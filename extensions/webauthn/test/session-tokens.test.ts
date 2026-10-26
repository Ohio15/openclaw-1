import { describe, it, expect, afterEach, vi } from "vitest";
import { SessionTokenStore } from "../src/session-tokens.js";

describe("SessionTokenStore", () => {
  const stores: SessionTokenStore[] = [];

  function createStore(): SessionTokenStore {
    const store = new SessionTokenStore();
    stores.push(store);
    return store;
  }

  afterEach(() => {
    for (const store of stores) {
      store.destroy();
    }
    stores.length = 0;
    vi.restoreAllMocks();
  });

  it("create returns valid token string", () => {
    const store = createStore();
    const token = store.createSessionToken();

    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThanOrEqual(32);
    // base64url format — no +, /, or = characters
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("validate returns true for valid token", () => {
    const store = createStore();
    const token = store.createSessionToken();

    const valid = store.validateSessionToken(token);
    expect(valid).toBe(true);
  });

  it("validate returns false for unknown token", () => {
    const store = createStore();
    // Create a token just so the store isn't empty
    store.createSessionToken();

    const valid = store.validateSessionToken("completely-random-nonexistent-token");
    expect(valid).toBe(false);
  });

  it("expired tokens fail validation", () => {
    // Freeze the clock BEFORE creating the token so expiry is independent of wall-clock drift.
    const frozenNow = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(frozenNow);
    const store = createStore();
    const token = store.createSessionToken();

    // Advance time past the 24-hour TTL (86_400_000ms)
    nowSpy.mockReturnValue(frozenNow + 86_400_001);

    const valid = store.validateSessionToken(token);
    expect(valid).toBe(false);
  });

  it("cleanup removes expired tokens while keeping valid ones", () => {
    // Freeze the clock BEFORE creating tokens so expiry is independent of wall-clock drift.
    const realNow = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(realNow);
    const store = createStore();

    const oldToken = store.createSessionToken();

    // Advance time past TTL
    nowSpy.mockReturnValue(realNow + 86_400_001);

    // Creating a new token triggers cleanup internally
    const freshToken = store.createSessionToken();

    // Old token should be invalid (expired and cleaned up)
    expect(store.validateSessionToken(oldToken)).toBe(false);

    // Fresh token should be valid — it was created at the mocked "now"
    expect(store.validateSessionToken(freshToken)).toBe(true);

    nowSpy.mockRestore();
  });
});
