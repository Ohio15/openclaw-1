/**
 * Quality Gate — Actionable response quality assessment
 *
 * Replaces the old confidence-scorer + refusal-detector + coherence-gate +
 * output-formatter stack with a single module that returns verdicts the
 * pipeline can actually act on.
 *
 * Checks for:
 *   1. Placeholder patterns (TODO, FIXME, "implement here")
 *   2. Truncation (trailing "...", unbalanced code fences)
 *   3. Explicit refusals ("I cannot", "too complex to implement")
 *   4. Incomplete code (empty blocks in code, ellipsis comments)
 *
 * Deliberately does NOT check for:
 *   - Code shape (backticks, TypeScript types, export statements)
 *   - Response length or format
 *   - "## Overview" or "Pros/Cons" headings (legitimate response structures)
 *
 * @module quality-gate
 */

// ============================================================================
// Types
// ============================================================================

export type QualityVerdict = "pass" | "flag" | "retry";

export interface QualityIssue {
  type: "placeholder" | "truncation" | "explicit_refusal" | "incomplete_code";
  description: string;
  /** The matched text fragment */
  evidence: string;
}

export interface QualityGateResult {
  verdict: QualityVerdict;
  issues: QualityIssue[];
  /** 0-1 score for feedback recording — NOT used for decisions */
  score: number;
}

// ============================================================================
// Patterns
// ============================================================================

interface PatternDef {
  pattern: RegExp;
  type: QualityIssue["type"];
  description: string;
  /** Score penalty per occurrence */
  penalty: number;
}

