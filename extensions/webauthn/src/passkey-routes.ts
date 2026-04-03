/**
 * WebAuthn passkey HTTP routes.
 *
 * Handles registration, browser login, and device approval via biometric.
 * Uses @simplewebauthn/server for all WebAuthn ceremony logic.
 */

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type PluginLogger = OpenClawPluginApi["logger"];
import type { PasskeyStore } from "./passkey-store.js";
import type { ChallengeStore } from "./challenge-store.js";
import type { SessionTokenStore } from "./session-tokens.js";
import type { PendingDevicesMap } from "./device-qr-routes.js";
import type { WebAuthnConfig } from "../index.js";

// ── Helpers ──────────────────────────────────────────────────

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

/** Convert a base64url string to raw bytes. */
function b64urlToBytes(s: string): Uint8Array {
  let normalized = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = 4 - (normalized.length % 4);
  if (pad !== 4) {
    normalized += "=".repeat(pad);
  }
  return new Uint8Array(Buffer.from(normalized, "base64"));
}

/** Convert standard base64 to base64url string. */
function base64ToBase64url(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Types ────────────────────────────────────────────────────

export type PasskeyRoutesDeps = {
  config: WebAuthnConfig;
  store: PasskeyStore;
  challenges: ChallengeStore;
  sessionTokens: SessionTokenStore;
  pendingDevices: PendingDevicesMap;
  logger: PluginLogger;
  getSetupToken: () => string | null;
  clearSetupToken: () => void;
  getHmacSecret: () => string;
  validateBearerAuth: (authHeader: string | undefined) => boolean;
};

// ── Route Handler Factory ────────────────────────────────────

export function createPasskeyHandler(deps: PasskeyRoutesDeps) {
  const { config, store, challenges, sessionTokens, pendingDevices, logger } = deps;
  const { rpId, rpName, origin, userName, userDisplayName } = config;

  /** Import HTML templates lazily to keep this module focused on logic. */
  let templates: typeof import("./html-templates.js") | null = null;
  async function getTemplates() {
    if (!templates) {
      templates = await import("./html-templates.js");
    }
    return templates;
  }

  return async function handlePasskeyRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const url = parseUrl(req);
    const path = url.pathname;
    const method = req.method?.toUpperCase() ?? "GET";

    // ── GET /auth/register ──────────────────────────────────
    if (path === "/auth/register" && method === "GET") {
      const tpl = await getTemplates();
      const setupToken = deps.getSetupToken();
      const queryToken = url.searchParams.get("setup_token") ?? "";

      if (!setupToken) {
        sendHtml(res, 403, tpl.registrationClosedPage(rpName));
        return true;
      }

      if (!queryToken || queryToken !== setupToken) {
        sendHtml(res, 403, tpl.invalidTokenPage(rpName));
        return true;
      }

      sendHtml(res, 200, tpl.registrationPage(setupToken, rpName, store.listAll().length));
      return true;
    }

    // ── POST /auth/passkey/register/options ──────────────────
    if (path === "/auth/passkey/register/options" && method === "POST") {
      const setupToken = deps.getSetupToken();
      if (!setupToken) {
        sendJson(res, 403, { error: "Registration is closed. No setup token active." });
        return true;
      }

      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return true;
      }

      const bodySetupToken = String(body.setup_token ?? "");
      if (!bodySetupToken || bodySetupToken !== setupToken) {
        sendJson(res, 403, { error: "Invalid setup token." });
        return true;
      }

      const name = String(body.name ?? "Phone");
      const userId = Buffer.from(`${rpId}-owner`);

      const excludeCredentials = store.hasCredentials
        ? store.listAll().map((c) => ({
            id: base64ToBase64url(c.id),
          }))
        : undefined;

      try {
        const options = await generateRegistrationOptions({
          rpName,
          rpID: rpId,
          userID: userId,
          userName: userName,
          userDisplayName: userDisplayName,
          authenticatorSelection: {
            residentKey: "preferred",
            userVerification: "required",
          },
          excludeCredentials,
        });

        const deviceHash = createHash("sha256").update(name).digest("hex").slice(0, 12);
        const challengeKey = `registration:${deviceHash}`;
        challenges.set(challengeKey, Buffer.from(options.challenge, "base64url"));

        sendJson(res, 200, options);
      } catch (err) {
        logger.error(`webauthn: registration options failed — ${String(err)}`);
        sendJson(res, 500, { error: "Failed to generate registration options" });
      }
      return true;
    }

    // ── POST /auth/passkey/register/verify ───────────────────
    if (path === "/auth/passkey/register/verify" && method === "POST") {
      const setupToken = deps.getSetupToken();
      if (!setupToken) {
        sendJson(res, 403, { error: "Registration is closed. No setup token active." });
        return true;
      }

      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return true;
      }

      const bodySetupToken = String(body.setup_token ?? "");
      if (!bodySetupToken || bodySetupToken !== setupToken) {
        sendJson(res, 403, { error: "Invalid setup token." });
        return true;
      }

      const name = String(body.name ?? "Phone");
      const deviceHash = createHash("sha256").update(name).digest("hex").slice(0, 12);
      const challengeKey = `registration:${deviceHash}`;

      const expectedChallenge = challenges.get(challengeKey);
      if (!expectedChallenge) {
        sendJson(res, 400, { error: "Challenge expired" });
        return true;
      }

      try {
        const verification = await verifyRegistrationResponse({
          response: body as any,
          expectedChallenge: Buffer.from(expectedChallenge).toString("base64url"),
          expectedRPID: rpId,
          expectedOrigin: origin,
        });

        if (!verification.verified || !verification.registrationInfo) {
          sendJson(res, 400, { success: false, error: "Verification failed" });
          return true;
        }

        const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

        // credential.id is already a Base64URLString in v13;
        // Store as standard base64 for consistency with the Python version
        const credIdBytes = Buffer.from(credential.id, "base64url");
        store.add({
          id: credIdBytes.toString("base64"),
          public_key: Buffer.from(credential.publicKey).toString("base64"),
          sign_count: credential.counter,
          name,
          registered_at: Date.now() / 1000,
        });

        // Invalidate setup token after first successful registration
        deps.clearSetupToken();
        logger.info(`webauthn: passkey registered for '${name}'. Setup token invalidated.`);

        sendJson(res, 200, { success: true });
      } catch (err) {
        logger.error(`webauthn: registration verification failed — ${String(err)}`);
        sendJson(res, 400, { success: false, error: String(err) });
      }
      return true;
    }

    // ── POST /auth/passkey/login/options ─────────────────────
    if (path === "/auth/passkey/login/options" && method === "POST") {
      if (!store.hasCredentials) {
        sendJson(res, 400, { error: "No passkeys registered" });
        return true;
      }

      const allowCredentials = store.listAll().map((c) => ({
        id: base64ToBase64url(c.id),
      }));

      try {
        const options = await generateAuthenticationOptions({
          rpID: rpId,
          allowCredentials,
          userVerification: "required",
        });

        const loginId = randomBytes(16).toString("base64url");
        challenges.set(`login:${loginId}`, Buffer.from(options.challenge, "base64url"));

        sendJson(res, 200, { login_id: loginId, ...options });
      } catch (err) {
        logger.error(`webauthn: login options failed — ${String(err)}`);
        sendJson(res, 500, { error: "Failed to generate login options" });
      }
      return true;
    }

    // ── POST /auth/passkey/login/verify ──────────────────────
    if (path === "/auth/passkey/login/verify" && method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return true;
      }

      const loginId = String(body.login_id ?? "");
      const expectedChallenge = challenges.get(`login:${loginId}`);
      if (!expectedChallenge) {
        sendJson(res, 400, { error: "Challenge expired or invalid" });
        return true;
      }

      const rawId = String(body.rawId ?? "");
      let incomingBytes: Uint8Array;
      try {
        incomingBytes = b64urlToBytes(rawId);
      } catch {
        sendJson(res, 400, { error: "Invalid credential ID encoding" });
        return true;
      }

      const storedCred = findCredentialByRawId(store, incomingBytes);
      if (!storedCred) {
        sendJson(res, 400, { error: "Unknown credential" });
        return true;
      }

      try {
        const verification = await verifyAuthenticationResponse({
          response: body as any,
          expectedChallenge: Buffer.from(expectedChallenge).toString("base64url"),
          expectedRPID: rpId,
          expectedOrigin: origin,
          credential: {
            id: base64ToBase64url(storedCred.id),
            publicKey: new Uint8Array(Buffer.from(storedCred.public_key, "base64")),
            counter: storedCred.sign_count ?? 0,
          },
        });

        if (!verification.verified) {
          sendJson(res, 400, { success: false, error: "Verification failed" });
          return true;
        }

        storedCred.sign_count = verification.authenticationInfo.newCounter;
        store.save();

        const sessionToken = sessionTokens.createSessionToken();
        logger.info(`webauthn: browser login successful (credential: ${storedCred.name})`);
        sendJson(res, 200, { success: true, token: sessionToken });
      } catch (err) {
        logger.error(`webauthn: login verification failed — ${String(err)}`);
        sendJson(res, 400, { success: false, error: String(err) });
      }
      return true;
    }

    // ── POST /auth/passkey/auth/options ──────────────────────
    if (path === "/auth/passkey/auth/options" && method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return true;
      }

      const code = String(body.code ?? "");

      const allowCredentials = store.listAll().map((c) => ({
        id: base64ToBase64url(c.id),
      }));

      try {
        const options = await generateAuthenticationOptions({
          rpID: rpId,
          allowCredentials,
          userVerification: "required",
        });

        challenges.set(`authentication:${code}`, Buffer.from(options.challenge, "base64url"));

        sendJson(res, 200, options);
      } catch (err) {
        logger.error(`webauthn: auth options failed — ${String(err)}`);
        sendJson(res, 500, { error: "Failed to generate authentication options" });
      }
      return true;
    }

    // ── POST /auth/passkey/auth/verify ───────────────────────
    if (path === "/auth/passkey/auth/verify" && method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return true;
      }

      const code = String(body.code ?? "");
      const expectedChallenge = challenges.get(`authentication:${code}`);
      if (!expectedChallenge) {
        sendJson(res, 400, { error: "Challenge expired" });
        return true;
      }

      const rawId = String(body.rawId ?? "");
      let incomingBytes: Uint8Array;
      try {
        incomingBytes = b64urlToBytes(rawId);
      } catch {
        sendJson(res, 400, { error: "Invalid credential ID encoding" });
        return true;
      }

      const storedCred = findCredentialByRawId(store, incomingBytes);
      if (!storedCred) {
        sendJson(res, 400, { error: "Unknown credential" });
        return true;
      }

      try {
        const verification = await verifyAuthenticationResponse({
          response: body as any,
          expectedChallenge: Buffer.from(expectedChallenge).toString("base64url"),
          expectedRPID: rpId,
          expectedOrigin: origin,
          credential: {
            id: base64ToBase64url(storedCred.id),
            publicKey: new Uint8Array(Buffer.from(storedCred.public_key, "base64")),
            counter: storedCred.sign_count ?? 0,
          },
        });

        if (!verification.verified) {
          sendJson(res, 400, { success: false, error: "Verification failed" });
          return true;
        }

        storedCred.sign_count = verification.authenticationInfo.newCounter;
        store.save();

        // Approve the pending device
        const device = pendingDevices.get(code);
        if (!device) {
          sendJson(res, 404, { error: "Device code not found" });
          return true;
        }

        const approvalToken = config.deviceApprovalToken ?? "";
        if (!approvalToken) {
          logger.warn("webauthn: deviceApprovalToken not configured — device approval will have an empty token");
        }
        device.status = "approved";
        device.token = approvalToken;
        logger.info(`webauthn: device approved via passkey — ${device.deviceName} (${code})`);
        sendJson(res, 200, { success: true, device: device.deviceName });
      } catch (err) {
        logger.error(`webauthn: auth verification failed — ${String(err)}`);
        sendJson(res, 400, { success: false, error: String(err) });
      }
      return true;
    }

    // admin/new-setup-token is handled in index.ts directly (needs access to setupToken state)

    // Not a passkey route
    return false;
  };
}

/** Find a stored credential by comparing raw bytes of the credential ID. */
function findCredentialByRawId(
  store: PasskeyStore,
  incomingBytes: Uint8Array,
): import("./passkey-store.js").PasskeyCredential | undefined {
  const incomingBuf = Buffer.from(incomingBytes);
  for (const cred of store.listAll()) {
    try {
      const storedBytes = Buffer.from(cred.id, "base64");
      if (incomingBuf.equals(storedBytes)) {
        return cred;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}
