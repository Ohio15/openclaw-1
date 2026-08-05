import type { BaseProbeResult } from "../channels/plugins/types.js";
import {
  signalCheck,
  signalRestAbout,
  signalRestAccounts,
  signalRpcRequest,
  type SignalTransport,
} from "./client.js";
import type { SignalTlsOptions } from "./tls.js";

export type SignalProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs: number;
  version?: string | null;
  /**
   * Which backend `version` came from. The two transports report unlike things
   * under the same field: "signal-cli" is the signal-cli daemon's own version
   * (json-rpc), "rest-api" is the bbernhard/signal-cli-rest-api *image* version
   * from /v1/about, which is not a signal-cli version at all. Consumers that
   * aggregate or compare versions must key on this; `version` itself keeps its
   * existing shape for backward compatibility.
   */
  versionSource?: "signal-cli" | "rest-api" | null;
};

function parseSignalVersion(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "object" && value !== null) {
    const version = (value as { version?: unknown }).version;
    if (typeof version === "string" && version.trim()) {
      return version.trim();
    }
  }
  return null;
}

/** Digits-only form used to compare a configured account to a registered one. */
function normalizeAccountNumber(value: string): string {
  return value.replace(/\D+/g, "");
}

/** Never log a full phone number; last 4 digits are enough to identify it. */
export function redactAccountNumber(value: string | null | undefined): string {
  const digits = normalizeAccountNumber(value ?? "");
  if (!digits) {
    return "***";
  }
  return `***${digits.slice(-4)}`;
}

let warnedMissingTransport = false;

/**
 * `transport` stays optional because {@link probeSignal} is re-exported to
 * third-party plugins (`runtime.channel.signal.probeSignal`, typed as
 * `typeof probeSignal`), so making it required would break their call sites at
 * compile time. Omitting it silently reproduces the bug this module exists to
 * fix — probing the signal-cli daemon paths against a REST backend — so warn
 * once per process instead of failing silently. Once per process, not per call:
 * the gateway health refresh probes every account on an interval and a
 * per-call warn would bury the signal it is meant to raise.
 */
function warnMissingTransportOnce(): void {
  if (warnedMissingTransport) {
    return;
  }
  warnedMissingTransport = true;
  console.warn(
    '[signal] probeSignal() called without an explicit transport; defaulting to "json-rpc". ' +
      'Pass transport (and the account for "rest") or the probe will report a REST backend ' +
      "as unhealthy and cannot verify account registration.",
  );
}

/**
 * Health probe for a Signal backend.
 *
 * On "rest" (bbernhard/signal-cli-rest-api) liveness alone is not a useful
 * answer: `/v1/health` is container-level and account-blind, so several
 * accounts sharing one container all report green off a single HTTP server
 * being up — including when a number is unregistered and cannot send. This
 * probe feeds a dead-man's-switch alerting path, so the account is verified
 * against `/v1/accounts` and every uncertainty fails closed.
 *
 * @param account E.164 sender number. Required on the "rest" transport;
 *   ignored on "json-rpc", whose behavior is unchanged.
 * @param tls Client-certificate material when the backend sits behind an mTLS
 *   front. Omitted on plaintext deployments, where every request is unchanged.
 */
export async function probeSignal(
  baseUrl: string,
  timeoutMs: number,
  transport?: SignalTransport,
  account?: string | null,
  tls?: SignalTlsOptions,
): Promise<SignalProbe> {
  if (!transport) {
    warnMissingTransportOnce();
  }
  const resolvedTransport: SignalTransport = transport ?? "json-rpc";
  const started = Date.now();
  const result: SignalProbe = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0,
    version: null,
    versionSource: null,
  };
  const check = await signalCheck(baseUrl, timeoutMs, resolvedTransport, tls);
  if (!check.ok) {
    return {
      ...result,
      status: check.status ?? null,
      error: check.error ?? "unreachable",
      elapsedMs: Date.now() - started,
    };
  }

  if (resolvedTransport === "rest") {
    const trimmedAccount = account?.trim();
    if (!trimmedAccount) {
      // Skipping the check here would restore exactly the false green this
      // probe exists to remove, so an unconfigured account is an error.
      return {
        ...result,
        status: check.status ?? null,
        error:
          "Signal REST probe requires the account's E.164 number (channels.signal.account) to verify registration",
        elapsedMs: Date.now() - started,
      };
    }
    let registered: string[];
    try {
      registered = await signalRestAccounts(baseUrl, timeoutMs, tls);
    } catch (err) {
      // Fail closed: an unreadable account list is not evidence of health.
      return {
        ...result,
        status: check.status ?? null,
        error: `Signal REST account check failed: ${err instanceof Error ? err.message : String(err)}`,
        elapsedMs: Date.now() - started,
      };
    }
    const wanted = normalizeAccountNumber(trimmedAccount);
    const present = registered.some((entry) => normalizeAccountNumber(entry) === wanted);
    if (!present) {
      return {
        ...result,
        status: check.status ?? null,
        error: `Signal account ${redactAccountNumber(trimmedAccount)} not registered on signal-api (${registered.length} registered account(s))`,
        elapsedMs: Date.now() - started,
      };
    }
  }

  try {
    // "rest" (bbernhard/signal-cli-rest-api) serves no RPC endpoint — POSTing
    // `version` to /api/v1/rpc 404s there. Its build info is on GET /v1/about.
    const version =
      resolvedTransport === "rest"
        ? await signalRestAbout(baseUrl, timeoutMs, tls)
        : await signalRpcRequest("version", undefined, {
            baseUrl,
            timeoutMs,
            tls,
          });
    result.version = parseSignalVersion(version);
    result.versionSource = result.version
      ? resolvedTransport === "rest"
        ? "rest-api"
        : "signal-cli"
      : null;
  } catch (err) {
    // Cosmetic only: the version banner is not load-bearing for health.
    result.error = err instanceof Error ? err.message : String(err);
  }
  return {
    ...result,
    ok: true,
    status: check.status ?? null,
    elapsedMs: Date.now() - started,
  };
}
