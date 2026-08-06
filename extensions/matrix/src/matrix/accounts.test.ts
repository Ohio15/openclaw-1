import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../types.js";
import { resolveMatrixAccount } from "./accounts.js";
import { resolveMatrixConfigForAccount } from "./client.js";

vi.mock("./credentials.js", () => ({
  loadMatrixCredentials: () => null,
  credentialsMatchConfig: () => false,
}));

const envKeys = [
  "MATRIX_HOMESERVER",
  "MATRIX_USER_ID",
  "MATRIX_ACCESS_TOKEN",
  "MATRIX_PASSWORD",
  "MATRIX_DEVICE_NAME",
];

describe("resolveMatrixAccount", () => {
  let prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    prevEnv = {};
    for (const key of envKeys) {
      prevEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = prevEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("treats access-token-only config as configured", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "tok-access",
        },
      },
    };

    const account = resolveMatrixAccount({ cfg });
    expect(account.configured).toBe(true);
  });

  it("requires userId + password when no access token is set", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
        },
      },
    };

    const account = resolveMatrixAccount({ cfg });
    expect(account.configured).toBe(false);
  });

  it("marks password auth as configured when userId is present", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          password: "secret",
        },
      },
    };

    const account = resolveMatrixAccount({ cfg });
    expect(account.configured).toBe(true);
  });
});

// Tolerant resolver (direct hit, then normalized-key scan). "constructor" is a
// `normalizeAccountId` fixed point, so a bare `accounts["constructor"]` answers
// with the truthy global `Object`, suppresses the scan, and leaves the account on
// the CHANNEL-level access token — the wrong Matrix identity for a config that
// reads as complete.

describe("matrix account lookups are own-property-only", () => {
  it("resolves a 'Constructor' account to its OWN access token and homeserver", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://channel.example.org",
          userId: "@channel:example.org",
          accessToken: "channel-access-token",
          accounts: {
            Constructor: {
              homeserver: "https://ops.example.org",
              userId: "@ops:example.org",
              accessToken: "ops-access-token",
            },
          },
        },
      },
    } as unknown as CoreConfig;

    const resolved = resolveMatrixConfigForAccount(cfg, "constructor", {});
    expect(resolved.accessToken).toBe("ops-access-token");
    expect(resolved.accessToken).not.toBe("channel-access-token");
    expect(resolved.homeserver).toBe("https://ops.example.org");

    const account = resolveMatrixAccount({ cfg, accountId: "constructor" });
    expect(account.homeserver).toBe("https://ops.example.org");
    expect(account.configured).toBe(true);
    // `resolveMatrixAccountConfig` is a second, independent lookup of the same
    // record — it must reach the account too, not fall back to the channel block.
    expect(account.config.accessToken).toBe("ops-access-token");
    expect(account.config.homeserver).toBe("https://ops.example.org");
  });

  it("treats a prototype-named account that was never configured as absent", () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          homeserver: "https://channel.example.org",
          userId: "@channel:example.org",
          accessToken: "channel-access-token",
          accounts: { ops: { accessToken: "ops-access-token" } },
        },
      },
    } as unknown as CoreConfig;

    for (const accountId of ["__proto__", "constructor", "prototype"]) {
      const resolved = resolveMatrixConfigForAccount(cfg, accountId, {});
      expect(resolved.accessToken).toBe("channel-access-token");
      expect(resolved.homeserver).toBe("https://channel.example.org");
      const account = resolveMatrixAccount({ cfg, accountId });
      expect(account.name).toBeUndefined();
      expect(Object.getPrototypeOf(account.config)).toBe(Object.prototype);
    }
  });
});
