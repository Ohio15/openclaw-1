import type { OpenClawConfig } from "../../config/config.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { getOwnProperty, hasOwnKey } from "../../safe-object.js";
import type { ChannelId } from "./types.js";

type ChannelConfigWithAccounts = {
  configWrites?: boolean;
  accounts?: Record<string, { configWrites?: boolean }>;
};

function resolveAccountConfig(accounts: ChannelConfigWithAccounts["accounts"], accountId: string) {
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  // Own-only: `"constructor" in accounts` is true on every object, so an operator
  // who denies config writes for an account named "constructor" would get the
  // global `Object` back, whose `configWrites` is undefined — the deny silently
  // degrades to the channel-level default, which fails OPEN.
  const record = accounts as Record<string, unknown>;
  if (hasOwnKey(record, accountId)) {
    return getOwnProperty(record, accountId) as { configWrites?: boolean } | undefined;
  }
  const matchKey = Object.keys(accounts).find(
    (key) => key.toLowerCase() === accountId.toLowerCase(),
  );
  return matchKey
    ? (getOwnProperty(record, matchKey) as { configWrites?: boolean } | undefined)
    : undefined;
}

export function resolveChannelConfigWrites(params: {
  cfg: OpenClawConfig;
  channelId?: ChannelId | null;
  accountId?: string | null;
}): boolean {
  if (!params.channelId) {
    return true;
  }
  const channels = params.cfg.channels as Record<string, ChannelConfigWithAccounts> | undefined;
  const channelConfig = channels?.[params.channelId];
  if (!channelConfig) {
    return true;
  }
  const accountId = normalizeAccountId(params.accountId);
  const accountConfig = resolveAccountConfig(channelConfig.accounts, accountId);
  const value = accountConfig?.configWrites ?? channelConfig.configWrites;
  return value !== false;
}
