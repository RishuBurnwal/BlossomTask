import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ExternalLink, RefreshCw, Cloud, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/time";
import { toast } from "sonner";

function formatBytes(value: number) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function GoogleDriveSyncPanel() {
  const queryClient = useQueryClient();
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [showFullError, setShowFullError] = useState(false);

  const { data: authData } = useQuery({
    queryKey: ["auth"],
    queryFn: api.authMe,
    staleTime: 30_000,
  });

  const isAdmin = authData?.user?.role === "admin";

  const { data, isLoading, error } = useQuery({
    queryKey: ["google-sync-files"],
    queryFn: api.googleSyncFiles,
    enabled: Boolean(isAdmin),
    refetchInterval: 10_000,
  });

  const syncMutation = useMutation({
    mutationFn: () => api.runGoogleSync({ mode: "approved-runtime" }),
    onSuccess: (result) => {
      toast.success(`Google Drive sync complete: ${result.uploadedFiles ?? result.lastSyncedFiles ?? 0} files`);
      queryClient.invalidateQueries({ queryKey: ["google-sync"] });
      queryClient.invalidateQueries({ queryKey: ["google-sync-files"] });
    },
    onError: (syncError) => toast.error(syncError.message || "Google Drive sync failed"),
  });

  if (!isAdmin) {
    return null;
  }

  const groups = data?.groups ?? [];
  const logs = data?.logs ?? [];
  const quotaError = /Service Accounts do not have storage quota/i.test(data?.lastError || "");

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Google Drive Sync</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Output files mirror into Drive with the same local folder structure and exact file names.
        </p>
      </div>

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <Cloud className="h-4 w-4" />
              Drive Output Mirror
            </CardTitle>
            <CardDescription>
              {data?.configured ? "Configured" : "Missing service account JSON"} | {data?.enabled ? "Auto-sync enabled" : "Auto-sync disabled"}
            </CardDescription>
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>Last sync: {formatDateTime(data?.lastSyncAt, authData?.configuredTimezone)}</span>
              <span>Files: {data?.files?.length ?? 0}</span>
              {data?.rootFolderUrl ? (
                <a href={data.rootFolderUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                  Root folder <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
            </div>
            {quotaError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                <div className="font-medium">Google rejected upload because this is a service-account sync into a normal My Drive folder.</div>
                <div className="mt-1 text-destructive/90">
                  Use a Shared Drive folder and add the service account as Content manager/Contributor, or use OAuth user delegation.
                </div>
              </div>
            ) : null}
            {data?.lastError ? (
              <div className="space-y-2">
                <Button variant="outline" size="sm" onClick={() => setShowFullError((current) => !current)}>
                  {showFullError ? "Hide Full Error" : "View Full Error"}
                </Button>
                {showFullError ? (
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-[11px] leading-5 text-destructive">
                    {data.lastError}
                  </pre>
                ) : null}
              </div>
            ) : null}
            {error ? <p className="text-xs text-destructive">{error instanceof Error ? error.message : "Failed to load sync state"}</p> : null}
          </div>
          <Button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending || !data?.configured}
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${syncMutation.isPending ? "animate-spin" : ""}`} />
            {syncMutation.isPending ? "Syncing..." : "Sync Now"}
          </Button>
          <a href={api.googleOAuthUrl()} target="_blank" rel="noreferrer">
            <Button variant="outline" className="gap-2">
              Connect OAuth
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </a>
        </CardHeader>

        <CardContent className="space-y-3">
          <div className="grid gap-2 rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground md:grid-cols-2">
            <div>OAuth configured: {data?.oauthConfigured ? "Yes" : "No"}</div>
            <div>OAuth connected: {data?.oauthConnected ? "Yes" : "No"}</div>
            <div className="break-all">Redirect URI: {data?.oauthRedirectUri || "Not set"}</div>
            <div className="break-all">Client secret file: {data?.oauthClientSecretPath || "Using .env"}</div>
            <div>Last OAuth refresh: {formatDateTime(data?.oauthLastRefreshAt, authData?.configuredTimezone)}</div>
          </div>
          {isLoading ? <p className="text-sm text-muted-foreground">Loading Drive sync files...</p> : null}
          {!isLoading && groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">No output files found yet.</p>
          ) : null}

          {groups.map((group) => {
            const isExpanded = expandedGroups[group.name] ?? group.name === "Funeral_Finder";
            return (
              <div key={group.name} className="rounded-lg border bg-background">
                <button
                  type="button"
                  onClick={() => setExpandedGroups((current) => ({ ...current, [group.name]: !isExpanded }))}
                  className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    <span className="truncate font-medium">{group.name}</span>
                  </span>
                  <span className="flex shrink-0 flex-wrap justify-end gap-2 text-xs">
                    <Badge variant="outline">{group.totalFiles} files</Badge>
                    <Badge variant="secondary">{group.syncedFiles} synced</Badge>
                    {group.deletedFiles > 0 ? <Badge variant="destructive">{group.deletedFiles} deleted</Badge> : null}
                  </span>
                </button>

                {isExpanded ? (
                  <div className="border-t">
                    <div className="overflow-auto">
                      <table className="w-full min-w-[760px] text-xs">
                        <thead className="bg-muted/40">
                          <tr>
                            <th className="px-3 py-2 text-left font-medium text-muted-foreground">File</th>
                            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Status</th>
                            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Size</th>
                            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Synced</th>
                            <th className="px-3 py-2 text-right font-medium text-muted-foreground">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.files.map((file) => (
                            <tr key={file.relativePath} className="border-t">
                              <td className="max-w-[24rem] px-3 py-2">
                                <div className="truncate font-medium">{file.name}</div>
                                <div className="truncate text-muted-foreground">{file.relativePath}</div>
                              </td>
                              <td className="px-3 py-2">
                                {file.deleted ? (
                                  <Badge variant="destructive" className="gap-1">
                                    <Trash2 className="h-3 w-3" />
                                    Deleted
                                  </Badge>
                                ) : (
                                  <Badge variant={file.status === "synced" ? "default" : "secondary"}>{file.status}</Badge>
                                )}
                              </td>
                              <td className="px-3 py-2 text-muted-foreground">{formatBytes(file.size)}</td>
                              <td className="px-3 py-2 text-muted-foreground">{formatDateTime(file.syncedAt, authData?.configuredTimezone)}</td>
                              <td className="px-3 py-2 text-right">
                                {file.driveUrl && !file.deleted ? (
                                  <a href={file.driveUrl} target="_blank" rel="noreferrer">
                                    <Button variant="outline" size="sm" className="gap-1.5">
                                      View File
                                      <ExternalLink className="h-3 w-3" />
                                    </Button>
                                  </a>
                                ) : (
                                  <span className="text-muted-foreground">No Drive URL</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}

          {logs.length > 0 ? (
            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Sync Logs</div>
              <div className="max-h-72 space-y-2 overflow-auto text-xs">
                {logs.map((log) => (
                  <div key={log.id} className="grid gap-1 rounded-md border bg-background p-2">
                    <span className="text-muted-foreground">{formatDateTime(log.at, authData?.configuredTimezone)}</span>
                    <span className="whitespace-pre-wrap break-words">{log.message}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
