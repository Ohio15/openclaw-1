import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

// Work item cc0c85af: `channels.signal.accounts.<id>.receive` is a validated
// boolean, so a typo cannot silently leave an account subscribed.
describe("signal account receive flag validation", () => {
  const cfg = (receive: unknown) => ({
    channels: {
      signal: {
        transport: "rest",
        httpUrl: "http://signal-api:8080",
        accounts: { cortex: { account: "+15550002222", receive } },
      },
    },
  });

  it("accepts receive: false and receive: true", () => {
    expect(validateConfigObject(cfg(false)).ok).toBe(true);
    expect(validateConfigObject(cfg(true)).ok).toBe(true);
  });

  it("rejects a non-boolean receive", () => {
    for (const bad of ["false", 0, "no", null]) {
      expect(validateConfigObject(cfg(bad)).ok, String(bad)).toBe(false);
    }
  });
});
