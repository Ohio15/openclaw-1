import { describe, expect, it } from "vitest";
import { RunContextStore } from "./run-context.js";

describe("RunContextStore", () => {
  it("returns the prompt and tier recorded for a session", () => {
    const store = new RunContextStore();
    store.record("s1", "fix the build", "medium");
    expect(store.get("s1")).toMatchObject({ prompt: "fix the build", tier: "medium" });
  });

  it("ignores a missing session id on both record and get", () => {
    const store = new RunContextStore();
    store.record(undefined, "p", "small");
    expect(store.size).toBe(0);
    expect(store.get(undefined)).toBeUndefined();
  });

  it("overwrites a session's previous run", () => {
    const store = new RunContextStore();
    store.record("s1", "first", "small");
    store.record("s1", "second", "reasoning");
    expect(store.get("s1")).toMatchObject({ prompt: "second", tier: "reasoning" });
    expect(store.size).toBe(1);
  });

  it("expires entries older than the TTL (a miss, not a default)", () => {
    let t = 1_000;
    const store = new RunContextStore(100, 10, () => t);
    store.record("s1", "p", "large");
    t += 100;
    expect(store.get("s1")).toBeDefined();
    t += 1;
    expect(store.get("s1")).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("evicts the least recently recorded session beyond maxEntries", () => {
    const store = new RunContextStore(60_000, 2);
    store.record("a", "pa", "small");
    store.record("b", "pb", "small");
    store.record("a", "pa2", "medium"); // refresh a; b is now oldest
    store.record("c", "pc", "large");
    expect(store.get("b")).toBeUndefined();
    expect(store.get("a")?.prompt).toBe("pa2");
    expect(store.get("c")?.tier).toBe("large");
    expect(store.size).toBe(2);
  });

  it("rejects non-positive bounds", () => {
    expect(() => new RunContextStore(0)).toThrow();
    expect(() => new RunContextStore(1000, 0)).toThrow();
  });
});
