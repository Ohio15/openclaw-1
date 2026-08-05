import { logVerbose, shouldLogVerbose } from "../globals.js";
import type { BackoffPolicy } from "../infra/backoff.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import type { RuntimeEnv } from "../runtime.js";
import { type SignalSseEvent, streamSignalEvents, streamSignalWsEvents } from "./client.js";
import type { SignalTlsOptions } from "./tls.js";

const DEFAULT_RECONNECT_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 10_000,
  factor: 2,
  jitter: 0.2,
};

type SignalReceiveStream = (params: {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  tls?: SignalTlsOptions;
  onEvent: (event: SignalSseEvent) => void;
}) => Promise<void>;

type RunSignalReceiveLoopParams = {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  /** Client-certificate material for an mTLS-fronted backend. */
  tls?: SignalTlsOptions;
  runtime: RuntimeEnv;
  onEvent: (event: SignalSseEvent) => void;
  policy?: Partial<BackoffPolicy>;
};

// Shared reconnect driver for both the native-daemon SSE stream and the
// bbernhard "rest" WebSocket stream. Both expose the same resolve-on-close /
// reject-on-error contract, so the backoff and restart-attempt accounting are
// identical — only the underlying transport function differs.
async function runSignalReceiveLoop(
  stream: SignalReceiveStream,
  label: string,
  { baseUrl, account, abortSignal, tls, runtime, onEvent, policy }: RunSignalReceiveLoopParams,
) {
  const reconnectPolicy = {
    ...DEFAULT_RECONNECT_POLICY,
    ...policy,
  };
  let reconnectAttempts = 0;

  const logReconnectVerbose = (message: string) => {
    if (!shouldLogVerbose()) {
      return;
    }
    logVerbose(message);
  };

  while (!abortSignal?.aborted) {
    try {
      await stream({
        baseUrl,
        account,
        abortSignal,
        tls,
        onEvent: (event) => {
          reconnectAttempts = 0;
          onEvent(event);
        },
      });
      if (abortSignal?.aborted) {
        return;
      }
      reconnectAttempts += 1;
      const delayMs = computeBackoff(reconnectPolicy, reconnectAttempts);
      logReconnectVerbose(`Signal ${label} stream ended, reconnecting in ${delayMs / 1000}s...`);
      await sleepWithAbort(delayMs, abortSignal);
    } catch (err) {
      if (abortSignal?.aborted) {
        return;
      }
      runtime.error?.(`Signal ${label} stream error: ${String(err)}`);
      reconnectAttempts += 1;
      const delayMs = computeBackoff(reconnectPolicy, reconnectAttempts);
      runtime.log?.(`Signal ${label} connection lost, reconnecting in ${delayMs / 1000}s...`);
      try {
        await sleepWithAbort(delayMs, abortSignal);
      } catch (sleepErr) {
        if (abortSignal?.aborted) {
          return;
        }
        throw sleepErr;
      }
    }
  }
}

export function runSignalSseLoop(params: RunSignalReceiveLoopParams) {
  return runSignalReceiveLoop(streamSignalEvents, "SSE", params);
}

export function runSignalWsLoop(params: RunSignalReceiveLoopParams) {
  return runSignalReceiveLoop(streamSignalWsEvents, "WebSocket", params);
}
