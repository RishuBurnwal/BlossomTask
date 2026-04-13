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
