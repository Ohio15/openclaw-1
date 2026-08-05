import { describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { listSignalAccountIds, resolveSignalAccount } from "../signal/accounts.js";
import { resolveSignalTlsOptions } from "../signal/tls.js";
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

  it("accepts the shared-CA layout when an explicit default account completes it", () => {
    // The channel block is partial on its own; every account that resolves —
    // including the implicit "default" — merges the CA with its own keypair.
    const res = validateConfigObject({
      channels: {
        signal: {
          httpUrl: "https://signal-proxy:8443",
          tlsCaFile: "/certs/ca.crt",
          accounts: {
            default: { tlsCertFile: "/certs/default.crt", tlsKeyFile: "/certs/default.key" },
            alerts: { tlsCertFile: "/certs/alerts.crt", tlsKeyFile: "/certs/alerts.key" },
            ops: { tlsCertFile: "/certs/ops.crt", tlsKeyFile: "/certs/ops.key" },
          },
        },
      },
    });

    const config = expectValidConfig(res);
    expect(config.channels?.signal?.accounts?.alerts?.tlsCertFile).toBe("/certs/alerts.crt");
  });

  it("rejects the shared-CA layout without an explicit default account", () => {
    // resolveSignalAccount synthesizes "default" from the bare channel block for
    // every accountId-less send, so this shape would validate green and throw at
    // send time.
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

    const issues = expectInvalidConfig(res);
    expect(issues[0]?.path).toBe("channels.signal.tlsCertFile");
    expect(issues[0]?.message).toMatch(
      /partial and unlisted accounts \(including the implicit "default" used by accountId-less sends\) inherit it as-is/,
    );
    expect(issues[0]?.message).toMatch(
      /complete the channel-level block, or add an explicit channels\.signal\.accounts\.default entry/,
    );
  });

  it("rejects a partial default account under the shared-CA layout", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          httpUrl: "https://signal-proxy:8443",
          tlsCaFile: "/certs/ca.crt",
          accounts: {
            default: { tlsCertFile: "/certs/default.crt" },
            alerts: { tlsCertFile: "/certs/alerts.crt", tlsKeyFile: "/certs/alerts.key" },
          },
        },
      },
    });

    const issues = expectInvalidConfig(res);
    expect(issues.some((issue) => issue.path === "channels.signal.tlsCertFile")).toBe(true);
  });

  it("still rejects an account left partial by the shared-CA layout", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          httpUrl: "https://signal-proxy:8443",
          tlsCaFile: "/certs/ca.crt",
          accounts: {
            default: { tlsCertFile: "/certs/default.crt", tlsKeyFile: "/certs/default.key" },
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
            default: { tlsCertFile: "/certs/default.crt", tlsKeyFile: "/certs/default.key" },
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

// Two reviews in a row found defects where the validator accepted a shape the
// runtime then rejected. Validation tests that only assert what the validator
// does cannot catch that class, so this walks each accepted shape through the
// actual runtime resolution — including the accountId-less path, which
// `resolveSignalAccount` synthesizes from the bare channel block.
describe("config signal mTLS validator/runtime consistency", () => {
  const acceptedShapes: Array<{ name: string; signal: Record<string, unknown> }> = [
    {
      name: "no TLS anywhere",
      signal: { httpUrl: "http://signal-api:8080" },
    },
    {
      name: "complete channel-level block",
      signal: {
        httpUrl: "https://signal-proxy:8443",
        tlsCaFile: "/certs/ca.crt",
        tlsCertFile: "/certs/client.crt",
        tlsKeyFile: "/certs/client.key",
      },
    },
    {
      name: "complete channel-level block with a partial account override",
      signal: {
        httpUrl: "https://signal-proxy:8443",
        tlsCaFile: "/certs/ca.crt",
        tlsCertFile: "/certs/client.crt",
        tlsKeyFile: "/certs/client.key",
        accounts: { work: { tlsCertFile: "/certs/work.crt" } },
      },
    },
    {
      name: "shared-CA layout with an explicit default account (the documented example)",
      signal: {
        httpUrl: "https://signal-proxy:8443",
        tlsCaFile: "/certs/ca.crt",
        accounts: {
          default: { tlsCertFile: "/certs/default.crt", tlsKeyFile: "/certs/default.key" },
          alerts: { tlsCertFile: "/certs/alerts.crt", tlsKeyFile: "/certs/alerts.key" },
        },
      },
    },
  ];

  it("pins the account id the schema assumes for unlisted accounts", () => {
    expect(DEFAULT_ACCOUNT_ID).toBe("default");
  });

  for (const shape of acceptedShapes) {
    it(`resolves every account without throwing: ${shape.name}`, () => {
      const cfg = expectValidConfig(validateConfigObject({ channels: { signal: shape.signal } }));

      // undefined is the accountId-less path taken by outbound delivery.
      const accountIds: Array<string | undefined> = [undefined, ...listSignalAccountIds(cfg)];
      for (const accountId of accountIds) {
        const account = resolveSignalAccount({ cfg, accountId });
        expect(() => resolveSignalTlsOptions(account.config)).not.toThrow();
      }
    });
  }

  it("resolves the documented shared-CA example's default account to a complete block", () => {
    const cfg = expectValidConfig(
      validateConfigObject({
        channels: {
          signal: {
            httpUrl: "https://signal-proxy:8443",
            tlsCaFile: "/certs/ca.crt",
            accounts: {
              default: { tlsCertFile: "/certs/default.crt", tlsKeyFile: "/certs/default.key" },
              alerts: { tlsCertFile: "/certs/alerts.crt", tlsKeyFile: "/certs/alerts.key" },
            },
          },
        },
      }),
    );

    expect(resolveSignalTlsOptions(resolveSignalAccount({ cfg }).config)).toEqual({
      caFile: "/certs/ca.crt",
      certFile: "/certs/default.crt",
      keyFile: "/certs/default.key",
    });
    expect(
      resolveSignalTlsOptions(resolveSignalAccount({ cfg, accountId: "alerts" }).config),
    ).toEqual({
      caFile: "/certs/ca.crt",
      certFile: "/certs/alerts.crt",
      keyFile: "/certs/alerts.key",
    });
  });
});
