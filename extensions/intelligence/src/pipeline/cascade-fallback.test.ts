import { describe, it, expect, beforeEach } from "vitest";
import {
  runWithQualityCascade,
  getNextTier,
  TIER_ORDER,
  CEILING_TIER,
  type CascadeConfig,
} from "./cascade-fallback.js";
import {
  cascadeSignals,
  setCascadeSignal,
  consumeCascadeSignal,
  clearCascadeSignals,
} from "../../../../src/intelligence/cascade-state.js";
import { ModelTierResolver } from "./model-tier-resolver.js";

// ============================================================================
// Helpers
// ============================================================================

function makeTierResolver(): ModelTierResolver {
  return new ModelTierResolver({
    tiny: { model: "tiny-model", provider: "test-provider" },
    small: { model: "small-model", provider: "test-provider" },
    medium: { model: "medium-model", provider: "test-provider" },
    large: { model: "large-model", provider: "test-provider" },
    reasoning: { model: "reasoning-model", provider: "test-provider" },
  });
}

function makeLogger() {
  const logs: string[] = [];
  return {
    info: (msg: string) => logs.push(`INFO: ${msg}`),
    warn: (msg: string) => logs.push(`WARN: ${msg}`),
    logs,
  };
}

const defaultConfig: CascadeConfig = {
  cascadeEnabled: true,
  cascadeMaxRetries: 2,
};

// ============================================================================
// Tests: TIER_ORDER and getNextTier
// ============================================================================

describe("TIER_ORDER", () => {
  it("contains all five standard tiers in order", () => {
    expect(TIER_ORDER).toEqual(["tiny", "small", "medium", "large", "reasoning"]);
  });
});

describe("CEILING_TIER", () => {
  it("is the last tier in TIER_ORDER", () => {
    expect(CEILING_TIER).toBe("reasoning");
  });
});

describe("getNextTier", () => {
  it("escalates tiny to small", () => {
    expect(getNextTier("tiny")).toBe("small");
  });

  it("escalates small to medium", () => {
    expect(getNextTier("small")).toBe("medium");
  });

  it("escalates medium to large", () => {
    expect(getNextTier("medium")).toBe("large");
  });

  it("escalates large to reasoning", () => {
    expect(getNextTier("large")).toBe("reasoning");
  });

  it("returns undefined for reasoning (ceiling)", () => {
    expect(getNextTier("reasoning")).toBeUndefined();
  });

  it("returns undefined for unknown tier", () => {
    expect(getNextTier("nonexistent")).toBeUndefined();
  });
});

// ============================================================================
// Tests: cascade-state
// ============================================================================

describe("cascade-state", () => {
  beforeEach(() => {
    cascadeSignals.clear();
  });

  it("setCascadeSignal creates a signal with attempts=1", () => {
    setCascadeSignal("session-1", "retry", "medium");
    const signal = cascadeSignals.get("session-1");
    expect(signal).toBeDefined();
    expect(signal!.verdict).toBe("retry");
    expect(signal!.currentTier).toBe("medium");
    expect(signal!.attempts).toBe(1);
  });

  it("setCascadeSignal increments attempts on repeated calls", () => {
    setCascadeSignal("session-1", "retry", "medium");
    setCascadeSignal("session-1", "retry", "large");
    const signal = cascadeSignals.get("session-1");
    expect(signal!.attempts).toBe(2);
    expect(signal!.currentTier).toBe("large");
  });

  it("setCascadeSignal stores escalation overrides", () => {
    setCascadeSignal("session-1", "retry", "medium", {
      provider: "anthropic",
      model: "claude-opus-4-6",
      tier: "large",
    });
    const signal = cascadeSignals.get("session-1");
    expect(signal!.escalatedProvider).toBe("anthropic");
    expect(signal!.escalatedModel).toBe("claude-opus-4-6");
    expect(signal!.escalatedTier).toBe("large");
  });

  it("consumeCascadeSignal returns and deletes signal", () => {
    setCascadeSignal("session-1", "retry", "medium");
    const signal = consumeCascadeSignal("session-1");
    expect(signal).toBeDefined();
    expect(signal!.verdict).toBe("retry");
    // Second consume returns undefined — single-read semantics
    expect(consumeCascadeSignal("session-1")).toBeUndefined();
  });

  it("consumeCascadeSignal returns undefined for missing session", () => {
    expect(consumeCascadeSignal("nonexistent")).toBeUndefined();
  });

  it("clearCascadeSignals removes signal for session", () => {
    setCascadeSignal("session-1", "retry", "medium");
    setCascadeSignal("session-2", "retry", "small");
    clearCascadeSignals("session-1");
    expect(cascadeSignals.has("session-1")).toBe(false);
    expect(cascadeSignals.has("session-2")).toBe(true);
  });

  it("signals do not leak between sessions", () => {
    setCascadeSignal("session-a", "retry", "tiny");
    setCascadeSignal("session-b", "retry", "large");
    const signalA = consumeCascadeSignal("session-a");
    const signalB = consumeCascadeSignal("session-b");
    expect(signalA!.currentTier).toBe("tiny");
    expect(signalB!.currentTier).toBe("large");
    // Both consumed — no cross-talk
    expect(consumeCascadeSignal("session-a")).toBeUndefined();
    expect(consumeCascadeSignal("session-b")).toBeUndefined();
  });
});

