import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bug, ChevronDown, ChevronUp, ServerCrash, Trash2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { toast } from "sonner";

const ALERTS_CLEARED_AT_KEY = "alerts-cleared-at";

const ALERT_ICON = {
  api: ServerCrash,
  script: Bug,
  job: AlertTriangle,
} as const;

function stripAlertNoise(value: string): string {
  return String(value || "")
    .replace(/(?:\[\s*REDACTED\s*\])(?:\]+)+/gi, "[REDACTED]")
    .replace(/(?:\]\s*){20,}/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractJsonBlock(value: string): string {
  const text = stripAlertNoise(value);
  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) {
    return text;
  }
  return text.slice(firstBrace).trim();
}

function summarizeTraceback(value: string): string {
  const text = stripAlertNoise(value);
  if (!/traceback \(most recent call last\):/i.test(text)) {
    return "";
  }

  const locationMatches = [...text.matchAll(/File\s+"([^"]+)",\s+line\s+(\d+),\s+in\s+([^\r\n]+)/g)];
  const headline = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => /error|exception/i.test(line) && !/^traceback/i.test(line));

  const summarizedLocations = locationMatches.slice(0, 2).map((match) => {
    const fullPath = match[1] || "";
    const fileName = fullPath.split(/[/\\]/).pop() || fullPath;
    const lineNumber = match[2] || "";
    const functionName = (match[3] || "").trim();
    return `${fileName}:${lineNumber}${functionName ? ` (${functionName})` : ""}`;
  });

  const parts = [];
  if (headline) {
    parts.push(headline);
  }
  if (summarizedLocations.length > 0) {
    parts.push(`Traceback at ${summarizedLocations.join(" -> ")}`);
  }
  return parts.join(" | ").trim();
}

function formatAlertMessage(value: string): string {
  const text = stripAlertNoise(value);
  const jsonBlock = extractJsonBlock(text);
  const tracebackSummary = summarizeTraceback(text);
  if (tracebackSummary) {
    return tracebackSummary;
  }

  try {
    const parsed = JSON.parse(jsonBlock);
    const errorMessage =
      parsed?.error?.message ||
      parsed?.message ||
      parsed?.error ||
      "";
    if (errorMessage) {
      return String(errorMessage).trim();
    }
  } catch {
    // Keep best-effort plain text below.
  }

  const normalized = text
    .replace(/^API ERROR:\s*/i, "")
    .replace(/^Process error:\s*/i, "")
    .trim();

  return normalized.length > 220 ? `${normalized.slice(0, 220).trim()}...` : normalized;
}

function formatAlertRaw(value: string): string {
  const text = stripAlertNoise(value);
  const jsonBlock = extractJsonBlock(text);

  try {
    const parsed = JSON.parse(jsonBlock);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text.replace(/ (?=\{)/g, "\n");
  }
}

export function AlertsPanel() {
  const queryClient = useQueryClient();
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [alertLimit, setAlertLimit] = useState(20);
  const [clearedAt, setClearedAt] = useState<string>(() => window.localStorage.getItem(ALERTS_CLEARED_AT_KEY) || "");

  const { data: authData } = useQuery({
    queryKey: ["auth"],
    queryFn: api.authMe,
    staleTime: 30_000,
  });

  const { data, isLoading } = useQuery({
    queryKey: ["alerts", alertLimit],
    queryFn: () => api.alerts(alertLimit),
    refetchInterval: 5000,
  });

  const clearAlertsMutation = useMutation({
    mutationFn: api.clearAlerts,
    onSuccess: (response) => {
      const nextClearedAt = response?.clearedAt || new Date().toISOString();
      window.localStorage.setItem(ALERTS_CLEARED_AT_KEY, nextClearedAt);
      setClearedAt(nextClearedAt);
      setExpandedIds({});
      queryClient.setQueryData(["alerts", alertLimit], { alerts: [] });
      toast.success("Alerts cleared");
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
    },
    onError: (error) => toast.error(error.message || "Failed to clear alerts"),
  });

  const alerts = useMemo(() => {
    const clearedAtMs = clearedAt ? Date.parse(clearedAt) : NaN;
    return (data?.alerts ?? []).filter((alert) => {
      const normalizedMessage = String(alert.message || "").toLowerCase();
      if (normalizedMessage.includes("run_summary|")) {
        return false;
      }
      if (alert.status === "cancelled" && normalizedMessage.includes("cancelled by user")) {
        return false;
      }
      const createdAtMs = Date.parse(alert.createdAt);
      if (!Number.isFinite(clearedAtMs) || !Number.isFinite(createdAtMs)) {
        return true;
      }
      return createdAtMs > clearedAtMs;
    });
  }, [clearedAt, data?.alerts]);

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Alerts
      </h2>
      <Card className="overflow-hidden border-red-500/20">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <CardTitle className="text-base">Failure and Error Alerts</CardTitle>
            <CardDescription>
              Latest API, script, and job-level issues with clean summaries and expandable raw details.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-2 self-start"
            onClick={() => clearAlertsMutation.mutate()}
            disabled={clearAlertsMutation.isPending || alerts.length === 0 || authData?.user?.role !== "admin"}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear Alerts
          </Button>
        </CardHeader>
        <CardContent className="space-y-3 overflow-hidden">
          {!isLoading && alerts.length === 0 && (
            <p className="text-sm text-muted-foreground">No active alerts found in recent runs.</p>
          )}
          {alerts.map((alert) => {
            const Icon = ALERT_ICON[alert.type] ?? AlertTriangle;
            const isExpanded = Boolean(expandedIds[alert.id]);
            const formattedMessage = formatAlertMessage(alert.message);
            const formattedRaw = formatAlertRaw(alert.raw);
            return (
              <div key={alert.id} className="overflow-hidden rounded-lg border bg-background px-3 py-3">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                  <div className="min-w-0 space-y-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                      <span className="flex min-w-0 items-center gap-2 font-medium text-foreground">
                        <Icon className="h-3.5 w-3.5 shrink-0 text-red-500" />
                        <span className="min-w-0 truncate">{alert.title}</span>
                      </span>
                      <Badge variant="outline" className="max-w-[14rem] shrink-0 truncate">
                        {alert.scriptId}
                      </Badge>
                      <Badge variant="secondary" className="shrink-0 whitespace-nowrap">
                        {alert.status}
                      </Badge>
                    </div>
                    <p className="whitespace-pre-line break-words text-sm leading-6 text-foreground">
                      {formattedMessage}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-muted-foreground sm:justify-end sm:text-right">
                    <span className="whitespace-nowrap">{new Date(alert.createdAt).toLocaleString()}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 px-2 text-xs"
                      onClick={() =>
                        setExpandedIds((current) => ({
                          ...current,
                          [alert.id]: !current[alert.id],
                        }))
                      }
                    >
                      {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      Raw
                    </Button>
                  </div>
                </div>

                {isExpanded && (
                  <pre className="mt-3 max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-[11px] leading-5 text-muted-foreground">
                    {formattedRaw}
                  </pre>
                )}
              </div>
            );
          })}
          {alerts.length >= alertLimit ? (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => setAlertLimit((current) => current + 30)}
            >
              View More
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
