/**
 * OpenClaw Intelligence Pipeline Plugin
 *
 * Augments AI responses with:
 * - Complexity decomposition and pipeline selection
 * - Confidence scoring and coherence checking
 * - Refusal detection
 * - Domain knowledge injection
 * - Output formatting/cleaning
 * - Feedback recording for continuous improvement
 *
 * Hook points:
 *   before_prompt_build  — analyze complexity, inject domain context
 *   agent_end            — score confidence, validate coherence, record feedback
 *
 * CLI commands:
 *   openclaw intel stats  — show aggregated feedback insights
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  IntelligenceControlPlane,
  type IntelligenceConfig,
} from "./src/pipeline/control-plane.js";
import { FeedbackLoop, type FeedbackEntry } from "./src/feedback/feedback-loop.js";
import { SubAgentOrchestrator } from "./src/pipeline/sub-agent-orchestrator.js";
import { ModelTierResolver } from "./src/pipeline/model-tier-resolver.js";

// ============================================================================
// Plugin Definition
// ============================================================================

const intelligencePlugin = {
  id: "intelligence",
  name: "Intelligence Pipeline",
  description:
    "Response quality augmentation: complexity decomposition, confidence scoring, self-review, multi-pass generation, domain knowledge injection",

  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as Partial<IntelligenceConfig>;
    const enabled = cfg.enabled ?? true;

    // Initialize core components
    const controlPlane = new IntelligenceControlPlane(cfg);
    const feedback = new FeedbackLoop(
      api.resolvePath(cfg.feedbackPath || "~/.openclaw/intelligence/feedback.jsonl"),
    );

    const orchestrator = new SubAgentOrchestrator();
    const tierResolver = new ModelTierResolver(
      (cfg as any).tierModelMap ?? {},
    );

    api.logger.info("intelligence: plugin registered");

    // ========================================================================
    // Hook: before_model_resolve
    // Select model/provider override based on tier analysis
    // ========================================================================

    api.on("before_model_resolve", async (event) => {
      if (!enabled) return;
      try {
        const messages = event.messages as unknown[];
        if (!messages || messages.length === 0) return;
        const analysis = await controlPlane.analyzeBeforeAgent(messages);
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
    // Analyze complexity, detect domain, inject domain knowledge context
    // ========================================================================

    api.on("before_prompt_build", async (event) => {
      if (!enabled) return;

      const messages = event.messages as unknown[];
      if (!messages || messages.length === 0) return;

      try {
        const analysis = await controlPlane.analyzeBeforeAgent(messages);

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
        if (analysis.domainContext) {
          return { prependContext: analysis.domainContext };
        }
      } catch (err) {
        api.logger.warn(`intelligence: before_prompt_build failed: ${String(err)}`);
      }
    });

    // ========================================================================
    // Hook: agent_end
    // Score confidence, validate coherence, detect refusals, record feedback
    // ========================================================================

    api.on("agent_end", async (event) => {
      if (!enabled || !event.success) return;

      const messages = event.messages as unknown[];
      const response = typeof event.response === "string"
        ? event.response
        : String(event.response ?? "");

      if (!response) return;

      try {
        const evaluation = await controlPlane.evaluateAfterAgent(
          messages ?? [],
          response,
        );

        // Run the before-agent analysis again to get tier/pipeline/domain for feedback
        // (triggers shared-brain recall but results are only used for metadata)
        const analysis = messages && messages.length > 0
          ? await controlPlane.analyzeBeforeAgent(messages)
          : null;

        // Check for chained execution output
        const chainOutputs = orchestrator.extractSubTaskOutputs(response);
        let chainedExecution = false;
        let subTaskCount = 0;
        let subTaskScores: Record<string, number> = {};

        if (chainOutputs.size > 0) {
          chainedExecution = true;
          subTaskCount = chainOutputs.size;
          // Simple per-step quality check
          for (const [step, content] of chainOutputs) {
            const hasContent = content.length > 0 ? 0.3 : 0;
            const hasLength = content.length > 100 ? 0.2 : 0;
            const hasCode = /```/.test(content) ? 0.2 : 0;
            subTaskScores[step] = hasContent + hasLength + hasCode + 0.3; // base 0.3 for existing
          }
        }

        // Record feedback entry
        const entry: FeedbackEntry = {
          confidence: evaluation.confidenceScore,
          coherent: evaluation.isCoherent,
          timestamp: Date.now(),
          category: evaluation.taskType,
          tier: analysis?.tierSelection.tier,
          pipeline: analysis?.pipelineSelection.pipeline,
          refusalDetected: evaluation.refusalDetected,
          complexity: analysis?.complexity,
          domain: analysis?.domain ?? undefined,
          chainedExecution: chainedExecution || undefined,
          subTaskCount: subTaskCount || undefined,
          subTaskScores: Object.keys(subTaskScores).length > 0 ? subTaskScores : undefined,
        };

        await feedback.record(entry);

        api.logger.info(
          `intelligence: confidence=${evaluation.confidenceScore.toFixed(2)}, ` +
          `coherent=${evaluation.isCoherent}, ` +
          `refusal=${evaluation.refusalDetected}`,
        );
      } catch (err) {
        api.logger.warn(`intelligence: agent_end evaluation failed: ${String(err)}`);
      }
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
    // Service Registration
    // ========================================================================

    // ========================================================================
    // Gateway Method: Dashboard Data
    // ========================================================================

    api.logger.info(`intelligence: registerGatewayMethod type = ${typeof api.registerGatewayMethod}`);
    try {
      api.registerGatewayMethod(
      "intelligence.dashboard",
      async (opts: any) => {
        const respond = opts.respond;
        try {
          const insights = await feedback.getInsights();
          const recentRaw = await feedback.getRecentEntries(20);
          const recent = recentRaw.map((entry) => ({
              timestamp: entry.timestamp,
              category: entry.category ?? "general",
              tier: entry.tier ?? "",
              confidence: entry.confidence,
              coherent: entry.coherent,
              refusalDetected: entry.refusalDetected ?? false,
              chainedExecution: entry.chainedExecution ?? false,
              complexity: entry.complexity,
            }));

          respond(true, {
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
          });
        } catch (err) {
          api.logger.warn(`intelligence: dashboard method failed: ${String(err)}`);
          respond(false, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    );
    api.logger.info("intelligence: gateway method registered successfully");
    } catch (regErr) {
      api.logger.warn(`intelligence: gateway method registration FAILED: ${String(regErr)}`);
    }

    api.registerService({
      id: "intelligence",
      start: () => api.logger.info("intelligence: pipeline active"),
      stop: () => api.logger.info("intelligence: pipeline stopped"),
    });
  },
};

export default intelligencePlugin;
