import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { execFile, execSync, spawn } from "node:child_process";
import { compareByOrderId } from "./lib/compare.js";
import {
  getDefaultDatasets,
  getRowStatus,
  listTree,
  normalizeStatusValue,
  readFileContent,
  resolveOutputPath,
} from "./lib/files.js";
import { createGoogleOAuthAuthorizationUrl, exchangeGoogleOAuthCode, getGoogleSyncManifest, getGoogleSyncState, recordGoogleSyncFailure, saveGoogleSyncConfig, syncProjectToGoogleDrive, syncWorkspaceSelectionToGoogleDrive } from "./lib/google-sync.js";
import { getScriptById, scriptCatalog } from "./lib/scripts.js";
import {
  parseScheduleIntervalFromCron,
  buildErrorReport,
  computeNextScheduleRunAt,
  computePipelineProgress,
  parseIntervalMinutesFromCron,
  parseProgressSignal,
  resolveScheduleIntervalMinutes,
} from "./lib/pipeline-runtime.js";
import { createId, dataDir, readJson, writeJson } from "./lib/storage.js";
import {
  authenticateUser,
  availableModels,
  createSession,
  createUser,
  deleteUser,
  finishModelRun,
  getActiveModel,
  getConfiguredTimezone,
  getDatabasePath,
  getReverifyDefaultProvider,
  getSessionTtlMinutes,
  getSessionById,
  getUserById,
  listModelRuns,
  listSessions,
  listUsers,
  purgeInactiveSessions,
  recordModelRun,
  revokeSession,
  revokeSessionsForUser,
  setActiveModel,
  setConfiguredTimezone,
  setReverifyDefaultProvider,
  setSessionTtlMinutes,
  touchSession,
  updateUserPassword,
} from "./lib/auth-store.js";

const app = express();
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:5173";
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));
app.use(express.json({ limit: "2mb" }));

function createRateLimiter({ windowMs, max, message }) {
  const hitsByKey = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip || req.socket?.remoteAddress || "unknown"}:${req.method}:${req.path}`;
    const current = hitsByKey.get(key);
    if (!current || now > current.resetAt) {
      hitsByKey.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    current.count += 1;
    if (current.count > max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((current.resetAt - now) / 1000))));
      return res.status(429).json({ error: message });
    }
    return next();
  };
}

const pipelineLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  message: "Too many pipeline requests. Please wait before retrying.",
});
const authLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 5,
  message: "Too many auth requests. Please wait before retrying.",
});
const fileLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: "Too many file requests. Please wait before retrying.",
});

const PORT = Number(process.env.BACKEND_PORT || 8787);
const jobsFile = "jobs.json";
const schedulesFile = "schedules.json";
const alertsStateFile = "alerts_state.json";
const runHistoryFile = path.resolve(dataDir, "run_history_logs.jsonl");
const runHistoryBackupFile = path.resolve(dataDir, "run_history_logs.prev.jsonl");
const pipelineErrorReportFile = path.resolve(dataDir, "pipeline_error_report.json");
const RUN_HISTORY_MAX_BYTES = Number(process.env.RUN_HISTORY_MAX_BYTES || 50 * 1024 * 1024);
const runningProcesses = new Map();
const scheduleTasks = new Map();
const SCHEDULE_RETRY_DELAY_MS = Number(process.env.SCHEDULE_RETRY_DELAY_MS || 15_000);
const DEMO_FAST_PIPELINE = process.env.BLOSSOM_DEMO_FAST_PIPELINE === "1";
const PIPELINE_ORDER = ["get-task", "get-order-inquiry", "funeral-finder", "reverify", "updater", "closing-task"];
const AUTH_COOKIE_NAME = "blossom_session";
const ROOT_ENV_PATH = path.resolve(process.cwd(), ".env");
const DEFAULT_OPENAI_MODEL = "gpt-4o-search-preview";
const DEFAULT_PERPLEXITY_MODEL = "sonar-pro";
const FUNERAL_OUTPUT_DIR = path.resolve(process.cwd(), "Scripts", "outputs", "Funeral_Finder");
const SCRIPT_SYNC_SCOPES = {
  "get-task": "Scripts/outputs/GetTask",
  "get-order-inquiry": "Scripts/outputs/GetOrderInquiry",
  "funeral-finder": "Scripts/outputs/Funeral_Finder",
  reverify: "Scripts/outputs/Funeral_Finder",
  updater: "Scripts/outputs/Updater",
  "closing-task": "Scripts/outputs/ClosingTask",
};
const COMMON_RUNTIME_SYNC_PATHS = [
  "pipeline_checkpoint.json",
  "pipeline_last_summary.json",
  "pipeline_logs.jsonl",
  "pipeline_state.json",
  "backend/data/jobs.json",
  "backend/data/schedules.json",
  "backend/data/run_history_logs.jsonl",
  "backend/data/run_history_logs.prev.jsonl",
];

// Platform-aware Python binary detection
let PYTHON_BIN = "python3";
if (process.platform === "win32") {
  try {
    execSync("python --version", { stdio: "ignore" });
    PYTHON_BIN = "python";
  } catch {
    PYTHON_BIN = "python3";
  }
}

function killJobProcess(childProc) {
  if (!childProc?.pid) {
    return;
  }
  if (process.platform === "win32") {
    execFile(
      "taskkill",
      ["/PID", String(childProc.pid), "/T", "/F"],
      { windowsHide: true },
      () => {
        try {
          childProc.kill();
        } catch {
          // ignore
        }
      },
    );
    return;
  }
  try {
    childProc.kill("SIGTERM");
  } catch {
    // ignore
  }
  setTimeout(() => {
    if (childProc.exitCode === null && childProc.signalCode === null) {
      try {
        childProc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }, 2000);
}

function requestTerminalRunnerStop(reason = "Stop requested by UI") {
  const controlFile = path.resolve(process.cwd(), "pipeline_control.json");
  try {
    fs.writeFileSync(
      controlFile,
      JSON.stringify({
        stop_requested: true,
        reason,
        requested_at: new Date().toISOString(),
      }, null, 2),
      "utf-8",
    );
  } catch (error) {
    console.warn(`[pipeline] Could not write terminal runner stop request: ${error.message}`);
  }
}

function parseCookies(cookieHeader = "") {
  return cookieHeader.split(";").reduce((accumulator, part) => {
    const [rawKey, ...rawValueParts] = part.split("=");
    const key = String(rawKey || "").trim();
    if (!key) {
      return accumulator;
    }
    const value = rawValueParts.join("=").trim();
    accumulator[key] = decodeURIComponent(value || "");
    return accumulator;
  }, {});
}

function serializeSessionCookie(sessionId, expiresAt) {
  const maxAgeSeconds = Math.max(60, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  const isProduction = process.env.NODE_ENV === "production";
  return `${AUTH_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${isProduction ? "; Secure" : ""}`;
}

function clearSessionCookie() {
  return `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function isOpenAIModel(modelName) {
  const normalized = String(modelName || "").trim().toLowerCase();
  return normalized.startsWith("gpt-") || normalized.startsWith("o");
}

function resolveProviderModel(provider, selectedModel) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const normalizedModel = String(selectedModel || "").trim();
  if (normalizedProvider === "openai") {
    return isOpenAIModel(normalizedModel) ? normalizedModel : DEFAULT_OPENAI_MODEL;
  }
  return isOpenAIModel(normalizedModel) ? DEFAULT_PERPLEXITY_MODEL : (normalizedModel || DEFAULT_PERPLEXITY_MODEL);
}

function readSessionId(req) {
  return parseCookies(req.headers.cookie || "")[AUTH_COOKIE_NAME] || "";
}

function requireAuth(req, res, next) {
  const sessionId = readSessionId(req);
  if (!sessionId) {
    return res.status(401).json({ error: "Login required" });
  }

  const session = touchSession(sessionId, getSessionTtlMinutes());
  if (!session) {
    res.setHeader("Set-Cookie", clearSessionCookie());
    return res.status(401).json({ error: "Session expired" });
  }

  req.auth = {
    session,
    user: {
      id: session.userId,
      username: session.username,
      role: session.role,
    },
  };
  res.setHeader("Set-Cookie", serializeSessionCookie(session.id, session.expiresAt));
  return next();
}

function requireAdmin(req, res, next) {
  if (req.auth?.user?.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  return next();
}

function setAuthResponse(res, session) {
  res.setHeader("Set-Cookie", serializeSessionCookie(session.id, session.expiresAt));
}

function ensureRunHistoryFile() {
  fs.mkdirSync(path.dirname(runHistoryFile), { recursive: true });
  if (!fs.existsSync(runHistoryFile)) {
    fs.writeFileSync(runHistoryFile, "", "utf-8");
  }
}

function rotateRunHistoryIfNeeded() {
  if (!fs.existsSync(runHistoryFile)) {
    return;
  }

  let fileSize = 0;
  try {
    fileSize = fs.statSync(runHistoryFile).size;
  } catch {
    return;
  }

  if (!Number.isFinite(fileSize) || fileSize < RUN_HISTORY_MAX_BYTES) {
    return;
  }

  try {
    if (fs.existsSync(runHistoryBackupFile)) {
      fs.unlinkSync(runHistoryBackupFile);
    }
  } catch {
    // Ignore backup cleanup errors; we still attempt rotation.
  }

  try {
    fs.renameSync(runHistoryFile, runHistoryBackupFile);
    fs.writeFileSync(runHistoryFile, "", "utf-8");
    console.warn(`Run history rotated at ${new Date().toISOString()} (limit=${RUN_HISTORY_MAX_BYTES} bytes)`);
  } catch (error) {
    console.error("Failed to rotate run history log:", error);
  }
}

function parseLoggedLine(line) {
  const source = String(line || "");
  const match = source.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (!match) {
    return { timestamp: new Date().toISOString(), message: source };
  }
  return { timestamp: match[1], message: match[2] };
}

function appendRunHistoryEntry(entry) {
  ensureRunHistoryFile();
  rotateRunHistoryIfNeeded();
  fs.appendFileSync(runHistoryFile, `${JSON.stringify(entry)}\n`, "utf-8");
}

function readPipelineErrorReport() {
  if (!fs.existsSync(pipelineErrorReportFile)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(pipelineErrorReportFile, "utf-8"));
  } catch {
    return null;
  }
}

function writePipelineErrorReport(report) {
  fs.mkdirSync(path.dirname(pipelineErrorReportFile), { recursive: true });
  fs.writeFileSync(pipelineErrorReportFile, JSON.stringify(report, null, 2), "utf-8");
}

function recordPipelineErrorReport(job, details = {}) {
  writePipelineErrorReport({
    status: "open",
    ...buildErrorReport(job, details),
  });
}

function resolvePipelineErrorReport(context = {}) {
  const existing = readPipelineErrorReport();
  if (!existing || existing.status !== "open") {
    return;
  }
  writePipelineErrorReport({
    ...existing,
    status: "resolved",
    resolvedAt: new Date().toISOString(),
    resolution: context,
  });
}

function seedRunHistoryFromExistingJobs() {
  ensureRunHistoryFile();
  const stats = fs.statSync(runHistoryFile);
  if (stats.size > 0) {
    return;
  }

  const jobs = loadJobs();
  jobs
    .slice()
    .reverse()
    .forEach((job) => {
      (job.logs || []).forEach((line) => {
        const parsed = parseLoggedLine(line);
        appendRunHistoryEntry({
          taskId: job.id,
          jobId: job.id,
          kind: job.kind,
          scriptId: job.scriptId ?? null,
          status: job.status,
          progress: job.progress,
          timestamp: parsed.timestamp,
          message: parsed.message,
          fullLogs: job.logs,
        });
      });
    });
}

function defaultPipelineSequence() {
  return [
    { scriptId: "get-task" },
    { scriptId: "get-order-inquiry" },
    { scriptId: "funeral-finder" },
    { scriptId: "reverify", option: "both" },
    { scriptId: "updater" },
    { scriptId: "closing-task" },
  ];
}

function inferScheduleUseReverify(schedule) {
  if (typeof schedule?.useReverify === "boolean") {
    return schedule.useReverify;
  }
  return Array.isArray(schedule?.sequence)
    ? schedule.sequence.some((step) => step?.scriptId === "reverify")
    : null;
}

function inferScheduleReverifyOption(schedule, useReverify) {
  if (useReverify === false) {
    return null;
  }
  const fromField = String(schedule?.reverifyOption || "").trim();
  if (fromField) {
    return fromField;
  }
  const reverifyStep = Array.isArray(schedule?.sequence)
    ? schedule.sequence.find((step) => step?.scriptId === "reverify")
    : null;
  return reverifyStep?.option || "both";
}

