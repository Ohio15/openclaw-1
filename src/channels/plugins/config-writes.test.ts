import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveChannelConfigWrites } from "./config-writes.js";

// `configWrites` is a permission gate, so its lookup must fail CLOSED, never open.
// The original `accountId in accounts` test is true for "constructor" on every
// object — even when the operator never declared that account — so the lookup
// returned the global `Object`, whose `configWrites` is undefined, and the
// per-account deny silently degraded to the channel-level default.
describe("resolveChannelConfigWrites reads the accounts record own-property-only", () => {
  it("honours a per-account deny on a prototype-named account key", () => {
    const cfg = {
      channels: {
        telegram: {
          configWrites: true,
          accounts: { constructor: { configWrites: false } },
        },
      },
    } as unknown as OpenClawConfig;
    expect(
      resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId: "constructor" }),
    ).toBe(false);
  });

  it("honours a per-account deny written with a non-normalized key", () => {
    const cfg = {
      channels: {
        telegram: {
          configWrites: true,
          accounts: { Constructor: { configWrites: false } },
        },
      },
    } as unknown as OpenClawConfig;
    expect(
      resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId: "constructor" }),
    ).toBe(false);
  });

  it("falls back to the channel-level setting when the account is not declared", () => {
    const cfg = {
      channels: {
        telegram: { configWrites: false, accounts: { ops: { configWrites: true } } },
      },
    } as unknown as OpenClawConfig;
    for (const accountId of ["__proto__", "constructor", "prototype"]) {
      expect(resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId })).toBe(false);
    }
  });
});
