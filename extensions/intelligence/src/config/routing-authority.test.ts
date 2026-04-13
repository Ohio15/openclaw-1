import { describe, it, expect } from "vitest";
import {
  MODEL_TIERS,
  DOMAIN_ESCALATIONS,
  TASK_TYPE_MODELS,
  selectTier,
  selectPipeline,
  getQualityThreshold,
} from "./routing-authority.js";

// ============================================================================
// selectTier
// ============================================================================

describe("selectTier", () => {
  describe("complexity-based selection (no domain, no task type)", () => {
    it("routes complexity 0.1 to tiny", () => {
      const result = selectTier(0.1);
      expect(result.tier).toBe("tiny");
      expect(result.reason).toContain("Complexity 0.10");
    });

    it("routes complexity 0.3 to small", () => {
      const result = selectTier(0.3);
      expect(result.tier).toBe("small");
      expect(result.reason).toContain("Complexity 0.30");
    });

    it("routes complexity 0.5 to medium", () => {
      const result = selectTier(0.5);
      expect(result.tier).toBe("medium");
      expect(result.reason).toContain("Complexity 0.50");
    });

    it("routes complexity 0.7 to large", () => {
      const result = selectTier(0.7);
      expect(result.tier).toBe("large");
      expect(result.reason).toContain("Complexity 0.70");
    });

    it("routes complexity 0.9 to reasoning", () => {
      const result = selectTier(0.9);
      expect(result.tier).toBe("reasoning");
      expect(result.reason).toContain("Complexity 0.90");
    });

    it("falls back to reasoning at complexity 1.0", () => {
      const result = selectTier(1.0);
      expect(result.tier).toBe("reasoning");
      expect(result.reason).toContain("Complexity 1.00");
    });
  });

  describe("domain escalation", () => {
    it('escalates "auth" domain to large when complexity >= 0.3', () => {
      const result = selectTier(0.5, "auth");
      expect(result.tier).toBe("large");
      expect(result.reason).toContain("Domain escalation: auth -> large");
      expect(result.reason).toContain("complexity 0.50");
    });

    it('does NOT escalate "auth" when complexity < 0.3', () => {
      const result = selectTier(0.2, "auth");
      // Should fall through to complexity-based: 0.2 <= 0.2 -> tiny
      expect(result.tier).toBe("tiny");
      expect(result.reason).not.toContain("Domain escalation");
    });

    it('escalates "database" domain to medium when complexity >= 0.3', () => {
      const result = selectTier(0.4, "database");
      expect(result.tier).toBe("medium");
      expect(result.reason).toContain("Domain escalation: database -> medium");
    });
  });

  describe("task type selection", () => {
    it('routes task type "code_generation" to large when complexity fits', () => {
      const result = selectTier(0.5, null, "code_generation");
      expect(result.tier).toBe("large");
      expect(result.reason).toBe("Task type: code_generation -> large");
    });

    it('routes task type "documentation" to small when complexity fits', () => {
      const result = selectTier(0.2, null, "documentation");
      expect(result.tier).toBe("small");
      expect(result.reason).toBe("Task type: documentation -> small");
    });

    it("falls through to complexity-based when task type tier maxComplexity is exceeded", () => {
      // "documentation" maps to "small" which has maxComplexity 0.4
      // complexity 0.5 exceeds that, so it should fall through to complexity-based
      const result = selectTier(0.5, null, "documentation");
      expect(result.tier).toBe("medium");
      expect(result.reason).toContain("Complexity 0.50");
      expect(result.reason).not.toContain("Task type");
    });
  });
});

// ============================================================================
// selectPipeline
// ============================================================================

describe("selectPipeline", () => {
  it("returns simple for low complexity and few requirements", () => {
    const result = selectPipeline(0.2, 1, "explain how variables work");
    expect(result.pipeline).toBe("simple");
    expect(result.reason).toBe("Default: low complexity, few requirements");
  });

  it("returns complex when complexity >= 0.4", () => {
    const result = selectPipeline(0.5);
    expect(result.pipeline).toBe("complex");
    expect(result.reason).toContain("Complexity 0.50 >= 0.4");
  });

  it("returns complex when requirement count >= 4", () => {
    const result = selectPipeline(0.2, 5);
    expect(result.pipeline).toBe("complex");
    expect(result.reason).toContain("Requirements 5 >= 4");
  });

  it('matches "implement an algorithm" pattern as complex', () => {
    const result = selectPipeline(0.1, 0, "implement an algorithm for sorting");
    expect(result.pipeline).toBe("complex");
    expect(result.reason).toContain("Pattern match");
  });

  it('matches "refactor the entire module" pattern as complex', () => {
    const result = selectPipeline(0.1, 0, "refactor the entire module");
    expect(result.pipeline).toBe("complex");
    expect(result.reason).toContain("Pattern match");
  });
});

// ============================================================================
// getQualityThreshold
// ============================================================================

describe("getQualityThreshold", () => {
  it("returns development profile with correct thresholds", () => {
    const result = getQualityThreshold("development");
    expect(result).toEqual({ minQuality: 0.65, autoApprove: 0.85 });
  });

  it("returns production profile with correct thresholds", () => {
    const result = getQualityThreshold("production");
    expect(result).toEqual({ minQuality: 0.8, autoApprove: 0.95 });
  });

  it("falls back to development profile for unknown profile names", () => {
    const result = getQualityThreshold("nonexistent_profile");
    expect(result).toEqual({ minQuality: 0.65, autoApprove: 0.85 });
  });
});
