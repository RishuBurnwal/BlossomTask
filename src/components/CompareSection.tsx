import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function CompareSection() {
  const [search, setSearch] = useState("");
  const [leftFile, setLeftFile] = useState("Funeral_Finder/Funeral_data.csv");
  const [rightFile, setRightFile] = useState("Funeral_Finder/Funeral_data_error.csv");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [layoutMode, setLayoutMode] = useState<"horizontal" | "vertical">("horizontal");

  const { data: treeData } = useQuery({
    queryKey: ["files-tree", "compare"],
    queryFn: () => api.fileTree("", true),
  });

  const { data: leftFileData } = useQuery({
    queryKey: ["compare-left-file", leftFile],
    queryFn: () => api.fileContent(leftFile, 100),
    enabled: Boolean(leftFile),
  });

  const { data: rightFileData } = useQuery({
    queryKey: ["compare-right-file", rightFile],
    queryFn: () => api.fileContent(rightFile, 100),
    enabled: Boolean(rightFile),
  });

  const normalizeOrderIdInput = (value: string) => {
    const first = value
      .trim()
      .split(/[\s,;|]+/)
      .find(Boolean);
    return first ?? "";
  };

  const activeOrderId = normalizeOrderIdInput(search);
  const hasMultipleOrderIds = search.trim() !== "" && search.trim() !== activeOrderId;

  const compareMutation = useMutation({
    mutationFn: () => api.compareOrder(activeOrderId, [leftFile, rightFile]),
  });

  const files = useMemo(
    () => treeData?.entries?.filter((entry) => entry.type === "file") ?? [],
    [treeData?.entries],
  );
  const differences = compareMutation.data?.differences ?? [];
  const matches = compareMutation.data?.matches ?? [];
  const summary = compareMutation.data?.summary ?? [];
  const comparedOrderId = compareMutation.data?.orderId ?? "";
  const categories = ["all", ...summary.map((entry) => entry.category)];
  const filteredDifferences = categoryFilter === "all"
    ? differences
    : differences.filter((row) => row.category === categoryFilter);

  const extractOrderIdFromRow = (row: Record<string, unknown>) => {
    const direct = row.ord_id
      ?? row.orderId
      ?? row.ord_ID
      ?? row.order_id
      ?? row["Order ID"]
      ?? row["order id"]
      ?? row.OrderId
      ?? row.orderid
      ?? "";
    const fromDirect = String(direct ?? "").trim();
    if (fromDirect) {
      return fromDirect;
    }

    const fallbackKey = Object.keys(row).find((key) => {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      return normalized === "ordid" || normalized === "orderid";
    });

    return fallbackKey ? String(row[fallbackKey] ?? "").trim() : "";
  };

  const orderSuggestions = [...(leftFileData?.parsed ?? []), ...(rightFileData?.parsed ?? [])]
    .map((row) => extractOrderIdFromRow(row as Record<string, unknown>))
    .filter((value, index, array) => Boolean(value) && array.indexOf(value) === index)
    .slice(0, 16);

  const leftMatch = matches.find((entry) => entry.source === leftFile)?.row ?? null;
  const rightMatch = matches.find((entry) => entry.source === rightFile)?.row ?? null;

  const leftRows = leftMatch
    ? Object.entries(leftMatch)
    : [];
  const rightRows = rightMatch
    ? Object.entries(rightMatch)
    : [];

  useEffect(() => {
    if (files.length === 0) return;
    if (!files.some((file) => file.path === leftFile)) {
      setLeftFile(files[0].path);
    }
    if (!files.some((file) => file.path === rightFile)) {
      setRightFile(files[Math.min(1, files.length - 1)].path);
    }
  }, [files, leftFile, rightFile]);

  return (
    <div className="rounded-xl border bg-card p-4 card-shadow animate-fade-in">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-sm font-semibold">Compare Data</h2>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search one Order ID..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && activeOrderId) {
                  compareMutation.mutate();
                }
              }}
              className="h-8 rounded-lg border bg-background pl-8 pr-3 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <button
            onClick={() => compareMutation.mutate()}
            disabled={!activeOrderId || compareMutation.isPending}
            className="h-8 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            Compare
          </button>
        </div>
      </div>

      {hasMultipleOrderIds && (
        <p className="mb-3 text-[11px] text-amber-600">
          Only one Order ID can be compared at once. Using: {activeOrderId}
        </p>
      )}

      <div className="mb-4 grid gap-2 sm:grid-cols-2">
        <select value={leftFile} onChange={(e) => setLeftFile(e.target.value)} className="h-8 rounded-md border bg-background px-2 text-xs">
          {files.map((file) => (
            <option key={`left-${file.path}`} value={file.path}>
              Left: {file.path}
            </option>
          ))}
        </select>
        <select value={rightFile} onChange={(e) => setRightFile(e.target.value)} className="h-8 rounded-md border bg-background px-2 text-xs">
          {files.map((file) => (
            <option key={`right-${file.path}`} value={file.path}>
              Right: {file.path}
            </option>
          ))}
        </select>
      </div>

      {orderSuggestions.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {orderSuggestions.map((orderId) => (
            <button
              key={orderId}
              onClick={() => setSearch(orderId)}
              className="rounded-full border bg-background px-2 py-1 text-[11px] hover:bg-accent"
            >
              {orderId}
            </button>
          ))}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-muted-foreground">Layout:</span>
        <button
          onClick={() => setLayoutMode("horizontal")}
          className={`rounded-md px-2 py-1 text-[11px] ${
            layoutMode === "horizontal" ? "bg-primary text-primary-foreground" : "border bg-background hover:bg-accent"
          }`}
        >
          Left / Right
        </button>
        <button
          onClick={() => setLayoutMode("vertical")}
          className={`rounded-md px-2 py-1 text-[11px] ${
            layoutMode === "vertical" ? "bg-primary text-primary-foreground" : "border bg-background hover:bg-accent"
          }`}
        >
          Up / Down
        </button>
      </div>

      <div className={`mb-4 grid items-stretch gap-3 ${layoutMode === "horizontal" ? "md:grid-cols-2" : "grid-cols-1"}`}>
        <div className="rounded-lg border bg-background flex h-72 flex-col">
          <div className="border-b px-3 py-2 text-xs font-medium">Left: {leftFile}</div>
          <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
            {!leftMatch && <p className="text-xs text-muted-foreground">No row found for order {comparedOrderId || activeOrderId || "-"}</p>}
            {leftRows.length > 0 && (
              <table className="w-full text-xs">
                <tbody>
                  {leftRows.map(([key, value]) => (
                    <tr key={`left-${key}`} className="border-t first:border-t-0">
                      <td className="w-1/2 px-2 py-1 font-medium text-muted-foreground align-top">{key}</td>
                      <td className="px-2 py-1 break-all">{String(value ?? "")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="rounded-lg border bg-background flex h-72 flex-col">
          <div className="border-b px-3 py-2 text-xs font-medium">Right: {rightFile}</div>
          <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
            {!rightMatch && <p className="text-xs text-muted-foreground">No row found for order {comparedOrderId || activeOrderId || "-"}</p>}
            {rightRows.length > 0 && (
              <table className="w-full text-xs">
                <tbody>
                  {rightRows.map(([key, value]) => (
                    <tr key={`right-${key}`} className="border-t first:border-t-0">
                      <td className="w-1/2 px-2 py-1 font-medium text-muted-foreground align-top">{key}</td>
                      <td className="px-2 py-1 break-all">{String(value ?? "")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {summary.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {summary.map((item) => (
            <span key={item.category} className="rounded-full border bg-secondary px-2 py-1 text-[11px] text-secondary-foreground">
              {item.category}: {item.count}
            </span>
          ))}
        </div>
      )}

      {categories.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {categories.map((category) => (
            <button
              key={category}
              onClick={() => setCategoryFilter(category)}
              className={`rounded-md px-2 py-1 text-[11px] ${
                categoryFilter === category ? "bg-primary text-primary-foreground" : "border bg-background hover:bg-accent"
              }`}
            >
              {category}
            </button>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-muted/50">
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Order ID</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Field</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Left Value</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Right Value</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Category</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Status</th>
            </tr>
          </thead>
          <tbody>
            {filteredDifferences.map((row, i) => (
              <tr key={i} className="border-t transition-colors hover:bg-accent/30 bg-destructive/5">
                {(() => {
                  const bySource = Object.fromEntries(row.values.map((entry) => [entry.source, entry.value]));
                  return (
                    <>
                <td className="px-3 py-2 font-mono font-medium">{comparedOrderId || activeOrderId || "-"}</td>
                <td className="px-3 py-2">{row.field}</td>
                <td className="px-3 py-2">{String(bySource[leftFile] ?? "")}</td>
                <td className="px-3 py-2 font-semibold">{String(bySource[rightFile] ?? "")}</td>
                <td className="px-3 py-2">{row.category}</td>
                <td className="px-3 py-2">
                  <span className="rounded-full border px-2 py-0.5 text-[10px] font-medium bg-destructive/10 text-destructive border-destructive/20">
                    mismatch
                  </span>
                </td>
                    </>
                  );
                })()}
              </tr>
            ))}
            {filteredDifferences.length === 0 && matches.length > 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-success">
                  {differences.length === 0 ? `All fields matched for ${comparedOrderId || activeOrderId}` : `No mismatches in ${categoryFilter}`}
                </td>
              </tr>
            )}
            {filteredDifferences.length === 0 && matches.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">No results found</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
