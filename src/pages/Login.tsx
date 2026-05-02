import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Shield, Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { toast } from "sonner";

export default function Login() {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    const maybeStored = window.sessionStorage.getItem("blossom_username") || "";
    if (maybeStored) {
      setUsername(maybeStored);
    }
  }, []);

  const loginMutation = useMutation({
    mutationFn: () => api.login(username, password),
    onSuccess: (_data) => {
      window.sessionStorage.setItem("blossom_username", username);
      queryClient.invalidateQueries({ queryKey: ["auth"] });
      toast.success("Session started");
      setPassword("");
    },
    onError: (error) => toast.error(error.message || "Login failed"),
  });

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.16),transparent_42%),linear-gradient(135deg,#0f172a_0%,#111827_52%,#030712_100%)] px-4 py-10 text-slate-50">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-6xl items-center justify-center">
        <div className="grid w-full gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="flex flex-col justify-center space-y-6 p-4 lg:p-10">
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs uppercase tracking-[0.35em] text-emerald-200">
              <Sparkles className="h-3.5 w-3.5" />
              BlossomTask Access
            </div>
            <h1 className="max-w-xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              Secure the pipeline, then let the operators move fast.
            </h1>
            <p className="max-w-lg text-sm leading-6 text-slate-300 sm:text-base">
              Sign in to manage scripts, run pipelines, switch models, and review real job telemetry from a single control plane.
            </p>
          </div>

          <Card className="border-white/10 bg-slate-950/70 text-slate-50 shadow-2xl backdrop-blur">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-2xl">
                <Shield className="h-5 w-5 text-emerald-300" />
                Login
              </CardTitle>
              <CardDescription className="text-slate-300">
                Use the shared SQLite account store to enter the dashboard.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username" className="text-slate-200">Username</Label>
                <Input
                  id="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  className="border-white/10 bg-white/5 text-white placeholder:text-slate-400"
                  placeholder="admin"
                  autoComplete="username"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password" className="text-slate-200">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="border-white/10 bg-white/5 text-white placeholder:text-slate-400"
                  placeholder="••••••••"
                  autoComplete="current-password"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      loginMutation.mutate();
                    }
                  }}
                />
              </div>
              <Button
                className="w-full gap-2 bg-emerald-500 text-slate-950 hover:bg-emerald-400"
                onClick={() => loginMutation.mutate()}
                disabled={loginMutation.isPending}
              >
                {loginMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {loginMutation.isPending ? "Signing in..." : "Enter System"}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}