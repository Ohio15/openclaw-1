import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock dependencies before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("./domain-knowledge.js", () => ({
  buildKnowledgeContext: vi.fn(),
}));

vi.mock("./agentic-rag.js", () => ({
  AgenticRAGPipeline: vi.fn().mockImplementation(() => ({
    iterativeRetrieve: vi.fn().mockResolvedValue([]),
    decomposedRetrieve: vi.fn().mockResolvedValue([]),
  })),
}));

// Stub fetch once at top level so it exists when the module loads.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Dynamic imports after mocks are registered
const { complexityBasedMaxResults, getSemanticKnowledge, parseMcpResponseBody } =
  await import("./knowledge-retrieval.js");
const { buildKnowledgeContext } = await import("./domain-knowledge.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultOptions = { maxResults: 5, minRelevance: 0.4, maxTokens: 2000 };

function makeRecallResult(
  overrides: Partial<{
    id: string;
    ty: string;
    score: number;
    sim: number;
    c: string;
    tg: string[];
  }> = {},
) {
  return {
    id: overrides.id ?? "mem-1",
    ty: overrides.ty ?? "knowledge",
    score: overrides.score ?? 0.85,
    sim: overrides.sim ?? 0.9,
    c: overrides.c ?? "JWT uses HS256 for signing",
    tg: overrides.tg ?? ["auth", "jwt"],
  };
}

/**
 * SSE body in the exact framing shared-brain (MCP SDK StreamableHTTPServerTransport,
 * server 7.72.0) returns, captured 2026-10-10 with content redacted:
 *   event: message

 *   data: {"jsonrpc":"2.0","id":<request id>,"result":{...}}

 *   

 */
function sseEvent(message: unknown): string {
  return `event: message
data: ${JSON.stringify(message)}

`;
}

/** Build the SSE body for a brain_recall response to request `id`. */
function makeBrainRecallSSE(results: ReturnType<typeof makeRecallResult>[], id: number): string {
  return sseEvent({
    jsonrpc: "2.0",
    id,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({ pri_n: results.length, pri: results }),
        },
      ],
    },
  });
}

const SSE_HEADERS = { "content-type": "text/event-stream" };

function initResponse(id: number, sessionId: string): Response {
  return new Response(
    sseEvent({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "shared-brain", version: "7.72.0" },
      },
    }),
    { status: 200, headers: { ...SSE_HEADERS, "mcp-session-id": sessionId } },
  );
}

/** notifications/initialized is acknowledged with 202 and no body. */
function acceptedResponse(): Response {
  return new Response(null, { status: 202 });
}

/**
 * Set up mockFetch to respond intelligently based on request body content.
 * Handles both init and recall requests regardless of session cache state.
 *
 * @param recallResults - Results to return for brain_recall calls
 * @param initStatus - HTTP status for the init response (default 200)
 * @param recallStatus - HTTP status for the recall response (default 200)
 */
function setupSmartFetch(
  recallResults: ReturnType<typeof makeRecallResult>[],
  opts?: {
    initStatus?: number;
    recallStatus?: number;
    sessionId?: string;
  },
) {
  const initStatus = opts?.initStatus ?? 200;
  const recallStatus = opts?.recallStatus ?? 200;
  const sessionId = opts?.sessionId ?? "test-session-123";

  mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);

    if (body.method === "initialize") {
      if (initStatus !== 200) {
        return new Response("Error", { status: initStatus });
      }
      return initResponse(body.id, sessionId);
    }

    if (body.method === "notifications/initialized") {
      return acceptedResponse();
    }

    if (body.method === "tools/call" && body.params?.name === "brain_recall") {
      if (recallStatus !== 200) {
        return new Response("Error", { status: recallStatus });
      }
      return new Response(makeBrainRecallSSE(recallResults, body.id), {
        status: 200,
        headers: { ...SSE_HEADERS, "mcp-session-id": sessionId },
      });
    }

    return new Response("Not Found", { status: 404 });
  });
}

// ---------------------------------------------------------------------------
// Reset state between tests.
//
// The module has singleton state (cachedSessionId, sessionCreatedAt).
// We use fake timers to force session expiry (> 10 min) so every test
// goes through a fresh init cycle. Fake timers stay active during the test.
// ---------------------------------------------------------------------------

// Track time offset to ensure each test starts with an expired session relative
// to any previous test's sessionCreatedAt.
let timeOffset = 0;