function buildScheduledSequence(schedule) {
  const useReverify = inferScheduleUseReverify(schedule);
  const reverifyOption = inferScheduleReverifyOption(schedule, useReverify);
  const sequence = [
    { scriptId: "get-task" },
    { scriptId: "get-order-inquiry" },
    { scriptId: "funeral-finder" },
  ];
  if (useReverify !== false) {
    sequence.push({ scriptId: "reverify", option: reverifyOption || "both" });
  }
  sequence.push({ scriptId: "updater", option: "complete" });
  sequence.push({ scriptId: "closing-task" });
  return sequence;
}

function validateScheduleConfig(schedule) {
  const updaterModel = String(schedule?.updaterModel || "").trim();
  const useReverify = inferScheduleUseReverify(schedule);
  const reverifyOption = inferScheduleReverifyOption(schedule, useReverify);

  if (!updaterModel) {
    return {
      ok: false,
      error: "updaterModel is required. Select a scheduled model before enabling cron.",
      missingConfig: "updaterModel",
    };
  }
  if (typeof useReverify !== "boolean") {
    return {
      ok: false,
      error: "Choose whether cron should use Reverify before enabling the schedule.",
      missingConfig: "reverifyConfig",
    };
  }
  if (useReverify && !String(reverifyOption || "").trim()) {
    return {
      ok: false,
      error: "Choose a Reverify source before enabling the schedule.",
      missingConfig: "reverifyConfig",
    };
  }
  return { ok: true, error: null, missingConfig: null };
}

function normalizeSequence(inputSequence) {
  const requested = Array.isArray(inputSequence) ? inputSequence : [];

  // If no input at all, return the default full pipeline
  if (requested.length === 0) {
    return defaultPipelineSequence();
  }

  const byScriptId = new Map(
    requested
      .filter((step) => step && typeof step.scriptId === "string")
      .map((step) => [step.scriptId, step]),
  );

  // Only include steps that were EXPLICITLY in the input, enforcing PIPELINE_ORDER ordering.
  // This allows callers to skip steps (e.g., omit reverify) by not including them.
  const normalized = [];
  PIPELINE_ORDER.forEach((scriptId) => {
    const fromInput = byScriptId.get(scriptId);
    if (!fromInput) {
      return; // Step not in input — skip it (don't inject defaults)
    }
    const step = { scriptId };
    if (scriptId === "reverify") {
      step.option = fromInput.option || "both";
    } else if (fromInput.option) {
      step.option = fromInput.option;
    }
    normalized.push(step);
  });

  return normalized.length > 0 ? normalized : defaultPipelineSequence();
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const text = fs.readFileSync(filePath, "utf-8");
  return text.split(/\r?\n/).reduce((acc, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return acc;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) return acc;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    acc[key] = value;
    return acc;
  }, {});
}

function sanitizeLogText(value) {
  return String(value || "")
    // Bearer tokens
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]")
    // Named env-var assignments: API_KEY=..., PASSWORD=..., SECRET=..., etc.
    .replace(/((?:PERPLEXITY|OPENAI|API|ACCESS|AUTH|TOKEN|PASSWORD|SECRET|BLOSSOMTASK)[A-Z0-9_\- ]*\s*[:=]\s*)([^\s,;\]\)\n]+)/gi, "$1[REDACTED]")
    // OpenAI sk- keys
    .replace(/sk-[A-Za-z0-9_\-]{20,}/g, "[REDACTED]")
    // Perplexity pplx- keys
    .replace(/pplx-[A-Za-z0-9_\-]{20,}/g, "[REDACTED]")
    // Generic long hex/base64 tokens that look like secrets (32+ chars after colon/equals in non-URL context)
    .replace(/(?<!https?:\/\/[^\s]*)(?:[:=])([A-Za-z0-9+/]{32,}={0,2})(?=[\s,;\]\)\n]|$)/g, ":[REDACTED]")
    // Mask RashiAI-style API values
    .replace(/RashiAI:[A-Za-z0-9!@#$%^&*._\-]+/g, "[REDACTED]");
}

function sanitizeJob(job) {
  return {
    ...job,
    logs: Array.isArray(job.logs) ? job.logs.map((line) => sanitizeLogText(line)) : [],
  };
}

function extractRequiredEnvVars(scriptPath) {
  if (!fs.existsSync(scriptPath)) {
    return [];
  }
  const source = fs.readFileSync(scriptPath, "utf-8");
  const regex = /_required_env\(["']([^"']+)["']\)/g;
  const vars = new Set();
  let match = regex.exec(source);
  while (match) {
    vars.add(match[1]);
    match = regex.exec(source);
  }
  return [...vars];
}

function createPreflightReport() {
  const checks = [];
  const scriptsDir = path.resolve(process.cwd(), "Scripts");
  const envPath = ROOT_ENV_PATH;
  const envMap = parseEnvFile(envPath);

  checks.push({
    key: "scripts-dir",
    label: "Scripts directory",
    status: fs.existsSync(scriptsDir) ? "pass" : "fail",
    details: fs.existsSync(scriptsDir) ? scriptsDir : `Missing directory: ${scriptsDir}`,
  });

  const missingScriptFiles = scriptCatalog
    .filter((script) => !fs.existsSync(script.file))
    .map((script) => script.file);

  checks.push({
    key: "script-files",
    label: "Python script files",
    status: missingScriptFiles.length === 0 ? "pass" : "fail",
    details:
      missingScriptFiles.length === 0
        ? `${scriptCatalog.length} script files found`
        : `Missing files: ${missingScriptFiles.join(", ")}`,
  });

  const envExists = fs.existsSync(envPath);
  checks.push({
    key: "env-file",
    label: "Root .env",
    status: envExists ? "pass" : "fail",
    details: envExists ? envPath : `Missing file: ${envPath}`,
  });

  const missingVarsByScript = scriptCatalog
    .map((script) => {
      const required = extractRequiredEnvVars(script.file);
      const missing = required.filter((key) => !String(envMap[key] || "").trim());
      return { script: script.id, missing };
    })
    .filter((entry) => entry.missing.length > 0);

  checks.push({
    key: "env-vars",
    label: "Required env variables",
    status: missingVarsByScript.length === 0 ? "pass" : "fail",
    details:
      missingVarsByScript.length === 0
        ? "All _required_env variables are present"
        : missingVarsByScript
            .map((entry) => `${entry.script}: ${entry.missing.join(", ")}`)
            .join(" | "),
  });

  const outputsDir = path.join(scriptsDir, "outputs");
  const outputsExists = fs.existsSync(outputsDir);
  checks.push({
    key: "outputs-dir",
    label: "Outputs directory",
    status: outputsExists ? "pass" : "warn",
    details: outputsExists ? outputsDir : `Directory not found yet: ${outputsDir}`,
  });

  const ok = checks.every((check) => check.status !== "fail");
  return {
    ok,
    checkedAt: new Date().toISOString(),
    checks,
  };
}

function loadJobs() {
  const raw = readJson(jobsFile, []);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((job) => {
    if (!job || typeof job !== "object") return false;
    if (typeof job.id !== "string") return false;
    if (!["script", "pipeline"].includes(job.kind)) return false;
    return true;
  }).map(sanitizeJob);
}

function isJobActuallyActive(job, jobs = loadJobs()) {
  if (!job || (job.status !== "running" && job.status !== "queued")) {
    return false;
  }
  if (job.status === "queued") {
    return true;
  }
  if (runningProcesses.has(job.id)) {
    return true;
  }
  if (job.kind === "pipeline") {
    return jobs.some((candidate) => (
      candidate.parentJobId === job.id
      && (candidate.status === "running" || candidate.status === "queued")
      && isJobActuallyActive(candidate, jobs)
    ));
  }
  return false;
}

function getActiveWorkload() {
  const jobs = loadJobs();
  return (
    jobs.find(
      (job) =>
        (job.kind === "script" || job.kind === "pipeline")
        && isJobActuallyActive(job, jobs),
    ) || null
  );
}

function saveJobs(jobs) {
  writeJson(jobsFile, jobs);
}

function reconcileOrphanedJobs() {
  const jobs = loadJobs();
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const ORPHAN_AGE_LIMIT_MS = 48 * 60 * 60 * 1000; // 48 hours
  let changed = false;
  const recoveredIds = [];

  const updated = jobs.map((job) => {
    if (job.status !== "running" && job.status !== "queued") {
      return job;
    }

    // Skip very old jobs — they may have been left in a historical weird state
    const createdAtMs = job.createdAt ? new Date(job.createdAt).getTime() : 0;
    if (Number.isFinite(createdAtMs) && nowMs - createdAtMs > ORPHAN_AGE_LIMIT_MS) {
      console.warn(`[reconcile] Skipping old orphaned job ${job.id} (created ${job.createdAt}); too old to reconcile safely`);
      return job;
    }

    const nextStatus = job.status === "running" ? "failed" : "cancelled";
    const reason = job.status === "running"
      ? "Recovered after backend restart: orphaned running job marked as failed"
      : "Recovered after backend restart: queued job marked as cancelled";
    const logLine = `[${now}] ${reason}`;

    recoveredIds.push(job.id);
    changed = true;
    return {
      ...job,
      status: nextStatus,
      finishedAt: job.finishedAt || now,
      updatedAt: now,
      progress: 100,
      exitCode: nextStatus === "failed" ? 1 : job.exitCode,
      logs: [...(job.logs || []), logLine].slice(-100),
    };
  });

  if (changed) {
    saveJobs(updated);
    console.warn(`[reconcile] Recovered ${recoveredIds.length} orphaned job(s) after backend restart: ${recoveredIds.join(", ")}`);
  }
}

// After jobs are reconciled, fix any schedules that are stuck in 'running' state
// with no corresponding active pipeline job (e.g., backend restarted mid-pipeline).
function reconcileOrphanedSchedules() {
  const schedules = loadSchedules();
  const now = new Date().toISOString();
  let changed = false;

  schedules.forEach((schedule) => {
    if (schedule.lastStatus !== "running" && schedule.lastStatus !== "queued") {
      return;
    }
    // Check whether there's actually a live pipeline job for this schedule
    const activeJob = loadJobs().find(
      (job) =>
        job.kind === "pipeline"
        && (job.status === "running" || job.status === "queued")
        && job.trigger?.scheduleId === schedule.id,
    );
    if (!activeJob) {
      // No live job — the schedule is stuck; finalize its cooldown as failed
      console.warn(`[cron] Reconciling orphaned schedule '${schedule.name}' (${schedule.id}): no active pipeline found`);
      finalizeScheduleCooldown(schedule.id, "failed", schedule.lastStartedAt || now);
      changed = true;
    }
  });

  if (changed) {
    console.warn("[cron] Orphaned schedules reconciled after backend restart");
  }
}

// In-memory log buffer for deferred jobs.json writes
// Map<jobId, {lines: string[], timer: NodeJS.Timeout | null}>
const logBuffer = new Map();
const LOG_FLUSH_INTERVAL_MS = 3000;

function upsertJob(jobId, patch) {
  const jobs = loadJobs();
  const index = jobs.findIndex((entry) => entry.id === jobId);
  if (index === -1) return null;
  jobs[index] = { ...jobs[index], ...patch, updatedAt: new Date().toISOString() };
  saveJobs(jobs);
  // If job is reaching a terminal state, merge any pending buffered logs immediately
  const terminalStatuses = ["success", "failed", "cancelled"];
  if (patch.status && terminalStatuses.includes(patch.status)) {
    // Flush the log buffer into the already-saved record
    const buffer = logBuffer.get(jobId);
    if (buffer && buffer.lines.length > 0) {
      if (buffer.timer) {
        clearTimeout(buffer.timer);
        buffer.timer = null;
      }
      const linesToMerge = [...buffer.lines];
      buffer.lines = [];
      logBuffer.delete(jobId);
      // Re-load, merge, re-save
      const freshJobs = loadJobs();
      const freshIndex = freshJobs.findIndex((entry) => entry.id === jobId);
      if (freshIndex !== -1) {
        freshJobs[freshIndex].logs = [...(freshJobs[freshIndex].logs || []), ...linesToMerge].slice(-100);
        freshJobs[freshIndex].updatedAt = new Date().toISOString();
        saveJobs(freshJobs);
        return freshJobs[freshIndex];
      }
    }
  }
  return jobs[index];
}


function createJob(payload) {
  const jobs = loadJobs();
  const job = {
    id: createId("job"),
    kind: payload.kind,
    parentJobId: payload.parentJobId ?? null,
    pipelineStepIndex: payload.pipelineStepIndex ?? null,
    pipelineTotalSteps: payload.pipelineTotalSteps ?? null,
    scriptId: payload.scriptId ?? null,
    sequence: payload.sequence ?? null,
    option: payload.option ?? null,
    forceLatestCount: payload.forceLatestCount ?? null,
    model: payload.model ?? null,
    trigger: payload.trigger ?? { type: "manual" },
    status: "queued",
    logs: [],
    progress: 0,
    progressMode: payload.progressMode ?? (payload.kind === "pipeline" ? "determinate" : "indeterminate"),
    progressCurrent: null,
    progressTotal: null,
    progressNote: payload.progressNote ?? "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
  };
  jobs.unshift(job);
  saveJobs(jobs.slice(0, 50));
  return job;
}

function getRunningChildProcessForPipeline(pipelineJobId) {
  const activeScriptJob = loadJobs().find(
    (job) => job.kind === "script" && job.parentJobId === pipelineJobId && job.status === "running",
  );
  if (!activeScriptJob) {
    return null;
  }
  return {
    jobId: activeScriptJob.id,
    childProc: runningProcesses.get(activeScriptJob.id) || null,
  };
}


function flushLogBuffer(jobId) {
  const buffer = logBuffer.get(jobId);
  if (!buffer || buffer.lines.length === 0) {
    logBuffer.delete(jobId);
    return;
  }
  const linesToFlush = [...buffer.lines];
  buffer.lines = [];
  if (buffer.timer) {
    clearTimeout(buffer.timer);
    buffer.timer = null;
  }
  logBuffer.delete(jobId);

  const jobs = loadJobs();
  const index = jobs.findIndex((entry) => entry.id === jobId);
  if (index === -1) return;
  const job = jobs[index];
  job.logs = [...(job.logs || []), ...linesToFlush].slice(-100);
  job.updatedAt = new Date().toISOString();
  jobs[index] = job;
  saveJobs(jobs);
}

function appendLog(jobId, line) {
  const timestamp = new Date().toISOString();
  const sanitizedLine = sanitizeLogText(line);
  const formattedLine = `[${timestamp}] ${sanitizedLine}`;

  // Always write to run history immediately (append-only, cheap)
  // Resolve job metadata from buffer or disk for run history
  const jobs = loadJobs();
  const job = jobs.find((entry) => entry.id === jobId);
  if (!job) return;

  appendRunHistoryEntry({
    taskId: job.id,
    jobId: job.id,
    kind: job.kind,
    scriptId: job.scriptId ?? null,
    status: job.status,
    progress: job.progress,
    timestamp,
    message: sanitizedLine,
    // fullLogs intentionally omitted — prevents O(n^2) growth in run_history_logs.jsonl
  });

  // Buffer log lines for deferred jobs.json write
  if (!logBuffer.has(jobId)) {
    logBuffer.set(jobId, { lines: [], timer: null });
  }
  const buffer = logBuffer.get(jobId);
  buffer.lines.push(formattedLine);

  if (!buffer.timer) {
    buffer.timer = setTimeout(() => flushLogBuffer(jobId), LOG_FLUSH_INTERVAL_MS);
  }
}

function syncPipelineProgressFromChild(job) {
  if (!job?.parentJobId || job.kind !== "script") {
    return;
  }

  const pipelineJob = loadJobs().find((entry) => entry.id === job.parentJobId);
  if (!pipelineJob || pipelineJob.kind !== "pipeline" || pipelineJob.status !== "running") {
    return;
  }

  const completedSteps = Math.max(0, Number(job.pipelineStepIndex || 0));
  const childProgress = job.progressMode === "determinate" ? Number(job.progress || 0) : null;
  const nextProgress = computePipelineProgress({
    totalSteps: job.pipelineTotalSteps || pipelineJob.sequence?.length || 1,
    completedSteps,
    currentStepProgress: childProgress,
  });

  upsertJob(pipelineJob.id, {
    progress: nextProgress,
    progressMode: "determinate",
    progressNote: job.scriptId ? `Running ${job.scriptId}` : "Running scheduled pipeline",
  });
}

function updateProgressFromOutput(jobId, output) {
  const text = String(output || "");
  if (!text) {
    return;
  }

  const jobs = loadJobs();
  const index = jobs.findIndex((entry) => entry.id === jobId);
  if (index === -1) {
    return;
  }

  const job = jobs[index];
  const signal = parseProgressSignal(text);
  if (!signal) {
    if (job.progressMode !== "indeterminate") {
      upsertJob(jobId, { progressMode: "indeterminate" });
    }
    return;
  }

  const currentProgress = Number(job.progress || 0);
  const nextProgress = Math.max(currentProgress, Number(signal.progress || 0));
  const updatedJob = upsertJob(jobId, {
    progress: nextProgress,
    progressMode: signal.mode,
    progressCurrent: signal.current,
    progressTotal: signal.total,
    progressNote: `${signal.current}/${signal.total}`,
  });
  syncPipelineProgressFromChild(updatedJob ?? { ...job, progress: nextProgress, progressMode: signal.mode });
}

function updateProgressFromOutputLegacy(jobId, output) {
  const text = String(output || "");
  if (!text) {
    return;
  }

  let current = null;
  let total = null;

  // Pattern 1: "processed so far: N" (Funeral_Finder)
  const processedMatch = text.match(/processed so far:\s*(\d+)/i);
  if (processedMatch) {
    current = Number(processedMatch[1]);
  }

  // Pattern 2: "LIVE PROCESSING – N orders/tasks" (total count)
  const totalMatch = text.match(/LIVE PROCESSING\s+[–-]\s+(\d+)\s+(?:tasks|orders)\b/i);
  if (totalMatch) {
    total = Number(totalMatch[1]);
  }

  // Pattern 3: "[X/Y]" bracket format used by pipeline stages
  const bracketMatch = text.match(/\[(\d+)\/(\d+)\]/);
  if (bracketMatch) {
    current = Number(bracketMatch[1]);
    total = Number(bracketMatch[2]);
  }

  // Pattern 4: "Processing X of Y" or "Task X of Y" or "Order X of Y"
  const ofMatch = text.match(/(?:Processing|Task|Order|Row|Record|Closing|Uploading|Verifying|Re-verifying)\s+(\d+)\s+of\s+(\d+)/i);
  if (ofMatch) {
    current = Number(ofMatch[1]);
    total = Number(ofMatch[2]);
  }

  // Pattern 5: Percentage in output "XX%" or "XX.X%"
  const percentMatch = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:complete|done|progress|finished)/i);
  if (percentMatch) {
    current = Number(percentMatch[1]);
    total = 100;
  }

  // Pattern 6: Stage completion markers (give progress bumps even without numbers)
  const stageCompletionPatterns = [
    { regex: /fetching\s+(?:tasks|orders)/i, progress: 10 },
    { regex: /(?:tasks|orders)\s+(?:loaded|fetched|retrieved)/i, progress: 20 },
    { regex: /INPUT SUMMARY/i, progress: 15 },
    { regex: /TASK COMPLETION SUMMARY/i, progress: 95 },
    { regex: /completed successfully/i, progress: 95 },
    { regex: /finished with code 0/i, progress: 95 },
    { regex: /Sending to Perplexity/i, progress: null },
    { regex: /Preparing upload/i, progress: 60 },
    { regex: /Upload complete/i, progress: 90 },
  ];

  let stageProgress = null;
  for (const pattern of stageCompletionPatterns) {
    if (pattern.regex.test(text) && pattern.progress !== null) {
      stageProgress = pattern.progress;
    }
  }

  if (current === null && total === null && stageProgress === null) {
    return;
  }

  const jobs = loadJobs();
  const index = jobs.findIndex((entry) => entry.id === jobId);
  if (index === -1) {
    return;
  }

  const job = jobs[index];
  const currentProgress = Number(job.progress || 0);
  let nextProgress = currentProgress;

  if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
    nextProgress = Math.min(95, Math.max(currentProgress, Math.round((current / total) * 100)));
  } else if (Number.isFinite(current)) {
    nextProgress = Math.min(95, Math.max(currentProgress, current));
  } else if (stageProgress !== null) {
    nextProgress = Math.min(95, Math.max(currentProgress, stageProgress));
  }

  if (nextProgress > currentProgress) {
    upsertJob(jobId, { progress: nextProgress });
  }
}

