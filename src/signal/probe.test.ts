import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifySignalCliLogLine } from "./daemon.js";
import { probeSignal } from "./probe.js";

const signalCheckMock = vi.fn();
const signalRpcRequestMock = vi.fn();
const signalRestAboutMock = vi.fn();
const signalRestAccountsMock = vi.fn();

vi.mock("./client.js", () => ({
  signalCheck: (...args: unknown[]) => signalCheckMock(...args),
  signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
  signalRestAbout: (...args: unknown[]) => signalRestAboutMock(...args),
  signalRestAccounts: (...args: unknown[]) => signalRestAccountsMock(...args),
}));

// The account under test. Only its last 4 digits may ever appear in output.
const ACCOUNT = "+15550001234";

describe("probeSignal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signalRestAccountsMock.mockResolvedValue([ACCOUNT]);
  });

  it("extracts version from {version} result", async () => {
    signalCheckMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      error: null,
    });
    signalRpcRequestMock.mockResolvedValueOnce({ version: "0.13.22" });

    const res = await probeSignal("http://127.0.0.1:8080", 1000);

    expect(res.ok).toBe(true);
    expect(res.version).toBe("0.13.22");
    expect(res.status).toBe(200);
  });

  it("returns ok=false when /check fails", async () => {
    signalCheckMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      error: "HTTP 503",
    });

    const res = await probeSignal("http://127.0.0.1:8080", 1000);

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(res.version).toBe(null);
  });

  it("defaults to json-rpc and asks signalCheck for the daemon path", async () => {
    signalCheckMock.mockResolvedValueOnce({ ok: true, status: 200, error: null });
    signalRpcRequestMock.mockResolvedValueOnce({ version: "0.13.22" });

    await probeSignal("http://127.0.0.1:8080", 1000);

    expect(signalCheckMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8080",
      1000,
      "json-rpc",
      undefined,
    );
    expect(signalRestAboutMock).not.toHaveBeenCalled();
  });

  it("forwards the rest transport to signalCheck", async () => {
    signalCheckMock.mockResolvedValueOnce({ ok: true, status: 204, error: null });
    signalRestAboutMock.mockResolvedValueOnce({ version: "0.98" });

    const res = await probeSignal("http://signal-api:8080", 1000, "rest", ACCOUNT);

    expect(signalCheckMock).toHaveBeenCalledWith("http://signal-api:8080", 1000, "rest", undefined);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(204);
  });

  it("reads the rest version from /v1/about instead of the rpc endpoint", async () => {
    signalCheckMock.mockResolvedValueOnce({ ok: true, status: 204, error: null });
    signalRestAboutMock.mockResolvedValueOnce({ build: 2, version: "0.98" });

    const res = await probeSignal("http://signal-api:8080", 1000, "rest", ACCOUNT);

    expect(signalRestAboutMock).toHaveBeenCalledWith("http://signal-api:8080", 1000, undefined);
    // POST /api/v1/rpc does not exist on signal-cli-rest-api; never call it.
    expect(signalRpcRequestMock).not.toHaveBeenCalled();
    expect(res.version).toBe("0.98");
  });

  it("stays ok when the rest version lookup fails but health passed", async () => {
    signalCheckMock.mockResolvedValueOnce({ ok: true, status: 204, error: null });
    signalRestAboutMock.mockRejectedValueOnce(new Error("Signal REST about failed: HTTP 404"));

    const res = await probeSignal("http://signal-api:8080", 1000, "rest", ACCOUNT);

    expect(res.ok).toBe(true);
    expect(res.version).toBe(null);
    expect(res.error).toMatch(/HTTP 404/);
  });

  it("labels the version source so rest image versions are not compared to signal-cli versions", async () => {
    signalCheckMock.mockResolvedValueOnce({ ok: true, status: 204, error: null });
    signalRestAboutMock.mockResolvedValueOnce({ version: "0.98" });
    const rest = await probeSignal("http://signal-api:8080", 1000, "rest", ACCOUNT);

    signalCheckMock.mockResolvedValueOnce({ ok: true, status: 200, error: null });
    signalRpcRequestMock.mockResolvedValueOnce({ version: "0.13.22" });
    const rpc = await probeSignal("http://127.0.0.1:8080", 1000, "json-rpc");

    expect(rest.versionSource).toBe("rest-api");
    expect(rpc.versionSource).toBe("signal-cli");
  });

  it("warns exactly once when the transport is omitted", async () => {
    // Fresh module instance: the warn latch is module-scoped and earlier tests
    // in this file already call probeSignal without a transport.
    vi.resetModules();
    const { probeSignal: freshProbeSignal } = await import("./probe.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      signalCheckMock.mockResolvedValue({ ok: true, status: 200, error: null });
      signalRpcRequestMock.mockResolvedValue({ version: "0.13.22" });

      await freshProbeSignal("http://127.0.0.1:8080", 1000);
      await freshProbeSignal("http://127.0.0.1:8080", 1000);
      await freshProbeSignal("http://127.0.0.1:8080", 1000, "json-rpc");

      // Warn-once-per-process: the health refresh probes on an interval, so a
      // per-call warn would bury the signal it is meant to raise.
      const calls = warn.mock.calls.filter((call) => String(call[0]).includes("probeSignal()"));
      expect(calls).toHaveLength(1);
      expect(String(calls[0][0])).toMatch(/json-rpc/);
    } finally {
      warn.mockRestore();
    }
  });
});

