/**
 * Tool definition for coding agent delegation.
 *
 * Registers a `delegate_to_coding_agent` tool that the LLM can invoke
 * to hand off complex coding tasks to external AI agents (Claude Code CLI, etc.).
 */

import { Type } from "@sinclair/typebox";
import { CodingAgentDelegator, type CodingAgentConfig } from "./coding-agent-delegator.js";

interface PluginLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * Creates the delegate_to_coding_agent tool for registration via api.registerTool().
 */
export function createDelegateCodingAgentTool(
  delegator: CodingAgentDelegator,
  config: CodingAgentConfig,
  logger: PluginLogger,
) {
  const availableAgents = Object.keys(config.agents).join(", ");

  return {
    name: "delegate_to_coding_agent",
    label: "Delegate to Coding Agent",
    description:
      `Delegate a complex coding task to an external AI coding agent (e.g., Claude Code CLI). ` +
      `Use this for tasks that require deep codebase exploration, multi-file changes, or complex implementations ` +
      `that would benefit from a dedicated coding session. ` +
      `Available agents: ${availableAgents}. ` +
      `The agent runs as a sub-process and returns its complete output.`,
    parameters: Type.Object({
      task: Type.String({
        description:
          "Clear, detailed description of the coding task. Include file paths, requirements, " +
          "and expected outcomes. The more specific, the better the result.",
      }),
      agent: Type.Optional(
        Type.String({
          description: `Which coding agent backend to use. Available: ${availableAgents}. Default: ${config.defaultAgent}`,
        }),
      ),
      workingDir: Type.Optional(
        Type.String({
          description: "Working directory for the coding agent. Defaults to session workspace.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description: "Timeout in milliseconds. Default depends on agent configuration.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { task: string; agent?: string; workingDir?: string; timeoutMs?: number },
      signal?: AbortSignal,
    ) {
      const { task, agent, workingDir, timeoutMs } = params;

      logger.info(
        `intelligence: delegating coding task to ${agent ?? config.defaultAgent} ` +
        `(${task.length} chars, timeout=${timeoutMs ?? "default"})`,
      );

      const result = await delegator.delegate(task, agent, workingDir, timeoutMs, signal);

      logger.info(
        `intelligence: delegation complete — success=${result.success}, ` +
        `exit=${result.exitCode}, duration=${result.durationMs}ms, ` +
        `truncated=${result.truncated}, timedOut=${result.timedOut}`,
      );

      // Format output for the agent
      const parts: string[] = [];

      if (result.timedOut) {
        parts.push("**WARNING: The coding agent timed out.** Partial output below:\n");
      }

      if (!result.success && !result.timedOut) {
        parts.push(`**Coding agent exited with code ${result.exitCode}.**\n`);
      }

      if (result.output) {
        parts.push(result.output);
      } else {
        parts.push("(No output produced by the coding agent.)");
      }

      if (result.truncated) {
        parts.push("\n**Note: Output was truncated due to size limits.**");
      }

      parts.push(
        `\n---\nDelegation stats: agent=${agent ?? config.defaultAgent}, ` +
        `duration=${Math.round(result.durationMs / 1000)}s, ` +
        `exit=${result.exitCode}`,
      );

      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
        details: {
          success: result.success,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          truncated: result.truncated,
          timedOut: result.timedOut,
          agent: agent ?? config.defaultAgent,
        },
      };
    },
  };
}
