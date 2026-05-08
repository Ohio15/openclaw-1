import { danger } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { sleepWithAbort } from "./backoff.js";

export type TransportReadyResult = {
  ok: boolean;
  error?: string | null;
};

export type WaitForTransportReadyParams = {
  label: string;
  timeoutMs: number;
  logAfterMs?: number;
  logIntervalMs?: number;
  pollIntervalMs?: number;
  abortSignal?: AbortSignal;
  runtime: RuntimeEnv;
  check: () => Promise<TransportReadyResult>;
  /**
   * Optional fail-fast predicate. Evaluated before each probe and after
   * each failed probe. If it returns a non-empty reason, the readiness
   * wait throws immediately with that reason instead of polling out the
   * full timeout. HIGH #6 uses this to short-circuit the signal-cli
   * readiness wait when the daemon child has exited — without it, a
   * crashed daemon causes a 30s timeout for every gateway start.
   */
  failFast?: () => string | null | undefined;
};

export async function waitForTransportReady(params: WaitForTransportReadyParams): Promise<void> {
  const started = Date.now();
  const timeoutMs = Math.max(0, params.timeoutMs);
  const deadline = started + timeoutMs;
  const logAfterMs = Math.max(0, params.logAfterMs ?? timeoutMs);
  const logIntervalMs = Math.max(1_000, params.logIntervalMs ?? 30_000);
  const pollIntervalMs = Math.max(50, params.pollIntervalMs ?? 150);
  let nextLogAt = started + logAfterMs;
  let lastError: string | null = null;

  while (true) {
    if (params.abortSignal?.aborted) {
      return;
    }
    // HIGH #6: fail-fast pre-probe check. Lets the caller short-circuit
    // readiness — e.g. the signal-cli daemon child has exited and there
    // is nothing to wait for — instead of burning the full timeout.
    const failFastReason = params.failFast?.();
    if (failFastReason) {
      params.runtime.error?.(
        danger(`${params.label} aborted readiness wait (${failFastReason})`),
      );
      throw new Error(`${params.label} not ready (${failFastReason})`);
    }
    const res = await params.check();
    if (res.ok) {
      return;
    }
    lastError = res.error ?? null;

    // Re-check fail-fast after the probe — the child may have exited
    // during the check itself (e.g. the probe attempted a TCP connect
    // that the dying daemon refused as it shut down).
    const postProbeFailFast = params.failFast?.();
    if (postProbeFailFast) {
      params.runtime.error?.(
        danger(`${params.label} aborted readiness wait (${postProbeFailFast})`),
      );
      throw new Error(`${params.label} not ready (${postProbeFailFast})`);
    }

    const now = Date.now();
    if (now >= deadline) {
      break;
    }
    if (now >= nextLogAt) {
      const elapsedMs = now - started;
      params.runtime.error?.(
        danger(`${params.label} not ready after ${elapsedMs}ms (${lastError ?? "unknown error"})`),
      );
      nextLogAt = now + logIntervalMs;
    }

    try {
      await sleepWithAbort(pollIntervalMs, params.abortSignal);
    } catch (err) {
      if (params.abortSignal?.aborted) {
        return;
      }
      throw err;
    }
  }

  params.runtime.error?.(
    danger(`${params.label} not ready after ${timeoutMs}ms (${lastError ?? "unknown error"})`),
  );
  throw new Error(`${params.label} not ready (${lastError ?? "unknown error"})`);
}
