/**
 * LLM Judge — Semantic quality evaluation via local LLM (Ollama)
 *
 * Supplements the heuristic quality gate (Stage 1) with a small local LLM
 * that evaluates response quality semantically (Stage 2). Only invoked for
 * borderline cases where the heuristic gate is uncertain.
 *
 * The judge evaluates:
 *   - Completeness: does the response fully address the request?
 *   - Correctness: obvious factual or code errors?
 *   - Depth: appropriately detailed for the complexity?
 *   - Implementation: real, functional code (not stubs/placeholders)?
 *
 * Falls back gracefully on any failure (timeout, parse error, connection
 * refused) — never crashes or blocks response delivery.
 *
 * @module llm-judge
 */

import { generateCompletion } from "./ollama-client.js";
import type { QualityGateResult, QualityVerdict } from "./quality-gate.js";

// ============================================================================
// Types
// ============================================================================

export interface LLMJudgeParams {
  /** The original user request */
  userPrompt: string;
  /** The LLM's response to evaluate */
  assistantResponse: string;
  /** Stage 1 heuristic result for context */
  heuristicResult: QualityGateResult;
  /** Ollama base URL (e.g., "http://192.168.1.20:11434") */
  ollamaBaseUrl: string;
  /** Model name (e.g., "deepseek-r1-distill-qwen-7b:latest") */
  model: string;
  /** Request timeout in milliseconds (default 15000) */
  timeoutMs?: number;
}

export interface LLMJudgeResult {
  /** Refined verdict from the LLM judge */
  verdict: QualityVerdict;
  /** 1-2 sentence explanation */
  reasoning: string;
  /** Confidence score 0-1 */
  confidence: number;
  /** Wall-clock evaluation time in milliseconds */
  evaluationTimeMs: number;
}

export interface LLMJudgeConfig {
  enabled: boolean;
  ollamaBaseUrl: string;
  model: string;
  timeoutMs: number;
  /** Heuristic score threshold — only invoke judge when score <= this */
  minHeuristicScoreForJudge: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT_MS = 15_000;

/** Maximum length of user prompt to include in judge prompt (avoid token explosion) */
const MAX_USER_PROMPT_CHARS = 2_000;

/** Maximum length of assistant response to include in judge prompt */
const MAX_RESPONSE_CHARS = 4_000;

// ============================================================================
// Prompt construction
// ============================================================================

/**
 * Build the structured prompt for the LLM judge.
 * Exported for testing.
 */
export function buildJudgePrompt(
  userPrompt: string,
  assistantResponse: string,
): string {
  const truncatedPrompt = userPrompt.length > MAX_USER_PROMPT_CHARS
    ? userPrompt.slice(0, MAX_USER_PROMPT_CHARS) + "\n[... truncated]"
    : userPrompt;

  const truncatedResponse = assistantResponse.length > MAX_RESPONSE_CHARS
    ? assistantResponse.slice(0, MAX_RESPONSE_CHARS) + "\n[... truncated]"
    : assistantResponse;

  return `You are a quality evaluator for AI assistant responses. Evaluate the following response to a user's request.

<user_request>
${truncatedPrompt}
</user_request>

<assistant_response>
${truncatedResponse}
</assistant_response>

Evaluate for:
1. COMPLETENESS: Does it fully address the request, or is it partial/truncated?
2. CORRECTNESS: Are there obvious factual or code errors?
3. DEPTH: Is the response appropriately detailed for the complexity of the request?
4. IMPLEMENTATION: If code is provided, is it real and functional (not stubs/placeholders)?

Respond in exactly this format:
VERDICT: [pass|flag|retry]
CONFIDENCE: [0.0-1.0]
REASONING: [one sentence explanation]`;
}

// ============================================================================
// Response parsing
// ============================================================================

/**
 * Parse the judge model's output into a structured result.
 * Returns null if parsing fails (caller should fall back to heuristic).
 * Exported for testing.
 */
export function parseJudgeResponse(
  raw: string,
): { verdict: QualityVerdict; confidence: number; reasoning: string } | null {
  // Extract VERDICT
  const verdictMatch = raw.match(/VERDICT:\s*(pass|flag|retry)/i);
  if (!verdictMatch) return null;

  const verdict = verdictMatch[1].toLowerCase() as QualityVerdict;

  // Extract CONFIDENCE
  const confidenceMatch = raw.match(/CONFIDENCE:\s*([\d.]+)/i);
  let confidence = 0.5; // default if missing
  if (confidenceMatch) {
    const parsed = parseFloat(confidenceMatch[1]);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
      confidence = parsed;
    }
  }

  // Extract REASONING (everything after "REASONING:" on the same line or until end)
  const reasoningMatch = raw.match(/REASONING:\s*(.+)/i);
  const reasoning = reasoningMatch
    ? reasoningMatch[1].trim()
    : "No reasoning provided";

  return { verdict, confidence, reasoning };
}

// ============================================================================
// Main evaluation function
// ============================================================================

/**
 * Evaluate a response using the LLM judge via Ollama.
 *
 * On any failure (timeout, connection error, parse failure), returns a
 * fallback result based on the heuristic gate instead of crashing.
 */
export async function evaluateWithLLMJudge(
  params: LLMJudgeParams,
): Promise<LLMJudgeResult> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  try {
    const prompt = buildJudgePrompt(params.userPrompt, params.assistantResponse);

    const result = await generateCompletion(
      params.ollamaBaseUrl,
      params.model,
      prompt,
      {
        timeoutMs,
        temperature: 0.1,
        numPredict: 150,
      },
    );

    const evaluationTimeMs = Date.now() - start;

    if (!result.ok) {
      // Ollama call failed — fall back to heuristic
      console.warn(
        `[llm-judge] Ollama call failed (${result.errorType}): ${result.message}`,
      );
      return heuristicFallback(params.heuristicResult, evaluationTimeMs, result.message);
    }

    // Parse the judge's response
    const parsed = parseJudgeResponse(result.response);

    if (!parsed) {
      // Parse failed — fall back to heuristic
      console.warn(
        `[llm-judge] Failed to parse judge response: ${result.response.slice(0, 200)}`,
      );
      return heuristicFallback(
        params.heuristicResult,
        evaluationTimeMs,
        "Judge response parse failure",
      );
    }

    return {
      verdict: parsed.verdict,
      reasoning: parsed.reasoning,
      confidence: parsed.confidence,
      evaluationTimeMs,
    };
  } catch (err: unknown) {
    // Unexpected error — fall back to heuristic
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[llm-judge] Unexpected error: ${msg}`);
    return heuristicFallback(
      params.heuristicResult,
      Date.now() - start,
      `Unexpected error: ${msg}`,
    );
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Produce a fallback LLMJudgeResult from the heuristic gate's output
 * when the LLM judge cannot run or fails.
 */
function heuristicFallback(
  heuristicResult: QualityGateResult,
  evaluationTimeMs: number,
  reason: string,
): LLMJudgeResult {
  return {
    verdict: heuristicResult.verdict,
    reasoning: `Fallback to heuristic: ${reason}`,
    confidence: heuristicResult.score,
    evaluationTimeMs,
  };
}
