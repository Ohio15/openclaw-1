import fs from "node:fs";
import fsp from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webauthnPlugin from "../index.js";
import { PasskeyStore } from "../src/passkey-store.js";

const isWindows = process.platform === "win32";
const GATEWAY_TOKEN = "gateway-token-for-tests";

type LogLine = { level: string; msg: string };
type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
type Service = {
  id: string;
  start: (ctx: Record<string, unknown>) => void | Promise<void>;
  stop?: (ctx: Record<string, unknown>) => void | Promise<void>;
};

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

function mockReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  const readable = new Readable({
    read() {
      this.push(null);
    },
  });
  Object.assign(readable, { method, url, headers: { host: "localhost", ...headers } });
  return readable as unknown as IncomingMessage;
}

type CapturedRes = { status: number; headers: Record<string, string>; body: string };

function mockRes(): { res: ServerResponse; captured: CapturedRes } {
  const captured: CapturedRes = { status: 0, headers: {}, body: "" };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      captured.headers = headers ?? {};
      return res;
    },
    end(chunk?: string) {
      captured.body += chunk ?? "";
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

describe("webauthn plugin lifecycle", () => {
  let tmpDir: string;
  let stateDir: string;
  let logs: LogLine[];
  let consoleOutput: string[];

  const logger = {
    info: (msg: string) => logs.push({ level: "info", msg }),
    warn: (msg: string) => logs.push({ level: "warn", msg }),
    error: (msg: string) => logs.push({ level: "error", msg }),
    debug: (msg: string) => logs.push({ level: "debug", msg }),
  };

  function loadPlugin(pluginConfig: Record<string, unknown> = {}) {
    let httpHandler: HttpHandler | null = null;
    let service: Service | null = null;
    const api = {
      id: "webauthn",
      name: "webauthn",
      source: "test",
      config: { gateway: { auth: { token: GATEWAY_TOKEN } } },
      pluginConfig: { rpId: "localhost", origin: "https://localhost", ...pluginConfig },
      runtime: {},
      logger,
      registerHttpHandler: (h: HttpHandler) => {
        httpHandler = h;
      },
      registerService: (s: Service) => {
        service = s;
      },
      registerGatewayMethod: () => {},
      resolvePath: (p: string) => path.resolve(p),
    };
    webauthnPlugin.register(api as unknown as Parameters<typeof webauthnPlugin.register>[0]);
    if (!httpHandler || !service) {
      throw new Error("plugin did not register its handler and service");
    }
    const svc: Service = service;
    const ctx = { config: {}, stateDir, logger };
    return {
      handler: httpHandler as HttpHandler,
      start: () => svc.start(ctx),
      stop: () => svc.stop?.(ctx),
    };
  }

  async function request(handler: HttpHandler, method: string, url: string, headers = {}) {
    const { res, captured } = mockRes();
    await handler(mockReq(method, url, headers), res);
    return captured;
  }

  /** Every string the plugin emitted through the logger or the process streams. */
  function allOutput(): string {
    return [...logs.map((l) => l.msg), ...consoleOutput].join("\n");
  }

  const tokenFile = () => path.join(stateDir, "webauthn", "setup-token");
  const readToken = () => fs.readFileSync(tokenFile(), "utf-8").trim();

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-webauthn-lifecycle-"));
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir);
    logs = [];
    consoleOutput = [];
    // The plugin prefers the env gateway token over config; pin the config one.
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
    const capture =
      (sink: string[]) =>
      (...args: unknown[]) => {
        sink.push(args.map(String).join(" "));
      };
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation(capture(consoleOutput));
    }
    const streamCapture = (chunk: unknown) => {
      consoleOutput.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(streamCapture as never);
    vi.spyOn(process.stderr, "write").mockImplementation(streamCapture as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("writes the startup setup token to a state-dir file and never to logs or stdout", async () => {
    const plugin = loadPlugin();
    await plugin.start();

    const token = readToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(allOutput()).not.toContain(token);
    // The operator is told where to find it.
    expect(logs.some((l) => l.msg.includes(tokenFile()))).toBe(true);
    plugin.stop();
  });

  it.skipIf(isWindows)("creates the token file 0600 inside a 0700 webauthn dir", async () => {
    const plugin = loadPlugin();
    await plugin.start();

    expect(mode(tokenFile())).toBe(0o600);
    expect(mode(path.join(stateDir, "webauthn"))).toBe(0o700);
    plugin.stop();
  });

  it.skipIf(isWindows)(
    "narrows a pre-existing world-readable webauthn dir and passkeys file",
    async () => {
      const dir = path.join(stateDir, "webauthn");
      fs.mkdirSync(dir, { mode: 0o755 });
      fs.chmodSync(dir, 0o755);
      const passkeysPath = path.join(dir, "passkeys.json");
      fs.writeFileSync(passkeysPath, JSON.stringify([{ id: "a", public_key: "b" }]), {
        mode: 0o644,
      });
      fs.chmodSync(passkeysPath, 0o644);

      const plugin = loadPlugin();
      await plugin.start();

      expect(mode(dir)).toBe(0o700);
      expect(mode(passkeysPath)).toBe(0o600);
      plugin.stop();
    },
  );

  it("serves the registration page without embedding the setup token", async () => {
    const plugin = loadPlugin();
    await plugin.start();
    const token = readToken();

    const page = await request(plugin.handler, "GET", "/auth/register");
    expect(page.status).toBe(200);
    expect(page.body).not.toContain(token);
    expect(page.body).toContain("location.hash");
    plugin.stop();
  });

  it("admin endpoint returns a new token in the response only, and retires the token file", async () => {
    const plugin = loadPlugin();
    await plugin.start();
    const startupToken = readToken();

    const denied = await request(plugin.handler, "POST", "/auth/passkey/admin/new-setup-token");
    expect(denied.status).toBe(401);

    const issued = await request(plugin.handler, "POST", "/auth/passkey/admin/new-setup-token", {
      authorization: `Bearer ${GATEWAY_TOKEN}`,
    });
    expect(issued.status).toBe(200);
    expect(issued.headers["Cache-Control"]).toBe("no-store");
    const newToken = (JSON.parse(issued.body) as { setup_token: string }).setup_token;
    expect(newToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken).not.toBe(startupToken);

    expect(allOutput()).not.toContain(newToken);
    expect(allOutput()).not.toContain(startupToken);
    expect(fs.existsSync(tokenFile())).toBe(false);
    plugin.stop();
  });

  it("keeps passkeys across a restart and keeps registration closed", async () => {
    const first = loadPlugin();
    await first.start();
    expect(fs.existsSync(tokenFile())).toBe(true);
    first.stop();

    // A passkey registered by the first run.
    const defaultPath = path.join(stateDir, "webauthn", "passkeys.json");
    new PasskeyStore(defaultPath, logger).add({
      id: "cred-1",
      public_key: "pk-1",
      sign_count: 0,
      name: "Phone",
      registered_at: 1,
    });

    // Simulated restart: fresh plugin instance, same state dir.
    const second = loadPlugin();
    await second.start();

    expect(new PasskeyStore(defaultPath, logger).hasCredentials).toBe(true);
    expect(fs.existsSync(tokenFile())).toBe(false);
    const page = await request(second.handler, "GET", "/auth/register");
    expect(page.status).toBe(403);
    second.stop();
  });

  it("resolves a relative passkeysPath against the state dir, not the cwd", async () => {
    const plugin = loadPlugin({ passkeysPath: "custom/passkeys.json" });
    await plugin.start();

    const expected = path.join(stateDir, "custom", "passkeys.json");
    expect(fs.existsSync(path.dirname(expected))).toBe(true);
    expect(logs.some((l) => l.msg.includes(`passkeys: ${expected}`))).toBe(true);
    expect(logs.some((l) => l.level === "warn" && l.msg.includes("outside the state dir"))).toBe(
      false,
    );
    plugin.stop();
  });

  it("warns when passkeysPath is outside the state dir, and creates its parent dir", async () => {
    const outside = path.join(tmpDir, "elsewhere", "nested", "passkeys.json");
    const plugin = loadPlugin({ passkeysPath: outside });
    await plugin.start();

    expect(fs.existsSync(path.dirname(outside))).toBe(true);
    expect(logs.some((l) => l.level === "warn" && l.msg.includes("outside the state dir"))).toBe(
      true,
    );
    plugin.stop();
  });

  it("refuses to start when passkey storage is not writable, and /auth fails closed", async () => {
    const blocker = path.join(tmpDir, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    const plugin = loadPlugin({ passkeysPath: path.join(blocker, "passkeys.json") });

    expect(() => plugin.start()).toThrow(/not writable/);
    expect(fs.existsSync(tokenFile())).toBe(false);

    const res = await request(plugin.handler, "GET", "/auth/register");
    expect(res.status).toBe(503);
  });
});
