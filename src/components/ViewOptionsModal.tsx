import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
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
    queryKey: ["file-content", sourcePath, "view-modal"],
    queryFn: () => api.fileContent(sourcePath, 1000),
    enabled: open,
  });

  if (!open) return null;

  const normalizedRows = Array.isArray(data?.parsed)
    ? data.parsed
    : data?.parsed && typeof data.parsed === "object"
      ? [data.parsed as Record<string, unknown>]
      : [];
  const tableHeaders = Array.from(
    normalizedRows.reduce<Set<string>>((acc, row) => {
      Object.keys((row as Record<string, unknown>) || {}).forEach((key) => acc.add(key));
      return acc;
    }, new Set<string>()),
  );
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
            <div className="rounded-lg border bg-background">
              <div className="max-h-[52vh] overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-background">
                    <tr className="border-b">
                      {tableHeaders.map((header) => (
                        <th key={header} className="px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap">
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {normalizedRows.map((row, index) => (
                      <tr key={index} className="border-b align-top">
                        {tableHeaders.map((header) => (
                          <td key={`${index}-${header}`} className="px-3 py-2 whitespace-pre-wrap break-words">
                            {String((row as Record<string, unknown>)?.[header] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {normalizedRows.length === 0 && (
                      <tr>
                        <td className="px-3 py-8 text-center text-muted-foreground" colSpan={Math.max(1, tableHeaders.length)}>
                          No parsed rows available
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {viewMode === "json" && (
            <pre className="rounded-lg border bg-background p-4 text-xs font-mono overflow-x-auto">
              {JSON.stringify(data?.parsed ?? null, null, 2)}
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
