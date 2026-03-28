import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Eye, RotateCcw, Loader2, CheckCircle2, XCircle, Square } from "lucide-react";
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

export function ScriptPanel({ script, cronMode, liveJob }: ScriptPanelProps) {
  const [status, setStatus] = useState<"idle" | "running" | "success" | "error">("idle");
  const [selectedOption, setSelectedOption] = useState(script.options?.[0] ?? "");
  const [showViewOptions, setShowViewOptions] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [progress, setProgress] = useState(0);
  const [customTiming, setCustomTiming] = useState("10");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const terminalRef = useRef<HTMLPreElement | null>(null);

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
  const logText = useMemo(() => (displayJob?.logs?.join("\n") || "Waiting for logs...").trim(), [displayJob?.logs]);
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

  const statusIcon: Record<string, JSX.Element> = {
    idle: <Square className="h-3.5 w-3.5" />,
    running: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
    success: <CheckCircle2 className="h-3.5 w-3.5 text-success" />,
    error: <XCircle className="h-3.5 w-3.5 text-destructive" />,
  };

  const statusLabel = { idle: "Idle", running: "Running", success: "Done", error: "Failed" };

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !stickToBottom) return;
    terminal.scrollTop = terminal.scrollHeight;
  }, [logText, stickToBottom]);

  const handleTerminalScroll = () => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const remaining = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight;
    setStickToBottom(remaining < 24);
  };

  return (
    <>
      <div className="group rounded-xl border bg-card p-4 card-shadow transition-all duration-300 hover:card-shadow-hover animate-fade-in">
        {/* Header */}
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">{script.name}</h3>
            <p className="text-xs text-muted-foreground">{script.description}</p>
          </div>
          <div className="flex items-center gap-1.5">
            {statusIcon[displayStatus]}
            <span className="text-xs font-medium text-muted-foreground">{statusLabel[displayStatus]}</span>
          </div>
        </div>

        {/* Progress bar */}
        {displayStatus === "running" && (
          <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${Math.min(displayProgress, 100)}%` }}
            />
          </div>
        )}

        {/* Custom timing */}
        {cronMode === "custom" && (
          <div className="mb-3 flex items-center gap-2 text-xs">
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

        {/* Meta */}
        {displayJob?.updatedAt && (
          <div className="mb-3 flex gap-4 text-xs text-muted-foreground">
            <span>Last: {new Date(displayJob.updatedAt).toLocaleString()}</span>
            {displayJob.startedAt && displayJob.finishedAt ? (
              <span>
                Duration:{" "}
                {Math.max(
                  1,
                  Math.round(
                    (new Date(displayJob.finishedAt).getTime() - new Date(displayJob.startedAt).getTime()) /
                      1000,
                  ),
                )}
                s
              </span>
            ) : null}
            {displayJob.status === "running" && <span className="text-primary">Live</span>}
          </div>
        )}

        {script.hasOptions && (
          <div className="mb-3 flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Mode:</span>
            <select
              value={selectedOption}
              onChange={(event) => setSelectedOption(event.target.value)}
              className="h-8 rounded-md border bg-background px-2 text-xs"
            >
              {(script.options || []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Buttons */}
        <div className="relative flex flex-wrap gap-2">
          <Button size="sm" onClick={handleRun} disabled={displayStatus === "running" || runMutation.isPending} className="gap-1.5">
            <Play className="h-3 w-3" />
            Run
          </Button>

          {displayStatus === "running" && effectiveJobId && (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => cancelMutation.mutate(effectiveJobId)}
              disabled={cancelMutation.isPending}
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
            <Button size="sm" variant="ghost" onClick={() => setShowTerminal((prev) => !prev)}>
              {showTerminal ? "Hide Terminal" : "Show Terminal"}
            </Button>
          )}
        </div>

        {showTerminal && effectiveJobId && (
          <div className="relative z-0 mt-3 rounded-lg border bg-muted/40 p-2">
            <div className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground">
              <span className="font-mono">{effectiveJobId}</span>
              <span>{jobQuery.data?.job?.status ?? status}</span>
            </div>
            <pre
              ref={terminalRef}
              onScroll={handleTerminalScroll}
              className="max-h-56 overflow-auto overscroll-contain whitespace-pre-wrap rounded border bg-background p-2 text-[11px] font-mono leading-relaxed"
            >
              {logText}
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
            ? "GetTask/Tasks_OrderID.csv"
            : script.id === "get-order-inquiry"
              ? "GetOrderInquiry/OrderInquiry.csv"
              : script.id === "updater"
                ? "Updater/updater_payloads.csv"
                : script.id === "closing-task"
                  ? "ClosingTask/closing_task_payloads.csv"
                  : "Funeral_Finder/Funeral_data.csv"
        }
      />
    </>
  );
}
