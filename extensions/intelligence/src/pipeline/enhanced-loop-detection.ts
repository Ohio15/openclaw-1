/**
 * Enhanced Loop Detection — DeerFlow-inspired improvements over core loop detection.
 *
 * Runs alongside (not replacing) OpenClaw's built-in tool-loop-detection.ts.
 * Registered at higher priority so it catches patterns earlier with smarter responses.
 *
 * Detection strategies:
 *   1. Early identical detection — same tool+params+error at lower threshold (default 5)
 *   2. Fuzzy similarity — Jaccard on flattened params catches "almost identical" calls
 *   3. Response repetition — tracks LLM output to detect the agent saying the same thing
 *
 * Instead of just blocking, provides actionable steering guidance per loop category.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LoopCategory =
  | "retry_failed_operation"
  | "polling_no_change"
  | "oscillating_approaches"
  | "response_repetition"
  | "fuzzy_repeat";

export interface EnhancedLoopConfig {
  enabled: boolean;
  earlyDetectionThreshold: number;
  fuzzyMatchThreshold: number;
  responseLevelDetection: boolean;
  responseSimilarityThreshold: number;
  maxResponseHistory: number;
}

export interface EnhancedLoopResult {
  detected: boolean;
  category?: LoopCategory;
  count: number;
  guidance?: string;
}

interface ToolCallRecord {
  toolName: string;
  paramsHash: string;
  flatParams: string[];
  hadError: boolean;
  resultHash: string | null;
  timestamp: number;
}

interface SessionLoopState {
  toolHistory: ToolCallRecord[];
  responseHistory: string[];
  responseLoopFlag: string | null; // steering message to inject via before_prompt_build
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: EnhancedLoopConfig = {
  enabled: false,
  earlyDetectionThreshold: 5,
  fuzzyMatchThreshold: 0.85,
  responseLevelDetection: true,
  responseSimilarityThreshold: 0.9,
  maxResponseHistory: 10,
};

const MAX_TOOL_HISTORY = 50;

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function flattenParams(params: Record<string, unknown>): string[] {
  const entries: string[] = [];
  const walk = (obj: unknown, prefix: string) => {
    if (obj === null || obj === undefined) {
      entries.push(`${prefix}=null`);
      return;
    }
    if (typeof obj !== "object") {
      entries.push(`${prefix}=${String(obj)}`);
      return;
    }
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        walk(obj[i], `${prefix}[${i}]`);
      }
      return;
    }
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      walk(v, prefix ? `${prefix}.${k}` : k);
    }
  };
  walk(params, "");
  return entries.sort();
}

function simpleHash(value: unknown): string {
  const str = typeof value === "string" ? value : JSON.stringify(value ?? "");
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

/**
 * Jaccard similarity between two sorted string arrays.
 * Returns 0-1 where 1 means identical sets.
 */
function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Simple text similarity using bigram overlap (Dice coefficient).
 * Good enough for detecting near-identical LLM responses without dependencies.
 */
function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = (s: string): Set<string> => {
    const bg = new Set<string>();
    const lower = s.toLowerCase();
    for (let i = 0; i < lower.length - 1; i++) {
      bg.add(lower.substring(i, i + 2));
    }
    return bg;
  };

  const bgA = bigrams(a);
  const bgB = bigrams(b);
  let intersection = 0;
  for (const bg of bgA) {
    if (bgB.has(bg)) intersection++;
  }
  return (2 * intersection) / (bgA.size + bgB.size);
}

// ---------------------------------------------------------------------------
// Steering guidance generators
// ---------------------------------------------------------------------------

const GUIDANCE: Record<LoopCategory, (toolName: string, count: number) => string> = {
  retry_failed_operation: (tool, count) =>
    `LOOP DETECTED: \`${tool}\` has failed ${count} times with the same parameters and error. ` +
    `Do NOT retry the same call. Instead: (1) modify the input/parameters, (2) use an alternative tool or approach, ` +
    `or (3) inform the user that this specific operation cannot be completed and explain why.`,

  polling_no_change: (tool, count) =>
    `LOOP DETECTED: \`${tool}\` has returned identical results ${count} times — no progress is being made. ` +
    `Stop polling. Either (1) the operation is complete and you should proceed with what you have, ` +
    `(2) something is fundamentally wrong and you should investigate the root cause, ` +
    `or (3) report the status to the user and ask for guidance.`,

  oscillating_approaches: (tool, count) =>
    `LOOP DETECTED: You are oscillating between approaches (${count} alternations) without making progress. ` +
    `Pick ONE approach and commit to it fully, or try something entirely different. ` +
    `Do not switch back to a previously failed approach.`,

  response_repetition: (_tool, count) =>
    `You have generated substantially similar responses ${count} times in a row. ` +
    `This suggests you are stuck. Try a fundamentally different approach to the problem, ` +
    `or ask the user for clarification if you are unsure how to proceed.`,

  fuzzy_repeat: (tool, count) =>
    `LOOP DETECTED: \`${tool}\` has been called ${count} times with nearly identical parameters. ` +
    `The slight variations are not producing different results. ` +
    `Try a substantially different approach rather than minor parameter tweaks.`,
};

