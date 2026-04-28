/**
 * Cascade Fallback — Quality-driven model tier escalation
 *
 * Wraps agent execution with a post-run quality check. When the intelligence
 * pipeline's quality gate signals "retry", this module escalates to the next
 * higher model tier and re-invokes the agent.
 *
 * Tier order follows MODEL_TIERS from routing-authority.ts:
 *   tiny → small → medium → large → reasoning (ceiling)
 *
 * Guards:
 *   - Max retries (default 2) to bound cost and latency
 *   - Ceiling at "reasoning" tier — no further escalation possible
 *   - Cascade can be disabled via plugin config (cascadeEnabled: false)
 *
 * @module cascade-fallback
 */

import { MODEL_TIERS } from "../config/routing-authority.js";
import { consumeCascadeSignal } from "../../../../src/intelligence/cascade-state.js";
import type { ModelTierResolver } from "./model-tier-resolver.js";

// ============================================================================
// Constants
// ============================================================================

/** Ordered tier names from lowest to highest capability. */
export const TIER_ORDER: string[] = Object.keys(MODEL_TIERS);

/** The highest tier — cascade stops here regardless of quality verdict. */
export const CEILING_TIER: string = TIER_ORDER[TIER_ORDER.length - 1];

// ============================================================================
// Types
// ============================================================================

export interface CascadeConfig {
  /** Whether cascade fallback is enabled. Defaults to true. */
  cascadeEnabled: boolean;
  /** Maximum number of cascade retries per turn. Defaults to 2. */
  cascadeMaxRetries: number;
}

export interface CascadeRunParams<T> {
  /** Session identifier for signal lookup. */
  sessionId: string;
  /** The tier that was used for the initial run. */
  currentTier: string;
  /** Cascade configuration from the plugin. */
  config: CascadeConfig;
  /** The tier resolver for mapping tier names to model/provider overrides. */
  tierResolver: ModelTierResolver;
  /** Logger for cascade events. */
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
  /**
   * Execute the agent run with the given provider/model overrides.
   * When provider/model are undefined, the original (non-overridden) values are used.
   */
  run: (overrides: { provider?: string; model?: string }) => Promise<T>;
}

// ============================================================================
// Tier Navigation
// ============================================================================

/**
 * Get the next tier above the given tier.
 * Returns undefined if the current tier is already at the ceiling or unknown.
 */
export function getNextTier(currentTier: string): string | undefined {
  const index = TIER_ORDER.indexOf(currentTier);
  if (index === -1 || index >= TIER_ORDER.length - 1) {
    return undefined;
  }
  return TIER_ORDER[index + 1];
}

// ============================================================================
// Cascade Runner
// ============================================================================

/**
 * Run an agent with quality cascade fallback.
 *
 * 1. Execute the initial run
 * 2. Check for a cascade signal (set by llm_output hook's quality assessment)
 * 3. If "retry" signal exists and retries remain, escalate tier and re-run
 * 4. Repeat until: pass/flag verdict, max retries reached, or ceiling tier reached
 *
 * @returns The result from the accepted run (either initial or escalated)
 */
export async function runWithQualityCascade<T>(params: CascadeRunParams<T>): Promise<T> {
  const { sessionId, config, tierResolver, logger } = params;

  // If cascade is disabled, just run once and return
  if (!config.cascadeEnabled) {
    return params.run({});
  }

  let currentTier = params.currentTier;
  let result = await params.run({});
  let cascadeAttempts = 0;

  while (cascadeAttempts < config.cascadeMaxRetries) {
    // Check if the quality gate flagged this response for retry
    const signal = consumeCascadeSignal(sessionId);
    if (!signal || signal.verdict !== "retry") {
      // Quality gate accepted the response — done
      break;
    }

    // Already at ceiling tier — accept whatever we got
    if (currentTier === CEILING_TIER) {
      logger.info(
        `intelligence: cascade — at ceiling tier "${CEILING_TIER}", accepting response`,
      );
      break;
    }

    // Resolve next tier
    const nextTier = getNextTier(currentTier);
    if (!nextTier) {
      logger.warn(
        `intelligence: cascade — no tier above "${currentTier}", accepting response`,
      );
      break;
    }

    // Resolve model/provider overrides for the next tier
    const override = tierResolver.resolve({ tier: nextTier, reason: "cascade-fallback" });
    if (!override?.modelOverride) {
      logger.warn(
        `intelligence: cascade — tier "${nextTier}" has no model mapping, accepting response`,
      );
      break;
    }

    cascadeAttempts += 1;
    logger.info(
      `intelligence: cascade — escalating from "${currentTier}" to "${nextTier}" ` +
      `(attempt ${cascadeAttempts}/${config.cascadeMaxRetries}, ` +
      `model=${override.modelOverride}, provider=${override.providerOverride ?? "default"})`,
    );

    // Re-invoke with the higher-tier model
    currentTier = nextTier;
    result = await params.run({
      provider: override.providerOverride,
      model: override.modelOverride,
    });
  }

  // If there's still a lingering signal after max retries, consume it silently
  // so it doesn't leak to the next turn
  consumeCascadeSignal(sessionId);

  return result;
}
