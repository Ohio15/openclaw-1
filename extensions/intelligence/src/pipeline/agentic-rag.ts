/**
 * Agentic RAG Pipeline — Iterative, autonomous retrieval-augmented generation
 *
 * Enhances knowledge retrieval with:
 *   - Relevance evaluation of result sets
 *   - Heuristic query refinement (no LLM calls)
 *   - Iterative retrieve-evaluate-refine loops
 *   - Decomposed retrieval for multi-faceted queries
 *
 * @module agentic-rag
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RAGOptions {
  maxResults: number;
  minRelevance: number;
  maxTokens: number;
}

export interface RAGResult {
  id: string;
  content: string;
  score: number;
  similarity: number;
  type: string;
  tags: string[];
}

export type Retriever = (
  query: string,
  limit: number,
) => Promise<RAGResult[] | null>;

// ---------------------------------------------------------------------------
// Stop words for keyword extraction
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by",
  "can", "could", "did", "do", "does", "doing", "done", "each", "else",
  "every", "for", "from", "get", "got", "had", "has", "have", "having",
  "he", "her", "here", "hers", "him", "his", "how", "i", "if", "in",
  "into", "is", "it", "its", "just", "let", "like", "may", "me", "might",
  "more", "most", "much", "my", "no", "nor", "not", "now", "of", "on",
  "one", "only", "or", "other", "our", "out", "own", "per", "re", "said",
  "same", "she", "so", "some", "such", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "those", "through",
  "to", "too", "up", "us", "very", "was", "we", "were", "what", "when",
  "where", "which", "while", "who", "whom", "why", "will", "with", "would",
  "you", "your",
]);

// ---------------------------------------------------------------------------
// Domain synonym map for query expansion
// ---------------------------------------------------------------------------

const DOMAIN_SYNONYMS: Record<string, string[]> = {
  auth: ["authentication", "authorization", "login", "session", "credentials"],
  authentication: ["auth", "login", "session", "credentials", "identity"],
  authorization: ["auth", "permissions", "roles", "access", "rbac"],
  database: ["db", "sql", "postgres", "mysql", "query", "schema"],
  db: ["database", "sql", "postgres", "query", "schema"],
  api: ["endpoint", "rest", "graphql", "route", "handler"],
  endpoint: ["api", "route", "handler", "url"],
  cache: ["caching", "redis", "memoize", "lru", "ttl"],
  caching: ["cache", "redis", "memoize", "lru", "ttl"],
  deploy: ["deployment", "release", "ci", "cd", "pipeline"],
  deployment: ["deploy", "release", "ci", "cd", "pipeline"],
  error: ["exception", "bug", "failure", "crash", "issue"],
  bug: ["error", "defect", "issue", "fix", "regression"],
  config: ["configuration", "settings", "options", "env"],
  configuration: ["config", "settings", "options", "env", "environment"],
  test: ["testing", "spec", "unit", "integration", "e2e"],
  testing: ["test", "spec", "unit", "integration", "e2e"],
  security: ["vulnerability", "exploit", "xss", "csrf", "injection"],
  performance: ["speed", "latency", "throughput", "optimization", "profiling"],
  monitor: ["monitoring", "observability", "metrics", "logging", "alerting"],
  monitoring: ["monitor", "observability", "metrics", "logging", "alerting"],
};

// ---------------------------------------------------------------------------
// Keyword extraction
// ---------------------------------------------------------------------------

/**
 * Extract meaningful keywords from text by splitting on whitespace/punctuation,
 * lowercasing, and removing stop words. Keeps words >= 3 chars.
 */
function extractKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[\s\-_/\\,.;:!?'"()[\]{}<>|@#$%^&*+=~`]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      result.push(token);
    }
  }
  return result;
}

/**
 * Compute keyword overlap ratio between a set of keywords and a text body.
 * Returns 0-1 indicating what fraction of keywords appear in the text.
 */
function keywordOverlap(keywords: string[], text: string): number {
  if (keywords.length === 0) return 0;
  const lowerText = text.toLowerCase();
  let matched = 0;
  for (const kw of keywords) {
    if (lowerText.includes(kw)) {
      matched++;
    }
  }
  return matched / keywords.length;
}