// /v1/health on bbernhard/signal-cli-rest-api is container liveness only: it
// answers 204 while the HTTP server is up, says nothing about whether a number
// is registered, and is identical for every account sharing the container.
// These tests pin the account assertion that makes the probe mean something.
//
// NOTE: these are mock-based. They encode OUR reading of the signal-cli-rest-api
// contract (GET /v1/accounts -> JSON array of E.164 strings); they do not prove
// the image actually behaves that way.
describe("probeSignal rest account assertion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signalCheckMock.mockResolvedValue({ ok: true, status: 204, error: null });
    signalRestAboutMock.mockResolvedValue({ version: "0.98" });
  });

  it("is ok when the account is present in /v1/accounts", async () => {
    signalRestAccountsMock.mockResolvedValueOnce(["+15559990000", ACCOUNT]);

    const res = await probeSignal("http://signal-api:8080", 1000, "rest", ACCOUNT);

    expect(signalRestAccountsMock).toHaveBeenCalledWith("http://signal-api:8080", 1000, undefined);
    expect(res.ok).toBe(true);
    expect(res.error).toBe(null);
  });

  it("matches regardless of E.164 punctuation", async () => {
    signalRestAccountsMock.mockResolvedValueOnce(["+1 (555) 000-1234"]);

    const res = await probeSignal("http://signal-api:8080", 1000, "rest", ACCOUNT);

    expect(res.ok).toBe(true);
  });

  it("is NOT ok when health is 204 but the account is absent", async () => {
    signalRestAccountsMock.mockResolvedValueOnce(["+15559990000"]);

    const res = await probeSignal("http://signal-api:8080", 1000, "rest", ACCOUNT);

    expect(res.ok).toBe(false);
    expect(res.status).toBe(204);
    expect(res.error).toMatch(/not registered/i);
  });

  it("is NOT ok when no account is registered at all", async () => {
    signalRestAccountsMock.mockResolvedValueOnce([]);

    const res = await probeSignal("http://signal-api:8080", 1000, "rest", ACCOUNT);

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not registered/i);
  });

  it("redacts the phone number to its last 4 digits in errors", async () => {
    signalRestAccountsMock.mockResolvedValueOnce([]);

    const res = await probeSignal("http://signal-api:8080", 1000, "rest", ACCOUNT);

    expect(res.error).toContain("***1234");
    expect(res.error).not.toContain(ACCOUNT);
    expect(res.error).not.toContain("5550001234");
  });

  it("fails closed with a distinct error when /v1/accounts is unreachable", async () => {
    signalRestAccountsMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await probeSignal("http://signal-api:8080", 1000, "rest", ACCOUNT);

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/account check failed/i);
    expect(res.error).toMatch(/ECONNREFUSED/);
    // Distinct from the "registered set was read and the account is missing" case.
    expect(res.error).not.toMatch(/not registered/i);
  });

  it("fails closed when /v1/accounts returns a wrapped/unexpected shape", async () => {
    signalRestAccountsMock.mockRejectedValueOnce(
      new Error("Signal REST accounts returned an unexpected shape (expected a JSON array)"),
    );

    const res = await probeSignal("http://signal-api:8080", 1000, "rest", ACCOUNT);

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unexpected shape/);
  });

  it("fails closed when the rest account is not configured", async () => {
    const res = await probeSignal("http://signal-api:8080", 1000, "rest");

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/requires the account/i);
    expect(signalRestAccountsMock).not.toHaveBeenCalled();
  });

  it("skips the version lookup once the account assertion has failed", async () => {
    signalRestAccountsMock.mockResolvedValueOnce([]);

    await probeSignal("http://signal-api:8080", 1000, "rest", ACCOUNT);

    expect(signalRestAboutMock).not.toHaveBeenCalled();
  });

  it("leaves the json-rpc path untouched (no account lookup, account ignored)", async () => {
    signalCheckMock.mockResolvedValue({ ok: true, status: 200, error: null });
    signalRpcRequestMock.mockResolvedValueOnce({ version: "0.13.22" });

    const res = await probeSignal("http://127.0.0.1:8080", 1000, "json-rpc", ACCOUNT);

    expect(signalRestAccountsMock).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.version).toBe("0.13.22");
  });

  it("stays ok on json-rpc even with no account configured", async () => {
    signalCheckMock.mockResolvedValue({ ok: true, status: 200, error: null });
    signalRpcRequestMock.mockResolvedValueOnce({ version: "0.13.22" });

    const res = await probeSignal("http://127.0.0.1:8080", 1000, "json-rpc");

    expect(res.ok).toBe(true);
    expect(signalRestAccountsMock).not.toHaveBeenCalled();
  });
});

describe("classifySignalCliLogLine", () => {
  it("treats INFO/DEBUG as log (even if emitted on stderr)", () => {
    expect(classifySignalCliLogLine("INFO  DaemonCommand - Started")).toBe("log");
    expect(classifySignalCliLogLine("DEBUG Something")).toBe("log");
  });

  it("treats WARN/ERROR as error", () => {
    expect(classifySignalCliLogLine("WARN  Something")).toBe("error");
    expect(classifySignalCliLogLine("WARNING Something")).toBe("error");
    expect(classifySignalCliLogLine("ERROR Something")).toBe("error");
  });

  it("treats failures without explicit severity as error", () => {
    expect(classifySignalCliLogLine("Failed to initialize HTTP Server - oops")).toBe("error");
    expect(classifySignalCliLogLine('Exception in thread "main"')).toBe("error");
  });

  it("returns null for empty lines", () => {
    expect(classifySignalCliLogLine("")).toBe(null);
    expect(classifySignalCliLogLine("   ")).toBe(null);
  });
});
