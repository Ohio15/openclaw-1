/**
 * CortexAdapter — Wraps @ron/cortex-core's ControlPlane behind OpenClaw's
 * intelligence plugin interface (analyzeBeforeAgent / evaluateAfterAgent).
 *
 * Drop-in replacement for IntelligenceControlPlane. The rest of the plugin
 * (hooks, feedback, orchestrator, CLI) remains unchanged.
 *
 * @module cortex-adapter
 */

import {
  ControlPlane,
  type ControlPlaneConfig,
  type BeforePromptResult,
  type ValidateResponseResult,
} from "@ron/cortex-core";
import type { BeforeAgentAnalysis, AfterAgentEvaluation } from "./control-plane.js";

// ============================================================================
// Config
// ============================================================================

export interface CortexAdapterConfig {
  enabled?: boolean;
  knowledgeSource?: "semantic" | "static" | "hybrid";
  brainUrl?: string;
  brainApiKey?: string;
}

// ============================================================================
// Adapter
// ============================================================================

export class CortexAdapter {
  private controlPlane: ControlPlane;

  constructor(config: CortexAdapterConfig = {}) {
    const cpConfig: Partial<ControlPlaneConfig> = {
      enabled: config.enabled ?? true,
      knowledgeSource: config.knowledgeSource ?? "hybrid",
      brainUrl: config.brainUrl,
      brainApiKey: config.brainApiKey,
    };
    this.controlPlane = new ControlPlane(cpConfig);
  }

  /**
   * Analyze messages BEFORE the agent runs.
   *
   * Extracts the user prompt, delegates to cortex-core's ControlPlane,
   * then maps BeforePromptResult -> BeforeAgentAnalysis.
   */
  async analyzeBeforeAgent(messages: unknown[]): Promise<BeforeAgentAnalysis> {
    const prompt = this.extractUserPrompt(messages);
    const result: BeforePromptResult = await this.controlPlane.analyzeBeforePrompt(prompt);

    return {
      complexity: result.complexity,
      subTasks: result.subTasks,
      tierSelection: result.tier,
      pipelineSelection: result.route,
      domain: result.domain,
      domainContext: result.brainContext,
      requirementCount: result.requirementCount,
    };
  }

  /**
   * Evaluate the agent's response AFTER it completes.
   *
   * Extracts the user prompt, delegates to cortex-core's ControlPlane,
   * then maps ValidateResponseResult -> AfterAgentEvaluation.
   */
  async evaluateAfterAgent(
    messages: unknown[],
    response: string,
  ): Promise<AfterAgentEvaluation> {
    const prompt = this.extractUserPrompt(messages);
    const result: ValidateResponseResult = await this.controlPlane.validateResponse(
      response,
      prompt,
    );

    return {
      confidenceScore: result.confidence,
      isCoherent: result.coherent,
      refusalDetected: result.refusalDetected,
      formattedContent: result.formattedContent,
      taskType: result.taskType,
    };
  }

  /**
   * Extract the last user message text from an OpenClaw message array.
   *
   * Handles both plain-string content and content-block arrays.
   * Reuses the same logic as IntelligenceControlPlane's extractUserPrompt.
   */
  private extractUserPrompt(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || typeof msg !== "object") continue;
      const m = msg as Record<string, unknown>;
      if (m.role !== "user") continue;

      if (typeof m.content === "string") return m.content;

      if (Array.isArray(m.content)) {
        const textParts: string[] = [];
        for (const block of m.content) {
          if (
            block &&
            typeof block === "object" &&
            (block as Record<string, unknown>).type === "text" &&
            typeof (block as Record<string, unknown>).text === "string"
          ) {
            textParts.push((block as Record<string, unknown>).text as string);
          }
        }
        return textParts.join("\n");
      }
    }
    return "";
  }
}
