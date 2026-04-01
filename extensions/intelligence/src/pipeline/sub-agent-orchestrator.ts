/**
 * SubAgentOrchestrator - Prompt-based agent chaining for complex requests
 *
 * Builds structured multi-step prompts that instruct the model to tackle
 * sub-tasks sequentially with tagged output sections. Evaluates per-section
 * quality and can generate refinement prompts for weak steps.
 *
 * This does NOT spawn sub-agents — it structures a single prompt so the model
 * produces chained reasoning within one generation pass.
 *
 * @module sub-agent-orchestrator
 */

// ============================================================================
// Types
// ============================================================================

export interface SubTask {
  name: string;
  description: string;
  priority: number;
  dependencies: string[];
}

// ============================================================================
// SubAgentOrchestrator
// ============================================================================

export class SubAgentOrchestrator {
  /**
   * Creates a structured multi-step prompt that instructs the model to tackle
   * sub-tasks sequentially, outputting results in tagged sections.
   */
  buildChainedPrompt(subTasks: SubTask[], domainContext: string | null): string {
    const lines: string[] = [];

    lines.push("## Multi-Step Task Execution");
    lines.push("");
    lines.push(
      "This request requires a structured, multi-step approach. " +
      "Complete each step in order, wrapping your output for each step in the specified tags.",
    );
    lines.push("");

    if (domainContext) {
      lines.push("### Domain Context");
      lines.push(domainContext);
      lines.push("");
    }

    for (let i = 0; i < subTasks.length; i++) {
      const stepNum = i + 1;
      const task = subTasks[i];

      lines.push(`### Step ${stepNum}: ${task.name}`);
      lines.push(task.description);

      if (task.dependencies.length > 0) {
        const depNames = task.dependencies.join(", ");
        lines.push(
          `Consider the output from the following prior step(s) when completing this step: ${depNames}.`,
        );
      } else if (i > 0) {
        lines.push(`Consider the output from Step ${i} when completing this step.`);
      }

      lines.push(
        `Output your work for this step between <step-${stepNum}> and </step-${stepNum}> tags.`,
      );
      lines.push("");
    }

    lines.push("### Final Integration");
    lines.push(
      "After completing all steps, provide a cohesive final answer that integrates " +
      "all step outputs between <final> and </final> tags.",
    );

    return lines.join("\n");
  }

  /**
   * Parses tagged sections from a model response.
   * Extracts <step-N>...</step-N> and <final>...</final> content.
   * Returns a map of tag name to trimmed content. Missing tags are omitted.
   */
  extractSubTaskOutputs(response: string): Map<string, string> {
    const outputs = new Map<string, string>();

    // Extract step-N tags
    const stepPattern = /<step-(\d+)>([\s\S]*?)<\/step-\1>/g;
    let match: RegExpExecArray | null;
    while ((match = stepPattern.exec(response)) !== null) {
      outputs.set(`step-${match[1]}`, match[2].trim());
    }

    // Extract final tag
    const finalPattern = /<final>([\s\S]*?)<\/final>/;
    const finalMatch = finalPattern.exec(response);
    if (finalMatch) {
      outputs.set("final", finalMatch[1].trim());
    }

    return outputs;
  }

}
