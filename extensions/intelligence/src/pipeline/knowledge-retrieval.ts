/**
 * Knowledge Retrieval — Semantic search via shared-brain MCP
 *
 * Provides semantic knowledge retrieval for the intelligence pipeline.
 * Uses shared-brain MCP over Streamable HTTP (JSON or SSE responses) as the primary
 * knowledge source, falling back to static domain-knowledge when unavailable.
 *
 * @module knowledge-retrieval
 */

import { AgenticRAGPipeline, type RAGResult, type Retriever } from "./agentic-rag.js";
import { buildKnowledgeContext } from "./domain-knowledge.js";

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

const SHARED_BRAIN_URL = process.env.SHARED_BRAIN_URL || "http://shared-brain-mcp:3100";
const SHARED_BRAIN_API_KEY = process.env.SHARED_BRAIN_API_KEY || "";

const REQUEST_TIMEOUT_MS = 8_000;
const SESSION_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes — re-init after this

// Rough token estimate: 4 characters ≈ 1 token
const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// MCP Streamable HTTP transport
// ---------------------------------------------------------------------------

/**
 * Streamable HTTP clients MUST accept both response modes; the server picks
 * one per request (single JSON body or an SSE stream).
 */
const MCP_ACCEPT = "application/json, text/event-stream";

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * JSON-RPC request ids MUST be unique within an MCP session. The server
 * routes each response to the HTTP stream registered under the request id, so
 * two concurrent requests sharing an id (as the decomposed RAG path issues)
 * cross-wire: one stream receives the other's result and the rest are
 * orphaned until the server reaps the session. A process-wide counter keeps
 * every id unique across sessions too.
 */
let nextRequestId = 1;

function allocateRequestId(): number {
  const id = nextRequestId;
  nextRequestId = nextRequestId >= Number.MAX_SAFE_INTEGER ? 1 : nextRequestId + 1;
  return id;
}

function isMatchingResponse(
  candidate: unknown,
  expectedId: string | number,
): candidate is JsonRpcResponse {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const msg = candidate as JsonRpcResponse;
  const isResponse = "result" in msg || "error" in msg;
  if (!isResponse) return false; // request or notification, not our reply
  if (msg.id === expectedId) return true;
  // Errors the server cannot attribute to a request (parse / session errors)
  // carry id null; they still answer this exchange.
  return msg.id === null && msg.error !== undefined;
}

function findInJson(value: unknown, expectedId: string | number): JsonRpcResponse | null {
  const candidates = Array.isArray(value) ? value : [value];
  for (const candidate of candidates) {
    if (isMatchingResponse(candidate, expectedId)) return candidate;
  }
  return null;
}

/**
 * Walk an SSE body per the WHATWG event-stream rules: events end at a blank
 * line, multiple `data:` lines join with "\n", one optional space after the
 * colon is stripped, and comment lines (`: keepalive`) are ignored. Returns
 * the JSON-RPC response for `expectedId`, skipping any server notifications
 * or requests interleaved on the same stream.
 */
