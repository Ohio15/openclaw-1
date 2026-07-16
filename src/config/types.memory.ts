import type { SessionSendPolicyConfig } from "./types.base.js";

export type MemoryBackend = "builtin" | "qmd";
export type MemoryCitationsMode = "auto" | "on" | "off";
export type MemoryQmdSearchMode = "query" | "search" | "vsearch";

export type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  qmd?: MemoryQmdConfig;
  brainIngest?: BrainIngestConfig;
};

/**
 * P4 W2.1 brain ingest bridge — forward inbound Signal messages to shared-brain.
 * OFF by default. The device private key is NEVER stored here; supply it via the
 * `OPENCLAW_BRAIN_INGEST_KEY` (inline PEM) or `OPENCLAW_BRAIN_INGEST_KEY_PATH`
 * env var (or the non-secret `keyPath` below). The master kill switch
 * `OPENCLAW_BRAIN_INGEST_ENABLED` overrides `enabled`.
 */
export type BrainIngestConfig = {
  /** Enable forwarding captures to shared-brain. Default false. */
  enabled?: boolean;
  /** shared-brain base URL, e.g. "https://shared-brain.us". */
  url?: string;
  /** Registered device id (uuid from POST /api/devices/register). */
  deviceId?: string;
  /** Path to the device's ed25519 private key PEM (PKCS8). Not a secret value. */
  keyPath?: string;
  /** Project tag applied to stored memories. */
  project?: string;
  /** Memory type override; when unset, shared-brain classifies. */
  type?: string;
  /** Importance for stored memories (0..1). Default 0.5. */
  importance?: number;
  /** Extra tags applied in addition to "openclaw" and the channel tag. */
  tags?: string[];
  /** Request timeout in ms. Default 5000. */
  timeoutMs?: number;
};

export type MemoryQmdConfig = {
  command?: string;
  searchMode?: MemoryQmdSearchMode;
  includeDefaultMemory?: boolean;
  paths?: MemoryQmdIndexPath[];
  sessions?: MemoryQmdSessionConfig;
  update?: MemoryQmdUpdateConfig;
  limits?: MemoryQmdLimitsConfig;
  scope?: SessionSendPolicyConfig;
};

export type MemoryQmdIndexPath = {
  path: string;
  name?: string;
  pattern?: string;
};

export type MemoryQmdSessionConfig = {
  enabled?: boolean;
  exportDir?: string;
  retentionDays?: number;
};

export type MemoryQmdUpdateConfig = {
  interval?: string;
  debounceMs?: number;
  onBoot?: boolean;
  waitForBootSync?: boolean;
  embedInterval?: string;
  commandTimeoutMs?: number;
  updateTimeoutMs?: number;
  embedTimeoutMs?: number;
};

export type MemoryQmdLimitsConfig = {
  maxResults?: number;
  maxSnippetChars?: number;
  maxInjectedChars?: number;
  timeoutMs?: number;
};