beforeEach(() => {
  vi.resetAllMocks();
  // Re-stub fetch since unstubGlobals:true clears it after each test
  vi.stubGlobal("fetch", mockFetch);

  // Jump forward by 12 minutes from the last offset. This ensures the
  // module's isSessionExpired() returns true regardless of when the
  // previous test set sessionCreatedAt.
  timeOffset += 12 * 60 * 1000;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(Date.UTC(2026, 3, 5) + timeOffset));
});

// ===========================================================================
// complexityBasedMaxResults — pure function tests
// ===========================================================================

describe("complexityBasedMaxResults", () => {
  it("returns 2 when complexity is below 0.2", () => {
    expect(complexityBasedMaxResults(0.0)).toBe(2);
    expect(complexityBasedMaxResults(0.1)).toBe(2);
    expect(complexityBasedMaxResults(0.19)).toBe(2);
  });

  it("returns 3 when complexity is 0.2 to 0.39", () => {
    expect(complexityBasedMaxResults(0.2)).toBe(3);
    expect(complexityBasedMaxResults(0.3)).toBe(3);
    expect(complexityBasedMaxResults(0.39)).toBe(3);
  });

  it("returns 5 when complexity is 0.4 to 0.69", () => {
    expect(complexityBasedMaxResults(0.4)).toBe(5);
    expect(complexityBasedMaxResults(0.5)).toBe(5);
    expect(complexityBasedMaxResults(0.69)).toBe(5);
  });

  it("returns 8 when complexity is 0.7 or above", () => {
    expect(complexityBasedMaxResults(0.7)).toBe(8);
    expect(complexityBasedMaxResults(0.85)).toBe(8);
    expect(complexityBasedMaxResults(1.0)).toBe(8);
  });

  it("handles boundary at exactly 0.2", () => {
    expect(complexityBasedMaxResults(0.2)).toBe(3);
  });

  it("handles boundary at exactly 0.4", () => {
    expect(complexityBasedMaxResults(0.4)).toBe(5);
  });

  it("handles boundary at exactly 0.7", () => {
    expect(complexityBasedMaxResults(0.7)).toBe(8);
  });
});

// ===========================================================================
// getSemanticKnowledge — static source
// ===========================================================================

describe("getSemanticKnowledge — static source", () => {
  it("returns result from buildKnowledgeContext for static source", async () => {
    const staticContent = "Static knowledge about authentication patterns.";
    vi.mocked(buildKnowledgeContext).mockReturnValue(staticContent);

    const result = await getSemanticKnowledge("how does auth work", defaultOptions, "static");

    expect(buildKnowledgeContext).toHaveBeenCalledWith("how does auth work");
    expect(result).toBe(staticContent);
  });

  it("returns null when buildKnowledgeContext returns null", async () => {
    vi.mocked(buildKnowledgeContext).mockReturnValue(null);

    const result = await getSemanticKnowledge("unknown topic", defaultOptions, "static");

    expect(result).toBeNull();
  });

  it("truncates static result when exceeding maxTokens * 4 chars", async () => {
    const tinyOptions = { maxResults: 5, minRelevance: 0.4, maxTokens: 10 };
    // maxChars = 10 * 4 = 40
    const longContent = "A".repeat(100);
    vi.mocked(buildKnowledgeContext).mockReturnValue(longContent);

    const result = await getSemanticKnowledge("some query", tinyOptions, "static");

    expect(result).not.toBeNull();
    // Truncated to maxChars: 40 chars total (37 A's + "...")
    expect(result!.length).toBe(40);
    expect(result!.endsWith("...")).toBe(true);
  });
});

// ===========================================================================
// getSemanticKnowledge — semantic source
// ===========================================================================

