/**
 * QR-code device pairing routes.
 *
 * Allows new devices to request authorization by generating a NEXUS-XXXX
 * code, which is presented as a QR code URL. The owner scans and approves
 * via passkey biometric (or HMAC fallback).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type PluginLogger = OpenClawPluginApi["logger"];
import type { PasskeyStore } from "./passkey-store.js";
import type { WebAuthnConfig } from "../index.js";

// ── Types ────────────────────────────────────────────────────

export type PendingDevice = {
  createdAt: number;
  deviceName: string;
  status: "pending" | "approved" | "denied";
  token: string | null;
  ip: string;
  sig: string;
};

export type PendingDevicesMap = Map<string, PendingDevice>;

const CODE_TTL_MS = 600_000; // 10 minutes
const CODE_TTL_SECONDS = 600;

// ── Helpers ──────────────────────────────────────────────────

function generateCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(4);
  let suffix = "";
  for (let i = 0; i < 4; i++) {
    suffix += chars[bytes[i]! % chars.length];
  }
  return `NEXUS-${suffix}`;
}

export function generateHmac(code: string, secret: string): string {
  return createHmac("sha256", secret).update(code).digest("hex").slice(0, 16);
}

function cleanupExpired(map: PendingDevicesMap): void {
  const now = Date.now();
  for (const [key, value] of map) {
    if (now - value.createdAt > CODE_TTL_MS) {
      map.delete(key);
    }
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        if (!raw.trim()) {
          resolve({});
          return;
        }
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
}

/** Generate an ASCII QR code using the qrcode npm package. */
async function generateQrAscii(url: string): Promise<string> {
  try {
    const qrcode = await import("qrcode");
    const ascii = await qrcode.toString(url, { type: "terminal", small: true });
    return ascii;
  } catch {
    return "";
  }
}

// ── Route Handler Factory ────────────────────────────────────

export type DeviceQrRoutesDeps = {
  config: WebAuthnConfig;
  store: PasskeyStore;
  pendingDevices: PendingDevicesMap;
  logger: PluginLogger;
  getHmacSecret: () => string;
};

