/**
 * ModelTierResolver - Maps intelligence tier selections to concrete model overrides
 *
 * When the intelligence pipeline selects a tier (e.g., "reasoning", "tiny", "balanced"),
 * this resolver translates that into a specific model and/or provider override that
 * the gateway can use to route the request appropriately.
 *
 * Configuration is provided via the plugin's `tierModelMap` config property.
 *
 * @module model-tier-resolver
 */

// ============================================================================
// Types
// ============================================================================

export type BackendType = "api" | "local";
export type LatencyClass = "instant" | "fast" | "slow" | "variable";
export type CostClass = "free" | "cheap" | "moderate" | "expensive";

export interface TierModelEntry {
  model?: string;
  provider?: string;
  /** Distinguishes cloud API providers from local inference backends. Defaults to "api". */
  backend?: BackendType;
  /** Routing hint for expected latency characteristics. */
  latencyClass?: LatencyClass;
  /** Routing hint for cost classification. */
  costClass?: CostClass;
}

export interface TierModelConfig {
  [tier: string]: TierModelEntry;
}

// ============================================================================
// ModelTierResolver
// ============================================================================

/**
 * Reference local-inference tier map for llama.cpp backends.
 * Users opt in by assigning this (or a similar map) to their `tierModelMap` config.
 * Not active by default — provided as a starting point for local deployments.
 */
export const LOCAL_TIER_DEFAULTS: TierModelConfig = {
  tiny: { model: "deepseek-r1-distill-7b-q4", provider: "llama.cpp", backend: "local", latencyClass: "instant", costClass: "free" },
  small: { model: "deepseek-r1-distill-7b-q4", provider: "llama.cpp", backend: "local", latencyClass: "instant", costClass: "free" },
  medium: { model: "qwen2.5-72b-q4", provider: "llama.cpp", backend: "local", latencyClass: "fast", costClass: "free" },
  large: { model: "deepseek-v3-q2", provider: "llama.cpp", backend: "local", latencyClass: "slow", costClass: "free" },
  reasoning: { model: "claude-opus-4-6", provider: "anthropic", backend: "api", latencyClass: "fast", costClass: "expensive" },
};

export class ModelTierResolver {
  private config: TierModelConfig;

  /**
   * @param config - Maps tier names to model/provider overrides.
   *   If not provided, no overrides will be applied (all tiers use default model).
   *
   * Example config:
   * ```json
   * {
   *   "reasoning": { "model": "claude-opus-4-6", "provider": "anthropic" },
   *   "balanced": { "model": "claude-sonnet-4-20250514" },
   *   "tiny": { "model": "claude-haiku-4-5", "provider": "anthropic" }
   * }
   * ```
   */
  constructor(config?: TierModelConfig) {
    this.config = config ?? {};
  }

  /**
   * Resolve a tier selection into optional model/provider overrides.
   *
   * @param tierSelection - The tier selection from the intelligence pipeline's analysis
   * @returns Override config if a mapping exists for the tier, or null if no override applies
   */
  resolve(
    tierSelection: { tier: string; reason: string },
  ): {
    modelOverride?: string;
    providerOverride?: string;
    backend?: BackendType;
    latencyClass?: LatencyClass;
    costClass?: CostClass;
  } | null {
    const entry = this.config[tierSelection.tier];
    if (!entry) return null;

    return {
      modelOverride: entry.model,
      providerOverride: entry.provider,
      backend: entry.backend ?? "api",
      latencyClass: entry.latencyClass,
      costClass: entry.costClass,
    };
  }
}
