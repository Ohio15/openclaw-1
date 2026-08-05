import { describe, expect, it } from "vitest";
import { resolveIrcAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

// The IRC resolver is TOLERANT: it tries a direct `accounts[id]` hit and then, on
// a miss, scans the record for a key that normalizes to the requested id. That
// makes non-normalized keys legitimately reachable — but only if the direct hit
// actually misses. "constructor" is a `normalizeAccountId` fixed point, so a bare
// `accounts["constructor"]` returns the global `Object`, which is truthy: the scan
// is skipped, the configured account never contributes its settings, and the
// connection silently falls back to the CHANNEL-level server password — the wrong
// identity, from a config that reads as complete.

describe("resolveIrcAccount reads the accounts record own-property-only", () => {
  const cfg = {
    channels: {
      irc: {
        host: "irc.example.org",
        nick: "channelbot",
        password: "channel-password",
        accounts: {
          Constructor: { nick: "opsbot", password: "ops-password" },
        },
      },
    },
  } as unknown as CoreConfig;

  it("resolves a 'Constructor' account to its OWN server password", () => {
    const resolved = resolveIrcAccount({ cfg, accountId: "constructor" });
    expect(resolved.password).toBe("ops-password");
    expect(resolved.password).not.toBe("channel-password");
    expect(resolved.nick).toBe("opsbot");
    expect(resolved.passwordSource).toBe("config");
  });

  it("treats a prototype-named account that was never configured as absent", () => {
    const bare = {
      channels: {
        irc: {
          host: "irc.example.org",
          nick: "channelbot",
          password: "channel-password",
          accounts: { ops: { password: "ops-password" } },
        },
      },
    } as unknown as CoreConfig;
    for (const accountId of ["__proto__", "constructor", "prototype"]) {
      const resolved = resolveIrcAccount({ cfg: bare, accountId });
      // Falls through to the channel block, never to another account's password
      // and never to a prototype object's fields.
      expect(resolved.password).toBe("channel-password");
      expect(resolved.nick).toBe("channelbot");
      expect(resolved.name).toBeUndefined();
      expect(Object.getPrototypeOf(resolved.config)).toBe(Object.prototype);
    }
  });
});
