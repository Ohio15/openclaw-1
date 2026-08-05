import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { resolveFetch } from "../infra/fetch.js";
import { rawDataToString } from "../infra/ws.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
import { type SignalTlsOptions, signalTlsWsOptions, withSignalTlsDispatcher } from "./tls.js";

export type SignalTransport = "json-rpc" | "rest";

export type SignalRpcOptions = {
  baseUrl: string;
  timeoutMs?: number;
  /**
   * Client-certificate material for a backend behind an mTLS front. Omitted on
   * every plaintext deployment, where the request init is unchanged.
   */
  tls?: SignalTlsOptions;
  /**
   * Wire protocol used to talk to the signal backend.
   * - "json-rpc" (default): POST a JSON-RPC envelope to `${baseUrl}/api/v1/rpc`,
   *   the contract exposed by `signal-cli daemon --http`.
   * - "rest": speak to bbernhard/signal-cli-rest-api's REST endpoints
   *   (currently only the `send` method is translated; all other RPC methods
   *   throw a clear error so callers can downgrade gracefully).
   */
  transport?: SignalTransport;
};

export type SignalRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

export type SignalRpcResponse<T> = {
  jsonrpc?: string;
  result?: T;
  error?: SignalRpcError;
  id?: string | number | null;
};

export type SignalSseEvent = {
  event?: string;
  data?: string;
  id?: string;
};

const DEFAULT_TIMEOUT_MS = 10_000;

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("Signal base URL is required");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  return `http://${trimmed}`.replace(/\/+$/, "");
}

function getRequiredFetch(): typeof fetch {
  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }
  return fetchImpl;
}

export async function signalRpcRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: SignalRpcOptions,
): Promise<T> {
  if (opts.transport === "rest") {
    return signalRestRequest<T>(method, params, opts);
  }
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const id = randomUUID();
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method,
    params,
    id,
  });
  const res = await fetchWithTimeout(
    `${baseUrl}/api/v1/rpc`,
    withSignalTlsDispatcher(
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
      opts.tls,
    ),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    getRequiredFetch(),
  );
  if (res.status === 201) {
    return undefined as T;
  }
  const text = await res.text();
  if (!text) {
    throw new Error(`Signal RPC empty response (status ${res.status})`);
  }
  const parsed = JSON.parse(text) as SignalRpcResponse<T>;
  if (parsed.error) {
    const code = parsed.error.code ?? "unknown";
    const msg = parsed.error.message ?? "Signal RPC error";
    throw new Error(`Signal RPC ${code}: ${msg}`);
  }
  return parsed.result as T;
}

/**
 * Translate a subset of signal-cli JSON-RPC methods to the REST endpoints
 * exposed by bbernhard/signal-cli-rest-api. Only `send` is implemented;
 * other methods throw so callers can degrade gracefully (e.g. fall back to
 * a different transport, or skip an optional capability).
 *
 * REST send shape: POST /v2/send
 *   { number, recipients[], message, base64_attachments? }
 *   -> 201 Created with { timestamp }
 */
