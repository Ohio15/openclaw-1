/**
 * IntelligenceControlPlane - OpenClaw hook-oriented intelligence pipeline
 *
 * NOT a direct port of AICodeAssistant's ControlPlane. This is a reimagining
 * that exposes the intelligence pipeline as OpenClaw lifecycle hooks:
 *
 *   before_prompt_build  ->  analyzeBeforeAgent()
 *   agent_end            ->  evaluateAfterAgent()
 *
 * Internally orchestrates: ComplexityDecomposer, ConfidenceScorer,
 * CoherenceGate, RefusalDetector, DomainKnowledge, OutputFormatter.
 *
 * @module control-plane
 */

import { analyzeComplexity } from "./complexity-decomposer.js";
import { scoreConfidence } from "./confidence-scorer.js";
import { getCoherenceGate } from "./coherence-gate.js";
import { detectRefusal } from "./refusal-detector.js";
import { buildKnowledgeContext } from "./domain-knowledge.js";
import { getOutputFormatter } from "./output-formatter.js";
import {
  selectTier,
  selectPipeline,
  type TierSelection,
  type PipelineSelection,
} from "../config/routing-authority.js";

// ============================================================================
// Types
// ============================================================================

export interface IntelligenceConfig {
  enabled: boolean;
  selfReviewEnabled: boolean;
  multiPassEnabled: boolean;
  qualityThresholds?: {
    min?: number;
    good?: number;
    high?: number;
  };
  pipelineRules?: {
    complexityThreshold?: number;
    maxSimpleRequirements?: number;
  };
  feedbackPath?: string;
}

export interface Message {
  role: string;
  content: string | unknown[];
}

export interface BeforeAgentAnalysis {
  /** Complexity score 0-1 */
  complexity: number;
  /** Decomposed sub-tasks (if complexity > threshold) */
  subTasks: string[];
  /** Selected tier recommendation */
  tierSelection: TierSelection;
  /** Selected pipeline (simple vs complex) */
  pipelineSelection: PipelineSelection;
  /** Detected domain (e.g. "auth", "database") */
  domain: string | null;
  /** Domain context to prepend to the prompt, or null */
  domainContext: string | null;
  /** Number of extracted requirements */
  requirementCount: number;
}

export interface AfterAgentEvaluation {
  /** Confidence score 0-1 */
  confidenceScore: number;
  /** Whether the response passes the coherence gate */
  isCoherent: boolean;
  /** Whether a refusal was detected in the response */
  refusalDetected: boolean;
  /** Formatted/cleaned response content */
  formattedContent: string;
  /** Detected task type for output formatting */
  taskType: string;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract the text content from a message array (handles string and content-block formats).
 */
function extractText(messages: unknown[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;

    const content = m.content;
    if (typeof content === "string") {
      parts.push(content);
      continue;
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          parts.push((block as Record<string, unknown>).text as string);
        }
      }
    }
  }

  return parts.join("\n");
}

/**
 * Extract user prompt from messages (last user message).
 */
function extractUserPrompt(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m.role === "user") {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        const textParts: string[] = [];
        for (const block of m.content) {
          if (
            block &&
            typeof block === "object" &&
            (block as Record<string, unknown>).type === "text" &&
            typeof (block as Record<string, unknown>).text === "string"
          ) {
            textParts.push((block as Record<string, unknown>).text as string);
          }
        }
        return textParts.join("\n");
      }
    }
  }
  return "";
}

/**
 * Detect domain from text using keyword patterns.
 * Mirrors DOMAIN_ESCALATIONS keys for consistency.
 */
function detectDomain(text: string): string | null {
  const lower = text.toLowerCase();

  const domainPatterns: Array<[string, RegExp]> = [
    ["auth", /\b(auth|authentication|authorization|login|session|token)\b/],
    ["security", /\b(security|encryption|hash|csrf|xss|injection)\b/],
    ["jwt", /\bjwt\b/],
    ["oauth", /\boauth\b/],
    ["rate_limiter", /\brate.?limit/],
    ["token_bucket", /\btoken.?bucket/],
    ["sliding_window", /\bsliding.?window/],
    ["circuit_breaker", /\bcircuit.?breaker/],
    ["cache", /\b(cache|caching|lru|memoiz)/],
    ["tree", /\b(binary.?tree|b-tree|avl|red.?black)\b/],
    ["graph", /\b(graph|dijkstra|bfs|dfs|shortest.?path)\b/],
    ["heap", /\b(heap|priority.?queue)\b/],
    ["trie", /\btrie\b/],
    ["database", /\b(database|sql|postgres|mysql|mongo|prisma|query)\b/],
    ["api", /\b(api|endpoint|rest|graphql|grpc)\b/],
    ["middleware", /\bmiddleware\b/],
  ];

  for (const [domain, pattern] of domainPatterns) {
    if (pattern.test(lower)) return domain;
  }

  return null;
}

/**
 * Extract requirement count from text (heuristic: bullet points, numbered lists, "must"/"should" keywords).
 */
