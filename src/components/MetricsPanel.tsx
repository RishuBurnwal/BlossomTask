import { useQuery } from "@tanstack/react-query";
import { BarChart3, CalendarDays, Clock3, ListChecks, TimerReset } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";

export function MetricsPanel() {
  const { data } = useQuery({
    queryKey: ["metrics"],
    queryFn: api.metrics,
    refetchInterval: 15_000,
  });

  const summary = data?.summary;
  const byDay = data?.byDay ?? [];
  const byHour = data?.byHour ?? [];
  const byModel = data?.byModel ?? [];
  const byScript = data?.byScript ?? [];

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Execution Metrics</h2>
      <div className="grid gap-4 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2"><BarChart3 className="h-4 w-4" /> Jobs</CardDescription>
            <CardTitle className="text-2xl">{summary?.totalJobs ?? 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2"><TimerReset className="h-4 w-4" /> Session Window</CardDescription>
            <CardTitle className="text-base">{summary?.sessionTtlMinutes ?? 0} min</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2"><CalendarDays className="h-4 w-4" /> Latest Day</CardDescription>
            <CardTitle className="text-base">{byDay[0]?.day ?? "n/a"}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2"><ListChecks className="h-4 w-4" /> Top Script</CardDescription>
            <CardTitle className="text-base">{byScript[0]?.scriptId ?? "n/a"}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">By Model</CardTitle>
            <CardDescription>Success rate and average runtime per model.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {byModel.map((item) => (
              <div key={item.model} className="rounded-md border px-3 py-2 text-xs">
                <div className="flex items-center justify-between font-medium">
                  <span>{item.model}</span>
                  <span>{item.total}</span>
                </div>
                <div className="mt-1 text-muted-foreground">
                  success {item.success} · failed {item.failed} · cancelled {item.cancelled}
                </div>
                <div className="mt-1 text-muted-foreground">
                  success rate {item.successRate}% · avg {item.averageDurationSec}s
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">By Day</CardTitle>
            <CardDescription>Recent volume, grouped by run date.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {byDay.slice(0, 5).map((item) => (
              <div key={item.day} className="rounded-md border px-3 py-2 text-xs">
                <div className="flex items-center justify-between font-medium">
                  <span>{item.day}</span>
                  <span>{item.total}</span>
                </div>
                <div className="mt-1 text-muted-foreground">
                  success {item.success} · failed {item.failed} · running {item.running}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">By Hour</CardTitle>
            <CardDescription>Execution counts by date and hour.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {byHour.slice(0, 8).map((item) => (
              <div key={item.hour} className="rounded-md border px-3 py-2 text-xs">
                <div className="flex items-center justify-between font-medium">
                  <span className="flex items-center gap-2"><Clock3 className="h-3.5 w-3.5" /> {item.hour}</span>
                  <span>{item.total}</span>
                </div>
                <div className="mt-1 text-muted-foreground">
                  success {item.success} · failed {item.failed} · running {item.running}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">By Script</CardTitle>
            <CardDescription>Performance and throughput per script.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {byScript.map((item) => (
              <div key={item.scriptId} className="rounded-md border px-3 py-2 text-xs">
                <div className="flex items-center justify-between font-medium">
                  <span>{item.scriptId}</span>
                  <span>{item.total}</span>
                </div>
                <div className="mt-1 text-muted-foreground">
                  success rate {item.successRate}% · avg {item.averageDurationSec}s
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
