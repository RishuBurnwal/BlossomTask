import express from "express";
import cors from "cors";
import cron from "node-cron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { execFile, execSync, spawn } from "node:child_process";
import { compareByOrderId } from "./lib/compare.js";
import { getDefaultDatasets, listTree, readFileContent, resolveOutputPath } from "./lib/files.js";
import { getScriptById, scriptCatalog } from "./lib/scripts.js";
import { createId, readJson, writeJson } from "./lib/storage.js";
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
  getSessionTtlMinutes,
  getSessionById,
  getUserById,
  listModelRuns,
  listSessions,
  listUsers,
  recordModelRun,
  revokeSession,
  revokeSessionsForUser,
  setActiveModel,
  setConfiguredTimezone,
  setSessionTtlMinutes,
  touchSession,
  updateUserPassword,
} from "./lib/auth-store.js";

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.BACKEND_PORT || 8787);
const jobsFile = "jobs.json";
const schedulesFile = "schedules.json";
const runHistoryFile = path.resolve(process.cwd(), "backend", "data", "run_history_logs.jsonl");
const runHistoryBackupFile = path.resolve(process.cwd(), "backend", "data", "run_history_logs.prev.jsonl");
const RUN_HISTORY_MAX_BYTES = Number(process.env.RUN_HISTORY_MAX_BYTES || 50 * 1024 * 1024);
const runningProcesses = new Map();
const scheduleTasks = new Map();
const PIPELINE_ORDER = ["get-task", "get-order-inquiry", "funeral-finder", "reverify", "updater", "closing-task"];
const AUTH_COOKIE_NAME = "blossom_session";
const ROOT_ENV_PATH = path.resolve(process.cwd(), ".env");

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
  return `${AUTH_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function clearSessionCookie() {
  return `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
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

