import { describe, it, expect, beforeEach, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createPresetHttpHandler } from "../src/preset-routes.js";
import type { PresetStore } from "../src/preset-loader.js";
import type { PresetConfig } from "../src/types.js";

describe("PresetRoutes", () => {
  const silentLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const samplePresets: PresetConfig[] = [
    {
      name: "monitor",
      display_name: "System Monitor",
      description: "Monitors health",
      system_prompt: "You monitor",
      allowed_tools: ["bash"],
      tags: ["ops"],
      schedule: "0 * * * *",
    },
    {
      name: "deploy",
      display_name: "Deployer",
      description: "Deploys things",
      system_prompt: "You deploy",
      allowed_tools: ["bash", "git"],
      tags: ["ci"],
    },
  ];

  let presetStore: PresetStore;
  let reloadFn: ReturnType<typeof vi.fn>;
  let handler: ReturnType<typeof createPresetHttpHandler>;

  beforeEach(() => {
    const presetsMap = new Map(samplePresets.map((p) => [p.name, p]));
    presetStore = {
      presets: presetsMap,
      get: (name: string) => presetsMap.get(name),
      listAll: () => [...presetsMap.values()],
      scheduled: () => [...presetsMap.values()].filter((p) => p.schedule),
      reload: () => {},
    };
    reloadFn = vi.fn().mockResolvedValue({ presetsLoaded: 2, cronSync: { added: 0, updated: 0, removed: 0 } });

    handler = createPresetHttpHandler({
      presetStore,
      reload: reloadFn,
      getCron: () => undefined,
      logger: silentLogger,
    });
  });

  function mockReq(method: string, url: string): IncomingMessage {
    const readable = new Readable({ read() { this.push(null); } });
    Object.assign(readable, {
      method,
      url,
      headers: {},
      httpVersion: "1.1",
      httpVersionMajor: 1,
      httpVersionMinor: 1,
    });
    return readable as unknown as IncomingMessage;
  }

  function mockRes(): ServerResponse & { _status: number; _headers: Record<string, string>; _body: string } {
    const headers: Record<string, string> = {};
    let body = "";
    let status = 200;
    const res = {
      _status: status,
      _headers: headers,
      _body: body,
      headersSent: false,
      writeHead(s: number, h?: Record<string, string>) {
        res._status = s;
        if (h) {
          for (const [k, v] of Object.entries(h)) {
            res._headers[k.toLowerCase()] = v;
          }
        }
        return res;
      },
      setHeader(k: string, v: string) {
        res._headers[k.toLowerCase()] = v;
        return res;
      },
      end(chunk?: string | Buffer) {
        if (chunk) {
          res._body += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        }
        res.headersSent = true;
        return res;
      },
    };
    return res as unknown as ServerResponse & { _status: number; _headers: Record<string, string>; _body: string };
  }

  it("GET /gateway/presets returns preset list", async () => {
    const req = mockReq("GET", "/gateway/presets");
    const res = mockRes();
    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res._status).toBe(200);

    const data = JSON.parse(res._body);
    expect(data.presets).toHaveLength(2);
    expect(data.presets[0].name).toBe("monitor");
    expect(data.presets[0].display_name).toBe("System Monitor");
    expect(data.presets[0].schedule).toBe("0 * * * *");
    expect(data.presets[1].name).toBe("deploy");
  });

  it("GET /gateway/presets/:name returns single preset", async () => {
    const req = mockReq("GET", "/gateway/presets/monitor");
    const res = mockRes();
    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res._status).toBe(200);

    const data = JSON.parse(res._body);
    expect(data.preset.name).toBe("monitor");
    expect(data.preset.display_name).toBe("System Monitor");
    expect(data.preset.system_prompt).toBe("You monitor");
  });

  it("GET /gateway/presets/nonexistent returns 404", async () => {
    const req = mockReq("GET", "/gateway/presets/nonexistent");
    const res = mockRes();
    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res._status).toBe(404);

    const data = JSON.parse(res._body);
    expect(data.error).toContain("not found");
  });

  it("POST /gateway/presets/reload triggers reload", async () => {
    const req = mockReq("POST", "/gateway/presets/reload");
    const res = mockRes();
    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(reloadFn).toHaveBeenCalledOnce();

    const data = JSON.parse(res._body);
    expect(data.presetsLoaded).toBe(2);
  });

  it("non-matching paths return false", async () => {
    const req = mockReq("GET", "/other/path");
    const res = mockRes();
    const handled = await handler(req, res);

    expect(handled).toBe(false);
  });

  it("correct Content-Type headers", async () => {
    const req = mockReq("GET", "/gateway/presets");
    const res = mockRes();
    await handler(req, res);

    expect(res._headers["content-type"]).toContain("application/json");
    expect(res._headers["content-type"]).toContain("charset=utf-8");
  });
});
