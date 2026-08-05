import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import { listSignalAccountIds, resolveSignalAccount } from "../signal/accounts.js";
import { resolveSignalTlsOptions } from "../signal/tls.js";
import { validateConfigObject } from "./config.js";
import { applyMergePatch } from "./merge-patch.js";
import { restoreRedactedValues } from "./redact-snapshot.js";
import { resolveSignalBaseUrlForValidation } from "./zod-schema.providers-core.js";

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
    {
      // An own key whose value is `undefined`: the validator reads it as an
      // absent override (`account.x ?? channel.x`), so the resolver has to as
      // well. A plain spread would blank the inherited path instead and this
      // shape would resolve to a partial block that throws at send time.
      name: "account overrides present but undefined",
      signal: {
        httpUrl: "https://signal-proxy:8443",
        tlsCaFile: "/certs/ca.crt",
        tlsCertFile: "/certs/default.crt",
        tlsKeyFile: "/certs/default.key",
        accounts: {
          ops: { tlsCertFile: undefined },
          alerts: { tlsCaFile: undefined, tlsCertFile: undefined, tlsKeyFile: undefined },
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
          if (want === undefined) {
            // An own key set to `undefined` is an ABSENT override, not a request
            // to clear the inherited value — the same reading the schema's `??`
            // merge takes. It must inherit, not blank out.
            expect(merged[key], `${accountId}.${key} (undefined override)`).toEqual(
              bareChannelView[key],
            );
            continue;
          }
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

// `normalizeAccountId` is not the whole reachability story: a key can survive
// normalization unchanged and still never exist as an entry. `__proto__` is that
// key — assigning it on a plain object drives the `Object.prototype` setter
// instead of creating an own property, so the record parse drops it, the config
// loads green, every send for that id presents the CHANNEL-level client
// certificate, and the next config write persists the block erased.
describe("config signal accounts keys that cannot exist as entries", () => {
  const CHANNEL_BLOCK = `
      httpUrl: "https://signal-proxy:8443",
      tlsCaFile: "/certs/ca.crt",
      tlsCertFile: "/certs/default.crt",
      tlsKeyFile: "/certs/default.key",`;

  // The real file path: JSON5 keeps "__proto__" as an own key of the parsed
  // object, exactly as `parseConfigJson5` hands it to validation. Building the
  // fixture with an object literal would set the prototype instead and test
  // nothing.
  const configFromJson5 = (accountsBody: string): unknown =>
    JSON5.parse(`{
  channels: {
    signal: {${CHANNEL_BLOCK}
      accounts: { ${accountsBody} },
    },
  },
}`);

  const signalAccountsOf = (config: unknown): object =>
    (config as { channels: { signal: { accounts: object } } }).channels.signal.accounts;

  it("rejects an accounts key the record parse would silently drop", () => {
    const raw = configFromJson5(
      `"__proto__": { tlsCertFile: "/certs/scoped.crt", tlsKeyFile: "/certs/scoped.key" }`,
    );
    // The premise: the key really is an own key of the parsed document, so the
    // fence has to run before the record parse discards it.
    expect(Object.hasOwn(signalAccountsOf(raw), "__proto__")).toBe(true);
    expect(normalizeAccountId("__proto__")).toBe("__proto__");

    const issues = expectInvalidConfig(validateConfigObject(raw));
    expect(issues.map((issue) => issue.path)).toContain("channels.signal.accounts.__proto__");
  });

  it("keeps accounts keys that ARE ordinary own keys", () => {
    // The fence is about retrievability, not about unusual-looking names:
    // "constructor" and "prototype" are plain own keys and must still resolve to
    // their own entries, not to the channel-level certificate.
    const cfg = expectValidConfig(
      validateConfigObject(
        configFromJson5(
          `constructor: { tlsCertFile: "/certs/ctor.crt", tlsKeyFile: "/certs/ctor.key" },
           prototype: { tlsCertFile: "/certs/proto.crt", tlsKeyFile: "/certs/proto.key" }`,
        ),
      ),
    );

    expect(
      resolveSignalTlsOptions(resolveSignalAccount({ cfg, accountId: "constructor" }).config),
    ).toEqual({
      caFile: "/certs/ca.crt",
      certFile: "/certs/ctor.crt",
      keyFile: "/certs/ctor.key",
    });
    expect(
      resolveSignalTlsOptions(resolveSignalAccount({ cfg, accountId: "prototype" }).config),
    ).toEqual({
      caFile: "/certs/ca.crt",
      certFile: "/certs/proto.crt",
      keyFile: "/certs/proto.key",
    });
  });

  it("reaches the same fence through the config.patch merge pipeline", () => {
    // config.patch parses operator JSON5, merges it over the stored config and
    // un-redacts it before validating. Every one of those walkers rebuilds
    // objects key by key, and a plain assignment would drop the key again —
    // silently discarding the operator's edit while the RPC reports success.
    const base = {
      channels: {
        signal: {
          httpUrl: "https://signal-proxy:8443",
          tlsCaFile: "/certs/ca.crt",
          tlsCertFile: "/certs/default.crt",
          tlsKeyFile: "/certs/default.key",
          accounts: { ops: { tlsCertFile: "/certs/ops.crt", tlsKeyFile: "/certs/ops.key" } },
        },
      },
    };
    const patch = JSON5.parse(
      `{ channels: { signal: { accounts: { "__proto__": { tlsCertFile: "/certs/scoped.crt", tlsKeyFile: "/certs/scoped.key" } } } } }`,
    );

    const merged = applyMergePatch(base, patch, { mergeObjectArraysById: true });
    const mergedAccounts = signalAccountsOf(merged);
    expect(Object.hasOwn(mergedAccounts, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(mergedAccounts)).toBe(Object.prototype);

    const restored = restoreRedactedValues(merged, base, {});
    expect(restored.ok).toBe(true);
    expect(Object.hasOwn(signalAccountsOf(restored.result), "__proto__")).toBe(true);

    const issues = expectInvalidConfig(validateConfigObject(restored.result));
    expect(issues.map((issue) => issue.path)).toContain("channels.signal.accounts.__proto__");
  });
});

// `resolveSignalBaseUrlForValidation` is the https-vs-plaintext decision point:
// every mTLS rejection above is computed from the URL it derives. Asserting only
// which key an issue lands on leaves that derivation unpinned — a mutant that
// drops the port, or changes the default port, keeps every issue path intact.
//
// So this fence asserts the CONTRACT directly, between the two real
// implementations: the URL the validator derives from a merged view must equal
// the URL `resolveSignalAccount` hands the client for the same config, and both
// must equal a literal (which pins the defaults that a matching mutation of both
// sides would otherwise slide past).
describe("config signal base URL derivation contract", () => {
  const baseUrlShapes: Array<{
    name: string;
    signal: Record<string, unknown>;
    accountId?: string;
    expected: string;
  }> = [
    {
      name: "channel httpUrl wins outright",
      signal: { httpUrl: "https://signal-proxy:8443" },
      expected: "https://signal-proxy:8443",
    },
    {
      name: "no httpUrl: host and port",
      signal: { httpHost: "signal-proxy", httpPort: 8443 },
      expected: "http://signal-proxy:8443",
    },
    {
      name: "host only: default port",
      signal: { httpHost: "signal-proxy" },
      expected: "http://signal-proxy:8080",
    },
    {
      name: "nothing at all: default host and port",
      signal: {},
      expected: "http://127.0.0.1:8080",
    },
    {
      name: "account httpUrl overrides the channel httpUrl",
      signal: {
        httpUrl: "http://signal-api:8080",
        accounts: { ops: { httpUrl: "https://ops-proxy:8443" } },
      },
      accountId: "ops",
      expected: "https://ops-proxy:8443",
    },
    {
      name: "account host/port does NOT displace an inherited httpUrl",
      signal: {
        httpUrl: "http://signal-api:8080",
        accounts: { ops: { httpHost: "ops-proxy", httpPort: 9443 } },
      },
      accountId: "ops",
      expected: "http://signal-api:8080",
    },
    {
      name: "whitespace httpUrl falls back to host and port",
      signal: { httpUrl: "   ", httpHost: "signal-proxy", httpPort: 8443 },
      expected: "http://signal-proxy:8443",
    },
    {
      name: "whitespace account httpUrl blanks the inherited one",
      signal: {
        httpUrl: "http://signal-api:8080",
        accounts: { ops: { httpUrl: "  " } },
      },
      accountId: "ops",
      expected: "http://127.0.0.1:8080",
    },
    {
      name: "mTLS shape: account host/port over a blanked httpUrl",
      signal: {
        httpUrl: "https://signal-proxy:8443",
        tlsCaFile: "/certs/ca.crt",
        tlsCertFile: "/certs/default.crt",
        tlsKeyFile: "/certs/default.key",
        accounts: { ops: { httpHost: "ops-proxy", httpPort: 9443, httpUrl: "" } },
      },
      accountId: "ops",
      expected: "http://ops-proxy:9443",
    },
  ];

  for (const shape of baseUrlShapes) {
    it(`derives the same base URL the client dials: ${shape.name}`, () => {
      const res = validateConfigObject({ channels: { signal: shape.signal } });
      // The last shape resolves an account to a plaintext origin while mTLS is
      // configured, which is exactly what the validator rejects — the URL
      // contract still has to hold for it, so take the raw config in that case.
      const cfg = res.ok
        ? res.config
        : ({ channels: { signal: shape.signal } } as Parameters<
            typeof resolveSignalAccount
          >[0]["cfg"]);
      const resolved = resolveSignalAccount({ cfg, accountId: shape.accountId });

      // Contract: validator derivation === what the client actually dials.
      expect(resolveSignalBaseUrlForValidation(resolved.config)).toBe(resolved.baseUrl);
      // …and both are this URL, so a mutation applied to both sides is caught.
      expect(resolved.baseUrl).toBe(shape.expected);
    });
  }

  it("rejects the shape whose account resolves to a plaintext origin", () => {
    // Proof that the derivation above is the one the fence acts on.
    const issues = expectInvalidConfig(
      validateConfigObject({
        channels: { signal: baseUrlShapes[baseUrlShapes.length - 1]?.signal },
      }),
    );
    expect(issues.map((issue) => issue.path)).toContain("channels.signal.accounts.ops.httpUrl");
  });
});

// The validator merges an account over the channel with `??`; the resolver used
// to spread. They agree on every key that is absent and disagree on every own
// key whose value is `undefined` — `??` inherits, spread blanks. That gap let a
// config validate green and then throw at send time, and let an all-undefined
// account slip past the blank-override guard and resolve certless.
describe("config signal undefined account overrides", () => {
  const channel = {
    httpUrl: "https://signal-proxy:8443",
    tlsCaFile: "/certs/ca.crt",
    tlsCertFile: "/certs/default.crt",
    tlsKeyFile: "/certs/default.key",
  };
  const channelIdentity = {
    caFile: "/certs/ca.crt",
    certFile: "/certs/default.crt",
    keyFile: "/certs/default.key",
  };
  const undefinedOverrides: Array<{ name: string; ops: Record<string, unknown> }> = [
    { name: "a single key", ops: { tlsCertFile: undefined } },
    {
      name: "every TLS key",
      ops: { tlsCaFile: undefined, tlsCertFile: undefined, tlsKeyFile: undefined },
    },
  ];

  for (const shape of undefinedOverrides) {
    it(`treats an undefined override as absent, at both boundaries: ${shape.name}`, () => {
      // The premise: these really are own keys, not absent ones.
      expect(Object.hasOwn(shape.ops, "tlsCertFile")).toBe(true);

      const cfg = expectValidConfig(
        validateConfigObject({
          channels: { signal: { ...channel, accounts: { ops: shape.ops } } },
        }),
      );
      const resolved = resolveSignalAccount({ cfg, accountId: "ops" });

      // The same outcome the validator accepted the config on: the inherited
      // channel identity, over the inherited https origin.
      expect(resolveSignalTlsOptions(resolved.config)).toEqual(channelIdentity);
      expect(resolved.baseUrl).toBe(channel.httpUrl);

      // …and identical to declaring no override at all.
      const withoutOverride = expectValidConfig(
        validateConfigObject({ channels: { signal: { ...channel, accounts: { ops: {} } } } }),
      );
      expect(resolveSignalTlsOptions(resolved.config)).toEqual(
        resolveSignalTlsOptions(
          resolveSignalAccount({ cfg: withoutOverride, accountId: "ops" }).config,
        ),
      );
    });
  }

  it("still rejects an account that blanks its inherited TLS paths with empty strings", () => {
    // `undefined` means "no override"; "" means "clear it", which stays a
    // rejection. Unifying the undefined semantics must not soften that.
    const issues = expectInvalidConfig(
      validateConfigObject({
        channels: {
          signal: {
            ...channel,
            accounts: { ops: { tlsCaFile: "", tlsCertFile: "", tlsKeyFile: "" } },
          },
        },
      }),
    );
    expect(issues.map((issue) => issue.path)).toContain("channels.signal.accounts.ops.tlsCaFile");
  });
});
