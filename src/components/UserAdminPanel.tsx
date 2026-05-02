import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  CloudUpload,
  Globe2,
  KeyRound,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Timer,
  Trash2,
  UserPlus,
} from "lucide-react";
import { api } from "@/lib/api";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  const [syncFolderName, setSyncFolderName] = useState("Blossom obituary automation");
  const [syncCredentialsPath, setSyncCredentialsPath] = useState("");
  const [syncDriveRootFolderId, setSyncDriveRootFolderId] = useState("");

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
    if (googleSyncData?.driveRootFolderId !== undefined) {
      setSyncDriveRootFolderId(googleSyncData.driveRootFolderId);
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
    mutationFn: ({ userId, password }: { userId: string; password: string }) => api.updateUserPassword(userId, password),
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
        driveRootFolderId: syncDriveRootFolderId,
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

  const users = usersData?.users ?? [];
  const sessions = sessionsData?.sessions ?? [];
  const activeSessions = sessions.filter(isSessionActive).length;

  return (
    <section>
      <Card className="overflow-hidden border-emerald-500/20 bg-card/95 shadow-lg">
        <CardHeader className="space-y-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <ShieldCheck className="h-4 w-4 text-emerald-500" />
              Admin Control Room
            </CardTitle>
            <CardDescription>
              Create users, manage sessions, update timezone, and control sync settings without layout overlap.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">Users: {users.length}</Badge>
            <Badge variant="secondary">Sessions: {sessions.length}</Badge>
            <Badge variant="secondary">Active: {activeSessions}</Badge>
            <Badge variant="secondary">TTL: {currentTtl} min</Badge>
          </div>
        </CardHeader>

        <CardContent>
          <Accordion type="multiple" defaultValue={["create-user", "settings", "users", "sessions"]} className="w-full">
            <AccordionItem value="create-user">
              <AccordionTrigger className="text-sm">New User Creation</AccordionTrigger>
              <AccordionContent>
                <div className="rounded-xl border p-4">
                  <div className="mb-4 flex items-center gap-2 text-sm font-medium">
                    <UserPlus className="h-4 w-4" />
                    Add a new dashboard user
                  </div>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    <div className="space-y-2">
                      <Label htmlFor="new-username">Username</Label>
                      <Input id="new-username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Enter username" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="new-password">Password</Label>
                      <Input id="new-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter password" />
                    </div>
                    <div className="space-y-2">
                      <Label>Role</Label>
                      <Select value={role} onValueChange={(value) => setRole(value as "admin" | "user")}>
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
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                      This section stays open by default so new user creation is always visible.
                    </p>
                    <Button
                      onClick={() => createUserMutation.mutate()}
                      disabled={createUserMutation.isPending || !username || !password}
                    >
                      {createUserMutation.isPending ? "Creating..." : "Create User"}
                    </Button>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="settings">
              <AccordionTrigger className="text-sm">Session, Timezone, and Sync Settings</AccordionTrigger>
              <AccordionContent>
                <div className="grid gap-4 xl:grid-cols-3">
                  <div className="rounded-xl border p-4">
                    <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                      <Timer className="h-4 w-4" />
                      Session Timeout
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs">Session Timeout (minutes)</Label>
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          type="number"
                          className="w-28"
                          min="5"
                          value={sessionTtl ?? currentTtl}
                          onChange={(event) => setSessionTtl(Number(event.target.value))}
                        />
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => sessionTtl && updateSessionTtlMutation.mutate(sessionTtl)}
                          disabled={updateSessionTtlMutation.isPending || !sessionTtl || sessionTtl === currentTtl || sessionTtl < 5}
                        >
                          Save
                        </Button>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Current: {currentTtl} min ({(currentTtl / 60).toFixed(1)} hours).
                      </p>
                    </div>
                  </div>

                  <div className="rounded-xl border p-4">
                    <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                      <Globe2 className="h-4 w-4" />
                      Global Timezone
                    </div>
                    <div className="space-y-3">
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
                      <p className="text-[11px] text-muted-foreground">
                        Current server display time: {formatDateTime(new Date().toISOString(), configuredTimezone)}
                      </p>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => updateTimezoneMutation.mutate(configuredTimezone)}
                        disabled={updateTimezoneMutation.isPending || configuredTimezone === currentTimezone}
                      >
                        Save Timezone
                      </Button>
                    </div>
                  </div>

                  <div className="rounded-xl border p-4">
                    <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                      <CloudUpload className="h-4 w-4" />
                      Google Drive Sync
                    </div>
                    <div className="space-y-3">
                      <div className="space-y-2">
                        <Label className="text-xs">Drive Folder</Label>
                        <Input value={syncFolderName} onChange={(event) => setSyncFolderName(event.target.value)} />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs">Service JSON Path</Label>
                        <Input value={syncCredentialsPath} onChange={(event) => setSyncCredentialsPath(event.target.value)} />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs">Drive Root Folder ID</Label>
                        <Input value={syncDriveRootFolderId} onChange={(event) => setSyncDriveRootFolderId(event.target.value)} />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant={googleSyncData?.configured ? "default" : "secondary"}>
                          {googleSyncData?.configured ? "Configured" : "Missing JSON"}
                        </Badge>
                        <Badge variant={googleSyncData?.enabled ? "default" : "secondary"}>
                          {googleSyncData?.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        <p>Service: {googleSyncData?.serviceEmail || "Not detected yet"}</p>
                        <p>Root ID: {googleSyncData?.driveRootFolderId || "Not set"}</p>
                        <p>Last sync: {formatDateTime(googleSyncData?.lastSyncAt, currentTimezone)}</p>
                        <p>Last scope: {googleSyncData?.lastSyncScope || "/"}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
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
                      {googleSyncData?.lastError ? <p className="text-[11px] text-destructive">{googleSyncData.lastError}</p> : null}
                    </div>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="users">
              <AccordionTrigger className="text-sm">Users Directory</AccordionTrigger>
              <AccordionContent>
                <div className="max-h-[420px] space-y-3 overflow-y-auto pr-1">
                  {users.length === 0 ? <p className="text-sm text-muted-foreground">No users found.</p> : null}
                  {users.map((user) => (
                    <div key={user.id} className="rounded-xl border p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{user.username}</span>
                        <Badge variant={user.role === "admin" ? "default" : "secondary"}>{user.role}</Badge>
                        <span className="text-xs text-muted-foreground">{user.active ? "active" : "disabled"}</span>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setPasswordChangeUserId(passwordChangeUserId === user.id ? null : user.id);
                            setNewPassword("");
                          }}
                        >
                          <KeyRound className="mr-2 h-3.5 w-3.5" />
                          Change Password
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => revokeUserSessionsMutation.mutate(user.id)}
                          disabled={revokeUserSessionsMutation.isPending}
                        >
                          <LogOut className="mr-2 h-3.5 w-3.5" />
                          Clear Sessions
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-destructive"
                          onClick={() => deleteUserMutation.mutate(user.id)}
                          disabled={deleteUserMutation.isPending}
                        >
                          <Trash2 className="mr-2 h-3.5 w-3.5" />
                          Delete
                        </Button>
                      </div>

                      {passwordChangeUserId === user.id ? (
                        <div className="mt-3 flex flex-col gap-2 rounded-lg border bg-background p-3 sm:flex-row">
                          <Input
                            type="password"
                            placeholder="New password"
                            value={newPassword}
                            onChange={(event) => setNewPassword(event.target.value)}
                            className="sm:flex-1"
                          />
                          <Button
                            size="sm"
                            disabled={!newPassword || changePasswordMutation.isPending}
                            onClick={() => changePasswordMutation.mutate({ userId: user.id, password: newPassword })}
                          >
                            {changePasswordMutation.isPending ? "Saving..." : "Save Password"}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="sessions">
              <AccordionTrigger className="text-sm">Active Sessions</AccordionTrigger>
              <AccordionContent>
                <div className="mb-3 flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => purgeInactiveSessionsMutation.mutate()}
                    disabled={purgeInactiveSessionsMutation.isPending}
                  >
                    Remove Expired
                  </Button>
                </div>
                <div className="max-h-[420px] space-y-3 overflow-y-auto pr-1">
                  {sessions.length === 0 ? <p className="text-sm text-muted-foreground">No sessions found.</p> : null}
                  {sessions.map((session) => {
                    const active = isSessionActive(session);
                    return (
                      <div key={session.id} className="rounded-xl border p-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{session.username}</span>
                          <Badge variant="outline">{session.role}</Badge>
                          <Badge
                            variant={active ? "default" : "secondary"}
                            className={active ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : ""}
                          >
                            {active ? "ACTIVE" : session.revokedAt ? "REVOKED" : "EXPIRED"}
                          </Badge>
                        </div>
                        <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                          <p>Created: {formatDateTime(session.createdAt, currentTimezone)}</p>
                          <p>Last seen: {formatDateTime(session.lastSeenAt, currentTimezone)}</p>
                          <p>Expires: {formatDateTime(session.expiresAt, currentTimezone)}</p>
                        </div>
                        <div className="mt-3">
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive"
                            disabled={!active || revokeSessionMutation.isPending}
                            onClick={() => revokeSessionMutation.mutate(session.id)}
                          >
                            <Ban className="mr-2 h-3.5 w-3.5" />
                            Revoke Session
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      </Card>
    </section>
  );
}
