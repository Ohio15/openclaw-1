/**
 * Knowledge Retrieval — Semantic search via shared-brain MCP
 *
 * Provides semantic knowledge retrieval for the intelligence pipeline.
 * Uses shared-brain MCP over HTTP with SSE responses as the primary
 * knowledge source, falling back to static domain-knowledge when unavailable.
 *
 * @module knowledge-retrieval
 */

import { buildKnowledgeContext } from "./domain-knowledge.js";
import {
  AgenticRAGPipeline,
  type RAGResult,
  type Retriever,
} from "./agentic-rag.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KnowledgeRetrievalOptions {
  maxResults: number;
  minRelevance: number;
  maxTokens: number;
}

export type KnowledgeSource = "semantic" | "static" | "hybrid";

export interface ComplexityInfo {
  complexity: number;
  needsDecomposition: boolean;
  indicators: Array<{ indicator: string }>;
}

interface RecallResult {
  id: string;
  ty: string;
  proj?: string;
  score: number;
  sim: number;
  c: string;
  tg: string[];
}

interface RecallResponse {
  pri_n: number;
  pri: RecallResult[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SHARED_BRAIN_URL =
  process.env.SHARED_BRAIN_URL || "http://shared-brain-mcp:3100";
const SHARED_BRAIN_API_KEY = process.env.SHARED_BRAIN_API_KEY || "";

const REQUEST_TIMEOUT_MS = 8_000;
const SESSION_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes — re-init after this

// Rough token estimate: 4 characters ≈ 1 token
const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// Session management (singleton)
// ---------------------------------------------------------------------------

let cachedSessionId: string | null = null;
let sessionCreatedAt = 0;
let initLock: Promise<string | null> | null = null;

function isSessionExpired(): boolean {
  if (!cachedSessionId) return true;
  return Date.now() - sessionCreatedAt > SESSION_MAX_AGE_MS;
}

/**
 * Parse the first `data:` line from an SSE response body to extract JSON.
 */
function parseSSE(body: string): unknown | null {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      const json = trimmed.slice("data:".length).trim();
      if (!json || json === "[DONE]") continue;
      try {
        return JSON.parse(json);
      } catch {
        // Malformed JSON line — skip
      }
    }
  }
  return null;
}

/**
 * Initialize an MCP session with shared-brain and return the session ID.
 * Returns null on failure (network error, bad response, etc.).
 */
