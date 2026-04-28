/**
 * Cascade State — Per-session signal store for quality cascade fallback
 *
 * Provides a thread-safe signaling mechanism between the llm_output hook
 * (which assesses quality) and the cascade wrapper in agent-runner-execution
 * (which decides whether to re-invoke at a higher model tier).
 *
 * Signals are consumed once (single-read) to prevent accidental re-processing.
 *
 * @module cascade-state
 */

// ============================================================================
// Types
// ============================================================================

export interface CascadeSignal {
  /** Quality verdict that triggered the cascade (typically "retry") */
  verdict: string;
  /** The model tier that produced the unsatisfactory response */
  currentTier: string;
  /** Number of cascade attempts made so far for this session turn */
  attempts: number;
  /** Pre-resolved provider override for the escalated tier (set by the hook) */
  escalatedProvider?: string;
  /** Pre-resolved model override for the escalated tier (set by the hook) */
  escalatedModel?: string;
  /** The tier being escalated to */
  escalatedTier?: string;
}

// ============================================================================
// Signal Store
// ============================================================================

/**
 * Module-level signal map keyed by session identifier.
 * Each entry represents a pending cascade retry request from the quality gate.
 */
export const cascadeSignals = new Map<string, CascadeSignal>();

/**
 * Set a cascade signal for the given session, indicating that the quality gate
 * wants the response re-generated at a higher tier.
 *
 * If a signal already exists for this session, the attempt count is preserved
 * and incremented — the new verdict and tier replace the previous values.
 */
export function setCascadeSignal(
  sessionId: string,
  verdict: string,
  currentTier: string,
  escalation?: {
    provider?: string;
    model?: string;
    tier?: string;
  },
): void {
  const existing = cascadeSignals.get(sessionId);
  cascadeSignals.set(sessionId, {
    verdict,
    currentTier,
    attempts: existing ? existing.attempts + 1 : 1,
    escalatedProvider: escalation?.provider,
    escalatedModel: escalation?.model,
    escalatedTier: escalation?.tier,
  });
}

/**
 * Consume (read and delete) the cascade signal for the given session.
 * Returns undefined if no signal is pending.
 *
 * This is a single-read operation — the signal is removed from the store
 * after consumption to prevent double-processing.
 */
export function consumeCascadeSignal(sessionId: string): CascadeSignal | undefined {
  const signal = cascadeSignals.get(sessionId);
  if (signal) {
    cascadeSignals.delete(sessionId);
  }
  return signal;
}

/**
 * Clear all cascade signals for the given session.
 * Called from the session_end hook to prevent stale state.
 */
export function clearCascadeSignals(sessionId: string): void {
  cascadeSignals.delete(sessionId);
}
