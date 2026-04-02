/**
 * Enhanced Conversation Summarization — DeerFlow-inspired progressive summarization.
 *
 * Layers on top of OpenClaw's built-in compaction (src/agents/compaction.ts)
 * via the `before_prompt_build` hook. Proactively summarizes older messages
 * BEFORE core compaction triggers, keeping the recent conversation window fresh.
 *
 * Does NOT modify core compaction — works purely through hooks.
 *
 * Trigger model (any one triggers summarization):
 *   1. Token count exceeds threshold (default 50,000)
 *   2. Message count exceeds threshold (default 30)
 *   3. Estimated capacity fraction exceeds threshold (default 0.35)
 *
 * Exception: skip if conversation is short AND complex (avoid summarizing
 * important context during active problem-solving).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnhancedCompactionConfig {
  enabled: boolean;
  triggers: {
    tokenCountThreshold?: number;
    messageCountThreshold?: number;
    capacityFraction?: number;
  };
  recentWindowSize: number;
  skipComplexShortConversations: boolean;
  complexityThresholdForSkip: number;
  shortConversationLimit: number;
}

interface SessionMetrics {
  messageCount: number;
  estimatedTokens: number;
  complexitySum: number;
  complexityCount: number;
  lastSummary: CachedSummary | null;
  maskingTokensRecovered: number;
  maskingApplied: boolean;
  summarizationSkippedAfterMasking: boolean;
}

interface CachedSummary {
  text: string;
  coveredMessageCount: number; // how many messages from the start this summary covers
  generatedAt: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: EnhancedCompactionConfig = {
  enabled: false,
  triggers: {
    tokenCountThreshold: 50_000,
    messageCountThreshold: 30,
    capacityFraction: 0.35,
  },
  recentWindowSize: 6,
  skipComplexShortConversations: true,
  complexityThresholdForSkip: 0.7,
  shortConversationLimit: 15,
};

// Rough token estimation: ~4 characters per token for English text
const CHARS_PER_TOKEN = 4;
// Default context window assumption when we can't determine the actual value
const DEFAULT_CONTEXT_WINDOW = 200_000;

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Extract text content from an opaque message object (AgentMessage typed as unknown).
 */