// ---------------------------------------------------------------------------
// AgenticRAGPipeline
// ---------------------------------------------------------------------------

export class AgenticRAGPipeline {
  private retriever: Retriever;

  constructor(retriever: Retriever) {
    this.retriever = retriever;
  }

  // -----------------------------------------------------------------------
  // retrieve — single-shot base retrieval
  // -----------------------------------------------------------------------

  /**
   * Single-shot retrieval. Calls shared-brain via the injected retriever.
   * Filters by minRelevance and limits to maxResults.
   */
  async retrieve(query: string, options: RAGOptions): Promise<RAGResult[]> {
    try {
      const raw = await this.retriever(query, options.maxResults * 2);
      if (!raw || raw.length === 0) return [];

      return raw
        .filter((r) => r.score >= options.minRelevance)
        .slice(0, options.maxResults);
    } catch (err) {
      console.warn("[agentic-rag] retrieve error:", err);
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // evaluateRelevance — score how well results match the query
  // -----------------------------------------------------------------------

  /**
   * Score result set relevance 0-1 using keyword overlap, coverage, and freshness.
   */
  evaluateRelevance(results: RAGResult[], originalQuery: string): number {
    if (results.length === 0) return 0;

    const queryKeywords = extractKeywords(originalQuery);
    if (queryKeywords.length === 0) return 0;

    // --- Keyword overlap (weight: 0.5) ---
    // How many query keywords appear across all result content combined
    const allContent = results.map((r) => r.content).join(" ");
    const overlapScore = keywordOverlap(queryKeywords, allContent);

    // --- Coverage (weight: 0.3) ---
    // What fraction of query keywords are covered by at least one result
    // (per-result coverage rather than combined — ensures spread)
    const coveredKeywords = new Set<string>();
    for (const result of results) {
      const lowerContent = result.content.toLowerCase();
      for (const kw of queryKeywords) {
        if (lowerContent.includes(kw)) {
          coveredKeywords.add(kw);
        }
      }
    }
    const coverageScore = coveredKeywords.size / queryKeywords.length;

    // --- Freshness (weight: 0.2) ---
    // Average normalized score from the brain results (higher score = more relevant/fresh)
    const avgScore =
      results.reduce((sum, r) => sum + r.score, 0) / results.length;
    // Brain scores are typically 0-1 already; clamp to be safe
    const freshnessScore = Math.min(1, Math.max(0, avgScore));

    return overlapScore * 0.5 + coverageScore * 0.3 + freshnessScore * 0.2;
  }

  // -----------------------------------------------------------------------
  // refineQuery — heuristic query refinement
  // -----------------------------------------------------------------------

  /**
   * Generate a refined search query based on what was missing from previous results.
   * Pure heuristic — no LLM calls.
   */
  refineQuery(
    originalQuery: string,
    previousResults: RAGResult[],
    gaps: string[],
  ): string {
    const originalKeywords = extractKeywords(originalQuery);
    const resultContent = previousResults.map((r) => r.content).join(" ");
    const resultLower = resultContent.toLowerCase();

    // Find keywords that had NO matches in result content
    const unmatchedKeywords = originalKeywords.filter(
      (kw) => !resultLower.includes(kw),
    );

    // Find keywords that DID match (to deprioritize)
    const matchedKeywords = originalKeywords.filter((kw) =>
      resultLower.includes(kw),
    );

    // Expand gaps with domain synonyms
    const expansionTerms: string[] = [];
    const gapKeywords = gaps.flatMap((g) => extractKeywords(g));
    for (const kw of [...unmatchedKeywords, ...gapKeywords]) {
      const synonyms = DOMAIN_SYNONYMS[kw];
      if (synonyms) {
        // Add up to 2 synonyms that aren't already in the query
        let added = 0;
        for (const syn of synonyms) {
          if (
            added >= 2 ||
            originalKeywords.includes(syn) ||
            expansionTerms.includes(syn)
          ) {
            continue;
          }
          expansionTerms.push(syn);
          added++;
        }
      }
    }

    // Build refined query: unmatched keywords first (highest signal),
    // then expansion terms, then a subset of matched keywords for context
    const parts: string[] = [];

    // Unmatched keywords (primary focus)
    parts.push(...unmatchedKeywords);

    // Gap-derived keywords not already included
    for (const gk of gapKeywords) {
      if (!parts.includes(gk) && !matchedKeywords.includes(gk)) {
        parts.push(gk);
      }
    }

    // Domain synonym expansions
    parts.push(...expansionTerms);

    // Keep up to 3 matched keywords for context anchoring
    const contextAnchors = matchedKeywords.slice(0, 3);
    for (const anchor of contextAnchors) {
      if (!parts.includes(anchor)) {
        parts.push(anchor);
      }
    }

    // If we somehow ended up with nothing, return the original
    if (parts.length === 0) {
      return originalQuery;
    }

    return parts.join(" ");
  }

  // -----------------------------------------------------------------------
  // iterativeRetrieve — orchestration loop
  // -----------------------------------------------------------------------

  /**
   * Orchestrates: query -> evaluate -> refine -> re-query.
   * Exits early when relevance >= threshold. Deduplicates across iterations.
   */
  async iterativeRetrieve(
    query: string,
    options: RAGOptions & {
      maxIterations?: number;
      relevanceThreshold?: number;
    },
  ): Promise<RAGResult[]> {
    const maxIterations = options.maxIterations ?? 3;
    const relevanceThreshold = options.relevanceThreshold ?? 0.6;

    const seenIds = new Set<string>();
    const allResults: RAGResult[] = [];
    let currentQuery = query;

    try {
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        const results = await this.retrieve(currentQuery, options);

        // Deduplicate and accumulate
        for (const result of results) {
          if (!seenIds.has(result.id)) {
            seenIds.add(result.id);
            allResults.push(result);
          }
        }

        // Evaluate relevance of the accumulated set
        const relevance = this.evaluateRelevance(allResults, query);

        if (relevance >= relevanceThreshold) {
          break; // Good enough — stop iterating
        }

        // Don't refine on the last iteration (we won't query again)
        if (iteration < maxIterations - 1) {
          // Identify gaps: query keywords not covered by results
          const queryKeywords = extractKeywords(query);
          const allContent = allResults
            .map((r) => r.content)
            .join(" ")
            .toLowerCase();
          const gaps = queryKeywords.filter((kw) => !allContent.includes(kw));

          currentQuery = this.refineQuery(query, allResults, gaps);
        }
      }
    } catch (err) {
      console.warn("[agentic-rag] iterativeRetrieve error:", err);
      // Return whatever we collected so far
    }

    // Sort by score descending, limit to maxResults
    return allResults
      .sort((a, b) => b.score - a.score)
      .slice(0, options.maxResults);
  }

  // -----------------------------------------------------------------------
  // decomposedRetrieve — parallel targeted retrieval per sub-task
  // -----------------------------------------------------------------------

  /**
   * Runs targeted retrieval for each sub-task description, deduplicates,
   * merges, and sorts by score.
   */
  async decomposedRetrieve(
    subTasks: string[],
    options: RAGOptions,
  ): Promise<RAGResult[]> {
    if (subTasks.length === 0) return [];

    const seenIds = new Set<string>();
    const allResults: RAGResult[] = [];

    // Distribute maxResults across sub-tasks (minimum 2 per sub-task)
    const perTaskLimit = Math.max(
      2,
      Math.ceil(options.maxResults / subTasks.length),
    );

    try {
      // Run all sub-task retrievals concurrently
      const retrievalPromises = subTasks.map((subTask) =>
        this.retrieve(subTask, {
          ...options,
          maxResults: perTaskLimit,
        }).catch((err) => {
          console.warn(
            `[agentic-rag] decomposed retrieval failed for sub-task "${subTask}":`,
            err,
          );
          return [] as RAGResult[];
        }),
      );

      const resultSets = await Promise.all(retrievalPromises);

      for (const results of resultSets) {
        for (const result of results) {
          if (!seenIds.has(result.id)) {
            seenIds.add(result.id);
            allResults.push(result);
          }
        }
      }
    } catch (err) {
      console.warn("[agentic-rag] decomposedRetrieve error:", err);
    }

    // Sort by score descending, limit to maxResults
    return allResults
      .sort((a, b) => b.score - a.score)
      .slice(0, options.maxResults);
  }
}