function appendScriptRunSummary(jobId, scriptId) {
  const job = loadJobs().find((entry) => entry.id === jobId);
  if (!job) return;
  if ((job.logs || []).some((line) => String(line).includes("RUN_SUMMARY|"))) {
    return;
  }

  const startedAtMs = job.startedAt ? new Date(job.startedAt).getTime() : null;
  const finishedAtMs = job.finishedAt ? new Date(job.finishedAt).getTime() : null;
  const durationSec =
    startedAtMs && finishedAtMs && Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
      ? Math.max(0, Math.round((finishedAtMs - startedAtMs) / 1000))
      : null;

  appendLog(
    jobId,
    `RUN_SUMMARY|taskId=${jobId}|scriptId=${scriptId}|status=${job.status}|exitCode=${job.exitCode ?? "n/a"}|progress=${job.progress ?? 0}|durationSec=${durationSec ?? "n/a"}|logLines=${(job.logs || []).length}`,
  );
}

function getGoogleSyncScopeForScript(scriptId) {
  return SCRIPT_SYNC_SCOPES[scriptId] || "Scripts/outputs";
}

function getApprovedGoogleSyncPaths(scriptId = null) {
  const uniquePaths = new Set(["Scripts/outputs", ...COMMON_RUNTIME_SYNC_PATHS]);
  const scriptScope = scriptId ? getGoogleSyncScopeForScript(scriptId) : null;
  if (scriptScope) {
    uniquePaths.add(scriptScope);
  }
  return Array.from(uniquePaths);
}

