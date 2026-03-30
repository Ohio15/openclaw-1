/**
 * LiteLLM Model Group Mapping — Maps intelligence tiers to LiteLLM model groups.
 *
 * When LiteLLM is the active provider, tier selections are mapped to
 * LiteLLM model groups for automatic load balancing, failover, and cost tracking.
 *
 * @module litellm-groups
 */

// ============================================================================
// Types
// ============================================================================

export interface LiteLLMGroupConfig {
  /** LiteLLM model group name (e.g., "litellm/group-tiny") */
  modelGroup: string;
  /** Estimated cost per 1K input tokens in USD */
  inputCostPer1K: number;
  /** Estimated cost per 1K output tokens in USD */
  outputCostPer1K: number;
  /** Description for logging */
  description: string;
}

// ============================================================================
// Default Tier-to-Group Mapping
// ============================================================================

/**
 * Default mapping from intelligence tiers to LiteLLM model groups.
 * Users can override these in the plugin config's `tierModelMap`.
 *
 * LiteLLM model groups are configured in the LiteLLM proxy config
 * (litellm_config.yaml) and allow automatic load balancing between
 * models in the same group.
 */
export const DEFAULT_LITELLM_GROUPS: Record<string, LiteLLMGroupConfig> = {
  tiny: {
    modelGroup: "litellm/group-tiny",
    inputCostPer1K: 0.00025,
    outputCostPer1K: 0.00125,
    description: "Fast, cheap models for simple lookups (e.g., Haiku, GPT-4o-mini)",
  },
  small: {
    modelGroup: "litellm/group-small",
    inputCostPer1K: 0.0005,
    outputCostPer1K: 0.0025,
    description: "Capable models for simple code (e.g., Haiku, GPT-4o-mini)",
  },
  medium: {
    modelGroup: "litellm/group-medium",
    inputCostPer1K: 0.003,
    outputCostPer1K: 0.015,
    description: "Standard models for code generation (e.g., Sonnet, GPT-4o)",
  },
  large: {
    modelGroup: "litellm/group-large",
    inputCostPer1K: 0.015,
    outputCostPer1K: 0.075,
    description: "Advanced models for complex tasks (e.g., Opus, GPT-4.5)",
  },
  reasoning: {
    modelGroup: "litellm/group-reasoning",
    inputCostPer1K: 0.015,
    outputCostPer1K: 0.075,
    description: "Reasoning models for architecture decisions (e.g., Opus, o3)",
  },
};

// ============================================================================
// Cost Estimation
// ============================================================================

/**
 * Estimate the cost for a request at a given tier.
 * Uses LiteLLM group pricing when available, falls back to defaults.
 */
export function estimateTierCost(
  tier: string,
  inputTokens: number,
  outputTokens: number,
  customGroups?: Record<string, LiteLLMGroupConfig>,
): number {
  const groups = customGroups ?? DEFAULT_LITELLM_GROUPS;
  const group = groups[tier] ?? groups.medium;

  const inputCost = (inputTokens / 1000) * group.inputCostPer1K;
  const outputCost = (outputTokens / 1000) * group.outputCostPer1K;

  return inputCost + outputCost;
}

/**
 * Get the LiteLLM model group name for a tier.
 */
export function getModelGroupForTier(
  tier: string,
  customGroups?: Record<string, LiteLLMGroupConfig>,
): string | null {
  const groups = customGroups ?? DEFAULT_LITELLM_GROUPS;
  return groups[tier]?.modelGroup ?? null;
}

/**
 * Check if LiteLLM proxy is likely configured (checks env vars).
 */
export function isLiteLLMConfigured(): boolean {
  return !!(
    process.env.LITELLM_API_KEY ||
    process.env.LITELLM_BASE_URL ||
    process.env.LITELLM_PROXY_URL
  );
}
