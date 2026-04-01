import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileSpreadsheet, FolderOpen, ChevronRight, ChevronLeft, BadgeCheck } from "lucide-react";
import { api } from "@/lib/api";
import type { DataRow } from "@/lib/types";

type FileTab = "main" | "all";

export function DataViewer() {
  const [activeTab, setActiveTab] = useState<FileTab>("all");
  const [activePath, setActivePath] = useState("");
  const [selectedFile, setSelectedFile] = useState<string>("");
  const [viewMode, setViewMode] = useState<"table" | "json" | "raw" | "terminal">("table");
  const [searchQuery, setSearchQuery] = useState("");
  const [liveRefresh, setLiveRefresh] = useState(false);
  const [terminalSource, setTerminalSource] = useState<"file" | "runtime">("file");
  const [selectedRuntimeJobId, setSelectedRuntimeJobId] = useState<string>("");
  const [hasInitializedFileSelection, setHasInitializedFileSelection] = useState(false);

  const { data: datasetsData } = useQuery({
    queryKey: ["datasets"],
    queryFn: api.datasets,
    refetchInterval: 20000,
  });

  const { data: treeData } = useQuery({
    queryKey: ["files-tree", activePath],
    queryFn: () => api.fileTree(activePath),
    refetchInterval: 30000,
  });

  const { data: recursiveTreeData, refetch: refetchRecursiveTree } = useQuery({
    queryKey: ["files-tree", "recursive-picker"],
    queryFn: () => api.fileTree("", true),
    refetchInterval: 30000,
  });

  const { data: selectedFileData } = useQuery({
    queryKey: ["file-content", selectedFile],
    queryFn: () => api.fileContent(selectedFile, 300),
    enabled: activeTab === "all" && Boolean(selectedFile),
    refetchInterval: activeTab === "all" && liveRefresh ? 3000 : false,
  });

  const { data: jobsData } = useQuery({
    queryKey: ["jobs", "terminal"],
    queryFn: api.jobs,
    refetchInterval: viewMode === "terminal" && terminalSource === "runtime" ? 2000 : 10000,
  });

  const { data: runtimeJobData } = useQuery({
    queryKey: ["job", selectedRuntimeJobId, "terminal"],
    queryFn: () => api.job(selectedRuntimeJobId),
    enabled: viewMode === "terminal" && terminalSource === "runtime" && Boolean(selectedRuntimeJobId),
    refetchInterval: 1500,
  });

  const { refetch: refetchDatasets } = useQuery({
    queryKey: ["datasets-refresh-only"],
    queryFn: api.datasets,
    enabled: false,
  });

  const { refetch: refetchTree } = useQuery({
    queryKey: ["files-tree-refresh-only", activePath],
    queryFn: () => api.fileTree(activePath),
    enabled: false,
  });

  const { refetch: refetchSelectedFile } = useQuery({
    queryKey: ["file-content-refresh-only", selectedFile],
    queryFn: () => api.fileContent(selectedFile, 300),
    enabled: false,
  });

  const { refetch: refetchJobs } = useQuery({
    queryKey: ["jobs-refresh-only"],
    queryFn: api.jobs,
    enabled: false,
  });

  const { refetch: refetchRuntimeJob } = useQuery({
    queryKey: ["job-refresh-only", selectedRuntimeJobId],
    queryFn: () => api.job(selectedRuntimeJobId),
    enabled: false,
  });

  const entries = treeData?.entries ?? [];
  const directories = entries.filter((entry) => entry.type === "directory");
  const files = entries.filter((entry) => entry.type === "file");
  const quickFiles = (recursiveTreeData?.entries ?? []).filter((entry) => entry.type === "file");

  useEffect(() => {
    if (activeTab !== "all") return;
    if (selectedFile && files.some((file) => file.path === selectedFile)) return;
    setSelectedFile(files[0]?.path ?? "");
  }, [activeTab, files, selectedFile]);

  useEffect(() => {
    if (activeTab !== "all") return;
    if (hasInitializedFileSelection) return;
    if (selectedFile) return;
    if (!quickFiles.length) return;
    const firstPath = quickFiles[0].path;
    setSelectedFile(firstPath);
    const chunks = firstPath.split("/");
    chunks.pop();
    setActivePath(chunks.join("/"));
    setHasInitializedFileSelection(true);
  }, [activeTab, hasInitializedFileSelection, quickFiles, selectedFile]);

  const pathSegments = useMemo(() => activePath.split("/").filter(Boolean), [activePath]);

  const normalizeRows = (value: unknown): DataRow[] => {
    if (Array.isArray(value)) {
      return value as DataRow[];
    }
    if (value && typeof value === "object") {
      return [value as DataRow];
    }
    return [];
  };

  const datasets = datasetsData?.datasets;
  const tabs: { id: FileTab; label: string; icon: React.ReactNode; data: DataRow[] }[] = [
    {
      id: "main",
      label: "Main Data",
      icon: <FileSpreadsheet className="h-3.5 w-3.5" />,
      data: normalizeRows(datasets?.main?.rows),
    },
    {
      id: "all",
      label: "All Files",
      icon: <FileSpreadsheet className="h-3.5 w-3.5" />,
      data: normalizeRows(selectedFileData?.parsed),
    },
  ];

  const current = tabs.find((t) => t.id === activeTab)!;
  const filteredRows = useMemo(() => {
    const rows = Array.isArray(current.data) ? current.data : [];
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => {
      if (!row || typeof row !== "object") return false;
      return Object.entries(row).some(([key, value]) =>
        `${key} ${String(value ?? "")}`.toLowerCase().includes(needle),
      );
    });
  }, [current.data, searchQuery]);

  const tableHeaders = useMemo(() => {
    const headers = new Set<string>();
    (Array.isArray(current.data) ? current.data : []).forEach((row) => {
      Object.keys(row).forEach((key) => headers.add(key));
    });
    return [...headers];
  }, [current.data]);

  const rawContent = selectedFileData?.raw ?? "";
  const runtimeJobs = (jobsData?.jobs ?? []).filter((job) => job.kind === "script" || job.kind === "pipeline");

  const refreshNow = async () => {
    await Promise.all([
      refetchDatasets(),
      refetchTree(),
      refetchRecursiveTree(),
      refetchJobs(),
      selectedFile ? refetchSelectedFile() : Promise.resolve(),
      selectedRuntimeJobId ? refetchRuntimeJob() : Promise.resolve(),
    ]);
  };

  useEffect(() => {
    if (runtimeJobs.length === 0) {
      setSelectedRuntimeJobId("");
      return;
    }
    if (selectedRuntimeJobId && runtimeJobs.some((job) => job.id === selectedRuntimeJobId)) {
      return;
    }
    setSelectedRuntimeJobId(runtimeJobs[0].id);
  }, [runtimeJobs, selectedRuntimeJobId]);

  useEffect(() => {
    const savedMode = window.localStorage.getItem("data-viewer-mode");
    if (savedMode === "table" || savedMode === "json" || savedMode === "raw" || savedMode === "terminal") {
      setViewMode(savedMode);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("data-viewer-mode", viewMode);
  }, [viewMode]);
  const openDirectory = (path: string) => {
    setActivePath(path);
    setSelectedFile("");
  };

  const goUpDirectory = () => {
    if (!activePath) return;
    const chunks = activePath.split("/").filter(Boolean);
    chunks.pop();
    setActivePath(chunks.join("/"));
    setSelectedFile("");
  };

  return (
    <div className="rounded-xl border bg-card card-shadow animate-fade-in">
      {/* Summary */}
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
          <BadgeCheck className="h-4 w-4 text-primary" />
          <div className="flex flex-col leading-tight">
            <span className="font-semibold">Status summary</span>
            <span className="text-muted-foreground">
              {datasets?.main?.summary?.total ?? 0} rows · matched {datasets?.main?.summary?.matched ?? 0} · needs review {datasets?.main?.summary?.needs_review ?? 0} · unmatched {datasets?.main?.summary?.unmatched ?? 0}
            </span>
          </div>
        </div>
        {datasets?.main?.summary?.last_processed_at && (
          <span className="rounded-lg border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            Last processed: {new Date(datasets.main.summary.last_processed_at).toLocaleString()}
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              activeTab === tab.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
            }`}
          >
            {tab.icon}
            {tab.label}
            <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] ${
              activeTab === tab.id ? "bg-primary-foreground/20" : "bg-muted"
            }`}>
              {tab.data.length}
            </span>
          </button>
        ))}

        <div className="ml-auto flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">File:</span>
          <select
            value={selectedFile}
            onChange={(event) => {
              const value = event.target.value;
              setSelectedFile(value);
              if (value) {
                const chunks = value.split("/");
                chunks.pop();
                setActivePath(chunks.join("/"));
                setActiveTab("all");
              }
            }}
            className="h-8 min-w-[240px] rounded-md border bg-background px-2 text-xs"
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

      {activeTab === "all" && (
        <div className="border-b px-4 py-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              onClick={() => openDirectory("")}
              className="rounded-md border bg-background px-2 py-1 hover:bg-accent"
            >
              root
            </button>
            {pathSegments.map((segment, index) => {
              const nextPath = pathSegments.slice(0, index + 1).join("/");
              return (
                <button
                  key={nextPath}
                  onClick={() => openDirectory(nextPath)}
                  className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 hover:bg-accent"
                >
                  <ChevronRight className="h-3 w-3" />
                  {segment}
                </button>
              );
            })}
            <button
              onClick={goUpDirectory}
              disabled={!activePath}
              className="ml-auto inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 disabled:opacity-50"
            >
              <ChevronLeft className="h-3 w-3" />
              Up
            </button>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-md border bg-background p-2">
              <p className="mb-2 text-[11px] font-medium text-muted-foreground">Folders</p>
              <div className="max-h-28 space-y-1 overflow-auto">
                {directories.length === 0 && <p className="text-[11px] text-muted-foreground">No folders</p>}
                {directories.map((directory) => (
                  <button
                    key={directory.path}
                    onClick={() => openDirectory(directory.path)}
                    className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-xs hover:bg-accent"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    {directory.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-md border bg-background p-2">
              <p className="mb-2 text-[11px] font-medium text-muted-foreground">Files</p>
              <div className="max-h-28 space-y-1 overflow-auto">
                {files.length === 0 && <p className="text-[11px] text-muted-foreground">No files</p>}
                {files.map((file) => (
                  <button
                    key={file.path}
                    onClick={() => {
                      setSelectedFile(file.path);
                      setHasInitializedFileSelection(true);
                    }}
                    className={`flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-xs ${
                      selectedFile === file.path ? "bg-accent" : "hover:bg-accent"
                    }`}
                  >
                    <FileSpreadsheet className="h-3.5 w-3.5" />
                    {file.name}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Quick file picker:</span>
            <select
              value={selectedFile}
              onChange={(event) => {
                const value = event.target.value;
                setSelectedFile(value);
                setHasInitializedFileSelection(true);
                const chunks = value.split("/");
                chunks.pop();
                setActivePath(chunks.join("/"));
              }}
              className="h-8 min-w-[260px] rounded-md border bg-background px-2 text-xs"
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
      )}

      {/* Grid */}
      <div className="border-b px-4 py-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">View:</span>
        {([
          { id: "table", label: "Table" },
          { id: "json", label: "JSON" },
          { id: "raw", label: "Raw" },
          { id: "terminal", label: "Terminal" },
        ] as const).map((mode) => (
          <button
            key={mode.id}
            onClick={() => setViewMode(mode.id)}
            disabled={activeTab !== "all" && (mode.id === "raw" || mode.id === "terminal")}
            className={`rounded-md px-2 py-1 text-xs ${
              viewMode === mode.id ? "bg-primary text-primary-foreground" : "border bg-background hover:bg-accent"
            } disabled:opacity-40`}
          >
            {mode.label}
          </button>
        ))}

        {activeTab === "all" && (
          <>
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search data..."
              className="h-8 min-w-[220px] rounded-md border bg-background px-2 text-xs"
            />
            <button
              onClick={refreshNow}
              className="rounded-md border bg-background px-2 py-1 text-xs hover:bg-accent"
            >
              Refresh
            </button>
            <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={liveRefresh}
                onChange={(event) => setLiveRefresh(event.target.checked)}
              />
              Live refresh (3s)
            </label>
          </>
        )}
      </div>

      {viewMode === "table" || (activeTab !== "all" && (viewMode === "raw" || viewMode === "terminal")) ? (
        <div className="max-h-[400px] overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b">
                {tableHeaders.map((key) => (
                  <th key={key} className="px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap bg-muted/30">
                    {key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row, index) => (
                <tr key={index} className="border-b transition-colors hover:bg-accent/30">
                  {tableHeaders.map((header) => (
                    <td key={`${index}-${header}`} className="px-3 py-2 whitespace-nowrap align-top">
                      {String(row[header] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
              {filteredRows.length === 0 ? (
                <tr>
                  <td className="px-3 py-8 text-center text-muted-foreground" colSpan={Math.max(1, tableHeaders.length)}>
                    No data found
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {viewMode === "json" && (
        <pre className="max-h-[400px] overflow-auto whitespace-pre-wrap p-4 text-xs font-mono">
          {JSON.stringify(filteredRows, null, 2)}
        </pre>
      )}

      {viewMode === "raw" && activeTab === "all" && (
        <pre className="max-h-[400px] overflow-auto whitespace-pre-wrap p-4 text-xs font-mono">
          {rawContent || "No raw data available"}
        </pre>
      )}

      {viewMode === "terminal" && activeTab === "all" && (
        <div className="space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Terminal Source:</span>
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

            {terminalSource === "runtime" && (
              <select
                value={selectedRuntimeJobId}
                onChange={(event) => setSelectedRuntimeJobId(event.target.value)}
                className="ml-auto h-8 rounded-md border bg-background px-2 text-xs"
              >
                {runtimeJobs.map((job) => (
                  <option key={job.id} value={job.id}>
                    {job.kind}:{job.scriptId || "pipeline"} • {job.status} • {job.id}
                  </option>
                ))}
              </select>
            )}
          </div>

          <pre className="max-h-[360px] overflow-auto rounded-md border bg-muted/40 p-4 text-xs font-mono leading-relaxed">
            {terminalSource === "file"
              ? (rawContent || "No terminal output available")
              : (runtimeJobData?.job?.logs?.join("\n") || "No runtime logs available")}
          </pre>
        </div>
      )}
    </div>
  );
}
