import { randomUUID } from "node:crypto";
import { resolveFetch } from "../infra/fetch.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";

export type SignalTransport = "json-rpc" | "rest";

export type SignalRpcOptions = {
  baseUrl: string;
  timeoutMs?: number;
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
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    },
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
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
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

export async function signalCheck(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; status?: number | null; error?: string | null }> {
  const normalized = normalizeBaseUrl(baseUrl);
  try {
    const res = await fetchWithTimeout(
      `${normalized}/api/v1/check`,
      { method: "GET" },
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

export async function streamSignalEvents(params: {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
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
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
    signal: params.abortSignal,
  });
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
