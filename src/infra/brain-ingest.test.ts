import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  verify,
} from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildIngestRequestBody,
  captureInboundToBrain,
  formatBrainIngestEnvelope,
  generateDeviceKeypairPem,
  resetBrainIngestKeyCacheForTest,
  resolveBrainIngestConfig,
  sendBrainIngest,
  signIngestRequest,
} from "./brain-ingest.js";

afterEach(() => {
  resetBrainIngestKeyCacheForTest();
  vi.restoreAllMocks();
});

function makeKeypair(): { privateKeyPem: string; publicKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKey,
  };
}

function textCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    SenderName: "Ron",
    SenderId: "uuid-ron",
    RawBody: "ship the release tonight",
    CommandBody: "ship the release tonight",
    ChatType: "direct",
    From: "signal:+15550001111",
    Timestamp: 1700000000000,
    ...overrides,
  } as MsgContext;
}

function voiceCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    SenderName: "Ron",
    SenderId: "uuid-ron",
    RawBody: "meet me at noon",
    CommandBody: "meet me at noon",
    Transcript: "meet me at noon",
    MediaPath: "/tmp/voice.ogg",
    ChatType: "direct",
    From: "signal:+15550001111",
    Timestamp: 1700000000000,
    ...overrides,
  } as MsgContext;
}

const enabledEnv = (privateKeyPem: string): NodeJS.ProcessEnv => ({
  OPENCLAW_BRAIN_INGEST_ENABLED: "true",
  OPENCLAW_BRAIN_INGEST_URL: "https://shared-brain.us",
  OPENCLAW_BRAIN_INGEST_DEVICE_ID: "device-123",
  OPENCLAW_BRAIN_INGEST_KEY: privateKeyPem,
});

describe("resolveBrainIngestConfig", () => {
  it("is disabled by default (no env, no config)", () => {
    expect(resolveBrainIngestConfig({}, {})).toBeNull();
  });

  it("returns null when enabled but required fields are missing", () => {
    expect(resolveBrainIngestConfig({}, { OPENCLAW_BRAIN_INGEST_ENABLED: "true" })).toBeNull();
  });

  it("env kill switch forces off even when config enables it", () => {
    const cfg: OpenClawConfig = {
      memory: {
        brainIngest: {
          enabled: true,
          url: "https://shared-brain.us",
          deviceId: "d1",
          keyPath: "/keys/dev.pem",
        },
      },
    };
    expect(resolveBrainIngestConfig(cfg, { OPENCLAW_BRAIN_INGEST_ENABLED: "false" })).toBeNull();
  });

  it("resolves from first-class config with env-unset flag falling back to config.enabled", () => {
    const cfg: OpenClawConfig = {
      memory: {
        brainIngest: {
          enabled: true,
          url: "https://shared-brain.us",
          deviceId: "d1",
          keyPath: "/keys/dev.pem",
          project: "openclaw",
          importance: 0.7,
          tags: ["signal-capture"],
        },
      },
    };
    const resolved = resolveBrainIngestConfig(cfg, {});
    expect(resolved).not.toBeNull();
    expect(resolved?.url).toBe("https://shared-brain.us");
    expect(resolved?.deviceId).toBe("d1");
    expect(resolved?.keyPath).toBe("/keys/dev.pem");
    expect(resolved?.importance).toBe(0.7);
    expect(resolved?.tags).toEqual(["signal-capture"]);
  });

  it("env overrides config per field", () => {
    const cfg: OpenClawConfig = {
      memory: {
        brainIngest: { enabled: true, url: "https://old", deviceId: "old", keyPath: "/k" },
      },
    };
    const resolved = resolveBrainIngestConfig(cfg, {
      OPENCLAW_BRAIN_INGEST_URL: "https://new",
      OPENCLAW_BRAIN_INGEST_DEVICE_ID: "new",
    });
    expect(resolved?.url).toBe("https://new");
    expect(resolved?.deviceId).toBe("new");
  });
});

describe("formatBrainIngestEnvelope", () => {
  it("maps a text message to a signal envelope", () => {
    const envelope = formatBrainIngestEnvelope(textCtx());
    expect(envelope).not.toBeNull();
    expect(envelope?.channel).toBe("signal");
    expect(envelope?.content).toBe("Ron: ship the release tonight");
    expect(envelope?.metadata.sender_uuid).toBe("uuid-ron");
    expect(envelope?.metadata.has_media).toBe(false);
    expect(envelope?.metadata.channel).toBe("signal");
  });

  it("maps a voice note to a voice envelope using the transcript", () => {
    const envelope = formatBrainIngestEnvelope(voiceCtx());
    expect(envelope?.channel).toBe("voice");
    expect(envelope?.content).toBe("Ron: meet me at noon");
    expect(envelope?.metadata.has_media).toBe(true);
    expect(envelope?.metadata.channel).toBe("voice");
  });

  it("includes group_id and group_subject for group messages", () => {
    const envelope = formatBrainIngestEnvelope(
      textCtx({ ChatType: "group", From: "group:g99", GroupSubject: "Ops" }),
    );
    expect(envelope?.metadata.group_id).toBe("g99");
    expect(envelope?.metadata.group_subject).toBe("Ops");
    expect(envelope?.external_id).toBe("signal:group:g99:uuid-ron:1700000000000");
  });

  it("returns null for a media-only message with no transcript", () => {
    const envelope = formatBrainIngestEnvelope({
      SenderId: "uuid-ron",
      MediaPath: "/tmp/photo.jpg",
      RawBody: "[media attached: /tmp/photo.jpg (image/jpeg)]",
      ChatType: "direct",
      Timestamp: 1700000000000,
    } as MsgContext);
    expect(envelope).toBeNull();
  });

  it("produces a stable external_id for identical input", () => {
    const a = formatBrainIngestEnvelope(textCtx());
    const b = formatBrainIngestEnvelope(textCtx());
    expect(a?.external_id).toBe(b?.external_id);
    expect(a?.external_id).toBe("signal:dm:uuid-ron:1700000000000");
  });
});

