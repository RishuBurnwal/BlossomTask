import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, ChevronLeft, ChevronRight, FileSpreadsheet, FolderOpen } from "lucide-react";
import { api } from "@/lib/api";
import type { DataRow } from "@/lib/types";

type FileTab = "main" | "found" | "customer" | "not_found" | "review" | "all";
type ViewMode = "table" | "json" | "raw" | "terminal";

type SummaryLike = {
  total: number;
  customer: number;
  found: number;
  notfound: number;
  review: number;
  unknown: number;
  last_processed_at: string | null;
};

function buildSummaryLabel(summary?: SummaryLike) {
  if (!summary) {
    return "0 rows";
  }
  return `${summary.total} rows | customer ${summary.customer} | found ${summary.found} | review ${summary.review} | not found ${summary.notfound}`;
}

export function DataViewer() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<FileTab>("all");
  const [activePath, setActivePath] = useState("");
  const [selectedFile, setSelectedFile] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [searchQuery, setSearchQuery] = useState("");
  const [liveRefresh, setLiveRefresh] = useState(true);
  const [terminalSource, setTerminalSource] = useState<"file" | "runtime">("file");
  const [selectedRuntimeJobId, setSelectedRuntimeJobId] = useState("");
  const [hasInitializedSelection, setHasInitializedSelection] = useState(false);
  const previousRuntimeStatusesRef = useRef<Record<string, string>>({});

  const { data: datasetsData } = useQuery({
    queryKey: ["datasets"],
    queryFn: api.datasets,
    refetchInterval: 20_000,
  });

  const { data: treeData } = useQuery({
    queryKey: ["files-tree", activePath],
    queryFn: () => api.fileTree(activePath),
    refetchInterval: 5_000,
  });

  const { data: recursiveTreeData } = useQuery({
    queryKey: ["files-tree", "recursive-picker"],
    queryFn: () => api.fileTree("", true),
    refetchInterval: 5_000,
  });

  const { data: selectedFileData, isFetching: isSelectedFileFetching, error: selectedFileError } = useQuery({
    queryKey: ["file-content", selectedFile],
    queryFn: () => api.fileContent(selectedFile, 0),
    enabled: activeTab === "all" && Boolean(selectedFile),
    refetchInterval: activeTab === "all" && liveRefresh ? 2_000 : false,
  });

  const { data: jobsData } = useQuery({
    queryKey: ["jobs", "terminal"],
    queryFn: api.jobs,
    refetchInterval: viewMode === "terminal" && terminalSource === "runtime" ? 2_000 : 10_000,
  });

  const { data: runtimeJobData } = useQuery({
    queryKey: ["job", selectedRuntimeJobId, "terminal"],
    queryFn: () => api.job(selectedRuntimeJobId),
    enabled: viewMode === "terminal" && terminalSource === "runtime" && Boolean(selectedRuntimeJobId),
    refetchInterval: 1_500,
  });

  const entries = treeData?.entries ?? [];
  const directories = entries.filter((entry) => entry.type === "directory");
  const files = entries.filter((entry) => entry.type === "file");
  const quickFiles = (recursiveTreeData?.entries ?? []).filter((entry) => entry.type === "file");
  const jobs = jobsData?.jobs ?? [];
  const runtimeJobs = jobs.filter((job) => job.kind === "script" || job.kind === "pipeline");
  const datasets = datasetsData?.datasets;

  useEffect(() => {
    if (activeTab !== "all") {
      return;
    }
    if (selectedFile && quickFiles.some((entry) => entry.path === selectedFile)) {
      return;
    }
    if (files[0]?.path) {
      setSelectedFile(files[0].path);
      return;
    }
    if (quickFiles[0]?.path) {
      setSelectedFile(quickFiles[0].path);
    }
  }, [activeTab, files, quickFiles, selectedFile]);

  useEffect(() => {
    if (activeTab !== "all" || hasInitializedSelection || selectedFile || !quickFiles.length) {
      return;
    }
    const firstPath = quickFiles[0].path;
    setSelectedFile(firstPath);
    const chunks = firstPath.split("/");
    chunks.pop();
    setActivePath(chunks.join("/"));
    setHasInitializedSelection(true);
  }, [activeTab, hasInitializedSelection, quickFiles, selectedFile]);

  useEffect(() => {
    if (!runtimeJobs.length) {
      setSelectedRuntimeJobId("");
      return;
    }
    if (selectedRuntimeJobId && runtimeJobs.some((job) => job.id === selectedRuntimeJobId)) {
      return;
    }
    setSelectedRuntimeJobId(runtimeJobs[0].id);
  }, [runtimeJobs, selectedRuntimeJobId]);

  useEffect(() => {
    const previousById = previousRuntimeStatusesRef.current;
    const runningStates = new Set(["running", "pending", "queued", "processing", "in_progress"]);
    const completeStates = new Set(["success", "failed", "cancelled", "canceled", "completed", "error"]);
    let shouldRefresh = false;

    runtimeJobs.forEach((job) => {
      const nextStatus = String(job.status || "").toLowerCase();
      const previousStatus = String(previousById[job.id] || "").toLowerCase();
      if (previousStatus && previousStatus !== nextStatus && runningStates.has(previousStatus) && completeStates.has(nextStatus)) {
        shouldRefresh = true;
      }
      previousById[job.id] = nextStatus;
    });

    Object.keys(previousById).forEach((jobId) => {
      if (!runtimeJobs.some((job) => job.id === jobId)) {
        delete previousById[jobId];
      }
    });

    if (shouldRefresh) {
      void refreshNow();
    }
  }, [runtimeJobs]);

  useEffect(() => {
    const savedMode = window.localStorage.getItem("data-viewer-mode");
    if (savedMode === "table" || savedMode === "json" || savedMode === "raw" || savedMode === "terminal") {
      setViewMode(savedMode);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("data-viewer-mode", viewMode);
  }, [viewMode]);

  const refreshNow = useCallback(async () => {
    const tasks: Promise<unknown>[] = [
      queryClient.invalidateQueries({ queryKey: ["datasets"], refetchType: "active" }),
      queryClient.invalidateQueries({ queryKey: ["files-tree", activePath], refetchType: "active" }),
      queryClient.invalidateQueries({ queryKey: ["files-tree", "recursive-picker"], refetchType: "active" }),
      queryClient.invalidateQueries({ queryKey: ["jobs", "terminal"], refetchType: "active" }),
    ];
    if (selectedFile) {
      tasks.push(queryClient.invalidateQueries({ queryKey: ["file-content", selectedFile], refetchType: "active" }));
    }
    if (selectedRuntimeJobId) {
      tasks.push(queryClient.invalidateQueries({ queryKey: ["job", selectedRuntimeJobId, "terminal"], refetchType: "active" }));
    }
    await Promise.all(tasks);
  }, [activePath, queryClient, selectedFile, selectedRuntimeJobId]);

  const categoryTabs: Array<{
    id: Exclude<FileTab, "all">;
    label: string;
    rows: DataRow[];
    icon: ReactNode;
    summary?: SummaryLike;
  }> = [
    { id: "main", label: "Main Data", rows: Array.isArray(datasets?.main?.rows) ? datasets.main.rows : [], icon: <FileSpreadsheet className="h-3.5 w-3.5" />, summary: datasets?.main?.summary as SummaryLike | undefined },
    { id: "found", label: "Found", rows: Array.isArray(datasets?.found?.rows) ? datasets.found.rows : [], icon: <FileSpreadsheet className="h-3.5 w-3.5" />, summary: datasets?.found?.summary as SummaryLike | undefined },
    { id: "customer", label: "Customer", rows: Array.isArray(datasets?.customer?.rows) ? datasets.customer.rows : [], icon: <FileSpreadsheet className="h-3.5 w-3.5" />, summary: datasets?.customer?.summary as SummaryLike | undefined },
    { id: "not_found", label: "Not Found", rows: Array.isArray(datasets?.not_found?.rows) ? datasets.not_found.rows : [], icon: <FileSpreadsheet className="h-3.5 w-3.5" />, summary: datasets?.not_found?.summary as SummaryLike | undefined },
    { id: "review", label: "Review", rows: Array.isArray(datasets?.review?.rows) ? datasets.review.rows : [], icon: <FileSpreadsheet className="h-3.5 w-3.5" />, summary: datasets?.review?.summary as SummaryLike | undefined },
  ];

  const allTab = {
    id: "all" as const,
    label: "All Files",
    rows: Array.isArray(selectedFileData?.parsed) ? selectedFileData.parsed : [],
    icon: <FileSpreadsheet className="h-3.5 w-3.5" />,
    summary: datasets?.main?.summary as SummaryLike | undefined,
  };

  const tabs = [...categoryTabs, allTab];
  const currentTab = tabs.find((tab) => tab.id === activeTab) ?? allTab;
  const currentRows = currentTab.rows;
  const currentSummary = activeTab === "all" ? (datasets?.main?.summary as SummaryLike | undefined) : currentTab.summary;
  const pathSegments = activePath.split("/").filter(Boolean);

  const filteredRows = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) {
      return currentRows;
    }
    return currentRows.filter((row) =>
      Object.entries(row || {}).some(([key, value]) => `${key} ${String(value ?? "")}`.toLowerCase().includes(needle)),
    );
  }, [currentRows, searchQuery]);

  const tableHeaders = useMemo(() => {
    const headers = new Set<string>();
    currentRows.forEach((row) => {
      Object.keys(row || {}).forEach((key) => headers.add(key));
    });
    return [...headers];
  }, [currentRows]);

  const openDirectory = (pathValue: string) => {
    setActivePath(pathValue);
    setSelectedFile("");
  };

  const goUpDirectory = () => {
    if (!activePath) {
      return;
    }
    const chunks = activePath.split("/").filter(Boolean);
    chunks.pop();
    setActivePath(chunks.join("/"));
    setSelectedFile("");
  };

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
          <BadgeCheck className="h-4 w-4 text-primary" />
          <div className="flex flex-col">
            <span className="font-semibold">Status summary</span>
            <span className="text-muted-foreground">{buildSummaryLabel(currentSummary)}</span>
          </div>
        </div>
        {currentSummary?.last_processed_at ? (
          <span className="rounded-lg border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            Last processed: {new Date(currentSummary.last_processed_at).toLocaleString()}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium ${
              activeTab === tab.id ? "bg-primary text-primary-foreground" : "border bg-background hover:bg-accent"
            }`}
          >
            <span className="inline-flex items-center gap-1.5">
              {tab.icon}
              {tab.label}
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{tab.rows.length}</span>
            </span>
          </button>
        ))}

        <div className="ml-auto flex min-w-[260px] items-center gap-2 text-xs">
          <span className="text-muted-foreground">File</span>
          <select
            value={selectedFile}
            onChange={(event) => {
              const value = event.target.value;
              setSelectedFile(value);
              setActiveTab("all");
              if (value) {
                const chunks = value.split("/");
                chunks.pop();
                setActivePath(chunks.join("/"));
              }
            }}
            className="h-8 min-w-[220px] rounded-md border bg-background px-2"
          >
            <option value="">Select file</option>
            {quickFiles.map((entry) => (
              <option key={entry.path} value={entry.path}>
                {entry.path}
              </option>
            ))}
          </select>
        </div>
      </div>

      {activeTab === "all" ? (
        <div className="space-y-3 border-b px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button onClick={() => openDirectory("")} className="rounded-md border bg-background px-2 py-1 hover:bg-accent">
              root
            </button>
            {pathSegments.map((segment, index) => {
              const nextPath = pathSegments.slice(0, index + 1).join("/");
              return (
                <button key={nextPath} onClick={() => openDirectory(nextPath)} className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 hover:bg-accent">
                  <ChevronRight className="h-3 w-3" />
                  {segment}
                </button>
              );
            })}
            <button onClick={goUpDirectory} disabled={!activePath} className="ml-auto inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 disabled:opacity-50">
              <ChevronLeft className="h-3 w-3" />
              Up
            </button>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <PickerCard title="Folders">
              {directories.length === 0 ? <p className="text-[11px] text-muted-foreground">No folders</p> : null}
              {directories.map((directory) => (
                <button key={directory.path} onClick={() => openDirectory(directory.path)} className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-xs hover:bg-accent">
                  <FolderOpen className="h-3.5 w-3.5" />
                  {directory.name}
                </button>
              ))}
            </PickerCard>

            <PickerCard title="Files">
              {files.length === 0 ? <p className="text-[11px] text-muted-foreground">No files</p> : null}
              {files.map((file) => (
                <button
                  key={file.path}
                  onClick={() => {
                    setSelectedFile(file.path);
                    setHasInitializedSelection(true);
                  }}
                  className={`flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-xs ${
                    selectedFile === file.path ? "bg-accent" : "hover:bg-accent"
                  }`}
                >
                  <FileSpreadsheet className="h-3.5 w-3.5" />
                  {file.name}
                </button>
              ))}
            </PickerCard>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        {(["table", "json", "raw", "terminal"] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            disabled={activeTab !== "all" && (mode === "raw" || mode === "terminal")}
            className={`rounded-md px-2 py-1 text-xs ${
              viewMode === mode ? "bg-primary text-primary-foreground" : "border bg-background hover:bg-accent"
            } disabled:opacity-40`}
          >
            {mode.toUpperCase()}
          </button>
        ))}
        <input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search data..."
          className="h-8 min-w-[220px] rounded-md border bg-background px-2 text-xs"
        />
        <button onClick={refreshNow} className="rounded-md border bg-background px-2 py-1 text-xs hover:bg-accent">
          Refresh
        </button>
        {activeTab === "all" ? (
          <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={liveRefresh} onChange={(event) => setLiveRefresh(event.target.checked)} />
            Live refresh (2s)
          </label>
        ) : null}
      </div>

      {activeTab === "all" && selectedFileError ? (
        <div className="border-b bg-destructive/5 px-3 py-2 text-xs text-destructive">
          Failed to load file content: {selectedFileError instanceof Error ? selectedFileError.message : "Unknown error"}
        </div>
      ) : null}

      {activeTab === "all" && isSelectedFileFetching ? (
        <div className="border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">Loading latest file content...</div>
      ) : null}

      {(viewMode === "table" || (activeTab !== "all" && (viewMode === "raw" || viewMode === "terminal"))) ? (
        <div className="max-h-[680px] min-h-[420px] overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b">
                {tableHeaders.map((header) => (
                  <th key={header} className="bg-muted/30 px-3 py-2 text-left font-medium text-muted-foreground">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row, index) => (
                <tr key={`${index}-${activeTab}`} className="border-b hover:bg-accent/30">
                  {tableHeaders.map((header) => (
                    <td key={`${index}-${header}`} className="whitespace-nowrap px-3 py-2 align-top">
                      {String(row?.[header] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={Math.max(1, tableHeaders.length)} className="px-3 py-8 text-center text-muted-foreground">
                    No data found
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {viewMode === "json" ? (
        <pre className="max-h-[680px] min-h-[420px] overflow-auto whitespace-pre-wrap p-4 text-xs font-mono">{JSON.stringify(filteredRows, null, 2)}</pre>
      ) : null}

      {viewMode === "raw" && activeTab === "all" ? (
        <pre className="max-h-[680px] min-h-[420px] overflow-auto whitespace-pre-wrap p-4 text-xs font-mono">{selectedFileData?.raw || "No raw data available"}</pre>
      ) : null}

      {viewMode === "terminal" && activeTab === "all" ? (
        <div className="space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              onClick={() => setTerminalSource("file")}
              className={`rounded-md px-2 py-1 ${terminalSource === "file" ? "bg-primary text-primary-foreground" : "border bg-background hover:bg-accent"}`}
            >
              File Raw
            </button>
            <button
              onClick={() => setTerminalSource("runtime")}
              className={`rounded-md px-2 py-1 ${terminalSource === "runtime" ? "bg-primary text-primary-foreground" : "border bg-background hover:bg-accent"}`}
            >
              Runtime Logs
            </button>
            {terminalSource === "runtime" ? (
              <select
                value={selectedRuntimeJobId}
                onChange={(event) => setSelectedRuntimeJobId(event.target.value)}
                className="ml-auto h-8 rounded-md border bg-background px-2 text-xs"
              >
                {runtimeJobs.map((job) => (
                  <option key={job.id} value={job.id}>
                    {job.kind}:{job.scriptId || "pipeline"} | {job.status} | {job.id}
                  </option>
                ))}
              </select>
            ) : null}
          </div>

          <pre className="max-h-[620px] min-h-[420px] overflow-auto rounded-md border bg-muted/40 p-4 text-xs font-mono leading-relaxed">
            {terminalSource === "file"
              ? (selectedFileData?.raw || "No terminal output available")
              : (runtimeJobData?.job?.logs?.join("\n") || "No runtime logs available")}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function PickerCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-md border bg-background p-2">
      <p className="mb-2 text-[11px] font-medium text-muted-foreground">{title}</p>
      <div className="max-h-44 space-y-1 overflow-auto">{children}</div>
    </div>
  );
}
