import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { RuntimeEnv } from "../runtime.js";
import type { SignalSseEvent } from "./client.js";
import { runSignalWsLoop } from "./sse-reconnect.js";

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: ((code: number): never => {
      throw new Error(`exit ${code}`);
    }) as (code: number) => never,
  };
}

// Fast, deterministic backoff for tests.
const FAST_POLICY = { initialMs: 5, maxMs: 10, factor: 2, jitter: 0 };

describe("runSignalWsLoop", () => {
  let wsServer: WebSocketServer | null = null;

  const startWsServer = async () => {
    wsServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wsServer?.once("listening", resolve));
    return (wsServer.address() as { port: number }).port;
  };

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!wsServer) {
        return resolve();
      }
      wsServer.close(() => resolve());
      wsServer = null;
    });
  });

  it("reconnects after the socket drops and stops cleanly on abort", async () => {
    const port = await startWsServer();
    if (!wsServer) {
      throw new Error("ws server not initialized");
    }
    let connections = 0;
    wsServer.on("connection", (socket) => {
      connections += 1;
      socket.send(JSON.stringify({ envelope: { dataMessage: { message: `msg${connections}` } } }));
      // Drop the connection to force the loop to reconnect.
      setTimeout(() => socket.close(), 10);
    });

    const abort = new AbortController();
    const runtime = createRuntime();
    const events: SignalSseEvent[] = [];
    const loop = runSignalWsLoop({
      baseUrl: `http://127.0.0.1:${port}`,
      account: "+15550001111",
      abortSignal: abort.signal,
      runtime,
      onEvent: (event) => events.push(event),
      policy: FAST_POLICY,
    });

    // At least two connections proves the reconnect machinery fired.
    await waitFor(() => connections >= 2);
    abort.abort();
    await expect(loop).resolves.toBeUndefined();

    expect(connections).toBeGreaterThanOrEqual(2);
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it("logs and retries after a connection error, then stops on abort", async () => {
    // Reserve then release a port so the connect is refused.
    const port = await startWsServer();
    await new Promise<void>((resolve) => {
      wsServer?.close(() => resolve());
      wsServer = null;
    });

    const abort = new AbortController();
    const runtime = createRuntime();
    const loop = runSignalWsLoop({
      baseUrl: `http://127.0.0.1:${port}`,
      account: "+15550001111",
      abortSignal: abort.signal,
      runtime,
      onEvent: () => {},
      policy: FAST_POLICY,
    });

    await waitFor(() => (runtime.error as ReturnType<typeof vi.fn>).mock.calls.length >= 1);
    abort.abort();
    await expect(loop).resolves.toBeUndefined();

    expect((runtime.error as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
    const errored = (runtime.error as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .some((arg) => String(arg).includes("Signal WebSocket stream error"));
    expect(errored).toBe(true);
  });
});
