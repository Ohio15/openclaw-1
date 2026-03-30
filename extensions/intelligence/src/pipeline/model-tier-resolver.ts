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

export interface TierModelConfig {
  [tier: string]: {
    model?: string;
    provider?: string;
  };
}

// ============================================================================
// ModelTierResolver
// ============================================================================

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
  ): { modelOverride?: string; providerOverride?: string } | null {
    const entry = this.config[tierSelection.tier];
    if (!entry) return null;

    return {
      modelOverride: entry.model,
      providerOverride: entry.provider,
    };
  }
}