function normalizeSequence(inputSequence) {
  const requested = Array.isArray(inputSequence) ? inputSequence : [];
  const byScriptId = new Map(
    requested
      .filter((step) => step && typeof step.scriptId === "string")
      .map((step) => [step.scriptId, step]),
  );

  const normalized = [];
  PIPELINE_ORDER.forEach((scriptId) => {
    const fromInput = byScriptId.get(scriptId);
    if (fromInput) {
      const step = { scriptId };
      if (scriptId === "reverify") {
        step.option = fromInput.option || "both";
      } else if (fromInput.option) {
        step.option = fromInput.option;
      }
      normalized.push(step);
      return;
    }

    if (scriptId === "reverify") {
      normalized.push({ scriptId, option: "both" });
    } else {
      normalized.push({ scriptId });
    }
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

function getActiveWorkload() {
  const jobs = loadJobs();
  return (
    jobs.find(
      (job) =>
        (job.kind === "script" || job.kind === "pipeline")
        && (job.status === "running" || job.status === "queued"),
    ) || null
  );
}

function saveJobs(jobs) {
  writeJson(jobsFile, jobs);
}

function reconcileOrphanedJobs() {
  const jobs = loadJobs();
  const now = new Date().toISOString();
  let changed = false;

  const updated = jobs.map((job) => {
    if (job.status !== "running" && job.status !== "queued") {
      return job;
    }

    const nextStatus = job.status === "running" ? "failed" : "cancelled";
    const reason = job.status === "running"
      ? "Recovered after backend restart: orphaned running job marked as failed"
      : "Recovered after backend restart: queued job marked as cancelled";
    const logLine = `[${now}] ${reason}`;

    changed = true;
    return {
      ...job,
      status: nextStatus,
      finishedAt: job.finishedAt || now,
      updatedAt: now,
      progress: 100,
      exitCode: nextStatus === "failed" ? 1 : job.exitCode,
      logs: [...(job.logs || []), logLine].slice(-500),
    };
  });

  if (changed) {
    saveJobs(updated);
    console.warn("Recovered orphaned queued/running jobs after backend restart");
  }
}

function upsertJob(jobId, patch) {
  const jobs = loadJobs();
  const index = jobs.findIndex((entry) => entry.id === jobId);
  if (index === -1) return null;
  jobs[index] = { ...jobs[index], ...patch, updatedAt: new Date().toISOString() };
  saveJobs(jobs);
  return jobs[index];
}

function createJob(payload) {
  const jobs = loadJobs();
  const job = {
    id: createId("job"),
    kind: payload.kind,
    parentJobId: payload.parentJobId ?? null,
    scriptId: payload.scriptId ?? null,
    sequence: payload.sequence ?? null,
    option: payload.option ?? null,
    model: payload.model ?? null,
    trigger: payload.trigger ?? { type: "manual" },
    status: "queued",
    logs: [],
    progress: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
  };
  jobs.unshift(job);
  saveJobs(jobs.slice(0, 200));
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

function appendLog(jobId, line) {
  const jobs = loadJobs();
  const index = jobs.findIndex((entry) => entry.id === jobId);
  if (index === -1) return;
  const job = jobs[index];
  const timestamp = new Date().toISOString();
  const sanitizedLine = sanitizeLogText(line);
  const formattedLine = `[${timestamp}] ${sanitizedLine}`;
  job.logs = [...job.logs, formattedLine].slice(-500);
  job.updatedAt = new Date().toISOString();
  jobs[index] = job;
  saveJobs(jobs);

  appendRunHistoryEntry({
    taskId: job.id,
    jobId: job.id,
    kind: job.kind,
    scriptId: job.scriptId ?? null,
    status: job.status,
    progress: job.progress,
    timestamp,
    message: sanitizedLine,
    fullLogs: job.logs,
  });
}

function updateProgressFromOutput(jobId, output) {
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

async function runScriptJob({ jobId, scriptId, option, modelName }) {
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

  upsertJob(jobId, { status: "running", startedAt: new Date().toISOString(), progress: 5, model: selectedModel });
  appendLog(jobId, `Starting ${script.name}`);
  appendLog(jobId, `Active model: ${selectedModel}`);

  const effectiveOption = scriptId === "reverify"
      ? (option || "both")
      : scriptId === "closing-task"
        ? (option || "live")
        : option;

  if (effectiveOption) {
    appendLog(jobId, `Run mode: ${effectiveOption}`);
  }

  const cancelFlagPath = path.join(process.cwd(), "Scripts", "outputs", `.cancel_${jobId}`);
  const env = {
    ...process.env,
    RUN_MODE: effectiveOption || "",
    PYTHONUNBUFFERED: "1",
    BLOSSOM_CANCEL_FLAG: cancelFlagPath,
    PERPLEXITY_MODEL: selectedModel,
    OPENAI_MODEL: selectedModel,
    BLOSSOM_TIMEZONE: getConfiguredTimezone(),
  };

  const scriptArgs = scriptId === "reverify" ? ["--force"] : [];
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
      upsertJob(jobId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        progress: 100,
        exitCode: 1,
      });
      appendLog(jobId, `Process error: ${error.message}`);
      appendScriptRunSummary(jobId, scriptId);
      resolve({ success: false, exitCode: 1 });
    });

    child.on("close", (code) => {
      runningProcesses.delete(jobId);
      const current = loadJobs().find((entry) => entry.id === jobId);
      if (current?.status === "cancelled") {
        finishModelRun(modelRunId, "cancelled");
        upsertJob(jobId, {
          finishedAt: new Date().toISOString(),
          progress: 100,
          exitCode: code,
        });
        appendLog(jobId, `${script.name} stopped by user`);
        appendScriptRunSummary(jobId, scriptId);
        resolve({ success: false, exitCode: code ?? 1 });
        return;
      }
      const success = code === 0;
      finishModelRun(modelRunId, success ? "success" : "failed");
      upsertJob(jobId, {
        status: success ? "success" : "failed",
        finishedAt: new Date().toISOString(),
        progress: 100,
        exitCode: code,
      });
      appendLog(jobId, `${script.name} finished with code ${code}`);
      appendScriptRunSummary(jobId, scriptId);
      resolve({ success, exitCode: code ?? 1 });
    });
  });
}

