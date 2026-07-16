// P4 Wave 2.1 — brain ingest bridge.
//
// When OpenClaw receives an inbound Signal message (it owns all human
// conversation), forward a capture envelope to Ron's shared-brain so the brain
// remembers what was said — WITHOUT affecting the auto-reply flow.
//
// This module is intentionally self-contained and fire-and-forget: every entry
// point swallows its own errors and never throws into the reply path. The whole
// bridge is OFF by default and must be explicitly enabled (master kill switch
// `OPENCLAW_BRAIN_INGEST_ENABLED`).
//
// Wire contract (shared-brain): POST {url}/api/memory/ingest, device-signed per
// shared-brain lib/devices.js — Authorization: `Device-Signature <b64>`, plus
// X-Device-Id and X-Device-Timestamp headers. The canonical signing message is
// `${timestamp}\n${METHOD}\n${path}\n${sha256hex(body)}` over an ed25519 key.
//
// Privacy: only messages that already passed OpenClaw's allowlist/group gating
// (i.e. exactly what reached dispatchInboundMessage) are forwarded, and only the
// text the agent itself sees — locally-produced transcript for voice notes,
// never raw audio, never attachment bytes.

import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import { readFileSync } from "node:fs";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_IMPORTANCE = 0.5;
const INGEST_PATH = "/api/memory/ingest";
// Two distinct media-only placeholder shapes reach the capture as body text:
//  - `[media attached: /path (mime)]` from the media-note builder, and
//  - `<media:image>` / `<media:attachment>` etc. set by the Signal handler when
//    an attachment arrives with no caption (event-handler.ts placeholder path).
// Both are stripped so a media-only message maps to an empty text → null.
const MEDIA_NOTE_RE = /\[media attached[^\]]*\]/gi;
const MEDIA_PLACEHOLDER_RE = /<media:[^>]*>/gi;

export type BrainIngestChannel = "signal" | "voice";

/** Fully-resolved, ready-to-use config. `null` means the bridge is disabled. */
export type ResolvedBrainIngestConfig = {
  url: string;
  deviceId: string;
  /** Inline ed25519 private key PEM (PKCS8), if provided via env. */
  keyPem?: string;
  /** Filesystem path to an ed25519 private key PEM, if provided. */
  keyPath?: string;
  project?: string;
  type?: string;
  importance: number;
  tags: string[];
  timeoutMs: number;
};

export type BrainIngestEnvelope = {
  content: string;
  channel: BrainIngestChannel;
  external_id: string;
  metadata: Record<string, unknown>;
};

type CaptureDeps = {
  cfg: OpenClawConfig;
  runtime?: Pick<RuntimeEnv, "log" | "error">;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
};

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Resolve the effective bridge config from OpenClaw config + environment.
 *
 * Precedence: env overrides config for every field. The master kill switch
 * `OPENCLAW_BRAIN_INGEST_ENABLED` gates everything:
 *   - explicit falsy env  → disabled (hard off, even if config enables it)
 *   - explicit truthy env → enabled  (subject to required fields)
 *   - unset env           → fall back to `memory.brainIngest.enabled` (default false)
 *
 * Returns `null` when disabled or when required fields (url, deviceId, a key
 * source) are missing — callers treat `null` as "do nothing".
 */
