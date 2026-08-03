import { beforeEach, describe, expect, it, vi } from "vitest";
import { signalCheck, signalRestAbout, signalRestAccounts } from "./client.js";

// The two Signal backends expose different health contracts and each 404s on
// the other's path, so these tests pin the exact URL per transport:
//   - signal-cli daemon --http        -> GET /api/v1/check
//   - bbernhard/signal-cli-rest-api   -> GET /v1/health (204), GET /v1/about
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/fetch.js", () => ({
  resolveFetch: () => fetchMock as unknown as typeof fetch,
}));

function requestedUrl(call = 0): string {
  return String(fetchMock.mock.calls[call]?.[0]);
}

describe("signalCheck", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("defaults to the json-rpc daemon check path", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const res = await signalCheck("http://127.0.0.1:8080", 1000);

    expect(requestedUrl()).toBe("http://127.0.0.1:8080/api/v1/check");
    expect(res).toEqual({ ok: true, status: 200, error: null });
  });

  it("uses the daemon check path when transport is json-rpc", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const res = await signalCheck("http://127.0.0.1:8080", 1000, "json-rpc");

    expect(requestedUrl()).toBe("http://127.0.0.1:8080/api/v1/check");
    expect(res.ok).toBe(true);
  });

  it("uses /v1/health when transport is rest", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await signalCheck("http://signal-api:8080", 1000, "rest");

    expect(requestedUrl()).toBe("http://signal-api:8080/v1/health");
    expect(res).toEqual({ ok: true, status: 204, error: null });
  });

  it("normalizes a bare host and trailing slashes before appending the path", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await signalCheck("signal-api:8080//", 1000, "rest");

    expect(requestedUrl()).toBe("http://signal-api:8080/v1/health");
  });

  it("reports ok=false on 404 (the live symptom of probing the wrong path)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("404 page not found", { status: 404 }));

    const res = await signalCheck("http://signal-api:8080", 1000, "rest");

    expect(res).toEqual({ ok: false, status: 404, error: "HTTP 404" });
  });

  it("reports ok=false with a null status when the request throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await signalCheck("http://127.0.0.1:8080", 1000);

    expect(res.ok).toBe(false);
    expect(res.status).toBe(null);
    expect(res.error).toBe("ECONNREFUSED");
  });
});

describe("signalRestAbout", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("GETs /v1/about and returns the parsed body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ build: 2, version: "0.98", versions: ["v1", "v2"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const about = await signalRestAbout("http://signal-api:8080", 1000);

    expect(requestedUrl()).toBe("http://signal-api:8080/v1/about");
    expect((about as { version?: string }).version).toBe("0.98");
  });

  it("throws on a non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));

    await expect(signalRestAbout("http://signal-api:8080", 1000)).rejects.toThrow(
      /Signal REST about failed: HTTP 500/,
    );
  });

  it("throws on a non-JSON body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>oops</html>", { status: 200 }));

    await expect(signalRestAbout("http://signal-api:8080", 1000)).rejects.toThrow(/non-JSON body/);
  });
});

// NOTE: mock-based. These pin OUR reading of the signal-cli-rest-api contract
// (GET /v1/accounts -> JSON array of E.164 strings) and the defensive parsing
// around it; they do not prove the image behaves this way.
describe("signalRestAccounts", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("GETs /v1/accounts and returns the documented array of E.164 strings", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(["+15550001234", "+15559990000"]));

    const accounts = await signalRestAccounts("http://signal-api:8080", 1000);

    expect(requestedUrl()).toBe("http://signal-api:8080/v1/accounts");
    expect(accounts).toEqual(["+15550001234", "+15559990000"]);
  });

  it("accepts object entries carrying a number/account field", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([{ number: "+15550001234", uuid: "abc" }, { account: "+15559990000" }]),
    );

    await expect(signalRestAccounts("http://signal-api:8080", 1000)).resolves.toEqual([
      "+15550001234",
      "+15559990000",
    ]);
  });

  it("returns an empty list when no account is registered", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    await expect(signalRestAccounts("http://signal-api:8080", 1000)).resolves.toEqual([]);
  });

  it("normalizes a bare host before appending the path", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    await signalRestAccounts("signal-api:8080//", 1000);

    expect(requestedUrl()).toBe("http://signal-api:8080/v1/accounts");
  });

  it("throws on a non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("404 page not found", { status: 404 }));

    await expect(signalRestAccounts("http://signal-api:8080", 1000)).rejects.toThrow(
      /Signal REST accounts failed: HTTP 404/,
    );
  });

  it("throws on an empty body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));

    await expect(signalRestAccounts("http://signal-api:8080", 1000)).rejects.toThrow(/empty body/);
  });

  it("throws on a non-JSON body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>oops</html>", { status: 200 }));

    await expect(signalRestAccounts("http://signal-api:8080", 1000)).rejects.toThrow(
      /non-JSON body/,
    );
  });

  it("throws (never silently succeeds) on a wrapped envelope", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ accounts: ["+15550001234"] }));

    await expect(signalRestAccounts("http://signal-api:8080", 1000)).rejects.toThrow(
      /unexpected shape/,
    );
  });

  it("throws on an entry with no recognizable E.164 number", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ uuid: "abc" }]));

    await expect(signalRestAccounts("http://signal-api:8080", 1000)).rejects.toThrow(
      /unrecognized entry at index 0/,
    );
  });
});