describe("getSemanticKnowledge — semantic source", () => {
  it("returns formatted context when fetch succeeds with results", async () => {
    setupSmartFetch([makeRecallResult()]);

    const result = await getSemanticKnowledge("JWT signing algorithm", defaultOptions, "semantic");

    expect(result).not.toBeNull();
    expect(result).toContain("<context-knowledge>");
    expect(result).toContain("</context-knowledge>");
    expect(result).toContain("JWT uses HS256 for signing");
    expect(result).toContain("0.85");
  });

  it("returns null when MCP session init fails with HTTP 500", async () => {
    setupSmartFetch([], { initStatus: 500 });

    const result = await getSemanticKnowledge("some query", defaultOptions, "semantic");

    expect(result).toBeNull();
  });

  it("filters results below minRelevance", async () => {
    setupSmartFetch([
      makeRecallResult({
        id: "high",
        score: 0.9,
        c: "High relevance content",
      }),
      makeRecallResult({
        id: "low",
        score: 0.1,
        c: "Low relevance content",
      }),
    ]);

    const result = await getSemanticKnowledge(
      "test query",
      { maxResults: 5, minRelevance: 0.4, maxTokens: 2000 },
      "semantic",
    );

    expect(result).not.toBeNull();
    expect(result).toContain("High relevance content");
    expect(result).not.toContain("Low relevance content");
  });

  it("limits results to maxResults", async () => {
    setupSmartFetch([
      makeRecallResult({ id: "r1", score: 0.9, c: "Result one" }),
      makeRecallResult({ id: "r2", score: 0.8, c: "Result two" }),
      makeRecallResult({ id: "r3", score: 0.7, c: "Result three" }),
    ]);

    const result = await getSemanticKnowledge(
      "test query",
      { maxResults: 2, minRelevance: 0.4, maxTokens: 2000 },
      "semantic",
    );

    expect(result).not.toBeNull();
    expect(result).toContain("Result one");
    expect(result).toContain("Result two");
    expect(result).not.toContain("Result three");
  });

  it("returns null when fetch times out with AbortError", async () => {
    mockFetch.mockImplementation(() => {
      const err = new DOMException("The operation was aborted.", "AbortError");
      return Promise.reject(err);
    });

    const result = await getSemanticKnowledge("slow query", defaultOptions, "semantic");

    expect(result).toBeNull();
  });
});

// ===========================================================================
// getSemanticKnowledge — hybrid source
// ===========================================================================

