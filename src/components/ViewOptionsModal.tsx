import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

interface ViewOptionsModalProps {
  open: boolean;
  onClose: () => void;
  scriptName: string;
  sourcePath?: string;
}

type ViewMode = "human" | "json" | "raw";

export function ViewOptionsModal({ open, onClose, scriptName, sourcePath = "Funeral_Finder/Funeral_data.csv" }: ViewOptionsModalProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("human");
  const { data } = useQuery({
    queryKey: ["file-content", sourcePath],
    queryFn: () => api.fileContent(sourcePath, 100),
    enabled: open,
  });

  if (!open) return null;

  const parsedRows = Array.isArray(data?.parsed) ? data.parsed : [];
  const sample = parsedRows.slice(0, 10);
  const raw = data?.raw ?? "";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative mx-4 max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-xl border bg-card shadow-xl animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-sm font-semibold">{scriptName} — Output View</h2>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-accent transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b px-5 py-2">
          {(["human", "json", "raw"] as ViewMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                viewMode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
              }`}
            >
              {m === "human" ? "Readable" : m === "json" ? "JSON" : "Raw"}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="max-h-[60vh] overflow-auto p-5">
          {viewMode === "human" && (
            <div className="space-y-3">
              {sample.map((row, index) => (
                <div key={String(row.ord_id ?? row.orderId ?? index)} className="rounded-lg border bg-background p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-semibold">{String(row.ord_id ?? row.orderId ?? "N/A")}</span>
                    <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-secondary text-secondary-foreground">
                      {String(row.pplx_status ?? row.status ?? "unknown")}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {String(row.ship_name ?? row.customer ?? "")} · {String(row.ship_city ?? row.product ?? "")} · {String(
                      row.ship_state ?? row.status ?? "",
                    )}
                  </p>
                </div>
              ))}
            </div>
          )}

          {viewMode === "json" && (
            <pre className="rounded-lg border bg-background p-4 text-xs font-mono overflow-x-auto">
              {JSON.stringify(sample, null, 2)}
            </pre>
          )}

          {viewMode === "raw" && (
            <pre className="rounded-lg border bg-background p-4 text-xs font-mono overflow-x-auto whitespace-pre-wrap">
              {raw || "No raw output available"}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