const PATTERNS: PatternDef[] = [
  // --- Placeholder patterns ---
  {
    pattern: /\/\/\s*(TODO|FIXME|XXX)\b[^\n]*/gi,
    type: "placeholder",
    description: "TODO/FIXME comment",
    penalty: 0.15,
  },
  {
    pattern: /implement\s*(this|the|your)\s*(logic|code|functionality)\s*here/gi,
    type: "placeholder",
    description: "Placeholder implementation instruction",
    penalty: 0.15,
  },
  {
    pattern: /throw\s+new\s+Error\s*\(\s*['"]not implemented/gi,
    type: "placeholder",
    description: "Not-implemented error throw",
    penalty: 0.15,
  },
  {
    pattern: /\bunimplemented!\s*\(\s*\)/g,
    type: "placeholder",
    description: "Rust unimplemented!() macro",
    penalty: 0.15,
  },
  {
    pattern: /\btodo!\s*\(\s*\)/g,
    type: "placeholder",
    description: "Rust todo!() macro",
    penalty: 0.15,
  },
  {
    pattern: /\bNotImplementedError\b/g,
    type: "placeholder",
    description: "Python NotImplementedError",
    penalty: 0.15,
  },
  {
    pattern: /\bpass\s*$/gm,
    type: "placeholder",
    description: "Python pass statement",
    penalty: 0.1,
  },

  // --- Incomplete code patterns ---
  {
    pattern: /\/\/\s*\.\.\.\s*$/gm,
    type: "incomplete_code",
    description: "Ellipsis comment (// ...)",
    penalty: 0.15,
  },
  {
    pattern: /\/\*\s*\.\.\.\s*\*\//g,
    type: "incomplete_code",
    description: "Ellipsis block comment (/* ... */)",
    penalty: 0.15,
  },

  // --- Explicit refusal patterns ---
  {
    pattern: /I\s*(cannot|can't|am unable to)\s*(provide|generate|create|implement|write)\b/gi,
    type: "explicit_refusal",
    description: "Explicit capability refusal",
    penalty: 0.3,
  },
  {
    pattern: /this\s*(request|task|implementation)\s*is\s*too\s*(extensive|complex|large)\b/gi,
    type: "explicit_refusal",
    description: "Complexity refusal",
    penalty: 0.3,
  },
  {
    pattern: /too\s+extensive\s+to\s+implement/gi,
    type: "explicit_refusal",
    description: "Extent refusal",
    penalty: 0.3,
  },
  {
    pattern: /beyond\s+(my|the)\s+(capabilities|scope)\b/gi,
    type: "explicit_refusal",
    description: "Scope refusal",
    penalty: 0.3,
  },
];

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract code fence regions so we can distinguish in-code patterns
 * from outside-code patterns.
 */
function getCodeFenceRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const regex = /```[\s\S]*?```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function isInsideCodeFence(
  position: number,
  ranges: Array<[number, number]>,
): boolean {
  return ranges.some(([start, end]) => position >= start && position < end);
}

/**
 * Check for unbalanced code fences (odd number of ``` sequences).
 */
function hasUnbalancedFences(text: string): boolean {
  const fenceCount = (text.match(/```/g) || []).length;
  return fenceCount % 2 !== 0;
}

/**
 * Check for trailing truncation (ends with "..." outside a code block).
 */
function hasTrailingTruncation(
  text: string,
  codeRanges: Array<[number, number]>,
): boolean {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith("...")) return false;

  // Check it's not inside a code fence
  const dotPos = trimmed.length - 3;
  return !isInsideCodeFence(dotPos, codeRanges);
}

/**
 * Detect empty blocks inside code fences: `{ }` or `{\n}`
 * Only flag these when they appear inside code blocks (not prose).
 */
function findEmptyBlocksInCode(
  text: string,
  codeRanges: Array<[number, number]>,
): string[] {
  const found: string[] = [];
  const regex = /\{\s*\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (isInsideCodeFence(match.index, codeRanges)) {
      found.push(match[0]);
    }
  }
  return found;
}

// ============================================================================
// Main
// ============================================================================

/**
 * Assess response quality and return an actionable verdict.
 */
export function assessQuality(response: string): QualityGateResult {
  if (!response || typeof response !== "string") {
    return { verdict: "flag", issues: [], score: 0 };
  }

  const issues: QualityIssue[] = [];
  const codeRanges = getCodeFenceRanges(response);

  // Run pattern checks
  for (const def of PATTERNS) {
    // Reset regex state for global patterns
    def.pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = def.pattern.exec(response)) !== null) {
      issues.push({
        type: def.type,
        description: def.description,
        evidence: match[0].slice(0, 80),
      });
    }
  }

  // Truncation checks
  if (hasTrailingTruncation(response, codeRanges)) {
    issues.push({
      type: "truncation",
      description: "Response ends with trailing ellipsis",
      evidence: response.trimEnd().slice(-40),
    });
  }

  if (hasUnbalancedFences(response)) {
    issues.push({
      type: "truncation",
      description: "Unbalanced code fences (possible truncation)",
      evidence: "Odd number of ``` sequences",
    });
  }

  // Empty blocks in code
  const emptyBlocks = findEmptyBlocksInCode(response, codeRanges);
  for (const block of emptyBlocks) {
    issues.push({
      type: "incomplete_code",
      description: "Empty block in code",
      evidence: block,
    });
  }

  // Compute verdict
  const hasRefusal = issues.some((i) => i.type === "explicit_refusal");
  const nonRefusalCount = issues.filter(
    (i) => i.type !== "explicit_refusal",
  ).length;

  let verdict: QualityVerdict;
  if (hasRefusal) {
    verdict = "retry";
  } else if (nonRefusalCount >= 3) {
    verdict = "retry";
  } else if (issues.length > 0) {
    verdict = "flag";
  } else {
    verdict = "pass";
  }

  // Compute score (for feedback recording only)
  let score = 1.0;
  for (const issue of issues) {
    const def = PATTERNS.find(
      (p) => p.description === issue.description,
    );
    const penalty = def?.penalty ?? 0.15;
    score -= penalty;
  }
  // Truncation/empty block penalties
  score -= issues.filter((i) => i.type === "truncation").length * 0.2;
  score -= issues.filter((i) =>
    i.type === "incomplete_code" && i.description === "Empty block in code",
  ).length * 0.1;
  score = Math.max(0, Math.min(1, score));

  return { verdict, issues, score };
}

// ============================================================================
// Two-stage gate: heuristic + LLM judge
// ============================================================================

import {
  evaluateWithLLMJudge,
  type LLMJudgeConfig,
} from "./llm-judge.js";

/**
 * Two-stage quality assessment:
 *
 * Stage 1: Heuristic gate (instant, <1ms)
 *   → "pass" with score > threshold → DONE
 *   → "retry" (explicit refusal) → DONE
 *   → "flag" or "pass" with score ≤ threshold → Stage 2
 *
 * Stage 2: LLM judge (2-10s via Ollama)
 *   → evaluates completeness, correctness, depth, implementation quality
 *   → returns refined verdict with reasoning
 *
 * Falls back to heuristic-only on any judge failure.
 */
export async function assessQualityWithJudge(
  response: string,
  userPrompt: string,
  config: LLMJudgeConfig,
): Promise<QualityGateResult> {
  // Stage 1: always run heuristic gate
  const heuristicResult = assessQuality(response);

  // Clear pass — score above threshold, skip judge entirely
  if (
    heuristicResult.verdict === "pass" &&
    heuristicResult.score > config.minHeuristicScoreForJudge
  ) {
    return heuristicResult;
  }

  // Clear retry (explicit refusal) — skip judge, cascade immediately
  if (heuristicResult.verdict === "retry") {
    return heuristicResult;
  }

  // Borderline — invoke LLM judge (Stage 2)
  try {
    const judgeResult = await evaluateWithLLMJudge({
      userPrompt,
      assistantResponse: response,
      heuristicResult,
      ollamaBaseUrl: config.ollamaBaseUrl,
      model: config.model,
      timeoutMs: config.timeoutMs,
    });

    // Merge: use judge's verdict but keep heuristic issues for diagnostics
    return {
      verdict: judgeResult.verdict,
      issues: [
        ...heuristicResult.issues,
        // Add a synthetic issue with the judge's reasoning for traceability
        {
          type: "placeholder" as const, // closest available type
          description: `LLM judge: ${judgeResult.reasoning}`,
          evidence: `verdict=${judgeResult.verdict} confidence=${judgeResult.confidence.toFixed(2)} time=${judgeResult.evaluationTimeMs}ms`,
        },
      ],
      score: judgeResult.confidence,
    };
  } catch (err: unknown) {
    // Judge failed entirely — fall back to heuristic
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[quality-gate] LLM judge failed, using heuristic: ${msg}`);
    return heuristicResult;
  }
}