// ---------------------------------------------------------------------------
// EnhancedLoopDetector
// ---------------------------------------------------------------------------

export class EnhancedLoopDetector {
  private config: EnhancedLoopConfig;
  private sessions = new Map<string, SessionLoopState>();

  constructor(config: Partial<EnhancedLoopConfig> = {}) {
    this.config = { ...DEFAULTS, ...config };
  }

  // ---- Session management ------------------------------------------------

  private getSession(sessionKey: string): SessionLoopState {
    let state = this.sessions.get(sessionKey);
    if (!state) {
      state = { toolHistory: [], responseHistory: [], responseLoopFlag: null };
      this.sessions.set(sessionKey, state);
    }
    return state;
  }

  clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  // ---- Tool call checking ------------------------------------------------

  /**
   * Check if the upcoming tool call is part of a detected loop pattern.
   * Called from `before_tool_call` hook.
   */
  check(
    toolName: string,
    params: Record<string, unknown>,
    sessionKey: string,
  ): EnhancedLoopResult {
    if (!this.config.enabled) {
      return { detected: false, count: 0 };
    }

    const state = this.getSession(sessionKey);
    const flat = flattenParams(params);
    const hash = simpleHash(flat);

    // Strategy 1: Early identical detection
    // identicalCount is from history; +1 includes the current call
    const identicalCount = this.countIdentical(state, toolName, hash);
    if (identicalCount + 1 >= this.config.earlyDetectionThreshold) {
      const category = this.categorizeIdentical(state, toolName, hash);
      return {
        detected: true,
        category,
        count: identicalCount + 1,
        guidance: GUIDANCE[category](toolName, identicalCount + 1),
      };
    }

    // Strategy 2: Fuzzy similarity
    const fuzzyResult = this.checkFuzzy(state, toolName, flat);
    if (fuzzyResult.detected) {
      return fuzzyResult;
    }

    // Strategy 3: Oscillation detection (A→B→A→B pattern)
    const oscillation = this.checkOscillation(state, toolName, hash);
    if (oscillation.detected) {
      return oscillation;
    }

    // Record this call for future checks
    state.toolHistory.push({
      toolName,
      paramsHash: hash,
      flatParams: flat,
      hadError: false,
      resultHash: null,
      timestamp: Date.now(),
    });

    // Prune old entries
    if (state.toolHistory.length > MAX_TOOL_HISTORY) {
      state.toolHistory = state.toolHistory.slice(-MAX_TOOL_HISTORY);
    }

    return { detected: false, count: 0 };
  }

  /**
   * Record the outcome of a tool call for no-progress tracking.
   * Called from `after_tool_call` hook.
   */
  recordOutcome(
    toolName: string,
    params: Record<string, unknown>,
    result: unknown,
    error: string | undefined,
    sessionKey: string,
  ): void {
    if (!this.config.enabled) return;

    const state = this.getSession(sessionKey);
    const flat = flattenParams(params);
    const hash = simpleHash(flat);
    const resultHash = simpleHash(result ?? error ?? "");

    // Update the most recent matching entry
    for (let i = state.toolHistory.length - 1; i >= 0; i--) {
      const entry = state.toolHistory[i];
      if (entry.toolName === toolName && entry.paramsHash === hash && entry.resultHash === null) {
        entry.hadError = !!error;
        entry.resultHash = resultHash;
        break;
      }
    }
  }

  // ---- Response tracking -------------------------------------------------

  /**
   * Track LLM output for response-level repetition detection.
   * Called from `llm_output` hook.
   */
  trackResponse(assistantTexts: string[], sessionKey: string): void {
    if (!this.config.enabled || !this.config.responseLevelDetection) return;

    const state = this.getSession(sessionKey);
    const combined = assistantTexts.join("\n").trim();
    if (!combined) return;

    state.responseHistory.push(combined);
    if (state.responseHistory.length > this.config.maxResponseHistory) {
      state.responseHistory = state.responseHistory.slice(-this.config.maxResponseHistory);
    }

    // Check for repeated responses (3+ similar in a row)
    const history = state.responseHistory;
    if (history.length >= 3) {
      const last = history[history.length - 1];
      let consecutiveSimilar = 0;
      for (let i = history.length - 2; i >= 0; i--) {
        if (textSimilarity(last, history[i]) >= this.config.responseSimilarityThreshold) {
          consecutiveSimilar++;
        } else {
          break;
        }
      }
      if (consecutiveSimilar >= 2) {
        state.responseLoopFlag = GUIDANCE.response_repetition("", consecutiveSimilar + 1);
      }
    }
  }

