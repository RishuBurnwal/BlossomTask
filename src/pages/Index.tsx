import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertsPanel } from "@/components/AlertsPanel";
import { CompareSection } from "@/components/CompareSection";
import { DashboardHeader } from "@/components/DashboardHeader";
import { DataViewer } from "@/components/DataViewer";
import { GoogleDriveSyncPanel } from "@/components/GoogleDriveSyncPanel";
import { MetricsPanel } from "@/components/MetricsPanel";
import { OrderStatsPanel } from "@/components/OrderStatsPanel";
import { ScriptPanel } from "@/components/ScriptPanel";
import { api } from "@/lib/api";
import type { Job } from "@/lib/types";
import { formatDateTime } from "@/lib/time";

function jobRecency(job?: Job | null): number {
  if (!job) return 0;
  const timestamp = job.updatedAt || job.finishedAt || job.startedAt || job.createdAt;
  const parsed = Date.parse(String(timestamp || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatElapsed(startedAt?: string | null): string {
  if (!startedAt) return "0s";
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

const Index = () => {
  const { data: scriptsData } = useQuery({
    queryKey: ["scripts"],
    queryFn: api.scripts,
    refetchInterval: 15_000,
  });

  const { data: jobsData } = useQuery({
    queryKey: ["jobs"],
    queryFn: api.jobs,
    refetchInterval: 2_000,
  });

  const { data: pipelineStatusData } = useQuery({
    queryKey: ["pipeline-status"],
    queryFn: api.pipelineStatus,
    refetchInterval: 2_000,
  });

  const scripts = scriptsData?.scripts ?? [];
  const jobs = jobsData?.jobs ?? [];
  const executionLocked = (pipelineStatusData?.activeWorkloads ?? 0) > 0;
  const latestScriptJobById = jobs.reduce<Record<string, Job>>((accumulator, job) => {
    if (job.kind !== "script" || !job.scriptId) {
      return accumulator;
    }
    const current = accumulator[job.scriptId];
    const jobIsActive = job.status === "running" || job.status === "queued";
    const currentIsActive = current?.status === "running" || current?.status === "queued";
    if (
      !current
      || (jobIsActive && !currentIsActive)
      || (jobIsActive === currentIsActive && jobRecency(job) >= jobRecency(current))
    ) {
      accumulator[job.scriptId] = job;
    }
    return accumulator;
  }, {});
  const activePipelineJob = useMemo(() => (
    jobs
      .filter((job) => job.kind === "pipeline" && (job.status === "running" || job.status === "queued"))
      .sort((left, right) => jobRecency(right) - jobRecency(left))[0] || null
  ), [jobs]);

  const activeScriptJob = useMemo(() => {
    const runningOrQueuedScripts = jobs
      .filter((job) => job.kind === "script" && (job.status === "running" || job.status === "queued"))
      .sort((left, right) => jobRecency(right) - jobRecency(left));
    if (!activePipelineJob) {
      return runningOrQueuedScripts[0] || null;
    }
    return runningOrQueuedScripts.find((job) => job.parentJobId === activePipelineJob.id) || null;
  }, [activePipelineJob, jobs]);

  const previewLogs = useMemo(() => {
    const lines = activeScriptJob?.logs ?? activePipelineJob?.logs ?? [];
    return lines.slice(-8);
  }, [activePipelineJob?.logs, activeScriptJob?.logs]);

  return (
    <div className="min-h-screen bg-background">
      <DashboardHeader />

      <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 lg:px-6">
        <OrderStatsPanel />

        <div className="space-y-6">
          <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
            <section className="space-y-3">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Pipeline Preview</h2>
                <p className="mt-1 text-sm text-muted-foreground">Current pipeline step, live clock, and latest output lines from the active script.</p>
              </div>
              <div className="rounded-2xl border bg-card p-4 shadow-sm">
                {activePipelineJob ? (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="text-sm font-semibold">
                          {activeScriptJob?.scriptId || "Waiting for next script"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Pipeline {activePipelineJob.status} • {Math.min(activePipelineJob.progress || 0, 100)}% • {activePipelineJob.progressNote || "Starting pipeline"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Started {formatDateTime(activePipelineJob.startedAt || activePipelineJob.createdAt)} • live {formatElapsed(activePipelineJob.startedAt || activePipelineJob.createdAt)}
                        </div>
                      </div>
                      <div className="rounded-full border px-3 py-1 text-xs font-medium text-blue-600">
                        {activeScriptJob?.status === "running" ? "Live step running" : activePipelineJob.status.toUpperCase()}
                      </div>
                    </div>

                      <div className="space-y-2">
                        <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-blue-500 to-cyan-400 transition-all duration-500"
                            style={{ width: `${Math.min(activePipelineJob.progress || 0, 100)}%` }}
                          />
                        </div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <span>Child job: {activeScriptJob?.id || "pending"}</span>
                          <span>
                            Step progress: {activeScriptJob?.progressCurrent != null && activeScriptJob?.progressTotal != null
                              ? `${activeScriptJob.progressCurrent}/${activeScriptJob.progressTotal} | ${activeScriptJob.progress ?? 0}%`
                              : (activeScriptJob?.progressNote || activeScriptJob?.status || "queued")}
                          </span>
                          <span>Elapsed: {formatElapsed(activeScriptJob?.startedAt || activePipelineJob.startedAt || activePipelineJob.createdAt)}</span>
                          <span>Pipeline: {activePipelineJob.progress ?? 0}%</span>
                        </div>
                      </div>

                    <div className="rounded-xl border border-zinc-800/60 bg-zinc-950 p-3">
                      <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-zinc-400">Live Output</div>
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-5 text-zinc-100">
                        {previewLogs.length > 0
                          ? previewLogs.map((line) => String(line).replace(/^\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s*/, "")).join("\n")
                          : "Waiting for live script output..."}
                      </pre>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">No active pipeline is running right now. Start the full pipeline or trigger the schedule to see live preview here.</div>
                )}
              </div>
            </section>

            <section className="space-y-3">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Run Summary</h2>
                <p className="mt-1 text-sm text-muted-foreground">Each script card reflects the latest live run and stays locked while the pipeline is active.</p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {scripts.map((script) => (
                  <ScriptPanel
                    key={script.id}
                    script={script}
                    liveJob={latestScriptJobById[script.id]}
                    executionLocked={executionLocked}
                  />
                ))}
              </div>
            </section>
          </div>

          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Data Viewer</h2>
              <p className="mt-1 text-sm text-muted-foreground">Live output data reloads directly from the latest files on refresh.</p>
            </div>
            <DataViewer />
          </section>

          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Cross-Check</h2>
              <p className="mt-1 text-sm text-muted-foreground">Compare order ids across generated files when a row needs closer inspection.</p>
            </div>
            <CompareSection />
          </section>

          <GoogleDriveSyncPanel />

          <AlertsPanel />
          <MetricsPanel />
        </div>
      </main>
    </div>
  );
};

export default Index;
