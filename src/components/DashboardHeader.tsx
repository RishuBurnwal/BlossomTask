import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ChevronDown,
  ChevronUp,
  Clock,
  Globe2,
  Moon,
  Play,
  Power,
  Settings2,
  ShieldCheck,
  Sun,
  Trash2,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTheme } from "@/contexts/ThemeContext";
import { api } from "@/lib/api";
import { formatDateTime, formatTimeZoneLabel, GMT_TIMEZONE_OPTIONS } from "@/lib/time";
import { toast } from "sonner";
import type { Job, PipelineStatus } from "@/lib/types";

function lastScheduleTimestamp(job: Job): string | null {
  return job.finishedAt || job.startedAt || job.createdAt || null;
}

export function DashboardHeader() {
  const queryClient = useQueryClient();
  const { isDark, toggleDark, darknessLevel, setDarknessLevel } = useTheme();
  const [cronFrequency, setCronFrequency] = useState("30");
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null);
  const [selectedHistoryJobId, setSelectedHistoryJobId] = useState<string | null>(null);
  const [showPreflight, setShowPreflight] = useState(false);
  const [pipelineReverifySource, setPipelineReverifySource] = useState("both");
  const [selectedModel, setSelectedModel] = useState("sonar-pro");
  const [reverifyDefaultProvider, setReverifyDefaultProvider] = useState<"perplexity" | "openai">("perplexity");
  const [configuredTimezone, setConfiguredTimezone] = useState("UTC");
  const [liveClock, setLiveClock] = useState(new Date().toISOString());

  // Tick live clock every second
  useEffect(() => {
    const interval = setInterval(() => setLiveClock(new Date().toISOString()), 1000);
    return () => clearInterval(interval);
  }, []);

  const { data: authData } = useQuery({
    queryKey: ["auth"],
    queryFn: api.authMe,
    refetchInterval: 30_000,
  });

  const { data: pipelineStatusData } = useQuery({
    queryKey: ["pipeline-status"],
    queryFn: api.pipelineStatus,
    refetchInterval: 3000,
  });

  const { data: scheduleData } = useQuery({
    queryKey: ["schedules"],
    queryFn: api.schedules,
    refetchInterval: 3000,
  });

  const authUser = authData?.user;
  const isAdmin = authUser?.role === "admin";
  const activeModel = authData?.activeModel || "sonar-pro";
  const availableModels = authData?.availableModels ?? [activeModel];
  const currentTimezone = authData?.configuredTimezone || "UTC";
  const currentReverifyDefaultProvider = authData?.reverifyDefaultProvider || "perplexity";
  const pipelineStatus = pipelineStatusData as PipelineStatus | undefined;
  const pipelineState = pipelineStatus?.state ?? "idle";
  const executionLocked = (pipelineStatus?.activeWorkloads ?? 0) > 0;
  const schedules = scheduleData?.schedules ?? [];
  const activeScheduleId = selectedScheduleId || schedules[0]?.id || "";
  const selectedSchedule = schedules.find((item) => item.id === activeScheduleId) || schedules[0] || null;

  useEffect(() => {
    setSelectedModel(activeModel);
  }, [activeModel]);

  useEffect(() => {
    setConfiguredTimezone(currentTimezone);
  }, [currentTimezone]);

  useEffect(() => {
    setReverifyDefaultProvider(currentReverifyDefaultProvider);
  }, [currentReverifyDefaultProvider]);

  const { data: scheduleHistoryData } = useQuery({
    queryKey: ["schedule-history", activeScheduleId],
    queryFn: () => api.scheduleHistory(activeScheduleId),
    enabled: Boolean(activeScheduleId),
    refetchInterval: 8000,
  });

  const { data: selectedJobData } = useQuery({
    queryKey: ["job", selectedHistoryJobId],
    queryFn: () => api.job(selectedHistoryJobId as string),
    enabled: Boolean(selectedHistoryJobId),
    refetchInterval: (query) => {
      const status = query.state.data?.job?.status;
      if (!status || ["success", "failed", "cancelled"].includes(status)) {
        return false;
      }
      return 2000;
    },
  });

  const runHistoryItems = useMemo(() => scheduleHistoryData?.history ?? [], [scheduleHistoryData?.history]);

  const runPipeline = useMutation({
    mutationFn: () => api.runPipeline([
      { scriptId: "get-task" },
      { scriptId: "get-order-inquiry" },
      { scriptId: "funeral-finder" },
      { scriptId: "reverify", option: pipelineReverifySource },
      { scriptId: "updater", option: "complete" },
      { scriptId: "closing-task" },
    ]),
    onSuccess: ({ jobId }) => toast.success(`Pipeline started (${jobId})`),
    onError: (error) => toast.error(error.message || "Failed to start pipeline"),
  });

  const saveSchedule = useMutation({
    mutationFn: async () => {
      const cronExpression = `*/${Math.max(1, Number(cronFrequency || "30"))} * * * *`;
      const payload = {
        name: selectedSchedule?.name || "Default Sequential Pipeline",
        cron: cronExpression,
        enabled: selectedSchedule?.enabled ?? true,
      };

      if (selectedSchedule) {
        return api.updateSchedule(selectedSchedule.id, payload);
      }

      const existingDefault = schedules.find((item) => item.name === "Default Sequential Pipeline");
      if (existingDefault) {
        return api.updateSchedule(existingDefault.id, { ...payload, enabled: existingDefault.enabled });
      }

      return api.createSchedule(payload);
    },
    onSuccess: () => {
      toast.success("Cron schedule saved");
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
    },
    onError: (error) => toast.error(error.message || "Failed to save schedule"),
  });

  const toggleSchedule = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.updateSchedule(id, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
      queryClient.invalidateQueries({ queryKey: ["schedule-history"] });
    },
    onError: (error) => toast.error(error.message || "Failed to update schedule"),
  });

  const deleteSchedule = useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => {
      toast.success("Schedule deleted");
      setSelectedScheduleId(null);
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
      queryClient.invalidateQueries({ queryKey: ["schedule-history"] });
    },
    onError: (error) => toast.error(error.message || "Failed to delete schedule"),
  });

  const triggerSchedule = useMutation({
    mutationFn: (id: string) => api.triggerSchedule(id),
    onSuccess: ({ jobId, started, skipped, activeJobId }) => {
      if (!started || skipped) {
        toast.info(
          activeJobId
            ? `Schedule skipped because another workload is active (${activeJobId})`
            : `Schedule skipped because another workload is active (${jobId})`,
        );
      } else {
        toast.success(`Schedule triggered (${jobId})`);
      }
      queryClient.invalidateQueries({ queryKey: ["schedule-history"] });
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
    },
    onError: (error) => toast.error(error.message || "Failed to trigger schedule"),
  });

  const clearHistory = useMutation({
    mutationFn: () => api.clearJobs(),
    onSuccess: () => {
      setSelectedHistoryJobId(null);
      toast.success("Run history cleared");
      queryClient.invalidateQueries({ queryKey: ["schedule-history"] });
    },
    onError: (error) => toast.error(error.message || "Failed to clear run history"),
  });

  const preflightMutation = useMutation({
    mutationFn: () => api.preflight(),
    onSuccess: (report) => {
      setShowPreflight(true);
      if (report.ok) {
        toast.success("Preflight passed");
      } else {
        toast.error("Preflight found blocking issues");
      }
    },
    onError: (error) => toast.error(error.message || "Failed to run preflight"),
  });

  const logoutMutation = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["auth"] });
      queryClient.invalidateQueries();
      toast.success("Signed out");
    },
    onError: (error) => toast.error(error.message || "Failed to sign out"),
  });

  const setModelMutation = useMutation({
    mutationFn: (model: string) => api.setModel(model),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ["auth"] });
      toast.success(`Active model set to ${response.activeModel}`);
    },
    onError: (error) => toast.error(error.message || "Failed to update model"),
  });

  const setTimezoneMutation = useMutation({
    mutationFn: (timeZone: string) => api.setTimezone(timeZone),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ["auth"] });
      toast.success(`Timezone updated to ${response.configuredTimezone}`);
    },
    onError: (error) => toast.error(error.message || "Failed to update timezone"),
  });

  const setReverifyProviderMutation = useMutation({
    mutationFn: (provider: "perplexity" | "openai") => api.setReverifyProvider(provider),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ["auth"] });
      toast.success(`Reverify default set to ${response.reverifyDefaultProvider}`);
    },
    onError: (error) => toast.error(error.message || "Failed to update reverify provider"),
  });

  const toggledScheduleId = toggleSchedule.variables?.id;

  return (
    <div className="relative z-10 border-b bg-background shadow-sm">
      <header className="px-4 py-3 lg:px-6">
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary">
              <Settings2 className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">DataFlow Pipeline</h1>
              <p className="text-xs text-muted-foreground">Processing Dashboard</p>
            </div>
            <div className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
              pipelineState === "running"
                ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                : pipelineState === "disabled"
                  ? "bg-zinc-500/15 text-zinc-500"
                  : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
            }`}>
              <Activity className={`h-3 w-3 ${pipelineState === "running" ? "animate-pulse" : ""}`} />
              {pipelineState === "running" ? "Running" : pipelineState === "disabled" ? "All Disabled" : "Idle"}
            </div>
            <div className="rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground">
              Schedules: {schedules.length}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 xl:justify-end">
            <div className="flex items-center gap-2 rounded-lg bg-secondary px-3 py-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs font-medium text-secondary-foreground">Cron</span>
              <span className="text-xs text-muted-foreground">Every</span>
              <input
                type="number"
                value={cronFrequency}
                onChange={(e) => setCronFrequency(e.target.value)}
                className="w-14 rounded-md border bg-background px-2 py-1 text-xs text-foreground"
                min="1"
              />
              <span className="text-xs text-muted-foreground">min</span>
              <Button onClick={() => saveSchedule.mutate()} variant="secondary" size="sm" className="h-7 px-2 text-[11px]">
                Save Cron
              </Button>
            </div>

            <Button onClick={() => runPipeline.mutate()} disabled={runPipeline.isPending || executionLocked} className="gap-2" size="sm">
              <Play className="h-3.5 w-3.5" />
              {runPipeline.isPending ? "Starting..." : executionLocked ? "Pipeline Busy" : "Run Full Pipeline"}
            </Button>

            <div className="flex items-center gap-1.5 rounded-lg bg-secondary px-2.5 py-1.5">
              <span className="text-[10px] text-muted-foreground whitespace-nowrap">Reverify:</span>
              <select
                value={pipelineReverifySource}
                onChange={(e) => setPipelineReverifySource(e.target.value)}
                className="h-6 rounded border bg-background px-1.5 text-[10px] text-foreground"
              >
                <option value="both">Both</option>
                <option value="not_found">Not Found Only</option>
                <option value="review">Review Only</option>
              </select>
            </div>

            {isAdmin && (
              <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
                <span className="text-[10px] uppercase tracking-[0.28em] text-muted-foreground">Reverify</span>
                <Select value={reverifyDefaultProvider} onValueChange={(value) => setReverifyDefaultProvider(value as "perplexity" | "openai")}>
                  <SelectTrigger className="h-8 w-[170px] text-xs">
                    <SelectValue placeholder="Default provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="perplexity">Perplexity First</SelectItem>
                    <SelectItem value="openai">OpenAI First</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setReverifyProviderMutation.mutate(reverifyDefaultProvider)}
                  disabled={setReverifyProviderMutation.isPending || reverifyDefaultProvider === currentReverifyDefaultProvider}
                >
                  Save
                </Button>
              </div>
            )}

            <Button
              onClick={() => preflightMutation.mutate()}
              disabled={preflightMutation.isPending}
              variant="outline"
              className="gap-2"
              size="sm"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {preflightMutation.isPending ? "Checking..." : "Preflight Check"}
            </Button>

            {isAdmin && (
              <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
                <span className="text-[10px] uppercase tracking-[0.28em] text-muted-foreground">Model</span>
                <Select value={selectedModel} onValueChange={setSelectedModel}>
                  <SelectTrigger className="h-8 w-[180px] text-xs">
                    <SelectValue placeholder="Select model" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableModels.map((model) => (
                      <SelectItem key={model} value={model}>
                        {model}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setModelMutation.mutate(selectedModel)}
                  disabled={setModelMutation.isPending || selectedModel === activeModel}
                >
                  Save
                </Button>
              </div>
            )}

            <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs text-muted-foreground">
              <span>{authUser ? `${authUser.username} (${authUser.role})` : "Guest"}</span>
              <span className="rounded-full border px-2 py-0.5">{activeModel}</span>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => logoutMutation.mutate()}>
                Sign out
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 xl:col-span-2">
            <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs text-muted-foreground">
              <Globe2 className="h-3.5 w-3.5" />
              <span className="tabular-nums">{formatDateTime(liveClock, currentTimezone)}</span>
              <span className="rounded-full border px-2 py-0.5 text-[10px]">
                {formatTimeZoneLabel(currentTimezone)}
              </span>
            </div>

            {isAdmin && (
              <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
                <Select value={configuredTimezone} onValueChange={setConfiguredTimezone}>
                  <SelectTrigger className="h-8 w-[220px] text-xs">
                    <SelectValue placeholder="Timezone" />
                  </SelectTrigger>
                  <SelectContent>
                    {GMT_TIMEZONE_OPTIONS.map((timeZone) => (
                      <SelectItem key={timeZone} value={timeZone}>
                        {formatTimeZoneLabel(timeZone)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setTimezoneMutation.mutate(configuredTimezone)}
                  disabled={setTimezoneMutation.isPending || configuredTimezone === currentTimezone}
                >
                  Save TZ
                </Button>
              </div>
            )}

            <div className="ml-auto flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Sun className="h-4 w-4 text-muted-foreground" />
                <Switch checked={isDark} onCheckedChange={toggleDark} />
                <Moon className="h-4 w-4 text-muted-foreground" />
              </div>
              {isDark && (
                <div className="flex items-center gap-2 animate-fade-in">
                  <span className="text-xs text-muted-foreground">Darkness</span>
                  <Slider
                    value={[darknessLevel]}
                    onValueChange={([v]) => setDarknessLevel(v)}
                    min={0.5}
                    max={1.5}
                    step={0.1}
                    className="w-24"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="border-t bg-background px-4 py-3 lg:px-6">
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-lg border bg-card p-3">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold text-muted-foreground">Saved Schedules</h2>
              {selectedScheduleId && (
                <button
                  onClick={() => setSelectedScheduleId(null)}
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  Clear Edit
                </button>
              )}
            </div>
            <div className="max-h-40 space-y-2 overflow-auto">
              {schedules.length === 0 && (
                <p className="text-xs text-muted-foreground">No schedules saved yet.</p>
              )}
              {schedules.map((schedule) => (
                <div key={schedule.id} className="space-y-2 rounded-md border bg-background px-2 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => {
                        setSelectedScheduleId(schedule.id);
                        const interval = Number(schedule.cron.split("/")[1]?.split(" ")[0] || "30");
                        setCronFrequency(String(Number.isFinite(interval) ? interval : 30));
                      }}
                      className="font-medium hover:underline"
                    >
                      {schedule.name}
                    </button>
                    <span className="rounded-full border px-2 py-0.5 text-[10px]">{schedule.cron}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                      schedule.enabled ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
                    }`}>
                      {schedule.enabled ? "enabled" : "disabled"}
                    </span>
                    <button onClick={() => triggerSchedule.mutate(schedule.id)} className="ml-auto rounded border px-1.5 py-0.5 hover:bg-accent">
                      <Zap className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => toggleSchedule.mutate({ id: schedule.id, enabled: !schedule.enabled })}
                      disabled={toggleSchedule.isPending && toggledScheduleId === schedule.id}
                      className="rounded border px-1.5 py-0.5 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <div className="flex items-center gap-1">
                        <Power className="h-3 w-3" />
                        <span>{schedule.enabled ? "Stop Cron" : "Start Cron"}</span>
                      </div>
                    </button>
                    <button onClick={() => deleteSchedule.mutate(schedule.id)} className="rounded border px-1.5 py-0.5 hover:bg-accent">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                    <span>Last trigger: {formatDateTime(schedule.lastTriggeredAt, currentTimezone)}</span>
                    <span>Last finish: {formatDateTime(schedule.lastFinishedAt, currentTimezone)}</span>
                    <span>Status: {schedule.lastStatus || "Never"}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-3">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold text-muted-foreground">Run History</h2>
              <button
                onClick={() => clearHistory.mutate()}
                className="rounded border bg-background px-2 py-1 text-[11px] hover:bg-accent"
                disabled={clearHistory.isPending}
              >
                {clearHistory.isPending ? "Clearing..." : "Clear History"}
              </button>
            </div>
            <div className="max-h-40 space-y-2 overflow-auto">
              {runHistoryItems.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  {selectedSchedule ? "No real runs recorded for this schedule yet." : "No schedules selected."}
                </p>
              )}
              {runHistoryItems.map((job) => (
                <button
                  key={job.id}
                  onClick={() => setSelectedHistoryJobId((current) => (current === job.id ? null : job.id))}
                  className="flex w-full items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-xs hover:bg-accent/40"
                >
                  <span className="font-mono">{job.id}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                    job.status === "success"
                      ? "bg-success/15 text-success"
                      : job.status === "failed"
                        ? "bg-destructive/15 text-destructive"
                        : "bg-secondary text-secondary-foreground"
                  }`}>
                    {job.status}
                  </span>
                  {job.trigger?.skipped && (
                    <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] text-warning">
                      skipped
                    </span>
                  )}
                  <span className="ml-auto text-muted-foreground">
                    {formatDateTime(lastScheduleTimestamp(job), currentTimezone)}
                  </span>
                  {selectedHistoryJobId === job.id ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </button>
              ))}
            </div>

            {selectedHistoryJobId && (
              <div className="mt-2 rounded-md border bg-background p-2 text-xs">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="font-medium">Logs: {selectedHistoryJobId}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                    selectedJobData?.job?.status === "success"
                      ? "bg-success/15 text-success"
                      : selectedJobData?.job?.status === "failed"
                        ? "bg-destructive/15 text-destructive"
                        : "bg-secondary text-secondary-foreground"
                  }`}>
                    {selectedJobData?.job?.status || "loading"}
                  </span>
                  {selectedJobData?.job?.trigger?.skipped && (
                    <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] text-warning">
                      skipped: {selectedJobData.job.trigger.skippedReason || "overlap"}
                    </span>
                  )}
                  {typeof selectedJobData?.job?.progress === "number" && (
                    <span className="text-muted-foreground">{selectedJobData.job.progress}%</span>
                  )}
                </div>
                {selectedJobData?.job?.trigger?.activeJobId && (
                  <p className="mb-2 text-[11px] text-muted-foreground">
                    Active pipeline: {selectedJobData.job.trigger.activeJobId}
                  </p>
                )}
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded border bg-card p-2 text-[11px] text-muted-foreground">
                  {selectedJobData?.job?.logs?.slice(-20).join("\n") || "No logs available"}
                </pre>
              </div>
            )}
          </div>
        </div>

        {showPreflight && preflightMutation.data && (
          <div className="mt-3 rounded-lg border bg-card p-3">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold text-muted-foreground">Preflight Report</h2>
              <button
                onClick={() => setShowPreflight(false)}
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                Hide
              </button>
            </div>
            <div className="space-y-2 text-xs">
              {preflightMutation.data.checks.map((check) => (
                <div key={check.key} className="rounded-md border bg-background px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{check.label}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] ${
                        check.status === "pass"
                          ? "bg-success/15 text-success"
                          : check.status === "warn"
                            ? "bg-warning/15 text-warning"
                            : "bg-destructive/15 text-destructive"
                      }`}
                    >
                      {check.status}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">{check.details}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