async function initializeSession(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (SHARED_BRAIN_API_KEY) {
      headers["Authorization"] = `Bearer ${SHARED_BRAIN_API_KEY}`;
    }

    const res = await fetch(`${SHARED_BRAIN_URL}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "openclaw-intelligence", version: "1.0" },
        },
        id: 1,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(
        `[knowledge-retrieval] MCP initialize failed: HTTP ${res.status}`,
      );
      return null;
    }

    const sessionId = res.headers.get("mcp-session-id");
    if (!sessionId) {
      console.warn(
        "[knowledge-retrieval] MCP initialize response missing mcp-session-id header",
      );
      return null;
    }

    cachedSessionId = sessionId;
    sessionCreatedAt = Date.now();
    return sessionId;
  } catch (err) {
    console.warn("[knowledge-retrieval] MCP initialize error:", err);
    return null;
  }
}

/**
 * Get a valid session ID, initializing if needed. Uses a lock to
 * prevent concurrent initialization requests.
 */
async function getSessionId(forceRefresh = false): Promise<string | null> {
  if (!forceRefresh && cachedSessionId && !isSessionExpired()) {
    return cachedSessionId;
  }

  // Prevent concurrent init attempts
  if (initLock) return initLock;

  initLock = initializeSession();
  try {
    return await initLock;
  } finally {
    initLock = null;
  }
}

// ---------------------------------------------------------------------------
// Shared-brain recall
// ---------------------------------------------------------------------------

/**
 * Call brain_recall on shared-brain MCP.
 * Returns parsed recall results or null on failure.
 */
async function recallFromBrain(
  query: string,
  limit: number,
): Promise<RecallResult[] | null> {
  const sessionId = await getSessionId();
  if (!sessionId) return null;

  const result = await doRecall(query, limit, sessionId);

  // If we got a session-related error, retry with a fresh session
  if (result === "SESSION_EXPIRED") {
    cachedSessionId = null;
    const freshSession = await getSessionId(true);
    if (!freshSession) return null;
    const retry = await doRecall(query, limit, freshSession);
    if (retry === "SESSION_EXPIRED") return null;
    return retry;
  }

  return result;
}

async function doRecall(
  query: string,
  limit: number,
  sessionId: string,
): Promise<RecallResult[] | "SESSION_EXPIRED" | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Mcp-Session-Id": sessionId,
    };
    if (SHARED_BRAIN_API_KEY) {
      headers["Authorization"] = `Bearer ${SHARED_BRAIN_API_KEY}`;
    }

    const res = await fetch(`${SHARED_BRAIN_URL}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "brain_recall",
          arguments: { query, limit },
        },
        id: 2,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      // 400/404 with session issues → session expired
      if (res.status === 400 || res.status === 404 || res.status === 409) {
        return "SESSION_EXPIRED";
      }
      console.warn(
        `[knowledge-retrieval] brain_recall failed: HTTP ${res.status}`,
      );
      return null;
    }

    const body = await res.text();
    const parsed = parseSSE(body) as {
      result?: { content?: Array<{ type: string; text: string }> };
      error?: { message: string };
    } | null;

    if (!parsed) {
      console.warn("[knowledge-retrieval] Failed to parse SSE response");
      return null;
    }

    // Check for JSON-RPC error (session expired, etc.)
    if (parsed.error) {
      const msg = parsed.error.message?.toLowerCase() || "";
      if (
        msg.includes("session") ||
        msg.includes("expired") ||
        msg.includes("invalid")
      ) {
        return "SESSION_EXPIRED";
      }
      console.warn(
        `[knowledge-retrieval] brain_recall RPC error: ${parsed.error.message}`,
      );
      return null;
    }

    const textContent = parsed.result?.content?.find(
      (c) => c.type === "text",
    );
    if (!textContent?.text) return null;

    const recallData: RecallResponse = JSON.parse(textContent.text);
    return recallData.pri || [];
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      console.warn("[knowledge-retrieval] brain_recall timed out");
    } else {
      console.warn("[knowledge-retrieval] brain_recall error:", err);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// RAG pipeline integration
// ---------------------------------------------------------------------------

/**
 * Adapter that wraps recallFromBrain as a Retriever for the AgenticRAGPipeline.
 * Converts RecallResult[] to RAGResult[].
 */
const brainRetriever: Retriever = async (
  query: string,
  limit: number,
): Promise<RAGResult[] | null> => {
  const results = await recallFromBrain(query, limit);
  if (!results) return null;
  return results.map((r) => ({
    id: r.id,
    content: r.c,
    score: r.score,
    similarity: r.sim,
    type: r.ty,
    tags: r.tg ?? [],
  }));
};

let ragPipelineInstance: AgenticRAGPipeline | null = null;

function getRAGPipeline(): AgenticRAGPipeline {
  if (!ragPipelineInstance) {
    ragPipelineInstance = new AgenticRAGPipeline(brainRetriever);
  }
  return ragPipelineInstance;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format recall results into a markdown context block for prompt injection.
 */
function formatResults(results: RecallResult[], maxChars: number): string {
  if (results.length === 0) return "";

  const parts: string[] = [
    "<context-knowledge>\n",
    "The following is retrieved background knowledge. Use it to inform your response but do NOT echo, quote, or reference this section directly. Respond naturally as if you already knew this information.\n\n",
  ];
  let totalChars = parts[0].length;

  for (const result of results) {
    const tags = result.tg?.length ? ` [${result.tg.join(", ")}]` : "";
    const typeLabel = result.ty || "knowledge";
    const header = `### ${typeLabel}${tags} (relevance: ${result.score.toFixed(2)})\n`;
    const content = `${result.c}\n\n`;
    const entryChars = header.length + content.length;

    if (totalChars + entryChars > maxChars) {
      // Try to fit a truncated version of this entry
      const remaining = maxChars - totalChars - header.length - 4; // 4 for "...\n"
      if (remaining > 50) {
        parts.push(header);
        parts.push(result.c.slice(0, remaining) + "...\n");
      }
      break;
    }

    parts.push(header);
    parts.push(content);
    totalChars += entryChars;
  }

  parts.push("</context-knowledge>");
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Maps complexity score to the number of knowledge results to retrieve.
 */
export function complexityBasedMaxResults(complexity: number): number {
  if (complexity < 0.2) return 2;
  if (complexity < 0.4) return 3;
  if (complexity < 0.7) return 5;
  return 8;
}

/**
 * Retrieve semantic knowledge relevant to a query.
 *
 * Uses agentic RAG to iteratively refine retrieval for complex queries.
 * Retrieval strategy is based on complexity:
 *   - complexity < 0.4: single-shot retrieval (fast path)
 *   - complexity >= 0.4 and !needsDecomposition: iterative retrieval
 *   - needsDecomposition: decomposed retrieval using indicator names as sub-tasks
 *
 * @param query - The user prompt / search query
 * @param options - Retrieval configuration (maxResults, minRelevance, maxTokens)
 * @param knowledgeSource - Strategy: "semantic", "static", or "hybrid"
 * @param complexityInfo - Optional complexity analysis to guide retrieval strategy
 * @returns Markdown context string or null if nothing relevant found
 */
export async function getSemanticKnowledge(
  query: string,
  options: KnowledgeRetrievalOptions,
  knowledgeSource: KnowledgeSource = "hybrid",
  complexityInfo?: ComplexityInfo,
): Promise<string | null> {
  const maxChars = options.maxTokens * CHARS_PER_TOKEN;

  // Static-only path
  if (knowledgeSource === "static") {
    return staticFallback(query, maxChars);
  }

  // Semantic or hybrid — choose retrieval strategy based on complexity
  let results: RecallResult[] | null = null;

  const complexity = complexityInfo?.complexity ?? 0;
  const needsDecomposition = complexityInfo?.needsDecomposition ?? false;

  if (complexity >= 0.4 && needsDecomposition && complexityInfo?.indicators?.length) {
    // Decomposed retrieval: run targeted queries per sub-task
    const rag = getRAGPipeline();
    const subTasks = complexityInfo.indicators.map((i) => i.indicator);
    const ragResults = await rag.decomposedRetrieve(subTasks, {
      maxResults: options.maxResults,
      minRelevance: options.minRelevance,
      maxTokens: options.maxTokens,
    });
    results = ragResultsToRecall(ragResults);
  } else if (complexity >= 0.4) {
    // Iterative retrieval: refine query across multiple passes
    const rag = getRAGPipeline();
    const ragResults = await rag.iterativeRetrieve(query, {
      maxResults: options.maxResults,
      minRelevance: options.minRelevance,
      maxTokens: options.maxTokens,
    });
    results = ragResultsToRecall(ragResults);
  } else {
    // Simple single-shot retrieval (current behavior)
    results = await recallFromBrain(query, options.maxResults);
  }

  if (results && results.length > 0) {
    // Filter by minimum relevance
    const filtered = results.filter((r) => r.score >= options.minRelevance);

    // Limit to maxResults (brain may return more than requested)
    const limited = filtered.slice(0, options.maxResults);

    if (limited.length > 0) {
      const formatted = formatResults(limited, maxChars);
      return formatted || null;
    }
  }

  // Semantic-only: no fallback, return null
  if (knowledgeSource === "semantic") {
    return null;
  }

  // Hybrid: fall back to static domain knowledge
  return staticFallback(query, maxChars);
}

/**
 * Convert RAGResult[] back to RecallResult[] for the existing formatting pipeline.
 */
function ragResultsToRecall(ragResults: RAGResult[]): RecallResult[] {
  return ragResults.map((r) => ({
    id: r.id,
    ty: r.type,
    score: r.score,
    sim: r.similarity,
    c: r.content,
    tg: r.tags,
  }));
}

/**
 * Static fallback using domain-knowledge.ts trigger-based matching.
 */
function staticFallback(query: string, maxChars: number): string | null {
  try {
    const context = buildKnowledgeContext(query);
    if (!context) return null;
    if (context.length > maxChars) {
      return context.slice(0, maxChars - 3) + "...";
    }
    return context;
  } catch (err) {
    console.warn("[knowledge-retrieval] Static fallback error:", err);
    return null;
  }
}
