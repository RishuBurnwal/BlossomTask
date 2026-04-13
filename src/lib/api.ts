import type {
  CompareDifference,
  CompareSummaryItem,
  DataRow,
  FileEntry,
  Job,
  PipelineStatus,
  PreflightReport,
  ScheduleItem,
  ScriptConfig,
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`, {
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
    ...options,
  });

  if (!response.ok) {
    let message = `Request failed: ${response.status}`;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<{ ok: boolean; service: string }>("/health"),

  preflight: () => request<PreflightReport>("/preflight"),

  pipelineStatus: () => request<PipelineStatus>("/pipeline/status"),

  scripts: () => request<{ scripts: ScriptConfig[] }>("/scripts"),

  runScript: (scriptId: string, option?: string) =>
    request<{ jobId: string }>("/jobs/run-script", {
      method: "POST",
      body: JSON.stringify({ scriptId, option }),
    }),

  runPipeline: (sequence?: Array<{ scriptId: string; option?: string }>) =>
    request<{ jobId: string }>("/jobs/run-pipeline", {
      method: "POST",
      body: JSON.stringify({ sequence }),
    }),

  jobs: () => request<{ jobs: Job[] }>("/jobs"),

  clearJobs: () => request<{ ok: boolean }>("/jobs", { method: "DELETE" }),

  job: (jobId: string) => request<{ job: Job }>(`/jobs/${jobId}`),

  cancelJob: (jobId: string) =>
    request<{ ok: boolean }>(`/jobs/${jobId}/cancel`, { method: "POST" }),

  schedules: () => request<{ schedules: ScheduleItem[] }>("/schedules"),

  createSchedule: (payload: Partial<ScheduleItem>) =>
    request<{ schedule: ScheduleItem }>("/schedules", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  updateSchedule: (scheduleId: string, payload: Partial<ScheduleItem>) =>
    request<{ schedule: ScheduleItem }>(`/schedules/${scheduleId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  deleteSchedule: (scheduleId: string) =>
    request<{ ok: boolean }>(`/schedules/${scheduleId}`, {
      method: "DELETE",
    }),

  triggerSchedule: (scheduleId: string) =>
    request<{ jobId: string; started: boolean; skipped: boolean; activeJobId?: string | null }>(`/schedules/${scheduleId}/trigger`, {
      method: "POST",
    }),

  scheduleHistory: (scheduleId: string) =>
    request<{ scheduleId: string; history: Job[] }>(`/schedules/${scheduleId}/history`),

  datasets: () =>
    request<{
      datasets: {
        main: { file: string; rows: DataRow[]; summary?: { total: number; matched: number; needs_review: number; unmatched: number; last_processed_at: string | null } };
        error: { file: string; rows: DataRow[] };
        low: { file: string; rows: DataRow[] };
        review: { file: string; rows: DataRow[] };
      };
    }>("/data/datasets"),

  fileTree: (path = "", recursive = false) =>
    request<{ path: string; entries: FileEntry[] }>(
      `/files/tree?path=${encodeURIComponent(path)}&recursive=${recursive ? "1" : "0"}`,
    ),

  fileContent: (path: string, limit = 200) =>
    request<{ path: string; type: string; raw: string; parsed: DataRow[] }>(
      `/files/content?path=${encodeURIComponent(path)}&limit=${limit}`,
    ),

  compareOrder: (orderId: string, files: string[]) =>
    request<{
      orderId: string;
      matches: Array<{ source: string; row: DataRow }>;
      differences: CompareDifference[];
      summary: CompareSummaryItem[];
    }>("/compare/order-id", {
      method: "POST",
      body: JSON.stringify({ orderId, files }),
    }),
};
