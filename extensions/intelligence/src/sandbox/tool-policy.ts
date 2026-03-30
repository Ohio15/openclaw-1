/**
 * Tool Security Policy — Determines which tools should run in sandboxed containers.
 */

export interface ContainerConfig {
  image: string;
  memoryLimit: string;
  cpuLimit: string;
  timeout: number;
  networkDisabled: boolean;
  readOnlyRootFs: boolean;
  workspaceMount?: string;
}

export interface PolicyDecision {
  shouldSandbox: boolean;
  reason: string;
  containerConfig?: ContainerConfig;
}

const DEFAULT_CONTAINER_CONFIG: ContainerConfig = {
  image: "node:22-bookworm-slim",
  memoryLimit: "256m",
  cpuLimit: "1.0",
  timeout: 30_000,
  networkDisabled: true,
  readOnlyRootFs: false,
  workspaceMount: "/workspace:ro",
};

const SANDBOXED_TOOLS = new Set([
  "bash",
  "shell",
  "computer",
  "execute",
  "run_command",
  "terminal",
]);

const EXEMPT_TOOLS = new Set([
  "memory_search",
  "memory_get",
  "memory_store",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
]);

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+[\/~]/i,
  /mkfs\b/i,
  /dd\s+if=/i,
  />\s*\/dev\/sd/i,
  /chmod\s+777/i,
  /curl\s+.*\|\s*(bash|sh)/i,
  /wget\s+.*\|\s*(bash|sh)/i,
  /eval\s*\(/,
  /exec\s*\(/,
];

export class ToolSecurityPolicy {
  private customSandboxed: Set<string>;
  private customExempt: Set<string>;
  private enabled: boolean;

  constructor(config?: {
    enabled?: boolean;
    additionalSandboxed?: string[];
    additionalExempt?: string[];
  }) {
    this.enabled = config?.enabled ?? true;
    this.customSandboxed = new Set(config?.additionalSandboxed ?? []);
    this.customExempt = new Set(config?.additionalExempt ?? []);
  }

  /**
   * Determine whether a tool call should be sandboxed.
   */
  shouldSandbox(toolName: string, params?: Record<string, unknown>): PolicyDecision {
    if (!this.enabled) {
      return { shouldSandbox: false, reason: "sandboxing disabled" };
    }

    // Exempt tools never get sandboxed
    if (EXEMPT_TOOLS.has(toolName) || this.customExempt.has(toolName)) {
      return { shouldSandbox: false, reason: "exempt tool" };
    }

    // Explicitly sandboxed tools
    if (SANDBOXED_TOOLS.has(toolName) || this.customSandboxed.has(toolName)) {
      return {
        shouldSandbox: true,
        reason: `tool "${toolName}" is in sandbox list`,
        containerConfig: this.getContainerConfig(toolName, params),
      };
    }

    // Check params for dangerous patterns
    if (params) {
      const paramsStr = JSON.stringify(params);
      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(paramsStr)) {
          return {
            shouldSandbox: true,
            reason: `dangerous pattern detected: ${pattern.source}`,
            containerConfig: this.getContainerConfig(toolName, params),
          };
        }
      }
    }

    return { shouldSandbox: false, reason: "no sandbox required" };
  }

  /**
   * Get container configuration for a specific tool.
   */
  getContainerConfig(
    toolName: string,
    _params?: Record<string, unknown>,
  ): ContainerConfig {
    // Browser/computer tools need more resources
    if (toolName === "computer" || toolName === "browser") {
      return {
        ...DEFAULT_CONTAINER_CONFIG,
        image: "mcr.microsoft.com/playwright:v1.58.0",
        memoryLimit: "512m",
        cpuLimit: "2.0",
        timeout: 60_000,
      };
    }

    return { ...DEFAULT_CONTAINER_CONFIG };
  }
}
