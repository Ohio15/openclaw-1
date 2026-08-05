import { describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
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
//
// Where a test's intent is "this config must not load", it asserts `ok:false`
// plus the issue path and nothing about the prose. A message regex is a pin on
// wording, not on behaviour: it goes red when someone improves the sentence,
// and it stays green for a mutation that keeps the sentence while dropping the
// rejection — exactly backwards from what a fence is for.
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
    // The account's own block is incomplete, and — because no TLS material sits
    // at the channel level — every unlisted account would resolve to plaintext.
    // Both are reported; the set matters, the ordering does not.
    const paths = issues.map((issue) => issue.path);
    expect(paths).toContain("channels.signal.tlsCaFile");
    expect(paths).toContain("channels.signal.accounts.work.tlsCaFile");
  });

  it("accepts per-account certificates layered on a complete channel-level block", () => {
    // The channel block is the transport every unlisted/implicit account
    // inherits, so it carries a full default identity; accounts override the
    // keypair on top of it.
    const res = validateConfigObject({
      channels: {
        signal: {
          httpUrl: "https://signal-proxy:8443",
          tlsCaFile: "/certs/ca.crt",
          tlsCertFile: "/certs/default.crt",
          tlsKeyFile: "/certs/default.key",
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

  it("rejects the shared-CA layout even when an explicit default account completes it", () => {
    // `resolveSignalAccount` synthesizes an account from the bare channel block
    // for EVERY unlisted id, not just "default", so completing "default" leaves
    // every other id resolving to a partial block that throws at send time.
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

    const issues = expectInvalidConfig(res);
    expect(issues[0]?.path).toBe("channels.signal.tlsCertFile");
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

  it("still rejects an account left partial on top of a complete channel block", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          httpUrl: "https://signal-proxy:8443",
          tlsCaFile: "/certs/ca.crt",
          tlsCertFile: "/certs/default.crt",
          tlsKeyFile: "/certs/default.key",
          accounts: {
            alerts: { tlsCertFile: "/certs/alerts.crt", tlsKeyFile: "/certs/alerts.key" },
            ops: { tlsCertFile: "/certs/ops.crt", tlsKeyFile: "" },
          },
        },
      },
    });

    const issues = expectInvalidConfig(res);
    expect(issues[0]?.path).toBe("channels.signal.accounts.ops.tlsKeyFile");
  });

  it("rejects an account that blanks every inherited TLS path", () => {
    // A cleared block resolves to `undefined` TLS options — a silent plaintext
    // send against a channel the operator configured for mTLS.
    const res = validateConfigObject({
      channels: {
        signal: {
          httpUrl: "https://signal-proxy:8443",
          tlsCaFile: "/certs/ca.crt",
          tlsCertFile: "/certs/default.crt",
          tlsKeyFile: "/certs/default.key",
          accounts: {
            ops: { tlsCaFile: "", tlsCertFile: "", tlsKeyFile: "" },
          },
        },
      },
    });

    const issues = expectInvalidConfig(res);
    expect(issues[0]?.path).toBe("channels.signal.accounts.ops.tlsCaFile");
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
  });

  it("rejects an account whose merged tls block lands on a plaintext url", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          httpUrl: "https://signal-proxy:8443",
          tlsCaFile: "/certs/ca.crt",
          tlsCertFile: "/certs/default.crt",
          tlsKeyFile: "/certs/default.key",
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
      name: "per-account keypairs layered on a complete channel block (the documented example)",
      signal: {
        httpUrl: "https://signal-proxy:8443",
        tlsCaFile: "/certs/ca.crt",
        tlsCertFile: "/certs/default.crt",
        tlsKeyFile: "/certs/default.key",
        accounts: {
          alerts: { tlsCertFile: "/certs/alerts.crt", tlsKeyFile: "/certs/alerts.key" },
        },
      },
    },
    {
      name: "per-account https origins over a complete channel block",
      signal: {
        httpUrl: "https://signal-proxy:8443",
        tlsCaFile: "/certs/ca.crt",
        tlsCertFile: "/certs/default.crt",
        tlsKeyFile: "/certs/default.key",
        accounts: {
          default: { httpUrl: "https://signal-default:8443" },
          alerts: { httpUrl: "https://signal-alerts:8443", tlsCertFile: "/certs/alerts.crt" },
        },
      },
    },
  ];

  // Shapes that resolve, for at least one reachable accountId, to a transport
  // view the validator never inspected. Each was empirically confirmed to
  // validate green before the class-scoped channel-block invariant landed.
  const rejectedShapes: Array<{ name: string; signal: Record<string, unknown>; path: string }> = [
    {
      name: "Shape A — plaintext channel block, mTLS only on a named account",
      signal: {
        httpUrl: "http://signal-api:8080",
        accounts: {
          alerts: {
            httpUrl: "https://signal-proxy:8443",
            tlsCaFile: "/certs/ca.crt",
            tlsCertFile: "/certs/alerts.crt",
            tlsKeyFile: "/certs/alerts.key",
          },
        },
      },
      path: "channels.signal.tlsCaFile",
    },
    {
      name: "Shape B — https channel block with no TLS material, mTLS only on a named account",
      signal: {
        httpUrl: "https://signal-proxy:8443",
        accounts: {
          alerts: {
            tlsCaFile: "/certs/ca.crt",
            tlsCertFile: "/certs/alerts.crt",
            tlsKeyFile: "/certs/alerts.key",
          },
        },
      },
      path: "channels.signal.tlsCaFile",
    },
    {
      name: "Shape C — shared CA at channel level, keypairs on default plus a named account",
      signal: {
        httpUrl: "https://signal-proxy:8443",
        tlsCaFile: "/certs/ca.crt",
        accounts: {
          default: { tlsCertFile: "/certs/default.crt", tlsKeyFile: "/certs/default.key" },
          alerts: { tlsCertFile: "/certs/alerts.crt", tlsKeyFile: "/certs/alerts.key" },
        },
      },
      path: "channels.signal.tlsCertFile",
    },
  ];

  const TLS_KEYS = ["tlsCaFile", "tlsCertFile", "tlsKeyFile"] as const;

  type RawBlock = Record<string, unknown>;

  function hasTlsKey(block: RawBlock | undefined): boolean {
    if (!block) {
      return false;
    }
    return TLS_KEYS.some((key) => {
      const raw = block[key];
      return typeof raw === "string" && raw.trim().length > 0;
    });
  }

  /** Any TLS material anywhere in the signal block, channel level or account. */
  function signalBlockConfiguresTls(signal: RawBlock): boolean {
    const accounts = (signal.accounts ?? {}) as Record<string, RawBlock | undefined>;
    return hasTlsKey(signal) || Object.values(accounts).some((account) => hasTlsKey(account));
  }

  /**
   * The entry the RUNTIME lookup finds for `accountId` — the real
   * `normalizeAccountId`, never a copy of its rules, because the whole class of
   * defect this file guards is the validator and the resolver disagreeing about
   * which entry an id names.
   */
  function accountEntry(signal: RawBlock, accountId: string | undefined): RawBlock | undefined {
    const accounts = (signal.accounts ?? {}) as Record<string, RawBlock | undefined>;
    return accounts[normalizeAccountId(accountId)];
  }

  type ExpectedView = {
    tls: { caFile: string; certFile: string; keyFile: string } | undefined;
    tlsKeysSet: number;
    baseUrl: string;
  };

  /**
   * THE transport view the validator inspected for this id — not "a complete
   * one". Built from the raw fixture with the same `account.x ?? channel.x`
   * merge the schema performs, so the assertion is identity, not plausibility:
   * a resolver that returned some other account's certificate, or the channel
   * certificate where an account override was expected, fails here.
   */
  function expectedView(signal: RawBlock, accountId: string | undefined): ExpectedView {
    const account = accountEntry(signal, accountId) ?? {};
    const pick = (key: string): unknown => account[key] ?? signal[key];
    const str = (key: string): string | undefined => {
      const raw = pick(key);
      return typeof raw === "string" ? raw.trim() : undefined;
    };
    const paths = {
      caFile: str("tlsCaFile"),
      certFile: str("tlsCertFile"),
      keyFile: str("tlsKeyFile"),
    };
    const tlsKeysSet = Object.values(paths).filter((value) => value).length;
    const httpUrl = str("httpUrl");
    const host = str("httpHost") || "127.0.0.1";
    const portRaw = pick("httpPort");
    const port = typeof portRaw === "number" ? portRaw : 8080;
    return {
      tls:
        tlsKeysSet === TLS_KEYS.length
          ? (paths as { caFile: string; certFile: string; keyFile: string })
          : undefined,
      tlsKeysSet,
      baseUrl: httpUrl || `http://${host}:${port}`,
    };
  }

  it("pins the account id the schema assumes for unlisted accounts", () => {
    expect(DEFAULT_ACCOUNT_ID).toBe("default");
  });

  for (const shape of rejectedShapes) {
    // The requirement is that the config does not load, reported against the
    // key the operator has to fix. Pinning the prose as well turns a wording
    // edit into a red test and, worse, lets a mutation that keeps the wording
    // while dropping the rejection look like it was caught.
    it(`rejects a shape whose unlisted accounts escape validation: ${shape.name}`, () => {
      const issues = expectInvalidConfig(
        validateConfigObject({ channels: { signal: shape.signal } }),
      );
      expect(issues.map((issue) => issue.path)).toContain(shape.path);
    });
  }

  // An `accounts` key that is not already a normalized id is unreachable:
  // `resolveSignalAccount` normalizes the requested id and then indexes
  // `accounts` with the normalized string, so the entry is never found and the
  // account silently presents the CHANNEL-level client certificate — a
  // fully-specified per-account identity that validates green and is inert.
  const nonNormalizedKeys = ["Alerts", "ops.eu", "ops eu", "DEFAULT", "a".repeat(70)];
  for (const key of nonNormalizedKeys) {
    it(`rejects an accounts key the runtime lookup can never match: ${JSON.stringify(key)}`, () => {
      expect(normalizeAccountId(key)).not.toBe(key);
      const issues = expectInvalidConfig(
        validateConfigObject({
          channels: {
            signal: {
              httpUrl: "https://signal-proxy:8443",
              tlsCaFile: "/certs/ca.crt",
              tlsCertFile: "/certs/default.crt",
              tlsKeyFile: "/certs/default.key",
              accounts: {
                [key]: { tlsCertFile: "/certs/scoped.crt", tlsKeyFile: "/certs/scoped.key" },
              },
            },
          },
        }),
      );
      expect(issues.map((issue) => issue.path)).toContain(`channels.signal.accounts.${key}`);
    });
  }

  it("accepts the normalized form of a rejected accounts key", () => {
    // The guard has to be about reachability, not about rejecting anything
    // unusual: the normalized spelling of the same account must still load.
    const cfg = expectValidConfig(
      validateConfigObject({
        channels: {
          signal: {
            httpUrl: "https://signal-proxy:8443",
            tlsCaFile: "/certs/ca.crt",
            tlsCertFile: "/certs/default.crt",
            tlsKeyFile: "/certs/default.key",
            accounts: {
              [normalizeAccountId("ops.eu")]: {
                tlsCertFile: "/certs/scoped.crt",
                tlsKeyFile: "/certs/scoped.key",
              },
            },
          },
        },
      }),
    );

    expect(
      resolveSignalTlsOptions(resolveSignalAccount({ cfg, accountId: "ops-eu" }).config),
    ).toEqual({
      caFile: "/certs/ca.crt",
      certFile: "/certs/scoped.crt",
      keyFile: "/certs/scoped.key",
    });
  });

  for (const shape of acceptedShapes) {
    it(`resolves every account id to the validated transport: ${shape.name}`, () => {
      const cfg = expectValidConfig(validateConfigObject({ channels: { signal: shape.signal } }));
      const tlsConfigured = signalBlockConfiguresTls(shape.signal);

      // `undefined` is the accountId-less path outbound delivery takes, and
      // unlisted ids (a typo, a stale routing key) are synthesized from the bare
      // channel block — neither appears in listSignalAccountIds.
      const accountIds: Array<string | undefined> = [
        undefined,
        ...listSignalAccountIds(cfg),
        DEFAULT_ACCOUNT_ID,
        "zz-unlisted",
      ];
      for (const accountId of accountIds) {
        const account = resolveSignalAccount({ cfg, accountId });
        const label = `accountId=${String(accountId)}`;
        let tls: ReturnType<typeof resolveSignalTlsOptions>;
        try {
          // The real resolver, never a reimplementation of the merge rules.
          tls = resolveSignalTlsOptions(account.config);
        } catch (err) {
          throw new Error(
            `resolveSignalTlsOptions threw for ${label}: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
        // Identity, not plausibility: the resolver must land on exactly the
        // view the validator inspected for this id — these cert paths, this
        // origin. "Some complete TLS view" would pass while the account
        // presented the wrong certificate at the mTLS boundary.
        const expected = expectedView(shape.signal, accountId);
        expect(
          [0, TLS_KEYS.length],
          `${label}: an accepted shape must never resolve to a partial TLS block`,
        ).toContain(expected.tlsKeysSet);
        expect(tls, label).toEqual(expected.tls);
        expect(account.baseUrl, label).toBe(expected.baseUrl);

        if (!tlsConfigured) {
          // No TLS anywhere: every id stays on the untouched plaintext path.
          expect(tls, label).toBeUndefined();
          expect(account.baseUrl, label).toMatch(/^http:\/\//);
          continue;
        }
        // TLS configured somewhere: every reachable id must resolve to a
        // complete client-certificate set against an https origin. Anything
        // else is either a runtime throw or a silent plaintext send.
        expect(tls, label).toBeDefined();
        expect(account.baseUrl, label).toMatch(/^https:\/\//);
      }
    });

    it(`lists only account ids the resolver can find: ${shape.name}`, () => {
      const cfg = expectValidConfig(validateConfigObject({ channels: { signal: shape.signal } }));
      const accounts = (shape.signal.accounts ?? {}) as Record<string, RawBlock | undefined>;
      // The bare channel block, i.e. what an id resolves to when its entry is
      // NOT found. Every configured account must resolve to something the
      // lookup actually reached, not to this.
      const bareChannelView = resolveSignalAccount({ cfg, accountId: "zz-unlisted" })
        .config as RawBlock;

      for (const accountId of listSignalAccountIds(cfg)) {
        expect(accountId, `${accountId} is not in normalized form`).toBe(
          normalizeAccountId(accountId),
        );
        const resolved = resolveSignalAccount({ cfg, accountId });
        expect(resolved.accountId, accountId).toBe(accountId);
        const entry = accounts[accountId];
        if (!entry) {
          // No `accounts` block at all: the list is the implicit default id.
          expect(Object.keys(accounts), accountId).toHaveLength(0);
          continue;
        }
        const merged = resolved.config as RawBlock;
        for (const [key, want] of Object.entries(entry)) {
          // Every key the entry declares survives the merge — proof the lookup
          // found THIS entry rather than falling through to the channel block.
          expect(merged[key], `${accountId}.${key}`).toEqual(want);
          if (bareChannelView[key] !== want) {
            expect(merged[key], `${accountId}.${key} shadowed the channel block`).not.toEqual(
              bareChannelView[key],
            );
          }
        }
      }
    });
  }

  it("resolves the documented example's implicit and unlisted accounts to the channel identity", () => {
    const cfg = expectValidConfig(
      validateConfigObject({
        channels: {
          signal: {
            httpUrl: "https://signal-proxy:8443",
            tlsCaFile: "/certs/ca.crt",
            tlsCertFile: "/certs/default.crt",
            tlsKeyFile: "/certs/default.key",
            accounts: {
              alerts: { tlsCertFile: "/certs/alerts.crt", tlsKeyFile: "/certs/alerts.key" },
            },
          },
        },
      }),
    );

    const channelIdentity = {
      caFile: "/certs/ca.crt",
      certFile: "/certs/default.crt",
      keyFile: "/certs/default.key",
    };
    expect(resolveSignalTlsOptions(resolveSignalAccount({ cfg }).config)).toEqual(channelIdentity);
    expect(
      resolveSignalTlsOptions(resolveSignalAccount({ cfg, accountId: "zz-unlisted" }).config),
    ).toEqual(channelIdentity);
    expect(
      resolveSignalTlsOptions(resolveSignalAccount({ cfg, accountId: "alerts" }).config),
    ).toEqual({
      caFile: "/certs/ca.crt",
      certFile: "/certs/alerts.crt",
      keyFile: "/certs/alerts.key",
    });
  });
});