async function syncScriptOutputsIfConfigured(jobId, scriptId) {
  const syncState = getGoogleSyncState();
  if (!syncState.enabled || !syncState.configured) {
    return null;
  }

  const syncPaths = getApprovedGoogleSyncPaths(scriptId);
  appendLog(jobId, `Google sync started for ${scriptId} outputs and runtime files`);
  try {
    const result = await syncWorkspaceSelectionToGoogleDrive({ paths: syncPaths });
    appendLog(jobId, `Google sync complete: ${result.uploadedFiles} files uploaded to ${result.folderName}`);
    return result;
  } catch (error) {
    recordGoogleSyncFailure(error, `Script ${scriptId} sync failed`);
    appendLog(jobId, `Google sync failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    return null;
  }
}

async function syncPipelineOutputsIfConfigured(jobId) {
  const syncState = getGoogleSyncState();
  if (!syncState.enabled || !syncState.configured) {
    return null;
  }

  const syncPaths = getApprovedGoogleSyncPaths();
  appendLog(jobId, "Google sync started for pipeline outputs and runtime files");
  try {
    const result = await syncWorkspaceSelectionToGoogleDrive({ paths: syncPaths });
    appendLog(jobId, `Google sync complete: ${result.uploadedFiles} files uploaded to ${result.folderName}`);
    return result;
  } catch (error) {
    recordGoogleSyncFailure(error, "Pipeline sync failed");
    appendLog(jobId, `Google sync failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    return null;
  }
}

function waitMs(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function detectConcurrentRunGuard(job) {
  const logs = Array.isArray(job?.logs) ? job.logs : [];
  const guardLine = logs.find((line) => (
    /Another run is already active/i.test(String(line || ""))
    || /Another run with same config is active/i.test(String(line || ""))
    || /skipping to avoid concurrent file updates/i.test(String(line || ""))
  ));
  return guardLine ? String(guardLine) : "";
}

async function runDemoScriptJob({ jobId, scriptId, option, modelName, script, modelRunId }) {
  const selectedModel = String(modelName || getActiveModel() || "sonar-pro");
  const previousErrorReport = readPipelineErrorReport();
  upsertJob(jobId, {
    status: "running",
    startedAt: new Date().toISOString(),
    progress: 0,
    progressMode: "determinate",
    progressCurrent: 0,
    progressTotal: 4,
    progressNote: "0/4",
    model: selectedModel,
  });
  appendLog(jobId, `Starting ${script.name}`);
  appendLog(jobId, `Active model: ${selectedModel}`);
  appendLog(jobId, "Demo fast pipeline mode enabled");
  if (option) {
    appendLog(jobId, `Run mode: ${option}`);
  }
  const currentJob = loadJobs().find((entry) => entry.id === jobId);
  if (currentJob?.forceLatestCount) {
    appendLog(jobId, `Force latest window: newest ${currentJob.forceLatestCount} GetOrderInquiry rows`);
  }
  if (previousErrorReport?.status === "open") {
    appendLog(
      jobId,
      `Previous error report loaded: ${previousErrorReport.kind}:${previousErrorReport.scriptId || previousErrorReport.jobId} -> ${previousErrorReport.message}`,
    );
  }

  const progressSteps = [
    `${script.name} demo bootstrap`,
    `${script.name} demo processing`,
    `${script.name} demo validating`,
    `${script.name} demo completed`,
  ];

  for (let index = 0; index < progressSteps.length; index += 1) {
    await waitMs(250);
    const current = loadJobs().find((entry) => entry.id === jobId);
    if (current?.status === "cancelled") {
      finishModelRun(modelRunId, "cancelled");
      upsertJob(jobId, {
        finishedAt: new Date().toISOString(),
        progress: 100,
        progressMode: "determinate",
        progressCurrent: progressSteps.length,
        progressTotal: progressSteps.length,
        progressNote: "Cancelled",
        exitCode: 1,
      });
      appendLog(jobId, `${script.name} stopped by user`);
      appendScriptRunSummary(jobId, scriptId);
      return { success: false, exitCode: 1 };
    }

    const currentStep = index + 1;
    appendLog(jobId, `[${currentStep}/${progressSteps.length}] ${progressSteps[index]}`);
    const nextProgress = Math.min(95, Math.round((currentStep / progressSteps.length) * 100));
    const updatedJob = upsertJob(jobId, {
      progress: nextProgress,
      progressMode: "determinate",
      progressCurrent: currentStep,
      progressTotal: progressSteps.length,
      progressNote: `${currentStep}/${progressSteps.length}`,
    });
    syncPipelineProgressFromChild(updatedJob ?? loadJobs().find((entry) => entry.id === jobId));
  }

  finishModelRun(modelRunId, "success");
  upsertJob(jobId, {
    status: "success",
    finishedAt: new Date().toISOString(),
    progress: 100,
    progressMode: "determinate",
    progressCurrent: progressSteps.length,
    progressTotal: progressSteps.length,
    progressNote: "Completed",
    exitCode: 0,
  });
  appendLog(jobId, `${script.name} finished with code 0`);
  resolvePipelineErrorReport({ jobId, scriptId, recoveredAt: new Date().toISOString() });
  appendScriptRunSummary(jobId, scriptId);
  return { success: true, exitCode: 0 };
}

async function runScriptJob({ jobId, scriptId, option, modelName, forceLatestCount = 0 }) {
  const script = getScriptById(scriptId);
  if (!script) {
    upsertJob(jobId, { status: "failed", finishedAt: new Date().toISOString(), exitCode: 1 });
    appendLog(jobId, `Unknown script: ${scriptId}`);
    return { success: false, exitCode: 1 };
  }

  if (!fs.existsSync(script.file)) {
    upsertJob(jobId, { status: "failed", finishedAt: new Date().toISOString(), exitCode: 1 });
    appendLog(jobId, `Script file not found: ${script.file}`);
    return { success: false, exitCode: 1 };
  }

  const selectedModel = String(modelName || getActiveModel() || "sonar-pro");
  const modelRunId = recordModelRun({
    jobId,
    scriptId,
    modelName: selectedModel,
    status: "running",
    source: scriptId,
  });

  if (DEMO_FAST_PIPELINE) {
    return runDemoScriptJob({ jobId, scriptId, option, modelName: selectedModel, script, modelRunId });
  }

  const previousErrorReport = readPipelineErrorReport();
  upsertJob(jobId, {
    status: "running",
    startedAt: new Date().toISOString(),
    progress: 0,
    progressMode: "indeterminate",
    progressNote: "",
    model: selectedModel,
  });
  appendLog(jobId, `Starting ${script.name}`);
  appendLog(jobId, `Active model: ${selectedModel}`);
  if (previousErrorReport?.status === "open") {
    appendLog(
      jobId,
      `Previous error report loaded: ${previousErrorReport.kind}:${previousErrorReport.scriptId || previousErrorReport.jobId} -> ${previousErrorReport.message}`,
    );
  }

  const effectiveOption = scriptId === "reverify"
      ? (option || "both")
      : scriptId === "closing-task"
        ? (option || "live")
        : option;

  if (effectiveOption) {
    appendLog(jobId, `Run mode: ${effectiveOption}`);
  }
  if (forceLatestCount > 0) {
    appendLog(jobId, `Force latest window: newest ${forceLatestCount} GetOrderInquiry rows`);
  }

  const cancelFlagPath = path.join(process.cwd(), "Scripts", "outputs", `.cancel_${jobId}`);
  const env = {
    ...process.env,
    RUN_MODE: effectiveOption || "",
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    BLOSSOM_CANCEL_FLAG: cancelFlagPath,
    ACTIVE_MODEL: selectedModel,
    PERPLEXITY_MODEL: resolveProviderModel("perplexity", selectedModel),
    OPENAI_MODEL: resolveProviderModel("openai", selectedModel),
    REVERIFY_DEFAULT_PROVIDER: getReverifyDefaultProvider(),
    BLOSSOM_TIMEZONE: getConfiguredTimezone(),
  };

  const scriptArgs = [];
  if (forceLatestCount > 0 && (scriptId === "funeral-finder" || scriptId === "reverify")) {
    scriptArgs.push("--force", "--latest-count", String(forceLatestCount));
  }
  if (scriptId === "reverify" && effectiveOption) {
    scriptArgs.push("--source", effectiveOption);
  }
  if (scriptId === "updater" && effectiveOption) {
    scriptArgs.push("--mode", effectiveOption);
  }
  const child = spawn(PYTHON_BIN, [script.file, ...scriptArgs], {
    cwd: path.dirname(script.file),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  runningProcesses.set(jobId, child);
  child.stdin.end();

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString().trim();
    appendLog(jobId, text);
    updateProgressFromOutput(jobId, text);
  });

  child.stderr.on("data", (chunk) => {
    appendLog(jobId, chunk.toString().trim());
  });

  return new Promise((resolve) => {
    child.on("error", (error) => {
      runningProcesses.delete(jobId);
      finishModelRun(modelRunId, "failed");
      const failedJob = upsertJob(jobId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        progress: 100,
        progressMode: "determinate",
        exitCode: 1,
      });
      appendLog(jobId, `Process error: ${error.message}`);
      recordPipelineErrorReport(failedJob ?? loadJobs().find((entry) => entry.id === jobId), {
        message: `Process error: ${error.message}`,
      });
      appendScriptRunSummary(jobId, scriptId);
      resolve({ success: false, exitCode: 1 });
    });

    child.on("close", async (code) => {
      runningProcesses.delete(jobId);
      const current = loadJobs().find((entry) => entry.id === jobId);
      if (current?.status === "cancelled") {
        finishModelRun(modelRunId, "cancelled");
        upsertJob(jobId, {
          finishedAt: new Date().toISOString(),
          progress: 100,
          progressMode: "determinate",
          exitCode: code,
        });
        appendLog(jobId, `${script.name} stopped by user`);
        appendScriptRunSummary(jobId, scriptId);
        await syncScriptOutputsIfConfigured(jobId, scriptId);
        resolve({ success: false, exitCode: code ?? 1 });
        return;
      }
      const concurrentGuardMessage = detectConcurrentRunGuard(current);
      const success = code === 0 && !concurrentGuardMessage;
      const finalExitCode = concurrentGuardMessage ? 75 : code;
      finishModelRun(modelRunId, success ? "success" : "failed");
      const finishedJob = upsertJob(jobId, {
        status: success ? "success" : "failed",
        finishedAt: new Date().toISOString(),
        progress: 100,
        progressMode: "determinate",
        progressNote: success ? "Completed" : "Failed",
        exitCode: finalExitCode,
      });
      if (concurrentGuardMessage) {
        appendLog(jobId, `${script.name} blocked by active-run guard; failing this step so the pipeline cannot continue with stale or incomplete data.`);
      }
      appendLog(jobId, `${script.name} finished with code ${finalExitCode}`);
      if (success) {
        resolvePipelineErrorReport({ jobId, scriptId, recoveredAt: new Date().toISOString() });
      } else {
        recordPipelineErrorReport(finishedJob ?? loadJobs().find((entry) => entry.id === jobId), {
          message: concurrentGuardMessage || `${script.name} finished with code ${finalExitCode}`,
        });
      }
      appendScriptRunSummary(jobId, scriptId);
      await syncScriptOutputsIfConfigured(jobId, scriptId);
      resolve({ success, exitCode: finalExitCode ?? 1 });
    });
  });
}

async function runPipelineJob(jobId, sequence, modelName) {
  const selectedModel = String(modelName || getActiveModel() || "sonar-pro");
  const pipelineJob = loadJobs().find((entry) => entry.id === jobId);
  const scheduleId = pipelineJob?.trigger?.scheduleId || null;
  const scheduleName = pipelineJob?.trigger?.scheduleName || null;
  const previousErrorReport = readPipelineErrorReport();
  upsertJob(jobId, {
    status: "running",
    startedAt: new Date().toISOString(),
    progress: 0,
    progressMode: "determinate",
    progressNote: sequence.length > 0 ? `0/${sequence.length} steps` : "",
    model: selectedModel,
  });
  appendLog(jobId, `Pipeline started with ${sequence.length} steps`);
  appendLog(jobId, `Active model: ${selectedModel}`);
  if (previousErrorReport?.status === "open") {
    appendLog(jobId, `Previous error report loaded: ${previousErrorReport.message}`);
  }

  for (let i = 0; i < sequence.length; i += 1) {
    const currentPipeline = loadJobs().find((entry) => entry.id === jobId);
    if (currentPipeline?.status === "cancelled") {
      appendLog(jobId, "Pipeline cancelled before next step");
      if (scheduleId) {
        finalizeScheduleCooldown(scheduleId, "cancelled", new Date().toISOString());
      }
      return;
    }
    const step = sequence[i];
    const stepJob = createJob({
      kind: "script",
      parentJobId: jobId,
      pipelineStepIndex: i,
      pipelineTotalSteps: sequence.length,
      scriptId: step.scriptId,
      option: step.option,
      model: selectedModel,
    });
    appendLog(jobId, `Step ${i + 1}/${sequence.length} -> ${step.scriptId} (${stepJob.id})`);
    upsertJob(jobId, {
      progress: computePipelineProgress({ totalSteps: sequence.length, completedSteps: i }),
      progressMode: "determinate",
      progressNote: `${i}/${sequence.length} steps complete`,
    });

    const done = await runScriptJob({ jobId: stepJob.id, scriptId: step.scriptId, option: step.option, modelName: selectedModel });

    if (!done.success) {
      const cancelledPipeline = loadJobs().find((entry) => entry.id === jobId);
      if (cancelledPipeline?.status === "cancelled") {
        appendLog(jobId, `Pipeline cancelled during ${step.scriptId}`);
        if (scheduleId) {
          finalizeScheduleCooldown(scheduleId, "cancelled", new Date().toISOString());
        }
        return;
      }

      const failedJob = upsertJob(jobId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        progress: 100,
        progressMode: "determinate",
        progressNote: `Failed at ${step.scriptId}`,
        exitCode: done.exitCode ?? 1,
      });
      appendLog(jobId, `Pipeline failed at ${step.scriptId}`);
      recordPipelineErrorReport(failedJob ?? loadJobs().find((entry) => entry.id === jobId), {
        message: `Pipeline failed at ${step.scriptId}`,
        scheduleId,
        scheduleName,
      });
      if (scheduleId) {
        finalizeScheduleCooldown(scheduleId, "failed", new Date().toISOString());
      }
      return;
    }

    const progress = Math.round(((i + 1) / sequence.length) * 100);
    upsertJob(jobId, {
      progress,
      progressMode: "determinate",
      progressNote: `${i + 1}/${sequence.length} steps complete`,
    });
  }

  upsertJob(jobId, {
    status: "success",
    finishedAt: new Date().toISOString(),
    progress: 100,
    progressMode: "determinate",
    progressNote: "Completed",
    exitCode: 0,
  });
  appendLog(jobId, "Pipeline completed successfully");
  resolvePipelineErrorReport({ jobId, scheduleId, recoveredAt: new Date().toISOString() });
  if (scheduleId) {
    finalizeScheduleCooldown(scheduleId, "success", new Date().toISOString());
  }
}

function normalizeSchedule(schedule) {
  const intervalSpec = parseScheduleIntervalFromCron(schedule?.cron);
  const intervalMinutes = resolveScheduleIntervalMinutes(schedule);
  const useReverify = inferScheduleUseReverify(schedule);
  const reverifyOption = inferScheduleReverifyOption(schedule, useReverify);
  const updaterModel = schedule?.updaterModel ? String(schedule.updaterModel).trim() : null;
  const validation = validateScheduleConfig({
    ...schedule,
    useReverify,
    reverifyOption,
    updaterModel,
  });
  return {
    ...schedule,
    intervalMinutes,
    intervalUnit: intervalSpec?.unit || "minutes",
    intervalValue: intervalSpec?.interval ?? Math.max(1, Math.round(intervalMinutes)),
    nextRunAt: schedule?.nextRunAt || null,
    sequence: normalizeSequence(buildScheduledSequence({
      ...schedule,
      useReverify,
      reverifyOption,
    })),
    useReverify,
    reverifyOption,
    updaterModel,
    configValid: validation.ok,
    configError: validation.error,
    missingConfig: validation.missingConfig,
  };
}

