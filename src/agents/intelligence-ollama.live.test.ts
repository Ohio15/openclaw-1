import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../infra/env.js";
import { analyzeComplexity } from "../../extensions/intelligence/src/pipeline/complexity-decomposer.js";
import { selectTier, type TierSelection } from "../../extensions/intelligence/src/config/routing-authority.js";
import { ModelTierResolver } from "../../extensions/intelligence/src/pipeline/model-tier-resolver.js";

// ---------------------------------------------------------------------------
// Gate: only run when explicitly opted-in via env var
// ---------------------------------------------------------------------------

const LIVE =
  isTruthyEnvValue(process.env.LIVE) ||
  isTruthyEnvValue(process.env.OPENCLAW_LIVE_OLLAMA);

const describeLive = LIVE ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OLLAMA_URL = process.env.OLLAMA_URL || "http://192.168.1.20:11434";

/**
 * NEXUS tier-to-model mapping. Mirrors the production Ollama deployment.
 */
const NEXUS_TIER_MAP = {
  tiny: { model: "ollama/qwen3.5:9b", provider: "ollama" },
  small: { model: "ollama/qwen3.5:9b", provider: "ollama" },
  medium: { model: "ollama/qwen2.5:14b", provider: "ollama" },
  large: { model: "ollama/qwen3.5:9b", provider: "ollama" },
  reasoning: { model: "ollama/qwen3:30b-a3b", provider: "ollama" },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BenchmarkEntry {
  tier: string;
  model: string;
  promptComplexity: string;
  promptWords: number;
  durationMs: number;
  responseChars: number;
  evalCount: number;
  content: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const benchmarks: BenchmarkEntry[] = [];

function logProgress(message: string): void {
  console.log(`[live:ollama] ${message}`);
}

/**
 * Send a chat prompt directly to the Ollama HTTP API, bypassing the gateway.
 */
async function chatOllama(
  model: string,
  prompt: string,
): Promise<{ content: string; totalDurationMs: number; evalCount: number }> {
  const start = Date.now();
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
    signal: AbortSignal.timeout(300_000), // 5min for CPU inference
  });
  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const wallClockMs = Date.now() - start;
  return {
    content: data.message?.content ?? "",
    totalDurationMs:
      Math.round((data.total_duration ?? 0) / 1_000_000) || wallClockMs,
    evalCount: data.eval_count ?? 0,
  };
}

/**
 * Run the full intelligence pipeline (complexity analysis -> tier selection ->
 * model resolution) then send the prompt to Ollama directly.
 */
function detectDomain(prompt: string): string | null {
  const lower = prompt.toLowerCase();
  if (/\b(auth|jwt|oauth|session|login|permission)\b/.test(lower)) return "auth";
  if (/\b(database|postgres|mongodb|sql|orm)\b/.test(lower)) return "database";
  if (/\b(cache|lru_cache|redis)\b/.test(lower)) return "cache";
  if (/\b(rate.?limit|token.?bucket)\b/.test(lower)) return "rate_limiter";
  return null;
}

