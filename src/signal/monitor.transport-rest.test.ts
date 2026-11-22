import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

// Requirement 1/2 wiring: with transport "rest" the monitor must drive the
// bbernhard WebSocket receive loop (no daemon, no SSE); with the default
// "json-rpc" transport it must keep the daemon + SSE path untouched.

const waitForTransportReadyMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const sseLoopMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const wsLoopMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
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
  streamSignalEvents: vi.fn(),
  streamSignalWsEvents: vi.fn(),
  signalCheck: (...args: unknown[]) => signalCheckMock(...args),
  signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
}));

vi.mock("./sse-reconnect.js", () => ({
  runSignalSseLoop: (...args: unknown[]) => sseLoopMock(...args),
  runSignalWsLoop: (...args: unknown[]) => wsLoopMock(...args),
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

// A loop mock that blocks until its abort signal fires, mirroring the real
// receive loops so the monitor stays inside the loop until the parent aborts.
function blockUntilAbort({ abortSignal }: { abortSignal?: AbortSignal }) {
  return new Promise<void>((resolve) => {
    if (abortSignal?.aborted) {
      resolve();
      return;
    }
    abortSignal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

beforeEach(() => {
  resetInboundDedupe();
  resetSystemEventsForTest();
  waitForTransportReadyMock.mockReset().mockResolvedValue(undefined);
  signalCheckMock.mockReset().mockResolvedValue({ ok: true });
  signalRpcRequestMock.mockReset().mockResolvedValue({});
  sendMock.mockReset().mockResolvedValue(undefined);
  daemonStopMock.mockReset();
  spawnDaemonMock.mockReset().mockImplementation(async () => ({
    pid: 9999,
    stop: daemonStopMock,
    exited: false,
    adopted: false,
  }));
  sseLoopMock.mockReset().mockImplementation(blockUntilAbort);
  wsLoopMock.mockReset().mockImplementation(blockUntilAbort);
});

describe("monitorSignalProvider transport routing", () => {
  it("uses the WebSocket receive loop and no daemon when transport is 'rest'", async () => {
    monitorConfig = {
      channels: {
        signal: {
          transport: "rest",
          httpUrl: "http://signal-api:8080",
          account: "+15550001111",
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    } as unknown as Record<string, unknown>;

    const runtime = createMonitorRuntime();
    const parent = new AbortController();
    const finished = monitorSignalProvider({
      runtime,
      abortSignal: parent.signal,
      accountId: "rest-acc",
    });

    await waitFor(() => wsLoopMock.mock.calls.length > 0);
    expect(wsLoopMock).toHaveBeenCalledTimes(1);
    expect(sseLoopMock).not.toHaveBeenCalled();
    expect(spawnDaemonMock).not.toHaveBeenCalled();

    const loopArgs = wsLoopMock.mock.calls[0][0] as {
      baseUrl: string;
      account: string;
      abortSignal: AbortSignal;
    };
    expect(loopArgs.baseUrl).toBe("http://signal-api:8080");
    expect(loopArgs.account).toBe("+15550001111");
    expect(loopArgs.abortSignal).toBeInstanceOf(AbortSignal);

    parent.abort();
    await finished;
  });

  it("uses the SSE loop + daemon on the default json-rpc transport", async () => {
    monitorConfig = {
      channels: {
        signal: {
          autoStart: true,
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    } as unknown as Record<string, unknown>;

    const runtime = createMonitorRuntime();
    const parent = new AbortController();
    const finished = monitorSignalProvider({
      runtime,
      abortSignal: parent.signal,
      accountId: "jsonrpc-acc",
    });

    await waitFor(() => sseLoopMock.mock.calls.length > 0);
    expect(sseLoopMock).toHaveBeenCalledTimes(1);
    expect(wsLoopMock).not.toHaveBeenCalled();
    expect(spawnDaemonMock).toHaveBeenCalledTimes(1);

    parent.abort();
    await finished;
  });
});

describe("waitForSignalDaemonReady health path", () => {
  // The readiness gate polls signalCheck. On "rest" the daemon check path
  // 404s, so the gate could never observe ready unless the transport is
  // threaded through to signalCheck.
  async function captureReadinessCheck(
    signalSection: Record<string, unknown>,
  ): Promise<() => Promise<{ ok: boolean; error?: string }>> {
    monitorConfig = {
      channels: { signal: { dmPolicy: "open", allowFrom: ["*"], ...signalSection } },
    } as unknown as Record<string, unknown>;

    const runtime = createMonitorRuntime();
    const parent = new AbortController();
    const finished = monitorSignalProvider({
      runtime,
      abortSignal: parent.signal,
      accountId: "readiness-acc",
    });

    await waitFor(() => waitForTransportReadyMock.mock.calls.length > 0);
    const readyArgs = waitForTransportReadyMock.mock.calls[0][0] as {
      check: () => Promise<{ ok: boolean; error?: string }>;
    };

    parent.abort();
    await finished;
    return readyArgs.check;
  }

  it("polls /v1/health via signalCheck when transport is 'rest'", async () => {
    const check = await captureReadinessCheck({
      autoStart: true,
      transport: "rest",
      httpUrl: "http://signal-api:8080",
      account: "+15550001111",
    });

    await expect(check()).resolves.toEqual({ ok: true });
    expect(signalCheckMock).toHaveBeenCalledWith("http://signal-api:8080", 1000, "rest", undefined);
  });

  it("polls the daemon check path on the default json-rpc transport", async () => {
    const check = await captureReadinessCheck({ autoStart: true });

    await expect(check()).resolves.toEqual({ ok: true });
    expect(signalCheckMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8080",
      1000,
      "json-rpc",
      undefined,
    );
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Work item cc0c85af: a gateway that only SENDS from an account must not hold
// a receive stream on it (an account can be a linked device of a person's own
// number, so its inbound carries their 2FA codes). `receive: false` keeps the
// account for outbound and opens no subscription.
describe("monitorSignalProvider per-account receive flag", () => {
  const twoAccounts = () =>
    ({
      channels: {
        signal: {
          transport: "rest",
          httpUrl: "http://signal-api:8080",
          dmPolicy: "open",
          allowFrom: ["*"],
          accounts: {
            bot: { account: "+15550001111" },
            cortex: { account: "+15550002222", receive: false, dmPolicy: "disabled" },
          },
        },
      },
    }) as unknown as Record<string, unknown>;

  it("opens no receive stream for a receive:false account and parks until abort", async () => {
    monitorConfig = twoAccounts();
    const runtime = createMonitorRuntime();
    const statuses: Array<Record<string, unknown>> = [];
    const parent = new AbortController();
    let done = false;
    const finished = monitorSignalProvider({
      runtime,
      abortSignal: parent.signal,
      accountId: "cortex",
      setStatus: (s) => statuses.push(s as Record<string, unknown>),
    }).then(() => {
      done = true;
    });

    await waitFor(() => statuses.length > 0);
    expect(statuses[0]).toMatchObject({ accountId: "cortex", running: false, enabled: false });
    expect(String(statuses[0]?.lastError)).toContain("receive: false");
    expect(wsLoopMock).not.toHaveBeenCalled();
    expect(sseLoopMock).not.toHaveBeenCalled();
    expect(spawnDaemonMock).not.toHaveBeenCalled();
    expect(waitForTransportReadyMock).not.toHaveBeenCalled();
    expect(done).toBe(false);

    parent.abort();
    await finished;
    expect(done).toBe(true);
  });

  it("still subscribes an account without the flag, on its own number only", async () => {
    monitorConfig = twoAccounts();
    const runtime = createMonitorRuntime();
    const parent = new AbortController();
    const finished = monitorSignalProvider({ runtime, abortSignal: parent.signal, accountId: "bot" });

    await waitFor(() => wsLoopMock.mock.calls.length > 0);
    expect(wsLoopMock).toHaveBeenCalledTimes(1);
    expect((wsLoopMock.mock.calls[0][0] as { account: string }).account).toBe("+15550001111");

    parent.abort();
    await finished;
  });
});
