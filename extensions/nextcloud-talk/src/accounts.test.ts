import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

// Tolerant resolver (direct hit, then normalized-key scan). A bare
// `accounts["constructor"]` returns the truthy global `Object`, which suppresses
// the scan, so a configured "Constructor" account silently presents the
// CHANNEL-level bot secret instead of its own.

describe("resolveNextcloudTalkAccount reads the accounts record own-property-only", () => {
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.NEXTCLOUD_TALK_BOT_SECRET;
    delete process.env.NEXTCLOUD_TALK_BOT_SECRET;
  });

  afterEach(() => {
    if (prev === undefined) {
      delete process.env.NEXTCLOUD_TALK_BOT_SECRET;
    } else {
      process.env.NEXTCLOUD_TALK_BOT_SECRET = prev;
    }
  });

  const cfg = {
    channels: {
      "nextcloud-talk": {
        baseUrl: "https://cloud.example.org",
        botSecret: "channel-secret",
        accounts: {
          Constructor: { botSecret: "ops-secret", name: "ops" },
        },
      },
    },
  } as unknown as CoreConfig;

  it("resolves a 'Constructor' account to its OWN bot secret", () => {
    const resolved = resolveNextcloudTalkAccount({ cfg, accountId: "constructor" });
    expect(resolved.secret).toBe("ops-secret");
    expect(resolved.secret).not.toBe("channel-secret");
    expect(resolved.name).toBe("ops");
  });

  it("treats a prototype-named account that was never configured as absent", () => {
    const bare = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.org",
          botSecret: "channel-secret",
          accounts: { ops: { botSecret: "ops-secret" } },
        },
      },
    } as unknown as CoreConfig;
    for (const accountId of ["__proto__", "constructor", "prototype"]) {
      const resolved = resolveNextcloudTalkAccount({ cfg: bare, accountId });
      expect(resolved.secret).toBe("channel-secret");
      expect(resolved.name).toBeUndefined();
      expect(Object.getPrototypeOf(resolved.config)).toBe(Object.prototype);
    }
  });
});
