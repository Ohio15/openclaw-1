/**
 * Syncs preset schedules to OpenClaw CronJobs.
 *
 * Uses a "preset:" naming convention to identify plugin-managed cron jobs.
 * On sync: adds new, updates changed, removes deleted preset cron jobs.
 */

import type { PresetConfig, ClaudeGatewayConfig } from "./types.js";

// Cron types matching OpenClaw's cron API responses.
// Defined locally since openclaw doesn't export cron types from plugin-sdk.

type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

type CronDelivery = {
  mode: "none" | "announce" | "webhook";
  channel?: string;
  to?: string;
  bestEffort?: boolean;
};

type CronPayload = {
  kind: "agentTurn";
  message: string;
  model?: string;
  timeoutSeconds?: number;
  deliver?: boolean;
  channel?: string;
  to?: string;
  bestEffortDeliver?: boolean;
};

export type CronJob = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: CronSchedule;
  sessionTarget: "main" | "isolated";
  wakeMode: "next-heartbeat" | "now";
  payload: CronPayload;
  delivery?: CronDelivery;
  state: Record<string, unknown>;
};

export type CronJobCreate = Omit<CronJob, "id" | "state"> & {
  state?: Record<string, unknown>;
  deleteAfterRun?: boolean;
};

const PRESET_PREFIX = "preset:";

function presetToCronJobName(presetName: string): string {
  return `${PRESET_PREFIX}${presetName}`;
}

function isPresetCronJob(job: CronJob): boolean {
  return job.name.startsWith(PRESET_PREFIX);
}

function presetNameFromCronJob(job: CronJob): string {
  return job.name.slice(PRESET_PREFIX.length);
}

function buildCronJobCreate(
  preset: PresetConfig,
  delivery?: ClaudeGatewayConfig["delivery"],
): CronJobCreate {
  const cronDelivery: CronDelivery | undefined =
    delivery && delivery.mode && delivery.mode !== "none"
      ? {
          mode: delivery.mode,
          channel: delivery.channel as any,
          to: delivery.to,
          bestEffort: true,
        }
      : undefined;

  return {
    name: presetToCronJobName(preset.name),
    description: `[Gateway Preset] ${preset.display_name}: ${preset.description}`,
    enabled: true,
    schedule: { kind: "cron", expr: preset.schedule! },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: `Execute your instructions. Report findings concisely.\n\nSystem context: You are the "${preset.display_name}" preset agent. ${preset.system_prompt}`,
      timeoutSeconds: 300,
      deliver: !!cronDelivery,
      channel: cronDelivery?.channel,
      to: cronDelivery?.to,
      bestEffortDeliver: true,
    },
    ...(cronDelivery ? { delivery: cronDelivery } : {}),
  };
}

export type CronApi = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<CronJob[]>;
  add: (job: CronJobCreate) => Promise<CronJob>;
  update: (id: string, patch: Record<string, unknown>) => Promise<CronJob>;
  remove: (id: string) => Promise<{ removed: boolean }>;
  run: (id: string, mode?: string) => Promise<unknown>;
};

export async function syncPresetsToCron(
  cron: CronApi,
  presets: PresetConfig[],
  delivery?: ClaudeGatewayConfig["delivery"],
  logger?: { info: (message: string) => void; warn: (message: string) => void },
): Promise<{ added: number; updated: number; removed: number }> {
  const log = logger ?? console;
  const scheduledPresets = presets.filter((p) => p.schedule);

  // Get existing preset cron jobs
  const allJobs = await cron.list({ includeDisabled: true });
  const existingPresetJobs = allJobs.filter(isPresetCronJob);
  const existingByName = new Map(existingPresetJobs.map((j) => [presetNameFromCronJob(j), j]));

  let added = 0;
  let updated = 0;
  let removed = 0;

  // Add or update
  const activePresetNames = new Set<string>();
  for (const preset of scheduledPresets) {
    activePresetNames.add(preset.name);
    const existing = existingByName.get(preset.name);

    if (!existing) {
      // New preset — add cron job
      const jobCreate = buildCronJobCreate(preset, delivery);
      await cron.add(jobCreate);
      log.info(`[claude-gateway] Created cron job for preset: ${preset.name} (${preset.schedule})`);
      added++;
    } else {
      // Existing — check if schedule changed
      const currentExpr =
        existing.schedule.kind === "cron" ? existing.schedule.expr : undefined;
      if (currentExpr !== preset.schedule) {
        await cron.update(existing.id, {
          schedule: { kind: "cron", expr: preset.schedule! },
          description: `[Gateway Preset] ${preset.display_name}: ${preset.description}`,
        });
        log.info(`[claude-gateway] Updated cron job for preset: ${preset.name} (${currentExpr} → ${preset.schedule})`);
        updated++;
      }
    }
  }

  // Remove cron jobs for presets that no longer exist or lost their schedule
  for (const [presetName, job] of existingByName) {
    if (!activePresetNames.has(presetName)) {
      await cron.remove(job.id);
      log.info(`[claude-gateway] Removed cron job for deleted preset: ${presetName}`);
      removed++;
    }
  }

  log.info(`[claude-gateway] Cron sync complete: +${added} ~${updated} -${removed}`);
  return { added, updated, removed };
}
