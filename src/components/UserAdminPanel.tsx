import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, UserPlus, ShieldCheck, KeyRound, Ban, Timer, Globe2, LogOut, CloudUpload, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDateTime, formatTimeZoneLabel, GMT_TIMEZONE_OPTIONS } from "@/lib/time";
import { toast } from "sonner";

export function UserAdminPanel() {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [passwordChangeUserId, setPasswordChangeUserId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [sessionTtl, setSessionTtl] = useState<number | null>(null);
  const [configuredTimezone, setConfiguredTimezone] = useState("UTC");
  const [syncFolderName, setSyncFolderName] = useState("Blossom flower");
  const [syncCredentialsPath, setSyncCredentialsPath] = useState("");

  const { data: authData } = useQuery({
    queryKey: ["auth"],
    queryFn: api.authMe,
  });

  const { data: usersData } = useQuery({
    queryKey: ["users"],
    queryFn: api.users,
    enabled: authData?.user?.role === "admin",
    refetchInterval: 15_000,
  });

  const { data: sessionsData } = useQuery({
    queryKey: ["sessions"],
    queryFn: api.sessions,
    enabled: authData?.user?.role === "admin",
    refetchInterval: 15_000,
  });

  const { data: googleSyncData } = useQuery({
    queryKey: ["google-sync"],
    queryFn: api.googleSync,
    enabled: authData?.user?.role === "admin",
    refetchInterval: 20_000,
  });

  const currentTtl = authData?.sessionTtlMinutes ?? 480;
  const currentTimezone = authData?.configuredTimezone || "UTC";

  useEffect(() => {
    if (sessionTtl === null && currentTtl) {
      setSessionTtl(currentTtl);
    }
  }, [currentTtl, sessionTtl]);

  useEffect(() => {
    setConfiguredTimezone(currentTimezone);
  }, [currentTimezone]);

  useEffect(() => {
    if (googleSyncData?.folderName) {
      setSyncFolderName(googleSyncData.folderName);
    }
    if (googleSyncData?.credentialsPath !== undefined) {
      setSyncCredentialsPath(googleSyncData.credentialsPath);
    }
  }, [googleSyncData]);

  const createUserMutation = useMutation({
    mutationFn: () => api.createUser({ username, password, role }),
    onSuccess: () => {
      toast.success("User created");
      setUsername("");
      setPassword("");
      setRole("user");
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (error) => toast.error(error.message || "Failed to create user"),
  });

  const deleteUserMutation = useMutation({
    mutationFn: (userId: string) => api.deleteUser(userId),
    onSuccess: () => {
      toast.success("User deleted");
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (error) => toast.error(error.message || "Failed to delete user"),
  });

  const changePasswordMutation = useMutation({
    mutationFn: ({ userId, password }: { userId: string; password: string }) =>
      api.updateUserPassword(userId, password),
    onSuccess: () => {
      toast.success("Password updated, and all sessions for this user have been revoked");
      setPasswordChangeUserId(null);
      setNewPassword("");
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (error) => toast.error(error.message || "Failed to change password"),
  });

  const updateSessionTtlMutation = useMutation({
    mutationFn: (minutes: number) => api.setSessionTtl(minutes),
    onSuccess: (data) => {
      toast.success(`Session TTL updated to ${data.sessionTtlMinutes} minutes`);
      queryClient.invalidateQueries({ queryKey: ["auth"] });
    },
    onError: (error) => toast.error(error.message || "Failed to update session TTL"),
  });

  const updateTimezoneMutation = useMutation({
    mutationFn: (timeZone: string) => api.setTimezone(timeZone),
    onSuccess: (data) => {
      setConfiguredTimezone(data.configuredTimezone);
      toast.success(`Timezone updated to ${data.configuredTimezone}`);
      queryClient.invalidateQueries({ queryKey: ["auth"] });
    },
    onError: (error) => toast.error(error.message || "Failed to update timezone"),
  });

  const saveGoogleSyncMutation = useMutation({
    mutationFn: () =>
      api.saveGoogleSyncConfig({
        enabled: true,
        folderName: syncFolderName,
        credentialsPath: syncCredentialsPath,
      }),
    onSuccess: () => {
      toast.success("Google Drive sync saved");
      queryClient.invalidateQueries({ queryKey: ["google-sync"] });
    },
    onError: (error) => toast.error(error.message || "Failed to save Google sync"),
  });

  const runGoogleSyncMutation = useMutation({
    mutationFn: () => api.runGoogleSync({ mode: "approved-runtime" }),
    onSuccess: (data) => {
      toast.success(`Google sync complete: ${data.uploadedFiles ?? data.lastSyncedFiles} files`);
      queryClient.invalidateQueries({ queryKey: ["google-sync"] });
    },
    onError: (error) => toast.error(error.message || "Failed to run Google sync"),
  });

  const revokeSessionMutation = useMutation({
    mutationFn: (sessionId: string) => api.revokeSession(sessionId),
    onSuccess: () => {
      toast.success("Session revoked");
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (error) => toast.error(error.message || "Failed to revoke session"),
  });

  const revokeUserSessionsMutation = useMutation({
    mutationFn: (userId: string) => api.revokeUserSessions(userId),
    onSuccess: (data) => {
      toast.success(data.message || "All sessions revoked for user");
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (error) => toast.error(error.message || "Failed to revoke user sessions"),
  });

  const purgeInactiveSessionsMutation = useMutation({
    mutationFn: () => api.purgeInactiveSessions(),
    onSuccess: (data) => {
      toast.success(`${data.removed} inactive sessions removed`);
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (error) => toast.error(error.message || "Failed to remove inactive sessions"),
  });

  if (authData?.user?.role !== "admin") {
    return null;
  }

  const isSessionActive = (session: { expiresAt: string; revokedAt?: string | null }) => {
    if (session.revokedAt) return false;
    return new Date(session.expiresAt).getTime() > Date.now();
  };

  return (
    <section>
      <Card className="border-emerald-500/20 bg-card/95 shadow-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <ShieldCheck className="h-4 w-4 text-emerald-500" />
            Admin Control Room
          </CardTitle>
          <CardDescription>
            Create users, delete users, change passwords, configure session TTL, and monitor active sessions.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
            <div className="min-w-0 space-y-3 rounded-lg border p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <UserPlus className="h-4 w-4" />
                Add User
              </div>
              <div className="grid gap-3 lg:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="new-username">Username</Label>
                  <Input id="new-username" value={username} onChange={(event) => setUsername(event.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="new-password">Password</Label>
                  <Input id="new-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Role</Label>
                  <Select value={role} onValueChange={(value) => setRole(value as "admin" | "user") }>
                    <SelectTrigger>
                      <SelectValue placeholder="Role" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">User</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button
                className="w-full lg:w-auto"
                onClick={() => createUserMutation.mutate()}
                disabled={createUserMutation.isPending || !username || !password}
              >
                Create User
              </Button>
            </div>

            <div className="space-y-4 rounded-lg border p-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 text-foreground">
                <Timer className="h-4 w-4" />
                Session Configuration
              </div>
              <div className="space-y-2">
                <Label className="text-xs">Session Timeout (minutes)</Label>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    className="w-24"
                    min="5"
                    value={sessionTtl ?? currentTtl}
                    onChange={(e) => setSessionTtl(Number(e.target.value))}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => sessionTtl && updateSessionTtlMutation.mutate(sessionTtl)}
                    disabled={
                      updateSessionTtlMutation.isPending ||
                      !sessionTtl ||
                      sessionTtl === currentTtl ||
                      sessionTtl < 5
                    }
                  >
                    Save
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Current: {currentTtl} min ({(currentTtl / 60).toFixed(1)} hours). Sessions now expire after this sign-in window even if the dashboard keeps refreshing.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">Users: {usersData?.users?.length ?? 0}</Badge>
                <Badge variant="secondary">Sessions: {sessionsData?.sessions?.length ?? 0}</Badge>
                <Badge variant="secondary">
                  Active: {(sessionsData?.sessions ?? []).filter(isSessionActive).length}
                </Badge>
              </div>
              <div className="space-y-2 rounded-lg border bg-background px-3 py-3">
                <div className="flex items-center gap-2 text-foreground">
                  <Globe2 className="h-4 w-4" />
                  Global Timezone
                </div>
                <Select value={configuredTimezone} onValueChange={setConfiguredTimezone}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select timezone" />
                  </SelectTrigger>
                  <SelectContent>
                    {GMT_TIMEZONE_OPTIONS.map((timeZone) => (
                      <SelectItem key={timeZone} value={timeZone}>
                        {formatTimeZoneLabel(timeZone)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] text-muted-foreground">
                    Current server display time: {formatDateTime(new Date().toISOString(), configuredTimezone)}
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => updateTimezoneMutation.mutate(configuredTimezone)}
                    disabled={updateTimezoneMutation.isPending || configuredTimezone === currentTimezone}
                  >
                    Save
                  </Button>
                </div>
              </div>
              <div className="space-y-3 rounded-lg border bg-background px-3 py-3">
                <div className="flex items-center gap-2 text-foreground">
                  <CloudUpload className="h-4 w-4" />
                  Google Drive Sync
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">Drive Folder</Label>
                  <Input value={syncFolderName} onChange={(event) => setSyncFolderName(event.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">Service JSON Path</Label>
                  <Input value={syncCredentialsPath} onChange={(event) => setSyncCredentialsPath(event.target.value)} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={googleSyncData?.configured ? "default" : "secondary"}>
                    {googleSyncData?.configured ? "Configured" : "Missing JSON"}
                  </Badge>
                  <Badge variant={googleSyncData?.enabled ? "default" : "secondary"}>
                    {googleSyncData?.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </div>
                <div className="text-[10px] text-muted-foreground">
                  <p>Service: {googleSyncData?.serviceEmail || "Not detected yet"}</p>
                  <p>Last sync: {formatDateTime(googleSyncData?.lastSyncAt, currentTimezone)}</p>
                  <p>Last scope: {googleSyncData?.lastSyncScope || "/"}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => saveGoogleSyncMutation.mutate()}
                    disabled={saveGoogleSyncMutation.isPending || !syncFolderName || !syncCredentialsPath}
                  >
                    Save Sync
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => runGoogleSyncMutation.mutate()}
                    disabled={runGoogleSyncMutation.isPending || !googleSyncData?.configured}
                  >
                    <RefreshCw className={`mr-2 h-3.5 w-3.5 ${runGoogleSyncMutation.isPending ? "animate-spin" : ""}`} />
                    Sync Now
                  </Button>
                </div>
                {googleSyncData?.lastError ? (
                  <p className="text-[10px] text-destructive">{googleSyncData.lastError}</p>
                ) : null}
              </div>
            </div>
          </div>

          <Separator />

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Users</h3>
              <div className="space-y-2">
                {(usersData?.users ?? []).map((user) => (
                  <div key={user.id} className="rounded-lg border px-3 py-2 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{user.username}</span>
                      <Badge variant={user.role === "admin" ? "default" : "secondary"}>{user.role}</Badge>
                      <span className="text-xs text-muted-foreground">{user.active ? "active" : "disabled"}</span>
                      <div className="ml-auto flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            setPasswordChangeUserId(
                              passwordChangeUserId === user.id ? null : user.id,
                            );
                            setNewPassword("");
                          }}
                          title="Change password"
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-amber-500 hover:text-amber-600"
                          onClick={() => revokeUserSessionsMutation.mutate(user.id)}
                          disabled={revokeUserSessionsMutation.isPending}
                          title="Revoke all active sessions for this user"
                        >
                          <LogOut className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-destructive"
                          onClick={() => deleteUserMutation.mutate(user.id)}
                          disabled={deleteUserMutation.isPending}
                          title="Delete user"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    {passwordChangeUserId === user.id && (
                      <div className="mt-2 flex items-center gap-2 rounded border bg-background p-2 animate-in fade-in">
                        <Input
                          type="password"
                          placeholder="New password"
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          className="h-7 text-xs"
                        />
                        <Button
                          size="sm"
                          className="h-7 text-xs"
                          disabled={!newPassword || changePasswordMutation.isPending}
                          onClick={() =>
                            changePasswordMutation.mutate({
                              userId: user.id,
                              password: newPassword,
                            })
                          }
                        >
                          {changePasswordMutation.isPending ? "Saving..." : "Save"}
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Sessions</h3>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => purgeInactiveSessionsMutation.mutate()}
                  disabled={purgeInactiveSessionsMutation.isPending}
                >
                  Remove Expired
                </Button>
              </div>
              <div className="space-y-2">
                {(sessionsData?.sessions ?? []).map((session) => {
                  const active = isSessionActive(session);
                  return (
                    <div key={session.id} className="rounded-lg border px-3 py-2 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{session.username}</span>
                        <Badge variant="outline">{session.role}</Badge>
                        <Badge
                          variant={active ? "default" : "secondary"}
                          className={`text-[9px] ${
                            active
                              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                              : "bg-zinc-500/15 text-zinc-500"
                          }`}
                        >
                          {active ? "ACTIVE" : session.revokedAt ? "REVOKED" : "EXPIRED"}
                        </Badge>
                        <div className="ml-auto flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">
                            {formatDateTime(session.expiresAt, currentTimezone)}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-destructive"
                            disabled={!active || revokeSessionMutation.isPending}
                            onClick={() => revokeSessionMutation.mutate(session.id)}
                            title="Revoke session"
                          >
                            <Ban className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        Created: {formatDateTime(session.createdAt, currentTimezone)} | Last seen: {formatDateTime(session.lastSeenAt, currentTimezone)}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