async function signalRestRequest<T>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: SignalRpcOptions,
): Promise<T> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (method !== "send") {
    throw new Error(
      `Signal REST transport does not implement method "${method}". Supported: send.`,
    );
  }

  const account = typeof params?.account === "string" ? params.account : undefined;
  if (!account) {
    throw new Error("Signal REST transport requires `account` in params (E.164 sender number).");
  }

  // The REST API only addresses recipient-by-number or group; usernames are
  // not supported. Translate accordingly. signal-cli JSON-RPC accepts these as
  // arrays (recipient[], username[]) or a single groupId string — the REST API
  // accepts a single recipients[] array containing numbers and/or
  // "group.<base64>" identifiers.
  const recipients: string[] = [];
  if (Array.isArray(params?.recipient)) {
    for (const r of params.recipient as unknown[]) {
      if (typeof r === "string" && r.trim()) {
        recipients.push(r.trim());
      }
    }
  }
  if (typeof params?.groupId === "string" && params.groupId.trim()) {
    // signal-cli-rest-api expects group recipients as "group.<id>".
    const gid = params.groupId.trim();
    recipients.push(gid.startsWith("group.") ? gid : `group.${gid}`);
  }
  if (Array.isArray(params?.username)) {
    throw new Error(
      "Signal REST transport does not support username addressing; use E.164 recipient.",
    );
  }
  if (recipients.length === 0) {
    throw new Error("Signal REST transport: no valid recipient(s) supplied.");
  }

  const message = typeof params?.message === "string" ? params.message : "";

  const body: Record<string, unknown> = {
    number: account,
    recipients,
    message,
  };

  // Map signal-cli text-style entries (start:length:STYLE) to the REST API's
  // text_style field (same wire format).
  if (Array.isArray(params?.["text-style"])) {
    body.text_style = params["text-style"];
  }

  // Attachments arrive as filesystem paths in the JSON-RPC contract; the REST
  // API expects base64. We don't translate them here — callers using REST
  // transport for shared-brain alerts only send text. Reject explicitly to
  // make the limitation obvious if it ever changes.
  if (Array.isArray(params?.attachments) && params.attachments.length > 0) {
    throw new Error(
      "Signal REST transport: attachments require base64 encoding and are not yet wired up.",
    );
  }

  const res = await fetchWithTimeout(
    `${baseUrl}/v2/send`,
    withSignalTlsDispatcher(
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      opts.tls,
    ),
    timeoutMs,
    getRequiredFetch(),
  );

  if (res.status !== 201 && res.status !== 200) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Signal REST send failed: HTTP ${res.status}${errText ? ` — ${errText.slice(0, 300)}` : ""}`,
    );
  }

  const text = await res.text();
  if (!text) {
    return { timestamp: Date.now() } as unknown as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return { timestamp: Date.now() } as unknown as T;
  }
}

/**
 * Liveness check against the Signal backend.
 *
 * The two transports expose different health contracts and neither serves the
 * other's path:
 * - "json-rpc": `signal-cli daemon --http` answers `GET /api/v1/check`.
 * - "rest": bbernhard/signal-cli-rest-api answers `GET /v1/health` (204) and
 *   404s on `/api/v1/check`.
 *
 * Probing the wrong path reports the channel permanently unhealthy, so the
 * transport must be threaded in by every caller that knows it.
 *
 * `tls` is the client-certificate material for an mTLS-fronted backend; omit it
 * (the default) for the unchanged plaintext path.
 */
export async function signalCheck(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  transport: SignalTransport = "json-rpc",
  tls?: SignalTlsOptions,
): Promise<{ ok: boolean; status?: number | null; error?: string | null }> {
  const normalized = normalizeBaseUrl(baseUrl);
  const path = transport === "rest" ? "/v1/health" : "/api/v1/check";
  try {
    const res = await fetchWithTimeout(
      `${normalized}${path}`,
      withSignalTlsDispatcher({ method: "GET" }, tls),
      timeoutMs,
      getRequiredFetch(),
    );
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, error: null };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Version banner for the "rest" transport.
 *
 * bbernhard/signal-cli-rest-api has no RPC endpoint — `signalRpcRequest`'s REST
 * translator only implements `send`, and `POST /api/v1/rpc` does not exist on
 * the image. Its build info lives at `GET /v1/about`, whose payload includes a
 * `version` field (e.g. `{"versions":[...],"build":2,"version":"0.98"}`).
 *
 * Returns the parsed body so the caller can extract the field it wants; throws
 * on a non-2xx response or unparseable body so probe callers can surface the
 * failure without treating the backend as versionless.
 */
export async function signalRestAbout(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  tls?: SignalTlsOptions,
): Promise<unknown> {
  const normalized = normalizeBaseUrl(baseUrl);
  const res = await fetchWithTimeout(
    `${normalized}/v1/about`,
    withSignalTlsDispatcher({ method: "GET" }, tls),
    timeoutMs,
    getRequiredFetch(),
  );
  if (!res.ok) {
    throw new Error(`Signal REST about failed: HTTP ${res.status}`);
  }
  const text = await res.text();
  if (!text) {
    throw new Error("Signal REST about returned an empty body");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Signal REST about returned a non-JSON body");
  }
}

function extractRestAccountNumber(entry: unknown): string | null {
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    return trimmed || null;
  }
  if (entry && typeof entry === "object") {
    // Newer images have shipped object entries; accept the two field names the
    // API has used for the E.164 rather than assuming one.
    const record = entry as { number?: unknown; account?: unknown };
    for (const candidate of [record.number, record.account]) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }
  return null;
}

/**
 * Registered accounts on the "rest" backend (bbernhard/signal-cli-rest-api).
 *
 * `GET /v1/health` is container liveness only — it answers 204 while the HTTP
 * server is up regardless of whether signal-cli has any registered/linked
 * account, and every account sharing a container emits the identical result.
 * `GET /v1/accounts` is the only account-aware signal the image exposes, so it
 * is what makes a probe say something about the number rather than the process.
 *
 * The documented payload is a JSON array of E.164 strings
 * (`["+15550001111","+15550002222"]`). Parsing is deliberately defensive but
 * never lenient: object entries carrying a `number`/`account` field are
 * accepted, and anything else (non-2xx, empty body, non-JSON, a non-array
 * envelope, or an entry with no recognizable number) throws. Callers on a
 * dead-man's-switch path must fail closed rather than infer "registered" from a
 * shape we did not understand.
 */
export async function signalRestAccounts(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  tls?: SignalTlsOptions,
): Promise<string[]> {
  const normalized = normalizeBaseUrl(baseUrl);
  const res = await fetchWithTimeout(
    `${normalized}/v1/accounts`,
    withSignalTlsDispatcher({ method: "GET" }, tls),
    timeoutMs,
    getRequiredFetch(),
  );
  if (!res.ok) {
    throw new Error(`Signal REST accounts failed: HTTP ${res.status}`);
  }
  const text = await res.text();
  if (!text.trim()) {
    throw new Error("Signal REST accounts returned an empty body");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Signal REST accounts returned a non-JSON body");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Signal REST accounts returned an unexpected shape (expected a JSON array)");
  }
  return parsed.map((entry, index) => {
    const number = extractRestAccountNumber(entry);
    if (!number) {
      throw new Error(
        `Signal REST accounts returned an unrecognized entry at index ${index} (no E.164 number)`,
      );
    }
    return number;
  });
}

export async function streamSignalEvents(params: {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  tls?: SignalTlsOptions;
  onEvent: (event: SignalSseEvent) => void;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const url = new URL(`${baseUrl}/api/v1/events`);
  if (params.account) {
    url.searchParams.set("account", params.account);
  }

  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }
  const res = await fetchImpl(
    url,
    withSignalTlsDispatcher(
      {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        signal: params.abortSignal,
      },
      params.tls,
    ),
  );
  if (!res.ok || !res.body) {
    throw new Error(`Signal SSE failed (${res.status} ${res.statusText || "error"})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent: SignalSseEvent = {};

  const flushEvent = () => {
    if (!currentEvent.data && !currentEvent.event && !currentEvent.id) {
      return;
    }
    params.onEvent({
      event: currentEvent.event,
      data: currentEvent.data,
      id: currentEvent.id,
    });
    currentEvent = {};
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let lineEnd = buffer.indexOf("\n");
    while (lineEnd !== -1) {
      let line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      if (line === "") {
        flushEvent();
        lineEnd = buffer.indexOf("\n");
        continue;
      }
      if (line.startsWith(":")) {
        lineEnd = buffer.indexOf("\n");
        continue;
      }
      const [rawField, ...rest] = line.split(":");
      const field = rawField.trim();
      const rawValue = rest.join(":");
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "event") {
        currentEvent.event = value;
      } else if (field === "data") {
        currentEvent.data = currentEvent.data ? `${currentEvent.data}\n${value}` : value;
      } else if (field === "id") {
        currentEvent.id = value;
      }
      lineEnd = buffer.indexOf("\n");
    }
  }

  flushEvent();
}

