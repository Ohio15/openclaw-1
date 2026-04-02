/**
 * OpenClaw Intelligence Pipeline Plugin
 *
 * Augments AI responses with:
 * - Complexity decomposition and pipeline selection
 * - Quality gating (placeholder/refusal/truncation detection with actionable verdicts)
 * - Domain knowledge injection via shared-brain
 * - Feedback recording for continuous improvement
 * - Enhanced loop detection (DeerFlow-inspired) — early triggers, fuzzy matching, steering guidance
 * - Progressive conversation summarization (DeerFlow-inspired) — configurable triggers, recent window
 * - Coding agent delegation (DeerFlow ACP-inspired) — delegate to Claude Code CLI or similar
 *
 * Hook points:
 *   before_model_resolve — tier-based model selection (cached)
 *   before_prompt_build  — analyze complexity, inject domain context, progressive summary, loop steering (cached)
 *   agent_end            — quality gate, record feedback (uses cached analysis)
 *   before_tool_call     — enhanced loop detection (priority 10)
 *   after_tool_call      — record tool outcomes for loop analysis
 *   llm_output           — response-level repetition detection
 *   before/after_compaction — observe and track core compaction events
 *   session_end          — cleanup per-session state
 *
 * Tools:
 *   delegate_to_coding_agent — delegate complex coding tasks to external AI agents
 *
 * CLI commands:
 *   openclaw intel stats    — show aggregated feedback insights
 *   openclaw intel summary  — show a brief quality summary
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  IntelligenceControlPlane,
  type IntelligenceConfig,
  extractUserPrompt,
} from "./src/pipeline/control-plane.js";
import { FeedbackLoop, type FeedbackEntry } from "./src/feedback/feedback-loop.js";
import { SubAgentOrchestrator } from "./src/pipeline/sub-agent-orchestrator.js";
import { ModelTierResolver } from "./src/pipeline/model-tier-resolver.js";
import { assessQuality } from "./src/pipeline/quality-gate.js";
import { AnalysisCache, promptHash } from "./src/pipeline/analysis-cache.js";
import type { BeforeAgentAnalysis } from "./src/pipeline/control-plane.js";
import {
  EnhancedLoopDetector,
  type EnhancedLoopConfig,
} from "./src/pipeline/enhanced-loop-detection.js";
import {
  EnhancedCompactionManager,
  type EnhancedCompactionConfig,
} from "./src/pipeline/enhanced-compaction.js";
import {
  CodingAgentDelegator,
  type CodingAgentConfig,
  CONFIG_DEFAULTS as DELEGATION_DEFAULTS,
} from "./src/tools/coding-agent-delegator.js";
import { createDelegateCodingAgentTool } from "./src/tools/delegate-coding-agent-tool.js";

// ============================================================================
// Plugin Definition
// ============================================================================

const intelligencePlugin = {
  id: "intelligence",
  name: "Intelligence Pipeline",
  description:
    "Response quality augmentation: complexity decomposition, quality gating, domain knowledge injection",

  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as Partial<IntelligenceConfig>;
    const enabled = cfg.enabled ?? true;

    // Initialize core components
    const controlPlane = new IntelligenceControlPlane({
      enabled: cfg.enabled,
      knowledgeSource: (cfg as any).knowledgeSource,
      brainUrl: (cfg as any).brainUrl,
      brainApiKey: (cfg as any).brainApiKey,
    });
    const feedback = new FeedbackLoop(
      api.resolvePath(cfg.feedbackPath || "~/.openclaw/intelligence/feedback.jsonl"),
    );

    const orchestrator = new SubAgentOrchestrator();
    const tierResolver = new ModelTierResolver(
      (cfg as any).tierModelMap ?? {},
    );

    // Analysis cache — prevents triple-computation across hooks
    const analysisCache = new AnalysisCache<BeforeAgentAnalysis>(60_000);

    /**
     * Get or compute the before-agent analysis, using cache to avoid
     * redundant shared-brain HTTP calls across hooks in the same request.
     */
    async function getCachedAnalysis(
      messages: unknown[],
    ): Promise<BeforeAgentAnalysis> {
      const userPrompt = extractUserPrompt(messages);
      const key = promptHash(userPrompt);
      const cached = analysisCache.get(key);
      if (cached) return cached;

      const result = await controlPlane.analyzeBeforeAgent(messages);
      analysisCache.set(key, result);
      return result;
    }

    // Enhanced loop detection (DeerFlow-inspired)
    const loopCfg = ((cfg as any).enhancedLoopDetection ?? {}) as Partial<EnhancedLoopConfig>;
    const loopDetector = new EnhancedLoopDetector(loopCfg);
    const loopEnabled = loopCfg.enabled ?? false;

    // Enhanced conversation summarization (DeerFlow-inspired)
    const compactionCfg = ((cfg as any).enhancedCompaction ?? {}) as Partial<EnhancedCompactionConfig>;
    const compactionMgr = new EnhancedCompactionManager(compactionCfg);
    const compactionEnabled = compactionCfg.enabled ?? false;

    // Coding agent delegation (DeerFlow ACP-inspired)
    const delegationCfg = {
      ...DELEGATION_DEFAULTS,
      ...((cfg as any).codingAgentDelegation ?? {}),
    } as CodingAgentConfig;
    const delegationEnabled = delegationCfg.enabled ?? false;
    const delegator = new CodingAgentDelegator(delegationCfg);

    api.logger.info("intelligence: plugin registered");

    // ========================================================================
    // Hook: before_model_resolve
    // Select model/provider override based on tier analysis (CACHED)
    // ========================================================================

    api.on("before_model_resolve", async (event) => {
      if (!enabled) return;
      try {
        const messages = event.messages as unknown[];
        if (!messages || messages.length === 0) return;
        const analysis = await getCachedAnalysis(messages);
        const override = tierResolver.resolve(analysis.tierSelection);
        if (override?.modelOverride || override?.providerOverride) {
          api.logger.info(
            `intelligence: tier ${analysis.tierSelection.tier} → model override: ${override.modelOverride ?? "none"}, provider: ${override.providerOverride ?? "none"}`,
          );
          return override;
        }
      } catch (err) {
        api.logger.warn(`intelligence: before_model_resolve failed: ${String(err)}`);
      }
    });

    // ========================================================================
    // Hook: before_prompt_build
    // Analyze complexity, detect domain, inject domain knowledge context (CACHED)
    // ========================================================================

    api.on("before_prompt_build", async (event, ctx) => {
      if (!enabled) return;

      const messages = event.messages as unknown[];
      if (!messages || messages.length === 0) return;

      try {
        const analysis = await getCachedAnalysis(messages);

        api.logger.info(
          `intelligence: complexity=${analysis.complexity.toFixed(2)}, ` +
          `tier=${analysis.tierSelection.tier}, ` +
          `pipeline=${analysis.pipelineSelection.pipeline}, ` +
          `domain=${analysis.domain ?? "none"}, ` +
          `knowledge=${analysis.domainContext ? "injected" : "none"}`,
        );

        // Chained execution for complex requests
        const chainingEnabled = (cfg as any).chainingEnabled ?? false;
        const chainingThreshold = (cfg as any).chainingComplexityThreshold ?? 0.7;

        if (
          chainingEnabled &&
          analysis.complexity >= chainingThreshold &&
          analysis.subTasks.length >= 2
        ) {
          const subTasks = analysis.subTasks.map((indicator, i) => ({
            name: indicator,
            description: `Address the "${indicator}" aspect of the request`,
            priority: analysis.subTasks.length - i,
            dependencies: i > 0 ? [analysis.subTasks[i - 1]] : [],
          }));

          const chainedPrompt = orchestrator.buildChainedPrompt(subTasks, analysis.domainContext);

          api.logger.info(
            `intelligence: chained execution activated (${subTasks.length} steps, complexity=${analysis.complexity.toFixed(2)})`,
          );

          return { prependContext: chainedPrompt };
        }

        // Original domain context injection (non-chained path)
        let prependParts: string[] = [];
        if (analysis.domainContext) {
          prependParts.push(analysis.domainContext);
        }

        // Check for response-level loop steering (from llm_output hook)
        const sessionKey = ctx.sessionKey ?? ctx.agentId ?? "default";
        if (loopEnabled) {
          const responseLoopMsg = loopDetector.consumeResponseLoopFlag(sessionKey);
          if (responseLoopMsg) {
            prependParts.push(responseLoopMsg);
            api.logger.warn("intelligence: injecting response-level loop steering");
          }
        }

        // Enhanced progressive compaction (Stage 1: masking, Stage 2: summarization)
        if (compactionEnabled) {
          compactionMgr.recordComplexity(sessionKey, analysis.complexity);
          const summary = compactionMgr.checkAndSummarize(messages, sessionKey);
          if (summary) {
            prependParts.push(summary);
            api.logger.info(
              `intelligence: progressive summary injected (${summary.length} chars)`,
            );
          }
          // Log masking metrics if observation masking was applied
          const sessionMetrics = compactionMgr.getSessionMetrics(sessionKey);
          if (sessionMetrics?.maskingApplied) {
            api.logger.info(
              `intelligence: observation masking recovered ~${sessionMetrics.maskingTokensRecovered} tokens` +
              (sessionMetrics.summarizationSkippedAfterMasking ? " (summarization skipped)" : ""),
            );
          }
        }

        if (prependParts.length > 0) {
          return { prependContext: prependParts.join("\n\n") };
        }
      } catch (err) {
        api.logger.warn(`intelligence: before_prompt_build failed: ${String(err)}`);
      }
    });

    // ========================================================================
    // Hook: agent_end
    // Quality gate assessment, record feedback (uses CACHED analysis)
    // ========================================================================

    api.on("agent_end", async (event) => {
      if (!enabled || !event.success) return;

      const messages = event.messages as unknown[];
      if (!messages || messages.length === 0) return;

      // Extract the last assistant response from the messages array
      let response = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i] as Record<string, unknown> | null;
        if (!msg || msg.role !== "assistant") continue;
        if (typeof msg.content === "string") { response = msg.content; break; }
        if (Array.isArray(msg.content)) {
          const texts = (msg.content as Array<Record<string, unknown>>)
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text as string);
          if (texts.length > 0) { response = texts.join("\n"); break; }
        }
      }

      if (!response) return;

      try {
        // Quality gate — actionable assessment
        const qualityResult = assessQuality(response);

        // Get cached analysis for metadata (no recomputation)
        const analysis = messages.length > 0
          ? await getCachedAnalysis(messages)
          : null;

        // Check for chained execution output
        const chainOutputs = orchestrator.extractSubTaskOutputs(response);
        let chainedExecution = false;
        let subTaskCount = 0;
        let subTaskScores: Record<string, number> = {};

        if (chainOutputs.size > 0) {
          chainedExecution = true;
          subTaskCount = chainOutputs.size;
          for (const [step, content] of chainOutputs) {
            const hasContent = content.length > 0 ? 0.3 : 0;
            const hasLength = content.length > 100 ? 0.2 : 0;
            const hasCode = /```/.test(content) ? 0.2 : 0;
            subTaskScores[step] = hasContent + hasLength + hasCode + 0.3;
          }
        }

        // Record feedback entry
        const entry: FeedbackEntry = {
          confidence: qualityResult.score,
          coherent: qualityResult.verdict !== "retry",
          timestamp: Date.now(),
          category: "general",
          tier: analysis?.tierSelection.tier,
          pipeline: analysis?.pipelineSelection.pipeline,
          refusalDetected: qualityResult.issues.some((i) => i.type === "explicit_refusal"),
          complexity: analysis?.complexity,
          domain: analysis?.domain ?? undefined,
          chainedExecution: chainedExecution || undefined,
          subTaskCount: subTaskCount || undefined,
          subTaskScores: Object.keys(subTaskScores).length > 0 ? subTaskScores : undefined,
        };

        await feedback.record(entry);

        api.logger.info(
          `intelligence: verdict=${qualityResult.verdict}, ` +
          `score=${qualityResult.score.toFixed(2)}, ` +
          `issues=${qualityResult.issues.length}, ` +
          `refusal=${entry.refusalDetected}`,
        );
      } catch (err) {
        api.logger.warn(`intelligence: agent_end evaluation failed: ${String(err)}`);
      }
    });

    // ========================================================================
    // Hook: before_tool_call (Enhanced Loop Detection)
    // Priority 10 — runs before core's default-priority (0) loop detection
    // ========================================================================

    api.on(
      "before_tool_call",
      async (event, ctx) => {
        if (!loopEnabled) return;
        const sessionKey = ctx.sessionKey ?? ctx.agentId ?? "default";
        const result = loopDetector.check(event.toolName, event.params, sessionKey);
        if (result.detected) {
          api.logger.warn(
            `intelligence: enhanced loop detected — category=${result.category}, ` +
            `tool=${event.toolName}, count=${result.count}`,
          );
          return { block: true, blockReason: result.guidance };
        }
      },
      { priority: 10 },
    );

    // ========================================================================
    // Hook: after_tool_call (Record outcome for no-progress tracking)
    // ========================================================================

    api.on("after_tool_call", async (event, ctx) => {
      if (!loopEnabled) return;
      const sessionKey = ctx.sessionKey ?? ctx.agentId ?? "default";
      loopDetector.recordOutcome(
        event.toolName,
        event.params,
        event.result,
        event.error,
        sessionKey,
      );
    });

    // ========================================================================
    // Hook: llm_output (Response-level loop detection)
    // ========================================================================

    api.on("llm_output", async (event, ctx) => {
      if (!loopEnabled) return;
      const sessionKey = ctx.sessionKey ?? ctx.agentId ?? "default";
      loopDetector.trackResponse(event.assistantTexts, sessionKey);
    });

    // ========================================================================
    // Hook: before_compaction (Observe core compaction for metrics)
    // ========================================================================

    api.on("before_compaction", async (event, ctx) => {
      if (!compactionEnabled) return;
      const sessionKey = ctx.sessionKey ?? ctx.agentId ?? "default";
      const snapshot = compactionMgr.logCompactionEvent(sessionKey, event as any);
      api.logger.info(
        `intelligence: core compaction triggered — msgs=${snapshot.metricsSnapshot.messageCount}, ` +
        `tokens=${snapshot.metricsSnapshot.estimatedTokens}`,
      );
    });

    // ========================================================================
    // Hook: after_compaction (Invalidate cache after core compaction)
    // ========================================================================

    api.on("after_compaction", async (_event, ctx) => {
      if (!compactionEnabled) return;
      const sessionKey = ctx.sessionKey ?? ctx.agentId ?? "default";
      compactionMgr.invalidateCache(sessionKey);
    });

    // ========================================================================
    // Hook: session_end (Cleanup state)
    // ========================================================================

    api.on("session_end", async (_event, ctx) => {
      const sessionKey = ctx.sessionId ?? ctx.agentId ?? "default";
      if (loopEnabled) loopDetector.clearSession(sessionKey);
      if (compactionEnabled) compactionMgr.clearSession(sessionKey);
      analysisCache.clear(); // Sweep all — session is done
    });

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const intel = program
          .command("intel")
          .description("Intelligence pipeline commands");

        intel
          .command("stats")
          .description("Show aggregated feedback insights")
          .action(async () => {
            const insights = await feedback.getInsights();
            console.log(JSON.stringify(insights, null, 2));
          });

        intel
          .command("summary")
          .description("Show a brief quality summary")
          .action(async () => {
            const insights = await feedback.getInsights();
            if (insights.totalEntries === 0) {
              console.log("No feedback data recorded yet.");
              return;
            }

            console.log(`Intelligence Pipeline Summary`);
            console.log(`${"=".repeat(40)}`);
            console.log(`Total evaluations: ${insights.totalEntries}`);
            console.log(`Avg confidence:    ${(insights.avgConfidence * 100).toFixed(1)}%`);
            console.log(`Coherence rate:    ${(insights.coherenceRate * 100).toFixed(1)}%`);
            console.log(`Refusal rate:      ${(insights.refusalRate * 100).toFixed(1)}%`);

            if (insights.byCategory.length > 0) {
              console.log(`\nTop categories:`);
              for (const cat of insights.byCategory.slice(0, 5)) {
                console.log(
                  `  ${cat.category.padEnd(15)} ` +
                  `n=${String(cat.count).padStart(4)}  ` +
                  `conf=${(cat.avgConfidence * 100).toFixed(0)}%  ` +
                  `coh=${(cat.coherenceRate * 100).toFixed(0)}%`,
                );
              }
            }

            const tierKeys = Object.keys(insights.byTier);
            if (tierKeys.length > 0) {
              console.log(`\nTier distribution:`);
              for (const tier of tierKeys) {
                const t = insights.byTier[tier];
                console.log(
                  `  ${tier.padEnd(12)} n=${String(t.count).padStart(4)}  conf=${(t.avgConfidence * 100).toFixed(0)}%`,
                );
              }
            }
          });
      },
      { commands: ["intel"] },
    );

    // ========================================================================
    // Gateway Method: Dashboard Data
    // ========================================================================

    api.registerHttpRoute({
      path: "/intelligence/dashboard",
      handler: async (_req: any, res: any) => {
        try {
          const insights = await feedback.getInsights();
          const recentRaw = await feedback.getRecentEntries(20);
          const recent = recentRaw.map((entry: any) => ({
            timestamp: entry.timestamp,
            category: entry.category ?? "general",
            tier: entry.tier ?? "",
            confidence: entry.confidence,
            coherent: entry.coherent,
            refusalDetected: entry.refusalDetected ?? false,
            chainedExecution: entry.chainedExecution ?? false,
            complexity: entry.complexity,
          }));

          const data = {
            config: {
              enabled,
              knowledgeSource: (cfg as any).knowledgeSource ?? "hybrid",
              chainingEnabled: (cfg as any).chainingEnabled ?? false,
              chainingThreshold: (cfg as any).chainingComplexityThreshold ?? 0.7,
              ragMaxIterations: (cfg as any).ragMaxIterations ?? 3,
              ragRelevanceThreshold: (cfg as any).ragRelevanceThreshold ?? 0.6,
              sandboxEnabled: false,
            },
            feedback: {
              ...insights,
              recentEntries: recent,
            },
            budget: null,
          };

          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify(data));
        } catch (err) {
          api.logger.warn(`intelligence: dashboard route failed: ${String(err)}`);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      },
    });
    api.logger.info("intelligence: HTTP route /intelligence/dashboard registered");

    // ========================================================================
    // Service Registration
    // ========================================================================

    api.registerService({
      id: "intelligence",
      start: () => api.logger.info("intelligence: pipeline active"),
      stop: () => {
        delegator.killAll();
        api.logger.info("intelligence: pipeline stopped");
      },
    });

    // ========================================================================
    // Tool: delegate_to_coding_agent (ACP-style external agent delegation)
    // ========================================================================

    if (delegationEnabled) {
      api.registerTool(
        createDelegateCodingAgentTool(delegator, delegationCfg, api.logger),
      );
      api.logger.info(
        `intelligence: coding agent delegation enabled (agents: ${Object.keys(delegationCfg.agents).join(", ")})`,
      );
    }
  },
};

export default intelligencePlugin;
