/**
 * HTTP route handler for preset API endpoints.
 *
 * Uses registerHttpHandler (prefix matching) instead of registerHttpRoute
 * (exact matching) because we need parameterized paths like /gateway/presets/:name.
 *
 * Endpoints:
 *   GET  /gateway/presets          — list all presets
 *   GET  /gateway/presets/:name    — get a single preset
 *   POST /gateway/presets/reload   — reload from disk
 *   POST /gateway/presets/:name/run — trigger preset execution
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { PresetStore } from "./preset-loader.js";

type CronApi = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<Array<{ id: string; name: string }>>;
  add: (job: Record<string, unknown>) => Promise<{ id: string }>;
  run: (id: string, mode: string) => Promise<unknown>;
};

type PresetRoutesDeps = {
  presetStore: PresetStore;
  reload: () => Promise<{ presetsLoaded: number; cronSync: unknown }>;
  getCron: () => CronApi | undefined;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};

const PREFIX = "/gateway/presets";

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-cache, must-revalidate",
  });
  res.end(payload);
}

function methodNotAllowed(res: ServerResponse): void {
  json(res, 405, { error: "Method not allowed" });
}

export function createPresetHttpHandler(deps: PresetRoutesDeps) {
  const { presetStore, reload, getCron, logger } = deps;

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    // Only handle paths under our prefix
    if (!pathname.startsWith(PREFIX)) {
      return false;
    }

    // Strip prefix to get the sub-path
    const sub = pathname.slice(PREFIX.length);
    const method = (req.method ?? "GET").toUpperCase();

    try {
      // GET /gateway/presets — list all presets
      if ((sub === "" || sub === "/") && method === "GET") {
        const presets = presetStore.listAll().map((p) => ({
          name: p.name,
          display_name: p.display_name,
          description: p.description,
          schedule: p.schedule,
          tags: p.tags,
          has_mcp: !!p.mcp_config,
        }));
        json(res, 200, { presets });
        return true;
      }

      // POST /gateway/presets/reload
      if (sub === "/reload" && method === "POST") {
        const result = await reload();
        json(res, 200, result);
        return true;
      }

      // POST /gateway/presets/:name/run
      const runMatch = sub.match(/^\/([^/]+)\/run$/);
      if (runMatch && method === "POST") {
        const name = decodeURIComponent(runMatch[1]);
        const preset = presetStore.get(name);
        if (!preset) {
          json(res, 404, { error: `Preset not found: ${name}` });
          return true;
        }

        const cron = getCron();
        if (!cron) {
          json(res, 503, { error: "Cron service not available" });
          return true;
        }

        try {
          const jobs = await cron.list({ includeDisabled: true });
          const cronJob = jobs.find((j) => j.name === `preset:${name}`);

          if (cronJob) {
            const result = await cron.run(cronJob.id, "force");
            json(res, 200, { preset: name, cronJobId: cronJob.id, result });
          } else {
            // Create a one-off job and run it
            const job = await cron.add({
              name: `preset:${name}`,
              description: `[Gateway Preset] ${preset.display_name}: ${preset.description}`,
              enabled: false,
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
            const result = await cron.run(job.id, "force");
            json(res, 200, { preset: name, cronJobId: job.id, oneOff: true, result });
          }
        } catch (e) {
          logger.error(`[claude-gateway] Preset run failed: ${e}`);
          json(res, 500, { error: `Run failed: ${e}` });
        }
        return true;
      }

      // GET /gateway/presets/:name — get preset details
      const nameMatch = sub.match(/^\/([^/]+)$/);
      if (nameMatch && method === "GET") {
        const name = decodeURIComponent(nameMatch[1]);
        const preset = presetStore.get(name);
        if (!preset) {
          json(res, 404, { error: `Preset not found: ${name}` });
          return true;
        }
        json(res, 200, { preset });
        return true;
      }

      // Path matches prefix but no specific route — check method
      if (sub === "" || sub === "/") {
        methodNotAllowed(res);
        return true;
      }

      // Unmatched sub-path under our prefix
      json(res, 404, { error: "Not found" });
      return true;
    } catch (e) {
      logger.error(`[claude-gateway] HTTP handler error: ${e}`);
      if (!res.headersSent) {
        json(res, 500, { error: "Internal server error" });
      }
      return true;
    }
  };
}
