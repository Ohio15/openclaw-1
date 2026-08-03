import type { BaseProbeResult } from "../channels/plugins/types.js";
import { signalCheck, signalRestAbout, signalRpcRequest, type SignalTransport } from "./client.js";

export type SignalProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs: number;
  version?: string | null;
};

function parseSignalVersion(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "object" && value !== null) {
    const version = (value as { version?: unknown }).version;
    if (typeof version === "string" && version.trim()) {
      return version.trim();
    }
  }
  return null;
}

export async function probeSignal(
  baseUrl: string,
  timeoutMs: number,
  transport: SignalTransport = "json-rpc",
): Promise<SignalProbe> {
  const started = Date.now();
  const result: SignalProbe = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0,
    version: null,
  };
  const check = await signalCheck(baseUrl, timeoutMs, transport);
  if (!check.ok) {
    return {
      ...result,
      status: check.status ?? null,
      error: check.error ?? "unreachable",
      elapsedMs: Date.now() - started,
    };
  }
  try {
    // "rest" (bbernhard/signal-cli-rest-api) serves no RPC endpoint — POSTing
    // `version` to /api/v1/rpc 404s there. Its build info is on GET /v1/about.
    const version =
      transport === "rest"
        ? await signalRestAbout(baseUrl, timeoutMs)
        : await signalRpcRequest("version", undefined, {
            baseUrl,
            timeoutMs,
          });
    result.version = parseSignalVersion(version);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return {
    ...result,
    ok: true,
    status: check.status ?? null,
    elapsedMs: Date.now() - started,
  };
}
