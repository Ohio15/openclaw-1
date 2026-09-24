/**
 * Hook-level regression tests: every intelligence hook must decide from the
 * run's CURRENT prompt, as recorded at before_model_resolve.
 *
 * Drives the real plugin registration and the real hook handlers; only the
 * analysis step (classifier/knowledge retrieval), the quality verdict and the
 * cascade-signal sink are replaced, so the assertions are about WHICH text the
 * hooks analyse and WHICH tier they escalate from - not about classifier
 * scores.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/intelligence/cascade-state.js", () => ({
  setCascadeSignal: vi.fn(),
  clearCascadeSignals: vi.fn(),
}));
vi.mock("./src/pipeline/quality-gate.js", () => ({
  assessQuality: vi.fn(() => ({ verdict: "retry", issues: ["forced"], score: 0.1 })),
  assessQualityWithJudge: vi.fn(async () => ({ verdict: "retry", issues: ["forced"], score: 0.1 })),
}));

import { setCascadeSignal } from "../../src/intelligence/cascade-state.js";
import { assessQualityWithJudge } from "./src/pipeline/quality-gate.js";
import { IntelligenceControlPlane, extractUserPrompt } from "./src/pipeline/control-plane.js";
import plugin from "./index.js";

type Handler = (event: any, ctx?: any) => Promise<any>;

const CURRENT = "CURRENT: design a multi-region auth failover with audit logging";
const PREVIOUS = "PREVIOUS: what time is it";
const ASSISTANT = "ASSISTANT: here is a long answer that is not a prompt";
const CTX = { sessionKey: "sess-1", sessionId: "sid-1", agentId: "main" };

function tierFor(prompt: string): string {
  if (prompt.startsWith("CURRENT")) return "reasoning";
  if (prompt.startsWith("PREVIOUS")) return "small";
  return "large";
}

function register(pluginConfig: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>();
  const logs: string[] = [];
  const api: any = new Proxy(
    {
      pluginConfig: { knowledgeSource: "static", ...pluginConfig },
      on: (name: string, fn: Handler) => handlers.set(name, fn),
      resolvePath: (p: string) => p.replace("~", "/tmp/intelligence-test"),
      logger: {
        info: (m: string) => logs.push(m),
        warn: (m: string) => logs.push(`WARN ${m}`),
        error: (m: string) => logs.push(`ERROR ${m}`),
        debug: () => {},
      },
    },
    { get: (t, k) => (k in t ? (t as any)[k] : vi.fn()) },
  );
  plugin.register(api);
  return { handlers, logs };
}

let analysed: string[];

beforeEach(() => {
  analysed = [];
  vi.spyOn(IntelligenceControlPlane.prototype, "analyzeBeforeAgent").mockImplementation(
    async (messages: unknown[]) => {
      const prompt = extractUserPrompt(messages);
      analysed.push(prompt);
      return {
        complexity: 0.5,
        subTasks: [],
        tierSelection: { tier: tierFor(prompt), reason: "test" },
        pipelineSelection: { pipeline: "simple", reason: "test" },
        domain: null,
        domainContext: null,
        requirementCount: 1,
      } as any;
    },
  );
  vi.mocked(setCascadeSignal).mockClear();
  vi.mocked(assessQualityWithJudge).mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe("intelligence hooks analyse the current prompt", () => {
  it("before_prompt_build analyses event.prompt, not the previous turn in history", async () => {
    const { handlers, logs } = register();
    await handlers.get("before_model_resolve")!({ prompt: CURRENT }, CTX);
    await handlers.get("before_prompt_build")!(
      { prompt: CURRENT, messages: [{ role: "user", content: PREVIOUS }] },
      CTX,
    );
    // One analysis, of the current prompt, shared via the cache.
    expect(analysed).toEqual([CURRENT]);
    expect(logs.some((l) => l.includes("tier=reasoning"))).toBe(true);
    expect(logs.some((l) => l.includes("tier=small"))).toBe(false);
  });

  it("before_prompt_build with an empty history still analyses the current prompt", async () => {
    const { handlers } = register();
    await handlers.get("before_prompt_build")!({ prompt: CURRENT, messages: [] }, CTX);
    expect(analysed).toEqual([CURRENT]);
  });

  it("cascade escalates from the tier recorded for the run, never from the assistant's text", async () => {
    const { handlers } = register();
    await handlers.get("before_model_resolve")!({ prompt: CURRENT }, CTX);
    analysed = [];
    await handlers.get("llm_output")!(
      { runId: "r1", sessionId: "sid-1", provider: "p", model: "m", assistantTexts: [ASSISTANT] },
      CTX,
    );
    expect(analysed).not.toContain(ASSISTANT);
    expect(vi.mocked(setCascadeSignal)).toHaveBeenCalledTimes(1);
    const [key, verdict, currentTier] = vi.mocked(setCascadeSignal).mock.calls[0];
    expect(key).toBe("sess-1");
    expect(verdict).toBe("retry");
    expect(currentTier).toBe("reasoning");
  });

  it("cascade with no recorded run context assumes medium and warns", async () => {
    const { handlers, logs } = register();
    await handlers.get("llm_output")!(
      { runId: "r1", sessionId: "other", provider: "p", model: "m", assistantTexts: [ASSISTANT] },
      { sessionKey: "other" },
    );
    expect(analysed).toEqual([]);
    expect(vi.mocked(setCascadeSignal).mock.calls[0][2]).toBe("medium");
    expect(logs.some((l) => l.startsWith("WARN") && l.includes("no recorded tier"))).toBe(true);
  });

  it("the LLM judge receives the run's recorded prompt", async () => {
    const { handlers } = register({ llmJudge: { enabled: true } });
    await handlers.get("before_model_resolve")!({ prompt: CURRENT }, CTX);
    await handlers.get("llm_output")!(
      { runId: "r1", sessionId: "sid-1", provider: "p", model: "m", assistantTexts: [ASSISTANT] },
      CTX,
    );
    expect(vi.mocked(assessQualityWithJudge)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(assessQualityWithJudge).mock.calls[0][1]).toBe(CURRENT);
  });
});