/**
 * Translate a single bbernhard/signal-cli-rest-api WebSocket receive frame into
 * the {@link SignalSseEvent} shape the SSE event handler already consumes.
 *
 * The `/v1/receive/{number}` WebSocket (MODE=json-rpc) emits one signal-cli
 * receive payload per text frame — the same `{ envelope, account, exception }`
 * object the native `signal-cli daemon --http` delivers inside an SSE
 * "receive" event's `data` field. We only need to re-wrap it as
 * `{ event: "receive", data: <frame> }` so the entire downstream pipeline
 * (event-handler → gating → dispatch → captureInboundToBrain) is reused
 * unchanged.
 *
 * Returns `null` for frames that carry no actionable payload (empty frames,
 * non-JSON keepalives, or objects without an `envelope`/`exception`) so the
 * reconnect loop's attempt counter is not reset by noise.
 */
export function signalWsFrameToSseEvent(raw: string): SignalSseEvent | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  if (!("envelope" in parsed) && !("exception" in parsed)) {
    return null;
  }
  return { event: "receive", data: text };
}

function toWebSocketReceiveUrl(baseUrl: string, account: string): string {
  // normalizeBaseUrl guarantees an http(s):// prefix and strips trailing
  // slashes; swap the scheme (http->ws, https->wss) and append the receive
  // route. The account (E.164) is a path segment, so it must be encoded.
  const normalized = normalizeBaseUrl(baseUrl);
  const wsBase = normalized.replace(/^http/i, "ws");
  return `${wsBase}/v1/receive/${encodeURIComponent(account)}`;
}

