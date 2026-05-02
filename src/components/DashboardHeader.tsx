import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Bell,
  BellOff,
  Bot,
  CircleStop,
  Globe2,
  LayoutPanelLeft,
  LogOut,
  Moon,
  PanelRightOpen,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { UserAdminPanel } from "@/components/UserAdminPanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useTheme } from "@/contexts/ThemeContext";
import { api } from "@/lib/api";
import { formatCountdown, formatDateTime, formatTimeZoneLabel, GMT_TIMEZONE_OPTIONS } from "@/lib/time";
import type { PipelineStatus } from "@/lib/types";
import { toast } from "sonner";

type OverviewCardProps = {
  label: string;
  value: string;
  detail: string;
};

function OverviewCard({ label, value, detail }: OverviewCardProps) {
  return (
    <Card className="border-border/70 bg-card/90">
      <CardHeader className="space-y-1 pb-2">
        <CardDescription className="text-[11px] uppercase tracking-[0.22em]">{label}</CardDescription>
        <CardTitle className="text-xl">{value}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0 text-xs text-muted-foreground">{detail}</CardContent>
    </Card>
  );
}

function buildPipelineSequence(reverifySource: string) {
  return [
    { scriptId: "get-task" },
    { scriptId: "get-order-inquiry" },
    { scriptId: "funeral-finder" },
    { scriptId: "reverify", option: reverifySource || "both" },
    { scriptId: "updater", option: "complete" },
    { scriptId: "closing-task" },
  ];
}

function buildCronSequence(useReverify: boolean, reverifySource: string) {
  const sequence = [
    { scriptId: "get-task" },
    { scriptId: "get-order-inquiry" },
    { scriptId: "funeral-finder" },
  ];
  if (useReverify) {
    sequence.push({ scriptId: "reverify", option: reverifySource || "both" });
  }
  sequence.push({ scriptId: "updater", option: "complete" });
  sequence.push({ scriptId: "closing-task" });
  return sequence;
}

function buildScheduleCron(intervalValue: string, intervalUnit: "minutes" | "seconds") {
  const normalizedValue = Math.max(1, Number(intervalValue || "1"));
  return intervalUnit === "seconds"
    ? `*/${normalizedValue} * * * * *`
    : `*/${normalizedValue} * * * *`;
}

function parseScheduleCron(cron: string) {
  const parts = String(cron || "").trim().split(/\s+/);
  if (parts.length === 6) {
    const match = parts[0]?.match(/^\*\/(\d{1,3})$/);
    if (match?.[1]) {
      return { value: match[1], unit: "seconds" as const };
    }
  }
  if (parts.length === 5) {
    const match = parts[0]?.match(/^\*\/(\d{1,3})$/);
    if (match?.[1]) {
      return { value: match[1], unit: "minutes" as const };
    }
  }
  return { value: "30", unit: "minutes" as const };
}

function describeScheduleInterval(schedule: { intervalUnit?: "minutes" | "seconds"; intervalValue?: number; cron: string }) {
  const parsed = parseScheduleCron(schedule.cron);
  const unit = schedule.intervalUnit || parsed.unit;
  const value = schedule.intervalValue || Number(parsed.value || "1");
  return `Every ${value} ${value === 1 ? unit.slice(0, -1) : unit}`;
}

