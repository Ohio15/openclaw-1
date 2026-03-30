/**
 * Container Sandbox — Executes tool operations in isolated Docker containers.
 *
 * Phase 1: Param modification approach — rewrites tool params to use `docker exec`.
 * Phase 2 (future): Full interception with synthetic result injection.
 */

import { type ContainerConfig } from "./tool-policy.js";

export interface SandboxResult {
  success: boolean;
  output: string;
  exitCode: number;
  containerId?: string;
  durationMs: number;
  violations: string[];
}

/**
 * Rewrite tool parameters to execute inside a Docker container.
 * This is the Phase 1 approach — modifies the command to run via `docker run`.
 */
export function rewriteForSandbox(
  toolName: string,
  params: Record<string, unknown>,
  config: ContainerConfig,
): Record<string, unknown> {
  // Only rewrite bash/shell-like tools
  if (!["bash", "shell", "execute", "run_command", "terminal"].includes(toolName)) {
    return params;
  }

  const command = extractCommand(params);
  if (!command) {
    return params;
  }

  const dockerArgs: string[] = [
    "docker", "run",
    "--rm",
    "--name", `openclaw-sandbox-${Date.now()}`,
    "--memory", config.memoryLimit,
    "--cpus", config.cpuLimit,
  ];

  if (config.networkDisabled) {
    dockerArgs.push("--network", "none");
  }

  if (config.readOnlyRootFs) {
    dockerArgs.push("--read-only");
  }

  if (config.workspaceMount) {
    const [hostPath, containerPath] = config.workspaceMount.includes(":")
      ? config.workspaceMount.split(":")
      : [config.workspaceMount, "/workspace"];
    dockerArgs.push("-v", `${hostPath}:${containerPath}`);
    dockerArgs.push("-w", containerPath === "ro" ? "/workspace" : containerPath);
  }

  // Add timeout
  dockerArgs.push("--stop-timeout", String(Math.ceil(config.timeout / 1000)));

  // Image and command
  dockerArgs.push(config.image);
  dockerArgs.push("/bin/sh", "-c", command);

  const sandboxedCommand = dockerArgs.join(" ");

  return {
    ...params,
    command: sandboxedCommand,
    _originalCommand: command,
    _sandboxed: true,
  };
}

/**
 * Extract the command string from tool params (handles various param shapes).
 */
function extractCommand(params: Record<string, unknown>): string | null {
  if (typeof params.command === "string") return params.command;
  if (typeof params.cmd === "string") return params.cmd;
  if (typeof params.input === "string") return params.input;
  if (typeof params.code === "string") return params.code;
  return null;
}

/**
 * Validate sandbox execution output for security violations.
 */
export function validateSandboxOutput(output: string): string[] {
  const violations: string[] = [];

  // Check for signs the sandbox was escaped
  if (/docker\s+run/i.test(output) && /--privileged/i.test(output)) {
    violations.push("Possible sandbox escape attempt: privileged container creation");
  }

  // Check for credential exposure
  if (/(?:password|secret|api.?key|token)\s*[:=]\s*\S+/i.test(output)) {
    violations.push("Possible credential exposure in output");
  }

  // Check for network activity when it should be disabled
  if (/curl|wget|nc\s+-|ncat|socat/i.test(output) && output.includes("network")) {
    violations.push("Network activity detected in sandboxed output");
  }

  return violations;
}

/**
 * Check if a tool result came from a sandboxed execution.
 */
export function isSandboxedResult(params: Record<string, unknown>): boolean {
  return params._sandboxed === true;
}

/**
 * Get the original (pre-sandbox) command from rewritten params.
 */
export function getOriginalCommand(params: Record<string, unknown>): string | null {
  return typeof params._originalCommand === "string" ? params._originalCommand : null;
}
