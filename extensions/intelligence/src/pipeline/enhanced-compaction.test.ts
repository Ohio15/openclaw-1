import { describe, it, expect, beforeEach } from "vitest";
import { EnhancedCompactionManager } from "./enhanced-compaction.js";

// Helper: create fake messages
function makeMessages(count: number, charsPerMessage = 500): unknown[] {
  const msgs: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    const text = `${role === "user" ? "Question" : "Answer"} number ${i}. ${"x".repeat(charsPerMessage)}`;
    msgs.push({ role, content: text });
  }
  return msgs;
}

describe("EnhancedCompactionManager", () => {
  let manager: EnhancedCompactionManager;
  const SESSION = "test-session";

  beforeEach(() => {
    manager = new EnhancedCompactionManager({
      enabled: true,
      triggers: {
        tokenCountThreshold: 1000,    // low for testing
        messageCountThreshold: 10,
        capacityFraction: 0.35,
      },
      recentWindowSize: 4,
      skipComplexShortConversations: true,
      complexityThresholdForSkip: 0.7,
      shortConversationLimit: 8,
    });
  });

  // --------------------------------------------------------------------------
  // Trigger evaluation
  // --------------------------------------------------------------------------

  describe("trigger evaluation", () => {
    it("returns null when no triggers are met", () => {
      const messages = makeMessages(5, 50); // small messages, few count
      const result = manager.checkAndSummarize(messages, SESSION);
      expect(result).toBeNull();
    });

    it("triggers on message count threshold", () => {
      const messages = makeMessages(12, 10); // 12 messages, tiny content
      const result = manager.checkAndSummarize(messages, SESSION);
      expect(result).not.toBeNull();
      expect(result).toContain("context-summary");
    });

    it("triggers on token count threshold", () => {
      // 1000 tokens ≈ 4000 chars, so 6 messages with 800 chars each
      const messages = makeMessages(6, 800);
      const result = manager.checkAndSummarize(messages, SESSION);
      expect(result).not.toBeNull();
    });

    it("triggers on capacity fraction", () => {
      // With contextWindow=5000 tokens and fraction 0.35, need >1750 tokens ≈ 7000 chars
      const messages = makeMessages(8, 1000);
      const result = manager.checkAndSummarize(messages, SESSION, 5000);
      expect(result).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Recent window preservation
  // --------------------------------------------------------------------------

  describe("recent window", () => {
    it("preserves recent messages in summary output", () => {
      const messages = makeMessages(12, 100);
      const result = manager.checkAndSummarize(messages, SESSION);
      expect(result).not.toBeNull();
      // Summary covers older messages (0..7), recent 4 are preserved
      // The summary should contain references to earlier messages
      expect(result).toContain("context-summary");
    });

    it("returns null if fewer messages than recentWindowSize", () => {
      const messages = makeMessages(3, 100);
      const result = manager.checkAndSummarize(messages, SESSION);
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Skip complex short conversations
  // --------------------------------------------------------------------------

  describe("skip complex short conversations", () => {
    it("skips summarization for short + high complexity conversations", () => {
      // Record high complexity
      for (let i = 0; i < 5; i++) {
        manager.recordComplexity(SESSION, 0.9);
      }
      // 7 messages (below shortConversationLimit of 8) but exceed token threshold
      const messages = makeMessages(7, 800);
      const result = manager.checkAndSummarize(messages, SESSION);
      expect(result).toBeNull();
    });

    it("does not skip when conversation is long enough", () => {
      for (let i = 0; i < 5; i++) {
        manager.recordComplexity(SESSION, 0.9);
      }
      // 12 messages (above shortConversationLimit of 8)
      const messages = makeMessages(12, 100);
      const result = manager.checkAndSummarize(messages, SESSION);
      expect(result).not.toBeNull();
    });

    it("does not skip when complexity is low", () => {
      for (let i = 0; i < 5; i++) {
        manager.recordComplexity(SESSION, 0.3);
      }
      // 7 messages, short conversation but low complexity
      const messages = makeMessages(7, 800);
      const result = manager.checkAndSummarize(messages, SESSION);
      expect(result).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Summary caching
  // --------------------------------------------------------------------------

  describe("summary caching", () => {
    it("returns cached summary on subsequent calls with same messages", () => {
      const messages = makeMessages(12, 100);
      const first = manager.checkAndSummarize(messages, SESSION);
      const second = manager.checkAndSummarize(messages, SESSION);
      expect(first).toBe(second); // exact same reference from cache
    });

    it("rebuilds summary when new messages extend beyond cached range", () => {
      const messages = makeMessages(12, 100);
      const first = manager.checkAndSummarize(messages, SESSION);

      // Add more messages
      const extended = [...messages, ...makeMessages(4, 100)];
      const second = manager.checkAndSummarize(extended, SESSION);

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      // New summary should cover more content
      expect(second!.length).toBeGreaterThan(first!.length);
    });

    it("invalidates cache on invalidateCache call", () => {
      const messages = makeMessages(12, 100);
      manager.checkAndSummarize(messages, SESSION);
      manager.invalidateCache(SESSION);

      // Should rebuild (may be same content but regenerated)
      const result = manager.checkAndSummarize(messages, SESSION);
      expect(result).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Summary content
  // --------------------------------------------------------------------------

  describe("summary content", () => {
    it("wraps summary in context-summary tags", () => {
      const messages = makeMessages(12, 100);
      const result = manager.checkAndSummarize(messages, SESSION);
      expect(result).toContain("<context-summary>");
      expect(result).toContain("</context-summary>");
    });

    it("includes user messages in summary", () => {
      const messages = [
        { role: "user", content: "How do I fix the authentication bug?" },
        { role: "assistant", content: "Let me look at the auth middleware..." },
        { role: "user", content: "It breaks when the token expires" },
        { role: "assistant", content: "I see, the refresh logic has a race condition" },
        ...makeMessages(10, 100), // pad to trigger
      ];
      const result = manager.checkAndSummarize(messages, SESSION);
      expect(result).toContain("User:");
      expect(result).toContain("authentication bug");
    });

    it("includes assistant messages in summary", () => {
      const messages = [
        { role: "user", content: "What's the status?" },
        { role: "assistant", content: "All services are running normally" },
        ...makeMessages(10, 100),
      ];
      const result = manager.checkAndSummarize(messages, SESSION);
      expect(result).toContain("Assistant:");
    });

    it("skips tool messages", () => {
      const messages = [
        { role: "user", content: "Run the tests" },
        { role: "tool", content: "PASS: 42 tests passed" },
        { role: "assistant", content: "All tests passed" },
        ...makeMessages(10, 100),
      ];
      const result = manager.checkAndSummarize(messages, SESSION);
      // Tool content should not appear directly in summary
      expect(result).not.toContain("PASS: 42");
    });
  });

  // --------------------------------------------------------------------------
  // Session management
  // --------------------------------------------------------------------------

  describe("session management", () => {
    it("isolates state between sessions", () => {
      for (let i = 0; i < 5; i++) {
        manager.recordComplexity("session-1", 0.9);
      }
      // Session 2 should not inherit session 1's complexity
      const messages = makeMessages(7, 800);
      const result = manager.checkAndSummarize(messages, "session-2");
      // Without complexity recorded, no skip — should trigger
      expect(result).not.toBeNull();
    });

    it("clears session state", () => {
      const messages = makeMessages(12, 100);
      manager.checkAndSummarize(messages, SESSION);
      manager.clearSession(SESSION);

      // After clear, cache is gone and metrics reset
      // With same messages, should rebuild from scratch
      const result = manager.checkAndSummarize(messages, SESSION);
      expect(result).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Disabled state
  // --------------------------------------------------------------------------

  describe("disabled state", () => {
    it("returns null when disabled", () => {
      const disabled = new EnhancedCompactionManager({ enabled: false });
      const messages = makeMessages(50, 500);
      expect(disabled.checkAndSummarize(messages, SESSION)).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Observation hooks
  // --------------------------------------------------------------------------

  describe("logCompactionEvent", () => {
    it("returns metrics snapshot", () => {
      const { metricsSnapshot } = manager.logCompactionEvent(SESSION, {
        messageCount: 25,
        tokenCount: 45000,
      });
      expect(metricsSnapshot.messageCount).toBe(25);
      expect(metricsSnapshot.estimatedTokens).toBe(45000);
    });
  });
});