describe("buildIngestRequestBody", () => {
  it("omits source, dedupes tags, and mirrors channel + external_id", () => {
    const { privateKeyPem } = makeKeypair();
    const config = resolveBrainIngestConfig({}, enabledEnv(privateKeyPem));
    const envelope = formatBrainIngestEnvelope(voiceCtx());
    const body = buildIngestRequestBody(envelope!, config!);
    expect(body.source).toBeUndefined();
    expect(body.channel).toBe("voice");
    expect(body.external_id).toBe("signal:dm:uuid-ron:1700000000000");
    expect(body.tags).toEqual(["openclaw", "voice"]);
    expect(body.importance).toBe(0.5);
  });
});

describe("signIngestRequest", () => {
  it("produces a signature the shared-brain device scheme verifies", () => {
    const { privateKeyPem, publicKey } = makeKeypair();
    const config = resolveBrainIngestConfig({}, enabledEnv(privateKeyPem));
    const body = buildIngestRequestBody(formatBrainIngestEnvelope(textCtx())!, config!);
    const signed = signIngestRequest(body, config!);

    expect(signed.url).toBe("https://shared-brain.us/api/memory/ingest");
    expect(signed.headers["x-device-id"]).toBe("device-123");

    // Replicate shared-brain lib/devices.js verifyRequest exactly.
    const timestamp = signed.headers["x-device-timestamp"];
    const path = new URL(signed.url).pathname;
    const bodyHash = createHash("sha256").update(signed.body, "utf8").digest("hex");
    const message = `${timestamp}\nPOST\n${path}\n${bodyHash}`;
    const sigB64 = signed.headers.authorization.replace("Device-Signature ", "");
    const ok = verify(null, Buffer.from(message, "utf8"), publicKey, Buffer.from(sigB64, "base64"));
    expect(ok).toBe(true);
  });
});

describe("sendBrainIngest", () => {
  it("posts a signed request on the happy path", async () => {
    const { privateKeyPem } = makeKeypair();
    const config = resolveBrainIngestConfig({}, enabledEnv(privateKeyPem));
    const envelope = formatBrainIngestEnvelope(textCtx())!;
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ id: "m1" }), { status: 200 }));

    await sendBrainIngest(envelope, config!, { fetchFn: fetchFn as unknown as typeof fetch });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://shared-brain.us/api/memory/ingest");
    expect((init.headers as Record<string, string>).authorization).toContain("Device-Signature ");
  });

  it("swallows a network failure without throwing", async () => {
    const { privateKeyPem } = makeKeypair();
    const config = resolveBrainIngestConfig({}, enabledEnv(privateKeyPem));
    const envelope = formatBrainIngestEnvelope(textCtx())!;
    const error = vi.fn();
    const fetchFn = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(
      sendBrainIngest(envelope, config!, {
        runtime: { log: () => {}, error },
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
  });

  it("drops on 429 without retrying", async () => {
    const { privateKeyPem } = makeKeypair();
    const config = resolveBrainIngestConfig({}, enabledEnv(privateKeyPem));
    const envelope = formatBrainIngestEnvelope(textCtx())!;
    const error = vi.fn();
    const fetchFn = vi.fn(async () => new Response("", { status: 429 }));

    await sendBrainIngest(envelope, config!, {
      runtime: { log: () => {}, error },
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledOnce();
  });
});

describe("captureInboundToBrain", () => {
  it("does nothing when the bridge is disabled (default)", async () => {
    const fetchFn = vi.fn();
    await captureInboundToBrain(textCtx(), {
      cfg: {},
      env: {},
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does nothing for a null envelope even when enabled", async () => {
    const { privateKeyPem } = makeKeypair();
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    await captureInboundToBrain(
      { SenderId: "x", MediaPath: "/tmp/a.jpg", ChatType: "direct" } as MsgContext,
      { cfg: {}, env: enabledEnv(privateKeyPem), fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("forwards when enabled", async () => {
    const { privateKeyPem } = makeKeypair();
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    await captureInboundToBrain(textCtx(), {
      cfg: {},
      env: enabledEnv(privateKeyPem),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("generateDeviceKeypairPem", () => {
  it("returns a PKCS8 private key PEM and a raw 32-byte public key", () => {
    const { privateKeyPem, publicKeyB64 } = generateDeviceKeypairPem();
    expect(privateKeyPem).toContain("BEGIN PRIVATE KEY");
    const raw = Buffer.from(publicKeyB64, "base64");
    expect(raw.length).toBe(32);
    // The raw key must rewrap into a usable ed25519 public key (SPKI prefix).
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
    expect(() => createPublicKey({ key: spki, format: "der", type: "spki" })).not.toThrow();
  });
});