function extractMessageText(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const m = msg as Record<string, unknown>;

  if (typeof m.content === "string") return m.content;

  if (Array.isArray(m.content)) {
    return (m.content as Array<Record<string, unknown>>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
  }

  return "";
}

/**
 * Get the role of a message.
 */
function getRole(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  return String((msg as Record<string, unknown>).role ?? "");
}

/**
 * Rough token count estimation from message array.
 */
function estimateTokens(messages: unknown[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += extractMessageText(msg).length;
    // Account for tool calls overhead (~100 chars per tool-call message)
    const role = getRole(msg);
    if (role === "tool") chars += 100;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Build a condensed summary of older messages by extracting key information.
 * This is a heuristic extraction approach — no LLM call needed.
 * Focuses on user requests and assistant conclusions, skipping tool calls.
 */
function buildSummaryFromMessages(messages: unknown[]): string {
  const summaryParts: string[] = [];

  for (const msg of messages) {
    const role = getRole(msg);
    const text = extractMessageText(msg).trim();
    if (!text) continue;

    if (role === "user") {
      // Include user messages verbatim but truncated
      const truncated = text.length > 200 ? text.substring(0, 200) + "..." : text;
      summaryParts.push(`User: ${truncated}`);
    } else if (role === "assistant") {
      // For assistant messages, extract first meaningful sentence/paragraph
      const firstBlock = text.split("\n\n")[0] ?? text;
      const truncated = firstBlock.length > 300 ? firstBlock.substring(0, 300) + "..." : firstBlock;
      summaryParts.push(`Assistant: ${truncated}`);
    }
    // Skip tool/system messages — they're implementation details
  }

  if (summaryParts.length === 0) return "";

  return (
    "<context-summary>\n" +
    "The following is a summary of the earlier part of this conversation. " +
    "Use it for continuity but prioritize the recent messages for current task context.\n\n" +
    summaryParts.join("\n") +
    "\n</context-summary>"
  );
}

// ---------------------------------------------------------------------------
// Observation Masking — Stage 1 of pipeline compaction
// ---------------------------------------------------------------------------

/**
 * Observation masking — Stage 1 of pipeline compaction.
 * Replaces old toolResult content with placeholders while keeping tool_use blocks
 * (assistant messages with ToolCall content) intact.
 *
 * Research: 52% cheaper than summarization, zero hallucination risk.
 * Source: JetBrains "The Complexity Trap" (NeurIPS 2025)
 *
 * Only toolResult messages outside the recent window are masked.
 * The recent window preserves full fidelity for active problem-solving context.
 */
function maskOldToolResults(
  messages: unknown[],
  recentWindowSize: number,
): { masked: unknown[]; tokensRecovered: number } {
  if (messages.length <= recentWindowSize) {
    return { masked: messages, tokensRecovered: 0 };
  }

  const recentBoundary = messages.length - recentWindowSize;
  let tokensRecovered = 0;
  let changed = false;

  const masked = messages.map((msg, idx) => {
    // Keep recent messages untouched
    if (idx >= recentBoundary) return msg;

    if (!msg || typeof msg !== "object") return msg;
    const m = msg as Record<string, unknown>;

    // Only mask toolResult messages
    if (m.role !== "toolResult") return msg;

    // Don't mask error results — they're usually short and diagnostically important
    if (m.isError === true) return msg;

    // Measure content size
    let totalChars = 0;
    if (Array.isArray(m.content)) {
      for (const block of m.content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string") {
          totalChars += (block.text as string).length;
        }
      }
    }

    // Don't mask small outputs (< 200 chars) — not worth the information loss
    if (totalChars < 200) return msg;

    const estimatedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);
    tokensRecovered += estimatedTokens;
    changed = true;

    return {
      ...m,
      content: [
        {
          type: "text",
          text: `[Tool output masked — ${totalChars} chars, ~${estimatedTokens} tokens]`,
        },
      ],
      // Strip details as well since they can be large
      ...(m.details !== undefined ? { details: undefined } : {}),
    };
  });

  return { masked: changed ? masked : messages, tokensRecovered };
}

// ---------------------------------------------------------------------------
// EnhancedCompactionManager
// ---------------------------------------------------------------------------

export class EnhancedCompactionManager {
  private config: EnhancedCompactionConfig;
  private sessions = new Map<string, SessionMetrics>();

  constructor(config: Partial<EnhancedCompactionConfig> = {}) {
    this.config = {
      ...DEFAULTS,
      ...config,
      triggers: { ...DEFAULTS.triggers, ...(config.triggers ?? {}) },
    };
  }

  // ---- Session management ------------------------------------------------

  private getSession(sessionKey: string): SessionMetrics {
    let metrics = this.sessions.get(sessionKey);
    if (!metrics) {
      metrics = {
        messageCount: 0,
        estimatedTokens: 0,
        complexitySum: 0,
        complexityCount: 0,
        lastSummary: null,
        maskingTokensRecovered: 0,
        maskingApplied: false,
        summarizationSkippedAfterMasking: false,
      };
      this.sessions.set(sessionKey, metrics);
    }
    return metrics;
  }

  clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  /**
   * Record complexity from the intelligence pipeline's analysis.
   */
  recordComplexity(sessionKey: string, complexity: number): void {
    const metrics = this.getSession(sessionKey);
    metrics.complexitySum += complexity;
    metrics.complexityCount++;
  }

  // ---- Core logic --------------------------------------------------------

  /**
   * Check if progressive summarization should activate.
   * Called from `before_prompt_build`.
   *
   * Two-stage pipeline:
   *   Stage 1 — Observation masking: replace old toolResult content with placeholders.
   *             Reduces token count without information loss on tool calls themselves.
   *   Stage 2 — Summarization: build a condensed summary of older messages (if still needed).
   *             Skipped entirely if masking alone brought usage below thresholds.
   *
   * Returns the summary context string to prepend, or null if no summarization needed.
   * Masking metrics are tracked internally and accessible via `getSessionMetrics`.
   */
  checkAndSummarize(
    messages: unknown[],
    sessionKey: string,
    contextWindow?: number,
  ): string | null {
    if (!this.config.enabled) return null;

    const metrics = this.getSession(sessionKey);
    const msgCount = messages.length;
    const tokens = estimateTokens(messages);

    // Update tracked metrics
    metrics.messageCount = msgCount;
    metrics.estimatedTokens = tokens;

    // Check if triggers are met
    const triggers = this.config.triggers;
    const window = contextWindow ?? DEFAULT_CONTEXT_WINDOW;

    const tokenTriggered = triggers.tokenCountThreshold != null && tokens > triggers.tokenCountThreshold;
    const messageTriggered = triggers.messageCountThreshold != null && msgCount > triggers.messageCountThreshold;
    const capacityTriggered =
      triggers.capacityFraction != null && tokens / window > triggers.capacityFraction;

    if (!tokenTriggered && !messageTriggered && !capacityTriggered) {
      return null;
    }

    // Exception: skip if short + complex conversation
    if (this.config.skipComplexShortConversations && msgCount < this.config.shortConversationLimit) {
      const avgComplexity =
        metrics.complexityCount > 0 ? metrics.complexitySum / metrics.complexityCount : 0;
      if (avgComplexity >= this.config.complexityThresholdForSkip) {
        return null;
      }
    }

    // ---- Stage 1: Observation Masking ----
    // Replace old toolResult content with placeholders. This reduces token count
    // for the summary generation pass and may eliminate the need for summarization.
    const recentWindow = this.config.recentWindowSize;
    const { masked, tokensRecovered } = maskOldToolResults(messages, recentWindow);

    metrics.maskingApplied = tokensRecovered > 0;
    metrics.maskingTokensRecovered = tokensRecovered;

    // Re-estimate tokens after masking
    const tokensAfterMasking = estimateTokens(masked);

    // Check if masking alone brought us below ALL triggered thresholds.
    // Message count threshold still requires summarization since masking
    // doesn't reduce message count.
    const stillTokenTriggered = triggers.tokenCountThreshold != null && tokensAfterMasking > triggers.tokenCountThreshold;
    const stillCapacityTriggered =
      triggers.capacityFraction != null && tokensAfterMasking / window > triggers.capacityFraction;

    if (!messageTriggered && !stillTokenTriggered && !stillCapacityTriggered) {
      metrics.summarizationSkippedAfterMasking = true;
      return null;
    }

    metrics.summarizationSkippedAfterMasking = false;

    // ---- Stage 2: Summarization (on already-masked messages) ----

    // Check cache — only rebuild if new messages arrived beyond cached range
    const cached = metrics.lastSummary;
    if (cached && cached.coveredMessageCount >= msgCount - recentWindow) {
      return cached.text;
    }

    if (msgCount <= recentWindow) {
      return null; // Not enough messages to warrant summarization
    }

    // Summarize the masked older messages — masked tool outputs produce shorter
    // summaries, saving both context and generation cost.
    const olderMessages = masked.slice(0, msgCount - recentWindow);
    const summary = buildSummaryFromMessages(olderMessages);

    if (!summary) return null;

    // Cache the summary
    metrics.lastSummary = {
      text: summary,
      coveredMessageCount: olderMessages.length,
      generatedAt: Date.now(),
    };

    return summary;
  }

  /**
   * Get metrics for a session, including masking statistics.
   * Useful for diagnostics and observability.
   */
  getSessionMetrics(sessionKey: string): Readonly<SessionMetrics> | undefined {
    return this.sessions.get(sessionKey);
  }

  // ---- Observation hooks -------------------------------------------------

  /**
   * Log metrics when core compaction fires. Called from `before_compaction` hook.
   */
  logCompactionEvent(
    sessionKey: string,
    event: { messageCount?: number; tokenCount?: number },
  ): { metricsSnapshot: SessionMetrics } {
    const metrics = this.getSession(sessionKey);
    if (event.messageCount != null) metrics.messageCount = event.messageCount;
    if (event.tokenCount != null) metrics.estimatedTokens = event.tokenCount;
    return { metricsSnapshot: { ...metrics } };
  }

  /**
   * Invalidate cached summary after compaction (messages have changed).
   */
  invalidateCache(sessionKey: string): void {
    const metrics = this.sessions.get(sessionKey);
    if (metrics) {
      metrics.lastSummary = null;
    }
  }
}
