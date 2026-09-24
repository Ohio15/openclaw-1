/**
 * RunContextStore — what the intelligence pipeline decided for a session's
 * current run, recorded at before_model_resolve and read by later hooks.
 *
 * Why this exists: later hooks do not see the run's prompt in the same form.
 * before_prompt_build receives the session history BEFORE the current prompt
 * is appended, and llm_output receives no messages at all. Re-deriving "the
 * user prompt" or "the tier" from whatever text a later hook holds analysed
 * the wrong message (the previous turn, or the assistant's own output).
 * The model was chosen once, from the real prompt; every later decision must
 * use that same prompt and tier.
 *
 * Bounded (maxEntries, oldest evicted) and time-limited (ttlMs), keyed by
 * session id. A run that exceeds the TTL simply loses its context; callers
 * must treat a miss as "unknown", never as a default tier.
 *
 * @module run-context
 */

export interface RunContext {
  /** The prompt the model was resolved for. */
  prompt: string;
  /** The tier chosen for that prompt. */
  tier: string;
  recordedAt: number;
}

export class RunContextStore {
  private readonly entries = new Map<string, RunContext>();

  constructor(
    private readonly ttlMs: number = 30 * 60_000,
    private readonly maxEntries: number = 512,
    private readonly now: () => number = Date.now,
  ) {
    if (!(ttlMs > 0)) throw new Error("RunContextStore: ttlMs must be > 0");
    if (!(maxEntries > 0)) throw new Error("RunContextStore: maxEntries must be > 0");
  }

  record(sessionId: string | undefined, prompt: string, tier: string): void {
    if (!sessionId) return;
    // Re-insert so Map iteration order tracks recency for eviction.
    this.entries.delete(sessionId);
    this.entries.set(sessionId, { prompt, tier, recordedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get(sessionId: string | undefined): RunContext | undefined {
    if (!sessionId) return undefined;
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    if (this.now() - entry.recordedAt > this.ttlMs) {
      this.entries.delete(sessionId);
      return undefined;
    }
    return entry;
  }

  get size(): number {
    return this.entries.size;
  }
}
