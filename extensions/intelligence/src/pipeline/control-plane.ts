/**
 * IntelligenceControlPlane — Pre-agent analysis for OpenClaw lifecycle hooks.
 *
 * Provides complexity analysis, domain detection, tier routing, and
 * knowledge retrieval. Post-agent quality assessment is handled separately
 * by quality-gate.ts.
 *
 *   before_model_resolve / before_prompt_build  ->  analyzeBeforeAgent()
 *
 * @module control-plane
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeComplexity } from "./complexity-decomposer.js";
import {
  getSemanticKnowledge,
  complexityBasedMaxResults,
} from "./knowledge-retrieval.js";
import {
  selectTier,
  selectPipeline,
  MODEL_TIERS,
  type TierSelection,
  type PipelineSelection,
} from "../config/routing-authority.js";
import { LearnedClassifier } from "./learned-classifier.js";

// ============================================================================
// Types
// ============================================================================

export interface IntelligenceConfig {
  enabled: boolean;
  pipelineRules?: {
    complexityThreshold?: number;
    maxSimpleRequirements?: number;
  };
  feedbackPath?: string;
  /** Knowledge source: "semantic" (shared-brain), "static" (hardcoded), "hybrid" (semantic + static fallback) */
  knowledgeSource?: "semantic" | "static" | "hybrid";
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


// ============================================================================
// Helpers
// ============================================================================


/**
 * Extract user prompt from messages (last user message).
 */