function loadSchedules() {
  const schedules = readJson(schedulesFile, []);
  return Array.isArray(schedules) ? schedules.map(normalizeSchedule) : [];
}

function saveSchedules(schedules) {
  writeJson(
    schedulesFile,
    schedules.map(({ intervalMinutes, configValid, configError, missingConfig, ...schedule }) => schedule),
  );
}

function updateScheduleMetadataLegacy(scheduleId, patch) {
  const schedules = loadSchedules();
  const index = schedules.findIndex((item) => item.id === scheduleId);
  if (index === -1) {
    return null;
  }
  schedules[index] = normalizeSchedule({
    ...schedules[index],
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  saveSchedules(schedules);
  return schedules[index];
}

function clearScheduleTimer(scheduleId) {
  const activeTimer = scheduleTasks.get(scheduleId);
  if (!activeTimer) {
    return;
  }
  clearTimeout(activeTimer.timeout);
  scheduleTasks.delete(scheduleId);
}

function updateScheduleMetadata(scheduleId, patch) {
  const schedules = loadSchedules();
  const index = schedules.findIndex((item) => item.id === scheduleId);
  if (index === -1) {
    return null;
  }
  schedules[index] = {
    ...schedules[index],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  saveSchedules(schedules);
  return schedules[index];
}

function registerSchedule(schedule) {
  clearScheduleTimer(schedule.id);
  if (!schedule.enabled) {
    return;
  }

  if (!schedule.configValid) {
    if (schedule.lastStatus !== "needs_config" || schedule.nextRunAt) {
      updateScheduleMetadata(schedule.id, {
        lastStatus: "needs_config",
        nextRunAt: null,
      });
    }
    console.warn(`[cron] Schedule '${schedule.name}' is enabled but missing required config: ${schedule.configError || "unknown-config-error"}`);
    return;
  }

  if (!parseScheduleIntervalFromCron(schedule.cron)) {
    console.warn(`[cron] Unsupported schedule expression for '${schedule.name}': ${schedule.cron}`);
  }

  const nextRunAt = computeNextScheduleRunAt(schedule);
  const syncedSchedule = schedule.nextRunAt === nextRunAt
    ? schedule
    : (updateScheduleMetadata(schedule.id, { nextRunAt }) ?? { ...schedule, nextRunAt });
  const delayMs = Math.max(0, new Date(nextRunAt).getTime() - Date.now());
  const timeout = setTimeout(() => {
    scheduleTasks.delete(schedule.id);
    const freshSchedule = loadSchedules().find((item) => item.id === schedule.id);
    if (!freshSchedule || !freshSchedule.enabled) {
      return;
    }
    triggerSchedulePipeline(freshSchedule, { immediate: false }, { busyPolicy: "defer" });
  }, delayMs);

  scheduleTasks.set(schedule.id, {
    timeout,
    nextRunAt: syncedSchedule.nextRunAt,
    intervalMinutes: syncedSchedule.intervalMinutes,
  });
}

function finalizeScheduleCooldown(scheduleId, status, finishedAt = new Date().toISOString()) {
  const schedule = loadSchedules().find((item) => item.id === scheduleId);
  if (!schedule) {
    return null;
  }

  if (!schedule.enabled) {
    clearScheduleTimer(scheduleId);
    return updateScheduleMetadata(scheduleId, {
      lastFinishedAt: finishedAt,
      lastStatus: status,
      nextRunAt: null,
    });
  }

  const nextRunAt = computeNextScheduleRunAt({
    ...schedule,
    lastFinishedAt: finishedAt,
    nextRunAt: null,
  }, new Date(finishedAt));
  const updated = updateScheduleMetadata(scheduleId, {
    lastFinishedAt: finishedAt,
    lastCooldownStartedAt: finishedAt,
    lastStatus: status,
    nextRunAt,
  });
  if (updated?.enabled) {
    registerSchedule(updated);
  }
  return updated;
}

function getRunningPipelineForSchedule(scheduleId) {
  return loadJobs().find((job) => (
    job.kind === "pipeline"
    && job.status === "running"
    && job.trigger
    && job.trigger.type === "schedule"
    && job.trigger.scheduleId === scheduleId
  )) ?? null;
}

function readTerminalPipelineState() {
  const stateFile = path.resolve(process.cwd(), "pipeline_state.json");
  if (!fs.existsSync(stateFile)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf-8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return false;
  }
  try {
    process.kill(parsed, 0);
    return true;
  } catch {
    return false;
  }
}

function getActiveTerminalPipelineState() {
  const state = readTerminalPipelineState();
  if (!state || String(state.status || "").toLowerCase() !== "running") {
    return null;
  }
  if (!state.owner_pid || !isPidAlive(state.owner_pid)) {
    return null;
  }
  return state;
}

function recoverStaleTerminalPipelineState(context = "backend") {
  const state = readTerminalPipelineState();
  if (!state || String(state.status || "").toLowerCase() !== "running") {
    return false;
  }
  if (state.owner_pid && isPidAlive(state.owner_pid)) {
    return false;
  }

  const stateFile = path.resolve(process.cwd(), "pipeline_state.json");
  const nextState = {
    ...state,
    status: "failed",
    reason: `Recovered stale running state from ${context}; previous terminal runner is not active`,
    updated_at: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(stateFile, JSON.stringify(nextState, null, 2), "utf-8");
    console.warn(`[cron] Recovered stale terminal pipeline state (${context})`);
    return true;
  } catch (error) {
    console.warn(`[cron] Could not recover stale terminal pipeline state: ${error.message}`);
    return false;
  }
}

function runTerminalRunnerPipelineJob(jobId, schedule, modelName) {
  const selectedModel = String(modelName || getActiveModel() || "sonar-pro");
  const reverifySource = inferScheduleReverifyOption(schedule, inferScheduleUseReverify(schedule)) || "both";
  const terminalRunnerPath = path.resolve(process.cwd(), "terminal_runner.py");
  const args = [
    terminalRunnerPath,
    "--once",
    "--mode=continue",
    "--updater-mode=complete",
    `--reverify-source=${reverifySource}`,
  ];
  if (DEMO_FAST_PIPELINE) {
    args.push("--dry-run");
  }

  upsertJob(jobId, {
    status: "running",
    startedAt: new Date().toISOString(),
    progress: 0,
    progressMode: "indeterminate",
    progressNote: "Running via terminal_runner.py",
    model: selectedModel,
  });
  appendLog(jobId, "Pipeline started via terminal_runner.py --once --mode=continue");
  appendLog(jobId, `Active model: ${selectedModel}`);

  let child;
  try {
    child = spawn(PYTHON_BIN, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        ACTIVE_MODEL: selectedModel,
        PERPLEXITY_MODEL: resolveProviderModel("perplexity", selectedModel),
        OPENAI_MODEL: resolveProviderModel("openai", selectedModel),
        REVERIFY_DEFAULT_PROVIDER: getReverifyDefaultProvider(),
        BLOSSOM_TIMEZONE: getConfiguredTimezone(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failedJob = upsertJob(jobId, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      progress: 100,
      progressMode: "determinate",
      progressNote: "Failed to start terminal_runner.py",
      exitCode: 1,
    });
    appendLog(jobId, `terminal_runner.py failed to start: ${error.message}`);
    recordPipelineErrorReport(failedJob ?? loadJobs().find((entry) => entry.id === jobId), {
      message: `terminal_runner.py failed to start: ${error.message}`,
      scheduleId: schedule.id,
      scheduleName: schedule.name,
    });
    finalizeScheduleCooldown(schedule.id, "failed", new Date().toISOString());
    return;
  }

  runningProcesses.set(jobId, child);

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      appendLog(jobId, text);
      updateProgressFromOutput(jobId, text);
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      appendLog(jobId, text);
    }
  });

  child.on("error", (error) => {
    runningProcesses.delete(jobId);
    const failedJob = upsertJob(jobId, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      progress: 100,
      progressMode: "determinate",
      progressNote: "Failed",
      exitCode: 1,
    });
    appendLog(jobId, `terminal_runner.py process error: ${error.message}`);
    recordPipelineErrorReport(failedJob ?? loadJobs().find((entry) => entry.id === jobId), {
      message: `terminal_runner.py process error: ${error.message}`,
      scheduleId: schedule.id,
      scheduleName: schedule.name,
    });
    finalizeScheduleCooldown(schedule.id, "failed", new Date().toISOString());
  });

  child.on("close", async (code) => {
    runningProcesses.delete(jobId);
    const current = loadJobs().find((entry) => entry.id === jobId);
    if (current?.status === "cancelled") {
      appendLog(jobId, "Pipeline cancelled");
      finalizeScheduleCooldown(schedule.id, "cancelled", new Date().toISOString());
      return;
    }

    const success = code === 0;
    const finishedJob = upsertJob(jobId, {
      status: success ? "success" : "failed",
      finishedAt: new Date().toISOString(),
      progress: 100,
      progressMode: "determinate",
      progressNote: success ? "Completed" : "Failed",
      exitCode: code ?? 1,
    });
    appendLog(jobId, `terminal_runner.py finished with code ${code ?? 1}`);
    if (success) {
      resolvePipelineErrorReport({ jobId, scheduleId: schedule.id, recoveredAt: new Date().toISOString() });
    } else {
      recordPipelineErrorReport(finishedJob ?? loadJobs().find((entry) => entry.id === jobId), {
        message: `terminal_runner.py finished with code ${code ?? 1}`,
        scheduleId: schedule.id,
        scheduleName: schedule.name,
      });
    }
    await syncPipelineOutputsIfConfigured(jobId);
    finalizeScheduleCooldown(schedule.id, success ? "success" : "failed", new Date().toISOString());
  });
}

function triggerSchedulePipeline(schedule, triggerPatch = {}, options = {}) {
  const now = new Date().toISOString();
  recoverStaleTerminalPipelineState("schedule-trigger");
  const activeWorkload = getActiveWorkload();
  const activeTerminalState = getActiveTerminalPipelineState();
  const busyPolicy = options.busyPolicy || "skip";

  if (activeWorkload || activeTerminalState) {
    const activeId = activeWorkload?.id || `terminal_runner:${activeTerminalState?.owner_pid || "unknown"}`;
    if (busyPolicy === "defer") {
      const retryAt = new Date(Date.now() + SCHEDULE_RETRY_DELAY_MS).toISOString();
      const updated = updateScheduleMetadata(schedule.id, {
        nextRunAt: retryAt,
        lastStatus: "waiting",
      });
      if (updated?.enabled) {
        registerSchedule(updated);
      }
      return { jobId: null, started: false, skipped: false, deferred: true, activeJobId: activeId };
    }

    const skippedJob = createJob({
      kind: "pipeline",
      sequence: normalizeSequence(schedule.sequence),
      model: getActiveModel(),
      trigger: {
        type: "schedule",
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        skipped: true,
        skippedReason: "active-workload",
        activeJobId: activeId,
        ...triggerPatch,
      },
    });

    upsertJob(skippedJob.id, {
      status: "cancelled",
      startedAt: now,
      finishedAt: now,
      progress: 100,
      progressMode: "determinate",
      exitCode: null,
    });
    appendLog(skippedJob.id, `Skipped: active workload in progress (${activeId})`);
    updateScheduleMetadata(schedule.id, {
      lastJobId: skippedJob.id,
      lastFinishedAt: now,
      lastStatus: "skipped",
    });
    return { jobId: skippedJob.id, started: false, skipped: true, deferred: false, activeJobId: activeId };
  }

  clearScheduleTimer(schedule.id);
  updateScheduleMetadata(schedule.id, {
    lastTriggeredAt: now,
    lastStatus: "queued",
    nextRunAt: null,
  });

  // Use schedule-specific model override if set, otherwise fall back to global active model
  const scheduleModel = schedule.updaterModel || getActiveModel();
  const sequence = normalizeSequence(schedule.sequence);
  const pipelineJob = createJob({
    kind: "pipeline",
    sequence,
    model: scheduleModel,
    progressMode: "determinate",
    progressNote: sequence.length > 0 ? `0/${sequence.length} steps` : "",
    trigger: {
      type: "schedule",
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      ...triggerPatch,
    },
  });
  appendLog(pipelineJob.id, `Triggered by schedule ${schedule.name}`);
  appendLog(pipelineJob.id, `Schedule model: ${scheduleModel} | terminal_runner.py owns the pipeline sequence`);
  updateScheduleMetadata(schedule.id, {
    lastJobId: pipelineJob.id,
    lastStartedAt: now,
    lastStatus: "running",
    nextRunAt: null,
  });
  runTerminalRunnerPipelineJob(pipelineJob.id, schedule, scheduleModel);
  return { jobId: pipelineJob.id, started: true, skipped: false, deferred: false, activeJobId: null };
}