async function runPipelineTest(
  prompt: string,
  label: string,
): Promise<BenchmarkEntry> {
  const analysis = analyzeComplexity(prompt);
  const domain = detectDomain(prompt);
  const tierSelection: TierSelection = selectTier(analysis.complexity, domain);
  const override = resolver.resolve(tierSelection);
  const modelId = override?.modelOverride ?? "qwen3.5:9b";
  const ollamaModel = modelId.replace(/^ollama\//, "");

  logProgress(
    `${label}: tier=${tierSelection.tier} model=${ollamaModel} complexity=${analysis.complexity.toFixed(2)}`,
  );

  const result = await chatOllama(ollamaModel, prompt);

  logProgress(
    `${label}: ${result.totalDurationMs}ms, ${result.content.length} chars, ${result.evalCount} tokens`,
  );

  const entry: BenchmarkEntry = {
    tier: tierSelection.tier,
    model: ollamaModel,
    promptComplexity: label,
    promptWords: prompt.split(/\s+/).length,
    durationMs: result.totalDurationMs,
    responseChars: result.content.length,
    evalCount: result.evalCount,
    content: result.content,
  };

  benchmarks.push(entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Resolver instance (initialized in beforeAll)
// ---------------------------------------------------------------------------

const resolver = new ModelTierResolver(NEXUS_TIER_MAP);

// ---------------------------------------------------------------------------
// Test prompts
// ---------------------------------------------------------------------------

const PROMPT_TRIVIAL = "what is 2+2?";

const PROMPT_MEDIUM =
  "Create multiple API routes with database queries and optimization for response times.";

const PROMPT_REASONING =
  "Design a CRDT-based collaborative editing algorithm with operational transform conflict resolution for a real-time production system. Explain the data structures, the merge function, and how concurrent edits from multiple clients converge to a consistent state without a central server.";

const PROMPT_DOMAIN_AUTH =
  "Implement JWT authentication with OAuth integration and session management for a database-backed API with caching.";

const PROMPT_RAPID_1 = "Name three primary colors.";
const PROMPT_RAPID_2 = "What is 10 divided by 2?";
const PROMPT_RAPID_3 = "Is water wet? Answer in one word.";

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeLive(
  "intelligence pipeline - ollama tier routing (direct HTTP)",
  { timeout: 600_000 },
  () => {
    // Print benchmark table after all tests
    afterAll(() => {
      if (benchmarks.length > 0) {
        console.log("\n## Intelligence Pipeline Benchmark Results\n");
        console.log(
          "| Tier | Model | Complexity | Words | Duration (ms) | Response Chars | Eval Tokens |",
        );
        console.log(
          "|------|-------|-----------|-------|--------------|----------------|-------------|",
        );
        for (const b of benchmarks) {
          console.log(
            `| ${b.tier} | ${b.model} | ${b.promptComplexity} | ${b.promptWords} | ${b.durationMs} | ${b.responseChars} | ${b.evalCount} |`,
          );
        }
      }
    });

    // ---- Connectivity ----

    it(
      "connects to Ollama (health check)",
      { timeout: 15_000 },
      async () => {
        const res = await fetch(`${OLLAMA_URL}/api/tags`, {
          signal: AbortSignal.timeout(10_000),
        });
        expect(res.ok).toBe(true);
        const data = await res.json();
        const modelNames = (data.models ?? []).map(
          (m: { name: string }) => m.name,
        );
        logProgress(`Ollama reachable. Models: ${modelNames.join(", ")}`);
        expect(modelNames.length).toBeGreaterThan(0);
      },
    );

    // ---- Tier routing ----

    it(
      "routes trivial prompt to tiny/small tier -> qwen3.5:9b",
      { timeout: 300_000 },
      async () => {
        const entry = await runPipelineTest(PROMPT_TRIVIAL, "trivial");

        expect(entry.content.length).toBeGreaterThan(0);
        expect(entry.content.toLowerCase()).toContain("4");

        const acceptableTiers = ["tiny", "small"];
        expect(acceptableTiers).toContain(entry.tier);
        expect(entry.model).toBe("qwen3.5:9b");
      },
    );

    it(
      "routes medium prompt to medium tier -> qwen2.5:14b",
      { timeout: 300_000 },
      async () => {
        const entry = await runPipelineTest(PROMPT_MEDIUM, "medium");

        expect(entry.content.length).toBeGreaterThan(10);

        const lowerText = entry.content.toLowerCase();
        const hasRelevantContent =
          lowerText.includes("express") ||
          lowerText.includes("endpoint") ||
          lowerText.includes("api") ||
          lowerText.includes("router") ||
          lowerText.includes("function") ||
          lowerText.includes("app.") ||
          lowerText.includes("const ") ||
          lowerText.includes("import ");
        expect(hasRelevantContent).toBe(true);

        expect(entry.tier).toBe("medium");
        expect(entry.model).toBe("qwen2.5:14b");
      },
    );

    it(
      "routes reasoning prompt to reasoning tier -> qwen3:30b-a3b",
      { timeout: 300_000 },
      async () => {
        const entry = await runPipelineTest(PROMPT_REASONING, "reasoning");

        expect(entry.content.length).toBeGreaterThan(10);

        const lowerText = entry.content.toLowerCase();
        const hasRelevantContent =
          lowerText.includes("crdt") ||
          lowerText.includes("merge") ||
          lowerText.includes("conflict") ||
          lowerText.includes("convergence") ||
          lowerText.includes("concurrent") ||
          lowerText.includes("operation") ||
          lowerText.includes("state") ||
          lowerText.includes("replica");
        expect(hasRelevantContent).toBe(true);

        expect(entry.tier).toBe("reasoning");
        expect(entry.model).toBe("qwen3:30b-a3b");
      },
    );

    it(
      "escalates auth-domain prompt to large tier -> qwen3.5:9b",
      { timeout: 600_000 },
      async () => {
        const entry = await runPipelineTest(PROMPT_DOMAIN_AUTH, "auth-domain");

        expect(entry.content.length).toBeGreaterThan(10);

        const lowerText = entry.content.toLowerCase();
        const hasAuthContent =
          lowerText.includes("jwt") ||
          lowerText.includes("token") ||
          lowerText.includes("auth") ||
          lowerText.includes("middleware") ||
          lowerText.includes("refresh") ||
          lowerText.includes("cookie");
        expect(hasAuthContent).toBe(true);

        expect(entry.tier).toBe("large");
        expect(entry.model).toBe("qwen3.5:9b");
      },
    );

    // ---- Response quality ----

    it(
      "trivial tier response is non-empty with substance (>10 chars)",
      { timeout: 300_000 },
      async () => {
        const prompt = "Explain what a variable is in programming.";
        const entry = await runPipelineTest(prompt, "trivial-quality");

        expect(entry.content.length).toBeGreaterThan(10);
        expect(entry.content.split(/\s+/).filter(Boolean).length).toBeGreaterThan(3);
      },
    );

    it(
      "medium tier response is non-empty with substance (>50 chars)",
      { timeout: 300_000 },
      async () => {
        const prompt =
          "Write a Python function that implements binary search on a sorted array with proper error handling.";
        const entry = await runPipelineTest(prompt, "medium-quality");

        expect(entry.content.length).toBeGreaterThan(50);

        const lowerText = entry.content.toLowerCase();
        const hasCode =
          lowerText.includes("def ") ||
          lowerText.includes("function") ||
          lowerText.includes("binary") ||
          lowerText.includes("search");
        expect(hasCode).toBe(true);
      },
    );

    it(
      "responses do not appear truncated mid-sentence",
      { timeout: 300_000 },
      async () => {
        const prompt =
          "Briefly explain the difference between a stack and a queue data structure.";
        const entry = await runPipelineTest(prompt, "truncation-check");

        expect(entry.content.length).toBeGreaterThan(10);

        // Rough truncation check: text should end with punctuation, a code fence,
        // a closing tag, or a complete-looking line (not mid-word).
        const trimmed = entry.content.trimEnd();
        const lastChar = trimmed.charAt(trimmed.length - 1);
        const endsCleanly =
          /[.!?)\]}`'"]/.test(lastChar) ||
          trimmed.endsWith("```") ||
          trimmed.endsWith("---") ||
          // Some models end with a newline after a complete thought. Accept if
          // the last line has > 5 chars (unlikely mid-word truncation).
          trimmed.split("\n").pop()!.trim().length > 5;
        expect(endsCleanly).toBe(true);
      },
    );

    // ---- Edge cases ----

    it(
      "handles rapid sequential prompts without errors",
      { timeout: 600_000 },
      async () => {
        logProgress("rapid sequential: sending 3 prompts");

        const prompts = [PROMPT_RAPID_1, PROMPT_RAPID_2, PROMPT_RAPID_3];

        // Send sequentially in quick succession (no artificial delay)
        for (const prompt of prompts) {
          const entry = await runPipelineTest(prompt, "rapid-sequential");
          expect(entry.content.length).toBeGreaterThan(0);
          logProgress(
            `rapid sequential: got response (${entry.content.length} chars)`,
          );
        }
      },
    );

    // ---- Tier-specific model verification ----

    it(
      "tiny tier model resolves to qwen3.5:9b",
      { timeout: 10_000 },
      async () => {
        const override = resolver.resolve({ tier: "tiny", reason: "test" });
        expect(override).not.toBeNull();
        expect(override!.modelOverride).toBe("ollama/qwen3.5:9b");

        const ollamaModel = override!.modelOverride!.replace(/^ollama\//, "");
        expect(ollamaModel).toBe("qwen3.5:9b");
      },
    );

    it(
      "medium tier model resolves to qwen2.5:14b",
      { timeout: 10_000 },
      async () => {
        const override = resolver.resolve({ tier: "medium", reason: "test" });
        expect(override).not.toBeNull();
        expect(override!.modelOverride).toBe("ollama/qwen2.5:14b");

        const ollamaModel = override!.modelOverride!.replace(/^ollama\//, "");
        expect(ollamaModel).toBe("qwen2.5:14b");
      },
    );

    it(
      "reasoning tier model resolves to qwen3:30b-a3b",
      { timeout: 10_000 },
      async () => {
        const override = resolver.resolve({
          tier: "reasoning",
          reason: "test",
        });
        expect(override).not.toBeNull();
        expect(override!.modelOverride).toBe("ollama/qwen3:30b-a3b");

        const ollamaModel = override!.modelOverride!.replace(/^ollama\//, "");
        expect(ollamaModel).toBe("qwen3:30b-a3b");
      },
    );
  },
);
