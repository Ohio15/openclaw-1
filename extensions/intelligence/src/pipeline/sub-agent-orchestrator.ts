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

export interface ChainEvaluation {
  /** Overall quality score 0-1 */
  overallQuality: number;
  /** Per-step quality scores */
  stepScores: Record<string, number>;
  /** Steps scoring below 0.5 */
  weakSteps: string[];
  /** Steps with no output found */
  missingSteps: string[];
  /** Whether <final> integration section exists */
  hasIntegration: boolean;
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

  /**
   * Evaluates the quality of chained output against the original sub-tasks.
   *
   * Quality scoring per step:
   * - Has content (non-empty): +0.3
   * - Content length > 100 chars: +0.2
   * - Contains code blocks if code-related: +0.2
   * - Addresses the sub-task description (keyword overlap): +0.3
   */
  evaluateChainedResult(
    subTasks: SubTask[],
    outputs: Map<string, string>,
  ): ChainEvaluation {
    const stepScores: Record<string, number> = {};
    const weakSteps: string[] = [];
    const missingSteps: string[] = [];

    for (let i = 0; i < subTasks.length; i++) {
      const stepKey = `step-${i + 1}`;
      const content = outputs.get(stepKey);

      if (content === undefined || content.length === 0) {
        stepScores[stepKey] = 0;
        missingSteps.push(stepKey);
        continue;
      }

      let score = 0;

      // Has content (non-empty)
      score += 0.3;

      // Content length > 100 chars
      if (content.length > 100) {
        score += 0.2;
      }

      // Contains code blocks (relevant for code-related tasks)
      const codeRelatedKeywords = /code|implement|function|class|method|script|program|fix|bug|api|endpoint/i;
      const isCodeRelated = codeRelatedKeywords.test(subTasks[i].description);
      if (isCodeRelated && /```/.test(content)) {
        score += 0.2;
      } else if (!isCodeRelated) {
        // Non-code tasks get the code bonus automatically
        score += 0.2;
      }

      // Keyword overlap with sub-task description
      const descriptionWords = this.extractKeywords(subTasks[i].description);
      const contentLower = content.toLowerCase();
      if (descriptionWords.length > 0) {
        const matchCount = descriptionWords.filter((w) =>
          contentLower.includes(w),
        ).length;
        const overlapRatio = matchCount / descriptionWords.length;
        score += 0.3 * overlapRatio;
      } else {
        // No keywords to check — give partial credit
        score += 0.15;
      }

      stepScores[stepKey] = Math.min(score, 1);

      if (score < 0.5) {
        weakSteps.push(stepKey);
      }
    }

    const hasIntegration = outputs.has("final") && (outputs.get("final")?.length ?? 0) > 0;

    // Overall quality: weighted average of step scores + integration bonus
    const stepKeys = Object.keys(stepScores);
    const totalStepScore = stepKeys.reduce((sum, k) => sum + stepScores[k], 0);
    const avgStepScore = stepKeys.length > 0 ? totalStepScore / stepKeys.length : 0;
    const integrationBonus = hasIntegration ? 0.1 : 0;
    const overallQuality = Math.min(avgStepScore + integrationBonus, 1);

    return {
      overallQuality,
      stepScores,
      weakSteps,
      missingSteps,
      hasIntegration,
    };
  }

  /**
   * Creates a focused follow-up prompt for steps that scored below threshold.
   * Includes the original output and asks for improvement.
   */
  buildRefinementPrompt(
    weakSteps: string[],
    originalOutputs: Map<string, string>,
  ): string {
    const lines: string[] = [];

    lines.push("## Refinement Required");
    lines.push("");
    lines.push(
      "The following steps from your previous response need improvement. " +
      "Please provide enhanced versions that are more thorough and complete.",
    );
    lines.push("");

    for (const stepKey of weakSteps) {
      const original = originalOutputs.get(stepKey) ?? "";

      lines.push(`### ${stepKey} — Needs Improvement`);

      if (original.length > 0) {
        lines.push("");
        lines.push("Your previous output:");
        lines.push("```");
        lines.push(original);
        lines.push("```");
        lines.push("");
        lines.push(
          "Please provide a more thorough, detailed, and complete version. " +
          "Address any gaps, add specifics, and ensure the response fully " +
          "covers the requirements for this step.",
        );
      } else {
        lines.push("");
        lines.push(
          "This step was missing from your previous response. " +
          "Please provide a complete answer for this step.",
        );
      }

      lines.push(
        `Wrap your improved output between <${stepKey}> and </${stepKey}> tags.`,
      );
      lines.push("");
    }

    lines.push(
      "After improving all steps, provide an updated final integration " +
      "between <final> and </final> tags.",
    );

    return lines.join("\n");
  }

  /**
   * Extract meaningful keywords from a description for overlap scoring.
   * Filters out common stop words and returns lowercase tokens.
   */
  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could",
      "should", "may", "might", "shall", "can", "need", "must", "ought",
      "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
      "into", "through", "during", "before", "after", "above", "below",
      "between", "out", "off", "over", "under", "again", "further", "then",
      "once", "and", "but", "or", "nor", "not", "so", "yet", "both",
      "each", "few", "more", "most", "other", "some", "such", "no",
      "only", "own", "same", "than", "too", "very", "just", "because",
      "this", "that", "these", "those", "it", "its", "they", "them",
      "their", "we", "our", "you", "your", "he", "she", "him", "her",
      "address", "aspect", "request",
    ]);

    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));
  }
}
