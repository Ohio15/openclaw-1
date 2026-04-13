import { describe, it, expect, vi } from "vitest";
import { syncPresetsToCron, type CronApi, type CronJob } from "../src/preset-cron-sync.js";
import type { PresetConfig } from "../src/types.js";

describe("PresetCronSync", () => {
  const silentLogger = {
    info: () => {},
    warn: () => {},
  };

  function makePreset(overrides: Partial<PresetConfig> & { name: string }): PresetConfig {
    return {
      display_name: overrides.name,
      description: "",
      system_prompt: "",
      allowed_tools: [],
      tags: [],
      ...overrides,
    };
  }

  function makeCronJob(name: string, schedule: string): CronJob {
    return {
      id: `cron-${name}`,
      name: `preset:${name}`,
      enabled: true,
      schedule: { kind: "cron", expr: schedule },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "test",
        timeoutSeconds: 300,
      },
      state: {},
    };
  }

  function createMockCronApi(existingJobs: CronJob[] = []): CronApi {
    return {
      list: vi.fn().mockResolvedValue(existingJobs),
      add: vi.fn().mockImplementation(async (job) => ({
        ...job,
        id: `new-${job.name}`,
        state: {},
      })),
      update: vi.fn().mockImplementation(async (id, patch) => ({
        id,
        ...patch,
      })),
      remove: vi.fn().mockResolvedValue({ removed: true }),
      run: vi.fn().mockResolvedValue({}),
    };
  }

  it("creates cron jobs for scheduled presets", async () => {
    const cron = createMockCronApi([]);
    const presets = [
      makePreset({ name: "monitor", schedule: "0 * * * *" }),
      makePreset({ name: "backup", schedule: "0 0 * * *" }),
    ];

    const result = await syncPresetsToCron(cron, presets, undefined, silentLogger);

    expect(result.added).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.removed).toBe(0);
    expect(cron.add).toHaveBeenCalledTimes(2);

    const firstCall = (cron.add as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(firstCall.name).toBe("preset:monitor");
    expect(firstCall.schedule).toEqual({ kind: "cron", expr: "0 * * * *" });

    const secondCall = (cron.add as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(secondCall.name).toBe("preset:backup");
    expect(secondCall.schedule).toEqual({ kind: "cron", expr: "0 0 * * *" });
  });

  it("skips non-scheduled presets", async () => {
    const cron = createMockCronApi([]);
    const presets = [
      makePreset({ name: "no-schedule" }),
      makePreset({ name: "also-no-schedule" }),
    ];

    const result = await syncPresetsToCron(cron, presets, undefined, silentLogger);

    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.removed).toBe(0);
    expect(cron.add).not.toHaveBeenCalled();
  });

  it("updates cron job when schedule changes", async () => {
    const existingJob = makeCronJob("monitor", "0 * * * *");
    const cron = createMockCronApi([existingJob]);
    const presets = [
      makePreset({ name: "monitor", schedule: "*/30 * * * *" }),
    ];

    const result = await syncPresetsToCron(cron, presets, undefined, silentLogger);

    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.removed).toBe(0);
    expect(cron.update).toHaveBeenCalledWith(existingJob.id, expect.objectContaining({
      schedule: { kind: "cron", expr: "*/30 * * * *" },
    }));
  });

  it("removes cron job for deleted preset", async () => {
    const existingJob = makeCronJob("old-preset", "0 * * * *");
    const cron = createMockCronApi([existingJob]);
    // No presets — the old-preset is "deleted"
    const presets: PresetConfig[] = [];

    const result = await syncPresetsToCron(cron, presets, undefined, silentLogger);

    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.removed).toBe(1);
    expect(cron.remove).toHaveBeenCalledWith(existingJob.id);
  });

  it("no-op when nothing changed", async () => {
    const existingJob = makeCronJob("monitor", "0 * * * *");
    const cron = createMockCronApi([existingJob]);
    const presets = [
      makePreset({ name: "monitor", schedule: "0 * * * *" }),
    ];

    const result = await syncPresetsToCron(cron, presets, undefined, silentLogger);

    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.removed).toBe(0);
    expect(cron.add).not.toHaveBeenCalled();
    expect(cron.update).not.toHaveBeenCalled();
    expect(cron.remove).not.toHaveBeenCalled();
  });

  it("uses preset: naming convention", async () => {
    const cron = createMockCronApi([]);
    const presets = [
      makePreset({ name: "health-check", schedule: "*/5 * * * *" }),
    ];

    await syncPresetsToCron(cron, presets, undefined, silentLogger);

    const addedJob = (cron.add as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(addedJob.name).toBe("preset:health-check");
    expect(addedJob.name.startsWith("preset:")).toBe(true);
  });
});
