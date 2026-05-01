import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { DashboardHeader } from "./DashboardHeader";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: {
    authMe: vi.fn(),
    pipelineStatus: vi.fn(),
    schedules: vi.fn(),
    scheduleHistory: vi.fn(),
    preflight: vi.fn(),
    runPipeline: vi.fn(),
    updateSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
    triggerSchedule: vi.fn(),
    clearJobs: vi.fn(),
    job: vi.fn(),
    logout: vi.fn(),
    logoutAll: vi.fn(),
    clearOtherSessions: vi.fn(),
    setModel: vi.fn(),
    setTimezone: vi.fn(),
    setReverifyProvider: vi.fn(),
  },
}));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function renderHeader() {
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <DashboardHeader />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("DashboardHeader cron controls", () => {
  beforeEach(() => {
    queryClient.clear();
    vi.mocked(api.authMe).mockResolvedValue({
      user: {
        id: "user-1",
        username: "admin",
        role: "admin",
        active: true,
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
      },
      session: {
        id: "session-1",
        createdAt: "2026-04-13T00:00:00.000Z",
        expiresAt: "2026-04-14T00:00:00.000Z",
        lastSeenAt: "2026-04-13T00:00:00.000Z",
      },
      activeModel: "sonar-pro",
      availableModels: ["sonar-pro"],
      sessionTtlMinutes: 480,
      configuredTimezone: "UTC",
    });
    vi.mocked(api.pipelineStatus).mockResolvedValue({
      state: "idle",
      runningPipelines: 0,
      runningScripts: 0,
      queuedPipelines: 0,
      queuedScripts: 0,
      activeWorkloads: 0,
      enabledSchedules: 1,
      totalSchedules: 1,
    });
    vi.mocked(api.schedules).mockResolvedValue({
      schedules: [
        {
          id: "schedule-1",
          name: "Default Sequential Pipeline",
          cron: "*/30 * * * *",
          enabled: true,
          sequence: [],
          createdAt: "2026-04-13T00:00:00.000Z",
        },
      ],
    });
    vi.mocked(api.scheduleHistory).mockResolvedValue({ scheduleId: "schedule-1", history: [] });
    vi.mocked(api.updateSchedule).mockResolvedValue({
      schedule: {
        id: "schedule-1",
        name: "Default Sequential Pipeline",
        cron: "*/30 * * * *",
        enabled: true,
        sequence: [],
        createdAt: "2026-04-13T00:00:00.000Z",
      },
    });
    vi.mocked(api.setTimezone).mockResolvedValue({ configuredTimezone: "UTC" });
  });

  it("shows a Pause button for enabled schedules and disables them through the API", async () => {
    renderHeader();

    fireEvent.click(await screen.findByRole("button", { name: /controls/i }));
    const pauseButton = await screen.findByRole("button", { name: /pause/i });
    fireEvent.click(pauseButton);

    await waitFor(() => {
      expect(api.updateSchedule).toHaveBeenCalledWith("schedule-1", { enabled: false });
    });
  });

  it("shows an Enable button for disabled schedules and enables them through the API", async () => {
    vi.mocked(api.schedules).mockResolvedValueOnce({
      schedules: [
        {
          id: "schedule-1",
          name: "Default Sequential Pipeline",
          cron: "*/30 * * * *",
          enabled: false,
          sequence: [],
          createdAt: "2026-04-13T00:00:00.000Z",
        },
      ],
    });

    renderHeader();

    fireEvent.click(await screen.findByRole("button", { name: /controls/i }));
    const enableButton = await screen.findByRole("button", { name: /enable/i });
    fireEvent.click(enableButton);

    await waitFor(() => {
      expect(api.updateSchedule).toHaveBeenCalledWith("schedule-1", { enabled: true });
    });
  });
});