async function runPipelineJob(jobId, sequence, modelName) {
  const selectedModel = String(modelName || getActiveModel() || "sonar-pro");
  const scheduleId = loadJobs().find((entry) => entry.id === jobId)?.trigger?.scheduleId || null;
  upsertJob(jobId, { status: "running", startedAt: new Date().toISOString(), progress: 1, model: selectedModel });
  appendLog(jobId, `Pipeline started with ${sequence.length} steps`);
  appendLog(jobId, `Active model: ${selectedModel}`);

  for (let i = 0; i < sequence.length; i += 1) {
    const currentPipeline = loadJobs().find((entry) => entry.id === jobId);
    if (currentPipeline?.status === "cancelled") {
      appendLog(jobId, "Pipeline cancelled before next step");
      if (scheduleId) {
        updateScheduleMetadata(scheduleId, {
          lastFinishedAt: new Date().toISOString(),
          lastStatus: "cancelled",
        });
      }
      return;
    }
    const step = sequence[i];
    const stepJob = createJob({
      kind: "script",
      parentJobId: jobId,
      scriptId: step.scriptId,
      option: step.option,
      model: selectedModel,
    });
    appendLog(jobId, `Step ${i + 1}/${sequence.length} -> ${step.scriptId} (${stepJob.id})`);

    const done = await runScriptJob({ jobId: stepJob.id, scriptId: step.scriptId, option: step.option, modelName: selectedModel });

    if (!done.success) {
      upsertJob(jobId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        progress: 100,
        exitCode: done.exitCode ?? 1,
      });
      appendLog(jobId, `Pipeline failed at ${step.scriptId}`);
      if (scheduleId) {
        updateScheduleMetadata(scheduleId, {
          lastFinishedAt: new Date().toISOString(),
          lastStatus: "failed",
        });
      }
      return;
    }

    const progress = Math.round(((i + 1) / sequence.length) * 100);
    upsertJob(jobId, { progress });
  }

  upsertJob(jobId, {
    status: "success",
    finishedAt: new Date().toISOString(),
    progress: 100,
    exitCode: 0,
  });
  appendLog(jobId, "Pipeline completed successfully");
  if (scheduleId) {
    updateScheduleMetadata(scheduleId, {
      lastFinishedAt: new Date().toISOString(),
      lastStatus: "success",
    });
  }
}

function loadSchedules() {
  const schedules = readJson(schedulesFile, []);
  return Array.isArray(schedules) ? schedules : [];
}

function saveSchedules(schedules) {
  writeJson(schedulesFile, schedules);
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
  if (!schedule.enabled) {
    return;
  }

  if (!cron.validate(schedule.cron)) {
    console.warn(`[cron] Invalid cron expression for schedule '${schedule.name}': ${schedule.cron}`);
    return;
  }

  // Load the freshest copy of the schedule from disk each time cron fires,
  // so that enable/disable changes made after registration take effect.
  const task = cron.schedule(schedule.cron, async () => {
    const freshSchedule = loadSchedules().find((s) => s.id === schedule.id);
    if (!freshSchedule || !freshSchedule.enabled) {
      return; // Schedule was disabled after it was registered; skip silently.
    }
    triggerSchedulePipeline(freshSchedule);
  });

  scheduleTasks.set(schedule.id, task);
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

function triggerSchedulePipeline(schedule, triggerPatch = {}) {
  const now = new Date().toISOString();
  const activeWorkload = getActiveWorkload();

  if (activeWorkload) {
    // Active workload running → record a skipped trigger but do NOT pollute lastTriggeredAt
    // with a timestamp that looks like a real run to the user.
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
        activeJobId: activeWorkload.id,
        ...triggerPatch,
      },
    });

    upsertJob(skippedJob.id, {
      status: "cancelled",
      startedAt: now,
      finishedAt: now,
      progress: 100,
      exitCode: null,
    });
    appendLog(
      skippedJob.id,
      `Skipped: active workload in progress (${activeWorkload.kind}:${activeWorkload.id})`,
    );
    // Only update lastStatus/lastJobId — do NOT touch lastTriggeredAt or lastStartedAt
    // so the UI does not show a "fake" last-run timestamp for a skipped cycle.
    updateScheduleMetadata(schedule.id, {
      lastJobId: skippedJob.id,
      lastFinishedAt: now,
      lastStatus: "skipped",
    });
    return { jobId: skippedJob.id, started: false, skipped: true, activeJobId: activeWorkload.id };
  }

  // Real trigger → update lastTriggeredAt only now, when we actually start a pipeline.
  updateScheduleMetadata(schedule.id, {
    lastTriggeredAt: now,
    lastStatus: "queued",
  });

  const sequence = normalizeSequence(schedule.sequence);
  const pipelineJob = createJob({
    kind: "pipeline",
    sequence,
    model: getActiveModel(),
    trigger: {
      type: "schedule",
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      ...triggerPatch,
    },
  });
  appendLog(pipelineJob.id, `Triggered by schedule ${schedule.name}`);
  updateScheduleMetadata(schedule.id, {
    lastJobId: pipelineJob.id,
    lastStartedAt: now,
    lastStatus: "running",
  });
  runPipelineJob(pipelineJob.id, sequence, getActiveModel());
  return { jobId: pipelineJob.id, started: true, skipped: false, activeJobId: null };
}

function resetSchedules() {
  scheduleTasks.forEach((task) => task.stop());
  scheduleTasks.clear();
  loadSchedules().forEach(registerSchedule);
}

resetSchedules();
reconcileOrphanedJobs();
seedRunHistoryFromExistingJobs();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "webui-backend" });
});

app.get("/api/preflight", (_req, res) => {
  const report = createPreflightReport();
  res.json(report);
});

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
  });
});

