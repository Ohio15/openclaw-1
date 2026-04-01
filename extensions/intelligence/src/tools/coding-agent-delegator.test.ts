import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CodingAgentDelegator, type CodingAgentConfig } from "./coding-agent-delegator.js";

// We test the delegator by spawning real processes (echo, sleep, etc.)
// These are lightweight and don't require external AI tools.

const TEST_CONFIG: CodingAgentConfig = {
  enabled: true,
  defaultAgent: "echo-agent",
  delegationComplexityThreshold: 0.8,
  maxConcurrentDelegations: 2,
  agents: {
    "echo-agent": {
      command: process.platform === "win32" ? "cmd" : "echo",
      args: process.platform === "win32" ? ["/c", "echo"] : [],
      timeoutMs: 10_000,
      maxOutputChars: 1000,
      promptTemplate: "{task}",
    },
    "slow-agent": {
      command: process.platform === "win32" ? "cmd" : "sleep",
      args: process.platform === "win32" ? ["/c", "timeout /t"] : [],
      timeoutMs: 2_000,
      maxOutputChars: 1000,
      promptTemplate: "{task}",
    },
    "verbose-agent": {
      command: process.platform === "win32" ? "cmd" : "yes",
      args: process.platform === "win32" ? ["/c", "echo"] : [],
      timeoutMs: 5_000,
      maxOutputChars: 100, // very small for testing truncation
      promptTemplate: "{task}",
    },
  },
};

describe("CodingAgentDelegator", () => {
  let delegator: CodingAgentDelegator;

  beforeEach(() => {
    delegator = new CodingAgentDelegator(TEST_CONFIG);
  });

  afterEach(() => {
    delegator.killAll();
  });

  // --------------------------------------------------------------------------
  // Basic delegation
  // --------------------------------------------------------------------------

  describe("basic delegation", () => {
    it("delegates to the echo agent and captures output", async () => {
      const result = await delegator.delegate("hello world");
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("hello world");
      expect(result.truncated).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it("returns error for unknown agent", async () => {
      const result = await delegator.delegate("task", "nonexistent-agent");
      expect(result.success).toBe(false);
      expect(result.output).toContain("Unknown coding agent");
      expect(result.output).toContain("nonexistent-agent");
    });

    it("uses defaultAgent when agent not specified", async () => {
      const result = await delegator.delegate("default test");
      expect(result.success).toBe(true);
      expect(result.output).toContain("default test");
    });
  });

  // --------------------------------------------------------------------------
  // Timeout handling
  // --------------------------------------------------------------------------

  describe("timeout handling", () => {
    it("times out long-running processes", async () => {
      const longRunning = new CodingAgentDelegator({
        ...TEST_CONFIG,
        agents: {
          "slow": {
            command: "node",
            args: ["-e", "setTimeout(function(){},60000)"], // hang for 60s
            timeoutMs: 1_000, // 1 second timeout
            maxOutputChars: 1000,
            promptTemplate: "", // no task appended
          },
        },
        defaultAgent: "slow",
      });

      const result = await longRunning.delegate("ignored");
      expect(result.timedOut).toBe(true);
      expect(result.output).toContain("TIMEOUT");
      longRunning.killAll();
    }, 15_000);
  });

  // --------------------------------------------------------------------------
  // Concurrent limits
  // --------------------------------------------------------------------------

  describe("concurrent limits", () => {
    it("rejects delegation when at max concurrent limit", async () => {
      const limited = new CodingAgentDelegator({
        ...TEST_CONFIG,
        maxConcurrentDelegations: 1,
        agents: {
          "slow": {
            command: "node",
            args: ["-e", "setTimeout(function(){},30000)"],
            timeoutMs: 30_000,
            maxOutputChars: 1000,
            promptTemplate: "",
          },
        },
        defaultAgent: "slow",
      });

      // Start first delegation (will run for a while)
      const first = limited.delegate("ignored");

      // Give it a moment to start and be tracked
      await new Promise((r) => setTimeout(r, 1000));

      // Second delegation should be rejected synchronously (before spawn)
      const second = await limited.delegate("ignored");
      expect(second.success).toBe(false);
      expect(second.output).toContain("Maximum concurrent delegations");

      // Clean up — kill processes and don't wait for first to finish
      limited.killAll();
      // Race: either first resolves or we time out gracefully
      await Promise.race([
        first.catch(() => {}),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    }, 30_000);

    it("tracks active delegations count", () => {
      expect(delegator.activeDelegations).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Output truncation
  // --------------------------------------------------------------------------

  describe("output truncation", () => {
    it("truncates output exceeding maxOutputChars", async () => {
      // Use a command that produces lots of output
      const verboseConfig: CodingAgentConfig = {
        ...TEST_CONFIG,
        defaultAgent: "verbose",
        agents: {
          "verbose": {
            command: process.platform === "win32" ? "cmd" : "bash",
            args: process.platform === "win32"
              ? ["/c", "for /L %i in (1,1,200) do @echo line-%i-padding-text-to-make-output-very-long"]
              : ["-c"],
            timeoutMs: 5_000,
            maxOutputChars: 200, // very small
            promptTemplate: process.platform === "win32" ? "{task}" : "for i in $(seq 1 200); do echo line-$i-padding-text-to-make-output-very-long; done",
          },
        },
      };
      const verbose = new CodingAgentDelegator(verboseConfig);
      const task = process.platform === "win32" ? "ignored" : "ignored";
      const result = await verbose.delegate(task, "verbose");
      if (result.output.length > 200) {
        expect(result.truncated).toBe(true);
        expect(result.output).toContain("TRUNCATED");
      }
      verbose.killAll();
    }, 10_000);
  });

  // --------------------------------------------------------------------------
  // Abort signal
  // --------------------------------------------------------------------------

  describe("abort signal", () => {
    it("aborts delegation when signal fires", async () => {
      const controller = new AbortController();
      const slowConfig: CodingAgentConfig = {
        ...TEST_CONFIG,
        defaultAgent: "slow",
        agents: {
          "slow": {
            command: "node",
            args: ["-e", "setTimeout(function(){},60000)"], // hang for 60s
            timeoutMs: 60_000,
            maxOutputChars: 1000,
            promptTemplate: "", // no task appended
          },
        },
      };
      const slow = new CodingAgentDelegator(slowConfig);

      // Start delegation then abort after 500ms
      const promise = slow.delegate("ignored", "slow", undefined, undefined, controller.signal);
      setTimeout(() => controller.abort(), 500);

      const result = await promise;
      expect(result.output).toContain("ABORTED");
      slow.killAll();
    }, 15_000);
  });

  // --------------------------------------------------------------------------
  // killAll
  // --------------------------------------------------------------------------

  describe("killAll", () => {
    it("does not throw when no active delegations", () => {
      expect(() => delegator.killAll()).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Spawn failure
  // --------------------------------------------------------------------------

  describe("spawn failure", () => {
    it("handles failed spawn gracefully", async () => {
      const badConfig: CodingAgentConfig = {
        ...TEST_CONFIG,
        defaultAgent: "nonexistent",
        agents: {
          "nonexistent": {
            command: "/absolutely/nonexistent/binary/xyz123",
            args: [],
            timeoutMs: 5_000,
            maxOutputChars: 1000,
            promptTemplate: "{task}",
          },
        },
      };
      const bad = new CodingAgentDelegator(badConfig);
      const result = await bad.delegate("test");
      expect(result.success).toBe(false);
    });
  });
});
