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

    api.logger.info("intelligence: plugin registered");

    // ========================================================================
    // Hook: before_prompt_build
    // Analyze complexity, detect domain, inject domain knowledge context
    // ========================================================================

    api.on("before_prompt_build", async (event) => {
      if (!enabled) return;

      const messages = event.messages as unknown[];
      if (!messages || messages.length === 0) return;

      try {
        const analysis = controlPlane.analyzeBeforeAgent(messages);

        api.logger.info(
          `intelligence: complexity=${analysis.complexity.toFixed(2)}, ` +
          `tier=${analysis.tierSelection.tier}, ` +
          `pipeline=${analysis.pipelineSelection.pipeline}, ` +
          `domain=${analysis.domain ?? "none"}`,
        );

        // Inject domain context into the prompt if available
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
        // (cheap — all synchronous in-memory operations)
        const analysis = messages && messages.length > 0
          ? controlPlane.analyzeBeforeAgent(messages)
          : null;

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

    api.registerService({
      id: "intelligence",
      start: () => api.logger.info("intelligence: pipeline active"),
      stop: () => api.logger.info("intelligence: pipeline stopped"),
    });
  },
};

export default intelligencePlugin;
