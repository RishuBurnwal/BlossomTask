import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Database, Edit3, FileText, PlayCircle, RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/time";
import { ModuleHelp } from "./ModuleHelp";

const SCRIPT_OPTIONS = [
  { id: "get-task", label: "GetTask" },
  { id: "get-order-inquiry", label: "GetOrderInquiry" },
  { id: "funeral-finder", label: "Funeral Finder" },
  { id: "reverify", label: "Reverify" },
  { id: "updater", label: "Updater" },
  { id: "closing-task", label: "ClosingTask" },
];

const DELETE_SCOPES = [
  { id: "order_inquiries", label: "Order inquiries" },
  { id: "funeral_results", label: "Funeral results" },
  { id: "crm_update_attempts", label: "CRM attempts" },
  { id: "ai_attempts", label: "AI attempts" },
  { id: "script_run_logs", label: "Run logs" },
  { id: "order_processing_state", label: "Processing state" },
  { id: "order", label: "Soft-delete order" },
];

function summarizeLatestResult(orderTimeline?: Awaited<ReturnType<typeof api.sqlOrderTimeline>>) {
  const latest = orderTimeline?.results?.[0] as Record<string, unknown> | undefined;
  if (!latest) return [];
  return Object.entries(latest)
    .filter(([, value]) => value != null && String(value).trim() !== "")
    .slice(0, 8);
}

function formatReportRange(dateFrom?: string, dateTo?: string) {
  if (dateFrom && dateTo) return `${dateFrom} to ${dateTo}`;
  if (dateFrom) return `${dateFrom} onward`;
  if (dateTo) return `Up to ${dateTo}`;
  return "All available SQL-backed data";
}

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

