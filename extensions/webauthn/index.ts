/**
 * OpenClaw WebAuthn Extension
 *
 * Provides biometric authentication (Face ID, fingerprint, security keys)
 * and QR-code device pairing via WebAuthn/passkeys.
 *
 * HTTP routes (registered via prefix handler on /auth):
 *   GET  /auth/register                     — Registration page (requires setup_token)
 *   POST /auth/passkey/register/options      — Generate registration options
 *   POST /auth/passkey/register/verify       — Verify registration and store credential
 *   POST /auth/passkey/login/options         — Generate browser login options
 *   POST /auth/passkey/login/verify          — Verify login, return session token
 *   POST /auth/passkey/auth/options          — Generate device approval auth options
 *   POST /auth/passkey/auth/verify           — Verify biometric, approve pending device
 *   POST /auth/passkey/admin/new-setup-token — Admin: generate new setup token
 *   POST /auth/request                       — Request device authorization (generate code)
 *   GET  /auth/poll?code=NEXUS-XXXX          — Poll device approval status
 *   GET  /auth/qr/:code/:sig                 — QR approval page
 *   POST /auth/qr/:code/:sig/confirm         — HMAC fallback approval
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { PasskeyStore } from "./src/passkey-store.js";
import { ChallengeStore } from "./src/challenge-store.js";
import { SessionTokenStore } from "./src/session-tokens.js";
import { createPasskeyHandler } from "./src/passkey-routes.js";
import { createDeviceQrHandler, type PendingDevicesMap } from "./src/device-qr-routes.js";

// ── Config Type ──────────────────────────────────────────────

export type WebAuthnConfig = {
  rpId: string;
  rpName: string;
  origin: string;
  userName: string;
  userDisplayName: string;
  passkeysPath: string;
  deviceApprovalToken: string;
  hmacSecret: string;
};

// ── Plugin Definition ────────────────────────────────────────

const webauthnPlugin = {
  id: "webauthn",
  name: "WebAuthn Passkey Authentication",
  description:
    "Biometric authentication (Face ID, fingerprint, security keys) and QR-code device pairing via WebAuthn/passkeys",

  register(api: OpenClawPluginApi) {
    const rawCfg = (api.pluginConfig ?? {}) as Record<string, unknown>;

    // Validate required config
    const rpId = String(rawCfg.rpId ?? "");
    const origin = String(rawCfg.origin ?? "");
    if (!rpId || !origin) {
      api.logger.error(
        "webauthn: plugin disabled — rpId and origin are required in plugin config",
      );
      return;
    }

    const rpName = String(rawCfg.rpName ?? "OpenClaw");
    const userName = String(rawCfg.userName ?? "owner");
    const userDisplayName = String(rawCfg.userDisplayName ?? "Owner");

    // Resolve HMAC secret: explicit config > gateway token > generated
    const gatewayToken =
      process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
      api.config.gateway?.auth?.token?.trim() ||
      "";
    const hmacSecret = String(rawCfg.hmacSecret ?? "") || gatewayToken;

    if (!hmacSecret) {
      api.logger.warn(
        "webauthn: no hmacSecret or gateway token configured — QR device pairing will be unavailable",
      );
    }

    const config: WebAuthnConfig = {
      rpId,
      rpName,
      origin,
      userName,
      userDisplayName,
      passkeysPath: String(rawCfg.passkeysPath ?? ""),
      deviceApprovalToken: String(rawCfg.deviceApprovalToken ?? process.env.BRAIN_MCP_TOKEN ?? ""),
      hmacSecret,
    };

    // ── Initialize Stores ────────────────────────────────────

    const challenges = new ChallengeStore();
    const sessionTokens = new SessionTokenStore();
    const pendingDevices: PendingDevicesMap = new Map();

    // Setup token state
    let setupToken: string | null = null;

    // PasskeyStore is initialized in the service start handler
    // because we need the stateDir which is only available at service start.
    let store: PasskeyStore | null = null;

    // Cached route handlers — created once after store is initialized
    let cachedPasskeyHandler: ReturnType<typeof createPasskeyHandler> | null = null;
    let cachedDeviceHandler: ReturnType<typeof createDeviceQrHandler> | null = null;

    function getPasskeyHandler(currentStore: PasskeyStore) {
      if (!cachedPasskeyHandler) {
        cachedPasskeyHandler = createPasskeyHandler({
          config,
          store: currentStore,
          challenges,
          sessionTokens,
          pendingDevices,
          logger: api.logger,
          getSetupToken: () => setupToken,
          clearSetupToken: () => { setupToken = null; },
          getHmacSecret: () => hmacSecret,
          validateBearerAuth,
        });
      }
      return cachedPasskeyHandler;
    }

    function getDeviceHandler(currentStore: PasskeyStore) {
      if (!cachedDeviceHandler) {
        cachedDeviceHandler = createDeviceQrHandler({
          config,
          store: currentStore,
          pendingDevices,
          logger: api.logger,
          getHmacSecret: () => hmacSecret,
        });
      }
      return cachedDeviceHandler;
    }

    // ── Bearer Auth Validation ───────────────────────────────

    function validateBearerAuth(authHeader: string | undefined): boolean {
      if (!authHeader) return false;
      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : "";
      if (!token) return false;

      // Accept gateway token or valid session token
      if (gatewayToken && token === gatewayToken) return true;
      return sessionTokens.validateSessionToken(token);
    }

    // ── HTTP Handler ─────────────────────────────────────────
    // We use registerHttpHandler with prefix matching on /auth

    api.registerHttpHandler(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const path = url.pathname;

      // Only handle /auth/* routes
      if (!path.startsWith("/auth")) {
        return false;
      }

      // Store must be initialized
      if (!store) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "WebAuthn service not yet initialized" }));
        return true;
      }

      // Admin new-setup-token needs special handling since it sets state
      if (path === "/auth/passkey/admin/new-setup-token" && req.method === "POST") {
        if (!validateBearerAuth(req.headers.authorization)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Valid bearer token required" }));
          return true;
        }
        setupToken = randomBytes(32).toString("base64url");
        api.logger.info(`webauthn: new setup token generated via admin endpoint — ${setupToken}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ setup_token: setupToken }));
        return true;
      }

      // Try passkey routes first
      const handled = await getPasskeyHandler(store)(req, res);
      if (handled) return true;

      // Try device QR routes
      return getDeviceHandler(store)(req, res);
    });

    api.logger.info("webauthn: HTTP handler registered for /auth/* routes");

    // ── Gateway Method: validate session token ───────────────

    api.registerGatewayMethod("webauthn.validateSession", async ({ params, respond }) => {
      const token = String(params?.token ?? "");
      respond(true, { valid: sessionTokens.validateSessionToken(token) });
    });

    // ── Service Lifecycle ────────────────────────────────────

    api.registerService({
      id: "webauthn",
      start: (ctx) => {
        // Resolve passkeys path
        const passkeysPath = config.passkeysPath
          ? api.resolvePath(config.passkeysPath)
          : join(ctx.stateDir, "webauthn", "passkeys.json");

        store = new PasskeyStore(passkeysPath, api.logger);

        // Initialize setup token if no passkeys are registered
        if (!store.hasCredentials) {
          setupToken = randomBytes(32).toString("base64url");
          api.logger.info(`webauthn: SETUP TOKEN: ${setupToken}`);
          // Print to stdout for visibility
          const line = "=".repeat(60);
          console.log(`\n${line}`);
          console.log(`WEBAUTHN SETUP TOKEN: ${setupToken}`);
          console.log(`Use this token to register your first passkey.`);
          console.log(`Visit: ${origin}/auth/register?setup_token=${setupToken}`);
          console.log(`${line}\n`);
        } else {
          setupToken = null;
          api.logger.info(
            "webauthn: passkeys already registered — registration is closed. Use admin endpoint for new setup tokens.",
          );
        }

        api.logger.info(`webauthn: service started (passkeys: ${passkeysPath})`);
      },
      stop: () => {
        challenges.destroy();
        sessionTokens.destroy();
        pendingDevices.clear();
        api.logger.info("webauthn: service stopped");
      },
    });
  },
};

export default webauthnPlugin;
