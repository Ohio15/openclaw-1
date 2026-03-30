/**
 * Budget Manager — Token rate limiting and cost controls for the intelligence pipeline.
 *
 * Tracks per-tier token usage, enforces session and daily cost caps,
 * and provides cost-aware tier downgrade suggestions when budgets are low.
 *
 * Persistent storage: ~/.openclaw/intelligence/budgets.json
 *
 * @module budget-manager
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface BudgetConfig {
  /** Per-tier daily token limits (0 = unlimited) */
  tierLimits: Record<string, number>;
  /** Daily cost cap in USD (0 = unlimited) */
  dailyCostCap: number;
  /** Per-session cost cap in USD (0 = unlimited) */
  sessionCostCap: number;
  /** Threshold (0-1) at which tier downgrade kicks in */
  downgradeThreshold: number;
}

export interface BudgetCheck {
  allowed: boolean;
  reason?: string;
  suggestedTier?: string;
  remainingTokens?: number;
  remainingBudget?: number;
}

export interface UsageRecord {
  tier: string;
  tokens: number;
  estimatedCost: number;
  timestamp: number;
}

interface BudgetState {
  daily: {
    date: string; // YYYY-MM-DD
    totalTokens: number;
    totalCost: number;
    byTier: Record<string, { tokens: number; cost: number; requests: number }>;
  };
  session: {
    startedAt: number;
    totalTokens: number;
    totalCost: number;
  };
  history: UsageRecord[];
}

// ============================================================================
// Cost Estimation
// ============================================================================

/**
 * Relative cost multipliers per tier (normalized to "tiny" = 1x).
 * Used for estimation when actual cost data is unavailable.
 */
const TIER_COST_MULTIPLIERS: Record<string, number> = {
  tiny: 1.0,
  small: 2.0,
  medium: 5.0,
  large: 10.0,
  reasoning: 20.0,
};

/**
 * Estimated cost per 1K tokens in USD (rough average across providers).
 */
const BASE_COST_PER_1K_TOKENS = 0.001;

function estimateCost(tier: string, tokens: number): number {
  const multiplier = TIER_COST_MULTIPLIERS[tier] ?? 5.0;
  return (tokens / 1000) * BASE_COST_PER_1K_TOKENS * multiplier;
}

/**
 * Tier downgrade path — when budget is low, which tier to fall back to.
 */
const TIER_DOWNGRADE: Record<string, string> = {
  reasoning: "large",
  large: "medium",
  medium: "small",
  small: "tiny",
};

// ============================================================================
// BudgetManager
// ============================================================================

export class BudgetManager {
  private config: BudgetConfig;
  private state: BudgetState;
  private storagePath: string;

