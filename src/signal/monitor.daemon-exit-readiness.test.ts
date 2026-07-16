import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

// HIGH #6 coverage: when the signal-cli daemon child exits during the
// readiness wait, the wait must short-circuit instead of polling the
// dead port for the full 30s timeout. This test exercises the real
// `waitForTransportReady` (no mock) so the failFast wiring is proven
// end-to-end through `monitor.ts` → `waitForSignalDaemonReady`.

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

const { monitorSignalProvider } = await import("./monitor.js");

function buildSignalAutoStartConfig(): OpenClawConfig {
  return {
    channels: {
      signal: {
        autoStart: true,
        dmPolicy: "open",
        allowFrom: ["*"],
        startupTimeoutMs: 30_000,
      },
    },
  } as OpenClawConfig;
}

function createDaemonHandle(initialExited = false) {
  let exited = initialExited;
  return {
    pid: 12345,
    stop: daemonStopMock,
    get exited() {
      return exited;
    },
    setExited: () => {
      exited = true;
    },
    adopted: false,
  };
}

beforeEach(() => {
  resetInboundDedupe();
  resetSystemEventsForTest();
  monitorConfig = buildSignalAutoStartConfig() as unknown as Record<string, unknown>;
  signalCheckMock.mockReset();
  signalRpcRequestMock.mockReset().mockResolvedValue({});
  sendMock.mockReset().mockResolvedValue(undefined);
  daemonStopMock.mockReset();
  spawnDaemonMock.mockReset();
  streamMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("monitorSignalProvider — daemon exit short-circuits readiness (HIGH #6)", () => {
  it("rejects readiness fast when the daemon child exits mid-wait", async () => {
    // Probe always reports the port unreachable — without HIGH #6 the
    // wait would burn the full 30s startupTimeoutMs.
    signalCheckMock.mockResolvedValue({ ok: false, error: "ECONNREFUSED" });

    const handle = createDaemonHandle();
    spawnDaemonMock.mockResolvedValue(handle);

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: ((code: number): never => {
        throw new Error(`unexpected exit ${code}`);
      }) as (code: number) => never,
    };

    const start = Date.now();
    const monitorPromise = monitorSignalProvider({
      runtime,
      accountId: "default",
      // Dummy URL — signalCheck is mocked, no real HTTP attempt.
      baseUrl: "http://127.0.0.1:65535",
    });

    // Yield long enough for at least one signalCheck probe to happen,
    // then mark the daemon as exited. Real timers — pollIntervalMs=150
    // is hardcoded inside waitForSignalDaemonReady.
    await new Promise<void>((res) => setTimeout(res, 200));
    handle.setExited();

    await expect(monitorPromise).rejects.toThrow(
      /signal daemon not ready \(signal daemon exited before readiness\)/,
    );

    const elapsed = Date.now() - start;
    // The full timeout is 30_000ms. Fail-fast should land in well under
    // half of that even on a slow CI box. Verifies we did NOT poll out.
    expect(elapsed).toBeLessThan(5_000);

    // Daemon stop is run by the monitor's `finally` — confirms cleanup
    // path executes regardless of which branch errored.
    expect(daemonStopMock).toHaveBeenCalled();
  });

  it("does not short-circuit when the daemon stays alive but is slow to listen", async () => {
    // First two probes fail; third one succeeds. Daemon never exits.
    let probes = 0;
    signalCheckMock.mockImplementation(async () => {
      probes += 1;
      if (probes < 3) {
        return { ok: false, error: "ECONNREFUSED" };
      }
      return { ok: true };
    });
    streamMock.mockImplementation(async function* () {
      // Yield nothing; SSE loop suspends waiting for events. The test
      // aborts once readiness has been reached.
    });

    const handle = createDaemonHandle();
    spawnDaemonMock.mockResolvedValue(handle);

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: ((code: number): never => {
        throw new Error(`unexpected exit ${code}`);
      }) as (code: number) => never,
    };

    const abort = new AbortController();
    const monitorPromise = monitorSignalProvider({
      runtime,
      accountId: "default",
      baseUrl: "http://127.0.0.1:65535",
      abortSignal: abort.signal,
    });

    // Wait long enough for the third probe to land (3 * 150ms poll =
    // 450ms minimum) plus a buffer. Then abort to let the SSE loop unwind.
    await new Promise<void>((res) => setTimeout(res, 700));
    abort.abort();
    await monitorPromise.catch(() => {
      // SSE loop may reject on abort — that's fine. We're proving the
      // readiness wait did not throw a "daemon exited" error.
    });

    // Probes ran multiple times — readiness wait did not short-circuit.
    expect(probes).toBeGreaterThanOrEqual(3);
    // No "exited before readiness" error was logged.
    const errorMessages = runtime.error.mock.calls
      .map((call) => call.map(String).join(" "))
      .join(" | ");
    expect(errorMessages).not.toMatch(/exited before readiness/);
  });
});