/**
 * Inbound receive stream for the "rest" transport (bbernhard/signal-cli-rest-api).
 *
 * Opens a WebSocket to `${baseUrl}/v1/receive/{account}` and forwards each frame
 * to `onEvent` as a translated {@link SignalSseEvent}. Resolves when the socket
 * closes (so {@link runSignalWsLoop} can reconnect) and rejects on a transport
 * error unless the caller has already aborted. Mirrors the resolve/reject
 * contract of {@link streamSignalEvents} so the two are interchangeable behind
 * the transport check in the monitor.
 */
export async function streamSignalWsEvents(params: {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  tls?: SignalTlsOptions;
  onEvent: (event: SignalSseEvent) => void;
}): Promise<void> {
  const account = params.account?.trim();
  if (!account) {
    throw new Error(
      "Signal REST transport requires an E.164 `account` to open the receive WebSocket.",
    );
  }
  if (params.abortSignal?.aborted) {
    return;
  }

  const url = toWebSocketReceiveUrl(params.baseUrl, account);
  // `ws` forwards unknown client options to tls.connect(), so the same CA and
  // client keypair used for the REST calls also secure the receive socket.
  // Passing `undefined` keeps the plaintext call shape identical.
  const wsOptions = signalTlsWsOptions(params.tls);
  const ws = wsOptions ? new WebSocket(url, wsOptions) : new WebSocket(url);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      // Hard-terminate rather than close(): a graceful close waits for the
      // server's close frame (up to ws's 30s closeTimeout), which would stall
      // channel teardown. terminate() always emits 'close', which settles us.
      ws.terminate();
    };
    const finish = (err?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      params.abortSignal?.removeEventListener("abort", onAbort);
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    if (params.abortSignal) {
      params.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    ws.on("message", (data: WebSocket.RawData) => {
      const event = signalWsFrameToSseEvent(rawDataToString(data));
      if (event) {
        params.onEvent(event);
      }
    });
    ws.on("error", (err: Error) => {
      // A socket error after abort is expected teardown, not a failure.
      if (params.abortSignal?.aborted) {
        finish();
        return;
      }
      finish(err instanceof Error ? err : new Error(String(err)));
    });
    ws.on("close", () => {
      finish();
    });
  });
}