export function extractUserPrompt(messages: unknown[]): string {
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
 * Detect domain from text using keyword patterns with priority-based matching.
 * Returns the most specific matching domain (highest priority wins).
 * Mirrors DOMAIN_ESCALATIONS keys for consistency.
 */
export function detectDomain(text: string): string | null {
  const lower = text.toLowerCase();

  // [domain, pattern, priority] — higher priority = more specific
  const domainPatterns: Array<[string, RegExp, number]> = [
    // Most specific domains (high priority)
    ["token_bucket", /\btoken.?bucket/, 10],
    ["sliding_window", /\bsliding.?window/, 10],
    ["circuit_breaker", /\bcircuit.?breaker/, 10],
    ["rate_limiter", /\brate.?limit/, 9],
    ["jwt", /\bjwt\b/, 9],
    ["oauth", /\boauth\b/, 9],
    ["trie", /\btrie\b/, 8],
    ["heap", /\b(heap|priority.?queue)\b/, 8],
    ["tree", /\b(binary.?tree|b-tree|avl|red.?black)\b/, 8],
    ["graph", /\b(graph|dijkstra|bfs|dfs|shortest.?path)\b/, 8],
    // Broad categories (lower priority)
    ["security", /\b(security.?audit|encryption|hash|csrf|xss|injection|vulnerability)\b/, 5],
    ["auth", /\b(authentication|authorization|login.?flow|auth.?middleware)\b/, 5],
    ["cache", /\b(cache|caching|lru|memoiz)/, 5],
    ["database", /\b(database|sql|postgres|mysql|mongo|prisma)\b/, 4],
    ["middleware", /\bmiddleware\b/, 3],
    ["api", /\b(api|endpoint|rest|graphql|grpc)\b/, 3],
  ];

  let bestDomain: string | null = null;
  let bestPriority = -1;

  for (const [domain, pattern, priority] of domainPatterns) {
    if (pattern.test(lower) && priority > bestPriority) {
      bestDomain = domain;
      bestPriority = priority;
    }
  }

  return bestDomain;
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
 * Numeric rank for tier comparison. Higher = more capable.
 */
const TIER_RANKS: Record<string, number> = {
  tiny: 0,
  small: 1,
  medium: 2,
  large: 3,
  reasoning: 4,
};

function tierRank(tier: string): number {
  return TIER_RANKS[tier] ?? 2; // default to medium if unknown
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
  private classifier: LearnedClassifier;
  private classifierReady: boolean;

  constructor(config: Partial<IntelligenceConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      pipelineRules: {
        complexityThreshold: config.pipelineRules?.complexityThreshold ?? 0.4,
        maxSimpleRequirements: config.pipelineRules?.maxSimpleRequirements ?? 3,
      },
      feedbackPath: config.feedbackPath,
      knowledgeSource: config.knowledgeSource ?? "hybrid",
    };

    // Load the learned classifier model at startup.
    // Falls back to heuristic if model file doesn't exist.
    this.classifier = new LearnedClassifier();
    this.classifierReady = false;
    try {
      // Resolve model path relative to this source file's location in the project tree.
      // The model lives at benchmark/classifier-model.json relative to the extension root.
      const thisDir = dirname(fileURLToPath(import.meta.url));
      const modelPath = resolve(thisDir, "../../benchmark/classifier-model.json");
      this.classifierReady = this.classifier.loadModelFromFile(modelPath);
    } catch {
      // Model loading failed — fall back to heuristic
      this.classifierReady = false;
    }
  }

  /**
   * Whether the learned classifier is loaded and ready.
   */
  get isClassifierReady(): boolean {
    return this.classifierReady;
  }

  /**
   * Analyze messages BEFORE the agent runs.
   *
   * Called from the `before_prompt_build` hook. Returns complexity analysis,
   * pipeline selection, and optional domain context to prepend.
   *
   * Queries shared-brain for semantically relevant knowledge (not gated by
   * domain detection). Falls back to static domain-knowledge.ts in hybrid mode.
   */
  async analyzeBeforeAgent(messages: unknown[]): Promise<BeforeAgentAnalysis> {
    const userPrompt = extractUserPrompt(messages);

    // 1. Complexity decomposition (always run — used for knowledge retrieval sizing)
    const complexityResult = analyzeComplexity(userPrompt);
    const complexity = complexityResult.complexity;

    // 2. Domain detection (still used for domain escalation override and knowledge gating)
    const domain = detectDomain(userPrompt);

    // 3. Requirement count
    const requirementCount = countRequirements(userPrompt);

    // 4. Tier and pipeline selection
    //    PRIMARY: learned classifier (if model loaded)
    //    FALLBACK: heuristic-based selectTier + selectPipeline
    let tierSelection: TierSelection;
    let pipelineSelection: PipelineSelection;

    if (this.classifierReady) {
      const prediction = this.classifier.predictFromPrompt(userPrompt);

      tierSelection = {
        tier: prediction.tier,
        reason: `Learned classifier (confidence: ${(prediction.tierConfidence * 100).toFixed(0)}%)`,
      };

      pipelineSelection = {
        pipeline: prediction.pipeline as "simple" | "complex",
        reason: `Learned classifier (confidence: ${(prediction.pipelineConfidence * 100).toFixed(0)}%)`,
      };

      // Domain escalation override: if routing-authority says a domain should
      // escalate and the classifier chose a lower tier, respect the escalation.
      // This preserves the safety net for security-sensitive domains.
      const taskType = detectTaskType(userPrompt);
      const heuristicTier = selectTier(complexity, domain, taskType);

      if (
        domain &&
        heuristicTier.reason.startsWith("Domain escalation") &&
        tierRank(heuristicTier.tier) > tierRank(prediction.tier)
      ) {
        tierSelection = {
          tier: heuristicTier.tier,
          reason: `Domain escalation override: ${domain} -> ${heuristicTier.tier} (classifier predicted ${prediction.tier})`,
        };
      }
    } else {
      // Fallback to heuristic when no classifier model is available
      const taskType = detectTaskType(userPrompt);
      tierSelection = selectTier(complexity, domain, taskType);
      pipelineSelection = selectPipeline(
        complexity,
        requirementCount,
        userPrompt,
      );
    }

    // 6. Semantic knowledge retrieval (not gated by domain — any query gets searched)
    //    Uses agentic RAG for complex queries (iterative/decomposed retrieval)
    const tierConfig = MODEL_TIERS[tierSelection.tier];
    const domainContext = await getSemanticKnowledge(
      userPrompt,
      {
        maxResults: complexityBasedMaxResults(complexity),
        minRelevance: 0.4,
        maxTokens: tierConfig?.maxTokens ?? 4096,
      },
      this.config.knowledgeSource,
      {
        complexity: complexityResult.complexity,
        needsDecomposition: complexityResult.needsDecomposition,
        indicators: complexityResult.indicators,
      },
    );

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

}
