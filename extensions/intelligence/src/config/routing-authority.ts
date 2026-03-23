/**
 * Routing Authority - Configuration for intelligence pipeline routing decisions
 *
 * Ported from AICodeAssistant/backend/config/routing-authority.js
 * Stripped of model names (OpenClaw manages models natively) but retains
 * tier structure, complexity thresholds, domain escalations, quality gates,
 * and pipeline selection logic.
 *
 * @module routing-authority
 */

// ============================================================================
// Tier Definitions (model-agnostic — OpenClaw resolves concrete models)
// ============================================================================

export interface TierConfig {
  maxComplexity: number;
  description: string;
  maxTokens: number;
}

/**
 * Model tiers define capability levels without binding to specific model names.
 * OpenClaw's model router resolves the concrete model for each tier at runtime.
 */
export const MODEL_TIERS: Record<string, TierConfig> = {
  tiny: {
    maxComplexity: 0.2,
    description: "Quick factual lookups, simple formatting",
    maxTokens: 512,
  },
  small: {
    maxComplexity: 0.4,
    description: "Simple code generation, explanations",
    maxTokens: 4096,
  },
  medium: {
    maxComplexity: 0.6,
    description: "Standard code generation, refactoring",
    maxTokens: 8192,
  },
  large: {
    maxComplexity: 0.85,
    description: "Complex code, security-sensitive tasks",
    maxTokens: 8192,
  },
  reasoning: {
    maxComplexity: 1.0,
    description: "Algorithm design, architecture decisions",
    maxTokens: 8192,
  },
};

// ============================================================================
// Domain Escalations
// ============================================================================

/**
 * Domain-based tier escalations.
 * These domains ALWAYS use the specified tier regardless of complexity score.
 */
export const DOMAIN_ESCALATIONS: Record<string, string> = {
  // Code patterns — always use large tier
  rate_limiter: "large",
  sliding_window: "large",
  token_bucket: "large",
  leaky_bucket: "large",
  cache: "large",
  lru_cache: "large",
  circuit_breaker: "large",

  // Data structures
  tree: "large",
  graph: "large",
  heap: "large",
  trie: "large",

  // Security-sensitive
  auth: "large",
  authentication: "large",
  authorization: "large",
  security: "large",
  encryption: "large",
  jwt: "large",
  oauth: "large",

  // Standard elevated (medium tier minimum)
  api: "medium",
  database: "medium",
  middleware: "medium",
};

// ============================================================================
// Quality Thresholds
// ============================================================================

export interface QualityProfile {
  minQuality: number;
  autoApprove: number;
}

export const QUALITY_THRESHOLDS = {
  /** Hard floor — responses below this are rejected */
  MIN_ACCEPTABLE: 0.65,

  /** Standard quality — good enough for most tasks */
  GOOD: 0.75,

  /** High quality — required for production/security tasks */
  HIGH: 0.85,

  /** Auto-approve — no human review needed */
  AUTO_APPROVE: 0.9,

  /** Profile-specific overrides */
  profiles: {
    development: { minQuality: 0.65, autoApprove: 0.85 } as QualityProfile,
    production: { minQuality: 0.8, autoApprove: 0.95 } as QualityProfile,
    quality: { minQuality: 0.85, autoApprove: 0.95 } as QualityProfile,
  } as Record<string, QualityProfile>,
};

// ============================================================================
// Pipeline Rules
// ============================================================================

export const PIPELINE_RULES = {
  simple: {
    maxComplexity: 0.4,
    maxRequirements: 3,
    patterns: [
      /^(explain|describe|what is|how does)/i,
      /^(write a|create a|generate a)\s+(simple|basic)/i,
      /^(fix|correct)\s+(this|the)\s+(typo|error|bug)/i,
    ],
  },
  complex: {
    minComplexity: 0.4,
    minRequirements: 4,
    patterns: [
      /implement.*algorithm/i,
      /refactor.*entire/i,
      /multi-file|multiple files/i,
      /architecture|design pattern/i,
      /rate.?limit|token.?bucket|sliding.window/i,
    ],
  },
};

// ============================================================================
// Task Type → Tier Mapping
// ============================================================================

export const TASK_TYPE_MODELS: Record<string, string> = {
  code_generation: "large",
  code_review: "medium",
  code_explanation: "small",
  debugging: "large",
  refactoring: "large",
  documentation: "small",
  testing: "medium",
  general: "medium",
};

// ============================================================================
// Selection Functions
// ============================================================================

export interface TierSelection {
  tier: string;
  reason: string;
}

/**
 * Select the appropriate model tier based on complexity, domain, and task type.
 *
 * Returns tier name and reason — OpenClaw resolves the concrete model externally.
 */
export function selectTier(
  complexity: number,
  domain: string | null = null,
  taskType: string | null = null,
): TierSelection {
  // Domain escalation takes precedence
  if (domain && DOMAIN_ESCALATIONS[domain]) {
    const tier = DOMAIN_ESCALATIONS[domain];
    return {
      tier,
      reason: `Domain escalation: ${domain} -> ${tier}`,
    };
  }

  // Task type mapping (only if complexity doesn't require higher)
  if (taskType && TASK_TYPE_MODELS[taskType]) {
    const tier = TASK_TYPE_MODELS[taskType];
    const tierConfig = MODEL_TIERS[tier];
    if (tierConfig && complexity <= tierConfig.maxComplexity) {
      return {
        tier,
        reason: `Task type: ${taskType} -> ${tier}`,
      };
    }
  }

  // Complexity-based selection
  for (const [tierName, tierConfig] of Object.entries(MODEL_TIERS)) {
    if (complexity <= tierConfig.maxComplexity) {
      return {
        tier: tierName,
        reason: `Complexity ${complexity.toFixed(2)} <= ${tierConfig.maxComplexity} -> ${tierName}`,
      };
    }
  }

  // Fallback to reasoning tier
  return {
    tier: "reasoning",
    reason: "Fallback to reasoning tier",
  };
}

export interface PipelineSelection {
  pipeline: "simple" | "complex";
  reason: string;
}

/**
 * Select the appropriate pipeline based on complexity, requirements, and prompt patterns.
 */
export function selectPipeline(
  complexity: number,
  requirementCount: number = 0,
  prompt: string = "",
): PipelineSelection {
  // Check complex patterns first
  for (const pattern of PIPELINE_RULES.complex.patterns) {
    if (pattern.test(prompt)) {
      return {
        pipeline: "complex",
        reason: `Pattern match: ${pattern.toString().slice(0, 30)}...`,
      };
    }
  }

  // Check complexity threshold
  if (complexity >= PIPELINE_RULES.complex.minComplexity) {
    return {
      pipeline: "complex",
      reason: `Complexity ${complexity.toFixed(2)} >= ${PIPELINE_RULES.complex.minComplexity}`,
    };
  }

  // Check requirement count
  if (requirementCount >= PIPELINE_RULES.complex.minRequirements) {
    return {
      pipeline: "complex",
      reason: `Requirements ${requirementCount} >= ${PIPELINE_RULES.complex.minRequirements}`,
    };
  }

  // Default to simple
  return {
    pipeline: "simple",
    reason: "Default: low complexity, few requirements",
  };
}

/**
 * Get quality threshold for a given profile.
 */
export function getQualityThreshold(
  profile: string = "development",
): QualityProfile {
  return (
    QUALITY_THRESHOLDS.profiles[profile] ??
    QUALITY_THRESHOLDS.profiles.development
  );
}
