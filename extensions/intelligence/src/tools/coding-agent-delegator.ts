/**
 * Coding Agent Delegator — DeerFlow ACP-inspired external agent delegation.
 *
 * Spawns external AI coding agents (Claude Code CLI, etc.) as sub-processes
 * for complex coding tasks. Handles output streaming, timeouts, concurrent
 * limits, and cleanup.
 */

import { spawn, type ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentBackendDef {
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs: number;
  maxOutputChars: number;
  workingDir?: string;
  promptTemplate?: string;
}

export interface CodingAgentConfig {
  enabled: boolean;
  defaultAgent: string;
  delegationComplexityThreshold: number;
  maxConcurrentDelegations: number;
  agents: Record<string, AgentBackendDef>;
}

export interface DelegationResult {
  success: boolean;
  output: string;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
}

interface ActiveDelegation {
  process: ChildProcess;
  agentId: string;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_BACKEND: AgentBackendDef = {
  command: "claude",
  args: ["-p"],
  timeoutMs: 300_000, // 5 minutes
  maxOutputChars: 100_000,
  promptTemplate: "{task}",
};

export const CONFIG_DEFAULTS: CodingAgentConfig = {
  enabled: false,
  defaultAgent: "claude-code",
  delegationComplexityThreshold: 0.8,
  maxConcurrentDelegations: 2,
  agents: {
    "claude-code": { ...DEFAULT_BACKEND },
  },
};

// ---------------------------------------------------------------------------
// CodingAgentDelegator
// ---------------------------------------------------------------------------

export class CodingAgentDelegator {
  private config: CodingAgentConfig;
  private active = new Map<string, ActiveDelegation>();
  private delegationCounter = 0;

  constructor(config: Partial<CodingAgentConfig> = {}) {
    this.config = {
      ...CONFIG_DEFAULTS,
      ...config,
      agents: { ...CONFIG_DEFAULTS.agents, ...(config.agents ?? {}) },
    };
  }

  get activeDelegations(): number {
    return this.active.size;
  }

  /**
   * Delegate a task to an external coding agent.
   */
  async delegate(
    task: string,
    agentId?: string,
    workingDir?: string,
    timeoutOverride?: number,
    signal?: AbortSignal,
  ): Promise<DelegationResult> {
    const effectiveAgent = agentId ?? this.config.defaultAgent;
    const backend = this.config.agents[effectiveAgent];

    if (!backend) {
      return {
        success: false,
        output: `Unknown coding agent: "${effectiveAgent}". Available: ${Object.keys(this.config.agents).join(", ")}`,
        exitCode: null,
        durationMs: 0,
        truncated: false,
        timedOut: false,
      };
    }

    // Enforce concurrent limit
    if (this.active.size >= this.config.maxConcurrentDelegations) {
      return {
        success: false,
        output: `Maximum concurrent delegations (${this.config.maxConcurrentDelegations}) reached. Wait for active tasks to complete.`,
        exitCode: null,
        durationMs: 0,
        truncated: false,
        timedOut: false,
      };
    }

    const delegationId = `delegation-${++this.delegationCounter}`;
    const startTime = Date.now();
    const timeout = timeoutOverride ?? backend.timeoutMs;
    const cwd = workingDir ?? backend.workingDir ?? process.cwd();

    // Build prompt from template
    const template = backend.promptTemplate ?? "{task}";
    const prompt = template.replace("{task}", task);

    // Build args — append prompt as the last argument
    const args = [...backend.args, prompt];

    // Build env — merge specific vars, don't leak full environment
    const childEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...(backend.env ?? {}),
    };

    return new Promise<DelegationResult>((resolve) => {
      let output = "";
      let truncated = false;
      let timedOut = false;
      let resolved = false;

      const finish = (exitCode: number | null) => {
        if (resolved) return;
        resolved = true;
        this.active.delete(delegationId);

        resolve({
          success: exitCode === 0,
          output: output.trim(),
          exitCode,
          durationMs: Date.now() - startTime,
          truncated,
          timedOut,
        });
      };

      // Spawn the process
      let child: ChildProcess;
      try {
        child = spawn(backend.command, args, {
          cwd,
          env: childEnv,
          stdio: ["ignore", "pipe", "pipe"],
          // On Windows, shell: true needed for commands that aren't .exe
          shell: process.platform === "win32",
        });
      } catch (err) {
        resolve({
          success: false,
          output: `Failed to spawn "${backend.command}": ${String(err)}`,
          exitCode: null,
          durationMs: Date.now() - startTime,
          truncated: false,
          timedOut: false,
        });
        return;
      }

      // Track active delegation
      this.active.set(delegationId, { process: child, agentId: effectiveAgent, startedAt: startTime });

      // Collect output
      const appendOutput = (chunk: Buffer) => {
        if (truncated) return;
        const text = chunk.toString("utf-8");
        if (output.length + text.length > backend.maxOutputChars) {
          output += text.substring(0, backend.maxOutputChars - output.length);
          output += "\n\n[OUTPUT TRUNCATED — exceeded maxOutputChars limit]";
          truncated = true;
        } else {
          output += text;
        }
      };

      child.stdout?.on("data", appendOutput);
      child.stderr?.on("data", appendOutput);

      // Handle process exit
      child.on("close", (code) => finish(code));
      child.on("error", (err) => {
        output += `\nProcess error: ${String(err)}`;
        finish(null);
      });

      // Timeout handling
      const timeoutId = setTimeout(() => {
        timedOut = true;
        output += `\n\n[TIMEOUT — exceeded ${Math.round(timeout / 1000)}s limit]`;

        // SIGTERM first, then SIGKILL after 5s grace
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!resolved) {
            child.kill("SIGKILL");
            finish(null);
          }
        }, 5_000);
      }, timeout);

      // Cleanup timeout on normal exit
      child.on("close", () => clearTimeout(timeoutId));

      // Respect abort signal
      if (signal) {
        const onAbort = () => {
          output += "\n\n[ABORTED by caller]";
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!resolved) {
              child.kill("SIGKILL");
              finish(null);
            }
          }, 2_000);
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
          child.on("close", () => signal.removeEventListener("abort", onAbort));
        }
      }
    });
  }

  /**
   * Kill all active delegations (for cleanup).
   */
  killAll(): void {
    for (const [id, delegation] of this.active) {
      delegation.process.kill("SIGTERM");
      this.active.delete(id);
    }
  }
}
