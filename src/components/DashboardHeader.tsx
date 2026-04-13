import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Moon, Sun, Play, Settings2, Clock, Power, Trash2, Zap, ChevronDown, ChevronUp, ShieldCheck, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { useTheme } from "@/contexts/ThemeContext";
import { api } from "@/lib/api";
import { toast } from "sonner";
import type { PipelineStatus } from "@/lib/types";

export function DashboardHeader() {
  const queryClient = useQueryClient();
  const { isDark, toggleDark, darknessLevel, setDarknessLevel } = useTheme();
  const [cronMode, setCronMode] = useState<"default" | "custom">("default");
  const [cronFrequency, setCronFrequency] = useState("30");
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null);
  const [selectedHistoryJobId, setSelectedHistoryJobId] = useState<string | null>(null);
  const [showPreflight, setShowPreflight] = useState(false);
  const [pipelineUpdaterMode, setPipelineUpdaterMode] = useState("complete");

  const { data: pipelineStatusData } = useQuery({
    queryKey: ["pipeline-status"],
    queryFn: api.pipelineStatus,
    refetchInterval: 3000,
  });

  const pipelineStatus = pipelineStatusData as PipelineStatus | undefined;
  const pipelineState = pipelineStatus?.state ?? "idle";
  const executionLocked = (pipelineStatus?.activeWorkloads ?? 0) > 0;
  const { data: scheduleData } = useQuery({
    queryKey: ["schedules"],
    queryFn: api.schedules,
    refetchInterval: 3000,
  });

  const schedules = scheduleData?.schedules ?? [];
  const activeScheduleId = selectedScheduleId || schedules[0]?.id || "";

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

  const { data: jobsData } = useQuery({
    queryKey: ["jobs", "run-history"],
    queryFn: api.jobs,
    refetchInterval: 8000,
  });

  const runHistoryItems =
    (scheduleHistoryData?.history?.length ?? 0) > 0
      ? scheduleHistoryData?.history ?? []
      : (jobsData?.jobs ?? [])
          .filter((job) => job.kind === "pipeline" || job.kind === "script")
          .slice(0, 20);
  const runPipeline = useMutation({
    mutationFn: () => {
      const sequence = [
        { scriptId: "get-task" },
        { scriptId: "get-order-inquiry" },
        { scriptId: "funeral-finder", option: "batch" },
        { scriptId: "reverify", option: "both" },
        { scriptId: "updater", option: pipelineUpdaterMode },
        { scriptId: "closing-task" },
      ];
      return api.runPipeline(sequence);
    },
    onSuccess: ({ jobId }) => {
      toast.success(`Pipeline started (${jobId})`);
    },
    onError: (error) => toast.error(error.message || "Failed to start pipeline"),
  });

  const saveSchedule = useMutation({
    mutationFn: async () => {
      const cronExpression = `*/${Math.max(1, Number(cronFrequency || "30"))} * * * *`;
      const selectedSchedule = selectedScheduleId
        ? schedules.find((item) => item.id === selectedScheduleId)
        : null;
      const payload = {
        name: cronMode === "default" ? "Default Sequential Pipeline" : "Custom Pipeline",
        cron: cronExpression,
        enabled: selectedSchedule?.enabled ?? true,
      };

      if (selectedScheduleId) {
        return api.updateSchedule(selectedScheduleId, payload);
      }

      if (cronMode === "default") {
        const existingDefault = schedules.find((item) => item.name === "Default Sequential Pipeline");
        if (existingDefault) {
          return api.updateSchedule(existingDefault.id, { ...payload, enabled: existingDefault.enabled });
        }
      }

      return api.createSchedule(payload);
    },
    onSuccess: () => {
      toast.success("Cron schedule saved");
      setSelectedScheduleId(null);
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
    },
    onError: (error) => toast.error(error.message || "Failed to save schedule"),
  });

  const toggleSchedule = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.updateSchedule(id, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
    },
    onError: (error) => toast.error(error.message || "Failed to update schedule"),
  });

  const deleteSchedule = useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => {
      toast.success("Schedule deleted");
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
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
        return;
      }
      toast.success(`Schedule triggered (${jobId})`);
    },
    onError: (error) => toast.error(error.message || "Failed to trigger schedule"),
  });

  const clearHistory = useMutation({
    mutationFn: () => api.clearJobs(),
    onSuccess: () => {
      setSelectedHistoryJobId(null);
      toast.success("Run history cleared");
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
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

  const toggledScheduleId = toggleSchedule.variables?.id;

  return (
    <>
      {/* Compact sticky bar only — avoids covering Script Panels when scrolling */}
      <header className="sticky top-0 z-40 border-b bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:px-6">
      <div className="flex flex-wrap flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        {/* Logo & Title */}
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary">
            <Settings2 className="h-5 w-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">DataFlow Pipeline</h1>
            <p className="text-xs text-muted-foreground">Processing Dashboard</p>
          </div>
          {/* Pipeline Status Badge */}
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
        </div>

        {/* Cron Controls */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 rounded-lg bg-secondary px-3 py-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs font-medium text-secondary-foreground">Cron:</span>
            <button
              onClick={() => setCronMode("default")}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                cronMode === "default" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Default
            </button>
            <button
              onClick={() => setCronMode("custom")}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                cronMode === "custom" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Custom
            </button>
          </div>

          {cronMode === "custom" && (
            <div className="flex items-center gap-2 rounded-lg bg-secondary px-3 py-2 animate-fade-in">
              <span className="text-xs text-muted-foreground">Every</span>
              <input
                type="number"
                value={cronFrequency}
                onChange={(e) => setCronFrequency(e.target.value)}
                className="w-14 rounded-md border bg-background px-2 py-1 text-xs text-foreground"
                min="1"
              />
              <span className="text-xs text-muted-foreground">min</span>
              <button
                onClick={() => saveSchedule.mutate()}
                className="rounded-md bg-primary px-2 py-1 text-[10px] text-primary-foreground"
              >
                Save
              </button>
            </div>
          )}

          {cronMode === "default" && (
            <button
              onClick={() => saveSchedule.mutate()}
              className="rounded-lg bg-secondary px-3 py-2 text-xs text-secondary-foreground"
            >
              Save Default Cron
            </button>
          )}

          <Button
            onClick={() => runPipeline.mutate()}
            disabled={runPipeline.isPending || executionLocked}
            className="gap-2"
            size="sm"
          >
            <Play className="h-3.5 w-3.5" />
            {runPipeline.isPending ? "Starting..." : executionLocked ? "Pipeline Busy" : "Run Full Pipeline"}
          </Button>

          {/* Pipeline Updater Mode */}
          <div className="flex items-center gap-1.5 rounded-lg bg-secondary px-2.5 py-1.5">
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">Updater:</span>
            <select
              value={pipelineUpdaterMode}
              onChange={(e) => setPipelineUpdaterMode(e.target.value)}
              className="h-6 rounded border bg-background px-1.5 text-[10px] text-foreground"
            >
              <option value="complete">Complete (All)</option>
              <option value="found_only">Found Only</option>
              <option value="not_found">Not Found</option>
              <option value="review">Review Data</option>
            </select>
          </div>

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

          <div className="rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground">
            Schedules: {scheduleData?.schedules?.length ?? 0}
          </div>
        </div>

        {/* Theme Controls */}
        <div className="flex items-center gap-3">
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
      </header>

      {/* Schedules + run history scroll with the page (not sticky) */}
      <div className="border-b bg-background px-4 py-3 lg:px-6">
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
        <div className="max-h-32 space-y-2 overflow-auto">
          {schedules.length === 0 && (
            <p className="text-xs text-muted-foreground">No schedules saved yet.</p>
          )}
          {schedules.map((schedule) => (
            <div key={schedule.id} className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-xs">
              <button
                onClick={() => {
                  setSelectedScheduleId(schedule.id);
                  const interval = Number(schedule.cron.split("/")[1]?.split(" ")[0] || "30");
                  setCronFrequency(String(Number.isFinite(interval) ? interval : 30));
                  setCronMode(schedule.name === "Default Sequential Pipeline" ? "default" : "custom");
                }}
                className="font-medium hover:underline"
              >
                {schedule.name}
              </button>
              <span className="rounded-full border px-2 py-0.5 text-[10px]">{schedule.cron}</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] ${schedule.enabled ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"}`}>
                {schedule.enabled ? "enabled" : "disabled"}
              </span>
              <button
                onClick={() => triggerSchedule.mutate(schedule.id)}
                className="ml-auto rounded border px-1.5 py-0.5 hover:bg-accent"
              >
                <Zap className="h-3 w-3" />
              </button>
              <button
                onClick={() => toggleSchedule.mutate({ id: schedule.id, enabled: !schedule.enabled })}
                disabled={toggleSchedule.isPending && toggledScheduleId === schedule.id}
                className="rounded border px-1.5 py-0.5 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                <div className="flex items-center gap-1">
                  <Power className="h-3 w-3" />
                  <span>{schedule.enabled ? "Stop Cron" : "Start Cron Now"}</span>
                </div>
              </button>
              <button
                onClick={() => deleteSchedule.mutate(schedule.id)}
                className="rounded border px-1.5 py-0.5 hover:bg-accent"
              >
                <Trash2 className="h-3 w-3" />
              </button>
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
          <div className="max-h-32 space-y-2 overflow-auto">
            {runHistoryItems.length === 0 && (
              <p className="text-xs text-muted-foreground">No runs found yet.</p>
            )}
            {runHistoryItems.map((job) => (
              <button
                key={job.id}
                onClick={() => setSelectedHistoryJobId((current) => (current === job.id ? null : job.id))}
                className="flex w-full items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-xs hover:bg-accent/40"
              >
                <span className="font-mono">{job.id}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] ${job.status === "success" ? "bg-success/15 text-success" : job.status === "failed" ? "bg-destructive/15 text-destructive" : "bg-secondary text-secondary-foreground"}`}>
                  {job.status}
                </span>
                {job.trigger?.skipped && (
                  <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] text-warning">
                    skipped
                  </span>
                )}
                <span className="ml-auto text-muted-foreground">
                  {new Date(job.createdAt).toLocaleString()}
                </span>
                {selectedHistoryJobId === job.id ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
            ))}
          </div>

          {selectedHistoryJobId && (
            <div className="mt-2 rounded-md border bg-background p-2 text-xs">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-medium">Logs: {selectedHistoryJobId}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] ${selectedJobData?.job?.status === "success" ? "bg-success/15 text-success" : selectedJobData?.job?.status === "failed" ? "bg-destructive/15 text-destructive" : "bg-secondary text-secondary-foreground"}`}>
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
    </>
  );
}
