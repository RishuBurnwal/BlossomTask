import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { DashboardHeader } from "./DashboardHeader";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: {
    pipelineStatus: vi.fn(),
    schedules: vi.fn(),
    scheduleHistory: vi.fn(),
    jobs: vi.fn(),
    preflight: vi.fn(),
    runPipeline: vi.fn(),
    updateSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
    triggerSchedule: vi.fn(),
    clearJobs: vi.fn(),
    job: vi.fn(),
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
    vi.mocked(api.jobs).mockResolvedValue({ jobs: [] });
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
  });

  it("shows a Stop Cron button for enabled schedules and disables them through the API", async () => {
    renderHeader();

    const stopButton = await screen.findByRole("button", { name: /stop cron/i });
    fireEvent.click(stopButton);

    await waitFor(() => {
      expect(api.updateSchedule).toHaveBeenCalledWith("schedule-1", { enabled: false });
    });
  });

  it("shows a Start Cron button for disabled schedules and enables them through the API", async () => {
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

    const startButton = await screen.findByRole("button", { name: /start cron/i });
    fireEvent.click(startButton);

    await waitFor(() => {
      expect(api.updateSchedule).toHaveBeenCalledWith("schedule-1", { enabled: true });
    });
  });
});