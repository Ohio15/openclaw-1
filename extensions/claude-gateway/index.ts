/**
 * Claude Gateway Plugin for OpenClaw
 *
 * Loads YAML preset files and registers scheduled ones as OpenClaw CronJobs.
 * Scans agent output for alert keywords and delivers notifications via channels.
 * Provides HTTP REST API for presets and serves the Gateway PWA.
 *
 * Replaces the standalone Claude Gateway FastAPI service with an integrated plugin.
 *
 * Hook points:
 *   gateway_start — load presets, sync to cron
 *   agent_end     — scan for alert keywords, deliver notifications
 *
 * Gateway methods:
 *   preset.list   — list all loaded presets
 *   preset.get    — get a preset by name
 *   preset.run    — trigger a preset run via cron.run()
 *   preset.reload — reload presets from disk and re-sync cron
 *
 * HTTP handlers:
 *   /gateway/presets/*  — REST API for presets
 *   /gateway/ui/*       — PWA static file serving
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createPresetLoader, type PresetStore } from "./src/preset-loader.js";
import { syncPresetsToCron, type CronApi } from "./src/preset-cron-sync.js";
import { createAlertKeywordHandler } from "./src/preset-alert-keywords.js";
import { createPresetHttpHandler } from "./src/preset-routes.js";
import { createPwaHttpHandler } from "./src/pwa-routes.js";
import { registerMigrateCli } from "./src/migrate.js";
import type { ClaudeGatewayConfig } from "./src/types.js";

let presetStore: PresetStore | undefined;

const claudeGatewayPlugin = {
  id: "claude-gateway",
  name: "Claude Gateway",
  description: "YAML preset loader with scheduled agent execution via cron",

  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as ClaudeGatewayConfig;
    if (cfg.enabled === false) {
      api.logger.info("[claude-gateway] Plugin disabled via config");
      return;
    }

    const presetsDir = cfg.presetsDir
      ? api.resolvePath(cfg.presetsDir)
      : api.resolvePath("./presets");

    // Cron reference captured from gateway method calls for use by the HTTP handler.
    // HTTP handlers don't receive GatewayRequestContext, so we grab it opportunistically.
    let cronRef: CronApi | undefined;

    // Load presets synchronously at registration time
    presetStore = createPresetLoader(presetsDir, api.logger);

    // Alert keyword handler
    const { handler: alertHandler, alertHistory } = createAlertKeywordHandler({
      keywords: cfg.alertKeywords,
      logger: api.logger,
    });

    // Hook: agent_end — scan for alert keywords
    api.on("agent_end", alertHandler);

    // Hook: gateway_start — sync presets to cron
    api.on("gateway_start", async () => {
      api.logger.info(`[claude-gateway] Gateway started, syncing ${presetStore!.scheduled().length} scheduled presets to cron`);
    });

    // Gateway method: preset.list
    api.registerGatewayMethod("preset.list", ({ respond, context }) => {
      // Capture cron reference for the HTTP handler
      if (!cronRef && context?.cron) cronRef = context.cron as unknown as CronApi;
      if (!presetStore) {
        respond(false, undefined, { code: -1, message: "Presets not loaded" });
        return;
      }
      const presets = presetStore.listAll().map((p) => ({
        name: p.name,
        display_name: p.display_name,
        description: p.description,
        schedule: p.schedule,
        tags: p.tags,
        has_mcp: !!p.mcp_config,
      }));
      respond(true, { presets });
    });

    // Gateway method: preset.get
    api.registerGatewayMethod("preset.get", ({ params, respond }) => {
      if (!presetStore) {
        respond(false, undefined, { code: -1, message: "Presets not loaded" });
        return;
      }
      const name = (params as { name?: string })?.name;
      if (!name) {
        respond(false, undefined, { code: -1, message: "Missing 'name' parameter" });
        return;
      }
      const preset = presetStore.get(name);
      if (!preset) {
        respond(false, undefined, { code: -1, message: `Preset not found: ${name}` });
        return;
      }
      respond(true, { preset });
    });

    // Gateway method: preset.run
    api.registerGatewayMethod("preset.run", async ({ params, respond, context }) => {
      // Capture cron reference for the HTTP handler
      if (!cronRef) cronRef = context.cron as unknown as CronApi;
      if (!presetStore) {
        respond(false, undefined, { code: -1, message: "Presets not loaded" });
        return;
      }
      const name = (params as { name?: string })?.name;
      if (!name) {
        respond(false, undefined, { code: -1, message: "Missing 'name' parameter" });
        return;
      }
      const preset = presetStore.get(name);
      if (!preset) {
        respond(false, undefined, { code: -1, message: `Preset not found: ${name}` });
        return;
      }

      // Find the corresponding cron job and run it, or create a one-off
      try {
        const jobs = await context.cron.list({ includeDisabled: true });
        const cronJob = jobs.find((j: any) => j.name === `preset:${name}`);

        if (cronJob) {
          // Run existing cron job in force mode
          const result = await context.cron.run(cronJob.id, "force");
          respond(true, { preset: name, cronJobId: cronJob.id, result });
        } else {
          // No cron job exists — create a one-off and run it
          const job = await context.cron.add({
            name: `preset:${name}`,
            description: `[Gateway Preset] ${preset.display_name}: ${preset.description}`,
            enabled: false, // disabled — one-off only
            deleteAfterRun: true,
            schedule: { kind: "at", at: new Date().toISOString() },
            sessionTarget: "isolated",
            wakeMode: "now",
            payload: {
              kind: "agentTurn",
              message: `Execute your instructions. Report findings concisely.\n\nSystem context: You are the "${preset.display_name}" preset agent. ${preset.system_prompt}`,
              timeoutSeconds: 300,
            },
          });
          const result = await context.cron.run(job.id, "force");
          respond(true, { preset: name, cronJobId: job.id, oneOff: true, result });
        }
      } catch (e) {
        respond(false, undefined, { code: -1, message: `Run failed: ${e}` });
      }
    });

    // Gateway method: preset.reload
    api.registerGatewayMethod("preset.reload", async ({ respond, context }) => {
      // Capture cron reference for the HTTP handler
      if (!cronRef) cronRef = context.cron as unknown as CronApi;
      if (!presetStore) {
        respond(false, undefined, { code: -1, message: "Presets not loaded" });
        return;
      }
      presetStore.reload();
      const cron = context.cron as CronApi;
      const result = await syncPresetsToCron(cron, presetStore.listAll(), cfg.delivery, api.logger);
      respond(true, {
        presetsLoaded: presetStore.listAll().length,
        cronSync: result,
      });
    });

    // Gateway method: preset.alerts
    api.registerGatewayMethod("preset.alerts", ({ respond }) => {
      respond(true, { alerts: alertHistory.slice(-100) });
    });

    // ── HTTP Handlers ───────────────────────────────────────

    // Preset REST API handler
    const presetHttpHandler = createPresetHttpHandler({
      presetStore: presetStore!,
      reload: async () => {
        presetStore!.reload();
        if (cronRef) {
          const cronResult = await syncPresetsToCron(cronRef, presetStore!.listAll(), cfg.delivery, api.logger);
          return { presetsLoaded: presetStore!.listAll().length, cronSync: cronResult };
        }
        return { presetsLoaded: presetStore!.listAll().length, cronSync: null };
      },
      getCron: () => cronRef,
      logger: api.logger,
    });

    api.registerHttpHandler(presetHttpHandler);

    // PWA static file handler
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const pwaDir = path.resolve(thisDir, "src", "pwa");
    const pwaHttpHandler = createPwaHttpHandler(pwaDir);

    api.registerHttpHandler(pwaHttpHandler);

    // CLI: gateway:migrate command
    api.registerCli(
      ({ program }) => {
        registerMigrateCli(program);
      },
      { commands: ["gateway:migrate"] },
    );

    api.logger.info(`[claude-gateway] Registered with ${presetStore.listAll().length} presets (${presetStore.scheduled().length} scheduled)`);
    api.logger.info(`[claude-gateway] HTTP handlers: /gateway/presets/* and /gateway/ui/*`);
  },

  async activate(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as ClaudeGatewayConfig;
    if (cfg.enabled === false || !presetStore) return;

    // Perform initial cron sync on activation (gateway is running at this point)
    // The actual sync happens when the first preset.reload is called or via the gateway_start hook.
    api.logger.info("[claude-gateway] Plugin activated — presets ready for cron sync");
    api.logger.info("[claude-gateway] PWA available at /gateway/ui/");
  },
};

export default claudeGatewayPlugin;
