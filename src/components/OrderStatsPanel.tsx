import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  CalendarDays,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  TrendingUp,
  Cpu,
  Filter,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

function ProgressBar({
  value,
  max,
  color,
  label,
}: {
  value: number;
  max: number;
  color: string;
  label: string;
}) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {value} ({pct.toFixed(1)}%)
        </span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function OrderStatsPanel() {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showDateFilter, setShowDateFilter] = useState(false);
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  const [showAllDates, setShowAllDates] = useState(false);

  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: ["order-processing-stats"],
    queryFn: api.orderProcessingStats,
    refetchInterval: 10_000,
  });

  const { data: dateData } = useQuery({
    queryKey: ["order-processing-by-date", dateFrom, dateTo],
    queryFn: () => api.orderProcessingByDate(dateFrom || undefined, dateTo || undefined),
    refetchInterval: 30_000,
  });

  const { data: modelPerf } = useQuery({
    queryKey: ["model-performance"],
    queryFn: api.modelPerformance,
    refetchInterval: 15_000,
  });

  const summary = statsData?.summary;
  const byDate = dateData?.days ?? statsData?.byDate ?? [];
  const byModel = statsData?.byModel ?? [];
  const models = modelPerf?.models ?? [];
  const activeModel = modelPerf?.activeModel || summary?.activeModel || "n/a";

  const visibleDates = showAllDates ? byDate : byDate.slice(0, 7);

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Order Processing Analytics
      </h2>

      {/* Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card className="border-emerald-500/20">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4" /> Total Processed
            </CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {statsLoading ? "—" : summary?.total ?? 0}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="border-green-500/20">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" /> Found
            </CardDescription>
            <CardTitle className="text-2xl tabular-nums text-emerald-600 dark:text-emerald-400">
              {summary?.found ?? 0}
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {summary?.foundPct ?? 0}%
              </span>
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="border-red-500/20">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2 text-red-500">
              <XCircle className="h-4 w-4" /> Not Found
            </CardDescription>
            <CardTitle className="text-2xl tabular-nums text-red-500">
              {summary?.notfound ?? 0}
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {summary?.notfoundPct ?? 0}%
              </span>
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="border-amber-500/20">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2 text-amber-500">
              <AlertTriangle className="h-4 w-4" /> Review
            </CardDescription>
            <CardTitle className="text-2xl tabular-nums text-amber-500">
              {summary?.review ?? 0}
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {summary?.reviewPct ?? 0}%
              </span>
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="border-blue-500/20">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2 text-blue-500">
              <Cpu className="h-4 w-4" /> Active Model
            </CardDescription>
            <CardTitle className="text-base">{activeModel}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Overall progress bars */}
      {summary && summary.total > 0 && (
        <Card className="mt-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4" /> Overall Processing Breakdown
            </CardTitle>
            <CardDescription>
              Real-time distribution of {summary.total} processed orders
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ProgressBar
              value={summary.found}
              max={summary.total}
              color="bg-gradient-to-r from-emerald-500 to-emerald-400"
              label="✅ Found"
            />
            <ProgressBar
              value={summary.notfound}
              max={summary.total}
              color="bg-gradient-to-r from-red-500 to-red-400"
              label="❌ Not Found"
            />
            <ProgressBar
              value={summary.review}
              max={summary.total}
              color="bg-gradient-to-r from-amber-500 to-amber-400"
              label="⚠️ Review"
            />
            {summary.unknown > 0 && (
              <ProgressBar
                value={summary.unknown}
                max={summary.total}
                color="bg-gradient-to-r from-zinc-500 to-zinc-400"
                label="❓ Unknown"
              />
            )}
          </CardContent>
        </Card>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* Date-wise breakdown */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <CalendarDays className="h-4 w-4" /> Daily Breakdown
                </CardTitle>
                <CardDescription>Orders processed per day with status distribution</CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setShowDateFilter(!showDateFilter)}
              >
                <Filter className="h-3 w-3" />
                Filter
              </Button>
            </div>

            {showDateFilter && (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border bg-background p-3 animate-in fade-in">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    From
                  </label>
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className="h-8 rounded-md border bg-background px-2 text-xs text-foreground"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    To
                  </label>
                  <input
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className="h-8 rounded-md border bg-background px-2 text-xs text-foreground"
                  />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-4 text-xs"
                  onClick={() => {
                    setDateFrom("");
                    setDateTo("");
                  }}
                >
                  Clear
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent className="space-y-2">
            {visibleDates.length === 0 && (
              <p className="text-xs text-muted-foreground">No date-wise data available yet.</p>
            )}
            {visibleDates.map((day) => (
              <div key={day.date} className="rounded-lg border bg-background px-3 py-2.5">
                <div className="flex items-center justify-between text-xs font-medium">
                  <span className="flex items-center gap-2">
                    <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
                    {day.date}
                  </span>
                  <Badge variant="outline" className="text-[10px]">
                    {day.total} orders
                  </Badge>
                </div>
                {day.total > 0 && (
                  <div className="mt-2 flex gap-1">
                    {day.found > 0 && (
                      <div
                        className="h-2 rounded-full bg-emerald-500 transition-all duration-500"
                        style={{ width: `${(day.found / day.total) * 100}%` }}
                        title={`Found: ${day.found}`}
                      />
                    )}
                    {day.notfound > 0 && (
                      <div
                        className="h-2 rounded-full bg-red-500 transition-all duration-500"
                        style={{ width: `${(day.notfound / day.total) * 100}%` }}
                        title={`Not Found: ${day.notfound}`}
                      />
                    )}
                    {day.review > 0 && (
                      <div
                        className="h-2 rounded-full bg-amber-500 transition-all duration-500"
                        style={{ width: `${(day.review / day.total) * 100}%` }}
                        title={`Review: ${day.review}`}
                      />
                    )}
                  </div>
                )}
                <div className="mt-1.5 flex gap-3 text-[10px] text-muted-foreground">
                  <span className="text-emerald-500">✅ {day.found}</span>
                  <span className="text-red-500">❌ {day.notfound}</span>
                  <span className="text-amber-500">⚠️ {day.review}</span>
                </div>
              </div>
            ))}
            {byDate.length > 7 && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full gap-1 text-xs"
                onClick={() => setShowAllDates(!showAllDates)}
              >
                {showAllDates ? (
                  <>
                    <ChevronUp className="h-3 w-3" /> Show Less
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-3 w-3" /> Show All {byDate.length} Days
                  </>
                )}
              </Button>
            )}
          </CardContent>
        </Card>

        {/* Model Performance */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Cpu className="h-4 w-4" /> Model Performance
            </CardTitle>
            <CardDescription>
              How each AI model is performing — switch models to see varied data
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {models.length === 0 && byModel.length === 0 && (
              <p className="text-xs text-muted-foreground">No model run data available yet.</p>
            )}

            {/* Model runs from model_runs table */}
            {models.map((m) => {
              const isActive = m.model === activeModel;
              const isExpanded = expandedModel === m.model;
              return (
                <div
                  key={m.model}
                  className={`rounded-lg border px-3 py-2.5 transition-colors ${
                    isActive ? "border-blue-500/30 bg-blue-500/5" : "bg-background"
                  }`}
                >
                  <button
                    className="flex w-full items-center justify-between text-xs font-medium"
                    onClick={() => setExpandedModel(isExpanded ? null : m.model)}
                  >
                    <span className="flex items-center gap-2">
                      <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                      {m.model}
                      {isActive && (
                        <Badge className="bg-blue-500/15 text-blue-600 dark:text-blue-400 text-[9px] px-1.5">
                          ACTIVE
                        </Badge>
                      )}
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        {m.totalRuns} runs
                      </Badge>
                      {isExpanded ? (
                        <ChevronUp className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" />
                      )}
                    </span>
                  </button>

                  {isExpanded && (
                    <div className="mt-2 space-y-2 animate-in fade-in slide-in-from-top-1">
                      <div className="grid grid-cols-4 gap-2 text-[10px]">
                        <div className="rounded border bg-emerald-500/10 p-1.5 text-center">
                          <div className="font-semibold text-emerald-600 dark:text-emerald-400">
                            {m.success}
                          </div>
                          <div className="text-muted-foreground">Success</div>
                        </div>
                        <div className="rounded border bg-red-500/10 p-1.5 text-center">
                          <div className="font-semibold text-red-500">{m.failed}</div>
                          <div className="text-muted-foreground">Failed</div>
                        </div>
                        <div className="rounded border bg-zinc-500/10 p-1.5 text-center">
                          <div className="font-semibold">{m.cancelled}</div>
                          <div className="text-muted-foreground">Cancelled</div>
                        </div>
                        <div className="rounded border bg-blue-500/10 p-1.5 text-center">
                          <div className="font-semibold text-blue-500">{m.running}</div>
                          <div className="text-muted-foreground">Running</div>
                        </div>
                      </div>
                      <div className="space-y-1">
                        <div className="flex justify-between text-[10px]">
                          <span className="text-muted-foreground">Success Rate</span>
                          <span className="font-medium">{m.successRate}%</span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-500"
                            style={{ width: `${m.successRate}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Order-level model stats (from funeral data CSV) */}
            {byModel.length > 0 && (
              <div className="mt-3 border-t pt-3">
                <p className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Order Processing by Model
                </p>
                {byModel.map((m) => (
                  <div
                    key={m.model}
                    className="mb-2 rounded-md border bg-background px-3 py-2 text-xs"
                  >
                    <div className="flex items-center justify-between font-medium">
                      <span>{m.model}</span>
                      <span>{m.total} runs</span>
                    </div>
                    <div className="mt-1 flex gap-3 text-[10px] text-muted-foreground">
                      <span className="text-emerald-500">✅ {m.success} success</span>
                      <span className="text-red-500">❌ {m.failed} failed</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
