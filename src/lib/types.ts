export type ScriptStatus = "idle" | "running" | "success" | "failed" | "cancelled";

export interface ScriptConfig {
  id: string;
  name: string;
  description: string;
  hasOptions: boolean;
  options: string[];
  status?: ScriptStatus;
  lastRun?: string | null;
  duration?: string | null;
}

export interface Job {
  id: string;
  kind: "script" | "pipeline";
  model?: string | null;
  scriptId?: string | null;
  sequence?: Array<{ scriptId: string; option?: string }> | null;
  option?: string | null;
  trigger?: {
    type: "manual" | "schedule";
    scheduleId?: string;
    scheduleName?: string;
    manual?: boolean;
    immediate?: boolean;
    skipped?: boolean;
    skippedReason?: string;
    activeJobId?: string;
  };
  status: ScriptStatus | "queued";
  logs: string[];
  progress: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  exitCode?: number | null;
}

export interface CompareDifference {
  field: string;
  values: Array<{ source: string; value: unknown }>;
  category: string;
}

export interface CompareSummaryItem {
  category: string;
  count: number;
}

export interface DataRow {
  [key: string]: string | number | null;
}

export interface DatasetSummary {
  total: number;
  matched: number;
  needs_review: number;
  unmatched: number;
  last_processed_at: string | null;
}

export interface DatasetWithSummary {
  file: string;
  rows: DataRow[];
  summary?: DatasetSummary;
}

export interface FuneralDatasets {
  main: DatasetWithSummary;
  not_found: DatasetWithSummary;
  review: DatasetWithSummary;
  error: DatasetWithSummary;
  low: DatasetWithSummary;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number | null;
}

export interface ScheduleItem {
  id: string;
  name: string;
  cron: string;
  enabled: boolean;
  sequence: Array<{ scriptId: string; option?: string }>;
  createdAt: string;
  updatedAt?: string;
  lastTriggeredAt?: string;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastStatus?: string;
  lastJobId?: string;
}

export interface PreflightCheck {
  key: string;
  label: string;
  status: "pass" | "warn" | "fail";
  details: string;
}

export interface PreflightReport {
  ok: boolean;
  checkedAt: string;
  checks: PreflightCheck[];
}

export interface PipelineStatus {
  state: "idle" | "running" | "disabled";
  runningPipelines: number;
  runningScripts: number;
  queuedPipelines: number;
  queuedScripts: number;
  activeWorkloads: number;
  enabledSchedules: number;
  totalSchedules: number;
}

export interface AuthUser {
  id: string;
  username: string;
  role: "admin" | "user";
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSession {
  id: string;
  userId?: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt?: string | null;
}

export interface AuthState {
  user: AuthUser;
  session: AuthSession;
  activeModel: string;
  availableModels: string[];
  sessionTtlMinutes: number;
  reverifyDefaultProvider?: "perplexity" | "openai";
  configuredTimezone?: string;
  databasePath?: string;
}

export interface UserSummary extends AuthUser {}

export interface SessionSummary {
  id: string;
  userId: string;
  username: string;
  role: "admin" | "user";
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt?: string | null;
}

export interface AlertEntry {
  id: string;
  type: "api" | "script" | "job";
  title: string;
  jobId: string;
  scriptId: string;
  status: string;
  severity?: string;
  createdAt: string;
  message: string;
  raw: string;
}

export interface UsageMetrics {
  summary: {
    totalJobs: number;
    activeModel: string;
    sessionTtlMinutes: number;
  };
  byDay: Array<{
    day: string;
    total: number;
    success: number;
    failed: number;
    cancelled: number;
    running: number;
  }>;
  byHour: Array<{
    hour: string;
    total: number;
    success: number;
    failed: number;
    cancelled: number;
    running: number;
  }>;
  byModel: Array<{
    model: string;
    total: number;
    success: number;
    failed: number;
    cancelled: number;
    running: number;
    durationTotalSec: number;
    completedCount: number;
    successRate: number;
    averageDurationSec: number;
  }>;
  byScript: Array<{
    scriptId: string;
    total: number;
    success: number;
    failed: number;
    cancelled: number;
    running: number;
    durationTotalSec: number;
    completedCount: number;
    successRate: number;
    averageDurationSec: number;
  }>;
}

export interface OrderProcessingSummary {
  total: number;
  found: number;
  notfound: number;
  review: number;
  unknown: number;
  foundPct: number;
  notfoundPct: number;
  reviewPct: number;
  activeModel: string;
}

export interface OrderDateBucket {
  date: string;
  total: number;
  found: number;
  notfound: number;
  review: number;
  foundPct?: number;
  notfoundPct?: number;
  reviewPct?: number;
}

export interface OrderModelBucket {
  model: string;
  total: number;
  found: number;
  notfound: number;
  review: number;
  success: number;
  failed: number;
}

export interface OrderProcessingStats {
  summary: OrderProcessingSummary;
  reconciliation?: {
    mainRows: number;
    foundFileRows: number;
    notFoundFileRows: number;
    reviewFileRows: number;
    statusFileTotal: number;
    matchedToStatusFiles: number;
  };
  byDate: OrderDateBucket[];
  byModel: OrderModelBucket[];
}

export interface ModelPerformanceEntry {
  model: string;
  totalRuns: number;
  success: number;
  failed: number;
  cancelled: number;
  running: number;
  successRate: number;
}

export interface ModelPerformanceStats {
  activeModel: string;
  models: ModelPerformanceEntry[];
}
