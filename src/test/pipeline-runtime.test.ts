import { describe, expect, it } from "vitest";

import {
  computeNextScheduleRunAt,
  computePipelineProgress,
  parseScheduleIntervalFromCron,
  parseIntervalMinutesFromCron,
  parseProgressSignal,
} from "../../backend/lib/pipeline-runtime.js";

describe("pipeline runtime helpers", () => {
  it("parses every-N-minutes cron expressions", () => {
    expect(parseIntervalMinutesFromCron("*/30 * * * *")).toBe(30);
    expect(parseScheduleIntervalFromCron("*/1 * * * * *")).toMatchObject({
      unit: "seconds",
      interval: 1,
      milliseconds: 1000,
    });
    expect(parseIntervalMinutesFromCron("0 10 * * *")).toBeNull();
  });

  it("schedules the next run after cooldown from the last finish time", () => {
    const nextRunAt = computeNextScheduleRunAt(
      {
        cron: "*/15 * * * *",
        lastFinishedAt: "2026-05-01T10:00:00.000Z",
        nextRunAt: null,
      },
      new Date("2026-05-01T10:00:00.000Z"),
    );

    expect(nextRunAt).toBe("2026-05-01T10:15:00.000Z");
  });

  it("supports cooldown schedules with second-based demo intervals", () => {
    const nextRunAt = computeNextScheduleRunAt(
      {
        cron: "*/1 * * * * *",
        lastFinishedAt: "2026-05-01T10:00:00.000Z",
        nextRunAt: null,
      },
      new Date("2026-05-01T10:00:00.000Z"),
    );

    expect(nextRunAt).toBe("2026-05-01T10:00:01.000Z");
  });

  it("extracts determinate progress only from real counts", () => {
    expect(parseProgressSignal("[12/48] Processing records")).toMatchObject({
      mode: "determinate",
      current: 12,
      total: 48,
      progress: 25,
    });
    expect(parseProgressSignal("Preparing upload")).toBeNull();
  });

  it("computes pipeline progress from completed steps plus child progress", () => {
    expect(
      computePipelineProgress({
        totalSteps: 6,
        completedSteps: 2,
        currentStepProgress: 50,
      }),
    ).toBe(42);
  });
});
