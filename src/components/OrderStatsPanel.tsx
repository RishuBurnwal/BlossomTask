import { type ReactNode, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  Filter,
  SearchCheck,
  UserRound,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";

type SummaryCardProps = {
  label: string;
  value: number;
  percent?: number;
  tone: string;
  icon: ReactNode;
};

type BreakdownMode = "daily" | "overall";

function formatPercent(value: number, total: number) {
  if (!total) return 0;
  return Number(((value / total) * 100).toFixed(1));
}

function SummaryCard({ label, value, percent, tone, icon }: SummaryCardProps) {
  return (
    <Card className="border-border/70">
      <CardHeader className="space-y-1 pb-2">
        <CardDescription className={`flex items-center gap-2 ${tone}`}>
          {icon}
          {label}
        </CardDescription>
        <CardTitle className={`text-3xl tabular-nums ${tone}`}>
          {value}
        </CardTitle>
        {typeof percent === "number" ? (
          <div className="text-xs text-muted-foreground">{percent}% of total</div>
        ) : null}
      </CardHeader>
    </Card>
  );
}

function ProgressRow({
  label,
  value,
  total,
  className,
}: {
  label: string;
  value: number;
  total: number;
  className: string;
}) {
  const width = total > 0 ? Math.min((value / total) * 100, 100) : 0;
  const percent = formatPercent(value, total);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-right text-muted-foreground">
          {value} / {total} | {percent}%
        </span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-secondary">
        <div className={`h-full rounded-full ${className}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

export function OrderStatsPanel() {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showDateFilter, setShowDateFilter] = useState(false);
  const [showAllDates, setShowAllDates] = useState(false);
  const [breakdownMode, setBreakdownMode] = useState<BreakdownMode>("daily");

  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: ["order-processing-stats"],
    queryFn: api.orderProcessingStats,
    refetchInterval: 10_000,
  });

  const { data: dateData } = useQuery({
    queryKey: ["order-processing-by-date", dateFrom, dateTo],
    queryFn: () => api.orderProcessingByDate(dateFrom || undefined, dateTo || undefined),
    refetchInterval: 15_000,
  });

  const { data: modelPerf } = useQuery({
    queryKey: ["model-performance"],
    queryFn: api.modelPerformance,
    refetchInterval: 20_000,
  });

  const summary = statsData?.summary;
  const reconciliation = statsData?.reconciliation;
  const byDate = dateData?.days ?? statsData?.byDate ?? [];
  const visibleDates = showAllDates ? byDate : byDate.slice(0, 7);
  const models = modelPerf?.models ?? [];
  const latestDay = byDate[0] || null;
  const topSummary = breakdownMode === "daily" && latestDay
    ? {
        total: latestDay.total,
        customer: latestDay.customer,
        found: latestDay.found,
        notfound: latestDay.notfound,
        review: latestDay.review,
        customerPct: latestDay.customerPct ?? formatPercent(latestDay.customer, latestDay.total),
        foundPct: latestDay.foundPct ?? formatPercent(latestDay.found, latestDay.total),
        notfoundPct: latestDay.notfoundPct ?? formatPercent(latestDay.notfound, latestDay.total),
        reviewPct: latestDay.reviewPct ?? formatPercent(latestDay.review, latestDay.total),
      }
    : summary;

  const overallSummaryItems = useMemo(() => {
    const total = summary?.total ?? 0;
    const matched = reconciliation?.matchedToStatusFiles ?? 0;
    const statusTotal = reconciliation?.statusFileTotal ?? 0;
    return [
      { label: "Main rows", value: reconciliation?.mainRows ?? total },
      { label: "Status-file total", value: statusTotal },
      { label: "Matched records", value: matched },
      { label: "Coverage", value: total > 0 ? `${formatPercent(matched, total)}%` : "0%" },
      { label: "Visible days", value: byDate.length },
      { label: "Customer file rows", value: reconciliation?.customerFileRows ?? 0 },
    ];
  }, [byDate.length, reconciliation, summary?.total]);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {breakdownMode === "daily" ? "Daily Breakdown" : "Overall Breakdown"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {breakdownMode === "daily" && latestDay
              ? `Showing freshest daily totals for ${latestDay.date}.`
              : "Live order status totals now come from the freshest output files, including customer-defined matches."}
          </p>
        </div>
        <Select value={breakdownMode} onValueChange={(value) => setBreakdownMode(value as BreakdownMode)}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Breakdown" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="daily">Daily</SelectItem>
            <SelectItem value="overall">Overall</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <SummaryCard label="Total" value={statsLoading ? 0 : topSummary?.total ?? 0} icon={<BarChart3 className="h-4 w-4" />} tone="text-foreground" />
        <SummaryCard label="Customer" value={topSummary?.customer ?? 0} percent={topSummary?.customerPct ?? 0} icon={<UserRound className="h-4 w-4" />} tone="text-sky-600 dark:text-sky-400" />
        <SummaryCard label="Found" value={topSummary?.found ?? 0} percent={topSummary?.foundPct ?? 0} icon={<CheckCircle2 className="h-4 w-4" />} tone="text-emerald-600 dark:text-emerald-400" />
        <SummaryCard label="Not Found" value={topSummary?.notfound ?? 0} percent={topSummary?.notfoundPct ?? 0} icon={<XCircle className="h-4 w-4" />} tone="text-rose-600 dark:text-rose-400" />
        <SummaryCard label="Review" value={topSummary?.review ?? 0} percent={topSummary?.reviewPct ?? 0} icon={<AlertTriangle className="h-4 w-4" />} tone="text-amber-600 dark:text-amber-400" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.3fr_0.7fr]">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <CalendarDays className="h-4 w-4" />
                  {breakdownMode === "daily" ? "Daily Status Breakdown" : "Overall Run Summary"}
                </CardTitle>
                <CardDescription>
                  {breakdownMode === "daily"
                    ? "See which day produced customer, found, review, and not found records."
                    : "See the combined status mix and file-level totals across the full dataset."}
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={breakdownMode} onValueChange={(value) => setBreakdownMode(value as BreakdownMode)}>
                  <SelectTrigger className="w-[140px]">
                    <SelectValue placeholder="View mode" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="overall">Overall</SelectItem>
                  </SelectContent>
                </Select>
                {breakdownMode === "daily" ? (
                  <Button variant="outline" size="sm" className="gap-2" onClick={() => setShowDateFilter((current) => !current)}>
                    <Filter className="h-3.5 w-3.5" />
                    Filter
                  </Button>
                ) : null}
              </div>
            </div>

            {breakdownMode === "daily" && showDateFilter ? (
              <div className="mt-4 flex flex-wrap gap-2 rounded-lg border bg-background p-3">
                <InputBlock label="From" value={dateFrom} onChange={setDateFrom} />
                <InputBlock label="To" value={dateTo} onChange={setDateTo} />
                <Button variant="ghost" size="sm" className="mt-auto" onClick={() => { setDateFrom(""); setDateTo(""); }}>
                  Clear
                </Button>
              </div>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-3">
            {breakdownMode === "overall" ? (
              <>
                <div className="rounded-xl border p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium">Overall status mix</div>
                    <Badge variant="outline">{summary?.total ?? 0} total rows</Badge>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <ProgressRow label="Customer" value={summary?.customer ?? 0} total={summary?.total ?? 0} className="bg-sky-500" />
                    <ProgressRow label="Found" value={summary?.found ?? 0} total={summary?.total ?? 0} className="bg-emerald-500" />
                    <ProgressRow label="Not Found" value={summary?.notfound ?? 0} total={summary?.total ?? 0} className="bg-rose-500" />
                    <ProgressRow label="Review" value={summary?.review ?? 0} total={summary?.total ?? 0} className="bg-amber-500" />
                  </div>
                </div>

                <div className="rounded-xl border p-4">
                  <div className="mb-3 font-medium">Overall run summary</div>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {overallSummaryItems.map((item) => (
                      <div key={item.label} className="rounded-lg border bg-background px-3 py-2">
                        <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">{item.label}</div>
                        <div className="mt-1 text-base font-semibold tabular-nums">{item.value}</div>
                      </div>
                    ))}
                  </div>
                  {reconciliation ? (
                    <div className="mt-3 rounded-lg border bg-background p-3 text-xs text-muted-foreground">
                      Main {reconciliation.mainRows} | customer {reconciliation.customerFileRows ?? 0} | found {reconciliation.foundFileRows} | not found {reconciliation.notFoundFileRows} | review {reconciliation.reviewFileRows}
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}

            {breakdownMode === "daily" ? (
              <>
                {visibleDates.length === 0 ? <p className="text-sm text-muted-foreground">No daily data available yet.</p> : null}
                {visibleDates.map((day) => (
                  <div key={day.date} className="rounded-xl border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium">{day.date}</div>
                      <Badge variant="outline">{day.total} rows</Badge>
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <ProgressRow label="Customer" value={day.customer} total={day.total} className="bg-sky-500" />
                      <ProgressRow label="Found" value={day.found} total={day.total} className="bg-emerald-500" />
                      <ProgressRow label="Not Found" value={day.notfound} total={day.total} className="bg-rose-500" />
                      <ProgressRow label="Review" value={day.review} total={day.total} className="bg-amber-500" />
                    </div>
                  </div>
                ))}
                {byDate.length > 7 ? (
                  <Button variant="ghost" size="sm" className="w-full" onClick={() => setShowAllDates((current) => !current)}>
                    {showAllDates ? "Show Less" : `Show All ${byDate.length} Days`}
                  </Button>
                ) : null}
              </>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <SearchCheck className="h-4 w-4" />
              Live Validation
            </CardTitle>
            <CardDescription>Cross-check the main dataset against category files.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ProgressRow label="Customer" value={summary?.customer ?? 0} total={summary?.total ?? 0} className="bg-sky-500" />
            <ProgressRow label="Found" value={summary?.found ?? 0} total={summary?.total ?? 0} className="bg-emerald-500" />
            <ProgressRow label="Not Found" value={summary?.notfound ?? 0} total={summary?.total ?? 0} className="bg-rose-500" />
            <ProgressRow label="Review" value={summary?.review ?? 0} total={summary?.total ?? 0} className="bg-amber-500" />
            {summary?.unknown ? <ProgressRow label="Unknown" value={summary.unknown} total={summary.total} className="bg-zinc-500" /> : null}
            {reconciliation ? (
              <div className="rounded-lg border bg-background p-3 text-xs text-muted-foreground">
                Main {reconciliation.mainRows} | customer {reconciliation.customerFileRows ?? 0} | found {reconciliation.foundFileRows} | not found {reconciliation.notFoundFileRows} | review {reconciliation.reviewFileRows}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Model Performance</CardTitle>
          <CardDescription>Run-level model history stays available without duplicating the active model in the top summary.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {models.length === 0 ? <p className="text-sm text-muted-foreground">No model run data available yet.</p> : null}
          {models.map((model) => (
            <div key={model.model} className="rounded-xl border p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium">{model.model}</div>
                <Badge variant="outline">{model.totalRuns} runs</Badge>
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                Success {model.success} | Failed {model.failed} | Running {model.running}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">Success rate {model.successRate}%</div>
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}

function InputBlock({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">{label}</div>
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-md border bg-background px-3 text-sm"
      />
    </div>
  );
}
