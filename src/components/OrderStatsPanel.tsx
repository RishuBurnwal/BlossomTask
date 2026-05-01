import { type ReactNode, useState } from "react";
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
import { api } from "@/lib/api";

type SummaryCardProps = {
  label: string;
  value: number;
  percent?: number;
  tone: string;
  icon: ReactNode;
};

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
          {typeof percent === "number" ? (
            <span className="ml-2 text-sm font-normal text-muted-foreground">{percent}%</span>
          ) : null}
        </CardTitle>
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
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span>{label}</span>
        <span className="text-muted-foreground">{value}</span>
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

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Daily Breakdown</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Live order status totals now come from the freshest output files, including customer-defined matches.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <SummaryCard label="Total" value={statsLoading ? 0 : summary?.total ?? 0} icon={<BarChart3 className="h-4 w-4" />} tone="text-foreground" />
        <SummaryCard label="Customer" value={summary?.customer ?? 0} percent={summary?.customerPct ?? 0} icon={<UserRound className="h-4 w-4" />} tone="text-sky-600 dark:text-sky-400" />
        <SummaryCard label="Found" value={summary?.found ?? 0} percent={summary?.foundPct ?? 0} icon={<CheckCircle2 className="h-4 w-4" />} tone="text-emerald-600 dark:text-emerald-400" />
        <SummaryCard label="Not Found" value={summary?.notfound ?? 0} percent={summary?.notfoundPct ?? 0} icon={<XCircle className="h-4 w-4" />} tone="text-rose-600 dark:text-rose-400" />
        <SummaryCard label="Review" value={summary?.review ?? 0} percent={summary?.reviewPct ?? 0} icon={<AlertTriangle className="h-4 w-4" />} tone="text-amber-600 dark:text-amber-400" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.3fr_0.7fr]">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <CalendarDays className="h-4 w-4" />
                  Daily Status Breakdown
                </CardTitle>
                <CardDescription>See which day produced customer, found, review, and not found records.</CardDescription>
              </div>
              <Button variant="outline" size="sm" className="gap-2" onClick={() => setShowDateFilter((current) => !current)}>
                <Filter className="h-3.5 w-3.5" />
                Filter
              </Button>
            </div>

            {showDateFilter ? (
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
            {visibleDates.length === 0 ? <p className="text-sm text-muted-foreground">No daily data available yet.</p> : null}
            {visibleDates.map((day) => (
              <div key={day.date} className="rounded-xl border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">{day.date}</div>
                  <Badge variant="outline">{day.total} rows</Badge>
                </div>
                <div className="mt-3 grid gap-2 md:grid-cols-2">
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