export function resolveBrainIngestConfig(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedBrainIngestConfig | null {
  const fileCfg = cfg?.memory?.brainIngest ?? {};

  const envFlag = parseBooleanValue(env.OPENCLAW_BRAIN_INGEST_ENABLED);
  const enabled = envFlag ?? fileCfg.enabled ?? false;
  if (!enabled) {
    return null;
  }

  const url = trimmedString(env.OPENCLAW_BRAIN_INGEST_URL) ?? trimmedString(fileCfg.url);
  const deviceId =
    trimmedString(env.OPENCLAW_BRAIN_INGEST_DEVICE_ID) ?? trimmedString(fileCfg.deviceId);
  const keyPem = trimmedString(env.OPENCLAW_BRAIN_INGEST_KEY);
  const keyPath =
    trimmedString(env.OPENCLAW_BRAIN_INGEST_KEY_PATH) ?? trimmedString(fileCfg.keyPath);

  // All three are mandatory to sign and address a request. Missing config while
  // enabled is a misconfiguration, not a silent partial mode.
  if (!url || !deviceId || (!keyPem && !keyPath)) {
    return null;
  }

  const project =
    trimmedString(env.OPENCLAW_BRAIN_INGEST_PROJECT) ?? trimmedString(fileCfg.project);
  const type = trimmedString(env.OPENCLAW_BRAIN_INGEST_TYPE) ?? trimmedString(fileCfg.type);
  const importance =
    parseNumber(env.OPENCLAW_BRAIN_INGEST_IMPORTANCE) ?? fileCfg.importance ?? DEFAULT_IMPORTANCE;
  const timeoutMs =
    parseNumber(env.OPENCLAW_BRAIN_INGEST_TIMEOUT_MS) ?? fileCfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const configuredTags = Array.isArray(fileCfg.tags)
    ? fileCfg.tags.map((tag) => trimmedString(tag)).filter((tag): tag is string => Boolean(tag))
    : [];

  return {
    url,
    deviceId,
    keyPem,
    keyPath,
    project,
    type,
    importance,
    tags: configuredTags,
    timeoutMs: timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

function resolveGroupId(ctx: MsgContext): string | undefined {
  if (ctx.ChatType !== "group") {
    return undefined;
  }
  const from = trimmedString(ctx.From);
  if (from?.startsWith("group:")) {
    return from.slice("group:".length) || undefined;
  }
  return undefined;
}

function stripMediaNotes(text: string): string {
  return text
    .replace(MEDIA_NOTE_RE, "")
    .replace(MEDIA_PLACEHOLDER_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Resolve the sender identifier, preferring a Signal uuid over an E.164 phone
 * number wherever both are available. `SenderUuid` is the raw envelope uuid (set
 * for phone-kind senders that also carry a uuid); `SenderId` may itself be a
 * `uuid:<raw>` display form (uuid-kind senders) or a bare E.164 (phone-kind).
 * E.164 is used only as a last-resort fallback.
 */
function resolveSenderId(ctx: MsgContext): string {
  const uuid = trimmedString(ctx.SenderUuid);
  if (uuid) {
    return uuid;
  }
  const senderId = trimmedString(ctx.SenderId);
  if (senderId?.toLowerCase().startsWith("uuid:")) {
    const raw = senderId.slice("uuid:".length).trim();
    if (raw) {
      return raw;
    }
  }
  return senderId ?? "unknown";
}

/**
 * Map the finalized MsgContext (post-gating, post-transcription) to a capture
 * envelope. Returns `null` when there is nothing meaningful to forward — e.g. a
 * media-only message with no transcript (we never forward raw audio/attachment
 * bytes, only text the agent saw).
 */
export function formatBrainIngestEnvelope(ctx: MsgContext): BrainIngestEnvelope | null {
  const transcript = trimmedString(ctx.Transcript);
  const isVoice = Boolean(transcript);

  const rawText =
    transcript ??
    trimmedString(ctx.RawBody) ??
    trimmedString(ctx.CommandBody) ??
    trimmedString(ctx.BodyForAgent);
  const messageText = isVoice ? transcript : rawText ? stripMediaNotes(rawText) : undefined;
  if (!messageText) {
    return null;
  }

  // content keeps the human-readable display name (sourceName), falling back to
  // the sender id then conversation label. This is Ron's own conversation data.
  const senderDisplay =
    trimmedString(ctx.SenderName) ??
    trimmedString(ctx.SenderId) ??
    trimmedString(ctx.ConversationLabel) ??
    "unknown";
  // sender_id / external_id use the stable identifier (uuid-preferred).
  const senderId = resolveSenderId(ctx);
  const content = `${senderDisplay}: ${messageText}`;
  const groupId = resolveGroupId(ctx);
  const timestamp = typeof ctx.Timestamp === "number" ? ctx.Timestamp : undefined;
  const hasMedia = Boolean(
    ctx.MediaPath || (Array.isArray(ctx.MediaPaths) && ctx.MediaPaths.length > 0),
  );

  const channel: BrainIngestChannel = isVoice ? "voice" : "signal";

  // Stable per-message id: envelope timestamp + source id, namespaced by the
  // conversation scope so a DM and a group message can never collide. Identical
  // inputs always produce the same id — the brain's own dedup makes replays safe.
  // When the timestamp is missing, fall back to a content hash so distinct
  // messages from one sender never collapse into a single provenance-deduped id.
  const scope = groupId ? `group:${groupId}` : "dm";
  const idTail =
    timestamp !== undefined
      ? String(timestamp)
      : `h${createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16)}`;
  const external_id = `signal:${scope}:${senderId}:${idTail}`;

  const metadata: Record<string, unknown> = {
    sender_id: senderId,
    ts: timestamp,
    has_media: hasMedia,
    surface: "signal",
    // Mirror channel + external_id into metadata so a shared-brain build that
    // does not yet read the top-level fields still preserves them for audit and
    // dedup. Harmless once the top-level contract lands.
    channel,
    external_id,
  };
  const senderName = trimmedString(ctx.SenderName);
  if (senderName) {
    metadata.sender_name = senderName;
  }
  if (groupId) {
    metadata.group_id = groupId;
  }
  const groupSubject = trimmedString(ctx.GroupSubject);
  if (groupSubject) {
    metadata.group_subject = groupSubject;
  }
  const chatType = trimmedString(ctx.ChatType);
  if (chatType) {
    metadata.chat_type = chatType;
  }
  const messageSid = trimmedString(ctx.MessageSid);
  if (messageSid) {
    metadata.message_sid = messageSid;
  }

  return {
    content,
    channel,
    external_id,
    metadata,
  };
}

/**
 * Build the JSON request body for POST /api/memory/ingest. `source` is
 * deliberately omitted: shared-brain binds the source to the registered device.
 */
export function buildIngestRequestBody(
  envelope: BrainIngestEnvelope,
  config: ResolvedBrainIngestConfig,
): Record<string, unknown> {
  const tags = Array.from(new Set([...config.tags, "openclaw", envelope.channel]));
  const body: Record<string, unknown> = {
    content: envelope.content,
    importance: config.importance,
    tags,
    metadata: envelope.metadata,
    channel: envelope.channel,
    external_id: envelope.external_id,
  };
  if (config.type) {
    body.type = config.type;
  }
  if (config.project) {
    body.project = config.project;
  }
  return body;
}

// Cache the loaded KeyObject keyed by its source material so we do not re-read
// the key file on every inbound message.
let cachedKey: { source: string; key: KeyObject } | null = null;

function loadPrivateKey(config: ResolvedBrainIngestConfig): KeyObject {
  const source = config.keyPem ?? `file:${config.keyPath}`;
  if (cachedKey && cachedKey.source === source) {
    return cachedKey.key;
  }
  const pem = config.keyPem ?? readFileSync(config.keyPath as string, "utf8");
  const key = createPrivateKey(pem);
  cachedKey = { source, key };
  return key;
}

/** Exposed for tests to reset the module-level key cache. */
export function resetBrainIngestKeyCacheForTest(): void {
  cachedKey = null;
}

type SignedRequest = {
  url: string;
  /** JSON request body as a string. Its utf8 bytes are what the signature covers. */
  body: string;
  headers: Record<string, string>;
};

export function signIngestRequest(
  body: Record<string, unknown>,
  config: ResolvedBrainIngestConfig,
  now: Date = new Date(),
): SignedRequest {
  const url = `${config.url.replace(/\/+$/, "")}${INGEST_PATH}`;
  const path = new URL(url).pathname;
  // Serialize once and sign the sha256 of these exact utf8 bytes. fetch sends a
  // string body as utf8, so the bytes shared-brain hashes (req.rawBody) match.
  const bodyText = JSON.stringify(body);
  const bodyHash = createHash("sha256").update(bodyText, "utf8").digest("hex");
  const timestamp = now.toISOString();
  const message = `${timestamp}\nPOST\n${path}\n${bodyHash}`;
  const signature = sign(null, Buffer.from(message, "utf8"), loadPrivateKey(config)).toString(
    "base64",
  );
  return {
    url,
    body: bodyText,
    headers: {
      "content-type": "application/json",
      authorization: `Device-Signature ${signature}`,
      "x-device-id": config.deviceId,
      "x-device-timestamp": timestamp,
    },
  };
}

/**
 * Send a single capture envelope to shared-brain. Never throws. On 429/5xx or
 * network failure it drops the message with a warning (the brain's own dedup
 * makes later replay safe) — no retry loop, no unbounded queue.
 */
export async function sendBrainIngest(
  envelope: BrainIngestEnvelope,
  config: ResolvedBrainIngestConfig,
  deps: { runtime?: Pick<RuntimeEnv, "log" | "error">; fetchFn?: typeof fetch } = {},
): Promise<void> {
  const warn = (msg: string) => deps.runtime?.error?.(`[brain-ingest] ${msg}`);
  let signed: SignedRequest;
  try {
    signed = signIngestRequest(buildIngestRequestBody(envelope, config), config);
  } catch (err) {
    warn(`failed to sign request: ${String(err)}`);
    return;
  }

  try {
    const res = await fetchWithTimeout(
      signed.url,
      { method: "POST", headers: signed.headers, body: signed.body },
      config.timeoutMs,
      deps.fetchFn,
    );

    if (res.ok) {
      // Drain the body to free the socket; tolerate parse failures.
      const payload = (await res.json().catch(() => null)) as { deduplicated?: boolean } | null;
      if (payload?.deduplicated) {
        deps.runtime?.log?.(`[brain-ingest] deduplicated ${envelope.external_id}`);
      }
      return;
    }

    if (res.status === 429 || res.status >= 500) {
      warn(`dropping ${envelope.external_id} after ${res.status} (no retry)`);
      return;
    }
    if (res.status === 401 || res.status === 403) {
      warn(`auth rejected (${res.status}) for ${envelope.external_id}; check device enrollment`);
      return;
    }
    warn(`unexpected ${res.status} for ${envelope.external_id}`);
  } catch (err) {
    warn(`send failed for ${envelope.external_id}: ${String(err)}`);
  }
}

/**
 * Top-level capture entry point invoked from the inbound message handler AFTER
 * allowlist/group gating and (for voice) after transcription resolves. This is
 * fire-and-forget: it resolves config, maps the envelope, and sends — swallowing
 * every error so it can never affect the reply path.
 *
 * The caller must invoke this only for messages that reached dispatch (i.e. that
 * passed gating); allowlist-rejected messages never reach this function.
 */
export async function captureInboundToBrain(ctx: MsgContext, deps: CaptureDeps): Promise<void> {
  try {
    const config = resolveBrainIngestConfig(deps.cfg, deps.env);
    if (!config) {
      return;
    }
    const envelope = formatBrainIngestEnvelope(ctx);
    if (!envelope) {
      return;
    }
    await sendBrainIngest(envelope, config, {
      runtime: deps.runtime,
      fetchFn: deps.fetchFn,
    });
  } catch (err) {
    // Belt-and-suspenders: nothing above should throw, but the reply path must
    // never see an exception from the capture bridge.
    deps.runtime?.error?.(`[brain-ingest] capture error: ${String(err)}`);
  }
}

/**
 * Generate an ed25519 keypair for device enrollment. Returns the private key as
 * PKCS8 PEM (store it as the device's secret) and the raw 32-byte public key as
 * base64 (send it as `public_key_b64` to POST /api/devices/register).
 */
export function generateDeviceKeypairPem(): { privateKeyPem: string; publicKeyB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  // ed25519 SPKI = 12-byte prefix + 32-byte raw key.
  const publicKeyB64 = Buffer.from(spkiDer.subarray(12)).toString("base64");
  return { privateKeyPem, publicKeyB64 };
}
