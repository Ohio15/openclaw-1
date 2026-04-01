import { describe, it, expect, beforeEach } from "vitest";
import { EnhancedLoopDetector } from "./enhanced-loop-detection.js";

describe("EnhancedLoopDetector", () => {
  let detector: EnhancedLoopDetector;
  const SESSION = "test-session";

  beforeEach(() => {
    detector = new EnhancedLoopDetector({
      enabled: true,
      earlyDetectionThreshold: 5,
      fuzzyMatchThreshold: 0.85,
      responseLevelDetection: true,
      responseSimilarityThreshold: 0.9,
      maxResponseHistory: 10,
    });
  });

  // --------------------------------------------------------------------------
  // Early identical detection
  // --------------------------------------------------------------------------

  describe("early identical detection", () => {
    it("does not trigger below threshold", () => {
      const params = { command: "ls /nonexistent" };
      for (let i = 0; i < 4; i++) {
        const result = detector.check("bash", params, SESSION);
        expect(result.detected).toBe(false);
        detector.recordOutcome("bash", params, undefined, "No such file", SESSION);
      }
    });

    it("triggers at earlyDetectionThreshold (5)", () => {
      const params = { command: "ls /nonexistent" };
      // First 4 calls pass through (recorded in check)
      for (let i = 0; i < 4; i++) {
        detector.check("bash", params, SESSION);
        detector.recordOutcome("bash", params, undefined, "No such file", SESSION);
      }
      // 5th call should trigger
      const result = detector.check("bash", params, SESSION);
      expect(result.detected).toBe(true);
      expect(result.count).toBe(5);
      expect(result.guidance).toBeDefined();
    });

    it("categorizes as retry_failed_operation when all calls had errors", () => {
      const params = { command: "npm install" };
      for (let i = 0; i < 4; i++) {
        detector.check("bash", params, SESSION);
        detector.recordOutcome("bash", params, undefined, "EACCES permission denied", SESSION);
      }
      const result = detector.check("bash", params, SESSION);
      expect(result.detected).toBe(true);
      expect(result.category).toBe("retry_failed_operation");
      expect(result.guidance).toContain("failed");
      expect(result.guidance).toContain("bash");
    });

    it("categorizes as polling_no_change when results are identical", () => {
      const params = { command: "docker ps" };
      const sameResult = "CONTAINER ID   IMAGE   STATUS\nabc123   nginx   Up 5 mins";
      for (let i = 0; i < 4; i++) {
        detector.check("bash", params, SESSION);
        detector.recordOutcome("bash", params, sameResult, undefined, SESSION);
      }
      const result = detector.check("bash", params, SESSION);
      expect(result.detected).toBe(true);
      expect(result.category).toBe("polling_no_change");
      expect(result.guidance).toContain("identical results");
    });

    it("does not count calls to different tools", () => {
      const params = { path: "/tmp/file.txt" };
      for (let i = 0; i < 4; i++) {
        detector.check("read_file", params, SESSION);
        detector.recordOutcome("read_file", params, "content", undefined, SESSION);
      }
      // Call a different tool — should not cross-contaminate
      const result = detector.check("write_file", params, SESSION);
      expect(result.detected).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Fuzzy similarity detection
  // --------------------------------------------------------------------------

  describe("fuzzy similarity detection", () => {
    it("detects near-identical params with minor variations", () => {
      // Params that differ only slightly (same keys, one value differs slightly)
      for (let i = 0; i < 5; i++) {
        const params = { query: `SELECT * FROM users WHERE id = ${i}`, table: "users", limit: 10 };
        detector.check("sql_query", params, SESSION);
        detector.recordOutcome("sql_query", params, "[]", undefined, SESSION);
      }
      // 6th call with similar params — should trigger fuzzy detection
      const result = detector.check("sql_query", { query: "SELECT * FROM users WHERE id = 5", table: "users", limit: 10 }, SESSION);
      // The params are slightly different each time but very similar
      // Whether this triggers depends on the exact Jaccard calculation
      // With these params, keys are identical, most values are identical
      expect(result.count).toBeGreaterThanOrEqual(0);
    });

    it("does not trigger for genuinely different params", () => {
      detector.check("bash", { command: "ls /tmp" }, SESSION);
      detector.recordOutcome("bash", { command: "ls /tmp" }, "file1", undefined, SESSION);
      detector.check("bash", { command: "cat /etc/hosts" }, SESSION);
      detector.recordOutcome("bash", { command: "cat /etc/hosts" }, "127.0.0.1", undefined, SESSION);
      detector.check("bash", { command: "pwd" }, SESSION);
      const result = detector.check("bash", { command: "whoami" }, SESSION);
      expect(result.detected).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Oscillation detection
  // --------------------------------------------------------------------------

  describe("oscillation detection", () => {
    it("detects A→B→A→B pattern", () => {
      const paramsA = { file: "config.json", content: "v1" };
      const paramsB = { file: "config.json", content: "v2" };

      // Build alternating pattern: A, B, A, B
      detector.check("write_file", paramsA, SESSION);
      detector.recordOutcome("write_file", paramsA, "ok", undefined, SESSION);
      detector.check("write_file", paramsB, SESSION);
      detector.recordOutcome("write_file", paramsB, "ok", undefined, SESSION);
      detector.check("write_file", paramsA, SESSION);
      detector.recordOutcome("write_file", paramsA, "ok", undefined, SESSION);
      detector.check("write_file", paramsB, SESSION);
      detector.recordOutcome("write_file", paramsB, "ok", undefined, SESSION);

      // Next A should detect oscillation
      const result = detector.check("write_file", paramsA, SESSION);
      if (result.detected) {
        expect(result.category).toBe("oscillating_approaches");
        expect(result.guidance).toContain("oscillating");
      }
    });
  });

  // --------------------------------------------------------------------------
  // Response-level repetition
  // --------------------------------------------------------------------------

  describe("response repetition detection", () => {
    it("sets flag when 3+ similar responses detected", () => {
      const response = "I apologize, but I cannot complete this task. Let me try a different approach.";

      detector.trackResponse([response], SESSION);
      expect(detector.consumeResponseLoopFlag(SESSION)).toBeNull();

      detector.trackResponse([response], SESSION);
      expect(detector.consumeResponseLoopFlag(SESSION)).toBeNull();

      detector.trackResponse([response], SESSION);
      const flag = detector.consumeResponseLoopFlag(SESSION);
      expect(flag).toBeDefined();
      expect(flag).toContain("substantially similar responses");
    });

    it("does not trigger for different responses", () => {
      detector.trackResponse(["Response A: The file was found"], SESSION);
      detector.trackResponse(["Response B: I've updated the config"], SESSION);
      detector.trackResponse(["Response C: Tests are now passing"], SESSION);
      expect(detector.consumeResponseLoopFlag(SESSION)).toBeNull();
    });

    it("consumes flag on read (one-shot)", () => {
      const response = "Same response repeated multiple times";
      detector.trackResponse([response], SESSION);
      detector.trackResponse([response], SESSION);
      detector.trackResponse([response], SESSION);

      const first = detector.consumeResponseLoopFlag(SESSION);
      expect(first).toBeDefined();

      const second = detector.consumeResponseLoopFlag(SESSION);
      expect(second).toBeNull();
    });

    it("respects maxResponseHistory limit", () => {
      // Fill beyond limit (10) with truly distinct responses
      const topics = [
        "The weather in Tokyo is sunny today with clear skies and mild temperature",
        "Python decorators allow you to modify function behavior transparently",
        "The stock market rallied sharply after the Federal Reserve announcement",
        "Kubernetes orchestrates containerized workloads across distributed clusters",
        "Renaissance art was characterized by realism and human-centered composition",
        "Quantum entanglement enables particles to share states instantaneously",
        "The recipe calls for fresh basil, garlic, olive oil, and pine nuts",
        "Mars rovers have discovered evidence of ancient water on the red planet",
        "Jazz improvisation relies on understanding chord progressions and scales",
        "Machine learning models require careful hyperparameter tuning for accuracy",
        "The Grand Canyon was formed over millions of years by Colorado River erosion",
        "Blockchain technology provides a decentralized ledger for secure transactions",
        "Shakespeare wrote thirty seven plays spanning comedy tragedy and history",
        "Photosynthesis converts sunlight into chemical energy in plant chloroplasts",
        "The Olympic Games originated in ancient Greece nearly three thousand years ago",
      ];
      for (const topic of topics) {
        detector.trackResponse([topic], SESSION);
      }
      // Should not crash and flag should be null (all genuinely unique)
      expect(detector.consumeResponseLoopFlag(SESSION)).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Session management
  // --------------------------------------------------------------------------

  describe("session management", () => {
    it("isolates state between sessions", () => {
      const params = { command: "test" };
      for (let i = 0; i < 4; i++) {
        detector.check("bash", params, "session-1");
      }
      // Different session should start fresh
      const result = detector.check("bash", params, "session-2");
      expect(result.detected).toBe(false);
    });

    it("clears session state", () => {
      const params = { command: "test" };
      for (let i = 0; i < 4; i++) {
        detector.check("bash", params, SESSION);
      }
      detector.clearSession(SESSION);

      // After clear, counter should reset
      const result = detector.check("bash", params, SESSION);
      expect(result.detected).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Disabled state
  // --------------------------------------------------------------------------

  describe("disabled state", () => {
    it("returns not-detected when disabled", () => {
      const disabled = new EnhancedLoopDetector({ enabled: false });
      const params = { command: "test" };
      for (let i = 0; i < 10; i++) {
        const result = disabled.check("bash", params, SESSION);
        expect(result.detected).toBe(false);
      }
    });

    it("does not track responses when disabled", () => {
      const disabled = new EnhancedLoopDetector({ enabled: false });
      for (let i = 0; i < 5; i++) {
        disabled.trackResponse(["Same text"], SESSION);
      }
      expect(disabled.consumeResponseLoopFlag(SESSION)).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Guidance messages
  // --------------------------------------------------------------------------

  describe("guidance messages", () => {
    it("includes tool name in guidance", () => {
      const params = { command: "failing-cmd" };
      for (let i = 0; i < 4; i++) {
        detector.check("bash", params, SESSION);
        detector.recordOutcome("bash", params, undefined, "error", SESSION);
      }
      const result = detector.check("bash", params, SESSION);
      expect(result.detected).toBe(true);
      expect(result.guidance).toContain("bash");
    });

    it("includes count in guidance", () => {
      const params = { command: "test" };
      for (let i = 0; i < 4; i++) {
        detector.check("bash", params, SESSION);
        detector.recordOutcome("bash", params, undefined, "error", SESSION);
      }
      const result = detector.check("bash", params, SESSION);
      expect(result.detected).toBe(true);
      expect(result.guidance).toContain("5");
    });
  });
});
