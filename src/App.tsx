import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { api } from "@/lib/api";
import Index from "./pages/Index.tsx";
import Login from "./pages/Login.tsx";
import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

const NOTIFICATION_SILENT_KEY = "blossom-notifications-silent";

const NotificationToaster = () => {
  const [silent, setSilent] = useState(() => (
    typeof window !== "undefined" && window.localStorage.getItem(NOTIFICATION_SILENT_KEY) === "1"
  ));

  useEffect(() => {
    const handleSilenceChange = (event: Event) => {
      const detail = (event as CustomEvent<{ silent?: boolean }>).detail;
      if (typeof detail?.silent === "boolean") {
        setSilent(detail.silent);
        return;
      }
      setSilent(window.localStorage.getItem(NOTIFICATION_SILENT_KEY) === "1");
    };
    window.addEventListener("blossom-notification-silence-change", handleSilenceChange);
    window.addEventListener("storage", handleSilenceChange);
    return () => {
      window.removeEventListener("blossom-notification-silence-change", handleSilenceChange);
      window.removeEventListener("storage", handleSilenceChange);
    };
  }, []);

  if (silent) {
    return null;
  }

  return <Sonner closeButton position="bottom-right" />;
};

const AuthGate = () => {
  const appQueryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["auth"],
    queryFn: api.authMe,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });

  useEffect(() => {
    const handleSessionExpiry = () => {
      appQueryClient.setQueryData(["auth"], null);
      appQueryClient.invalidateQueries();
    };
    window.addEventListener("blossom-auth-expired", handleSessionExpiry);
    return () => window.removeEventListener("blossom-auth-expired", handleSessionExpiry);
  }, [appQueryClient]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.16),transparent_42%),linear-gradient(135deg,#0f172a_0%,#111827_52%,#030712_100%)] px-4 text-sm text-slate-300">
        Checking session...
      </div>
    );
  }

  if (isError || !data?.user) {
    return <Login />;
  }

  return <Index />;
};

const GoogleOAuthRedirect = () => {
  useEffect(() => {
    window.location.replace(api.googleOAuthUrl());
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-sm text-muted-foreground">
      Redirecting to Google OAuth...
    </div>
  );
};

const App = () => (
  <ThemeProvider>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <NotificationToaster />
        <BrowserRouter>
          <Routes>
            <Route path="/auth/google" element={<GoogleOAuthRedirect />} />
            <Route path="/" element={<AuthGate />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  </ThemeProvider>
);

export default App;