  /**
   * Check and consume the response loop flag (for before_prompt_build injection).
   */
  consumeResponseLoopFlag(sessionKey: string): string | null {
    const state = this.sessions.get(sessionKey);
    if (!state?.responseLoopFlag) return null;
    const flag = state.responseLoopFlag;
    state.responseLoopFlag = null;
    return flag;
  }

  // ---- Private detection strategies --------------------------------------

  private countIdentical(state: SessionLoopState, toolName: string, paramsHash: string): number {
    let count = 0;
    for (let i = state.toolHistory.length - 1; i >= 0; i--) {
      const entry = state.toolHistory[i];
      if (entry.toolName === toolName && entry.paramsHash === paramsHash) {
        count++;
      } else if (entry.toolName !== toolName) {
        // Only count consecutive or interleaved calls to the same tool
        // Allow other tools in between (agent might try something else and come back)
        continue;
      }
    }
    return count;
  }

  private categorizeIdentical(
    state: SessionLoopState,
    toolName: string,
    paramsHash: string,
  ): LoopCategory {
    // Check if all matching calls had errors → retry_failed_operation
    const matching = state.toolHistory.filter(
      (e) => e.toolName === toolName && e.paramsHash === paramsHash,
    );

    if (matching.length > 0 && matching.every((e) => e.hadError)) {
      return "retry_failed_operation";
    }

    // Check if results are all identical → polling_no_change
    const resultHashes = matching.map((e) => e.resultHash).filter(Boolean);
    if (resultHashes.length >= 2) {
      const allSame = resultHashes.every((h) => h === resultHashes[0]);
      if (allSame) return "polling_no_change";
    }

    return "retry_failed_operation";
  }

  private checkFuzzy(
    state: SessionLoopState,
    toolName: string,
    flatParams: string[],
  ): EnhancedLoopResult {
    const threshold = this.config.fuzzyMatchThreshold;
    const detectionThreshold = this.config.earlyDetectionThreshold;

    // Count recent calls to the same tool with similar (but not identical) params
    let fuzzyCount = 0;
    for (let i = state.toolHistory.length - 1; i >= 0; i--) {
      const entry = state.toolHistory[i];
      if (entry.toolName !== toolName) continue;

      const similarity = jaccardSimilarity(flatParams, entry.flatParams);
      if (similarity >= threshold && similarity < 1.0) {
        fuzzyCount++;
      }
    }

    if (fuzzyCount + 1 >= detectionThreshold) {
      return {
        detected: true,
        category: "fuzzy_repeat",
        count: fuzzyCount + 1,
        guidance: GUIDANCE.fuzzy_repeat(toolName, fuzzyCount + 1),
      };
    }

    return { detected: false, count: 0 };
  }

  private checkOscillation(
    state: SessionLoopState,
    toolName: string,
    paramsHash: string,
  ): EnhancedLoopResult {
    // Need at least 4 entries for an A→B→A→B pattern
    const history = state.toolHistory;
    if (history.length < 3) return { detected: false, count: 0 };

    // Check if we're about to complete another oscillation cycle
    // Pattern: ...A, B, A — and we're about to call B again (or vice versa)
    const current = `${toolName}:${paramsHash}`;
    let alternations = 0;

    // Walk backward looking for alternating pattern
    const recent = history.slice(-6); // only check last 6 entries for performance
    if (recent.length < 2) return { detected: false, count: 0 };

    const lastKey = `${recent[recent.length - 1].toolName}:${recent[recent.length - 1].paramsHash}`;
    const prevKey = `${recent[recent.length - 2].toolName}:${recent[recent.length - 2].paramsHash}`;

    // Are we oscillating: prev=A, last=B, current=A?
    if (current === prevKey && current !== lastKey) {
      // Count how many times this A↔B pattern has occurred
      for (let i = recent.length - 1; i >= 1; i--) {
        const a = `${recent[i].toolName}:${recent[i].paramsHash}`;
        const b = `${recent[i - 1].toolName}:${recent[i - 1].paramsHash}`;
        if ((a === current && b === lastKey) || (a === lastKey && b === current)) {
          alternations++;
        } else {
          break;
        }
      }
    }

    if (alternations >= 2) {
      return {
        detected: true,
        category: "oscillating_approaches",
        count: alternations + 1,
        guidance: GUIDANCE.oscillating_approaches(toolName, alternations + 1),
      };
    }

    return { detected: false, count: 0 };
  }
}