  constructor(storagePath: string, config?: Partial<BudgetConfig>) {
    this.storagePath = storagePath;
    this.config = {
      tierLimits: config?.tierLimits ?? {},
      dailyCostCap: config?.dailyCostCap ?? 0,
      sessionCostCap: config?.sessionCostCap ?? 0,
      downgradeThreshold: config?.downgradeThreshold ?? 0.2,
    };
    this.state = this.loadState();
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  private loadState(): BudgetState {
    try {
      const data = readFileSync(this.storagePath, "utf-8");
      const parsed = JSON.parse(data) as BudgetState;

      // Reset daily counters if date has changed
      const today = this.todayStr();
      if (parsed.daily.date !== today) {
        parsed.daily = {
          date: today,
          totalTokens: 0,
          totalCost: 0,
          byTier: {},
        };
      }

      return parsed;
    } catch {
      return this.freshState();
    }
  }

  private freshState(): BudgetState {
    return {
      daily: {
        date: this.todayStr(),
        totalTokens: 0,
        totalCost: 0,
        byTier: {},
      },
      session: {
        startedAt: Date.now(),
        totalTokens: 0,
        totalCost: 0,
      },
      history: [],
    };
  }

  private saveState(): void {
    try {
      mkdirSync(dirname(this.storagePath), { recursive: true });
      writeFileSync(
        this.storagePath,
        JSON.stringify(this.state, null, 2),
        "utf-8",
      );
    } catch (err) {
      console.warn(`[budget-manager] Failed to save state: ${String(err)}`);
    }
  }

  private todayStr(): string {
    return new Date().toISOString().split("T")[0];
  }

  private ensureDailyReset(): void {
    const today = this.todayStr();
    if (this.state.daily.date !== today) {
      this.state.daily = {
        date: today,
        totalTokens: 0,
        totalCost: 0,
        byTier: {},
      };
    }
  }

  // --------------------------------------------------------------------------
  // Budget Checking
  // --------------------------------------------------------------------------

  /**
   * Check if a request at the given tier is within budget.
   * Returns whether it's allowed, and suggests a cheaper tier if not.
   */
  checkBudget(tier: string, estimatedTokens: number = 1000): BudgetCheck {
    this.ensureDailyReset();

    const estimatedRequestCost = estimateCost(tier, estimatedTokens);

    // Check daily cost cap
    if (
      this.config.dailyCostCap > 0 &&
      this.state.daily.totalCost + estimatedRequestCost > this.config.dailyCostCap
    ) {
      const downgrade = this.suggestDowngrade(tier);
      return {
        allowed: downgrade === null,
        reason: `Daily cost cap would be exceeded ($${this.state.daily.totalCost.toFixed(4)} + $${estimatedRequestCost.toFixed(4)} > $${this.config.dailyCostCap.toFixed(2)})`,
        suggestedTier: downgrade ?? undefined,
        remainingBudget: Math.max(
          0,
          this.config.dailyCostCap - this.state.daily.totalCost,
        ),
      };
    }

    // Check session cost cap
    if (
      this.config.sessionCostCap > 0 &&
      this.state.session.totalCost + estimatedRequestCost >
        this.config.sessionCostCap
    ) {
      const downgrade = this.suggestDowngrade(tier);
      return {
        allowed: downgrade === null,
        reason: `Session cost cap would be exceeded ($${this.state.session.totalCost.toFixed(4)} + $${estimatedRequestCost.toFixed(4)} > $${this.config.sessionCostCap.toFixed(2)})`,
        suggestedTier: downgrade ?? undefined,
        remainingBudget: Math.max(
          0,
          this.config.sessionCostCap - this.state.session.totalCost,
        ),
      };
    }

    // Check per-tier daily token limit
    const tierLimit = this.config.tierLimits[tier];
    if (tierLimit && tierLimit > 0) {
      const tierUsage = this.state.daily.byTier[tier]?.tokens ?? 0;
      if (tierUsage + estimatedTokens > tierLimit) {
        const downgrade = this.suggestDowngrade(tier);
        return {
          allowed: downgrade === null,
          reason: `Tier "${tier}" daily token limit would be exceeded (${tierUsage} + ${estimatedTokens} > ${tierLimit})`,
          suggestedTier: downgrade ?? undefined,
          remainingTokens: Math.max(0, tierLimit - tierUsage),
        };
      }

      // Check if approaching threshold
      const usage = (tierUsage + estimatedTokens) / tierLimit;
      if (usage > 1 - this.config.downgradeThreshold) {
        return {
          allowed: true,
          reason: `Tier "${tier}" approaching limit (${(usage * 100).toFixed(0)}% used)`,
          remainingTokens: Math.max(0, tierLimit - tierUsage - estimatedTokens),
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Suggest a cheaper tier if the current one is over budget.
   * Returns null if no downgrade is possible (already at cheapest).
   */
  private suggestDowngrade(currentTier: string): string | null {
    let tier = currentTier;
    while (TIER_DOWNGRADE[tier]) {
      tier = TIER_DOWNGRADE[tier];
      // Check if the downgraded tier is within budget
      const check = this.config.tierLimits[tier];
      if (!check || check <= 0) return tier; // No limit on this tier
      const usage = this.state.daily.byTier[tier]?.tokens ?? 0;
      if (usage < check * 0.8) return tier; // Has capacity
    }
    return null;
  }

  // --------------------------------------------------------------------------
  // Usage Recording
  // --------------------------------------------------------------------------

  /**
   * Record actual token usage after a request completes.
   */
  recordUsage(tier: string, tokens: number, cost?: number): void {
    this.ensureDailyReset();

    const actualCost = cost ?? estimateCost(tier, tokens);

    // Update daily totals
    this.state.daily.totalTokens += tokens;
    this.state.daily.totalCost += actualCost;

    if (!this.state.daily.byTier[tier]) {
      this.state.daily.byTier[tier] = { tokens: 0, cost: 0, requests: 0 };
    }
    this.state.daily.byTier[tier].tokens += tokens;
    this.state.daily.byTier[tier].cost += actualCost;
    this.state.daily.byTier[tier].requests += 1;

    // Update session totals
    this.state.session.totalTokens += tokens;
    this.state.session.totalCost += actualCost;

    // Append to history (keep last 500 entries)
    this.state.history.push({
      tier,
      tokens,
      estimatedCost: actualCost,
      timestamp: Date.now(),
    });
    if (this.state.history.length > 500) {
      this.state.history = this.state.history.slice(-500);
    }

    this.saveState();
  }

  // --------------------------------------------------------------------------
  // Budget Status
  // --------------------------------------------------------------------------

  /**
   * Get remaining budget for a specific tier or overall.
   */
  getRemainingBudget(tier?: string): {
    dailyTokensRemaining: number | null;
    dailyCostRemaining: number | null;
    sessionCostRemaining: number | null;
  } {
    this.ensureDailyReset();

    let dailyTokensRemaining: number | null = null;
    if (tier && this.config.tierLimits[tier] && this.config.tierLimits[tier] > 0) {
      const used = this.state.daily.byTier[tier]?.tokens ?? 0;
      dailyTokensRemaining = Math.max(0, this.config.tierLimits[tier] - used);
    }

    const dailyCostRemaining =
      this.config.dailyCostCap > 0
        ? Math.max(0, this.config.dailyCostCap - this.state.daily.totalCost)
        : null;

    const sessionCostRemaining =
      this.config.sessionCostCap > 0
        ? Math.max(0, this.config.sessionCostCap - this.state.session.totalCost)
        : null;

    return { dailyTokensRemaining, dailyCostRemaining, sessionCostRemaining };
  }

  /**
   * Get full budget status for CLI/dashboard display.
   */
  getStatus(): {
    daily: BudgetState["daily"];
    session: BudgetState["session"];
    config: BudgetConfig;
    recentHistory: UsageRecord[];
  } {
    this.ensureDailyReset();
    return {
      daily: { ...this.state.daily },
      session: { ...this.state.session },
      config: { ...this.config },
      recentHistory: this.state.history.slice(-20),
    };
  }

  /**
   * Reset budget counters.
   */
  resetBudget(scope: "daily" | "session" | "all" = "all"): void {
    if (scope === "daily" || scope === "all") {
      this.state.daily = {
        date: this.todayStr(),
        totalTokens: 0,
        totalCost: 0,
        byTier: {},
      };
    }
    if (scope === "session" || scope === "all") {
      this.state.session = {
        startedAt: Date.now(),
        totalTokens: 0,
        totalCost: 0,
      };
    }
    if (scope === "all") {
      this.state.history = [];
    }
    this.saveState();
  }
}