function resetSchedules() {
  scheduleTasks.forEach((task) => clearTimeout(task.timeout));
  scheduleTasks.clear();
  loadSchedules().forEach(registerSchedule);
}
// Startup sequence — order matters:
// 1. Reconcile orphaned jobs first (marks them failed/cancelled in jobs.json)
// 2. Reconcile orphaned schedules (depends on reconciled job state above)
// 3. Register schedule timers (reads clean schedule state)
// 4. Seed run history from existing jobs
reconcileOrphanedJobs();
reconcileOrphanedSchedules();
recoverStaleTerminalPipelineState("backend-startup");
resetSchedules();
seedRunHistoryFromExistingJobs();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "webui-backend" });
});

app.get("/api/preflight", (_req, res) => {
  const report = createPreflightReport();
  res.json(report);
});

app.use("/api/auth/login", authLimiter);
app.use("/api/jobs/run-pipeline", pipelineLimiter);
app.use("/api/jobs/run-script", pipelineLimiter);
app.use("/api/schedules/:id/trigger", pipelineLimiter);
app.use("/api/files", fileLimiter);

app.post("/api/auth/login", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "").trim();
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  const user = authenticateUser(username, password);
  if (!user) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  const session = createSession(user.id, getSessionTtlMinutes(), {
    userAgent: req.headers["user-agent"],
    ipAddress: req.ip,
  });
  setAuthResponse(res, session);
  return res.json({
    user,
    session: {
      id: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      lastSeenAt: session.lastSeenAt,
    },
    activeModel: getActiveModel(),
    availableModels,
    sessionTtlMinutes: getSessionTtlMinutes(),
    reverifyDefaultProvider: getReverifyDefaultProvider(),
  });
});

app.get("/auth/google", (_req, res) => {
  try {
    return res.redirect(createGoogleOAuthAuthorizationUrl());
  } catch (error) {
    return res.status(400).send(error instanceof Error ? error.message : "Google OAuth configuration failed");
  }
});

app.get("/oauth2callback", async (req, res) => {
  try {
    const state = await exchangeGoogleOAuthCode({
      code: req.query.code,
      state: req.query.state,
    });
    return res
      .status(200)
      .type("html")
      .send(`
        <!doctype html>
        <html>
          <head><title>Google Drive connected</title></head>
          <body style="font-family: system-ui, sans-serif; padding: 32px;">
            <h1>Google Drive connected</h1>
            <p>OAuth refresh token saved. You can close this tab and run Drive sync again.</p>
            <p>Redirect URI: ${String(state.oauthRedirectUri || "")}</p>
          </body>
        </html>
      `);
  } catch (error) {
    recordGoogleSyncFailure(error, "OAuth callback failed");
    return res.status(400).send(error instanceof Error ? error.message : "Google OAuth callback failed");
  }
});

app.use("/api", requireAuth);

app.get("/api/auth/me", (req, res) => {
  return res.json({
    user: req.auth.user,
    session: req.auth.session,
    activeModel: getActiveModel(),
    availableModels,
    sessionTtlMinutes: getSessionTtlMinutes(),
    reverifyDefaultProvider: getReverifyDefaultProvider(),
    configuredTimezone: getConfiguredTimezone(),
    databasePath: getDatabasePath(),
  });
});

app.post("/api/auth/logout", (req, res) => {
  const sessionId = req.auth?.session?.id;
  if (sessionId) {
    revokeSession(sessionId);
  }
  res.setHeader("Set-Cookie", clearSessionCookie());
  return res.json({ ok: true });
});

app.post("/api/auth/logout-all", (req, res) => {
  const userId = req.auth?.user?.id;
  if (userId) {
    revokeSessionsForUser(userId);
  }
  res.setHeader("Set-Cookie", clearSessionCookie());
  return res.json({ ok: true });
});

app.delete("/api/auth/me/sessions/others", (req, res) => {
  const userId = req.auth?.user?.id;
  const currentSessionId = req.auth?.session?.id;
  if (!userId || !currentSessionId) {
    return res.status(400).json({ error: "Active session not found" });
  }

  let removed = 0;
  listSessions()
    .filter((session) => session.userId === userId && session.id !== currentSessionId && !session.revokedAt)
    .forEach((session) => {
      revokeSession(session.id);
      removed += 1;
    });

  return res.json({ ok: true, removed });
});

app.get("/api/auth/users", requireAdmin, (_req, res) => {
  return res.json({ users: listUsers() });
});