export function SqlControlCenter() {
  const [orderId, setOrderId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [forceReprocess, setForceReprocess] = useState(false);
  const [selectedScripts, setSelectedScripts] = useState<string[]>(["get-order-inquiry", "funeral-finder", "reverify", "updater"]);
  const [activeJobId, setActiveJobId] = useState("");
  const [manualStatus, setManualStatus] = useState("Review");
  const [manualDatetime, setManualDatetime] = useState("");
  const [manualFuneralHome, setManualFuneralHome] = useState("");
  const [manualNotes, setManualNotes] = useState("");
  const [actionReason, setActionReason] = useState("");
  const [deleteScopes, setDeleteScopes] = useState<string[]>(["order_processing_state"]);

  const { data: sqlHealth, refetch: refetchHealth } = useQuery({
    queryKey: ["sql-health"],
    queryFn: api.sqlHealth,
    refetchInterval: 20_000,
  });

  const { data: sqlOrders } = useQuery({
    queryKey: ["sql-orders-control-center"],
    queryFn: () => api.sqlOrders({ limit: 25, sort: "updated_at", direction: "desc" }),
    enabled: Boolean(sqlHealth?.configured && sqlHealth?.connected),
    refetchInterval: 20_000,
  });

  const { data: orderTimeline, refetch: refetchOrderTimeline } = useQuery({
    queryKey: ["sql-order-timeline", orderId.trim(), "control-center"],
    queryFn: () => api.sqlOrderTimeline(orderId.trim()),
    enabled: Boolean(sqlHealth?.configured && sqlHealth?.connected && orderId.trim()),
  });

  const { data: sqlRunLogs } = useQuery({
    queryKey: ["sql-run-logs", activeJobId],
    queryFn: () => api.sqlRunLogs(activeJobId),
    enabled: Boolean(activeJobId),
    refetchInterval: 1500,
  });

  const { data: reportMeta } = useQuery({
    queryKey: ["sql-report-meta"],
    queryFn: api.sqlReportMeta,
    enabled: Boolean(sqlHealth?.configured && sqlHealth?.connected),
    refetchInterval: 30_000,
  });

  const { data: getTaskDiagnostics } = useQuery({
    queryKey: ["get-task-diagnostics"],
    queryFn: api.getTaskDiagnostics,
    refetchInterval: 30_000,
  });

  const bootstrapMutation = useMutation({
    mutationFn: api.sqlBootstrap,
  });

  const reportMutation = useMutation({
    mutationFn: api.sqlGenerateReport,
  });

  const runMutation = useMutation({
    mutationFn: api.sqlRunOrderPipeline,
    onSuccess: (result) => setActiveJobId(result.jobId),
  });

  const manualUpdateMutation = useMutation({
    mutationFn: () => api.sqlManualUpdate(orderId.trim(), {
      matchStatus: manualStatus,
      serviceDatetime: manualDatetime,
      funeralHome: manualFuneralHome,
      notes: manualNotes,
      reason: actionReason || "manual update from SQL Control Center",
    }),
    onSuccess: () => void refetchOrderTimeline(),
  });

  const scopedDeleteMutation = useMutation({
    mutationFn: () => api.sqlScopedDelete(orderId.trim(), {
      scopes: deleteScopes,
      reason: actionReason || "scoped reset from SQL Control Center",
    }),
    onSuccess: () => void refetchOrderTimeline(),
  });

  const selectedCount = selectedScripts.length;

  const downloadReportHtml = () => {
    if (!reportMutation.data) return;
    downloadTextFile(
      `blossomtask-sql-report-${reportMutation.data.dateFrom || "all"}-${reportMutation.data.dateTo || "latest"}.html`,
      reportMutation.data.generatedHtml,
      "text/html;charset=utf-8",
    );
  };

  const downloadReportJson = () => {
    if (!reportMutation.data) return;
    downloadTextFile(
      `blossomtask-sql-report-${reportMutation.data.dateFrom || "all"}-${reportMutation.data.dateTo || "latest"}.json`,
      `${JSON.stringify(reportMutation.data, null, 2)}\n`,
      "application/json;charset=utf-8",
    );
  };
  const orderSuggestions = (sqlOrders?.rows ?? []).map((row) => String(row.order_id || "")).filter(Boolean);
  const latestResultPairs = summarizeLatestResult(orderTimeline);
  const selectedScriptLabels = SCRIPT_OPTIONS.filter((script) => selectedScripts.includes(script.id)).map((script) => script.label);
  const latestAllowedDate = reportMeta?.maxDate || "";
  const earliestAllowedDate = reportMeta?.minDate || "";
  const getTaskStatsAvailable = getTaskDiagnostics && !("ok" in getTaskDiagnostics && getTaskDiagnostics.ok === false);
  const diagnosticStats = getTaskStatsAvailable ? getTaskDiagnostics : null;
  const missingMysqlEnv = sqlHealth?.config?.missing ?? [];
  const sqlGuidanceSteps = sqlHealth?.guidance?.steps ?? [];

  function toggleScript(scriptId: string) {
    setSelectedScripts((current) => (
      current.includes(scriptId)
        ? current.filter((item) => item !== scriptId)
        : [...current, scriptId]
    ));
  }

  function toggleDeleteScope(scopeId: string) {
    setDeleteScopes((current) => (
      current.includes(scopeId)
        ? current.filter((scope) => scope !== scopeId)
        : [...current, scopeId]
    ));
  }

  function applyReportRange() {
    const nextFrom = dateFrom && earliestAllowedDate && dateFrom < earliestAllowedDate ? earliestAllowedDate : dateFrom;
    const nextTo = dateTo && latestAllowedDate && dateTo > latestAllowedDate ? latestAllowedDate : dateTo;
    setDateFrom(nextFrom);
    setDateTo(nextTo);
    reportMutation.mutate({ dateFrom: nextFrom, dateTo: nextTo });
  }

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">SQL Control Center</h2>
            <ModuleHelp
              title="SQL Control Center"
              purpose="Operate order-scoped SQL workflows: verify connection health, run selected scripts for one order, apply manual corrections, and generate bounded reports."
              useCases={[
                "Re-run only one order through selected scripts.",
                "Apply a manual status or service-time correction before reprocessing.",
                "Generate a report only for the valid SQL-backed date range.",
              ]}
              example="Example: select one order, enable Force Reprocess, run GetOrderInquiry + Funeral Finder + Updater, then confirm the latest SQL result before generating a report."
            />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">This area is for targeted SQL operations. Use the main Data Viewer for large-table browsing.</p>
        </div>
      </div>

      <div className="rounded-2xl border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Database className="h-4 w-4" />
              SQL Connection
            </div>
            <div className="rounded-lg border bg-background px-3 py-2 text-sm">
              Configured: <strong>{sqlHealth?.configured ? "Yes" : "No"}</strong> | Connected: <strong>{sqlHealth?.connected ? "Yes" : "No"}</strong>
            </div>
            {sqlHealth?.startup?.state ? (
              <div className="rounded-lg border bg-background px-3 py-2 text-sm">
                Startup state: <strong>{sqlHealth.startup.state}</strong>
              </div>
            ) : null}
            {sqlHealth?.connection?.database_name ? (
              <div className="rounded-lg border bg-background px-3 py-2 text-sm">
                Database: <strong>{sqlHealth.connection.database_name}</strong>
              </div>
            ) : null}
            {sqlHealth?.config?.values?.MYSQL_HOST ? (
              <div className="rounded-lg border bg-background px-3 py-2 text-sm">
                Host: <strong>{sqlHealth.config.values.MYSQL_HOST}:{sqlHealth.config.values.MYSQL_PORT || 3306}</strong>
              </div>
            ) : null}
            {sqlHealth?.startup?.tunnel?.localHost && sqlHealth?.startup?.tunnel?.localPort ? (
              <div className="rounded-lg border bg-background px-3 py-2 text-sm">
                Tunnel: <strong>{sqlHealth.startup.tunnel.localHost}:{sqlHealth.startup.tunnel.localPort}</strong>
              </div>
            ) : null}
            {missingMysqlEnv.length > 0 ? (
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                Missing `.env` keys on server: <strong>{missingMysqlEnv.join(", ")}</strong>
              </div>
            ) : null}
            {sqlHealth?.message ? <div className="text-xs text-muted-foreground">{sqlHealth.message}</div> : null}
            {sqlHealth?.error ? <div className="text-xs text-destructive">{sqlHealth.error}</div> : null}
            {sqlHealth?.guidance?.summary ? (
              <div className="rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                {sqlHealth.guidance.summary}
              </div>
            ) : null}
            {sqlGuidanceSteps.length > 0 ? (
              <div className="rounded-lg border bg-background px-3 py-2 text-xs text-muted-foreground">
                <div className="font-medium text-foreground">Next checks</div>
                <ol className="mt-2 list-decimal space-y-1 pl-4">
                  {sqlGuidanceSteps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => void refetchHealth()} className="rounded-md border bg-background px-3 py-2 text-xs hover:bg-accent">
              Refresh Health
            </button>
            <button
              onClick={() => bootstrapMutation.mutate()}
              className="rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground hover:opacity-90"
            >
              Bootstrap + Import Outputs
            </button>
          </div>
        </div>
        {bootstrapMutation.data?.summary ? (
          <pre className="mt-3 max-h-44 overflow-auto rounded-lg border bg-muted/40 p-3 text-[11px]">
            {JSON.stringify(bootstrapMutation.data.summary, null, 2)}
          </pre>
        ) : null}

        <div className="mt-4 rounded-xl border bg-background p-4">
          <div className="mb-2 text-sm font-semibold">GetTask Intake Diagnostics</div>
          <p className="mb-3 text-xs text-muted-foreground">
            This compares raw GetTask intake against duplicate and closed-order filters so we can see why a manual API call may show more rows than the pipeline stores.
          </p>
          {getTaskStatsAvailable ? (
            <>
              <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-6">
                <div className="rounded-lg border bg-muted/20 p-3 text-xs">Manual/API Items<br /><strong className="text-base text-foreground">{diagnosticStats?.server_items_received ?? 0}</strong></div>
                <div className="rounded-lg border bg-muted/20 p-3 text-xs">Unique Order IDs<br /><strong className="text-base text-foreground">{diagnosticStats?.unique_order_ids_received ?? 0}</strong></div>
                <div className="rounded-lg border bg-muted/20 p-3 text-xs">Already Processed<br /><strong className="text-base text-foreground">{diagnosticStats?.already_processed_count ?? 0}</strong></div>
                <div className="rounded-lg border bg-muted/20 p-3 text-xs">Already Closed<br /><strong className="text-base text-foreground">{diagnosticStats?.already_closed_count ?? 0}</strong></div>
                <div className="rounded-lg border bg-muted/20 p-3 text-xs">Runnable Now<br /><strong className="text-base text-foreground">{diagnosticStats?.runnable_count ?? 0}</strong></div>
                <div className="rounded-lg border bg-muted/20 p-3 text-xs">Saved In Run<br /><strong className="text-base text-foreground">{diagnosticStats?.saved_count ?? 0}</strong></div>
              </div>
              <div className="mt-3 rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
                Generated {diagnosticStats?.generated_at ? formatDateTime(diagnosticStats.generated_at) : "Unavailable"} | processed source {diagnosticStats?.processed_source?.toUpperCase() || "N/A"} | closed source {diagnosticStats?.closed_source?.toUpperCase() || "N/A"} | fetch limit {diagnosticStats?.fetch_limit === 0 ? "unlimited" : diagnosticStats?.fetch_limit ?? "N/A"}
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="rounded-lg border bg-background p-3 text-xs">
                  <div className="mb-2 font-medium text-foreground">Sample manual/API order IDs</div>
                  <div className="break-words text-muted-foreground">{diagnosticStats?.sample_order_ids?.join(", ") || "None"}</div>
                </div>
                <div className="rounded-lg border bg-background p-3 text-xs">
                  <div className="mb-2 font-medium text-foreground">Sample runnable order IDs</div>
                  <div className="break-words text-muted-foreground">{diagnosticStats?.sample_runnable_order_ids?.join(", ") || "None"}</div>
                </div>
              </div>
            </>
          ) : (
            <div className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
              Run `GetTask.py --stats-only` once to generate diagnostics for this panel.
            </div>
          )}
        </div>

        <div className="mt-4 rounded-xl border bg-background p-4">
          <div className="mb-2 text-sm font-semibold">Where Date-Wise SQL Data Appears</div>
          <div className="space-y-2 text-xs text-muted-foreground">
            <div>Use the main <strong className="text-foreground">Data Viewer</strong> in SQL mode to see the <strong className="text-foreground">Day-wise Processed Data</strong> cards for the current dataset.</div>
            <div>Use <strong className="text-foreground">Generate Report</strong> below to see the full SQL-backed <strong className="text-foreground">Day-wise Breakdown</strong> table for a selected date range.</div>
            <div>If rows exist in local files but not here, run <code>Bootstrap + Import Outputs</code> after SQL connection is fixed.</div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
        <div className="rounded-2xl border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <PlayCircle className="h-4 w-4" />
            Single Order Runner
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Use this when you need to rerun one order through a controlled sequence instead of launching the full pipeline. Force Reprocess tells the SQL duplicate guard to run the selected scripts even if they previously completed successfully for that order.
          </p>
          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
            <input
              value={orderId}
              onChange={(event) => setOrderId(event.target.value)}
              placeholder="Enter order_id"
              className="h-10 rounded-md border bg-background px-3 text-sm"
            />
            <label className="flex items-center gap-2 rounded-md border bg-background px-3 text-sm">
              <input type="checkbox" checked={forceReprocess} onChange={(event) => setForceReprocess(event.target.checked)} />
              Force Reprocess
            </label>
          </div>
          {orderSuggestions.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {orderSuggestions.slice(0, 10).map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => setOrderId(suggestion)}
                  className="rounded-full border bg-background px-2 py-1 text-[11px] hover:bg-accent"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          ) : null}
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {SCRIPT_OPTIONS.map((script) => (
              <label key={script.id} className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-xs">
                <input
                  type="checkbox"
                  checked={selectedScripts.includes(script.id)}
                  onChange={() => toggleScript(script.id)}
                />
                {script.label}
              </label>
            ))}
          </div>
          <div className="mt-3 rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
            <div className="font-medium text-foreground">What this runner does</div>
            <div className="mt-1">It builds an order-scoped pipeline using only the scripts you selected and applies the result to the chosen order.</div>
            <div className="mt-2 font-medium text-foreground">Example</div>
            <div className="mt-1">Example: choose order <code>5461581</code>, enable Force Reprocess, then run <code>GetOrderInquiry -&gt; Funeral Finder -&gt; Reverify -&gt; Updater</code> to refresh the SQL result for only that order.</div>
            <div className="mt-2 font-medium text-foreground">Current sequence</div>
            <div className="mt-1">{selectedScriptLabels.length > 0 ? selectedScriptLabels.join(" -> ") : "No scripts selected"}</div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              onClick={() => runMutation.mutate({ orderId, selectedScripts, reprocess: forceReprocess })}
              disabled={!orderId.trim() || selectedCount === 0 || runMutation.isPending}
              className="rounded-md bg-emerald-600 px-3 py-2 text-xs text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Run Selected Scripts
            </button>
            <span className="text-xs text-muted-foreground">{selectedCount} script(s) selected</span>
            {runMutation.data?.jobId ? <span className="text-xs text-muted-foreground">Job: {runMutation.data.jobId}</span> : null}
          </div>
          <pre className="mt-3 max-h-56 min-h-[180px] overflow-auto rounded-lg border bg-zinc-950 p-3 text-[11px] text-zinc-100">
            {sqlRunLogs?.logs?.length
              ? sqlRunLogs.logs.join("\n")
              : "Live single-order run logs will appear here."}
          </pre>
          {latestResultPairs.length > 0 ? (
            <div className="mt-3 rounded-lg border bg-background p-3">
              <div className="mb-2 text-xs font-medium">Latest SQL output for the selected order</div>
              <div className="grid gap-2 md:grid-cols-2">
                {latestResultPairs.map(([key, value]) => (
                  <div key={key} className="rounded-md border px-3 py-2 text-xs">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{key}</div>
                    <div className="mt-1 break-all">{String(value)}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className="rounded-2xl border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Edit3 className="h-4 w-4" />
            Manual Update + Follow-up Processing
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Step 1: choose an order ID. Step 2: save a manual correction. Step 3: run the follow-up script sequence above if the order should be re-evaluated after the edit.
          </p>
          <div className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
            <div>Selected order: <strong className="text-foreground">{orderId || "None selected yet"}</strong></div>
            <div className="mt-1">Follow-up scripts after the edit: <strong className="text-foreground">{selectedScriptLabels.length > 0 ? selectedScriptLabels.join(" -> ") : "Select scripts in Single Order Runner"}</strong></div>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <select value={manualStatus} onChange={(event) => setManualStatus(event.target.value)} className="h-10 rounded-md border bg-background px-3 text-sm">
              <option value="Found">Found</option>
              <option value="Customer">Customer</option>
              <option value="Review">Review</option>
              <option value="NotFound">Not Found</option>
            </select>
            <input
              type="datetime-local"
              aria-label="Manual service datetime"
              value={manualDatetime}
              onChange={(event) => setManualDatetime(event.target.value)}
              className="h-10 rounded-md border bg-background px-3 text-sm"
            />
            <input
              value={manualFuneralHome}
              onChange={(event) => setManualFuneralHome(event.target.value)}
              placeholder="Funeral home / place"
              className="h-10 rounded-md border bg-background px-3 text-sm"
            />
            <input
              value={actionReason}
              onChange={(event) => setActionReason(event.target.value)}
              placeholder="Reason / audit note"
              className="h-10 rounded-md border bg-background px-3 text-sm"
            />
          </div>
          <textarea
            value={manualNotes}
            onChange={(event) => setManualNotes(event.target.value)}
            placeholder="Manual notes"
            className="mt-3 min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => manualUpdateMutation.mutate()}
              disabled={!orderId.trim() || manualUpdateMutation.isPending}
              className="rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              Save Manual Version
            </button>
            <button
              onClick={() => runMutation.mutate({ orderId, selectedScripts, reprocess: true })}
              disabled={!orderId.trim() || selectedCount === 0 || runMutation.isPending}
              className="rounded-md border bg-background px-3 py-2 text-xs hover:bg-accent disabled:opacity-50"
            >
              Save Then Re-run Selected Scripts
            </button>
            <button onClick={() => void refetchOrderTimeline()} disabled={!orderId.trim()} className="rounded-md border bg-background px-3 py-2 text-xs hover:bg-accent disabled:opacity-50">
              Refresh Timeline
            </button>
          </div>
          {manualUpdateMutation.error ? <div className="mt-2 text-xs text-destructive">{manualUpdateMutation.error.message}</div> : null}
          {orderTimeline ? (
            <div className="mt-3 grid gap-2 text-xs md:grid-cols-4">
              <div className="rounded-lg border bg-background p-2">Results: <strong>{orderTimeline.results.length}</strong></div>
              <div className="rounded-lg border bg-background p-2">Attempts: <strong>{orderTimeline.attempts.length}</strong></div>
              <div className="rounded-lg border bg-background p-2">States: <strong>{orderTimeline.processing.length}</strong></div>
              <div className="rounded-lg border bg-background p-2">Audit: <strong>{orderTimeline.audit.length}</strong></div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <div className="rounded-2xl border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <FileText className="h-4 w-4" />
            Report Center
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Reports are restricted to the SQL-backed data range. If you select a later date, the backend will clamp it to the latest available reporting date.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <input
              type="date"
              aria-label="Report date from"
              value={dateFrom}
              min={earliestAllowedDate || undefined}
              max={latestAllowedDate || undefined}
              onChange={(event) => setDateFrom(event.target.value)}
              className="h-10 rounded-md border bg-background px-3 text-sm"
            />
            <input
              type="date"
              aria-label="Report date to"
              value={dateTo}
              min={earliestAllowedDate || undefined}
              max={latestAllowedDate || undefined}
              onChange={(event) => setDateTo(event.target.value)}
              className="h-10 rounded-md border bg-background px-3 text-sm"
            />
          </div>
          <div className="mt-3 rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
            <div>Earliest available report date: <strong className="text-foreground">{earliestAllowedDate || "Unavailable"}</strong></div>
            <div className="mt-1">Latest available report date: <strong className="text-foreground">{latestAllowedDate || "Unavailable"}</strong></div>
            <div className="mt-1">Last SQL-backed update: <strong className="text-foreground">{reportMeta?.lastUpdatedAt ? formatDateTime(reportMeta.lastUpdatedAt, reportMeta.timeZone) : "Unavailable"}</strong></div>
            <div className="mt-1">Report timezone: <strong className="text-foreground">{reportMeta?.timeZoneLabel || "Unavailable"}</strong></div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={applyReportRange}
              className="rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground hover:opacity-90"
            >
              Generate Report
            </button>
            <a href="/docs/mysql_persistence_blueprint.html" target="_blank" rel="noreferrer" className="rounded-md border bg-background px-3 py-2 text-xs hover:bg-accent">
              Open SQL Blueprint
            </a>
            <a href="/docs/MYSQL_PERSISTENCE_GUIDE.md" target="_blank" rel="noreferrer" className="rounded-md border bg-background px-3 py-2 text-xs hover:bg-accent">
              Open SQL Guide
            </a>
            <a href="/docs/CLOUDWAYS_SQL_DEPLOY_CHECKLIST.md" target="_blank" rel="noreferrer" className="rounded-md border bg-background px-3 py-2 text-xs hover:bg-accent">
              Open Cloudways SQL Checklist
            </a>
          </div>
          {reportMutation.data ? (
            <div className="mt-3 space-y-3 rounded-xl border bg-background p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-foreground">Report Summary</div>
                  <div className="mt-1 text-xs text-muted-foreground">Range: {formatReportRange(reportMutation.data.dateFrom, reportMutation.data.dateTo)}</div>
                  <div className="mt-1 text-xs text-muted-foreground">Generated: {reportMutation.data.generatedAtLabel || "Unavailable"}</div>
                  <div className="mt-1 text-xs text-muted-foreground">Timezone: {reportMutation.data.timeZoneLabel || reportMutation.data.timeZone || "Unavailable"}</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs">
                    Report ID: <strong>{reportMutation.data.reportUuid}</strong>
                  </div>
                  <button onClick={downloadReportHtml} className="rounded-md border bg-background px-3 py-2 text-xs hover:bg-accent">
                    Download HTML
                  </button>
                  <button onClick={downloadReportJson} className="rounded-md border bg-background px-3 py-2 text-xs hover:bg-accent">
                    Download JSON
                  </button>
                </div>
              </div>

              <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-6">
                <div className="rounded-lg border bg-muted/20 p-3 text-xs">Total Processed<br /><strong className="text-base text-foreground">{reportMutation.data.summary.total_orders}</strong></div>
                <div className="rounded-lg border bg-muted/20 p-3 text-xs">Found<br /><strong className="text-base text-foreground">{reportMutation.data.summary.found_count}</strong></div>
                <div className="rounded-lg border bg-muted/20 p-3 text-xs">Customer<br /><strong className="text-base text-foreground">{reportMutation.data.summary.customer_count}</strong></div>
                <div className="rounded-lg border bg-muted/20 p-3 text-xs">Review<br /><strong className="text-base text-foreground">{reportMutation.data.summary.review_count}</strong></div>
                <div className="rounded-lg border bg-muted/20 p-3 text-xs">Not Found<br /><strong className="text-base text-foreground">{reportMutation.data.summary.not_found_count}</strong></div>
                <div className="rounded-lg border bg-muted/20 p-3 text-xs">Failed<br /><strong className="text-base text-foreground">{reportMutation.data.summary.failed_count}</strong></div>
              </div>

              <div>
                <div className="mb-2 text-xs font-medium text-foreground">Day-wise Breakdown</div>
                <div className="overflow-auto rounded-lg border">
                  <table className="min-w-full text-left text-xs">
                    <thead className="bg-muted/40 text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-medium">Date</th>
                        <th className="px-3 py-2 font-medium">Total</th>
                        <th className="px-3 py-2 font-medium">Found</th>
                        <th className="px-3 py-2 font-medium">Customer</th>
                        <th className="px-3 py-2 font-medium">Review</th>
                        <th className="px-3 py-2 font-medium">Not Found</th>
                        <th className="px-3 py-2 font-medium">Failed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reportMutation.data.byDate.length > 0 ? reportMutation.data.byDate.map((row) => (
                        <tr key={row.report_date} className="border-t">
                          <td className="px-3 py-2">{row.report_date}</td>
                          <td className="px-3 py-2">{row.total_processed}</td>
                          <td className="px-3 py-2">{row.found_count}</td>
                          <td className="px-3 py-2">{row.customer_count}</td>
                          <td className="px-3 py-2">{row.review_count}</td>
                          <td className="px-3 py-2">{row.not_found_count}</td>
                          <td className="px-3 py-2">{row.failed_count}</td>
                        </tr>
                      )) : (
                        <tr>
                          <td colSpan={7} className="px-3 py-4 text-center text-muted-foreground">No processed rows were found in the selected date range.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <div className="rounded-2xl border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Trash2 className="h-4 w-4" />
            Scoped Delete / Reset By Order ID
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Use this only when you need to delete specific SQL scopes for one order while keeping an audit trail.
          </p>
          <div className="grid gap-2 md:grid-cols-2">
            {DELETE_SCOPES.map((scope) => (
              <label key={scope.id} className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-xs">
                <input
                  type="checkbox"
                  checked={deleteScopes.includes(scope.id)}
                  onChange={() => toggleDeleteScope(scope.id)}
                />
                {scope.label}
              </label>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => scopedDeleteMutation.mutate()}
              disabled={!orderId.trim() || deleteScopes.length === 0 || scopedDeleteMutation.isPending}
              className="rounded-md bg-destructive px-3 py-2 text-xs text-destructive-foreground hover:opacity-90 disabled:opacity-50"
            >
              Delete Selected Scopes
            </button>
            <span className="text-xs text-muted-foreground">{deleteScopes.length} scope(s) selected</span>
            {scopedDeleteMutation.error ? <span className="text-xs text-destructive">{scopedDeleteMutation.error.message}</span> : null}
          </div>
          <div className="mt-3 rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
            Tip: reset only the scopes you actually need, then use Single Order Runner to rebuild the order state in sequence.
          </div>
          <div className="mt-4 rounded-lg border bg-background p-3 text-xs text-muted-foreground">
            Primary table browsing has moved to the main <strong className="text-foreground">Data Viewer</strong> so this panel can stay focused on control actions.
          </div>
        </div>
      </div>
    </section>
  );
}
