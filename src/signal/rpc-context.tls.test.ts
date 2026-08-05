import { describe, expect, it, vi } from "vitest";
import { resolveSignalRpcContext } from "./rpc-context.js";

// `resolveSignalRpcContext` is the single point where every outbound RPC picks
// up its connection details, so this is where a dropped TLS block would silently
// downgrade send/typing/receipt/reaction traffic to plaintext.
const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

const tlsConfig = {
  httpUrl: "https://signal-proxy:8443",
  account: "+15559990000",
  transport: "rest" as const,
  tlsCaFile: "/certs/ca.crt",
  tlsCertFile: "/certs/client.crt",
  tlsKeyFile: "/certs/client.key",
};

describe("resolveSignalRpcContext TLS", () => {
  it("resolves the TLS block from the account config", () => {
    loadConfigMock.mockReturnValue({ channels: { signal: tlsConfig } });

    const ctx = resolveSignalRpcContext({});

    expect(ctx.baseUrl).toBe("https://signal-proxy:8443");
    expect(ctx.tls).toEqual({
      caFile: "/certs/ca.crt",
      certFile: "/certs/client.crt",
      keyFile: "/certs/client.key",
    });
  });

  it("resolves the TLS block from an explicitly supplied accountInfo", () => {
    loadConfigMock.mockReturnValue({});

    const ctx = resolveSignalRpcContext(
      {},
      {
        accountId: "default",
        enabled: true,
        baseUrl: "https://signal-proxy:8443",
        configured: true,
        config: tlsConfig,
      },
    );

    expect(ctx.tls?.certFile).toBe("/certs/client.crt");
  });

  it("prefers an explicit tls override over the account config", () => {
    loadConfigMock.mockReturnValue({ channels: { signal: tlsConfig } });

    const override = { caFile: "/o/ca", certFile: "/o/crt", keyFile: "/o/key" };
    expect(resolveSignalRpcContext({ tls: override }).tls).toBe(override);
  });

  it("leaves tls undefined for a plaintext account", () => {
    loadConfigMock.mockReturnValue({
      channels: { signal: { httpUrl: "http://signal-api:8080" } },
    });

    expect(resolveSignalRpcContext({}).tls).toBeUndefined();
  });

  it("throws rather than resolving a partial TLS block to plaintext", () => {
    loadConfigMock.mockReturnValue({
      channels: {
        signal: { httpUrl: "https://signal-proxy:8443", tlsCaFile: "/certs/ca.crt" },
      },
    });

    expect(() => resolveSignalRpcContext({})).toThrow(/incomplete/);
  });
});