describe("getSemanticKnowledge — hybrid source", () => {
  it("returns semantic results when available", async () => {
    setupSmartFetch([makeRecallResult({ c: "Semantic hybrid result" })]);

    const result = await getSemanticKnowledge("hybrid query", defaultOptions, "hybrid");

    expect(result).not.toBeNull();
    expect(result).toContain("Semantic hybrid result");
    expect(buildKnowledgeContext).not.toHaveBeenCalled();
  });

  it("falls back to static when semantic fails", async () => {
    setupSmartFetch([], { initStatus: 503 });
    vi.mocked(buildKnowledgeContext).mockReturnValue("Fallback static knowledge about auth.");

    const result = await getSemanticKnowledge("auth patterns", defaultOptions, "hybrid");

    expect(result).toBe("Fallback static knowledge about auth.");
    expect(buildKnowledgeContext).toHaveBeenCalledWith("auth patterns");
  });

  it("uses single-shot retrieval for complexity below 0.4", async () => {
    setupSmartFetch([makeRecallResult({ c: "Simple retrieval result" })]);

    const lowComplexity = {
      complexity: 0.2,
      needsDecomposition: false,
      indicators: [],
    };

    const result = await getSemanticKnowledge(
      "simple question",
      defaultOptions,
      "hybrid",
      lowComplexity,
    );

    expect(result).not.toBeNull();
    expect(result).toContain("Simple retrieval result");
    // Single-shot: init + initialized notification + recall = 3 fetch calls
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

// ===========================================================================
// Session management — verified via fetch call patterns
// ===========================================================================

describe("session management", () => {
  it("first call initializes, confirms, then recalls (3 fetch calls)", async () => {
    setupSmartFetch([makeRecallResult()]);

    await getSemanticKnowledge("test query", defaultOptions, "semantic");

    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Verify the first call is the initialize request
    const initBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(initBody.method).toBe("initialize");

    // Lifecycle: the initialized notification carries the new session and no id
    const ackBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(ackBody.method).toBe("notifications/initialized");
    expect(ackBody.id).toBeUndefined();
    expect(mockFetch.mock.calls[1][1].headers["Mcp-Session-Id"]).toBe("test-session-123");

    // Verify the third call is the brain_recall request
    const recallBody = JSON.parse(mockFetch.mock.calls[2][1].body);
    expect(recallBody.method).toBe("tools/call");
    expect(recallBody.params.name).toBe("brain_recall");
  });

  it("retries with fresh session when recall returns 409 (session expired)", async () => {
    // Track call count to return 409 on the first recall, then 200 on retry
    let recallCallCount = 0;
    mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);

      if (body.method === "initialize") {
        return initResponse(body.id, `session-${++recallCallCount}`);
      }

      if (body.method === "notifications/initialized") {
        return acceptedResponse();
      }

      if (body.method === "tools/call" && body.params?.name === "brain_recall") {
        recallCallCount++;
        if (recallCallCount <= 2) {
          // First recall attempt: return 409 to simulate session expired
          return new Response("Conflict", { status: 409 });
        }
        // Retry recall: return valid results
        return new Response(
          makeBrainRecallSSE([makeRecallResult({ c: "Retried result" })], body.id),
          {
            status: 200,
            headers: { ...SSE_HEADERS, "mcp-session-id": "session-fresh" },
          },
        );
      }

      return new Response("Not Found", { status: 404 });
    });

    const result = await getSemanticKnowledge("retry query", defaultOptions, "semantic");

    expect(result).not.toBeNull();
    expect(result).toContain("Retried result");
    // 6 calls: (init + ack) + failed recall + (re-init + ack) + successful recall
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });
});

// ===========================================================================
// Streamable HTTP transport: regressions for the 2026-10-09 production
// failure ("Failed to parse SSE response" on every agent turn)
// ===========================================================================

describe("MCP transport", () => {
  it("sends the Streamable HTTP Accept header on every request", async () => {
    setupSmartFetch([makeRecallResult()]);

    await getSemanticKnowledge("accept header", defaultOptions, "semantic");

    for (const call of mockFetch.mock.calls) {
      expect(call[1].headers.Accept).toBe("application/json, text/event-stream");
    }
  });

  it("gives concurrent recalls on one session distinct JSON-RPC ids", async () => {
    // Emulates the MCP SDK server: responses are routed by JSON-RPC id, so a
    // later in-flight request with the same id steals the stream mapping and
    // the earlier streams never receive a response. When the server reaps the
    // idle session it closes them with only keepalive comments, the body
    // shape captured in production, which the old parser rejected.
    const inFlight = new Map<number, Array<(res: Response) => void>>();
    let pending = 0;
    const CONCURRENT = 3;
    const release = () => {
      for (const [id, waiters] of inFlight) {
        const winner = waiters[waiters.length - 1];
        for (const waiter of waiters) {
          waiter(
            new Response(
              waiter === winner
                ? makeBrainRecallSSE([makeRecallResult({ c: `answer for ${id}` })], id)
                : ": keepalive\n\n: keepalive\n\n",
              { status: 200, headers: SSE_HEADERS },
            ),
          );
        }
      }
    };

    mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.method === "initialize") return initResponse(body.id, "shared-session");
      if (body.method === "notifications/initialized") return acceptedResponse();
      return new Promise<Response>((resolve) => {
        const waiters = inFlight.get(body.id) ?? [];
        waiters.push(resolve);
        inFlight.set(body.id, waiters);
        if (++pending === CONCURRENT) release();
      });
    });

    const results = await Promise.all(
      ["first", "second", "third"].map((q) => getSemanticKnowledge(q, defaultOptions, "semantic")),
    );

    // One session, three recalls, three distinct ids, three answers.
    const bodies = mockFetch.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(bodies.filter((body) => body.method === "initialize")).toHaveLength(1);
    const recallIds = bodies.filter((body) => body.method === "tools/call").map((body) => body.id);
    expect(recallIds).toHaveLength(3);
    expect(new Set(recallIds).size).toBe(3);
    for (const result of results) {
      expect(result).toContain("answer for");
    }
  });

  it("returns null without throwing for an orphaned stream (keepalives only)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.method === "initialize") return initResponse(body.id, "s-orphan");
      if (body.method === "notifications/initialized") return acceptedResponse();
      return new Response(": keepalive\n\n", { status: 200, headers: SSE_HEADERS });
    });

    const result = await getSemanticKnowledge("orphan", defaultOptions, "semantic");

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("brain_recall returned no JSON-RPC response"),
    );
    warn.mockRestore();
  });

  it("rejects a response addressed to a different request id", async () => {
    mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.method === "initialize") return initResponse(body.id, "s-crossed");
      if (body.method === "notifications/initialized") return acceptedResponse();
      // Another request's answer delivered on this stream (cross-wired routing)
      return new Response(makeBrainRecallSSE([makeRecallResult()], body.id + 1000), {
        status: 200,
        headers: SSE_HEADERS,
      });
    });

    const result = await getSemanticKnowledge("crossed", defaultOptions, "semantic");

    expect(result).toBeNull();
  });

  it("bounds the body read by the request deadline", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.method === "initialize") return initResponse(body.id, "s-hung");
      if (body.method === "notifications/initialized") return acceptedResponse();
      // Headers arrive at once; the body never completes (as an orphaned
      // stream behaves for up to the server's 4h session TTL). Like undici,
      // aborting the request signal errors the body stream.
      const signal = init.signal!;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(signal.reason));
        },
      });
      return new Response(stream, { status: 200, headers: SSE_HEADERS });
    });

    const pendingResult = getSemanticKnowledge("hung", defaultOptions, "semantic");
    await vi.advanceTimersByTimeAsync(8_001);
    const result = await pendingResult;

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith("[knowledge-retrieval] brain_recall timed out");
    warn.mockRestore();
  });

  it("parses a plain JSON response when the server chooses JSON mode", async () => {
    mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "s-json" },
        });
      }
      if (body.method === "notifications/initialized") return acceptedResponse();
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ pri_n: 1, pri: [makeRecallResult({ c: "json mode" })] }),
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await getSemanticKnowledge("json", defaultOptions, "semantic");

    expect(result).toContain("json mode");
  });

  it("does not cache a session whose initialized notification is rejected", async () => {
    mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.method === "initialize") return initResponse(body.id, "s-unacked");
      if (body.method === "notifications/initialized") {
        return new Response("Bad Request", { status: 400 });
      }
      return new Response(makeBrainRecallSSE([makeRecallResult()], body.id), {
        status: 200,
        headers: SSE_HEADERS,
      });
    });

    const result = await getSemanticKnowledge("unacked", defaultOptions, "semantic");

    expect(result).toBeNull();
    const methods = mockFetch.mock.calls.map((call) => JSON.parse(call[1].body).method);
    expect(methods).not.toContain("tools/call");
  });
});

