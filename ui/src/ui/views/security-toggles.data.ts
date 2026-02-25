export type ToggleOption = {
  label: string;
  value: string;
};

export type ToggleMeta = {
  key: string;
  label: string;
  description: string;
  configPath: (string | number)[];
  type: "select" | "boolean" | "tags";
  options?: ToggleOption[];
  restartRequired?: boolean;
};

export type ToggleGroup = {
  id: string;
  label: string;
  description: string;
  toggles: ToggleMeta[];
};

export const SECURITY_TOGGLE_GROUPS: ToggleGroup[] = [
  {
    id: "sandbox",
    label: "Sandbox",
    description: "Process isolation for agent command execution.",
    toggles: [
      {
        key: "sandbox.mode",
        label: "Sandbox Mode",
        description: "Which agent sessions are sandboxed.",
        configPath: ["agents", "defaults", "sandbox", "mode"],
        type: "select",
        options: [
          { label: "Off", value: "off" },
          { label: "Non-main only", value: "non-main" },
          { label: "All sessions", value: "all" },
        ],
      },
      {
        key: "sandbox.scope",
        label: "Sandbox Scope",
        description: "Lifetime of sandbox containers.",
        configPath: ["agents", "defaults", "sandbox", "scope"],
        type: "select",
        options: [
          { label: "Session", value: "session" },
          { label: "Run", value: "run" },
        ],
      },
    ],
  },
  {
    id: "tools",
    label: "Tools",
    description: "Tool access policies and restrictions.",
    toggles: [
      {
        key: "tools.elevated",
        label: "Elevated Exec",
        description: "Allow elevated (sudo/admin) command execution.",
        configPath: ["tools", "elevated", "enabled"],
        type: "boolean",
      },
      {
        key: "tools.fs.workspaceOnly",
        label: "FS: Workspace Only",
        description: "Restrict filesystem access to the workspace directory.",
        configPath: ["tools", "fs", "workspaceOnly"],
        type: "boolean",
      },
      {
        key: "tools.exec.security",
        label: "Exec Security",
        description: "Command execution security policy.",
        configPath: ["tools", "exec", "security"],
        type: "select",
        options: [
          { label: "Open", value: "open" },
          { label: "Allowlist", value: "allowlist" },
          { label: "Off", value: "off" },
        ],
      },
      {
        key: "tools.exec.ask",
        label: "Exec Ask Mode",
        description: "When to prompt for approval on unrecognized commands.",
        configPath: ["tools", "exec", "ask"],
        type: "select",
        options: [
          { label: "Always", value: "always" },
          { label: "On Miss", value: "on-miss" },
          { label: "Never", value: "never" },
        ],
      },
      {
        key: "tools.message.crossContext",
        label: "Cross-Provider Messages",
        description: "Allow messages across different model providers.",
        configPath: ["tools", "message", "crossContext", "allowAcrossProviders"],
        type: "boolean",
      },
      {
        key: "tools.sessions.visibility",
        label: "Session Visibility",
        description: "Session tree visibility policy.",
        configPath: ["tools", "sessions", "visibility"],
        type: "select",
        options: [
          { label: "Tree", value: "tree" },
          { label: "Flat", value: "flat" },
          { label: "Isolated", value: "isolated" },
        ],
      },
    ],
  },
  {
    id: "gateway",
    label: "Gateway & Auth",
    description: "Gateway binding and authentication settings.",
    toggles: [
      {
        key: "gateway.bind",
        label: "Gateway Bind",
        description: "Network interface the gateway listens on.",
        configPath: ["gateway", "bind"],
        type: "select",
        options: [
          { label: "Loopback", value: "loopback" },
          { label: "LAN", value: "lan" },
          { label: "All", value: "all" },
        ],
        restartRequired: true,
      },
      {
        key: "gateway.auth.mode",
        label: "Auth Mode",
        description: "Authentication method for gateway access.",
        configPath: ["gateway", "auth", "mode"],
        type: "select",
        options: [
          { label: "Token", value: "token" },
          { label: "Password", value: "password" },
          { label: "Trusted Proxy", value: "trusted-proxy" },
          { label: "None", value: "none" },
        ],
        restartRequired: true,
      },
      {
        key: "logging.redactSensitive",
        label: "Log Redaction",
        description: "Redact sensitive data from log output.",
        configPath: ["logging", "redactSensitive"],
        type: "select",
        options: [
          { label: "Tools", value: "tools" },
          { label: "All", value: "all" },
          { label: "Off", value: "off" },
        ],
      },
    ],
  },
];
