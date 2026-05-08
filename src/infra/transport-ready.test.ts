import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForTransportReady } from "./transport-ready.js";

// Perf: `sleepWithAbort` uses `node:timers/promises` which isn't controlled by fake timers.
// Route sleeps through global `setTimeout` so tests can advance time deterministically.
vi.mock("./backoff.js", () => ({
  sleepWithAbort: async (ms: number) => {
    if (ms <= 0) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  },
}));

describe("waitForTransportReady", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns when the check succeeds and logs after the delay", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    let attempts = 0;
    const readyPromise = waitForTransportReady({
      label: "test transport",
      timeoutMs: 220,
      // Deterministic: first attempt at t=0 won't log; second attempt at t=50 will.
      logAfterMs: 1,
      logIntervalMs: 1_000,
      pollIntervalMs: 50,
      runtime,
      check: async () => {
        attempts += 1;
        if (attempts > 2) {
          return { ok: true };
        }
        return { ok: false, error: "not ready" };
      },
    });

    await vi.advanceTimersByTimeAsync(200);

    await readyPromise;
    expect(runtime.error).toHaveBeenCalled();
  });

  it("throws after the timeout", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const waitPromise = waitForTransportReady({
      label: "test transport",
      timeoutMs: 110,
      logAfterMs: 0,
      logIntervalMs: 1_000,
      pollIntervalMs: 50,
      runtime,
      check: async () => ({ ok: false, error: "still down" }),
    });
    const asserted = expect(waitPromise).rejects.toThrow("test transport not ready");
    await vi.advanceTimersByTimeAsync(200);
    await asserted;
    expect(runtime.error).toHaveBeenCalled();
  });

  it("returns early when aborted", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const controller = new AbortController();
    controller.abort();
    await waitForTransportReady({
      label: "test transport",
      timeoutMs: 200,
      runtime,
      abortSignal: controller.signal,
      check: async () => ({ ok: false, error: "still down" }),
    });
    expect(runtime.error).not.toHaveBeenCalled();
  });

  // HIGH #6: failFast predicate short-circuits the readiness wait so a
  // crashed daemon child does not burn the full timeout.
  it("throws immediately when failFast returns a reason after a failed probe", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    let exited = false;
    const checkSpy = vi.fn(async () => {
      // After the first probe, simulate the daemon dying.
      exited = true;
      return { ok: false, error: "connection refused" };
    });
    const waitPromise = waitForTransportReady({
      label: "signal daemon",
      // Deliberately enormous so a non-fail-fast wait would hang the test.
      timeoutMs: 30_000,
      logAfterMs: 0,
      logIntervalMs: 1_000,
      pollIntervalMs: 50,
      runtime,
      check: checkSpy,
      failFast: () => (exited ? "signal daemon exited before readiness" : null),
    });
    const asserted = expect(waitPromise).rejects.toThrow(
      "signal daemon not ready (signal daemon exited before readiness)",
    );
    // Probe + failFast re-check happen synchronously; no need to advance
    // by 30s. A short tick suffices to drain the microtask queue.
    await vi.advanceTimersByTimeAsync(10);
    await asserted;
    expect(checkSpy).toHaveBeenCalledTimes(1);
  });

  it("throws immediately when failFast returns a reason before the first probe", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const checkSpy = vi.fn(async () => ({ ok: false, error: "connection refused" }));
    const waitPromise = waitForTransportReady({
      label: "signal daemon",
      timeoutMs: 30_000,
      logAfterMs: 0,
      pollIntervalMs: 50,
      runtime,
      check: checkSpy,
      failFast: () => "already dead",
    });
    const asserted = expect(waitPromise).rejects.toThrow(
      "signal daemon not ready (already dead)",
    );
    await vi.advanceTimersByTimeAsync(10);
    await asserted;
    expect(checkSpy).not.toHaveBeenCalled();
  });
});