export function createDeviceQrHandler(deps: DeviceQrRoutesDeps) {
  const { config, store, pendingDevices, logger, getHmacSecret } = deps;

  return async function handleDeviceQrRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const url = parseUrl(req);
    const path = url.pathname;
    const method = req.method?.toUpperCase() ?? "GET";

    // ── POST /auth/request ──────────────────────────────────
    if (path === "/auth/request" && method === "POST") {
      cleanupExpired(pendingDevices);

      let body: Record<string, unknown> = {};
      const contentType = req.headers["content-type"] ?? "";
      if (contentType.includes("application/json")) {
        try {
          body = await readJsonBody(req);
        } catch {
          // Fall through with empty body
        }
      }

      const deviceName = String(body.device_name ?? "Unknown device");
      const secret = getHmacSecret();
      if (!secret) {
        logger.error("webauthn: HMAC secret not configured — cannot generate device auth codes");
        sendJson(res, 500, { error: "Server misconfiguration: HMAC secret not set" });
        return true;
      }

      const code = generateCode();
      const sig = generateHmac(code, secret);
      const clientIp = req.socket?.remoteAddress ?? "unknown";

      pendingDevices.set(code, {
        createdAt: Date.now(),
        deviceName,
        status: "pending",
        token: null,
        ip: clientIp,
        sig,
      });

      // Build QR URL
      const requestOrigin = config.origin;
      const qrUrl = `${requestOrigin}/auth/qr/${code}/${sig}`;
      const qrAscii = await generateQrAscii(qrUrl);

      logger.info(`webauthn: device auth requested — ${deviceName} -> code ${code}`);

      sendJson(res, 200, {
        code,
        qr_url: qrUrl,
        qr_ascii: qrAscii,
        poll_url: `${requestOrigin}/auth/poll?code=${code}`,
        expires_in: CODE_TTL_SECONDS,
      });
      return true;
    }

    // ── GET /auth/poll ──────────────────────────────────────
    if (path === "/auth/poll" && method === "GET") {
      cleanupExpired(pendingDevices);

      const code = url.searchParams.get("code") ?? "";
      const device = pendingDevices.get(code);
      if (!device) {
        sendJson(res, 404, { error: "Code expired" });
        return true;
      }

      if (device.status === "approved") {
        const mcpConfig = {
          mcpServers: {
            "shared-brain": {
              type: "http",
              url: "https://shared-brain.us/mcp",
              headers: {
                Authorization: `Bearer ${device.token ?? ""}`,
              },
            },
          },
        };
        pendingDevices.delete(code);
        sendJson(res, 200, { status: "approved", mcp_config: mcpConfig });
        return true;
      }

      if (device.status === "denied") {
        pendingDevices.delete(code);
        sendJson(res, 200, { status: "denied" });
        return true;
      }

      const remaining = Math.max(
        0,
        Math.floor(CODE_TTL_SECONDS - (Date.now() - device.createdAt) / 1000),
      );
      sendJson(res, 200, { status: "pending", expires_in: remaining });
      return true;
    }

    // ── GET /auth/qr/:code/:sig ─────────────────────────────
    const qrMatch = path.match(/^\/auth\/qr\/([A-Z0-9-]+)\/([a-f0-9]+)$/);
    if (qrMatch && method === "GET") {
      cleanupExpired(pendingDevices);

      const code = qrMatch[1]!;
      const sig = qrMatch[2]!;
      const secret = getHmacSecret();

      const expectedSig = generateHmac(code, secret);
      // Timing-safe comparison
      const sigBuf = Buffer.from(sig);
      const expectedBuf = Buffer.from(expectedSig);
      if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
        const tpl = await import("./html-templates.js");
        sendHtml(res, 403, tpl.simplePage(config.rpName, "Invalid", '<p style="color:#f85149;text-align:center">Invalid QR code.</p>'));
        return true;
      }

      const device = pendingDevices.get(code);
      if (!device) {
        const tpl = await import("./html-templates.js");
        sendHtml(res, 404, tpl.simplePage(config.rpName, "Expired", '<p style="color:#f85149;text-align:center">Code expired.</p>'));
        return true;
      }

      if (device.status !== "pending") {
        const tpl = await import("./html-templates.js");
        sendHtml(res, 200, tpl.simplePage(config.rpName, "Done", `<p style="text-align:center">Already ${device.status}.</p>`));
        return true;
      }

      const remaining = Math.max(
        0,
        Math.floor(CODE_TTL_SECONDS - (Date.now() - device.createdAt) / 1000),
      );
      const hasPasskey = store.hasCredentials;

      const tpl = await import("./html-templates.js");
      sendHtml(
        res,
        200,
        tpl.qrApprovalPage(code, sig, device.deviceName, config.rpName, remaining, hasPasskey),
      );
      return true;
    }

    // ── POST /auth/qr/:code/:sig/confirm ────────────────────
    // HMAC-based fallback approval (no passkey)
    const confirmMatch = path.match(/^\/auth\/qr\/([A-Z0-9-]+)\/([a-f0-9]+)\/confirm$/);
    if (confirmMatch && method === "POST") {
      cleanupExpired(pendingDevices);

      const code = confirmMatch[1]!;
      const sig = confirmMatch[2]!;
      const secret = getHmacSecret();

      const expectedSig = generateHmac(code, secret);
      const sigBuf = Buffer.from(sig);
      const expectedBuf = Buffer.from(expectedSig);
      if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
        sendJson(res, 403, { error: "Invalid signature" });
        return true;
      }

      const device = pendingDevices.get(code);
      if (!device) {
        sendJson(res, 404, { error: "Code expired" });
        return true;
      }

      if (device.status !== "pending") {
        sendJson(res, 200, { status: device.status, device: device.deviceName });
        return true;
      }

      const approvalToken = config.deviceApprovalToken ?? "";
      if (!approvalToken) {
        logger.warn("webauthn: deviceApprovalToken not configured — HMAC approval will have an empty token");
      }
      device.status = "approved";
      device.token = approvalToken;
      logger.info(`webauthn: device approved via HMAC — ${device.deviceName} (${code})`);
      sendJson(res, 200, { success: true, device: device.deviceName });
      return true;
    }

    // Not a device QR route
    return false;
  };
}