describe("parseMcpResponseBody", () => {
  const response = { jsonrpc: "2.0", id: 7, result: { ok: true } };

  it("extracts the response from the captured SSE framing", () => {
    expect(parseMcpResponseBody("text/event-stream", sseEvent(response), 7)).toEqual(response);
  });

  it("skips notifications and comments that precede the response", () => {
    const body =
      ": keepalive\n\n" +
      sseEvent({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } }) +
      sseEvent(response);
    expect(parseMcpResponseBody("text/event-stream", body, 7)).toEqual(response);
  });

  it("joins multi-line data fields and accepts CRLF line endings", () => {
    const json = JSON.stringify(response, null, 2);
    const body =
      "event: message\r\n" +
      json
        .split("\n")
        .map((line) => `data: ${line}`)
        .join("\r\n") +
      "\r\n\r\n";
    expect(parseMcpResponseBody("text/event-stream; charset=utf-8", body, 7)).toEqual(response);
  });

  it("accepts a final event without a trailing blank line", () => {
    const body = `event: message\ndata: ${JSON.stringify(response)}`;
    expect(parseMcpResponseBody("text/event-stream", body, 7)).toEqual(response);
  });

  it("returns null for a stream carrying only keepalive comments", () => {
    expect(
      parseMcpResponseBody("text/event-stream", ": keepalive\n\n: keepalive\n\n", 7),
    ).toBeNull();
  });

  it("returns null when the only response is for another request id", () => {
    expect(
      parseMcpResponseBody("text/event-stream", sseEvent({ ...response, id: 8 }), 7),
    ).toBeNull();
  });

  it("accepts an unattributed (id null) error as the answer", () => {
    const error = {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Bad Request: Server not initialized" },
    };
    expect(parseMcpResponseBody("application/json", JSON.stringify(error), 7)).toEqual(error);
  });

  it("finds the matching entry in a JSON batch response", () => {
    const batch = [{ ...response, id: 6 }, response];
    expect(parseMcpResponseBody("application/json", JSON.stringify(batch), 7)).toEqual(response);
  });

  it("falls back to SSE framing when the content-type is missing", () => {
    expect(parseMcpResponseBody("", sseEvent(response), 7)).toEqual(response);
  });
});
