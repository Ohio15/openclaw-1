import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createDeviceQrHandler,
  generateHmac,
  type PendingDevicesMap,
  type DeviceQrRoutesDeps,
} from "../src/device-qr-routes.js";
import { PasskeyStore } from "../src/passkey-store.js";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("DeviceQrRoutes", () => {
  const silentLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };

  let tmpDir: string;
  let pendingDevices: PendingDevicesMap;
  let handler: ReturnType<typeof createDeviceQrHandler>;
  let store: PasskeyStore;
  const hmacSecret = "test-hmac-secret-value";

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-qr-test-"));
    const storePath = path.join(tmpDir, "passkeys.json");
    store = new PasskeyStore(storePath, silentLogger);
    pendingDevices = new Map();

    const deps: DeviceQrRoutesDeps = {
      config: {
        rpId: "localhost",
        rpName: "OpenClaw Test",
        origin: "http://localhost:3000",
        userName: "testowner",
        userDisplayName: "Test Owner",
        passkeysPath: storePath,
        deviceApprovalToken: "approval-token-123",
        hmacSecret,
      },
      store,
      pendingDevices,
      logger: silentLogger,
      getHmacSecret: () => hmacSecret,
    };

    handler = createDeviceQrHandler(deps);
  });

  afterEach(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  function mockReq(method: string, url: string, body?: Record<string, unknown>): IncomingMessage {
    const bodyStr = body ? JSON.stringify(body) : "";
    const readable = new Readable({
      read() {
        if (bodyStr) {
          this.push(bodyStr);
        }
        this.push(null);
      },
    });
    Object.assign(readable, {
      method,
      url,
      headers: {
        host: "localhost:3000",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      httpVersion: "1.1",
      httpVersionMajor: 1,
      httpVersionMinor: 1,
      socket: { remoteAddress: "127.0.0.1" } as Socket,
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

  it("POST /auth/request generates code in NEXUS-XXXX format", async () => {
    const req = mockReq("POST", "/auth/request", { device_name: "Ron's laptop" });
    const res = mockRes();
    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res._status).toBe(200);

    const data = JSON.parse(res._body);
    expect(data.code).toMatch(/^NEXUS-[A-Z0-9]{4}$/);
    expect(data.qr_url).toContain("/auth/qr/");
    expect(data.qr_url).toContain(data.code);
    expect(data.poll_url).toContain("/auth/poll");
    expect(data.poll_url).toContain(data.code);
    expect(data.expires_in).toBe(600);
  });

  it("GET /auth/poll returns pending after request", async () => {
    // First, create a device request
    const createReq = mockReq("POST", "/auth/request", { device_name: "Test Device" });
    const createRes = mockRes();
    await handler(createReq, createRes);
    const { code } = JSON.parse(createRes._body);

    // Now poll
    const pollReq = mockReq("GET", `/auth/poll?code=${code}`);
    const pollRes = mockRes();
    const handled = await handler(pollReq, pollRes);

    expect(handled).toBe(true);
    expect(pollRes._status).toBe(200);

    const data = JSON.parse(pollRes._body);
    expect(data.status).toBe("pending");
    expect(data.expires_in).toBeGreaterThan(0);
    expect(data.expires_in).toBeLessThanOrEqual(600);
  });

  it("GET /auth/qr/:code/:sig validates HMAC — valid sig serves page, invalid returns 403", async () => {
    // Create a device request to get a real code
    const createReq = mockReq("POST", "/auth/request", { device_name: "QR Test" });
    const createRes = mockRes();
    await handler(createReq, createRes);
    const { code } = JSON.parse(createRes._body);

    // Valid signature
    const validSig = generateHmac(code, hmacSecret);
    const validReq = mockReq("GET", `/auth/qr/${code}/${validSig}`);
    const validRes = mockRes();
    const handledValid = await handler(validReq, validRes);

    expect(handledValid).toBe(true);
    expect(validRes._status).toBe(200);
    expect(validRes._headers["content-type"]).toContain("text/html");

    // Invalid signature
    const invalidReq = mockReq("GET", `/auth/qr/${code}/0000000000000000`);
    const invalidRes = mockRes();
    const handledInvalid = await handler(invalidReq, invalidRes);

    expect(handledInvalid).toBe(true);
    expect(invalidRes._status).toBe(403);
    expect(invalidRes._body).toContain("Invalid");
  });

  it("device codes expire after TTL", async () => {
    // Manually add a device entry that is already expired (created 601 seconds ago)
    const code = "NEXUS-TEST";
    const sig = generateHmac(code, hmacSecret);
    pendingDevices.set(code, {
      createdAt: Date.now() - 601_000, // 601 seconds ago — past the 600s TTL
      deviceName: "Expired Device",
      status: "pending",
      token: null,
      ip: "127.0.0.1",
      sig,
    });

    // Poll should return 404 (expired) because cleanupExpired runs on poll
    const pollReq = mockReq("GET", `/auth/poll?code=${code}`);
    const pollRes = mockRes();
    await handler(pollReq, pollRes);

    expect(pollRes._status).toBe(404);
    const data = JSON.parse(pollRes._body);
    expect(data.error).toContain("expired");
  });
});