export function DashboardHeader() {
  const queryClient = useQueryClient();
  const { isDark, toggleDark } = useTheme();
  const [cronFrequency, setCronFrequency] = useState("30");
  const [cronUnit, setCronUnit] = useState<"minutes" | "seconds">("minutes");
  const [cronUseReverify, setCronUseReverify] = useState<"yes" | "no" | "">("");
  const [cronReverifySource, setCronReverifySource] = useState("both");
  const [cronUpdaterModel, setCronUpdaterModel] = useState("");
  const [pipelineReverifySource, setPipelineReverifySource] = useState("both");
  const [selectedModel, setSelectedModel] = useState("sonar-pro");
  const [configuredTimezone, setConfiguredTimezone] = useState("UTC");
  const [reverifyDefaultProvider, setReverifyDefaultProvider] = useState<"perplexity" | "openai">("perplexity");
  const [notificationsSilent, setNotificationsSilent] = useState(() => (
    typeof window !== "undefined" && window.localStorage.getItem("blossom-notifications-silent") === "1"
  ));

  const { data: authData } = useQuery({
    queryKey: ["auth"],
    queryFn: api.authMe,
    refetchInterval: 30_000,
  });

  const { data: pipelineStatusData } = useQuery({
    queryKey: ["pipeline-status"],
    queryFn: api.pipelineStatus,
    refetchInterval: 2000,
  });

  const { data: scheduleData } = useQuery({
    queryKey: ["schedules"],
    queryFn: api.schedules,
    refetchInterval: 5000,
  });

  const pipelineStatus = pipelineStatusData as PipelineStatus | undefined;
  const schedules = scheduleData?.schedules ?? [];
  const enabledSchedules = schedules.filter((schedule) => schedule.enabled);
  const lastSchedule = schedules[0] || null;
  const authUser = authData?.user;
  const isAdmin = authUser?.role === "admin";
  const activeModel = authData?.activeModel || "sonar-pro";
  const availableModels = authData?.availableModels ?? [activeModel];
  const currentTimezone = authData?.configuredTimezone || "UTC";
  const currentReverifyDefaultProvider = authData?.reverifyDefaultProvider || "perplexity";
  const executionLocked = (pipelineStatus?.activeWorkloads ?? 0) > 0;

  useEffect(() => {
    setSelectedModel(activeModel);
  }, [activeModel]);

  useEffect(() => {
    setConfiguredTimezone(currentTimezone);
  }, [currentTimezone]);

  useEffect(() => {
    setReverifyDefaultProvider(currentReverifyDefaultProvider);
  }, [currentReverifyDefaultProvider]);

  useEffect(() => {
    const firstCron = schedules[0]?.cron || "";
    const parsed = parseScheduleCron(firstCron);
    setCronFrequency(parsed.value);
    setCronUnit(parsed.unit);
    if (schedules[0]) {
      setCronUseReverify(schedules[0].useReverify === false ? "no" : schedules[0].useReverify === true ? "yes" : "");
      setCronReverifySource(schedules[0].reverifyOption || "both");
      setCronUpdaterModel(schedules[0].updaterModel || "");
    }
  }, [schedules]);

  const runPipeline = useMutation({
    mutationFn: () => api.runPipeline(buildPipelineSequence(pipelineReverifySource)),
    onSuccess: ({ jobId }) => {
      toast.success(`Pipeline started (${jobId})`);
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["pipeline-status"] });
    },
    onError: (error) => toast.error(error.message || "Failed to start pipeline"),
  });

  const saveSchedule = useMutation({
    mutationFn: async () => {
      const useReverify = true;
      if (!cronUpdaterModel.trim()) {
        throw new Error("Select a scheduled model before saving cron.");
      }
      if (!cronReverifySource) {
        throw new Error("Choose a Reverify source before saving.");
      }
      const cron = buildScheduleCron(cronFrequency, cronUnit);
      const current = schedules[0];
      const payload = {
        cron,
        useReverify,
        reverifyOption: useReverify ? cronReverifySource : null,
        updaterModel: cronUpdaterModel,
        sequence: buildCronSequence(useReverify, cronReverifySource),
      };
      if (current) {
        return api.updateSchedule(current.id, {
          enabled: current.enabled,
          ...payload,
        });
      }
      return api.createSchedule({
        name: "Default Sequential Pipeline",
        enabled: true,
        ...payload,
      });
    },
    onSuccess: () => {
      toast.success("Cooldown schedule saved");
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
      queryClient.invalidateQueries({ queryKey: ["pipeline-status"] });
    },
    onError: (error) => toast.error(error.message || "Failed to save schedule"),
  });

  const toggleSchedule = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.updateSchedule(id, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
      queryClient.invalidateQueries({ queryKey: ["pipeline-status"] });
    },
    onError: (error) => toast.error(error.message || "Failed to update schedule"),
  });

  const startStopCron = useMutation({
    mutationFn: async () => {
      const activeTargets = schedules.filter((schedule) => schedule.enabled);
      if (activeTargets.length > 0) {
        await Promise.all(activeTargets.map((schedule) => api.updateSchedule(schedule.id, { enabled: false })));
        return { action: "stopped" as const };
      }

      if (lastSchedule) {
        if (!lastSchedule.configValid) {
          throw new Error(lastSchedule.configError || "Configure the saved cron before starting.");
        }
        await api.updateSchedule(lastSchedule.id, { enabled: true });
        return { action: "started" as const };
      }

      const useReverify = true;
      if (!cronUpdaterModel.trim()) {
        throw new Error("Select a scheduled model before starting cron.");
      }
      if (!cronReverifySource) {
        throw new Error("Choose a Reverify source before starting cron.");
      }
      await api.createSchedule({
        name: "Default Sequential Pipeline",
        enabled: true,
        cron: buildScheduleCron(cronFrequency, cronUnit),
        useReverify,
        reverifyOption: cronReverifySource,
        updaterModel: cronUpdaterModel,
        sequence: buildCronSequence(useReverify, cronReverifySource),
      });
      return { action: "started" as const };
    },
    onSuccess: ({ action }) => {
      toast.success(action === "started" ? "Cron started" : "Cron stopped");
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
      queryClient.invalidateQueries({ queryKey: ["pipeline-status"] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error) => toast.error(error.message || "Failed to update cron"),
  });

  const triggerSchedule = useMutation({
    mutationFn: (id: string) => api.triggerSchedule(id),
    onSuccess: ({ jobId, started, skipped, activeJobId }) => {
      if (!started || skipped) {
        toast.info(`Schedule delayed because another workload is active (${activeJobId || jobId || "busy"})`);
      } else {
        toast.success(`Schedule triggered (${jobId})`);
      }
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
      queryClient.invalidateQueries({ queryKey: ["pipeline-status"] });
    },
    onError: (error) => toast.error(error.message || "Failed to trigger schedule"),
  });

  const setModelMutation = useMutation({
    mutationFn: (model: string) => api.setModel(model),
    onSuccess: () => {
      toast.success("Model updated");
      queryClient.invalidateQueries({ queryKey: ["auth"] });
    },
    onError: (error) => toast.error(error.message || "Failed to update model"),
  });

  const setTimezoneMutation = useMutation({
    mutationFn: (timeZone: string) => api.setTimezone(timeZone),
    onSuccess: () => {
      toast.success("Timezone updated");
      queryClient.invalidateQueries({ queryKey: ["auth"] });
    },
    onError: (error) => toast.error(error.message || "Failed to update timezone"),
  });

  const setReverifyProviderMutation = useMutation({
    mutationFn: (provider: "perplexity" | "openai") => api.setReverifyProvider(provider),
    onSuccess: () => {
      toast.success("Reverify preference updated");
      queryClient.invalidateQueries({ queryKey: ["auth"] });
    },
    onError: (error) => toast.error(error.message || "Failed to update reverify preference"),
  });

  const preflightMutation = useMutation({
    mutationFn: () => api.preflight(),
    onSuccess: (report) => {
      toast[report.ok ? "success" : "error"](report.ok ? "Preflight passed" : "Preflight needs attention");
    },
    onError: (error) => toast.error(error.message || "Failed to run preflight"),
  });

  const logoutMutation = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      queryClient.setQueryData(["auth"], null);
      queryClient.invalidateQueries();
    },
    onError: (error) => toast.error(error.message || "Failed to sign out"),
  });

  const clearOtherSessionsMutation = useMutation({
    mutationFn: () => api.clearOtherSessions(),
    onSuccess: ({ removed }) => {
      toast.success(removed > 0 ? `${removed} other sessions cleared` : "No other sessions were active");
      queryClient.invalidateQueries({ queryKey: ["auth"] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (error) => toast.error(error.message || "Failed to clear other sessions"),
  });

  const logoutAllMutation = useMutation({
    mutationFn: () => api.logoutAll(),
    onSuccess: () => {
      queryClient.setQueryData(["auth"], null);
      queryClient.invalidateQueries();
    },
    onError: (error) => toast.error(error.message || "Failed to clear all sessions"),
  });

  const statusBadge = useMemo(() => {
    const state = pipelineStatus?.state || "idle";
    if (state === "running") return { label: "Running", className: "bg-blue-500/15 text-blue-600" };
    if (state === "disabled") return { label: "Disabled", className: "bg-zinc-500/15 text-zinc-600" };
    return { label: "Idle", className: "bg-emerald-500/15 text-emerald-600" };
  }, [pipelineStatus?.state]);

  const nextScheduleLabel = pipelineStatus?.nextSchedule?.nextRunAt
    ? pipelineStatus.nextSchedule.lastStatus === "running"
      ? "Running now"
      : formatDateTime(pipelineStatus.nextSchedule.nextRunAt, currentTimezone, {
          month: "short",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
    : "Not scheduled";

  const nextScheduleDetail = pipelineStatus?.nextSchedule?.name
    ? pipelineStatus.nextSchedule.lastStatus === "running"
      ? `${pipelineStatus.nextSchedule.name} cooldown starts after the current pipeline finishes`
      : pipelineStatus.nextSchedule.lastStatus === "waiting"
        ? `${pipelineStatus.nextSchedule.name} is waiting for the active workload to clear before its cooldown can resume`
      : `${pipelineStatus.nextSchedule.name} in ${formatCountdown(pipelineStatus.nextScheduleInSeconds)}`
    : "No enabled schedule";

  const toggleNotificationsSilent = () => {
    const next = !notificationsSilent;
    setNotificationsSilent(next);
    window.localStorage.setItem("blossom-notifications-silent", next ? "1" : "0");
    window.dispatchEvent(new CustomEvent("blossom-notification-silence-change", { detail: { silent: next } }));
    if (!next) {
      toast.success("Notifications enabled");
    }
  };

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border bg-card/90 p-4 shadow-sm lg:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${statusBadge.className}`}>
              <Activity className={`h-3.5 w-3.5 ${pipelineStatus?.state === "running" ? "animate-pulse" : ""}`} />
              {statusBadge.label}
            </div>
            <div className="rounded-full border px-3 py-1 text-xs text-muted-foreground">
              {pipelineStatus?.activeWorkloads ?? 0} active workloads
            </div>
            <div className="rounded-full border px-3 py-1 text-xs text-muted-foreground">
              {nextScheduleDetail}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => runPipeline.mutate()} disabled={runPipeline.isPending || executionLocked} className="gap-2">
              <Play className="h-4 w-4" />
              {runPipeline.isPending ? "Starting..." : executionLocked ? "Pipeline Busy" : "Run Full Pipeline"}
            </Button>
            <Button
              onClick={() => startStopCron.mutate()}
              disabled={startStopCron.isPending || (!lastSchedule && !cronUpdaterModel)}
              variant="outline"
              className="gap-2"
            >
              {enabledSchedules.length > 0 ? <CircleStop className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              {startStopCron.isPending ? "Updating..." : enabledSchedules.length > 0 ? "Stop Cron" : "Start Cron"}
            </Button>
            <Button
              onClick={toggleNotificationsSilent}
              variant={notificationsSilent ? "secondary" : "outline"}
              className="gap-2"
              title={notificationsSilent ? "Enable popup notifications" : "Silence popup notifications"}
            >
              {notificationsSilent ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
              {notificationsSilent ? "Silent" : "Alerts On"}
            </Button>
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline" className="gap-2">
                  <LayoutPanelLeft className="h-4 w-4" />
                  Controls
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-full overflow-y-auto sm:max-w-xl">
                <SheetHeader>
                  <SheetTitle>Dashboard Controls</SheetTitle>
                  <SheetDescription>
                    Scheduling, runtime settings, and the tools that used to sit across the header now live here.
                  </SheetDescription>
                </SheetHeader>

                <div className="mt-6 space-y-5">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Pipeline</CardTitle>
                      <CardDescription>Choose the reverify source and start a full run.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="space-y-2">
                        <div className="text-xs font-medium text-muted-foreground">Reverify source</div>
                        <Select value={pipelineReverifySource} onValueChange={setPipelineReverifySource}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select source" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="both">Both</SelectItem>
                            <SelectItem value="not_found">Not Found Only</SelectItem>
                            <SelectItem value="review">Review Only</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      {isAdmin && (
                        <div className="space-y-2">
                          <div className="text-xs font-medium text-muted-foreground">Model selection</div>
                          <div className="flex gap-2">
                            <Select value={selectedModel} onValueChange={setSelectedModel}>
                              <SelectTrigger>
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
                              variant="secondary"
                              onClick={() => setModelMutation.mutate(selectedModel)}
                              disabled={setModelMutation.isPending || selectedModel === activeModel}
                            >
                              Save
                            </Button>
                          </div>
                        </div>
                      )}

                      <Button onClick={() => runPipeline.mutate()} disabled={runPipeline.isPending || executionLocked} className="w-full gap-2">
                        <Play className="h-4 w-4" />
                        {runPipeline.isPending ? "Starting..." : "Run Pipeline"}
                      </Button>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Cron Schedule</CardTitle>
                      <CardDescription>
                        After each pipeline completes, the cooldown timer starts. When it expires, the next pipeline runs automatically.
                        <span className="mt-1 block font-medium text-amber-600 dark:text-amber-400">
                          Scheduled model and Reverify source are mandatory before cron can start.
                        </span>
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {/* Step 1: Mandatory — Use Reverify & Scheduled Model */}
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="rounded-lg border bg-muted/20 p-3">
                          <div className="text-xs font-medium text-muted-foreground">Cron pipeline</div>
                          <div className="mt-2 text-sm font-medium">Complete sequence</div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            GetTask to ClosingTask runs every time. Cooldown starts only after the full pipeline finishes.
                          </p>
                        </div>

                        <div className="space-y-2">
                          <div className="text-xs font-medium text-muted-foreground">
                            Scheduled model <span className="text-destructive">*</span>
                          </div>
                          <Select value={cronUpdaterModel || undefined} onValueChange={setCronUpdaterModel}>
                            <SelectTrigger className={!cronUpdaterModel ? "border-amber-500/50" : ""}>
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
                        </div>
                      </div>

                      {/* Step 2: Reverify source */}
                      <div className="space-y-2">
                        <div className="text-xs font-medium text-muted-foreground">
                          Reverify source for cron <span className="text-destructive">*</span>
                        </div>
                        <Select value={cronReverifySource} onValueChange={setCronReverifySource}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select source" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="both">Both</SelectItem>
                            <SelectItem value="not_found">Not Found Only</SelectItem>
                            <SelectItem value="review">Review Only</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Step 3: Interval */}
                      <div className="space-y-2">
                        <div className="text-xs font-medium text-muted-foreground">Cooldown interval (run every)</div>
                        <div className="flex gap-2">
                          <Input
                            type="number"
                            min="1"
                            value={cronFrequency}
                            onChange={(event) => setCronFrequency(event.target.value)}
                          />
                          <Select value={cronUnit} onValueChange={(value) => setCronUnit(value as "minutes" | "seconds")}>
                            <SelectTrigger className="w-32">
                              <SelectValue placeholder="Unit" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="minutes">Minutes</SelectItem>
                              <SelectItem value="seconds">Seconds</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      <div className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
                        <div>
                          <span className="font-medium">Pipeline:</span>{" "}
                          GetTask → GetOrderInquiry → Funeral_Finder → Reverify → Updater → ClosingTask
                        </div>
                        <div className="mt-1">
                          <span className="font-medium">Timing:</span>{" "}
                          Pipeline runs → completes → {cronFrequency} {cronUnit} cooldown → next run
                        </div>
                      </div>

                      {/* Validation warning before Save */}
                      {!cronUpdaterModel && (
                        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                          <span className="font-semibold">Required before saving:</span>
                          {!cronUpdaterModel && <span className="ml-1">• Scheduled model</span>}
                        </div>
                      )}

                      {/* Save button at the bottom after all mandatory fields */}
                      <Button
                        onClick={() => saveSchedule.mutate()}
                        disabled={saveSchedule.isPending || !cronUpdaterModel}
                        className="w-full gap-2"
                      >
                        <Save className="h-4 w-4" />
                        {saveSchedule.isPending ? "Saving..." : "Save Schedule"}
                      </Button>

                      <div className="space-y-3">
                        {schedules.length === 0 && <p className="text-sm text-muted-foreground">No schedules saved yet.</p>}
                        {schedules.map((schedule) => (
                          <div key={schedule.id} className="rounded-lg border p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <div className="font-medium">{schedule.name}</div>
                                <div className="text-xs text-muted-foreground">{describeScheduleInterval(schedule)} • {schedule.cron}</div>
                              </div>
                              <div className="flex items-center gap-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={!schedule.configValid || triggerSchedule.isPending}
                                  onClick={() => triggerSchedule.mutate(schedule.id)}
                                >
                                  Trigger
                                </Button>
                                <Button
                                  variant={schedule.enabled ? "secondary" : "outline"}
                                  size="sm"
                                  disabled={!schedule.configValid && !schedule.enabled}
                                  title={!schedule.configValid ? (schedule.configError || "Configure model and reverify first") : undefined}
                                  onClick={() => toggleSchedule.mutate({ id: schedule.id, enabled: !schedule.enabled })}
                                >
                                  {schedule.enabled ? "Pause" : "Enable"}
                                </Button>
                              </div>
                            </div>
                            <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
                              <div>Next run: {formatDateTime(schedule.nextRunAt, currentTimezone)}</div>
                              <div>Last trigger: {formatDateTime(schedule.lastTriggeredAt, currentTimezone)}</div>
                              <div>Last finish: {formatDateTime(schedule.lastFinishedAt, currentTimezone)}</div>
                              <div>Status: {schedule.lastStatus || "Never"}</div>
                              <div>Reverify: {schedule.useReverify === false ? "Disabled" : `Enabled (${schedule.reverifyOption || "both"})`}</div>
                              <div>Scheduled model: {schedule.updaterModel || <span className="text-amber-600">Not set</span>}</div>
                              {!schedule.configValid ? (
                                <div className="font-medium text-destructive">
                                  ⚠ {schedule.configError || "Schedule cannot start until required settings are selected."}
                                </div>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>


                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Preferences</CardTitle>
                      <CardDescription>Timezone, theme, and reverify behavior.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                          <Globe2 className="h-3.5 w-3.5" />
                          Timezone
                        </div>
                        <div className="flex gap-2">
                          <Select value={configuredTimezone} onValueChange={setConfiguredTimezone}>
                            <SelectTrigger>
                              <SelectValue placeholder="Select timezone" />
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
                            variant="secondary"
                            onClick={() => setTimezoneMutation.mutate(configuredTimezone)}
                            disabled={setTimezoneMutation.isPending || configuredTimezone === currentTimezone}
                          >
                            Save
                          </Button>
                        </div>
                      </div>

                      {isAdmin && (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                            <Bot className="h-3.5 w-3.5" />
                            Reverify default
                          </div>
                          <div className="flex gap-2">
                            <Select value={reverifyDefaultProvider} onValueChange={(value) => setReverifyDefaultProvider(value as "perplexity" | "openai")}>
                              <SelectTrigger>
                                <SelectValue placeholder="Provider" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="perplexity">Perplexity First</SelectItem>
                                <SelectItem value="openai">OpenAI First</SelectItem>
                              </SelectContent>
                            </Select>
                            <Button
                              variant="secondary"
                              onClick={() => setReverifyProviderMutation.mutate(reverifyDefaultProvider)}
                              disabled={setReverifyProviderMutation.isPending || reverifyDefaultProvider === currentReverifyDefaultProvider}
                            >
                              Save
                            </Button>
                          </div>
                        </div>
                      )}

                      <div className="flex items-center justify-between rounded-lg border px-3 py-2">
                        <div className="flex items-center gap-2 text-sm">
                          {isDark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                          Theme mode
                        </div>
                        <Switch checked={isDark} onCheckedChange={toggleDark} />
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Utilities</CardTitle>
                      <CardDescription>Refresh data, sign out safely, and clear stuck sessions.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <Button onClick={() => preflightMutation.mutate()} disabled={preflightMutation.isPending} variant="outline" className="w-full gap-2">
                        <ShieldCheck className="h-4 w-4" />
                        {preflightMutation.isPending ? "Checking..." : "Run Preflight"}
                      </Button>
                      <Button onClick={() => queryClient.invalidateQueries()} variant="outline" className="w-full gap-2">
                        <RefreshCw className="h-4 w-4" />
                        Refresh Live Data
                      </Button>
                      <Button
                        onClick={() => clearOtherSessionsMutation.mutate()}
                        variant="outline"
                        className="w-full gap-2"
                        disabled={clearOtherSessionsMutation.isPending}
                      >
                        <ShieldCheck className="h-4 w-4" />
                        {clearOtherSessionsMutation.isPending ? "Clearing..." : "Clear Other Sessions"}
                      </Button>
                      <Button onClick={() => logoutMutation.mutate()} variant="destructive" className="w-full gap-2">
                        <LogOut className="h-4 w-4" />
                        Sign Out
                      </Button>
                      <Button
                        onClick={() => logoutAllMutation.mutate()}
                        variant="destructive"
                        className="w-full gap-2"
                        disabled={logoutAllMutation.isPending}
                      >
                        <LogOut className="h-4 w-4" />
                        {logoutAllMutation.isPending ? "Clearing..." : "Sign Out Everywhere"}
                      </Button>
                    </CardContent>
                  </Card>
                </div>
              </SheetContent>
            </Sheet>
            {isAdmin && (
              <Sheet>
                <SheetTrigger asChild>
                  <Button variant="outline" className="gap-2">
                    <PanelRightOpen className="h-4 w-4" />
                    Admin
                  </Button>
                </SheetTrigger>
                <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
                  <SheetHeader>
                    <SheetTitle>Admin Panel</SheetTitle>
                    <SheetDescription>
                      User, session, timezone, and sync administration.
                    </SheetDescription>
                  </SheetHeader>
                  <div className="mt-6">
                    <UserAdminPanel />
                  </div>
                </SheetContent>
              </Sheet>
            )}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <OverviewCard
            label="Next Cron"
            value={nextScheduleLabel}
            detail={nextScheduleDetail}
          />
          <OverviewCard
            label="Next Pipeline"
            value={pipelineStatus?.nextPipeline?.status ? pipelineStatus.nextPipeline.status.toUpperCase() : "Idle"}
            detail={pipelineStatus?.nextPipeline?.id ? `${pipelineStatus.nextPipeline.id} in ${formatCountdown(pipelineStatus.nextPipelineInSeconds)}` : `Starts in ${formatCountdown(pipelineStatus?.nextPipelineInSeconds)}`}
          />
          <OverviewCard
            label="Next Script"
            value={pipelineStatus?.nextScript?.scriptId || "Waiting"}
            detail={pipelineStatus?.nextScript?.status ? `${pipelineStatus.nextScript.status} • ${formatCountdown(pipelineStatus.nextScriptInSeconds)}` : "No script queued"}
          />
          <OverviewCard
            label="Queue"
            value={`${pipelineStatus?.queuedPipelines ?? 0}/${pipelineStatus?.queuedScripts ?? 0}`}
            detail={`${pipelineStatus?.runningPipelines ?? 0} pipelines and ${pipelineStatus?.runningScripts ?? 0} scripts active`}
          />
          <OverviewCard
            label="Local Time"
            value={formatDateTime(new Date().toISOString(), currentTimezone, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            detail={formatTimeZoneLabel(currentTimezone)}
          />
        </div>
      </div>
    </section>
  );
}

