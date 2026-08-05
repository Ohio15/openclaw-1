import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

function expectValidConfig(result: ReturnType<typeof validateConfigObject>) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("expected config to be valid");
  }
  return result.config;
}

function expectInvalidConfig(result: ReturnType<typeof validateConfigObject>) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected config to be invalid");
  }
  return result.issues;
}

// The mTLS block is all-or-nothing: a partial block cannot complete a
// handshake, and silently accepting it would leave the gateway on plaintext
// against an operator who believes otherwise.
describe("config signal mTLS", () => {
  it("accepts a complete tls block", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          transport: "rest",
          httpUrl: "https://signal-proxy:8443",
          tlsCaFile: "/certs/ca.crt",
          tlsCertFile: "/certs/client.crt",
          tlsKeyFile: "/certs/client.key",
        },
      },
    });

    const config = expectValidConfig(res);
    expect(config.channels?.signal?.tlsCaFile).toBe("/certs/ca.crt");
    expect(config.channels?.signal?.tlsCertFile).toBe("/certs/client.crt");
    expect(config.channels?.signal?.tlsKeyFile).toBe("/certs/client.key");
  });

  it("accepts a signal config with no tls keys at all", () => {
    const res = validateConfigObject({
      channels: { signal: { httpUrl: "http://signal-api:8080" } },
    });

    const config = expectValidConfig(res);
    expect(config.channels?.signal?.tlsCaFile).toBeUndefined();
  });

  it("rejects a partial tls block at the channel level", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          tlsCaFile: "/certs/ca.crt",
          tlsCertFile: "/certs/client.crt",
        },
      },
    });

    const issues = expectInvalidConfig(res);
    expect(issues[0]?.path).toBe("channels.signal.tlsKeyFile");
    expect(issues[0]?.message).toMatch(/requires all of tlsCaFile, tlsCertFile, tlsKeyFile/);
  });

  it("rejects a partial tls block on a named account", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          accounts: {
            work: { tlsCertFile: "/certs/client.crt", tlsKeyFile: "/certs/client.key" },
          },
        },
      },
    });

    const issues = expectInvalidConfig(res);
    expect(issues[0]?.path).toBe("channels.signal.accounts.work.tlsCaFile");
  });

  it("accepts the shared-CA layout: CA at channel level, cert/key per account", () => {
    // The channel block is partial on its own, but no account resolves to that
    // view — every account merges the CA with its own keypair.
    const res = validateConfigObject({
      channels: {
        signal: {
          httpUrl: "https://signal-proxy:8443",
          tlsCaFile: "/certs/ca.crt",
          accounts: {
            alerts: { tlsCertFile: "/certs/alerts.crt", tlsKeyFile: "/certs/alerts.key" },
            ops: { tlsCertFile: "/certs/ops.crt", tlsKeyFile: "/certs/ops.key" },
          },
        },
      },
    });

    const config = expectValidConfig(res);
    expect(config.channels?.signal?.accounts?.alerts?.tlsCertFile).toBe("/certs/alerts.crt");
  });

  it("still rejects an account left partial by the shared-CA layout", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          httpUrl: "https://signal-proxy:8443",
          tlsCaFile: "/certs/ca.crt",
          accounts: {
            alerts: { tlsCertFile: "/certs/alerts.crt", tlsKeyFile: "/certs/alerts.key" },
            ops: { tlsCertFile: "/certs/ops.crt" },
          },
        },
      },
    });

    const issues = expectInvalidConfig(res);
    expect(issues[0]?.path).toBe("channels.signal.accounts.ops.tlsKeyFile");
  });

  it("rejects a complete tls block against a plaintext httpUrl", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          httpUrl: "http://signal-api:8080",
          tlsCaFile: "/certs/ca.crt",
          tlsCertFile: "/certs/client.crt",
          tlsKeyFile: "/certs/client.key",
        },
      },
    });

    const issues = expectInvalidConfig(res);
    expect(issues[0]?.path).toBe("channels.signal.httpUrl");
    expect(issues[0]?.message).toMatch(/only presented over https|only presented|https/);
  });

  it("rejects a complete tls block with no httpUrl (host/port derives http://)", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          httpHost: "signal-proxy",
          httpPort: 8443,
          tlsCaFile: "/certs/ca.crt",
          tlsCertFile: "/certs/client.crt",
          tlsKeyFile: "/certs/client.key",
        },
      },
    });

    const issues = expectInvalidConfig(res);
    expect(issues[0]?.path).toBe("channels.signal.httpUrl");
    expect(issues[0]?.message).toMatch(/http:\/\/signal-proxy:8443/);
  });

  it("rejects an account whose merged tls block lands on a plaintext url", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          httpUrl: "https://signal-proxy:8443",
          tlsCaFile: "/certs/ca.crt",
          accounts: {
            ops: {
              httpUrl: "http://signal-api:8080",
              tlsCertFile: "/certs/ops.crt",
              tlsKeyFile: "/certs/ops.key",
            },
          },
        },
      },
    });

    const issues = expectInvalidConfig(res);
    expect(issues[0]?.path).toBe("channels.signal.accounts.ops.httpUrl");
  });

  it("accepts an account that completes its block from the channel-level keys", () => {
    // `resolveSignalAccount` merges channel-level keys under account-level ones,
    // so an account overriding only the cert is complete at runtime.
    const res = validateConfigObject({
      channels: {
        signal: {
          httpUrl: "https://signal-proxy:8443",
          tlsCaFile: "/certs/ca.crt",
          tlsCertFile: "/certs/client.crt",
          tlsKeyFile: "/certs/client.key",
          accounts: {
            work: { tlsCertFile: "/certs/work.crt" },
          },
        },
      },
    });

    const config = expectValidConfig(res);
    expect(config.channels?.signal?.accounts?.work?.tlsCertFile).toBe("/certs/work.crt");
  });
});
