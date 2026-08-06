import { normalizeChannelId } from "../channels/plugins/index.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { getOwnProperty } from "../safe-object.js";
import type { OpenClawConfig } from "./config.js";
import type { TelegramCapabilitiesConfig } from "./types.telegram.js";

type CapabilitiesConfig = TelegramCapabilitiesConfig;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

function normalizeCapabilities(capabilities: CapabilitiesConfig | undefined): string[] | undefined {
  // Handle object-format capabilities (e.g., { inlineButtons: "dm" }) gracefully.
  // Channel-specific handlers (like resolveTelegramInlineButtonsScope) process these separately.
  if (!isStringArray(capabilities)) {
    return undefined;
  }
  const normalized = capabilities.map((entry) => entry.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function resolveAccountCapabilities(params: {
  cfg?: { accounts?: Record<string, { capabilities?: CapabilitiesConfig }> } & {
    capabilities?: CapabilitiesConfig;
  };
  accountId?: string | null;
}): string[] | undefined {
  const cfg = params.cfg;
  if (!cfg) {
    return undefined;
  }
  const normalizedAccountId = normalizeAccountId(params.accountId);

  const accounts = cfg.accounts;
  if (accounts && typeof accounts === "object") {
    // Own-only: a bare `accounts[id]` answers "constructor" — a reachable,
    // already-normalized account id — with the truthy global `Object`, so the
    // case-insensitive scan below never runs for a configured "Constructor".
    const record = accounts as Record<string, unknown>;
    type AccountEntry = { capabilities?: CapabilitiesConfig };
    const direct = getOwnProperty(record, normalizedAccountId) as AccountEntry | undefined;
    if (direct) {
      return normalizeCapabilities(direct.capabilities) ?? normalizeCapabilities(cfg.capabilities);
    }
    const matchKey = Object.keys(accounts).find(
      (key) => key.toLowerCase() === normalizedAccountId.toLowerCase(),
    );
    const match = matchKey
      ? (getOwnProperty(record, matchKey) as AccountEntry | undefined)
      : undefined;
    if (match) {
      return normalizeCapabilities(match.capabilities) ?? normalizeCapabilities(cfg.capabilities);
    }
  }

  return normalizeCapabilities(cfg.capabilities);
}

export function resolveChannelCapabilities(params: {
  cfg?: Partial<OpenClawConfig>;
  channel?: string | null;
  accountId?: string | null;
}): string[] | undefined {
  const cfg = params.cfg;
  const channel = normalizeChannelId(params.channel);
  if (!cfg || !channel) {
    return undefined;
  }

  const channelsConfig = cfg.channels as Record<string, unknown> | undefined;
  const channelConfig = (channelsConfig?.[channel] ?? (cfg as Record<string, unknown>)[channel]) as
    | {
        accounts?: Record<string, { capabilities?: CapabilitiesConfig }>;
        capabilities?: CapabilitiesConfig;
      }
    | undefined;
  return resolveAccountCapabilities({
    cfg: channelConfig,
    accountId: params.accountId,
  });
}
