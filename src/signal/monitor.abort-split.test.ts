import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

// CRITICAL #3: split-abort coverage. The monitor must isolate daemon
// teardown from SSE teardown so a transient daemon stop cannot rip down
// the SSE loop, and an SSE failure cannot kill the daemon child.

const waitForTransportReadyMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const streamMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const signalCheckMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const signalRpcRequestMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const sendMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const daemonStopMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const spawnDaemonMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;

let monitorConfig: Record<string, unknown> = {};

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => monitorConfig,
  };
});

vi.mock("./client.js", () => ({
  streamSignalEvents: (...args: unknown[]) => streamMock(...args),
  signalCheck: (...args: unknown[]) => signalCheckMock(...args),
  signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
}));

vi.mock("./send.js", () => ({
  sendMessageSignal: (...args: unknown[]) => sendMock(...args),
  sendTypingSignal: vi.fn().mockResolvedValue(true),
  sendReadReceiptSignal: vi.fn().mockResolvedValue(true),
}));

vi.mock("./daemon.js", () => ({
  spawnSignalDaemon: (...args: unknown[]) => spawnDaemonMock(...args),
}));

vi.mock("../infra/transport-ready.js", () => ({
  waitForTransportReady: (...args: unknown[]) => waitForTransportReadyMock(...args),
}));

const { monitorSignalProvider } = await import("./monitor.js");

function createMonitorRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: ((code: number): never => {
      throw new Error(`exit ${code}`);
    }) as (code: number) => never,
  };
}

function buildSignalAutoStartConfig(): OpenClawConfig {
  return {
    channels: {
      signal: {
        autoStart: true,
        dmPolicy: "open",
        allowFrom: ["*"],
      },
    },
  } as OpenClawConfig;
}

beforeEach(() => {
  resetInboundDedupe();
  resetSystemEventsForTest();
  monitorConfig = buildSignalAutoStartConfig() as unknown as Record<string, unknown>;
  waitForTransportReadyMock.mockReset().mockResolvedValue(undefined);
  signalCheckMock.mockReset().mockResolvedValue({ ok: true });
  signalRpcRequestMock.mockReset().mockResolvedValue({});
  sendMock.mockReset().mockResolvedValue(undefined);
  daemonStopMock.mockReset();
  spawnDaemonMock
    .mockReset()
    .mockImplementation(() => ({ pid: 9999, stop: daemonStopMock }));
  streamMock.mockReset();
});

describe("CRITICAL #3 — daemon/SSE abort signals are independent", () => {
  it("parent abort tears down both daemon and SSE", async () => {
    // SSE loop blocks until its abort fires, so we can observe what happens
    // when the parent abort cascades.
    let observedSseAbort: AbortSignal | undefined;
    streamMock.mockImplementation(
      ({ abortSignal }: { abortSignal?: AbortSignal }) =>
        new Promise<void>((resolve) => {
          observedSseAbort = abortSignal;
          if (abortSignal?.aborted) {
            resolve();
            return;
          }
          abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        }),
    );

    const runtime = createMonitorRuntime();
    const parent = new AbortController();

    const finished = monitorSignalProvider({
      runtime,
      abortSignal: parent.signal,
      accountId: "acc-parent",
    });

    // Yield until SSE has been entered (mock captured the inner sseAbort).
    for (let i = 0; i < 5 && !observedSseAbort; i += 1) {
      await Promise.resolve();
    }
    expect(observedSseAbort).toBeDefined();
    expect(observedSseAbort?.aborted).toBe(false);
    expect(daemonStopMock).not.toHaveBeenCalled();

    parent.abort();
    await finished;

    expect(observedSseAbort?.aborted).toBe(true);
    expect(daemonStopMock).toHaveBeenCalled();
  });

  it("SSE-only failure does NOT stop the daemon child", async () => {
    // Stream rejects synchronously the first time, then blocks on its
    // own abort signal so the SSE reconnect loop holds. We never abort
    // the parent — daemon must remain running because no one stopped it.
    let streamCalls = 0;
    streamMock.mockImplementation(
      ({ abortSignal }: { abortSignal?: AbortSignal }) => {
        streamCalls += 1;
        if (streamCalls === 1) {
          return Promise.reject(new Error("SSE upstream blew up"));
        }
        return new Promise<void>((resolve) => {
          if (abortSignal?.aborted) {
            resolve();
            return;
          }
          abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    );

    const runtime = createMonitorRuntime();
    const parent = new AbortController();

    const finished = monitorSignalProvider({
      runtime,
      abortSignal: parent.signal,
      accountId: "acc-sse-only",
    });

    // Allow the SSE loop to error once, log, and re-enter the next stream call.
    // A small advance is needed because of the reconnect backoff.
    await new Promise((res) => setTimeout(res, 50));

    // Daemon must NOT have been stopped just because SSE errored.
    expect(daemonStopMock).not.toHaveBeenCalled();
    expect(streamCalls).toBeGreaterThanOrEqual(1);

    // Cleanup: aborting the parent should now stop both.
    parent.abort();
    await finished;
    expect(daemonStopMock).toHaveBeenCalled();
  });

  it("daemon stop does NOT abort the SSE loop", async () => {
    // Hand the test a captured reference to whatever AbortSignal the SSE
    // loop is bound to. If split-abort is wired correctly that signal is
    // independent from the daemon's controller.
    let observedSseAbort: AbortSignal | undefined;
    streamMock.mockImplementation(
      ({ abortSignal }: { abortSignal?: AbortSignal }) =>
        new Promise<void>((resolve) => {
          observedSseAbort = abortSignal;
          if (abortSignal?.aborted) {
            resolve();
            return;
          }
          abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        }),
    );

    const runtime = createMonitorRuntime();
    const parent = new AbortController();

    const finished = monitorSignalProvider({
      runtime,
      abortSignal: parent.signal,
      accountId: "acc-daemon-only",
    });

    // Wait until the monitor has entered the SSE loop.
    for (let i = 0; i < 5 && !observedSseAbort; i += 1) {
      await Promise.resolve();
    }
    expect(observedSseAbort).toBeDefined();
    expect(observedSseAbort?.aborted).toBe(false);

    // Synthesise a daemon-only stop by invoking the captured handle's stop().
    // This is what a future "daemon needs restart" path would do.
    const handle = spawnDaemonMock.mock.results[0]?.value as {
      stop: () => void;
    };
    handle.stop();
    // Drain a tick.
    await Promise.resolve();

    // The SSE abort must STILL not be aborted — daemon stop is isolated.
    expect(observedSseAbort?.aborted).toBe(false);

    // Cleanup.
    parent.abort();
    await finished;
  });
});
