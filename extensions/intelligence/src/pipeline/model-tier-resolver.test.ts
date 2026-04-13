import { describe, it, expect } from "vitest";
import { ModelTierResolver, LOCAL_TIER_DEFAULTS } from "./model-tier-resolver.js";

describe("ModelTierResolver", () => {
  // ==========================================================================
  // Constructor
  // ==========================================================================

  describe("constructor", () => {
    it("accepts no arguments and defaults to empty config", () => {
      const resolver = new ModelTierResolver();
      // Should not throw; resolve should return null for any tier
      expect(resolver.resolve({ tier: "tiny", reason: "test" })).toBeNull();
    });

    it("accepts a provided config", () => {
      const resolver = new ModelTierResolver({
        fast: { model: "gpt-4o-mini", provider: "openai" },
      });
      const result = resolver.resolve({ tier: "fast", reason: "speed" });
      expect(result).not.toBeNull();
      expect(result!.modelOverride).toBe("gpt-4o-mini");
      expect(result!.providerOverride).toBe("openai");
    });
  });

  // ==========================================================================
  // resolve()
  // ==========================================================================

  describe("resolve", () => {
    it("returns correct modelOverride and providerOverride for a configured tier", () => {
      const resolver = new ModelTierResolver({
        medium: { model: "claude-sonnet-4-20250514", provider: "anthropic" },
      });
      const result = resolver.resolve({ tier: "medium", reason: "balanced cost" });
      expect(result).toEqual({
        modelOverride: "claude-sonnet-4-20250514",
        providerOverride: "anthropic",
        backend: "api",
        latencyClass: undefined,
        costClass: undefined,
      });
    });

    it("returns only modelOverride when provider is absent", () => {
      const resolver = new ModelTierResolver({
        cheap: { model: "gpt-4o-mini" },
      });
      const result = resolver.resolve({ tier: "cheap", reason: "cost savings" });
      expect(result).not.toBeNull();
      expect(result!.modelOverride).toBe("gpt-4o-mini");
      expect(result!.providerOverride).toBeUndefined();
    });

    it("returns only providerOverride when model is absent", () => {
      const resolver = new ModelTierResolver({
        routed: { provider: "azure" },
      });
      const result = resolver.resolve({ tier: "routed", reason: "region routing" });
      expect(result).not.toBeNull();
      expect(result!.modelOverride).toBeUndefined();
      expect(result!.providerOverride).toBe("azure");
    });

    it("returns null for an unmapped tier", () => {
      const resolver = new ModelTierResolver({
        tiny: { model: "small-model", provider: "local" },
      });
      expect(resolver.resolve({ tier: "gigantic", reason: "not configured" })).toBeNull();
    });

    it("returns null when config is empty", () => {
      const resolver = new ModelTierResolver({});
      expect(resolver.resolve({ tier: "medium", reason: "empty config" })).toBeNull();
    });

    it("handles tierSelection with extra properties gracefully", () => {
      const resolver = new ModelTierResolver({
        small: { model: "phi-3", provider: "ollama" },
      });
      const selection = {
        tier: "small",
        reason: "lightweight task",
        confidence: 0.95,
        source: "classifier",
      } as { tier: string; reason: string };

      const result = resolver.resolve(selection);
      expect(result).toEqual({
        modelOverride: "phi-3",
        providerOverride: "ollama",
        backend: "api",
        latencyClass: undefined,
        costClass: undefined,
      });
    });

    it("returns modelOverride: undefined and providerOverride: undefined for an empty {} entry", () => {
      const resolver = new ModelTierResolver({
        placeholder: {},
      });
      const result = resolver.resolve({ tier: "placeholder", reason: "empty entry" });
      expect(result).not.toBeNull();
      expect(result).toEqual({
        modelOverride: undefined,
        providerOverride: undefined,
        backend: "api",
        latencyClass: undefined,
        costClass: undefined,
      });
    });
  });

  // ==========================================================================
  // Metadata fields (backend, latencyClass, costClass)
  // ==========================================================================

  describe("metadata fields", () => {
    it("round-trips all metadata fields through resolve()", () => {
      const resolver = new ModelTierResolver({
        local: {
          model: "deepseek-r1-distill-7b-q4",
          provider: "llama.cpp",
          backend: "local",
          latencyClass: "instant",
          costClass: "free",
        },
      });
      const result = resolver.resolve({ tier: "local", reason: "local inference" });
      expect(result).toEqual({
        modelOverride: "deepseek-r1-distill-7b-q4",
        providerOverride: "llama.cpp",
        backend: "local",
        latencyClass: "instant",
        costClass: "free",
      });
    });

    it("defaults backend to 'api' when not specified", () => {
      const resolver = new ModelTierResolver({
        cloud: { model: "gpt-4o", provider: "openai" },
      });
      const result = resolver.resolve({ tier: "cloud", reason: "default backend" });
      expect(result!.backend).toBe("api");
    });

    it("preserves backend='local' when explicitly set", () => {
      const resolver = new ModelTierResolver({
        edge: { model: "phi-3", provider: "ollama", backend: "local" },
      });
      const result = resolver.resolve({ tier: "edge", reason: "edge inference" });
      expect(result!.backend).toBe("local");
    });

    it("leaves latencyClass and costClass undefined when not configured", () => {
      const resolver = new ModelTierResolver({
        bare: { model: "some-model" },
      });
      const result = resolver.resolve({ tier: "bare", reason: "minimal config" });
      expect(result!.latencyClass).toBeUndefined();
      expect(result!.costClass).toBeUndefined();
    });

    it("supports all latencyClass values", () => {
      for (const lc of ["instant", "fast", "slow", "variable"] as const) {
        const resolver = new ModelTierResolver({
          test: { model: "m", latencyClass: lc },
        });
        expect(resolver.resolve({ tier: "test", reason: "lc test" })!.latencyClass).toBe(lc);
      }
    });

    it("supports all costClass values", () => {
      for (const cc of ["free", "cheap", "moderate", "expensive"] as const) {
        const resolver = new ModelTierResolver({
          test: { model: "m", costClass: cc },
        });
        expect(resolver.resolve({ tier: "test", reason: "cc test" })!.costClass).toBe(cc);
      }
    });
  });

  // ==========================================================================
  // LOCAL_TIER_DEFAULTS
  // ==========================================================================

  describe("LOCAL_TIER_DEFAULTS", () => {
    it("is well-formed with all five standard tiers", () => {
      const expectedTiers = ["tiny", "small", "medium", "large", "reasoning"];
      expect(Object.keys(LOCAL_TIER_DEFAULTS).sort()).toEqual(expectedTiers.sort());
    });

    it("every entry has model and provider defined", () => {
      for (const [tier, entry] of Object.entries(LOCAL_TIER_DEFAULTS)) {
        expect(entry.model, `${tier} should have a model`).toBeDefined();
        expect(entry.provider, `${tier} should have a provider`).toBeDefined();
      }
    });

    it("every entry has backend defined", () => {
      for (const [tier, entry] of Object.entries(LOCAL_TIER_DEFAULTS)) {
        expect(entry.backend, `${tier} should have a backend`).toBeDefined();
        expect(["api", "local"]).toContain(entry.backend);
      }
    });

    it("every entry has latencyClass and costClass defined", () => {
      for (const [tier, entry] of Object.entries(LOCAL_TIER_DEFAULTS)) {
        expect(entry.latencyClass, `${tier} should have latencyClass`).toBeDefined();
        expect(entry.costClass, `${tier} should have costClass`).toBeDefined();
      }
    });

    it("can be used directly as a ModelTierResolver config", () => {
      const resolver = new ModelTierResolver(LOCAL_TIER_DEFAULTS);
      const result = resolver.resolve({ tier: "medium", reason: "local test" });
      expect(result).not.toBeNull();
      expect(result!.backend).toBe("local");
      expect(result!.costClass).toBe("free");
    });

    it("reasoning tier falls back to API", () => {
      const resolver = new ModelTierResolver(LOCAL_TIER_DEFAULTS);
      const result = resolver.resolve({ tier: "reasoning", reason: "complex task" });
      expect(result!.backend).toBe("api");
      expect(result!.providerOverride).toBe("anthropic");
    });
  });

  // ==========================================================================
  // NEXUS tier map integration
  // ==========================================================================

  describe("NEXUS tier map", () => {
    const NEXUS_TIER_MAP = {
      tiny: { model: "ollama/qwen3.5:9b", provider: "ollama" },
      small: { model: "ollama/qwen3.5:9b", provider: "ollama" },
      medium: { model: "ollama/qwen2.5:14b", provider: "ollama" },
      large: { model: "ollama/qwen3.5:9b", provider: "ollama" },
      reasoning: { model: "ollama/qwen3:30b-a3b", provider: "ollama" },
    };

    const resolver = new ModelTierResolver(NEXUS_TIER_MAP);

    it("resolves tiny tier", () => {
      const result = resolver.resolve({ tier: "tiny", reason: "trivial task" });
      expect(result!.modelOverride).toBe("ollama/qwen3.5:9b");
      expect(result!.providerOverride).toBe("ollama");
      expect(result!.backend).toBe("api");
    });

    it("resolves small tier", () => {
      const result = resolver.resolve({ tier: "small", reason: "simple classification" });
      expect(result!.modelOverride).toBe("ollama/qwen3.5:9b");
      expect(result!.providerOverride).toBe("ollama");
    });

    it("resolves medium tier", () => {
      const result = resolver.resolve({ tier: "medium", reason: "moderate complexity" });
      expect(result!.modelOverride).toBe("ollama/qwen2.5:14b");
      expect(result!.providerOverride).toBe("ollama");
    });

    it("resolves large tier", () => {
      const result = resolver.resolve({ tier: "large", reason: "complex generation" });
      expect(result!.modelOverride).toBe("ollama/qwen3.5:9b");
      expect(result!.providerOverride).toBe("ollama");
    });

    it("resolves reasoning tier", () => {
      const result = resolver.resolve({ tier: "reasoning", reason: "multi-step logic" });
      expect(result!.modelOverride).toBe("ollama/qwen3:30b-a3b");
      expect(result!.providerOverride).toBe("ollama");
    });
  });
});