app.use("/api", requireAuth);

app.get("/api/auth/me", (req, res) => {
  return res.json({
    user: req.auth.user,
    session: req.auth.session,
    activeModel: getActiveModel(),
    availableModels,
    sessionTtlMinutes: getSessionTtlMinutes(),
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

app.get("/api/scripts", (_req, res) => {
  const scripts = scriptCatalog.map((script) => ({
    id: script.id,
    name: script.name,
    description: script.description,
    hasOptions: script.hasOptions,
    options: script.options,
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
  const { scriptId, option } = req.body || {};
  if (!scriptId) {
    return res.status(400).json({ error: "scriptId is required" });
  }
  const activeWorkload = getActiveWorkload();
  if (activeWorkload) {
    return res.status(409).json({
      error: `Another workload is already running (${activeWorkload.kind}:${activeWorkload.id}). Wait until it finishes.`,
    });
  }
  const model = getActiveModel();
  const job = createJob({ kind: "script", scriptId, option: option || null, model });
  runScriptJob({ jobId: job.id, scriptId, option, modelName: model });
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
  if (!cron.validate(body.cron)) {
    return res.status(400).json({ error: "Invalid cron expression" });
  }

  const schedule = {
    id: createId("schedule"),
    name: body.name,
    cron: body.cron,
    enabled: body.enabled ?? true,
    sequence: normalizeSequence(body.sequence),
    createdAt: new Date().toISOString(),
  };

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
  if (next.cron && !cron.validate(next.cron)) {
    return res.status(400).json({ error: "Invalid cron expression" });
  }
  schedules[index] = next;
  saveSchedules(schedules);
  resetSchedules();

  // When disabling a schedule, cancel any running pipelines for it
  if (wasEnabled && !next.enabled) {
    const runningPipeline = getRunningPipelineForSchedule(req.params.id);
    if (runningPipeline) {
      const childProc = getRunningChildProcessForPipeline(runningPipeline.id)?.childProc;
      if (childProc) {
        killJobProcess(childProc);
      }
      upsertJob(runningPipeline.id, {
        status: "cancelled",
        finishedAt: new Date().toISOString(),
        progress: 100,
      });
      appendLog(runningPipeline.id, "Pipeline cancelled: schedule was disabled");
      updateScheduleMetadata(req.params.id, {
        lastFinishedAt: new Date().toISOString(),
        lastStatus: "cancelled",
      });
    }
  }
  return res.json({ schedule: next });
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

// Pipeline global status: are any pipelines currently running?
app.get("/api/pipeline/status", (_req, res) => {
  const jobs = loadJobs();
  const schedules = loadSchedules();

  const runningPipelines = jobs.filter(
    (job) => job.kind === "pipeline" && job.status === "running",
  );
  const runningScripts = jobs.filter(
    (job) => job.kind === "script" && job.status === "running",
  );
  const queuedPipelines = jobs.filter(
    (job) => job.kind === "pipeline" && job.status === "queued",
  );
  const queuedScripts = jobs.filter(
    (job) => job.kind === "script" && job.status === "queued",
  );
  const activeWorkloads = runningPipelines.length + runningScripts.length + queuedPipelines.length + queuedScripts.length;
  const anyEnabled = schedules.some((s) => s.enabled);

  let state = "idle";
  if (activeWorkloads > 0) {
    state = "running";
  } else if (!anyEnabled) {
    state = "disabled";
  }

  return res.json({
    state,
    runningPipelines: runningPipelines.length,
    runningScripts: runningScripts.length,
    queuedPipelines: queuedPipelines.length,
    queuedScripts: queuedScripts.length,
    activeWorkloads,
    enabledSchedules: schedules.filter((s) => s.enabled).length,
    totalSchedules: schedules.length,
  });
});

// ── Order Processing Stats API ──────────────────────────────────────────────

function parseCsvFileForStats(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.replace(/^\uFEFF/, "").trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const values = [];
    let cell = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === "," && !inQuotes) { values.push(cell); cell = ""; continue; }
      cell += ch;
    }
    values.push(cell);
    const row = {};
    headers.forEach((h, idx) => { row[h] = (values[idx] || "").trim(); });
    return row;
  });
}

function classifyStatus(row) {
  const status = String(row.match_status || row.status || row.pplx_status || "").trim().toLowerCase();
  if (status === "found" || status === "matched") return "found";
  if (status === "notfound" || status === "not_found" || status === "not found") return "notfound";
  if (status === "review" || status === "needs_review" || status === "needs review") return "review";
  return "unknown";
}

function extractDateFromRow(row) {
  const ts = row.last_processed_at || row.processed_at || row.processedAt || "";
  if (!ts) return null;
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

app.get("/api/stats/order-processing", requireAuth, (_req, res) => {
  const funeralDataPath = path.resolve(process.cwd(), "Scripts", "outputs", "Funeral_Finder", "Funeral_data.csv");
  const rows = parseCsvFileForStats(funeralDataPath);

  let found = 0, notfound = 0, review = 0, unknown = 0;
  const byDate = {};
  const byModel = {};

  rows.forEach((row) => {
    const status = classifyStatus(row);
    if (status === "found") found++;
    else if (status === "notfound") notfound++;
    else if (status === "review") review++;
    else unknown++;

    const date = extractDateFromRow(row);
    if (date) {
      if (!byDate[date]) byDate[date] = { date, found: 0, notfound: 0, review: 0, total: 0 };
      byDate[date].total++;
      if (status === "found") byDate[date].found++;
      else if (status === "notfound") byDate[date].notfound++;
      else if (status === "review") byDate[date].review++;
    }
  });

  // Merge model performance data from model_runs table
  const modelRuns = listModelRuns(1000);

  modelRuns.forEach((run) => {
    const model = run.modelName || "unknown";
    if (!byModel[model]) byModel[model] = { model, total: 0, found: 0, notfound: 0, review: 0, success: 0, failed: 0 };
    byModel[model].total++;
    if (run.status === "success") byModel[model].success++;
    else if (run.status === "failed") byModel[model].failed++;
  });

  // Try to assign order-level stats to models from date-wise logs
  const dateWiseDir = path.resolve(process.cwd(), "Scripts", "outputs", "Funeral_Finder", "date_wise");
  if (fs.existsSync(dateWiseDir)) {
    const dateDirs = fs.readdirSync(dateWiseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    dateDirs.forEach((dateDir) => {
      const foundPath = path.join(dateWiseDir, dateDir, "Funeral_data_found.csv");
      const notFoundPath = path.join(dateWiseDir, dateDir, "Funeral_data_not_found.csv");
      const reviewPath = path.join(dateWiseDir, dateDir, "Funeral_data_review.csv");

      const foundRows = parseCsvFileForStats(foundPath).length;
      const notFoundRows = parseCsvFileForStats(notFoundPath).length;
      const reviewRows = parseCsvFileForStats(reviewPath).length;

      if (!byDate[dateDir]) {
        byDate[dateDir] = { date: dateDir, found: foundRows, notfound: notFoundRows, review: reviewRows, total: foundRows + notFoundRows + reviewRows };
      }
    });
  }

  const total = found + notfound + review + unknown;
  const foundPct = total > 0 ? Number(((found / total) * 100).toFixed(1)) : 0;
  const notfoundPct = total > 0 ? Number(((notfound / total) * 100).toFixed(1)) : 0;
  const reviewPct = total > 0 ? Number(((review / total) * 100).toFixed(1)) : 0;

  return res.json({
    summary: {
      total,
      found,
      notfound,
      review,
      unknown,
      foundPct,
      notfoundPct,
      reviewPct,
      activeModel: getActiveModel(),
    },
    byDate: Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date)),
    byModel: Object.values(byModel).sort((a, b) => b.total - a.total),
  });
});

app.get("/api/stats/order-processing/by-date", requireAuth, (req, res) => {
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  const dateWiseDir = path.resolve(process.cwd(), "Scripts", "outputs", "Funeral_Finder", "date_wise");
  const result = [];

  if (!fs.existsSync(dateWiseDir)) {
    return res.json({ from, to, days: [] });
  }

  const dateDirs = fs.readdirSync(dateWiseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .filter((d) => (!from || d >= from) && (!to || d <= to))
    .sort();

  dateDirs.forEach((dateDir) => {
    const mainPath = path.join(dateWiseDir, dateDir, "Funeral_data.csv");
    const rows = parseCsvFileForStats(mainPath);
    let found = 0, notfound = 0, review = 0;
    rows.forEach((row) => {
      const s = classifyStatus(row);
      if (s === "found") found++;
      else if (s === "notfound") notfound++;
      else if (s === "review") review++;
    });
    const total = found + notfound + review;
    result.push({
      date: dateDir,
      total,
      found,
      notfound,
      review,
      foundPct: total > 0 ? Number(((found / total) * 100).toFixed(1)) : 0,
      notfoundPct: total > 0 ? Number(((notfound / total) * 100).toFixed(1)) : 0,
      reviewPct: total > 0 ? Number(((review / total) * 100).toFixed(1)) : 0,
    });
  });

  return res.json({ from, to, days: result });
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