function findInEventStream(body: string, expectedId: string | number): JsonRpcResponse | null {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let dataLines: string[] = [];

  const dispatch = (): JsonRpcResponse | null => {
    if (dataLines.length === 0) return null;
    const payload = dataLines.join("\n");
    dataLines = [];
    try {
      return findInJson(JSON.parse(payload), expectedId);
    } catch {
      return null;
    }
  };

  for (const line of lines) {
    if (line === "") {
      const match = dispatch();
      if (match) return match;
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") continue;
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    dataLines.push(value);
  }
  // A stream closed without a trailing blank line still carries its last event.
  return dispatch();
}

/**
 * Extract the JSON-RPC response for `expectedId` from a Streamable HTTP
 * response body, whichever mode the server chose.
 */
export function parseMcpResponseBody(
  contentType: string,
  body: string,
  expectedId: string | number,
): JsonRpcResponse | null {
  if (contentType.toLowerCase().includes("text/event-stream")) {
    return findInEventStream(body, expectedId);
  }
  try {
    return findInJson(JSON.parse(body), expectedId);
  } catch {
    // Content-Type missing or wrong: fall back to the event-stream framing.
    return findInEventStream(body, expectedId);
  }
}

type McpExchange =
  | { kind: "response"; headers: Headers; message: JsonRpcResponse }
  | { kind: "accepted"; headers: Headers }
  | { kind: "http-error"; status: number }
  | { kind: "unparseable"; status: number; contentType: string; bodyLength: number };

/**
 * POST one JSON-RPC message to the MCP endpoint and read the reply.
 *
 * The deadline covers the whole exchange including the body read. The
 * server sends 200 + SSE headers before the tool runs, so a deadline that
 * stops at the headers leaves `res.text()` unbounded: a stream that never
 * receives its response then blocks the caller until the server closes it.
 */
async function postMcp(
  message: { method: string; params?: unknown; id?: number },
  sessionId: string | null,
): Promise<McpExchange> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: MCP_ACCEPT,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (SHARED_BRAIN_API_KEY) {
    headers["Authorization"] = `Bearer ${SHARED_BRAIN_API_KEY}`;
  }

  try {
    const res = await fetch(`${SHARED_BRAIN_URL}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
      signal: controller.signal,
    });

    // Always consume the body so the pooled connection is released.
    const body = await res.text();

    if (!res.ok) return { kind: "http-error", status: res.status };

    if (message.id === undefined) {
      // Notifications get 202 Accepted with no body.
      return { kind: "accepted", headers: res.headers };
    }

    const contentType = res.headers.get("content-type") ?? "";
    const parsed = parseMcpResponseBody(contentType, body, message.id);
    if (!parsed) {
      return {
        kind: "unparseable",
        status: res.status,
        contentType,
        bodyLength: body.length,
      };
    }
    return { kind: "response", headers: res.headers, message: parsed };
  } finally {
    clearTimeout(timeout);
  }
}

function describeUnparseable(exchange: Extract<McpExchange, { kind: "unparseable" }>): string {
  return (
    `HTTP ${exchange.status}, content-type "${exchange.contentType || "none"}", ` +
    `${exchange.bodyLength} bytes`
  );
}

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
 * Initialize an MCP session with shared-brain and return the session ID.
 * Returns null on failure (network error, bad response, etc.).
 */
async function initializeSession(): Promise<string | null> {
  try {
    const init = await postMcp(
      {
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "openclaw-intelligence", version: "1.0" },
        },
        id: allocateRequestId(),
      },
      null,
    );

    if (init.kind === "http-error") {
      console.warn(`[knowledge-retrieval] MCP initialize failed: HTTP ${init.status}`);
      return null;
    }
    if (init.kind === "unparseable") {
      console.warn(
        `[knowledge-retrieval] MCP initialize returned no JSON-RPC response (${describeUnparseable(init)})`,
      );
      return null;
    }
    if (init.kind !== "response") return null;
    if (init.message.error) {
      console.warn(
        `[knowledge-retrieval] MCP initialize RPC error: ${init.message.error.message ?? "unknown"}`,
      );
      return null;
    }

    const sessionId = init.headers.get("mcp-session-id");
    if (!sessionId) {
      console.warn("[knowledge-retrieval] MCP initialize response missing mcp-session-id header");
      return null;
    }

    // Lifecycle: the client MUST confirm initialization before normal operation.
    const ack = await postMcp({ method: "notifications/initialized" }, sessionId);
    if (ack.kind === "http-error") {
      console.warn(`[knowledge-retrieval] MCP initialized notification failed: HTTP ${ack.status}`);
      return null;
    }

    cachedSessionId = sessionId;
    sessionCreatedAt = Date.now();
    return sessionId;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      console.warn("[knowledge-retrieval] MCP initialize timed out");
    } else {
      console.warn("[knowledge-retrieval] MCP initialize error:", err);
    }
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
async function recallFromBrain(query: string, limit: number): Promise<RecallResult[] | null> {
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
    const exchange = await postMcp(
      {
        method: "tools/call",
        params: {
          name: "brain_recall",
          arguments: { query, limit },
        },
        id: allocateRequestId(),
      },
      sessionId,
    );

    if (exchange.kind === "http-error") {
      // 400/404/409 → the server no longer knows this session
      if (exchange.status === 400 || exchange.status === 404 || exchange.status === 409) {
        return "SESSION_EXPIRED";
      }
      console.warn(`[knowledge-retrieval] brain_recall failed: HTTP ${exchange.status}`);
      return null;
    }

    if (exchange.kind === "unparseable") {
      console.warn(
        `[knowledge-retrieval] brain_recall returned no JSON-RPC response for its request (${describeUnparseable(exchange)})`,
      );
      return null;
    }

    if (exchange.kind !== "response") return null;
    const parsed = exchange.message as {
      result?: { content?: Array<{ type: string; text: string }> };
      error?: { message?: string };
    };

    // Check for JSON-RPC error (session expired, etc.)
    if (parsed.error) {
      const msg = parsed.error.message?.toLowerCase() || "";
      if (msg.includes("session") || msg.includes("expired") || msg.includes("invalid")) {
        return "SESSION_EXPIRED";
      }
      console.warn(`[knowledge-retrieval] brain_recall RPC error: ${parsed.error.message}`);
      return null;
    }

    const textContent = parsed.result?.content?.find((c) => c.type === "text");
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
