import express from "express";
import cors from "cors";
import cron from "node-cron";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { compareByOrderId } from "./lib/compare.js";
import { getDefaultDatasets, listTree, readFileContent, resolveOutputPath } from "./lib/files.js";
import { getScriptById, scriptCatalog } from "./lib/scripts.js";
import { createId, readJson, writeJson } from "./lib/storage.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.BACKEND_PORT || 8787);
const jobsFile = "jobs.json";
const schedulesFile = "schedules.json";
const runningProcesses = new Map();
const scheduleTasks = new Map();
const PIPELINE_ORDER = ["get-task", "get-order-inquiry", "funeral-finder", "updater", "closing-task"];

function defaultPipelineSequence() {
  return [
    { scriptId: "get-task" },
    { scriptId: "get-order-inquiry" },
    { scriptId: "funeral-finder", option: "batch" },
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
      if (scriptId === "funeral-finder") {
        step.option = fromInput.option || "batch";
      } else if (fromInput.option) {
        step.option = fromInput.option;
      }
      normalized.push(step);
      return;
    }

    if (scriptId === "funeral-finder") {
      normalized.push({ scriptId, option: "batch" });
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
  const envPath = path.join(scriptsDir, ".env");
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
    label: "Scripts/.env",
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
  return readJson(jobsFile, []);
}

function saveJobs(jobs) {
  writeJson(jobsFile, jobs);
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
    scriptId: payload.scriptId ?? null,
    sequence: payload.sequence ?? null,
    option: payload.option ?? null,
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

function appendLog(jobId, line) {
  const jobs = loadJobs();
  const index = jobs.findIndex((entry) => entry.id === jobId);
  if (index === -1) return;
  const job = jobs[index];
  job.logs = [...job.logs, `[${new Date().toISOString()}] ${line}`].slice(-500);
  job.updatedAt = new Date().toISOString();
  jobs[index] = job;
  saveJobs(jobs);
}

async function runScriptJob({ jobId, scriptId, option }) {
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

  upsertJob(jobId, { status: "running", startedAt: new Date().toISOString(), progress: 5 });
  appendLog(jobId, `Starting ${script.name}`);

  const effectiveOption = scriptId === "funeral-finder"
    ? (option || "batch")
    : option;

  if (effectiveOption) {
    appendLog(jobId, `Run mode: ${effectiveOption}`);
  }

  const env = {
    ...process.env,
    RUN_MODE: effectiveOption || "",
    PYTHONUNBUFFERED: "1",
  };

  const child = spawn("python3", [script.file], {
    cwd: path.dirname(script.file),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  runningProcesses.set(jobId, child);

  if (scriptId === "funeral-finder" && effectiveOption === "interactive") {
    child.stdin.write("1\n");
  }
  child.stdin.end();

  child.stdout.on("data", (chunk) => {
    appendLog(jobId, chunk.toString().trim());
    const current = loadJobs().find((entry) => entry.id === jobId);
    if (current?.status === "running") {
      const nextProgress = Math.min(95, (current.progress || 5) + 3);
      upsertJob(jobId, { progress: nextProgress });
    }
  });

  child.stderr.on("data", (chunk) => {
    appendLog(jobId, chunk.toString().trim());
  });

  return new Promise((resolve) => {
    child.on("error", (error) => {
      runningProcesses.delete(jobId);
      upsertJob(jobId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        progress: 100,
        exitCode: 1,
      });
      appendLog(jobId, `Process error: ${error.message}`);
      resolve({ success: false, exitCode: 1 });
    });

    child.on("close", (code) => {
      runningProcesses.delete(jobId);
      const current = loadJobs().find((entry) => entry.id === jobId);
      if (current?.status === "cancelled") {
        upsertJob(jobId, {
          finishedAt: new Date().toISOString(),
          progress: 100,
          exitCode: code,
        });
        appendLog(jobId, `${script.name} stopped by user`);
        resolve({ success: false, exitCode: code ?? 1 });
        return;
      }
      const success = code === 0;
      upsertJob(jobId, {
        status: success ? "success" : "failed",
        finishedAt: new Date().toISOString(),
        progress: 100,
        exitCode: code,
      });
      appendLog(jobId, `${script.name} finished with code ${code}`);
      resolve({ success, exitCode: code ?? 1 });
    });
  });
}

async function runPipelineJob(jobId, sequence) {
  upsertJob(jobId, { status: "running", startedAt: new Date().toISOString(), progress: 1 });
  appendLog(jobId, `Pipeline started with ${sequence.length} steps`);

  for (let i = 0; i < sequence.length; i += 1) {
    const step = sequence[i];
    const stepJob = createJob({ kind: "script", scriptId: step.scriptId, option: step.option });
    appendLog(jobId, `Step ${i + 1}/${sequence.length} -> ${step.scriptId} (${stepJob.id})`);

    const done = await runScriptJob({ jobId: stepJob.id, scriptId: step.scriptId, option: step.option });

    if (!done.success) {
      upsertJob(jobId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        progress: 100,
        exitCode: done.exitCode ?? 1,
      });
      appendLog(jobId, `Pipeline failed at ${step.scriptId}`);
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
}

function loadSchedules() {
  return readJson(schedulesFile, []);
}

function saveSchedules(schedules) {
  writeJson(schedulesFile, schedules);
}

function registerSchedule(schedule) {
  if (!schedule.enabled) {
    return;
  }

  if (!cron.validate(schedule.cron)) {
    return;
  }

  const task = cron.schedule(schedule.cron, async () => {
    triggerSchedulePipeline(schedule);
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
  const running = getRunningPipelineForSchedule(schedule.id);
  if (running) {
    const skippedJob = createJob({
      kind: "pipeline",
      sequence: normalizeSequence(schedule.sequence),
      trigger: {
        type: "schedule",
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        skipped: true,
        skippedReason: "previous-run-active",
        activeJobId: running.id,
        ...triggerPatch,
      },
    });

    upsertJob(skippedJob.id, {
      status: "cancelled",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      progress: 100,
      exitCode: null,
    });
    appendLog(skippedJob.id, `Skipped: previous pipeline is still running (${running.id})`);
    return { jobId: skippedJob.id, started: false, skipped: true, activeJobId: running.id };
  }

  const sequence = normalizeSequence(schedule.sequence);
  const pipelineJob = createJob({
    kind: "pipeline",
    sequence,
    trigger: {
      type: "schedule",
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      ...triggerPatch,
    },
  });
  appendLog(pipelineJob.id, `Triggered by schedule ${schedule.name}`);
  runPipelineJob(pipelineJob.id, sequence);
  return { jobId: pipelineJob.id, started: true, skipped: false, activeJobId: null };
}

function resetSchedules() {
  scheduleTasks.forEach((task) => task.stop());
  scheduleTasks.clear();
  loadSchedules().forEach(registerSchedule);
}

resetSchedules();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "webui-backend" });
});

app.get("/api/preflight", (_req, res) => {
  const report = createPreflightReport();
  res.json(report);
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

app.post("/api/jobs/run-script", async (req, res) => {
  const { scriptId, option } = req.body || {};
  if (!scriptId) {
    return res.status(400).json({ error: "scriptId is required" });
  }
  const job = createJob({ kind: "script", scriptId, option: option || null });
  runScriptJob({ jobId: job.id, scriptId, option });
  return res.json({ jobId: job.id });
});

app.post("/api/jobs/run-pipeline", async (req, res) => {
  const sequence = normalizeSequence(req.body?.sequence);

  const job = createJob({
    kind: "pipeline",
    sequence,
    trigger: { type: "manual" },
  });
  runPipelineJob(job.id, sequence);
  return res.json({ jobId: job.id });
});

app.post("/api/jobs/:jobId/cancel", (req, res) => {
  const process = runningProcesses.get(req.params.jobId);
  if (!process) {
    return res.status(404).json({ error: "Running process not found" });
  }
  process.kill("SIGTERM");
  upsertJob(req.params.jobId, { status: "cancelled", finishedAt: new Date().toISOString() });
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
  if (schedule.enabled) {
    triggerSchedulePipeline(schedule, { immediate: true });
  }
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
  if (!wasEnabled && next.enabled) {
    triggerSchedulePipeline(next, { immediate: true });
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
      const content = readFileContent(filePath, 2000);
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

app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});
