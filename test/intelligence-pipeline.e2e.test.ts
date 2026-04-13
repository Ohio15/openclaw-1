/**
 * Intelligence Pipeline E2E Tests
 *
 * Exercises the full control-plane flow: prompt analysis -> complexity scoring ->
 * domain detection -> tier selection -> model resolution -> pipeline selection.
 *
 * All components are real instances with pure-logic execution (no network, no I/O).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { analyzeComplexity } from "../extensions/intelligence/src/pipeline/complexity-decomposer.js";
import { selectTier, selectPipeline } from "../extensions/intelligence/src/config/routing-authority.js";
import { ModelTierResolver } from "../extensions/intelligence/src/pipeline/model-tier-resolver.js";
import { SubAgentOrchestrator } from "../extensions/intelligence/src/pipeline/sub-agent-orchestrator.js";

// ---------------------------------------------------------------------------
// NEXUS tier map — maps abstract tiers to concrete local Ollama models
// ---------------------------------------------------------------------------

const NEXUS_TIER_MAP = {
  tiny: { model: "ollama/qwen3.5:9b", provider: "ollama" },
  small: { model: "ollama/qwen3.5:9b", provider: "ollama" },
  medium: { model: "ollama/qwen2.5:14b", provider: "ollama" },
  large: { model: "ollama/qwen3.5:9b", provider: "ollama" },
  reasoning: { model: "ollama/qwen3:30b-a3b", provider: "ollama" },
};

// ---------------------------------------------------------------------------
// Simplified domain detection (mirrors control-plane.ts keyword matching)
// ---------------------------------------------------------------------------

function detectDomain(prompt: string): string | null {
  const lower = prompt.toLowerCase();
  if (/\b(auth|jwt|oauth|session|login|permission)\b/.test(lower)) return "auth";
  if (/\b(database|postgres|mongodb|sql|orm)\b/.test(lower)) return "database";
  if (/\b(cache|lru_cache|redis)\b/.test(lower)) return "cache";
  if (/\b(rate.?limit|token.?bucket)\b/.test(lower)) return "rate_limiter";
  return null;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Intelligence Pipeline E2E", () => {
  let resolver: ModelTierResolver;
  let orchestrator: SubAgentOrchestrator;

  beforeEach(() => {
    resolver = new ModelTierResolver(NEXUS_TIER_MAP);
    orchestrator = new SubAgentOrchestrator();
  });

  // -------------------------------------------------------------------------
  // 1. Trivial arithmetic — tiny tier
  // -------------------------------------------------------------------------
  it("routes trivial arithmetic to tiny tier with qwen3.5:9b", () => {
    const prompt = "what is 2+2";
    const analysis = analyzeComplexity(prompt);

    expect(analysis.complexity).toBeLessThan(0.2);

    const domain = detectDomain(prompt);
    const tierSelection = selectTier(analysis.complexity, domain);

    expect(tierSelection.tier).toBe("tiny");

    const override = resolver.resolve(tierSelection);
    expect(override).not.toBeNull();
    expect(override!.modelOverride).toBe("ollama/qwen3.5:9b");
    expect(override!.providerOverride).toBe("ollama");

    const pipelineSelection = selectPipeline(analysis.complexity, analysis.featureCount, prompt);
    expect(pipelineSelection.pipeline).toBe("simple");
  });

  // -------------------------------------------------------------------------
  // 2. Conceptual explanation with moderate indicators — small tier
  // -------------------------------------------------------------------------
  it("routes moderate conceptual explanation to small tier with qwen3.5:9b", () => {
    const prompt = "describe database indexing and query optimization strategies";
    const analysis = analyzeComplexity(prompt);

    expect(analysis.complexity).toBeGreaterThan(0.2);
    expect(analysis.complexity).toBeLessThanOrEqual(0.4);

    const domain = detectDomain(prompt);
    // Domain is "database" but complexity-based routing lands in small,
    // and database escalation targets medium — however selectTier checks
    // complexity >= 0.3 for domain escalation. At 0.296 it falls through
    // to pure complexity-based selection -> small.
    const tierSelection = selectTier(analysis.complexity, domain);

    expect(tierSelection.tier).toBe("small");

    const override = resolver.resolve(tierSelection);
    expect(override).not.toBeNull();
    expect(override!.modelOverride).toBe("ollama/qwen3.5:9b");
  });

  // -------------------------------------------------------------------------
  // 3. REST API with database — medium tier via domain escalation
  // -------------------------------------------------------------------------
  it("routes database-domain REST API task to medium tier with qwen2.5:14b", () => {
    const prompt = "build a database-backed API with comprehensive testing and optimization";
    const analysis = analyzeComplexity(prompt);

    const domain = detectDomain(prompt);
    expect(domain).toBe("database");

    // Complexity must be >= 0.3 for domain escalation to activate
    expect(analysis.complexity).toBeGreaterThanOrEqual(0.3);

    const tierSelection = selectTier(analysis.complexity, domain);

    // Database domain escalates to medium tier
    expect(tierSelection.tier).toBe("medium");

    const override = resolver.resolve(tierSelection);
    expect(override).not.toBeNull();
    expect(override!.modelOverride).toBe("ollama/qwen2.5:14b");
    expect(override!.providerOverride).toBe("ollama");
  });

  // -------------------------------------------------------------------------
  // 4. JWT authentication — auth domain escalation to large tier
  // -------------------------------------------------------------------------
  it("escalates auth-domain JWT task to large tier with qwen3.5:9b", () => {
    const prompt =
      "implement JWT authentication with refresh tokens, session management, and RBAC for a production API";
    const analysis = analyzeComplexity(prompt);

    const domain = detectDomain(prompt);
    expect(domain).toBe("auth");

    // Complexity must be >= 0.3 for domain escalation to activate
    expect(analysis.complexity).toBeGreaterThanOrEqual(0.3);

    const tierSelection = selectTier(analysis.complexity, domain);

    // Auth domain escalates to large when complexity >= 0.3
    expect(tierSelection.tier).toBe("large");
    expect(tierSelection.reason).toContain("Domain escalation");

    const override = resolver.resolve(tierSelection);
    expect(override).not.toBeNull();
    expect(override!.modelOverride).toBe("ollama/qwen3.5:9b");
  });

  // -------------------------------------------------------------------------
  // 5. CRDT collaborative editing — reasoning tier
  // -------------------------------------------------------------------------
  it("routes high-complexity algorithm design to reasoning tier with qwen3:30b-a3b", () => {
    const prompt =
      "design a CRDT-based collaborative editing algorithm with operational transform " +
      "for a real-time production system with authentication";
    const analysis = analyzeComplexity(prompt);

    // This prompt triggers multiple high-weight indicators:
    // algorithms, realtime, authentication, production
    expect(analysis.complexity).toBeGreaterThan(0.6);
    expect(analysis.indicators.length).toBeGreaterThanOrEqual(3);

    const domain = detectDomain(prompt);
    const tierSelection = selectTier(analysis.complexity, domain);

    // High complexity should push past large into reasoning
    expect(tierSelection.tier).toBe("reasoning");

    const override = resolver.resolve(tierSelection);
    expect(override).not.toBeNull();
    expect(override!.modelOverride).toBe("ollama/qwen3:30b-a3b");
    expect(override!.providerOverride).toBe("ollama");
  });

  // -------------------------------------------------------------------------
  // 6. Pipeline selection: trivial prompt → simple pipeline
  // -------------------------------------------------------------------------
  it("selects simple pipeline for trivial prompts", () => {
    const prompt = "what is the capital of France";
    const analysis = analyzeComplexity(prompt);
    const pipelineSelection = selectPipeline(analysis.complexity, analysis.featureCount, prompt);

    expect(pipelineSelection.pipeline).toBe("simple");
    expect(pipelineSelection.reason).toContain("low complexity");
  });

  // -------------------------------------------------------------------------
  // 7. Pipeline selection: complex pattern → complex pipeline
  // -------------------------------------------------------------------------
  it("selects complex pipeline when prompt matches implement.*algorithm pattern", () => {
    const prompt = "implement a sorting algorithm with merge sort optimization";
    const pipelineSelection = selectPipeline(0.5, 2, prompt);

    expect(pipelineSelection.pipeline).toBe("complex");
    expect(pipelineSelection.reason).toContain("Pattern match");
  });

  // -------------------------------------------------------------------------
  // 8. Deterministic: same prompt always produces same tier
  // -------------------------------------------------------------------------
  it("produces deterministic tier selection for the same prompt", () => {
    const prompt = "build a caching layer with Redis integration and LRU eviction";
    const runs = Array.from({ length: 10 }, () => {
      const analysis = analyzeComplexity(prompt);
      const domain = detectDomain(prompt);
      const tierSelection = selectTier(analysis.complexity, domain);
      const override = resolver.resolve(tierSelection);
      return { tier: tierSelection.tier, model: override?.modelOverride };
    });

    const firstRun = runs[0];
    for (const run of runs) {
      expect(run.tier).toBe(firstRun.tier);
      expect(run.model).toBe(firstRun.model);
    }
  });

  // -------------------------------------------------------------------------
  // 9. SubAgentOrchestrator.buildChainedPrompt produces valid structured prompt
  // -------------------------------------------------------------------------
  it("builds a valid chained prompt with step tags for high-complexity tasks", () => {
    const subTasks = [
      {
        name: "Analyze Requirements",
        description: "Break down the system requirements into discrete components.",
        priority: 1,
        dependencies: [],
      },
      {
        name: "Design Data Model",
        description: "Design the database schema and entity relationships.",
        priority: 2,
        dependencies: ["Analyze Requirements"],
      },
      {
        name: "Implement API Layer",
        description: "Build the REST endpoints with validation and error handling.",
        priority: 3,
        dependencies: ["Design Data Model"],
      },
    ];

    const chainedPrompt = orchestrator.buildChainedPrompt(subTasks, "Enterprise SaaS platform");

    // Verify structural elements
    expect(chainedPrompt).toContain("## Multi-Step Task Execution");
    expect(chainedPrompt).toContain("### Domain Context");
    expect(chainedPrompt).toContain("Enterprise SaaS platform");

    // Verify each step is present with its tags
    expect(chainedPrompt).toContain("### Step 1: Analyze Requirements");
    expect(chainedPrompt).toContain("<step-1>");
    expect(chainedPrompt).toContain("</step-1>");

    expect(chainedPrompt).toContain("### Step 2: Design Data Model");
    expect(chainedPrompt).toContain("<step-2>");
    expect(chainedPrompt).toContain("</step-2>");

    expect(chainedPrompt).toContain("### Step 3: Implement API Layer");
    expect(chainedPrompt).toContain("<step-3>");
    expect(chainedPrompt).toContain("</step-3>");

    // Verify dependency references
    expect(chainedPrompt).toContain("Analyze Requirements");

    // Verify final integration section
    expect(chainedPrompt).toContain("### Final Integration");
    expect(chainedPrompt).toContain("<final>");
    expect(chainedPrompt).toContain("</final>");
  });

  // -------------------------------------------------------------------------
  // 10. All five tiers are reachable with appropriate prompts
  // -------------------------------------------------------------------------
  it("can reach all five tiers with appropriate prompts", () => {
    const tierPrompts: Record<string, { prompt: string; domain: string | null }> = {
      tiny: {
        prompt: "hi",
        domain: null,
      },
      small: {
        prompt: "describe database indexing and query optimization strategies",
        // Domain is "database" but complexity 0.296 < 0.3 so escalation doesn't
        // activate — falls through to complexity-based routing -> small
        domain: null,
      },
      medium: {
        prompt: "build a database-backed API with comprehensive testing and optimization",
        domain: "database",
      },
      large: {
        prompt:
          "implement JWT authentication with refresh tokens, session management, and RBAC for a production API",
        domain: "auth",
      },
      reasoning: {
        prompt:
          "design a CRDT-based collaborative editing algorithm with operational transform " +
          "for a real-time production system with authentication",
        domain: null,
      },
    };

    const reachedTiers = new Set<string>();

    for (const [expectedTier, { prompt, domain: explicitDomain }] of Object.entries(tierPrompts)) {
      const analysis = analyzeComplexity(prompt);
      const domain = explicitDomain ?? detectDomain(prompt);
      const tierSelection = selectTier(analysis.complexity, domain);

      expect(tierSelection.tier).toBe(expectedTier);

      const override = resolver.resolve(tierSelection);
      expect(override).not.toBeNull();
      expect(override!.modelOverride).toBe(NEXUS_TIER_MAP[expectedTier as keyof typeof NEXUS_TIER_MAP].model);

      reachedTiers.add(tierSelection.tier);
    }

    // Confirm all 5 tiers were actually reached
    expect(reachedTiers.size).toBe(5);
    expect(reachedTiers).toEqual(new Set(["tiny", "small", "medium", "large", "reasoning"]));
  });
});