function countRequirements(text: string): number {
  let count = 0;

  // Count bullet/numbered list items
  const listItems = text.match(/^[\s]*[-*•]\s+.+$/gm);
  if (listItems) count += listItems.length;

  const numberedItems = text.match(/^[\s]*\d+[.)]\s+.+$/gm);
  if (numberedItems) count += numberedItems.length;

  // Count must/should/need statements
  const mustStatements = text.match(/\b(must|should|need to|require|ensure)\b/gi);
  if (mustStatements) count += Math.ceil(mustStatements.length / 2); // Deduplicate roughly

  return count;
}

/**
 * Detect task type from text content (mirrors MultiPassExecutor's determineSpecialistType).
 */
function detectTaskType(text: string): string {
  const lower = text.toLowerCase();

  if (/```|function\s|class\s|def\s|import\s|const\s|let\s|var\s/.test(text)) return "code_generation";
  if (/\b(error|exception|bug|fix|debug|traceback|stack)\b/.test(lower)) return "debugging";
  if (/\b(refactor|restructure|clean up|simplify)\b/.test(lower)) return "refactoring";
  if (/\b(explain|what is|how does|why does|describe)\b/.test(lower)) return "code_explanation";
  if (/\b(test|spec|assertion|mock|stub)\b/.test(lower)) return "testing";
  if (/\b(document|jsdoc|readme|comment)\b/.test(lower)) return "documentation";
  if (/\b(review|audit|check|inspect)\b/.test(lower)) return "code_review";

  return "general";
}

// ============================================================================
// IntelligenceControlPlane
// ============================================================================

export class IntelligenceControlPlane {
  private config: IntelligenceConfig;

  constructor(config: Partial<IntelligenceConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      selfReviewEnabled: config.selfReviewEnabled ?? true,
      multiPassEnabled: config.multiPassEnabled ?? false,
      qualityThresholds: {
        min: config.qualityThresholds?.min ?? 0.65,
        good: config.qualityThresholds?.good ?? 0.75,
        high: config.qualityThresholds?.high ?? 0.85,
      },
      pipelineRules: {
        complexityThreshold: config.pipelineRules?.complexityThreshold ?? 0.4,
        maxSimpleRequirements: config.pipelineRules?.maxSimpleRequirements ?? 3,
      },
      feedbackPath: config.feedbackPath,
    };
  }

  /**
   * Analyze messages BEFORE the agent runs.
   *
   * Called from the `before_prompt_build` hook. Returns complexity analysis,
   * pipeline selection, and optional domain context to prepend.
   */
  analyzeBeforeAgent(messages: unknown[]): BeforeAgentAnalysis {
    const userPrompt = extractUserPrompt(messages);

    // 1. Complexity decomposition
    const complexityResult = analyzeComplexity(userPrompt);
    const complexity = complexityResult.complexity;

    // 2. Domain detection
    const domain = detectDomain(userPrompt);

    // 3. Requirement count
    const requirementCount = countRequirements(userPrompt);

    // 4. Tier selection
    const taskType = detectTaskType(userPrompt);
    const tierSelection = selectTier(complexity, domain, taskType);

    // 5. Pipeline selection
    const pipelineSelection = selectPipeline(
      complexity,
      requirementCount,
      userPrompt,
    );

    // 6. Domain knowledge lookup (returns context string or null)
    const domainContext = domain ? buildKnowledgeContext(userPrompt) : null;

    return {
      complexity,
      subTasks: complexityResult.needsDecomposition
        ? complexityResult.indicators.map((i) => i.indicator)
        : [],
      tierSelection,
      pipelineSelection,
      domain,
      domainContext,
      requirementCount,
    };
  }

  /**
   * Evaluate the agent's response AFTER it completes.
   *
   * Called from the `agent_end` hook. Scores confidence, checks coherence,
   * detects refusals, and formats output.
   */
  async evaluateAfterAgent(
    messages: unknown[],
    response: string,
    metadata?: Record<string, unknown>,
  ): Promise<AfterAgentEvaluation> {
    const userPrompt = extractUserPrompt(messages);
    const taskType = detectTaskType(userPrompt);

    // 1. Confidence scoring
    const confidenceResult = scoreConfidence(response, {
      taskType,
      promptLength: userPrompt.length,
      hasCode: /```/.test(response),
    });

    // 2. Coherence check (does the response actually address the prompt?)
    const coherenceGate = getCoherenceGate();
    const coherenceResult = await coherenceGate.validate(
      response,
      { prompt: userPrompt, intent: taskType },
    );

    // 3. Refusal detection
    const refusalResult = detectRefusal(response);

    // 4. Output formatting/cleaning
    const formatter = getOutputFormatter();
    const formatted = formatter.format({ content: response, taskType });
    const formattedContent = formatted.content;

    return {
      confidenceScore: confidenceResult.score,
      isCoherent: coherenceResult.pass ?? coherenceResult.coherent ?? true,
      refusalDetected: refusalResult.isRefusal,
      formattedContent,
      taskType,
    };
  }
}
