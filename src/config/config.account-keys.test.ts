import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { resolveDiscordAccount } from "../discord/accounts.js";
import { resolveIMessageAccount } from "../imessage/accounts.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { resolveSlackAccount } from "../slack/accounts.js";
import { resolveWhatsAppAccount } from "../web/accounts.js";
import { validateConfigObject } from "./config.js";

// Cross-channel account-key validation.
//
// Each of these channels resolves a per-account config by normalizing the
// requested id (`normalizeAccountId`, the routing normalizer) and then doing an
// EXACT `accounts[normalized]` lookup (whatsapp trims a caller-normalized id —
// same contract). A config key that is not a `normalizeAccountId` fixed point
// ("Alerts", "ops.eu", "DEFAULT", anything over 64 chars) — or a key a plain
// object cannot retrieve at all (`__proto__`) — validates green as a complete
// per-account identity and is then unreachable at runtime, so the account
// silently falls back to the CHANNEL-level credential (wrong bot token / API key
// / service account / per-account config). These fences close that class,
// mirroring the Signal mTLS fence. They assert `ok:false` plus the issue path
// only: pinning the prose would go red on a wording edit and stay green for a
// mutant that keeps the sentence while dropping the rejection.

function expectValidConfig(result: ReturnType<typeof validateConfigObject>) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("expected config to be valid");
  }
  return result.config;
}

function expectInvalidConfig(result: ReturnType<typeof validateConfigObject>) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected config to be invalid");
  }
  return result.issues;
}

// A JSON5 document keeps "__proto__" as an own key of the parsed object, exactly
// as `parseConfigJson5` hands it to validation. An object literal would drive the
// prototype setter instead and test nothing.
const parseJson5 = (source: string): unknown => JSON5.parse(source);

const NON_NORMALIZED_KEYS = ["Alerts", "ops.eu", "ops eu", "DEFAULT", "a".repeat(70)];

// Every first-party channel whose schema is core-validated and whose resolver
// normalizes-then-exact-looks-up. All per-account fields are optional, so an
// empty account block is a valid entry — the guard fires on the KEY, not the
// value.
const GUARDED_CHANNELS = ["discord", "slack", "imessage", "whatsapp", "googlechat", "bluebubbles"];

describe.each(GUARDED_CHANNELS)("config %s accounts key validation", (channel) => {
  const configWith = (accounts: Record<string, unknown>) => ({
    channels: { [channel]: { accounts } },
  });

  for (const key of NON_NORMALIZED_KEYS) {
    it(`rejects an accounts key the runtime lookup can never match: ${JSON.stringify(key)}`, () => {
      expect(normalizeAccountId(key)).not.toBe(key);
      const issues = expectInvalidConfig(validateConfigObject(configWith({ [key]: {} })));
      expect(issues.map((issue) => issue.path)).toContain(`channels.${channel}.accounts.${key}`);
    });
  }

  it("rejects an accounts key the record parse would silently drop (__proto__)", () => {
    const raw = parseJson5(`{
      channels: {
        ${channel}: {
          accounts: { "__proto__": {} },
        },
      },
    }`);
    // Premise: the key really is an own key of the parsed document, so the fence
    // has to run before the record parse discards it.
    const accountsObj = (raw as { channels: Record<string, { accounts: object }> }).channels[
      channel
    ].accounts;
    expect(Object.hasOwn(accountsObj, "__proto__")).toBe(true);
    expect(normalizeAccountId("__proto__")).toBe("__proto__");

    const issues = expectInvalidConfig(validateConfigObject(raw));
    expect(issues.map((issue) => issue.path)).toContain(`channels.${channel}.accounts.__proto__`);
  });

  it("keeps ordinary own keys that only LOOK unusual (constructor, prototype)", () => {
    // The fence is about retrievability, not about unusual-looking names.
    const cfg = expectValidConfig(
      validateConfigObject(configWith({ constructor: {}, prototype: {} })),
    );
    expect(cfg.channels?.[channel]).toBeDefined();
  });
});

// The normalized spelling of each rejected key must still load AND resolve to its
// OWN credential — not the channel-level one. This is the positive half of the
// class: the guard rejects unreachable keys without rejecting the reachable ones.

describe("config account keys resolve to their own credential", () => {
  it("discord: a normalized account key resolves to its own bot token", () => {
    const cfg = expectValidConfig(
      validateConfigObject({
        channels: {
          discord: {
            token: "channel-bot-token",
            accounts: { [normalizeAccountId("ops.eu")]: { token: "ops-bot-token" } },
          },
        },
      }),
    );
    const resolved = resolveDiscordAccount({ cfg, accountId: "ops-eu" });
    expect(resolved.token).toBe("ops-bot-token");
    expect(resolved.token).not.toBe("channel-bot-token");
  });

  it("slack: a normalized account key resolves to its own bot token", () => {
    const cfg = expectValidConfig(
      validateConfigObject({
        channels: {
          slack: {
            botToken: "xoxb-channel",
            accounts: { [normalizeAccountId("ops.eu")]: { botToken: "xoxb-ops" } },
          },
        },
      }),
    );
    const resolved = resolveSlackAccount({ cfg, accountId: "ops-eu" });
    expect(resolved.botToken).toBe("xoxb-ops");
    expect(resolved.botToken).not.toBe("xoxb-channel");
  });

  it("imessage: a normalized account key resolves to its own dbPath", () => {
    const cfg = expectValidConfig(
      validateConfigObject({
        channels: {
          imessage: {
            dbPath: "/channel.db",
            accounts: { [normalizeAccountId("ops.eu")]: { dbPath: "/ops.db" } },
          },
        },
      }),
    );
    const resolved = resolveIMessageAccount({ cfg, accountId: "ops-eu" });
    expect(resolved.config.dbPath).toBe("/ops.db");
    expect(resolved.config.dbPath).not.toBe("/channel.db");
  });

  it("whatsapp: a normalized account key resolves to its own per-account setting", () => {
    const cfg = expectValidConfig(
      validateConfigObject({
        channels: {
          whatsapp: {
            sendReadReceipts: true,
            accounts: { [normalizeAccountId("ops.eu")]: { sendReadReceipts: false } },
          },
        },
      }),
    );
    const resolved = resolveWhatsAppAccount({ cfg, accountId: "ops-eu" });
    expect(resolved.sendReadReceipts).toBe(false);
  });

  it("discord: resolving an undefined prototype-named account yields a plain view, not Object.prototype", () => {
    // Defense-in-depth for the resolver's own-only read (`getOwnProperty`): a
    // request for a prototype-named account that was never configured must fall
    // through to the channel block with a plain object, never surface
    // Object.prototype / the global Object constructor.
    const cfg = expectValidConfig(
      validateConfigObject({ channels: { discord: { token: "channel-bot-token" } } }),
    );
    for (const accountId of ["__proto__", "constructor", "prototype"]) {
      const resolved = resolveDiscordAccount({ cfg, accountId });
      expect(typeof resolved.config).toBe("object");
      expect(Object.getPrototypeOf(resolved.config)).toBe(Object.prototype);
      // No account-level token was defined for these ids, and only the DEFAULT
      // account inherits the channel-level token, so resolution is "none".
      expect(resolved.token).toBe("");
    }
  });
});
