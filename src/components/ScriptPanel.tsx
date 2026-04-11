import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Eye, RotateCcw, Loader2, CheckCircle2, XCircle, Square, Terminal, Clock, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type Job, type ScriptConfig } from "@/lib/types";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { ViewOptionsModal } from "./ViewOptionsModal";

interface ScriptPanelProps {
  script: ScriptConfig;
  cronMode: "default" | "custom";
  liveJob?: Job;
}

const UPDATER_MODE_LABELS: Record<string, string> = {
  complete: "Complete (All Records)",
  found_only: "Found Only",
  not_found: "Not Found Only",
  review: "Review Data Only",
};

function formatElapsed(startedAt: string | null | undefined): string {
  if (!startedAt) return "0s";
  const elapsed = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
  if (elapsed < 60) return `${elapsed}s`;
  const min = Math.floor(elapsed / 60);
  const sec = elapsed % 60;
  return `${min}m ${sec}s`;
}

function formatDuration(startedAt?: string | null, finishedAt?: string | null): string {
  if (!startedAt || !finishedAt) return "";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  return `${min}m ${s}s`;
}

export function ScriptPanel({ script, cronMode, liveJob }: ScriptPanelProps) {
  const [status, setStatus] = useState<"idle" | "running" | "success" | "error">("idle");
  const [selectedOption, setSelectedOption] = useState(script.options?.[0] ?? "");
  const [showViewOptions, setShowViewOptions] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [progress, setProgress] = useState(0);
  const [customTiming, setCustomTiming] = useState("10");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [elapsedTick, setElapsedTick] = useState(0);
  const terminalRef = useRef<HTMLPreElement | null>(null);

  // Elapsed time ticker while running
  useEffect(() => {
    if (status !== "running") return;
    const interval = setInterval(() => setElapsedTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [status]);

  const runMutation = useMutation({
    mutationFn: (option?: string) => api.runScript(script.id, option),
    onSuccess: ({ jobId }) => {
      setActiveJobId(jobId);
      setStatus("running");
      toast.info(`Running ${script.name}${selectedOption ? ` (${selectedOption})` : ""}...`);
    },
    onError: (error) => {
      setStatus("error");
      toast.error(error.message || `Failed to run ${script.name}`);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (jobId: string) => api.cancelJob(jobId),
    onSuccess: () => {
      toast.info(`${script.name} stopped`);
    },
    onError: (error) => {
      toast.error(error.message || `Failed to stop ${script.name}`);
    },
  });

  const effectiveJobId = activeJobId ?? liveJob?.id ?? null;

  const jobQuery = useQuery({
    queryKey: ["job", effectiveJobId],
    queryFn: () => api.job(effectiveJobId as string),
    enabled: Boolean(effectiveJobId),
    refetchInterval: (query) => {
      const currentStatus = query.state.data?.job?.status;
      if (!currentStatus || ["success", "failed", "cancelled"].includes(currentStatus)) {
        return false;
      }
      return 1200;
    },
  });

  useEffect(() => {
    const job = jobQuery.data?.job;
    if (!job) return;

    setProgress(job.progress || 0);
    if (job.status === "running" || job.status === "queued") {
      setStatus("running");
    } else if (job.status === "success") {
      setStatus("success");
      toast.success(`${script.name} completed!`);
    } else if (job.status === "failed" || job.status === "cancelled") {
      setStatus("error");
      toast.error(`${script.name} failed — check logs`);
    }
    return;
  }, [jobQuery.data, script.name]);

  useEffect(() => {
    if (!activeJobId && liveJob?.id) {
      setActiveJobId(liveJob.id);
    }
  }, [activeJobId, liveJob?.id]);

  const runScript = (option?: string) => {
    const resolvedOption = option ?? (script.hasOptions ? selectedOption : undefined);
    if (resolvedOption) setSelectedOption(resolvedOption);
    setProgress(0);
    setShowTerminal(true);
    setStickToBottom(true);
    runMutation.mutate(resolvedOption);
  };

  const handleRun = () => {
    runScript();
  };

  useEffect(() => {
    if (script.hasOptions && !selectedOption && script.options?.length) {
      setSelectedOption(script.options[0]);
    }
  }, [script.hasOptions, script.options, selectedOption]);

  const reset = () => {
    setStatus("idle");
    setProgress(0);
    setActiveJobId(null);
    setShowTerminal(false);
    setStickToBottom(true);
  };

  const displayJob = jobQuery.data?.job ?? liveJob;
  const logLines = useMemo(() => displayJob?.logs ?? [], [displayJob?.logs]);

  const displayProgress = displayJob?.progress ?? progress;
  const displayStatus = displayJob
    ? (displayJob.status === "running" || displayJob.status === "queued"
        ? "running"
        : displayJob.status === "success"
          ? "success"
          : displayJob.status === "failed" || displayJob.status === "cancelled"
            ? "error"
            : "idle")
    : status;

  const statusConfig: Record<string, { icon: JSX.Element; label: string; color: string; bg: string }> = {
    idle: {
      icon: <Square className="h-3.5 w-3.5" />,
      label: "Idle",
      color: "text-muted-foreground",
      bg: "bg-muted/50",
    },
    running: {
      icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
      label: "Running",
      color: "text-blue-500",
      bg: "bg-blue-500/10",
    },
    success: {
      icon: <CheckCircle2 className="h-3.5 w-3.5" />,
      label: "Done",
      color: "text-emerald-500",
      bg: "bg-emerald-500/10",
    },
    error: {
      icon: <XCircle className="h-3.5 w-3.5" />,
      label: "Failed",
      color: "text-red-500",
      bg: "bg-red-500/10",
    },
  };

  const currentStatus = statusConfig[displayStatus] || statusConfig.idle;

  // Elapsed time string
  const elapsedStr = displayStatus === "running"
    ? formatElapsed(displayJob?.startedAt)
    : formatDuration(displayJob?.startedAt, displayJob?.finishedAt);

  // suppress unused variable lint
  void elapsedTick;

  // Terminal auto-scroll
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !stickToBottom) return;
    terminal.scrollTop = terminal.scrollHeight;
  }, [logLines, stickToBottom]);

  const handleTerminalScroll = () => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const remaining = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight;
    setStickToBottom(remaining < 24);
  };

  // Colorize terminal lines
  const colorizeLogLine = (line: string): string => {
    if (line.includes("✅") || line.includes("SUCCESS") || line.includes("✓") || line.startsWith("OK|"))
      return "terminal-line-success";
    if (line.includes("❌") || line.includes("ERROR") || line.includes("FAILED") || line.startsWith("ERR|"))
      return "terminal-line-error";
    if (line.includes("⚠️") || line.includes("SKIP") || line.includes("WARNING") || line.includes("Review"))
      return "terminal-line-warn";
    if (line.includes("⏭") || line.includes("SKIP"))
      return "terminal-line-skip";
    if (line.includes("═") || line.includes("─") || line.includes("┌") || line.includes("└") || line.includes("│"))
      return "terminal-line-border";
    if (line.includes("RUN_SUMMARY|"))
      return "terminal-line-summary";
    return "";
  };

  return (
    <>
      <div className={`group rounded-xl border bg-card p-4 card-shadow transition-all duration-300 hover:card-shadow-hover animate-fade-in ${
        displayStatus === "running" ? "ring-2 ring-blue-500/30" : ""
      }`}>
        {/* Header */}
        <div className="mb-3 flex items-center justify-between">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold truncate">{script.name}</h3>
            <p className="text-xs text-muted-foreground truncate">{script.description}</p>
          </div>
          <div className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${currentStatus.color} ${currentStatus.bg}`}>
            {currentStatus.icon}
            <span>{currentStatus.label}</span>
            {displayStatus === "running" && (
              <span className="ml-1 tabular-nums">{elapsedStr}</span>
            )}
          </div>
        </div>

        {/* Progress bar */}
        {displayStatus === "running" && (
          <div className="mb-3 relative">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-400 transition-all duration-500 ease-out"
                style={{ width: `${Math.min(displayProgress, 100)}%` }}
              />
            </div>
            <span className="absolute right-0 -top-4 text-[10px] text-muted-foreground tabular-nums">
              {displayProgress}%
            </span>
          </div>
        )}

        {/* Custom timing */}
        {cronMode === "custom" && (
          <div className="mb-3 flex items-center gap-2 text-xs">
            <Clock className="h-3 w-3 text-muted-foreground" />
            <span className="text-muted-foreground">Timing:</span>
            <input
              type="number"
              value={customTiming}
              onChange={(e) => setCustomTiming(e.target.value)}
              className="w-14 rounded border bg-background px-2 py-1 text-xs"
              min="1"
            />
            <span className="text-muted-foreground">min</span>
          </div>
        )}

        {/* Meta info */}
        {displayJob?.updatedAt && displayStatus !== "running" && (
          <div className="mb-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {new Date(displayJob.updatedAt).toLocaleString()}
            </span>
            {elapsedStr && (
              <span>{elapsedStr}</span>
            )}
          </div>
        )}

        {/* Options dropdown */}
        {script.hasOptions && (
          <div className="mb-3 flex items-center gap-2 text-xs">
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
            <span className="text-muted-foreground">
              {script.id === "updater" ? "File Source:" : "Mode:"}
            </span>
            <select
              value={selectedOption}
              onChange={(event) => setSelectedOption(event.target.value)}
              className="h-8 rounded-md border bg-background px-2 text-xs flex-1"
            >
              {(script.options || []).map((option) => (
                <option key={option} value={option}>
                  {script.id === "updater"
                    ? UPDATER_MODE_LABELS[option] || option
                    : option}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Selected mode badge for updater */}
        {script.id === "updater" && selectedOption && (
          <div className="mb-3">
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-[10px] font-medium text-primary">
              📂 {UPDATER_MODE_LABELS[selectedOption] || selectedOption}
            </span>
          </div>
        )}

        {/* Buttons */}
        <div className="relative flex flex-wrap gap-2">
          {displayStatus !== "running" ? (
            <Button
              size="sm"
              onClick={handleRun}
              disabled={runMutation.isPending}
              className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              <Play className="h-3 w-3" />
              Run
            </Button>
          ) : (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => effectiveJobId && cancelMutation.mutate(effectiveJobId)}
              disabled={cancelMutation.isPending || !effectiveJobId}
              className="gap-1.5"
            >
              <Square className="h-3 w-3" />
              Stop
            </Button>
          )}

          <Button size="sm" variant="outline" onClick={() => setShowViewOptions(true)} className="gap-1.5">
            <Eye className="h-3 w-3" />
            View
          </Button>

          <Button size="sm" variant="ghost" onClick={reset} className="gap-1.5">
            <RotateCcw className="h-3 w-3" />
            Reset
          </Button>

          {effectiveJobId && (
            <Button
              size="sm"
              variant={showTerminal ? "secondary" : "outline"}
              onClick={() => setShowTerminal((prev) => !prev)}
              className="gap-1.5 ml-auto"
            >
              <Terminal className="h-3 w-3" />
              {showTerminal ? "Hide" : "Logs"}
            </Button>
          )}
        </div>

        {/* Terminal-like log viewer */}
        {showTerminal && effectiveJobId && (
          <div className="mt-3 rounded-lg overflow-hidden border border-zinc-700/50">
            {/* Terminal header */}
            <div className="flex items-center justify-between bg-zinc-800 dark:bg-zinc-900 px-3 py-1.5">
              <div className="flex items-center gap-2">
                <div className="flex gap-1.5">
                  <div className="h-2.5 w-2.5 rounded-full bg-red-500/80" />
                  <div className="h-2.5 w-2.5 rounded-full bg-yellow-500/80" />
                  <div className="h-2.5 w-2.5 rounded-full bg-green-500/80" />
                </div>
                <span className="text-[10px] font-mono text-zinc-400">{script.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-[10px] font-mono ${
                  displayStatus === "running" ? "text-blue-400" :
                  displayStatus === "success" ? "text-emerald-400" :
                  displayStatus === "error" ? "text-red-400" :
                  "text-zinc-500"
                }`}>
                  {displayStatus === "running" ? `● running ${elapsedStr}` :
                   displayStatus === "success" ? "✓ done" :
                   displayStatus === "error" ? "✗ failed" : "idle"}
                </span>
                {!stickToBottom && (
                  <button
                    onClick={() => {
                      setStickToBottom(true);
                      if (terminalRef.current) {
                        terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
                      }
                    }}
                    className="rounded px-1.5 py-0.5 text-[9px] bg-zinc-700 text-zinc-300 hover:bg-zinc-600"
                  >
                    ↓ Bottom
                  </button>
                )}
              </div>
            </div>

            {/* Terminal body */}
            <pre
              ref={terminalRef}
              onScroll={handleTerminalScroll}
              className="max-h-64 overflow-auto bg-zinc-900 dark:bg-[#0d1117] p-3 text-[11px] font-mono leading-5 text-zinc-300 overscroll-contain"
            >
              {logLines.length === 0 ? (
                <span className="text-zinc-500">Waiting for output...</span>
              ) : (
                logLines.map((line, i) => {
                  const colorClass = colorizeLogLine(line);
                  // Strip timestamp prefix for cleaner display
                  const displayLine = line.replace(/^\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s*/, "");
                  return (
                    <div key={i} className={`flex gap-2 ${colorClass}`}>
                      <span className="select-none text-zinc-600 w-6 text-right shrink-0">
                        {i + 1}
                      </span>
                      <span className="flex-1 whitespace-pre-wrap break-all">{displayLine}</span>
                    </div>
                  );
                })
              )}
              {displayStatus === "running" && (
                <div className="flex gap-2">
                  <span className="text-zinc-600 w-6 text-right shrink-0">&gt;</span>
                  <span className="animate-pulse text-blue-400">▌</span>
                </div>
              )}
            </pre>
          </div>
        )}
      </div>

      <ViewOptionsModal
        open={showViewOptions}
        onClose={() => setShowViewOptions(false)}
        scriptName={script.name}
        sourcePath={
          script.id === "get-task"
            ? "GetTask/data.csv"
            : script.id === "get-order-inquiry"
              ? "GetOrderInquiry/data.csv"
              : script.id === "funeral-finder"
                ? "Funeral_Finder/Funeral_data.csv"
                : script.id === "reverify"
                  ? "Funeral_Finder/Funeral_data.csv"
                : script.id === "updater"
                  ? "Updater/data.csv"
                  : script.id === "closing-task"
                    ? "ClosingTask/data.csv"
                    : "master/master_records.csv"
        }
      />
    </>
  );
}
