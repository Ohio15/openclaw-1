import { describe, it, expect, beforeEach, vi } from "vitest";
import { AnalysisCache, promptHash } from "./analysis-cache.js";

describe("AnalysisCache", () => {
  let cache: AnalysisCache<{ value: number }>;

  beforeEach(() => {
    cache = new AnalysisCache<{ value: number }>(1000); // 1s TTL for tests
  });

  it("returns undefined for cache miss", () => {
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  it("returns cached result on hit", () => {
    cache.set("key1", { value: 42 });
    expect(cache.get("key1")).toEqual({ value: 42 });
  });

  it("returns undefined after TTL expires", () => {
    vi.useFakeTimers();
    try {
      cache.set("key1", { value: 42 });
      expect(cache.get("key1")).toEqual({ value: 42 });

      vi.advanceTimersByTime(1001);
      expect(cache.get("key1")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a specific key", () => {
    cache.set("key1", { value: 1 });
    cache.set("key2", { value: 2 });
    cache.clear("key1");
    expect(cache.get("key1")).toBeUndefined();
    expect(cache.get("key2")).toEqual({ value: 2 });
  });

  it("clears all entries when no key provided", () => {
    cache.set("key1", { value: 1 });
    cache.set("key2", { value: 2 });
    cache.clear();
    expect(cache.get("key1")).toBeUndefined();
    expect(cache.get("key2")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("sweeps expired entries", () => {
    vi.useFakeTimers();
    try {
      cache.set("old", { value: 1 });
      vi.advanceTimersByTime(500);
      cache.set("new", { value: 2 });
      vi.advanceTimersByTime(600); // old is now 1100ms, new is 600ms

      const removed = cache.sweep();
      expect(removed).toBe(1);
      expect(cache.get("old")).toBeUndefined();
      expect(cache.get("new")).toEqual({ value: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks size correctly", () => {
    expect(cache.size).toBe(0);
    cache.set("a", { value: 1 });
    expect(cache.size).toBe(1);
    cache.set("b", { value: 2 });
    expect(cache.size).toBe(2);
    cache.clear("a");
    expect(cache.size).toBe(1);
  });
});

describe("promptHash", () => {
  it("returns consistent hash for same input", () => {
    const h1 = promptHash("hello world");
    const h2 = promptHash("hello world");
    expect(h1).toBe(h2);
  });

  it("returns different hash for different input", () => {
    const h1 = promptHash("hello world");
    const h2 = promptHash("goodbye world");
    expect(h1).not.toBe(h2);
  });

  it("returns a string", () => {
    expect(typeof promptHash("test")).toBe("string");
  });

  it("handles empty string", () => {
    const h = promptHash("");
    expect(typeof h).toBe("string");
  });
});
