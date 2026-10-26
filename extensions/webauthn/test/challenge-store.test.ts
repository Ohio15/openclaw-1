import { describe, it, expect, afterEach, vi } from "vitest";
import { ChallengeStore } from "../src/challenge-store.js";

describe("ChallengeStore", () => {
  const stores: ChallengeStore[] = [];

  function createStore(): ChallengeStore {
    const store = new ChallengeStore();
    stores.push(store);
    return store;
  }

  afterEach(() => {
    for (const store of stores) {
      store.destroy();
    }
    stores.length = 0;
  });

  it("set and get challenge", () => {
    const store = createStore();
    const challenge = Buffer.from("test-challenge-bytes-1234");
    store.set("registration:abc", challenge);

    const retrieved = store.get("registration:abc");
    expect(retrieved).not.toBeNull();
    expect(Buffer.from(retrieved!).toString()).toBe("test-challenge-bytes-1234");
  });

  it("get returns null for missing key", () => {
    const store = createStore();

    const result = store.get("nonexistent-key");
    expect(result).toBeNull();
  });

  it("expired challenges return null", () => {
    // Freeze the clock BEFORE creating the entry so expiry is independent of wall-clock drift.
    const frozenNow = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(frozenNow);
    const store = createStore();
    const challenge = Buffer.from("will-expire");

    store.set("auth:expire-test", challenge);

    // Fast-forward time past the 5 minute TTL (300_000ms)
    nowSpy.mockReturnValue(frozenNow + 300_001);

    const result = store.get("auth:expire-test");
    expect(result).toBeNull();

    vi.restoreAllMocks();
  });

  it("delete removes challenge", () => {
    const store = createStore();
    store.set("auth:to-delete", Buffer.from("delete-me"));

    store.delete("auth:to-delete");

    const result = store.get("auth:to-delete");
    expect(result).toBeNull();
  });

  it("cleanup removes expired entries", () => {
    // Freeze the clock BEFORE creating entries so expiry is independent of wall-clock drift.
    const realNow = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(realNow);
    const store = createStore();

    // Add entries at different times using direct manipulation
    store.set("fresh", Buffer.from("fresh-challenge"));

    // We need to manipulate internal state for the "old" entry.
    // Set it normally first, then advance time and run cleanup.
    store.set("old", Buffer.from("old-challenge"));

    // Advance time past TTL for the "old" entry
    nowSpy.mockReturnValue(realNow + 300_001);

    // Run cleanup — this should remove both entries since both are now expired
    // relative to the advanced clock
    store.cleanup();

    // Both were set at realNow, both are expired at realNow + 300_001
    // Getting "fresh" would also be null since get() deletes after retrieval,
    // but cleanup already removed them
    const freshResult = store.get("fresh");
    const oldResult = store.get("old");
    expect(freshResult).toBeNull();
    expect(oldResult).toBeNull();

    nowSpy.mockRestore();

    // Now verify that a newly-set entry is NOT cleaned up
    const store2 = createStore();
    store2.set("new-entry", Buffer.from("alive"));
    store2.cleanup();
    const newResult = store2.get("new-entry");
    expect(newResult).not.toBeNull();
    expect(Buffer.from(newResult!).toString()).toBe("alive");
  });
});
