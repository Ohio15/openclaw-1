import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { resolveDiscordAccount } from "../discord/accounts.js";
import { resolveDiscordToken } from "../discord/token.js";
import { resolveIMessageAccount } from "../imessage/accounts.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { resolveSlackAccount } from "../slack/accounts.js";
import { resolveTelegramAccount } from "../telegram/accounts.js";
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
});

// Own-only resolver reads (`getOwnProperty`).
//
// A prototype-named account id that the config never declared must resolve as
// ABSENT. A bare `accounts[id]` answers "constructor" with the global `Object`
// and "__proto__" with `Object.prototype` — objects the operator never wrote —
// and both are truthy, which is what makes them dangerous: a resolver that tests
// the direct hit for truthiness treats the prototype object as a real account.
//
// These cases carry a POPULATED accounts block on purpose. The previous version
// of this test used a config with no `accounts` key at all, so every resolver
// early-returned before reaching the line under test and the case could not fail.
// PROTOTYPE_NAMED_IDS are the only two strings that are simultaneously a
// `normalizeAccountId` fixed point (hence a reachable account id) and truthy on a
// plain object; "prototype" is carried along as the control that is neither.

const PROTOTYPE_NAMED_IDS = ["__proto__", "constructor", "prototype"];

describe("resolvers read the accounts record own-property-only", () => {
  it("discord: a prototype-named id that is not configured falls through to the channel block", () => {
    const cfg = expectValidConfig(
      validateConfigObject({
        channels: {
          discord: {
            token: "channel-bot-token",
            accounts: { ops: { token: "ops-bot-token" } },
          },
        },
      }),
    );
    for (const accountId of PROTOTYPE_NAMED_IDS) {
      const resolved = resolveDiscordAccount({ cfg, accountId });
      expect(Object.getPrototypeOf(resolved.config)).toBe(Object.prototype);
      // Not the other account's token, and not the channel token either: only the
      // DEFAULT account inherits the channel-level token.
      expect(resolved.token).toBe("");
      expect(resolved.tokenSource).toBe("none");
      expect(resolved.name).toBeUndefined();
      // The prototype objects carry no per-account settings, so nothing they own
      // may appear in the merged view.
      expect(Object.hasOwn(resolved.config, "accounts")).toBe(false);
    }
  });

  it("discord/token: a prototype-named id resolves no token from the accounts record", () => {
    const cfg = expectValidConfig(
      validateConfigObject({
        channels: {
          discord: {
            token: "channel-bot-token",
            accounts: { ops: { token: "ops-bot-token" } },
          },
        },
      }),
    );
    for (const accountId of PROTOTYPE_NAMED_IDS) {
      expect(resolveDiscordToken(cfg, { accountId })).toEqual({ token: "", source: "none" });
    }
  });

  it("slack: a prototype-named id that is not configured falls through to the channel block", () => {
    const cfg = expectValidConfig(
      validateConfigObject({
        channels: {
          slack: {
            botToken: "xoxb-channel",
            accounts: { ops: { botToken: "xoxb-ops" } },
          },
        },
      }),
    );
    for (const accountId of PROTOTYPE_NAMED_IDS) {
      const resolved = resolveSlackAccount({ cfg, accountId });
      expect(resolved.botToken).not.toBe("xoxb-ops");
      expect(resolved.name).toBeUndefined();
      expect(Object.getPrototypeOf(resolved.config)).toBe(Object.prototype);
    }
  });

  it("imessage: a prototype-named id that is not configured falls through to the channel block", () => {
    const cfg = expectValidConfig(
      validateConfigObject({
        channels: {
          imessage: {
            dbPath: "/channel.db",
            accounts: { ops: { dbPath: "/ops.db" } },
          },
        },
      }),
    );
    for (const accountId of PROTOTYPE_NAMED_IDS) {
      const resolved = resolveIMessageAccount({ cfg, accountId });
      expect(resolved.config.dbPath).toBe("/channel.db");
      expect(resolved.name).toBeUndefined();
      expect(Object.getPrototypeOf(resolved.config)).toBe(Object.prototype);
    }
  });

  it("whatsapp: a prototype-named id does not inherit a name from the global Object", () => {
    // WhatsApp reads `accountCfg?.name` off the raw lookup result instead of off a
    // spread copy, so a bare `accounts["constructor"]` surfaces `Object.name` —
    // the string "Object" — as the account's display name.
    const cfg = expectValidConfig(
      validateConfigObject({
        channels: {
          whatsapp: {
            sendReadReceipts: true,
            accounts: { ops: { sendReadReceipts: false } },
          },
        },
      }),
    );
    for (const accountId of PROTOTYPE_NAMED_IDS) {
      const resolved = resolveWhatsAppAccount({ cfg, accountId });
      expect(resolved.name).toBeUndefined();
      // Falls through to the channel-level setting, not the "ops" account's.
      expect(resolved.sendReadReceipts).toBe(true);
    }
  });
});

