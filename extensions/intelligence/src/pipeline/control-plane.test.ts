import { describe, it, expect } from "vitest";
import { extractUserPrompt, detectDomain } from "./control-plane.js";

describe("extractUserPrompt", () => {
  it("extracts string content from last user message", () => {
    const messages = [
      { role: "user", content: "first message" },
      { role: "assistant", content: "response" },
      { role: "user", content: "second message" },
    ];
    expect(extractUserPrompt(messages)).toBe("second message");
  });

  it("extracts text from content block array", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "hello " },
          { type: "text", text: "world" },
        ],
      },
    ];
    expect(extractUserPrompt(messages)).toBe("hello \nworld");
  });

  it("returns empty string for no user messages", () => {
    const messages = [{ role: "assistant", content: "response" }];
    expect(extractUserPrompt(messages)).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(extractUserPrompt([])).toBe("");
  });
});

describe("detectDomain", () => {
  it("returns jwt over auth when both keywords present", () => {
    const result = detectDomain("implement JWT authentication middleware");
    expect(result).toBe("jwt");
  });

  it("returns oauth over auth when oauth present", () => {
    const result = detectDomain("implement OAuth authorization flow");
    expect(result).toBe("oauth");
  });

  it("returns token_bucket over rate_limiter", () => {
    const result = detectDomain("implement a rate limit using token bucket algorithm");
    expect(result).toBe("token_bucket");
  });

  it("returns sliding_window at highest priority", () => {
    const result = detectDomain("create a sliding window rate limiter with caching");
    expect(result).toBe("sliding_window");
  });

  it("returns auth for generic authentication mentions", () => {
    const result = detectDomain("add authentication middleware to the login flow");
    expect(result).toBe("auth");
  });

  it("returns null for no domain matches", () => {
    const result = detectDomain("what time is it?");
    expect(result).toBeNull();
  });

  it("does not false-match 'query parameters' as database", () => {
    // "query" was removed from the database regex to prevent false matches
    const result = detectDomain("parse query parameters from the URL");
    expect(result).not.toBe("database");
  });

  it("returns database for actual database mentions", () => {
    const result = detectDomain("create a postgres database schema");
    expect(result).toBe("database");
  });

  it("returns most specific domain when multiple match", () => {
    // "trie" is more specific (priority 8) than "api" (priority 3)
    const result = detectDomain("build a trie-based API for autocomplete");
    expect(result).toBe("trie");
  });

  it("returns security for security audit mentions", () => {
    const result = detectDomain("run a security audit for XSS vulnerabilities");
    expect(result).toBe("security");
  });
});
