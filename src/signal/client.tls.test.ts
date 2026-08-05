import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  signalCheck,
  signalRestAbout,
  signalRestAccounts,
  signalRpcRequest,
  streamSignalEvents,
  streamSignalWsEvents,
} from "./client.js";
import { getSignalTlsDispatcher, resetSignalTlsCachesForTests } from "./tls.js";

// signal-api can sit behind an mTLS front (TLS 1.3 + client cert + CN
// allowlist). These tests pin that the client certificate reaches both wire
// paths — the undici dispatcher on HTTP, the tls options on the receive
// WebSocket — and that omitting the config leaves both call shapes untouched.
const fetchMock = vi.hoisted(() => vi.fn());
const wsConstructorCalls = vi.hoisted(() => [] as unknown[][]);

vi.mock("../infra/fetch.js", () => ({
  resolveFetch: () => fetchMock as unknown as typeof fetch,
}));

vi.mock("ws", () => {
  class FakeWebSocket {
    private handlers = new Map<string, (arg?: unknown) => void>();
    constructor(...args: unknown[]) {
      wsConstructorCalls.push(args);
      // Resolve the stream on the next tick the same way a server-side close
      // would, so the call under test settles without a real socket.
      setTimeout(() => this.handlers.get("close")?.(), 0);
    }
    on(event: string, handler: (arg?: unknown) => void) {
      this.handlers.set(event, handler);
      return this;
    }
    terminate() {
      this.handlers.get("close")?.();
    }
  }
  return { default: FakeWebSocket };
});

const dir = mkdtempSync(join(tmpdir(), "signal-client-tls-"));
const caFile = join(dir, "ca.crt");
const certFile = join(dir, "client.crt");
const keyFile = join(dir, "client.key");
writeFileSync(caFile, "ca-pem");
writeFileSync(certFile, "cert-pem");
writeFileSync(keyFile, "key-pem");

const tls = { caFile, certFile, keyFile };

type InitWithDispatcher = RequestInit & { dispatcher?: unknown };

function requestInit(call = 0): InitWithDispatcher {
  return fetchMock.mock.calls[call]?.[1] as InitWithDispatcher;
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fetchMock.mockReset();
  wsConstructorCalls.length = 0;
  resetSignalTlsCachesForTests();
});

describe("signal client TLS on the HTTP path", () => {
  it("attaches the client-certificate dispatcher to signalCheck", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await signalCheck("https://signal-proxy:8443", 1000, "rest", tls);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://signal-proxy:8443/v1/health");
    expect(requestInit().dispatcher).toBe(getSignalTlsDispatcher(tls));
  });

  it("attaches the dispatcher to signalRestAbout and signalRestAccounts", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ version: "0.98" })));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(["+15550001111"])));

    await signalRestAbout("https://signal-proxy:8443", 1000, tls);
    await signalRestAccounts("https://signal-proxy:8443", 1000, tls);

    const dispatcher = getSignalTlsDispatcher(tls);
    expect(requestInit(0).dispatcher).toBe(dispatcher);
    expect(requestInit(1).dispatcher).toBe(dispatcher);
  });

  it("attaches the dispatcher to the REST send without disturbing the body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ timestamp: 1 }), { status: 201 }),
    );

    await signalRpcRequest(
      "send",
      { account: "+15559990000", recipient: ["+15550001111"], message: "hi" },
      { baseUrl: "https://signal-proxy:8443", transport: "rest", tls },
    );

    const init = requestInit();
    expect(init.dispatcher).toBe(getSignalTlsDispatcher(tls));
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      number: "+15559990000",
      recipients: ["+15550001111"],
      message: "hi",
    });
  });

  it("reuses one dispatcher across requests rather than building one per call", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await signalCheck("https://signal-proxy:8443", 1000, "rest", tls);
    await signalCheck("https://signal-proxy:8443", 1000, "rest", tls);

    expect(requestInit(0).dispatcher).toBe(requestInit(1).dispatcher);
  });

  it("attaches the dispatcher to the JSON-RPC POST path", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { version: "0.13.22" } })),
    );

    await signalRpcRequest("version", undefined, { baseUrl: "https://signal-proxy:8443", tls });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://signal-proxy:8443/api/v1/rpc");
    expect(requestInit().dispatcher).toBe(getSignalTlsDispatcher(tls));
  });

  it("attaches the dispatcher to the SSE event stream", async () => {
    fetchMock.mockResolvedValueOnce(new Response("data: {}\n\n", { status: 200 }));

    await streamSignalEvents({
      baseUrl: "https://signal-proxy:8443",
      account: "+15559990000",
      onEvent: () => {},
      tls,
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "https://signal-proxy:8443/api/v1/events",
    );
    expect(requestInit().dispatcher).toBe(getSignalTlsDispatcher(tls));
  });

  it("refuses to issue a request when TLS is configured against a plaintext base URL", async () => {
    await expect(signalCheck("http://signal-api:8080", 1000, "rest", tls)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/is not https/),
    });
    await expect(
      signalRpcRequest("version", undefined, { baseUrl: "http://signal-api:8080", tls }),
    ).rejects.toThrow(/is not https/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends no dispatcher key at all when TLS is not configured", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await signalCheck("http://signal-api:8080", 1000, "rest");

    expect(requestInit()).not.toHaveProperty("dispatcher");
    expect(requestInit()).toEqual({ method: "GET", signal: expect.any(AbortSignal) });
  });
});

describe("streamSignalWsEvents TLS", () => {
  it("passes the CA and client keypair to the ws constructor", async () => {
    await streamSignalWsEvents({
      baseUrl: "https://signal-proxy:8443",
      account: "+15559990000",
      tls,
      onEvent: () => {},
    });

    const [url, options] = wsConstructorCalls[0] as [string, Record<string, Buffer>];
    expect(url).toBe(`wss://signal-proxy:8443/v1/receive/${encodeURIComponent("+15559990000")}`);
    expect(options.ca.toString()).toBe("ca-pem");
    expect(options.cert.toString()).toBe("cert-pem");
    expect(options.key.toString()).toBe("key-pem");
  });

  it("refuses to open a plaintext socket when TLS is configured", async () => {
    await expect(
      streamSignalWsEvents({
        baseUrl: "http://signal-api:8080",
        account: "+15559990000",
        tls,
        onEvent: () => {},
      }),
    ).rejects.toThrow(/is not wss/);
    expect(wsConstructorCalls).toHaveLength(0);
  });

  it("constructs the socket with the url alone when TLS is not configured", async () => {
    await streamSignalWsEvents({
      baseUrl: "http://signal-api:8080",
      account: "+15559990000",
      onEvent: () => {},
    });

    expect(wsConstructorCalls[0]).toEqual([
      `ws://signal-api:8080/v1/receive/${encodeURIComponent("+15559990000")}`,
    ]);
  });
});
