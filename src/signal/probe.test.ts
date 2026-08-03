import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifySignalCliLogLine } from "./daemon.js";
import { probeSignal } from "./probe.js";

const signalCheckMock = vi.fn();
const signalRpcRequestMock = vi.fn();
const signalRestAboutMock = vi.fn();

vi.mock("./client.js", () => ({
  signalCheck: (...args: unknown[]) => signalCheckMock(...args),
  signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
  signalRestAbout: (...args: unknown[]) => signalRestAboutMock(...args),
}));

describe("probeSignal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    expect(signalCheckMock).toHaveBeenCalledWith("http://127.0.0.1:8080", 1000, "json-rpc");
    expect(signalRestAboutMock).not.toHaveBeenCalled();
  });

  it("forwards the rest transport to signalCheck", async () => {
    signalCheckMock.mockResolvedValueOnce({ ok: true, status: 204, error: null });
    signalRestAboutMock.mockResolvedValueOnce({ version: "0.98" });

    const res = await probeSignal("http://signal-api:8080", 1000, "rest");

    expect(signalCheckMock).toHaveBeenCalledWith("http://signal-api:8080", 1000, "rest");
    expect(res.ok).toBe(true);
    expect(res.status).toBe(204);
  });

  it("reads the rest version from /v1/about instead of the rpc endpoint", async () => {
    signalCheckMock.mockResolvedValueOnce({ ok: true, status: 204, error: null });
    signalRestAboutMock.mockResolvedValueOnce({ build: 2, version: "0.98" });

    const res = await probeSignal("http://signal-api:8080", 1000, "rest");

    expect(signalRestAboutMock).toHaveBeenCalledWith("http://signal-api:8080", 1000);
    // POST /api/v1/rpc does not exist on signal-cli-rest-api; never call it.
    expect(signalRpcRequestMock).not.toHaveBeenCalled();
    expect(res.version).toBe("0.98");
  });

  it("stays ok when the rest version lookup fails but health passed", async () => {
    signalCheckMock.mockResolvedValueOnce({ ok: true, status: 204, error: null });
    signalRestAboutMock.mockRejectedValueOnce(new Error("Signal REST about failed: HTTP 404"));

    const res = await probeSignal("http://signal-api:8080", 1000, "rest");

    expect(res.ok).toBe(true);
    expect(res.version).toBe(null);
    expect(res.error).toMatch(/HTTP 404/);
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