// ============================================================================
// Tests: runWithQualityCascade
// ============================================================================

describe("runWithQualityCascade", () => {
  beforeEach(() => {
    cascadeSignals.clear();
  });

  it("returns immediately when cascade is disabled", async () => {
    let runCount = 0;
    const result = await runWithQualityCascade({
      sessionId: "session-1",
      currentTier: "medium",
      config: { cascadeEnabled: false, cascadeMaxRetries: 2 },
      tierResolver: makeTierResolver(),
      logger: makeLogger(),
      run: async () => {
        runCount += 1;
        return `response-${runCount}`;
      },
    });
    expect(runCount).toBe(1);
    expect(result).toBe("response-1");
  });

  it("returns first result when quality gate does not signal retry", async () => {
    let runCount = 0;
    const result = await runWithQualityCascade({
      sessionId: "session-1",
      currentTier: "medium",
      config: defaultConfig,
      tierResolver: makeTierResolver(),
      logger: makeLogger(),
      run: async () => {
        runCount += 1;
        // No cascade signal set — quality gate accepted the response
        return `response-${runCount}`;
      },
    });
    expect(runCount).toBe(1);
    expect(result).toBe("response-1");
  });

  it("escalates tier when quality gate signals retry", async () => {
    let runCount = 0;
    const overrides: Array<{ provider?: string; model?: string }> = [];
    const result = await runWithQualityCascade({
      sessionId: "session-1",
      currentTier: "medium",
      config: defaultConfig,
      tierResolver: makeTierResolver(),
      logger: makeLogger(),
      run: async (o) => {
        runCount += 1;
        overrides.push(o);
        if (runCount === 1) {
          // Simulate quality gate setting a retry signal after first run
          setCascadeSignal("session-1", "retry", "medium");
        }
        // On second run, no signal — quality accepted
        return `response-${runCount}`;
      },
    });
    expect(runCount).toBe(2);
    expect(result).toBe("response-2");
    // First run has no overrides (original tier)
    expect(overrides[0]).toEqual({});
    // Second run has escalated overrides
    expect(overrides[1].model).toBe("large-model");
    expect(overrides[1].provider).toBe("test-provider");
  });

  it("respects max retry cap of 2", async () => {
    let runCount = 0;
    const result = await runWithQualityCascade({
      sessionId: "session-1",
      currentTier: "small",
      config: { cascadeEnabled: true, cascadeMaxRetries: 2 },
      tierResolver: makeTierResolver(),
      logger: makeLogger(),
      run: async () => {
        runCount += 1;
        // Always signal retry — should stop after 2 retries (3 total runs)
        setCascadeSignal("session-1", "retry", "small");
        return `response-${runCount}`;
      },
    });
    // 1 initial + 2 retries = 3 runs max
    expect(runCount).toBe(3);
    expect(result).toBe("response-3");
  });

  it("stops at ceiling tier (reasoning) regardless of retry signal", async () => {
    let runCount = 0;
    const result = await runWithQualityCascade({
      sessionId: "session-1",
      currentTier: "reasoning",
      config: defaultConfig,
      tierResolver: makeTierResolver(),
      logger: makeLogger(),
      run: async () => {
        runCount += 1;
        setCascadeSignal("session-1", "retry", "reasoning");
        return `response-${runCount}`;
      },
    });
    // Already at ceiling — only 1 run
    expect(runCount).toBe(1);
    expect(result).toBe("response-1");
  });

  it("stops when next tier has no model mapping", async () => {
    let runCount = 0;
    // Resolver with only medium and large — no reasoning mapping
    const sparseResolver = new ModelTierResolver({
      medium: { model: "medium-model", provider: "test" },
      large: { model: "large-model", provider: "test" },
    });
    const result = await runWithQualityCascade({
      sessionId: "session-1",
      currentTier: "large",
      config: defaultConfig,
      tierResolver: sparseResolver,
      logger: makeLogger(),
      run: async () => {
        runCount += 1;
        setCascadeSignal("session-1", "retry", "large");
        return `response-${runCount}`;
      },
    });
    // reasoning tier has no mapping — accept the large-tier response
    expect(runCount).toBe(1);
    expect(result).toBe("response-1");
  });

  it("accepts response when verdict is 'flag' (not 'retry')", async () => {
    let runCount = 0;
    const result = await runWithQualityCascade({
      sessionId: "session-1",
      currentTier: "medium",
      config: defaultConfig,
      tierResolver: makeTierResolver(),
      logger: makeLogger(),
      run: async () => {
        runCount += 1;
        // "flag" verdict means quality issues detected but not severe enough to retry
        setCascadeSignal("session-1", "flag", "medium");
        return `response-${runCount}`;
      },
    });
    expect(runCount).toBe(1);
    expect(result).toBe("response-1");
  });

  it("escalates through multiple tiers across retries", async () => {
    let runCount = 0;
    const overrides: Array<{ provider?: string; model?: string }> = [];
    const result = await runWithQualityCascade({
      sessionId: "session-1",
      currentTier: "small",
      config: { cascadeEnabled: true, cascadeMaxRetries: 2 },
      tierResolver: makeTierResolver(),
      logger: makeLogger(),
      run: async (o) => {
        runCount += 1;
        overrides.push(o);
        if (runCount <= 2) {
          // First two runs trigger retry; third is accepted
          setCascadeSignal("session-1", "retry", runCount === 1 ? "small" : "medium");
        }
        return `response-${runCount}`;
      },
    });
    expect(runCount).toBe(3);
    expect(result).toBe("response-3");
    // Run 1: no override (original small tier)
    expect(overrides[0]).toEqual({});
    // Run 2: escalated to medium
    expect(overrides[1].model).toBe("medium-model");
    // Run 3: escalated to large
    expect(overrides[2].model).toBe("large-model");
  });

  it("cleans up lingering signal after max retries", async () => {
    let runCount = 0;
    await runWithQualityCascade({
      sessionId: "session-1",
      currentTier: "medium",
      config: { cascadeEnabled: true, cascadeMaxRetries: 1 },
      tierResolver: makeTierResolver(),
      logger: makeLogger(),
      run: async () => {
        runCount += 1;
        setCascadeSignal("session-1", "retry", "medium");
        return `response-${runCount}`;
      },
    });
    // Signal should be consumed/cleared — no leakage
    expect(consumeCascadeSignal("session-1")).toBeUndefined();
  });

  it("logs cascade events via provided logger", async () => {
    const logger = makeLogger();
    let runCount = 0;
    await runWithQualityCascade({
      sessionId: "session-1",
      currentTier: "medium",
      config: defaultConfig,
      tierResolver: makeTierResolver(),
      logger,
      run: async () => {
        runCount += 1;
        if (runCount === 1) {
          setCascadeSignal("session-1", "retry", "medium");
        }
        return `response-${runCount}`;
      },
    });
    const cascadeLogs = logger.logs.filter((l) => l.includes("cascade"));
    expect(cascadeLogs.length).toBeGreaterThan(0);
    expect(cascadeLogs[0]).toContain("escalating");
    expect(cascadeLogs[0]).toContain("medium");
    expect(cascadeLogs[0]).toContain("large");
  });
});
