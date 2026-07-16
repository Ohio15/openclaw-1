import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { type SignalSseEvent, signalWsFrameToSseEvent, streamSignalWsEvents } from "./client.js";

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("signalWsFrameToSseEvent", () => {
  it("wraps a receive payload as an SSE 'receive' event with the raw frame as data", () => {
    const frame = JSON.stringify({
      envelope: { sourceNumber: "+15550001111", dataMessage: { message: "hi" } },
      account: "+15559990000",
    });
    const event = signalWsFrameToSseEvent(frame);
    expect(event).not.toBeNull();
    expect(event?.event).toBe("receive");
    expect(event?.data).toBe(frame);
    // Downstream handler JSON.parses `data` and reads `.envelope`.
    const payload = JSON.parse(event?.data ?? "{}") as {
      envelope?: { dataMessage?: { message?: string } };
    };
    expect(payload.envelope?.dataMessage?.message).toBe("hi");
  });

  it("passes through exception-only frames so the handler can log them", () => {
    const frame = JSON.stringify({ exception: { message: "boom" } });
    const event = signalWsFrameToSseEvent(frame);
    expect(event).not.toBeNull();
    expect(event?.data).toBe(frame);
  });

  it("drops frames without an envelope or exception", () => {
    expect(signalWsFrameToSseEvent(JSON.stringify({ heartbeat: true }))).toBeNull();
  });

  it("drops empty, whitespace, and non-JSON frames", () => {
    expect(signalWsFrameToSseEvent("")).toBeNull();
    expect(signalWsFrameToSseEvent("   \n ")).toBeNull();
    expect(signalWsFrameToSseEvent("not json")).toBeNull();
    expect(signalWsFrameToSseEvent("42")).toBeNull();
  });
});

describe("streamSignalWsEvents", () => {
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

  it("rejects when no account is supplied", async () => {
    await expect(
      streamSignalWsEvents({ baseUrl: "http://127.0.0.1:1", onEvent: () => {} }),
    ).rejects.toThrow(/E\.164/);
  });

  it("returns immediately if the abort signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      streamSignalWsEvents({
        baseUrl: "http://127.0.0.1:1",
        account: "+15550001111",
        abortSignal: abort.signal,
        onEvent: () => {
          throw new Error("should not emit when pre-aborted");
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("connects to /v1/receive/{account} and forwards translated frames", async () => {
    const port = await startWsServer();
    if (!wsServer) {
      throw new Error("ws server not initialized");
    }
    let connectionPath: string | undefined;
    wsServer.on("connection", (socket, req) => {
      connectionPath = req.url;
      socket.send(
        JSON.stringify({
          envelope: { sourceNumber: "+15550001111", dataMessage: { message: "hi" } },
        }),
      );
      socket.send("not-json-keepalive");
      setTimeout(() => socket.close(), 20);
    });

    const events: SignalSseEvent[] = [];
    await streamSignalWsEvents({
      baseUrl: `http://127.0.0.1:${port}`,
      account: "+15559990000",
      onEvent: (event) => events.push(event),
    });

    // http->ws scheme swap and E.164-as-encoded-path-segment.
    expect(connectionPath).toBe(`/v1/receive/${encodeURIComponent("+15559990000")}`);
    // The keepalive frame is dropped; only the real envelope is forwarded.
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("receive");
    const payload = JSON.parse(events[0].data ?? "{}") as {
      envelope?: { dataMessage?: { message?: string } };
    };
    expect(payload.envelope?.dataMessage?.message).toBe("hi");
  });

  it("resolves cleanly when aborted mid-stream and closes the socket", async () => {
    const port = await startWsServer();
    if (!wsServer) {
      throw new Error("ws server not initialized");
    }
    let serverClosed = false;
    wsServer.on("connection", (socket) => {
      socket.on("close", () => {
        serverClosed = true;
      });
      socket.send(JSON.stringify({ envelope: { dataMessage: { message: "x" } } }));
      // Never closes from the server side — the abort must tear it down.
    });

    const abort = new AbortController();
    const events: SignalSseEvent[] = [];
    const streaming = streamSignalWsEvents({
      baseUrl: `http://127.0.0.1:${port}`,
      account: "+15550001111",
      abortSignal: abort.signal,
      onEvent: (event) => events.push(event),
    });

    await waitFor(() => events.length === 1);
    abort.abort();
    await expect(streaming).resolves.toBeUndefined();
    await waitFor(() => serverClosed);
    expect(serverClosed).toBe(true);
  });

  it("rejects on a transport error when not aborted", async () => {
    // Bind then immediately release a port so the connect is refused.
    const port = await startWsServer();
    await new Promise<void>((resolve) => {
      wsServer?.close(() => resolve());
      wsServer = null;
    });
    await expect(
      streamSignalWsEvents({
        baseUrl: `http://127.0.0.1:${port}`,
        account: "+15550001111",
        onEvent: () => {},
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});
