/**
 * Preset configuration loaded from YAML files.
 * Mirrors the Python PresetConfig dataclass from Claude Gateway.
 */
export type PresetConfig = {
  name: string;
  display_name: string;
  description: string;
  system_prompt: string;
  allowed_tools: string[];
  mcp_config?: string;
  working_directory?: string;
  schedule?: string;
  tags: string[];
  max_turns?: number;
};

export type PresetRunResult = {
  presetName: string;
  sessionId?: string;
  status: "ok" | "error";
  durationMs: number;
  alertSeverity?: "info" | "warning" | "critical";
  summary?: string;
};

export type ClaudeGatewayConfig = {
  enabled?: boolean;
  presetsDir?: string;
  delivery?: {
    mode?: "none" | "announce" | "webhook";
    channel?: string;
    to?: string;
  };
  alertKeywords?: string[];
};