app.post("/api/auth/users", requireAdmin, (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "").trim();
  const role = String(req.body?.role || "user").trim();
  try {
    const user = createUser({ username, password, role });
    return res.status(201).json({ user });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.put("/api/auth/users/:userId/password", requireAdmin, (req, res) => {
  const password = String(req.body?.password || "").trim();
  try {
    const updated = updateUserPassword(req.params.userId, password);
    if (!updated) {
      return res.status(404).json({ error: "User not found" });
    }
    revokeSessionsForUser(req.params.userId);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.delete("/api/auth/users/:userId", requireAdmin, (req, res) => {
  const targetUser = getUserById(req.params.userId);
  if (!targetUser) {
    return res.status(404).json({ error: "User not found" });
  }

  const users = listUsers();
  const remainingAdmins = users.filter((user) => user.role === "admin" && user.id !== req.params.userId);
  if (targetUser.role === "admin" && remainingAdmins.length === 0) {
    return res.status(409).json({ error: "At least one admin account must remain" });
  }

  if (req.auth?.user?.id === req.params.userId) {
    return res.status(409).json({ error: "You cannot delete your own active account" });
  }

  const deleted = deleteUser(req.params.userId);
  if (!deleted) {
    return res.status(404).json({ error: "User not found" });
  }
  return res.json({ ok: true });
});

app.get("/api/auth/sessions", requireAdmin, (_req, res) => {
  return res.json({ sessions: listSessions() });
});

app.delete("/api/auth/sessions/inactive", requireAdmin, (_req, res) => {
  const removed = purgeInactiveSessions();
  return res.json({ ok: true, removed });
});

app.delete("/api/auth/sessions/:sessionId", requireAdmin, (req, res) => {
  revokeSession(req.params.sessionId);
  return res.json({ ok: true });
});

// Revoke ALL sessions for a specific user (by userId)
app.delete("/api/auth/users/:userId/sessions", requireAdmin, (req, res) => {
  const targetUser = getUserById(req.params.userId);
  if (!targetUser) {
    return res.status(404).json({ error: "User not found" });
  }
  revokeSessionsForUser(req.params.userId);
  return res.json({ ok: true, message: `All sessions for user '${targetUser.username}' revoked` });
});

app.put("/api/auth/model", requireAdmin, (req, res) => {
  const model = String(req.body?.model || "").trim();
  if (!model) {
    return res.status(400).json({ error: "model is required" });
  }
  if (!availableModels.includes(model)) {
    return res.status(400).json({ error: "Unsupported model" });
  }

  try {
    const activeModel = setActiveModel(model);
    return res.json({ activeModel, availableModels });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.put("/api/auth/settings/session-ttl", requireAdmin, (req, res) => {
  const minutes = Number(req.body?.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return res.status(400).json({ error: "minutes must be a positive number" });
  }
  const sessionTtlMinutes = setSessionTtlMinutes(minutes);
  return res.json({ sessionTtlMinutes });
});

app.put("/api/auth/settings/timezone", requireAdmin, (req, res) => {
  const timeZone = String(req.body?.timeZone || "").trim();
  if (!timeZone) {
    return res.status(400).json({ error: "timeZone is required" });
  }
  try {
    const configuredTimezone = setConfiguredTimezone(timeZone);
    return res.json({ configuredTimezone });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.put("/api/auth/settings/reverify-provider", requireAdmin, (req, res) => {
  const provider = String(req.body?.provider || "").trim().toLowerCase();
  if (!provider) {
    return res.status(400).json({ error: "provider is required" });
  }
  try {
    const reverifyDefaultProvider = setReverifyDefaultProvider(provider);
    return res.json({ reverifyDefaultProvider });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get("/api/google-sync", requireAuth, requireAdmin, (_req, res) => {
  return res.json(getGoogleSyncState());
});

app.get("/api/google-sync/files", requireAuth, requireAdmin, (_req, res) => {
  try {
    return res.json(getGoogleSyncManifest());
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Google sync manifest failed" });
  }
});

app.put("/api/google-sync/config", requireAuth, requireAdmin, (req, res) => {
  try {
    const state = saveGoogleSyncConfig({
      enabled: req.body?.enabled,
      folderName: req.body?.folderName,
      credentialsPath: req.body?.credentialsPath,
      driveRootFolderId: req.body?.driveRootFolderId,
      credentialsJson: req.body?.credentialsJson,
    });
    return res.json(state);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid Google sync config" });
  }
});

app.post("/api/google-sync/run", requireAuth, requireAdmin, async (req, res) => {
  try {
    const mode = String(req.body?.mode || "").trim().toLowerCase();
    const result = mode === "approved-runtime"
      ? await syncWorkspaceSelectionToGoogleDrive({ paths: getApprovedGoogleSyncPaths() })
      : await syncProjectToGoogleDrive({
        target: req.body?.target || "workspace",
        scope: req.body?.scope || "",
      });
    return res.json(result);
  } catch (error) {
    recordGoogleSyncFailure(error, "Manual sync failed");
    return res.status(400).json({ error: error instanceof Error ? error.message : "Google sync failed" });
  }
});

app.get("/api/scripts", (_req, res) => {
  const scripts = scriptCatalog.map((script) => ({
    id: script.id,
    name: script.name,
    description: script.description,
    hasOptions: script.hasOptions,
    options: script.options,
    supportsForceLatest: Boolean(script.supportsForceLatest),
    forceLatestOptions: Array.isArray(script.forceLatestOptions) ? script.forceLatestOptions : [],
    status: "idle",
  }));
  res.json({ scripts });
});

app.get("/api/jobs", (_req, res) => {
  res.json({ jobs: loadJobs() });
});

app.delete("/api/jobs", (_req, res) => {
  saveJobs([]);
  return res.json({ ok: true });
});

app.get("/api/jobs/:jobId", (req, res) => {
  const job = loadJobs().find((entry) => entry.id === req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  return res.json({ job });
});

app.get("/api/metrics", (_req, res) => {
  const jobs = loadJobs();
  const byDay = new Map();
  const byHour = new Map();
  const byModel = new Map();
  const byScript = new Map();

  function ensurePerformanceBucket(map, key, labelKey) {
    return map.get(key) || {
      [labelKey]: key,
      total: 0,
      success: 0,
      failed: 0,
      cancelled: 0,
      running: 0,
      durationTotalSec: 0,
      completedCount: 0,
    };
  }

  jobs.forEach((job) => {
    const createdAt = String(job.createdAt || new Date().toISOString());
    const day = createdAt.slice(0, 10);
    const hour = createdAt.slice(0, 13);
    const model = String(job.model || "unassigned");
    const scriptId = String(job.scriptId || job.kind || "unknown");
    const status = String(job.status || "unknown");
    const startedAtMs = Date.parse(job.startedAt);
    const finishedAtMs = Date.parse(job.finishedAt);
    const durationSec = Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
      ? Math.max(0, Math.round((finishedAtMs - startedAtMs) / 1000))
      : null;

    const dayBucket = byDay.get(day) || { day, total: 0, success: 0, failed: 0, cancelled: 0, running: 0 };
    dayBucket.total += 1;
    if (dayBucket[status] !== undefined) {
      dayBucket[status] += 1;
    }
    byDay.set(day, dayBucket);

    const hourBucket = byHour.get(hour) || { hour, total: 0, success: 0, failed: 0, cancelled: 0, running: 0 };
    hourBucket.total += 1;
    if (hourBucket[status] !== undefined) {
      hourBucket[status] += 1;
    }
    byHour.set(hour, hourBucket);

    const modelBucket = ensurePerformanceBucket(byModel, model, "model");
    modelBucket.total += 1;
    if (modelBucket[status] !== undefined) {
      modelBucket[status] += 1;
    }
    if (Number.isFinite(durationSec)) {
      modelBucket.durationTotalSec += durationSec;
      modelBucket.completedCount += status === "running" ? 0 : 1;
    }
    byModel.set(model, modelBucket);

    const scriptBucket = ensurePerformanceBucket(byScript, scriptId, "scriptId");
    scriptBucket.total += 1;
    if (scriptBucket[status] !== undefined) {
      scriptBucket[status] += 1;
    }
    if (Number.isFinite(durationSec)) {
      scriptBucket.durationTotalSec += durationSec;
      scriptBucket.completedCount += status === "running" ? 0 : 1;
    }
    byScript.set(scriptId, scriptBucket);
  });

  const finalizeBucket = (bucket) => ({
    ...bucket,
    successRate: bucket.total > 0 ? Number(((bucket.success / bucket.total) * 100).toFixed(1)) : 0,
    averageDurationSec: bucket.completedCount > 0 ? Number((bucket.durationTotalSec / bucket.completedCount).toFixed(1)) : 0,
  });

  return res.json({
    summary: {
      totalJobs: jobs.length,
      activeModel: getActiveModel(),
      sessionTtlMinutes: getSessionTtlMinutes(),
    },
    byDay: Array.from(byDay.values()).sort((left, right) => right.day.localeCompare(left.day)),
    byHour: Array.from(byHour.values()).sort((left, right) => right.hour.localeCompare(left.hour)),
    byModel: Array.from(byModel.values()).sort((left, right) => right.total - left.total),
    byScript: Array.from(byScript.values()).sort((left, right) => right.total - left.total),
    performance: {
      byModel: Array.from(byModel.values()).map(finalizeBucket).sort((left, right) => right.total - left.total),
      byScript: Array.from(byScript.values()).map(finalizeBucket).sort((left, right) => right.total - left.total),
    },
  });
});

app.post("/api/jobs/run-script", async (req, res) => {
  const { scriptId, option, forceLatestCount } = req.body || {};
  if (!scriptId) {
    return res.status(400).json({ error: "scriptId is required" });
  }
  const normalizedForceLatestCount = Number(forceLatestCount || 0);
  if (!Number.isFinite(normalizedForceLatestCount) || normalizedForceLatestCount < 0) {
    return res.status(400).json({ error: "forceLatestCount must be a non-negative number" });
  }
  const activeWorkload = getActiveWorkload();
  if (activeWorkload) {
    return res.status(409).json({
      error: `Another workload is already running (${activeWorkload.kind}:${activeWorkload.id}). Wait until it finishes.`,
    });
  }
  const model = getActiveModel();
  const job = createJob({
    kind: "script",
    scriptId,
    option: option || null,
    forceLatestCount: normalizedForceLatestCount > 0 ? normalizedForceLatestCount : null,
    model,
  });
  runScriptJob({
    jobId: job.id,
    scriptId,
    option,
    modelName: model,
    forceLatestCount: normalizedForceLatestCount,
  });
  return res.json({ jobId: job.id });
});

app.post("/api/jobs/run-pipeline", async (req, res) => {
  const activeWorkload = getActiveWorkload();
  if (activeWorkload) {
    return res.status(409).json({
      error: `Another workload is already running (${activeWorkload.kind}:${activeWorkload.id}). Wait until it finishes.`,
    });
  }
  const sequence = normalizeSequence(req.body?.sequence);
  const model = getActiveModel();

  const job = createJob({
    kind: "pipeline",
    sequence,
    model,
    trigger: { type: "manual" },
  });
  runPipelineJob(job.id, sequence, model);
  return res.json({ jobId: job.id });
});

app.post("/api/jobs/:jobId/cancel", (req, res) => {
  const directProcess = runningProcesses.get(req.params.jobId);
  const pipelineChild = getRunningChildProcessForPipeline(req.params.jobId);
  const childProc = directProcess || pipelineChild?.childProc;
  if (!childProc) {
    return res.status(404).json({ error: "Running process not found" });
  }
  try {
    const cancelFlagPath = path.join(process.cwd(), "Scripts", "outputs", `.cancel_${req.params.jobId}`);
    fs.mkdirSync(path.dirname(cancelFlagPath), { recursive: true });
    fs.writeFileSync(cancelFlagPath, new Date().toISOString(), "utf-8");
  } catch {
    // ignore
  }
  requestTerminalRunnerStop("Cancelled by user");
  killJobProcess(childProc);
  upsertJob(req.params.jobId, { status: "cancelled", finishedAt: new Date().toISOString() });
  if (pipelineChild?.jobId) {
    upsertJob(pipelineChild.jobId, { status: "cancelled", finishedAt: new Date().toISOString() });
  }
  appendLog(req.params.jobId, "Cancelled by user");
  return res.json({ ok: true });
});

app.get("/api/schedules", (_req, res) => {
  res.json({ schedules: loadSchedules() });
});

app.post("/api/schedules", (req, res) => {
  const body = req.body || {};
  if (!body.name || !body.cron) {
    return res.status(400).json({ error: "name and cron are required" });
  }
  if (!parseScheduleIntervalFromCron(body.cron)) {
    return res.status(400).json({ error: "Use */30 * * * * for minutes or */1 * * * * * for seconds demo mode" });
  }

  const schedule = normalizeSchedule({
    id: createId("schedule"),
    name: body.name,
    cron: body.cron,
    enabled: body.enabled ?? true,
    sequence: normalizeSequence(body.sequence),
    useReverify: typeof body.useReverify === "boolean" ? body.useReverify : null,
    reverifyOption: body.reverifyOption || null,
    updaterModel: body.updaterModel || null,
    createdAt: new Date().toISOString(),
    nextRunAt: null,
  });

  if (schedule.enabled && !schedule.configValid) {
    return res.status(400).json({
      error: `Cannot create enabled schedule: ${schedule.configError}`,
      missingConfig: schedule.missingConfig,
    });
  }

  const schedules = loadSchedules();
  schedules.push(schedule);
  saveSchedules(schedules);
  resetSchedules();
  return res.json({ schedule });
});

app.patch("/api/schedules/:id", (req, res) => {
  const schedules = loadSchedules();
  const index = schedules.findIndex((item) => item.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: "Schedule not found" });
  }
  const wasEnabled = Boolean(schedules[index].enabled);
  const next = { ...schedules[index], ...req.body, updatedAt: new Date().toISOString() };
  if ("sequence" in (req.body || {})) {
    next.sequence = normalizeSequence(req.body?.sequence);
  }
  if (next.cron && !parseScheduleIntervalFromCron(next.cron)) {
    return res.status(400).json({ error: "Use */30 * * * * for minutes or */1 * * * * * for seconds demo mode" });
  }
  const normalizedNext = normalizeSchedule(next);
  if (Boolean(normalizedNext.enabled) && !normalizedNext.configValid) {
    return res.status(400).json({
      error: `Cannot enable schedule: ${normalizedNext.configError}`,
      missingConfig: normalizedNext.missingConfig,
    });
  }

  if ("cron" in (req.body || {}) || wasEnabled !== Boolean(next.enabled)) {
    normalizedNext.nextRunAt = null;
  }
  schedules[index] = normalizedNext;
  saveSchedules(schedules);
  resetSchedules();

  // When disabling a schedule, cancel any running pipelines for it
  if (wasEnabled && !next.enabled) {
    const runningPipeline = getRunningPipelineForSchedule(req.params.id);
    if (runningPipeline) {
      const childProc = runningProcesses.get(runningPipeline.id) || getRunningChildProcessForPipeline(runningPipeline.id)?.childProc;
      if (childProc) {
        requestTerminalRunnerStop("Cron stopped from dashboard");
        killJobProcess(childProc);
      }
      upsertJob(runningPipeline.id, {
        status: "cancelled",
        finishedAt: new Date().toISOString(),
        progress: 100,
        progressMode: "determinate",
      });
      appendLog(runningPipeline.id, "Pipeline cancelled: schedule was disabled");
      finalizeScheduleCooldown(req.params.id, "cancelled", new Date().toISOString());
    }
  }
  return res.json({ schedule: schedules[index] });
});

app.delete("/api/schedules/:id", (req, res) => {
  const schedules = loadSchedules().filter((item) => item.id !== req.params.id);
  saveSchedules(schedules);
  resetSchedules();
  return res.json({ ok: true });
});

app.post("/api/schedules/:id/trigger", (req, res) => {
  const schedule = loadSchedules().find((item) => item.id === req.params.id);
  if (!schedule) {
    return res.status(404).json({ error: "Schedule not found" });
  }
  if (!schedule.configValid) {
    return res.status(400).json({
      error: `Cannot trigger schedule: ${schedule.configError}`,
      missingConfig: schedule.missingConfig,
    });
  }
  const result = triggerSchedulePipeline(schedule, { manual: true });
  if (result.started) {
    appendLog(result.jobId, `Manual trigger from schedule ${schedule.name}`);
  } else {
    appendLog(result.jobId, `Manual trigger skipped: active pipeline ${result.activeJobId}`);
  }
  return res.json({ jobId: result.jobId, started: result.started, skipped: result.skipped });
});

app.get("/api/schedules/:id/history", (req, res) => {
  const schedule = loadSchedules().find((item) => item.id === req.params.id);
  if (!schedule) {
    return res.status(404).json({ error: "Schedule not found" });
  }

  const jobs = loadJobs()
    .filter((job) => job.kind === "pipeline")
    .filter((job) => {
      const trigger = job.trigger || {};
      return trigger.scheduleId === schedule.id;
    })
    .slice(0, 20);

  return res.json({ scheduleId: schedule.id, history: jobs });
});

app.get("/api/files/tree", (req, res) => {
  try {
    const pathArg = String(req.query.path || "");
    const recursive = String(req.query.recursive || "0") === "1";
    const entries = listTree(pathArg, { recursive });
    return res.json({ path: pathArg, entries });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get("/api/files/content", (req, res) => {
  try {
    const filePath = String(req.query.path || "");
    const limit = Number(req.query.limit || 200);
    const content = readFileContent(filePath, limit);
    return res.json({ path: filePath, ...content });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get("/api/data/datasets", (req, res) => {
  const limit = Number(req.query.limit || 200);
  const datasets = getDefaultDatasets(limit);
  return res.json({ datasets });
});

app.post("/api/compare/order-id", (req, res) => {
  try {
    const orderId = String(req.body?.orderId || "");
    const files = Array.isArray(req.body?.files) ? req.body.files : [];

    const sources = files.map((filePath) => {
      const content = readFileContent(filePath, 0);
      const rows = Array.isArray(content.parsed) ? content.parsed : [];
      return { source: filePath, rows };
    });

    const result = compareByOrderId(orderId, sources);
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get("/api/config/outputs-root", (_req, res) => {
  const absolute = resolveOutputPath("");
  return res.json({ outputsRoot: absolute });
});

function normalizeOrderIdValue(value) {
  return String(value || "").trim().replace(/\.0$/, "");
}

function readLiveOrderStats() {
  const datasets = getDefaultDatasets(0);
  const statusRowsByBucket = {
    customer: datasets.customer.rows || [],
    found: datasets.found.rows || [],
    notfound: datasets.not_found.rows || [],
    review: datasets.review.rows || [],
  };
  const byOrderIdFromBuckets = new Map();

  Object.entries(statusRowsByBucket).forEach(([status, rows]) => {
    rows.forEach((row) => {
      const orderId = normalizeOrderIdValue(row.order_id || row.ord_id);
      if (!orderId) {
        return;
      }
      byOrderIdFromBuckets.set(orderId, { ...row, match_status: status });
    });
  });

  const rows = [];
  const seenOrderIds = new Set();
  (datasets.main.rows || []).forEach((row) => {
    const orderId = normalizeOrderIdValue(row.order_id || row.ord_id);
    const bucketRow = orderId ? byOrderIdFromBuckets.get(orderId) : null;
    const statusFromRow = getRowStatus(row);
    const normalizedStatus = statusFromRow !== "unknown"
      ? statusFromRow
      : bucketRow
        ? normalizeStatusValue(bucketRow.match_status)
        : "unknown";
    rows.push({ ...row, _normalizedStatus: normalizedStatus });
    if (orderId) {
      seenOrderIds.add(orderId);
    }
  });

  Object.entries(statusRowsByBucket).forEach(([status, bucketRows]) => {
    bucketRows.forEach((row) => {
      const orderId = normalizeOrderIdValue(row.order_id || row.ord_id);
      if (orderId && seenOrderIds.has(orderId)) {
        return;
      }
      rows.push({ ...row, _normalizedStatus: status });
      if (orderId) {
        seenOrderIds.add(orderId);
      }
    });
  });

  return {
    datasets,
    statusRowsByBucket,
    byOrderIdFromBuckets,
    rows,
  };
}

function buildOrderStatsSnapshot() {
  const live = readLiveOrderStats();
  const byDate = {};
  const byModel = {};
  let customer = 0;
  let found = 0;
  let notfound = 0;
  let review = 0;
  let unknown = 0;

  live.rows.forEach((row) => {
    const status = normalizeStatusValue(row._normalizedStatus || row.match_status || row.status);
    if (status === "customer") customer += 1;
    else if (status === "found") found += 1;
    else if (status === "notfound") notfound += 1;
    else if (status === "review") review += 1;
    else unknown += 1;

    const date = extractDateFromRow(row);
    if (date) {
      if (!byDate[date]) {
        byDate[date] = { date, total: 0, customer: 0, found: 0, notfound: 0, review: 0 };
      }
      byDate[date].total += 1;
      if (status === "customer") byDate[date].customer += 1;
      else if (status === "found") byDate[date].found += 1;
      else if (status === "notfound") byDate[date].notfound += 1;
      else if (status === "review") byDate[date].review += 1;
    }
  });

  const modelRuns = listModelRuns(1000);
  modelRuns.forEach((run) => {
    const model = run.modelName || "unknown";
    if (!byModel[model]) {
      byModel[model] = { model, total: 0, found: 0, notfound: 0, review: 0, success: 0, failed: 0 };
    }
    byModel[model].total += 1;
    if (run.status === "success") byModel[model].success += 1;
    else if (run.status === "failed") byModel[model].failed += 1;
  });

  const total = customer + found + notfound + review + unknown;
  return {
    summary: {
      total,
      customer,
      found,
      notfound,
      review,
      unknown,
      customerPct: total > 0 ? Number(((customer / total) * 100).toFixed(1)) : 0,
      foundPct: total > 0 ? Number(((found / total) * 100).toFixed(1)) : 0,
      notfoundPct: total > 0 ? Number(((notfound / total) * 100).toFixed(1)) : 0,
      reviewPct: total > 0 ? Number(((review / total) * 100).toFixed(1)) : 0,
    },
    reconciliation: {
      mainRows: live.datasets.main.rows.length,
      customerFileRows: live.statusRowsByBucket.customer.length,
      foundFileRows: live.statusRowsByBucket.found.length,
      notFoundFileRows: live.statusRowsByBucket.notfound.length,
      reviewFileRows: live.statusRowsByBucket.review.length,
      statusFileTotal:
        live.statusRowsByBucket.customer.length
        + live.statusRowsByBucket.found.length
        + live.statusRowsByBucket.notfound.length
        + live.statusRowsByBucket.review.length,
      matchedToStatusFiles: live.rows.filter((row) => live.byOrderIdFromBuckets.has(normalizeOrderIdValue(row.order_id || row.ord_id))).length,
    },
    byDate: Object.values(byDate)
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((day) => ({
        ...day,
        customerPct: day.total > 0 ? Number(((day.customer / day.total) * 100).toFixed(1)) : 0,
        foundPct: day.total > 0 ? Number(((day.found / day.total) * 100).toFixed(1)) : 0,
        notfoundPct: day.total > 0 ? Number(((day.notfound / day.total) * 100).toFixed(1)) : 0,
        reviewPct: day.total > 0 ? Number(((day.review / day.total) * 100).toFixed(1)) : 0,
      })),
    byModel: Object.values(byModel).sort((a, b) => b.total - a.total),
  };
}

// Pipeline global status: are any pipelines currently running?
app.get("/api/pipeline/status", (_req, res) => {
  const jobs = loadJobs();
  const schedules = loadSchedules();

  const runningPipelines = jobs.filter((job) => job.kind === "pipeline" && job.status === "running" && isJobActuallyActive(job, jobs));
  const runningScripts = jobs.filter((job) => job.kind === "script" && job.status === "running" && isJobActuallyActive(job, jobs));
  const queuedPipelines = jobs.filter((job) => job.kind === "pipeline" && job.status === "queued" && isJobActuallyActive(job, jobs));
  const queuedScripts = jobs.filter((job) => job.kind === "script" && job.status === "queued" && isJobActuallyActive(job, jobs));
  const activeWorkloads = runningPipelines.length + runningScripts.length + queuedPipelines.length + queuedScripts.length;
  const enabledSchedules = schedules.filter((schedule) => schedule.enabled);
  const readySchedules = enabledSchedules.filter((schedule) => schedule.configValid);
  const nextSchedule = readySchedules
    .map((schedule) => ({
      id: schedule.id,
      name: schedule.name,
      cron: schedule.cron,
      intervalMinutes: schedule.intervalMinutes,
      intervalUnit: schedule.intervalUnit,
      intervalValue: schedule.intervalValue,
      lastStatus: schedule.lastStatus || "idle",
      nextRunAt: schedule.nextRunAt || schedule.lastStartedAt || computeNextScheduleRunAt(schedule),
    }))
    .filter((schedule) => Boolean(schedule.nextRunAt))
    .sort((left, right) => String(left.nextRunAt).localeCompare(String(right.nextRunAt)))[0] || null;

  let state = "idle";
  if (activeWorkloads > 0) {
    state = "running";
  } else if (readySchedules.length === 0) {
    state = "disabled";
  }

  const nextScheduleInSeconds = nextSchedule?.nextRunAt
    ? Math.max(0, Math.floor((new Date(nextSchedule.nextRunAt).getTime() - Date.now()) / 1000))
    : null;

  return res.json({
    state,
    runningPipelines: runningPipelines.length,
    runningScripts: runningScripts.length,
    queuedPipelines: queuedPipelines.length,
    queuedScripts: queuedScripts.length,
    activeWorkloads,
    enabledSchedules: enabledSchedules.length,
    totalSchedules: schedules.length,
    nextSchedule,
    nextPipeline: queuedPipelines[0] || runningPipelines[0] || null,
    nextScript: queuedScripts[0] || runningScripts[0] || null,
    nextScheduleInSeconds,
    nextPipelineInSeconds: queuedPipelines[0] ? 0 : nextScheduleInSeconds,
    nextScriptInSeconds: queuedScripts[0] || runningScripts[0] ? 0 : null,
  });
});

// â”€â”€ Order Processing Stats API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function parseCsvFileForStats(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  const csvRows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];

    if (character === '"') {
      if (inQuotes && raw[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (character === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((character === "\n" || character === "\r") && !inQuotes) {
      if (character === "\r" && raw[index + 1] === "\n") {
        index += 1;
      }
      row.push(cell);
      if (row.some((value) => String(value || "").trim() !== "")) {
        csvRows.push(row);
      }
      row = [];
      cell = "";
      continue;
    }

    cell += character;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => String(value || "").trim() !== "")) {
      csvRows.push(row);
    }
  }

  if (csvRows.length < 2) return [];
  const headers = csvRows[0].map((header, index) => {
    const cleaned = String(header ?? "").replace(/^\uFEFF/, "").trim().toLowerCase();
    return cleaned || `column_${index + 1}`;
  });

  return csvRows.slice(1).map((values) => {
    const parsedRow = {};
    headers.forEach((header, index) => {
      parsedRow[header] = String(values[index] ?? "").trim();
    });
    return parsedRow;
  });
}

function classifyStatus(row) {
  const status = String(row.match_status || row.status || row.pplx_status || "").trim().toLowerCase();
  if (status === "found" || status === "matched") return "found";
  if (status === "notfound" || status === "not_found" || status === "not found") return "notfound";
  if (status === "review" || status === "needs_review" || status === "needs review") return "review";
  return "unknown";
}

function readStatusDatasetsByOrderId() {
  const files = {
    found: path.join(FUNERAL_OUTPUT_DIR, "Funeral_data_found.csv"),
    notfound: path.join(FUNERAL_OUTPUT_DIR, "Funeral_data_not_found.csv"),
    review: path.join(FUNERAL_OUTPUT_DIR, "Funeral_data_review.csv"),
  };
  const rowsByStatus = Object.fromEntries(
    Object.entries(files).map(([status, filePath]) => [status, parseCsvFileForStats(filePath)]),
  );
  const byOrderId = new Map();

  Object.entries(rowsByStatus).forEach(([status, rows]) => {
    rows.forEach((row) => {
      const orderId = String(row.order_id || "").trim();
      if (!orderId) {
        return;
      }
      byOrderId.set(orderId, { ...row, match_status: status });
    });
  });

  return { rowsByStatus, byOrderId };
}

function collectAlerts(limit = 50) {
  const alertsState = readJson(alertsStateFile, { clearedAt: null });
  const clearedAtMs = alertsState?.clearedAt ? Date.parse(alertsState.clearedAt) : null;
  const jobs = loadJobs();
  const alerts = [];
  const seen = new Set();

  jobs.forEach((job) => {
    (job.logs || []).forEach((line, lineIndex) => {
      const text = String(line || "");
      const lower = text.toLowerCase();
      if (lower.includes("run_summary|")) {
        return;
      }
      let type = "";
      let title = "";
      let severity = "info";

      if (lower.includes("api error") || lower.includes("response_status_code")) {
        type = "api";
        title = "API alert";
        severity = "error";
      } else if (lower.includes("process error") || lower.includes("traceback") || lower.includes("failed with code")) {
        type = "script";
        title = "Script runtime alert";
        severity = "error";
      } else if (
        job.status === "failed"
        && (lower.includes("failed") || lower.includes("error") || lower.includes("orphaned"))
      ) {
        type = "job";
        title = "Job alert";
        severity = "error";
      }

      if (!type) {
        return;
      }

      const createdAt = text.match(/^\[([^\]]+)\]/)?.[1] || job.updatedAt || job.createdAt;
      const createdAtMs = Date.parse(createdAt);
      if (Number.isFinite(clearedAtMs) && Number.isFinite(createdAtMs) && createdAtMs <= clearedAtMs) {
        return;
      }

      const id = `${job.id}:${lineIndex}:${type}`;
      if (seen.has(id)) {
        return;
      }
      seen.add(id);

      const raw = text.replace(/^\[[^\]]+\]\s*/, "");
      alerts.push({
        id,
        type,
        title,
        jobId: job.id,
        scriptId: job.scriptId || job.kind,
        status: job.status,
        severity,
        createdAt,
        message: raw,
        raw: JSON.stringify({
          title,
          type,
          severity,
          jobId: job.id,
          jobKind: job.kind,
          scriptId: job.scriptId || job.kind,
          status: job.status,
          exitCode: job.exitCode ?? null,
          createdAt,
          startedAt: job.startedAt || null,
          finishedAt: job.finishedAt || null,
          errorLine: raw,
          errorLogIndex: lineIndex,
          logs: job.logs || [],
        }, null, 2),
      });
    });
  });

  return alerts
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .slice(0, Math.max(1, Number(limit || 50)));
}

function extractDateFromRow(row) {
  const ts = row.last_processed_at || row.processed_at || row.processedAt || "";
  if (!ts) return null;
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}

app.get("/api/stats/order-processing", requireAuth, (_req, res) => {
  return res.json(buildOrderStatsSnapshot());
});

app.get("/api/stats/order-processing/by-date", requireAuth, (req, res) => {
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  const snapshot = buildOrderStatsSnapshot();
  const days = snapshot.byDate.filter((day) => (!from || day.date >= from) && (!to || day.date <= to));
  return res.json({ from, to, days });
});

app.get("/api/stats/model-performance", requireAuth, (_req, res) => {
  const modelRuns = listModelRuns(2000);
  const modelStats = {};

  modelRuns.forEach((run) => {
    const model = run.modelName || "unknown";
    if (!modelStats[model]) {
      modelStats[model] = {
        model,
        totalRuns: 0,
        success: 0,
        failed: 0,
        cancelled: 0,
        running: 0,
        successRate: 0,
      };
    }
    modelStats[model].totalRuns++;
    if (run.status === "success") modelStats[model].success++;
    else if (run.status === "failed") modelStats[model].failed++;
    else if (run.status === "cancelled") modelStats[model].cancelled++;
    else if (run.status === "running") modelStats[model].running++;
  });

  Object.values(modelStats).forEach((m) => {
    const completed = m.success + m.failed;
    m.successRate = completed > 0 ? Number(((m.success / completed) * 100).toFixed(1)) : 0;
  });

  return res.json({
    activeModel: getActiveModel(),
    models: Object.values(modelStats).sort((a, b) => b.totalRuns - a.totalRuns),
  });
});

app.get("/api/alerts", requireAuth, (req, res) => {
  const limit = Number(req.query.limit || 50);
  return res.json({ alerts: collectAlerts(limit) });
});

app.delete("/api/alerts", requireAdmin, (_req, res) => {
  const nextState = { clearedAt: new Date().toISOString() };
  writeJson(alertsStateFile, nextState);
  return res.json({ ok: true, clearedAt: nextState.clearedAt });
});

app.post("/api/alerts/clear", requireAdmin, (_req, res) => {
  const nextState = { clearedAt: new Date().toISOString() };
  writeJson(alertsStateFile, nextState);
  return res.json({ ok: true, clearedAt: nextState.clearedAt });
});

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(serverDir, "../dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get("*", (req, res, next) => {
    if (req.path === "/api" || req.path.startsWith("/api/")) {
      return next();
    }
    return res.sendFile(path.join(distDir, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});

