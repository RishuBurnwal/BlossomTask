import type {
  AuthState,
  AlertEntry,
  CompareDifference,
  CompareSummaryItem,
  DataRow,
  FileEntry,
  Job,
  FuneralDatasets,
  GoogleSyncRunResult,
  GoogleSyncState,
  GoogleSyncManifest,
  ModelPerformanceStats,
  OrderDateBucket,
  OrderProcessingStats,
  PipelineStatus,
  PreflightReport,
  ScheduleItem,
  ScriptConfig,
  SessionSummary,
  UserSummary,
  UsageMetrics,
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";

function backendBaseUrl() {
  if (/^https?:\/\//i.test(API_BASE)) {
    return new URL(API_BASE).origin;
  }
  if (typeof window !== "undefined") {
    const { protocol, hostname, port } = window.location;
    if ((hostname === "localhost" || hostname === "127.0.0.1") && (port === "8080" || port === "5173")) {
      return `${protocol}//${hostname}:8787`;
    }
  }
  return "";
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`, {
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
    credentials: "include",
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
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("blossom-auth-expired", { detail: { message } }));
    }
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

async function clearAlertsRequest(): Promise<{ ok: boolean; clearedAt: string }> {
  const localFallback = { ok: true, clearedAt: new Date().toISOString() };

  try {
    return await request<{ ok: boolean; clearedAt: string }>("/alerts", { method: "DELETE" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("404")) {
      return localFallback;
    }
  }

  try {
    return await request<{ ok: boolean; clearedAt: string }>("/alerts/clear", {
      method: "POST",
      body: JSON.stringify({}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("404")) {
      return localFallback;
    }
  }

  return localFallback;
}

export const api = {
  googleOAuthUrl: () => `${backendBaseUrl()}/auth/google`,

  health: () => request<{ ok: boolean; service: string }>("/health"),

  preflight: () => request<PreflightReport>("/preflight"),

  metrics: () => request<UsageMetrics>("/metrics"),

  authMe: () => request<AuthState>("/auth/me"),

  login: (username: string, password: string) =>
    request<AuthState>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),

  logoutAll: () => request<{ ok: boolean }>("/auth/logout-all", { method: "POST" }),

  clearOtherSessions: () =>
    request<{ ok: boolean; removed: number }>("/auth/me/sessions/others", { method: "DELETE" }),

  users: () => request<{ users: UserSummary[] }>("/auth/users"),

  createUser: (payload: { username: string; password: string; role: "admin" | "user" }) =>
    request<{ user: UserSummary }>("/auth/users", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  updateUserPassword: (userId: string, password: string) =>
    request<{ ok: boolean }>(`/auth/users/${userId}/password`, {
      method: "PUT",
      body: JSON.stringify({ password }),
    }),

  deleteUser: (userId: string) =>
    request<{ ok: boolean }>(`/auth/users/${userId}`, { method: "DELETE" }),

  sessions: () => request<{ sessions: SessionSummary[] }>("/auth/sessions"),

  revokeSession: (sessionId: string) =>
    request<{ ok: boolean }>(`/auth/sessions/${sessionId}`, { method: "DELETE" }),

  purgeInactiveSessions: () =>
    request<{ ok: boolean; removed: number }>("/auth/sessions/inactive", { method: "DELETE" }),

  revokeUserSessions: (userId: string) =>
    request<{ ok: boolean; message: string }>(`/auth/users/${userId}/sessions`, { method: "DELETE" }),

  setModel: (model: string) =>
    request<{ activeModel: string; availableModels: string[] }>("/auth/model", {
      method: "PUT",
      body: JSON.stringify({ model }),
    }),

  setSessionTtl: (minutes: number) =>
    request<{ sessionTtlMinutes: number }>("/auth/settings/session-ttl", {
      method: "PUT",
      body: JSON.stringify({ minutes }),
    }),

  setTimezone: (timeZone: string) =>
    request<{ configuredTimezone: string }>("/auth/settings/timezone", {
      method: "PUT",
      body: JSON.stringify({ timeZone }),
    }),

  setReverifyProvider: (provider: "perplexity" | "openai") =>
    request<{ reverifyDefaultProvider: "perplexity" | "openai" }>("/auth/settings/reverify-provider", {
      method: "PUT",
      body: JSON.stringify({ provider }),
    }),

  pipelineStatus: () => request<PipelineStatus>("/pipeline/status"),

  orderProcessingStats: () => request<OrderProcessingStats>("/stats/order-processing"),

  orderProcessingByDate: (from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return request<{ from: string; to: string; days: OrderDateBucket[] }>(`/stats/order-processing/by-date?${params.toString()}`);
  },

  modelPerformance: () => request<ModelPerformanceStats>("/stats/model-performance"),

  alerts: (limit = 50) => request<{ alerts: AlertEntry[] }>(`/alerts?limit=${limit}`),

  clearAlerts: () => clearAlertsRequest(),

  scripts: () => request<{ scripts: ScriptConfig[] }>("/scripts"),

  runScript: (scriptId: string, payload?: { option?: string; forceLatestCount?: number }) =>
    request<{ jobId: string }>("/jobs/run-script", {
      method: "POST",
      body: JSON.stringify({
        scriptId,
        option: payload?.option,
        forceLatestCount: payload?.forceLatestCount,
      }),
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
      datasets: FuneralDatasets;
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

  googleSync: () => request<GoogleSyncState>("/google-sync"),

  googleSyncFiles: () => request<GoogleSyncManifest>("/google-sync/files"),

  saveGoogleSyncConfig: (payload: { enabled?: boolean; folderName?: string; credentialsPath?: string; driveRootFolderId?: string; credentialsJson?: string }) =>
    request<GoogleSyncState>("/google-sync/config", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  runGoogleSync: (payload?: { target?: "workspace" | "outputs"; scope?: string; mode?: "approved-runtime" }) =>
    request<GoogleSyncRunResult>("/google-sync/run", {
      method: "POST",
      body: JSON.stringify(payload || {}),
    }),
};
