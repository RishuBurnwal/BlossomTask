import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
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

const App = () => (
  <ThemeProvider>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<AuthGate />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  </ThemeProvider>
);

export default App;
