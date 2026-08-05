import type { BaseTokenResolution } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import { getOwnProperty } from "../safe-object.js";

export type DiscordTokenSource = "env" | "config" | "none";

export type DiscordTokenResolution = BaseTokenResolution & {
  source: DiscordTokenSource;
};

export function normalizeDiscordToken(raw?: string | null): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^Bot\s+/i, "");
}

export function resolveDiscordToken(
  cfg?: OpenClawConfig,
  opts: { accountId?: string | null; envToken?: string | null } = {},
): DiscordTokenResolution {
  const accountId = normalizeAccountId(opts.accountId);
  const discordCfg = cfg?.channels?.discord;
  // Own-only lookup: a bare `accounts[id]` answers "__proto__"/"constructor"
  // with a prototype object for configs that never defined them, which would
  // hand token resolution a non-account object instead of falling through to the
  // channel-level token.
  const accounts = discordCfg?.accounts as Record<string, unknown> | undefined;
  const accountCfg = accounts
    ? (getOwnProperty(accounts, accountId) as { token?: string | null } | undefined)
    : undefined;
  const accountToken = normalizeDiscordToken(accountCfg?.token ?? undefined);
  if (accountToken) {
    return { token: accountToken, source: "config" };
  }

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const configToken = allowEnv ? normalizeDiscordToken(discordCfg?.token ?? undefined) : undefined;
  if (configToken) {
    return { token: configToken, source: "config" };
  }

  const envToken = allowEnv
    ? normalizeDiscordToken(opts.envToken ?? process.env.DISCORD_BOT_TOKEN)
    : undefined;
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  return { token: "", source: "none" };
}
