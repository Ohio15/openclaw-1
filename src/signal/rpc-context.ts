import { loadConfig } from "../config/config.js";
import { resolveSignalAccount } from "./accounts.js";
import type { SignalTransport } from "./client.js";

export function resolveSignalRpcContext(
  opts: { baseUrl?: string; account?: string; accountId?: string; transport?: SignalTransport },
  accountInfo?: ReturnType<typeof resolveSignalAccount>,
) {
  const hasBaseUrl = Boolean(opts.baseUrl?.trim());
  const hasAccount = Boolean(opts.account?.trim());
  const resolvedAccount =
    accountInfo ||
    (!hasBaseUrl || !hasAccount
      ? resolveSignalAccount({
          cfg: loadConfig(),
          accountId: opts.accountId,
        })
      : undefined);
  const baseUrl = opts.baseUrl?.trim() || resolvedAccount?.baseUrl;
  if (!baseUrl) {
    throw new Error("Signal base URL is required");
  }
  const account = opts.account?.trim() || resolvedAccount?.config.account?.trim();
  const transport: SignalTransport =
    opts.transport ?? resolvedAccount?.config.transport ?? "json-rpc";
  return { baseUrl, account, transport };
}