// Telegram and IRC have TOLERANT resolvers: a direct hit is tried first, then the
// record is scanned for a key that normalizes to the requested id. That makes
// non-normalized keys legitimately reachable — so the strict fixed-point guard
// must NOT be applied to them — but it also means a truthy direct hit SKIPS the
// scan. "constructor" is a normalizeAccountId fixed point, so `accounts["constructor"]`
// returning the global `Object` silently suppresses the scan and the configured
// account never contributes its own credential. That is the same wrong-identity
// outcome the strict channels have, reached by a different route.

describe("tolerant resolvers still reach a non-normalized prototype-named key", () => {
  it("telegram: a 'Constructor' account resolves to its OWN bot token", () => {
    const cfg = expectValidConfig(
      validateConfigObject({
        channels: {
          telegram: {
            botToken: "channel-bot-token",
            accounts: { Constructor: { botToken: "ops-bot-token", name: "ops" } },
          },
        },
      }),
    );
    const resolved = resolveTelegramAccount({ cfg, accountId: "constructor" });
    expect(resolved.token).toBe("ops-bot-token");
    expect(resolved.token).not.toBe("channel-bot-token");
    expect(resolved.name).toBe("ops");
  });

  it("telegram: a non-normalized key stays accepted by the schema (tolerant resolver)", () => {
    const cfg = expectValidConfig(
      validateConfigObject({
        channels: {
          telegram: {
            botToken: "channel-bot-token",
            accounts: { "Ops.EU": { botToken: "ops-bot-token" } },
          },
        },
      }),
    );
    expect(resolveTelegramAccount({ cfg, accountId: "ops-eu" }).token).toBe("ops-bot-token");
  });
});

// The retrievability half of the guard, applied to the tolerant channels. An
// unretrievable key is not merely non-normalized — the record parse drops it, so
// there is nothing left for the tolerant scan to find and the account silently
// falls back to the channel-level credential.

describe.each(["telegram", "irc"])("config %s accounts key retrievability", (channel) => {
  it("rejects an accounts key the record parse would silently drop (__proto__)", () => {
    const raw = parseJson5(`{
      channels: {
        ${channel}: {
          accounts: { "__proto__": {} },
        },
      },
    }`);
    const accountsObj = (raw as { channels: Record<string, { accounts: object }> }).channels[
      channel
    ].accounts;
    expect(Object.hasOwn(accountsObj, "__proto__")).toBe(true);

    const issues = expectInvalidConfig(validateConfigObject(raw));
    expect(issues.map((issue) => issue.path)).toContain(`channels.${channel}.accounts.__proto__`);
  });

  for (const key of NON_NORMALIZED_KEYS) {
    it(`keeps a non-normalized key the tolerant resolver can still reach: ${JSON.stringify(key)}`, () => {
      // The fixed-point half of the guard must NOT be applied here: these keys are
      // reachable, so rejecting them would break working configs.
      expectValidConfig(
        validateConfigObject({ channels: { [channel]: { accounts: { [key]: {} } } } }),
      );
    });
  }
});
