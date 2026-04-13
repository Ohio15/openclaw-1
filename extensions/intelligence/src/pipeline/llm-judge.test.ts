import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import {
  buildJudgePrompt,
  parseJudgeResponse,
  evaluateWithLLMJudge,
  type LLMJudgeParams,
} from "./llm-judge.js";
import { assessQuality, assessQualityWithJudge } from "./quality-gate.js";
import type { QualityGateResult } from "./quality-gate.js";
import type { LLMJudgeConfig } from "./llm-judge.js";

// ============================================================================
// In-process Ollama mock server
// ============================================================================

let server: Server;
let baseUrl: string;

/**
 * What the fake Ollama server should return next.
 * Tests set this before each call to control behavior.
 */
let nextResponse: {
  status?: number;
  body?: unknown;
  delay?: number;
} = {};

function resetServer(): void {
  nextResponse = {};
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const status = nextResponse.status ?? 200;
      const responseBody = nextResponse.body ?? { response: "" };
      const delay = nextResponse.delay ?? 0;

      const send = () => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
      };

      if (delay > 0) {
        setTimeout(send, delay);
      } else {
        send();
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

// ============================================================================
// Helpers
// ============================================================================

function makeHeuristicResult(
  overrides: Partial<QualityGateResult> = {},
): QualityGateResult {
  return {
    verdict: overrides.verdict ?? "flag",
    issues: overrides.issues ?? [],
    score: overrides.score ?? 0.6,
  };
}

function makeJudgeParams(
  overrides: Partial<LLMJudgeParams> = {},
): LLMJudgeParams {
  return {
    userPrompt: overrides.userPrompt ?? "Write a function to sort an array",
    assistantResponse: overrides.assistantResponse ?? "Here is a sort function...",
    heuristicResult: overrides.heuristicResult ?? makeHeuristicResult(),
    ollamaBaseUrl: overrides.ollamaBaseUrl ?? baseUrl,
    model: overrides.model ?? "test-model",
    timeoutMs: overrides.timeoutMs ?? 5000,
  };
}

function makeJudgeConfig(
  overrides: Partial<LLMJudgeConfig> = {},
): LLMJudgeConfig {
  return {
    enabled: overrides.enabled ?? true,
    ollamaBaseUrl: overrides.ollamaBaseUrl ?? baseUrl,
    model: overrides.model ?? "test-model",
    timeoutMs: overrides.timeoutMs ?? 5000,
    minHeuristicScoreForJudge: overrides.minHeuristicScoreForJudge ?? 0.8,
  };
}

// ============================================================================
// Tests: buildJudgePrompt
// ============================================================================

describe("buildJudgePrompt", () => {
  it("includes user request and assistant response in structured format", () => {
    const prompt = buildJudgePrompt("How do I sort?", "Use Array.sort()");
    expect(prompt).toContain("<user_request>");
    expect(prompt).toContain("How do I sort?");
    expect(prompt).toContain("</user_request>");
    expect(prompt).toContain("<assistant_response>");
    expect(prompt).toContain("Use Array.sort()");
    expect(prompt).toContain("</assistant_response>");
  });

  it("includes all four evaluation criteria", () => {
    const prompt = buildJudgePrompt("test", "test");
    expect(prompt).toContain("COMPLETENESS");
    expect(prompt).toContain("CORRECTNESS");
    expect(prompt).toContain("DEPTH");
    expect(prompt).toContain("IMPLEMENTATION");
  });

  it("includes expected response format instructions", () => {
    const prompt = buildJudgePrompt("test", "test");
    expect(prompt).toContain("VERDICT: [pass|flag|retry]");
    expect(prompt).toContain("CONFIDENCE: [0.0-1.0]");
    expect(prompt).toContain("REASONING: [one sentence explanation]");
  });

  it("truncates long user prompts", () => {
    const longPrompt = "x".repeat(3000);
    const prompt = buildJudgePrompt(longPrompt, "short response");
    expect(prompt).toContain("[... truncated]");
    // Should not contain the full 3000 characters
    expect(prompt.length).toBeLessThan(longPrompt.length + 2000);
  });

  it("truncates long assistant responses", () => {
    const longResponse = "y".repeat(5000);
    const prompt = buildJudgePrompt("short prompt", longResponse);
    expect(prompt).toContain("[... truncated]");
  });

  it("handles special characters in user content without breaking format", () => {
    const prompt = buildJudgePrompt(
      'User says "hello" & <script>alert(1)</script>',
      "Response with `backticks` and $variables",
    );
    expect(prompt).toContain("<script>alert(1)</script>");
    expect(prompt).toContain("`backticks`");
  });
});

// ============================================================================
// Tests: parseJudgeResponse
// ============================================================================

describe("parseJudgeResponse", () => {
  it("parses a well-formed response", () => {
    const result = parseJudgeResponse(
      "VERDICT: pass\nCONFIDENCE: 0.92\nREASONING: The response fully addresses the request with correct code.",
    );
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("pass");
    expect(result!.confidence).toBe(0.92);
    expect(result!.reasoning).toBe(
      "The response fully addresses the request with correct code.",
    );
  });

  it("parses a retry verdict", () => {
    const result = parseJudgeResponse(
      "VERDICT: retry\nCONFIDENCE: 0.85\nREASONING: Response contains only stubs.",
    );
    expect(result!.verdict).toBe("retry");
  });

  it("parses a flag verdict", () => {
    const result = parseJudgeResponse(
      "VERDICT: flag\nCONFIDENCE: 0.6\nREASONING: Partially complete.",
    );
    expect(result!.verdict).toBe("flag");
  });

  it("handles case-insensitive verdicts", () => {
    const result = parseJudgeResponse(
      "VERDICT: Pass\nCONFIDENCE: 0.9\nREASONING: Good.",
    );
    expect(result!.verdict).toBe("pass");
  });

  it("returns null for missing VERDICT", () => {
    const result = parseJudgeResponse(
      "CONFIDENCE: 0.9\nREASONING: No verdict here.",
    );
    expect(result).toBeNull();
  });

  it("returns null for invalid verdict value", () => {
    const result = parseJudgeResponse(
      "VERDICT: excellent\nCONFIDENCE: 0.9\nREASONING: Great.",
    );
    expect(result).toBeNull();
  });

  it("defaults confidence to 0.5 when missing", () => {
    const result = parseJudgeResponse(
      "VERDICT: pass\nREASONING: Looks good.",
    );
    expect(result!.confidence).toBe(0.5);
  });

  it("defaults confidence to 0.5 for out-of-range values", () => {
    const result = parseJudgeResponse(
      "VERDICT: pass\nCONFIDENCE: 1.5\nREASONING: Good.",
    );
    expect(result!.confidence).toBe(0.5);
  });

  it("provides default reasoning when missing", () => {
    const result = parseJudgeResponse("VERDICT: flag\nCONFIDENCE: 0.5");
    expect(result!.reasoning).toBe("No reasoning provided");
  });

  it("handles extra whitespace and formatting", () => {
    const result = parseJudgeResponse(
      "  VERDICT:  pass  \n  CONFIDENCE:  0.88  \n  REASONING:  All good.  ",
    );
    expect(result!.verdict).toBe("pass");
    expect(result!.confidence).toBe(0.88);
    expect(result!.reasoning).toBe("All good.");
  });

  it("handles response with preamble text before the verdict", () => {
    const result = parseJudgeResponse(
      "Let me evaluate this response.\n\nVERDICT: pass\nCONFIDENCE: 0.9\nREASONING: Well done.",
    );
    expect(result!.verdict).toBe("pass");
  });
});

// ============================================================================
// Tests: evaluateWithLLMJudge (via real HTTP server)
// ============================================================================

describe("evaluateWithLLMJudge", () => {
  it("returns parsed judge result on success", async () => {
    resetServer();
    nextResponse = {
      body: {
        response: "VERDICT: pass\nCONFIDENCE: 0.95\nREASONING: Complete and correct implementation.",
      },
    };

    const result = await evaluateWithLLMJudge(makeJudgeParams());
    expect(result.verdict).toBe("pass");
    expect(result.confidence).toBe(0.95);
    expect(result.reasoning).toBe("Complete and correct implementation.");
    expect(result.evaluationTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("returns heuristic fallback on HTTP error", async () => {
    resetServer();
    nextResponse = { status: 500, body: { error: "internal error" } };

    const heuristic = makeHeuristicResult({ verdict: "flag", score: 0.6 });
    const result = await evaluateWithLLMJudge(
      makeJudgeParams({ heuristicResult: heuristic }),
    );
    expect(result.verdict).toBe("flag");
    expect(result.reasoning).toContain("Fallback to heuristic");
  });

  it("returns heuristic fallback on parse failure", async () => {
    resetServer();
    nextResponse = {
      body: { response: "I don't understand the format you want." },
    };

    const heuristic = makeHeuristicResult({ verdict: "flag", score: 0.5 });
    const result = await evaluateWithLLMJudge(
      makeJudgeParams({ heuristicResult: heuristic }),
    );
    expect(result.verdict).toBe("flag");
    expect(result.reasoning).toContain("Fallback to heuristic");
    expect(result.reasoning).toContain("parse failure");
  });

  it("returns heuristic fallback on connection refused", async () => {
    const heuristic = makeHeuristicResult({ verdict: "flag", score: 0.7 });
    const result = await evaluateWithLLMJudge(
      makeJudgeParams({
        ollamaBaseUrl: "http://127.0.0.1:1", // port 1 — should refuse
        heuristicResult: heuristic,
        timeoutMs: 2000,
      }),
    );
    expect(result.verdict).toBe("flag");
    expect(result.reasoning).toContain("Fallback to heuristic");
  });

  it("returns heuristic fallback on timeout", async () => {
    resetServer();
    nextResponse = {
      delay: 3000, // 3 second delay
      body: { response: "VERDICT: pass\nCONFIDENCE: 0.9\nREASONING: Late." },
    };

    const heuristic = makeHeuristicResult({ verdict: "flag", score: 0.5 });
    const result = await evaluateWithLLMJudge(
      makeJudgeParams({
        heuristicResult: heuristic,
        timeoutMs: 500, // 500ms timeout — will expire before 3s delay
      }),
    );
    expect(result.verdict).toBe("flag");
    expect(result.reasoning).toContain("Fallback to heuristic");
  });

  it("returns heuristic fallback when response field is missing", async () => {
    resetServer();
    nextResponse = {
      body: { model: "test", created_at: "2024-01-01" }, // no 'response' field
    };

    const heuristic = makeHeuristicResult({ verdict: "retry", score: 0.3 });
    const result = await evaluateWithLLMJudge(
      makeJudgeParams({ heuristicResult: heuristic }),
    );
    expect(result.verdict).toBe("retry");
    expect(result.reasoning).toContain("Fallback to heuristic");
  });
});

// ============================================================================
// Tests: assessQualityWithJudge (two-stage gate)
// ============================================================================

describe("assessQualityWithJudge", () => {
  it("skips judge for clear pass (score > threshold)", async () => {
    // A clean response will get score=1.0, verdict="pass" from heuristic
    const config = makeJudgeConfig();
    const result = await assessQualityWithJudge(
      "Here is a complete implementation:\n\n```typescript\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n```\n\nThis handles all cases correctly.",
      "Write an add function",
      config,
    );
    // Should pass without invoking judge (score 1.0 > 0.8 threshold)
    expect(result.verdict).toBe("pass");
    expect(result.score).toBe(1.0);
    // Should NOT have a judge reasoning issue (judge was skipped)
    expect(result.issues.some((i) => i.description.startsWith("LLM judge:"))).toBe(false);
  });

  it("skips judge for clear retry (explicit refusal)", async () => {
    const config = makeJudgeConfig();
    const result = await assessQualityWithJudge(
      "I cannot provide this implementation because it is too complex.",
      "Implement a compiler",
      config,
    );
    expect(result.verdict).toBe("retry");
    // Judge should NOT have been invoked
    expect(result.issues.some((i) => i.description.startsWith("LLM judge:"))).toBe(false);
  });

  it("invokes judge for borderline cases and uses judge verdict", async () => {
    resetServer();
    nextResponse = {
      body: {
        response: "VERDICT: retry\nCONFIDENCE: 0.82\nREASONING: Response contains placeholder code that needs real implementation.",
      },
    };

    const config = makeJudgeConfig();
    // A response with a TODO will get flagged by heuristic (score < 0.8)
    const result = await assessQualityWithJudge(
      "Here is the code:\n\n```typescript\n// TODO: implement the sorting logic\n```",
      "Write a sort function",
      config,
    );
    // Judge says retry, so verdict should be retry
    expect(result.verdict).toBe("retry");
    // Should include judge reasoning in issues
    expect(result.issues.some((i) => i.description.startsWith("LLM judge:"))).toBe(true);
    // Score should be the judge's confidence
    expect(result.score).toBe(0.82);
  });

  it("falls back to heuristic when judge fails", async () => {
    resetServer();
    nextResponse = { status: 500, body: { error: "server error" } };

    const config = makeJudgeConfig();
    // Response with incomplete code (score < 0.8, verdict "flag")
    const response = "Here:\n\n```typescript\n// TODO: implement\nfunction sort() {}\n```";
    const result = await assessQualityWithJudge(
      response,
      "Write a sort function",
      config,
    );
    // Should fall back to heuristic verdict
    const heuristic = assessQuality(response);
    expect(result.verdict).toBe(heuristic.verdict);
  });

  it("invokes judge when score equals threshold exactly", async () => {
    resetServer();
    nextResponse = {
      body: {
        response: "VERDICT: pass\nCONFIDENCE: 0.9\nREASONING: Acceptable quality.",
      },
    };

    // Use a threshold of 1.0 so even a "clean pass" with score=1.0 goes to judge
    const config = makeJudgeConfig({ minHeuristicScoreForJudge: 1.0 });
    const result = await assessQualityWithJudge(
      "A perfectly clean response with no issues whatsoever.",
      "Say hello",
      config,
    );
    // Score 1.0 is NOT > 1.0, so judge should be invoked
    expect(result.issues.some((i) => i.description.startsWith("LLM judge:"))).toBe(true);
  });
});
