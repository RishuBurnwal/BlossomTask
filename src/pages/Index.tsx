import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DashboardHeader } from "@/components/DashboardHeader";
import { ScriptPanel } from "@/components/ScriptPanel";
import { CompareSection } from "@/components/CompareSection";
import { DataViewer } from "@/components/DataViewer";
import { api } from "@/lib/api";
import type { Job } from "@/lib/types";

const Index = () => {
  const [cronMode] = useState<"default" | "custom">("default");
  const { data: scriptsData } = useQuery({
    queryKey: ["scripts"],
    queryFn: api.scripts,
    refetchInterval: 15000,
  });

  const { data: jobsData } = useQuery({
    queryKey: ["jobs"],
    queryFn: api.jobs,
    refetchInterval: 2000,
  });

  const scripts = scriptsData?.scripts ?? [];
  const jobs = jobsData?.jobs ?? [];

  const latestScriptJobById = jobs.reduce<Record<string, Job>>((acc, job) => {
    if (job.kind !== "script" || !job.scriptId) {
      return acc;
    }
    if (!acc[job.scriptId]) {
      acc[job.scriptId] = job;
    }
    return acc;
  }, {});

  return (
    <div className="min-h-screen bg-background">
      <DashboardHeader />

      <main className="mx-auto max-w-7xl px-4 py-6 lg:px-6 space-y-6">
        {/* Script Panels */}
        <section className="scroll-mt-4">
          <h2 className="mb-3 text-sm font-semibold text-muted-foreground uppercase tracking-wider">Script Panels</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {scripts.map((s) => (
              <ScriptPanel
                key={s.id}
                script={s}
                cronMode={cronMode}
                liveJob={latestScriptJobById[s.id]}
              />
            ))}
          </div>
        </section>

        {/* Compare Section */}
        <section>
          <h2 className="mb-3 text-sm font-semibold text-muted-foreground uppercase tracking-wider">Data Comparison</h2>
          <CompareSection />
        </section>

        {/* Data Viewer */}
        <section>
          <h2 className="mb-3 text-sm font-semibold text-muted-foreground uppercase tracking-wider">Data Viewer</h2>
          <DataViewer />
        </section>
      </main>
    </div>
  );
};

export default Index;
