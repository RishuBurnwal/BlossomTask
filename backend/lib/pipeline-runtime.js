const DEFAULT_INTERVAL_MINUTES = 30;

export function parseScheduleIntervalFromCron(cronExpression) {
  const parts = String(cronExpression || "").trim().split(/\s+/);
  if (parts.length === 5) {
    const everyMatch = parts[0].match(/^\*\/(\d{1,3})$/);
    if (!everyMatch) {
      return null;
    }

    const parsed = Number(everyMatch[1] || "0");
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }

    return {
      unit: "minutes",
      interval: Math.max(1, parsed),
      milliseconds: Math.max(1, parsed) * 60 * 1000,
    };
  }

  if (parts.length === 6) {
    const everyMatch = parts[0].match(/^\*\/(\d{1,3})$/);
    const wildcardRest = parts.slice(1).every((part) => part === "*");
    if (!everyMatch || !wildcardRest) {
      return null;
    }

    const parsed = Number(everyMatch[1] || "0");
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }

    return {
      unit: "seconds",
      interval: Math.max(1, parsed),
      milliseconds: Math.max(1, parsed) * 1000,
    };
  }

  return null;
}

export function parseIntervalMinutesFromCron(cronExpression) {
  const parsed = parseScheduleIntervalFromCron(cronExpression);
  if (!parsed) {
    return null;
  }
  return parsed.milliseconds / (60 * 1000);
}

export function resolveScheduleIntervalMinutes(schedule) {
  const fromCron = parseIntervalMinutesFromCron(schedule?.cron);
  return fromCron ?? DEFAULT_INTERVAL_MINUTES;
}

export function resolveScheduleIntervalMs(schedule) {
  const parsed = parseScheduleIntervalFromCron(schedule?.cron);
  if (parsed?.milliseconds) {
    return parsed.milliseconds;
  }
  return DEFAULT_INTERVAL_MINUTES * 60 * 1000;
}

export function toIsoString(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

export function computeNextScheduleRunAt(schedule, now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const intervalMs = resolveScheduleIntervalMs(schedule);
  const persistedNextRunMs = schedule?.nextRunAt ? new Date(schedule.nextRunAt).getTime() : NaN;

  if (Number.isFinite(persistedNextRunMs) && persistedNextRunMs > nowMs) {
    return new Date(persistedNextRunMs).toISOString();
  }

  const finishedAtMs = schedule?.lastFinishedAt ? new Date(schedule.lastFinishedAt).getTime() : NaN;
  if (Number.isFinite(finishedAtMs)) {
    const cooldownTargetMs = finishedAtMs + intervalMs;
    return new Date(Math.max(nowMs, cooldownTargetMs)).toISOString();
  }

  return new Date(nowMs + intervalMs).toISOString();
}

export function parseProgressSignal(output) {
  const text = String(output || "");
  if (!text.trim()) {
    return null;
  }

  let current = null;
  let total = null;

  // [N/M] bracket pattern
  const bracketMatch = text.match(/\[(\d+)\/(\d+)\]/);
  if (bracketMatch) {
    current = Number(bracketMatch[1]);
    total = Number(bracketMatch[2]);
  }

  // "Processing/Verifying N of M" pattern
  const ofMatch = text.match(/(?:Processing|Task|Order|Row|Record|Closing|Uploading|Verifying|Re-verifying)\s+(\d+)\s+of\s+(\d+)/i);
  if (ofMatch) {
    current = Number(ofMatch[1]);
    total = Number(ofMatch[2]);
  }

  // Percent complete pattern
  const percentMatch = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:complete|done|progress|finished)/i);
  if (percentMatch) {
    current = Number(percentMatch[1]);
    total = 100;
  }

  // "processed so far: N" pattern
  const processedMatch = text.match(/processed so far:\s*(\d+)/i);
  if (processedMatch && current === null) {
    current = Number(processedMatch[1]);
  }

  // LIVE PROCESSING - N tasks/orders (total signal)
  const totalMatch = text.match(/LIVE PROCESSING\s+[-–]\s+(\d+)\s+(?:tasks|orders)\b/i);
  if (totalMatch && total === null) {
    total = Number(totalMatch[1]);
  }

  // Reverify: "Checking XXXXXX [not_found|review]" with REVERIFY_TOTAL signal
  // Reverify emits: "REVERIFY_TOTAL|N" at start and "REVERIFY_PROGRESS|current|total" per row
  const reverifyTotalMatch = text.match(/REVERIFY_TOTAL\|(\d+)/i);
  if (reverifyTotalMatch) {
    total = Number(reverifyTotalMatch[1]);
    current = current ?? 0;
  }
  const reverifyProgressMatch = text.match(/REVERIFY_PROGRESS\|(\d+)\|(\d+)/i);
  if (reverifyProgressMatch) {
    current = Number(reverifyProgressMatch[1]);
    total = Number(reverifyProgressMatch[2]);
  }

  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) {
    return null;
  }

  // Use 99 as ceiling — 100% is only set when the job actually finishes
  return {
    mode: "determinate",
    current,
    total,
    progress: Math.max(0, Math.min(99, Math.round((current / total) * 100))),
  };
}

export function computePipelineProgress({ totalSteps, completedSteps, currentStepProgress = null }) {
  const normalizedTotal = Math.max(1, Number(totalSteps || 0));
  const normalizedCompleted = Math.max(0, Math.min(normalizedTotal, Number(completedSteps || 0)));
  const currentFraction = Number.isFinite(currentStepProgress)
    ? Math.max(0, Math.min(100, Number(currentStepProgress))) / 100
    : 0;
  const exactProgress = ((normalizedCompleted + currentFraction) / normalizedTotal) * 100;
  // Cap at 99 — the pipeline sets 100 only when all steps truly finish
  return Math.max(0, Math.min(99, Math.round(exactProgress)));
}

export function buildErrorReport(job, details = {}) {
  const logs = Array.isArray(job?.logs) ? job.logs.slice(-40) : [];
  const latestLog = logs.length > 0 ? logs[logs.length - 1] : "";

  return {
    kind: job?.kind || "unknown",
    jobId: job?.id || null,
    parentJobId: job?.parentJobId || null,
    scriptId: job?.scriptId || null,
    status: job?.status || "failed",
    exitCode: job?.exitCode ?? null,
    createdAt: new Date().toISOString(),
    startedAt: job?.startedAt || null,
    finishedAt: job?.finishedAt || null,
    progress: job?.progress ?? 0,
    message: details.message || latestLog || "Pipeline error detected",
    scheduleId: details.scheduleId || null,
    scheduleName: details.scheduleName || null,
    trigger: job?.trigger || null,
    logs,
  };
}
