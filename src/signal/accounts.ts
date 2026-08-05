import { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SignalAccountConfig } from "../config/types.js";
import { normalizeAccountId } from "../routing/session-key.js";

export type ResolvedSignalAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  baseUrl: string;
  configured: boolean;
  config: SignalAccountConfig;
};

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("signal");
export const listSignalAccountIds = listAccountIds;
export const resolveDefaultSignalAccountId = resolveDefaultAccountId;

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): SignalAccountConfig | undefined {
  const accounts = cfg.channels?.signal?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as SignalAccountConfig | undefined;
}

function mergeSignalAccountConfig(cfg: OpenClawConfig, accountId: string): SignalAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.signal ?? {}) as SignalAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  // An own key whose value is `undefined` is an ABSENT override, not a request to
  // clear the inherited value. A plain spread says otherwise, and the config
  // validator does not: it merges this block with `account.x ?? channel.x`, so a
  // spread here would hand back a view no validator inspected — an account with
  // `tlsCertFile: undefined` over a complete channel block validates green and
  // then throws at send time, and one with all three undefined slips past the
  // blank-override guard and resolves certless. Filtering makes the runtime agree
  // with the accepted-config contract; it only changes shapes that were already
  // broken.
  const overrides = Object.fromEntries(
    Object.entries(account).filter(([, value]) => value !== undefined),
  );
  return { ...base, ...overrides };
}

export function resolveSignalAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedSignalAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.signal?.enabled !== false;
  const merged = mergeSignalAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const host = merged.httpHost?.trim() || "127.0.0.1";
  const port = merged.httpPort ?? 8080;
  const baseUrl = merged.httpUrl?.trim() || `http://${host}:${port}`;
  const configured = Boolean(
    merged.account?.trim() ||
    merged.httpUrl?.trim() ||
    merged.cliPath?.trim() ||
    merged.httpHost?.trim() ||
    typeof merged.httpPort === "number" ||
    typeof merged.autoStart === "boolean",
  );
  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    baseUrl,
    configured,
    config: merged,
  };
}

export function listEnabledSignalAccounts(cfg: OpenClawConfig): ResolvedSignalAccount[] {
  return listSignalAccountIds(cfg)
    .map((accountId) => resolveSignalAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
