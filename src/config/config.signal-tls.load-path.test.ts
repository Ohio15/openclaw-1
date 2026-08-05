import fs from "node:fs/promises";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { resolveSignalAccount } from "../signal/accounts.js";
import { resolveSignalTlsOptions } from "../signal/tls.js";
import { validateConfigObject } from "./config.js";
import { restoreEnvVarRefs } from "./env-preserve.js";
import { resolveConfigEnvVars } from "./env-substitution.js";
import { withTempHome } from "./home-env.test-harness.js";
import { type IncludeResolver, resolveConfigIncludes } from "./includes.js";
import { createConfigIO } from "./io.js";
import { applyMergePatch } from "./merge-patch.js";
import { REDACTED_SENTINEL, redactConfigObject, restoreRedactedValues } from "./redact-snapshot.js";
import type { ConfigUiHints } from "./schema.hints.js";

// Round 6 fenced `channels.signal.accounts.__proto__` at the SCHEMA, and proved
// it with `validateConfigObject(JSON5.parse(...))` — which is not how a config
// reaches validation. The real read path runs two whole-document walkers first
// (`resolveConfigIncludes`, then `resolveConfigEnvVars`), and both rebuilt
// objects with `result[key] = value`. That assignment drives the
// `Object.prototype` setter for `__proto__` instead of creating an own property,
// so the key was GONE before the fence ran: the config loaded green, every send
// for that id presented the CHANNEL-level client certificate, and the next write
// persisted the block erased.
//
// These tests therefore assert at the real boundary. They deliberately assert
// the key survives EACH walker, so that a regression in any single walker fails
// here with a pointer to which one, rather than only as a distant "config loaded
// green".
const CHANNEL_BLOCK = `
      httpUrl: "https://signal-proxy:8443",
      tlsCaFile: "/certs/ca.crt",
      tlsCertFile: "/certs/default.crt",
      tlsKeyFile: "/certs/default.key",`;

const configJson5 = (accountsBody: string): string => `{
  channels: {
    signal: {${CHANNEL_BLOCK}
      accounts: { ${accountsBody} },
    },
  },
}`;

const PROTO_ACCOUNT = `"__proto__": { tlsCertFile: "/certs/scoped.crt", tlsKeyFile: "/certs/scoped.key" }`;

const accountsOf = (config: unknown): Record<string, unknown> =>
  (config as { channels: { signal: { accounts: Record<string, unknown> } } }).channels.signal
    .accounts;

const throwingResolver: IncludeResolver = {
  readFile: () => {
    throw new Error("no include files in this fixture");
  },
  parseJson: (raw) => JSON5.parse(raw),
};

/** The exact sequence `createConfigIO().loadConfig()` runs before validating. */
function walkLikeTheLoadPath(raw: string): unknown {
  const parsed = JSON5.parse(raw);
  const included = resolveConfigIncludes(parsed, "/tmp/openclaw.json5", throwingResolver);
  return resolveConfigEnvVars(included, {});
}

describe("signal accounts __proto__ through the real config load path", () => {
  it("survives every load-path walker as an own key and is rejected by validation", () => {
    const parsed = JSON5.parse(configJson5(PROTO_ACCOUNT));
    // Premise: JSON5 really does hand validation an OWN "__proto__" key.
    expect(Object.hasOwn(accountsOf(parsed), "__proto__")).toBe(true);

    const included = resolveConfigIncludes(parsed, "/tmp/openclaw.json5", throwingResolver);
    expect(Object.hasOwn(accountsOf(included), "__proto__")).toBe(true);

    const substituted = resolveConfigEnvVars(included, {});
    expect(Object.hasOwn(accountsOf(substituted), "__proto__")).toBe(true);

    // The fence inspects the raw object with `Object.getOwnPropertyNames`, so
    // "own" is exactly the property the walkers have to preserve for it to fire.
    expect(Object.getOwnPropertyNames(accountsOf(substituted))).toContain("__proto__");

    const result = validateConfigObject(substituted);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected the config to be rejected");
    }
    expect(result.issues.map((issue) => issue.path)).toContain(
      "channels.signal.accounts.__proto__",
    );
  });

  it("rejects the same config when read from disk by createConfigIO", async () => {
    await withTempHome("openclaw-signal-proto-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, configJson5(PROTO_ACCOUNT), "utf-8");

      const errors: string[] = [];
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn: () => {}, error: (msg: string) => errors.push(String(msg)) },
      });

      // The end-to-end invariant the CHANGELOG and docs/channels/signal.md now
      // promise. `readConfigFileSnapshot` is the boundary that REPORTS the
      // verdict; `loadConfig` is the boundary that ACTS on it, and it acts by
      // logging and refusing to apply the file (it deliberately converts an
      // invalid config into an empty one rather than crashing the process).
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.exists).toBe(true);
      expect(snapshot.valid).toBe(false);
      expect(snapshot.issues.map((issue) => issue.path)).toContain(
        "channels.signal.accounts.__proto__",
      );

      expect(io.loadConfig().channels).toBeUndefined();
      expect(errors.join("\n")).toContain("channels.signal.accounts.__proto__");
    });
  });

  it("keeps ordinary own keys resolving to their OWN certificates through the walkers", () => {
    // The fence is about retrievability, not about unusual-looking names. If a
    // walker "solved" __proto__ by dropping odd keys, these would silently fall
    // back to the channel certificate — the very bug being fixed.
    const walked = walkLikeTheLoadPath(
      configJson5(
        `constructor: { tlsCertFile: "/certs/ctor.crt", tlsKeyFile: "/certs/ctor.key" },
         prototype: { tlsCertFile: "/certs/proto.crt", tlsKeyFile: "/certs/proto.key" }`,
      ),
    );
    const result = validateConfigObject(walked);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected the config to be valid");
    }

    expect(
      resolveSignalTlsOptions(
        resolveSignalAccount({ cfg: result.config, accountId: "constructor" }).config,
      ),
    ).toEqual({
      caFile: "/certs/ca.crt",
      certFile: "/certs/ctor.crt",
      keyFile: "/certs/ctor.key",
    });
    expect(
      resolveSignalTlsOptions(
        resolveSignalAccount({ cfg: result.config, accountId: "prototype" }).config,
      ),
    ).toEqual({
      caFile: "/certs/ca.crt",
      certFile: "/certs/proto.crt",
      keyFile: "/certs/proto.key",
    });
  });

  it("resolves an unlisted account to the channel certificate without consulting the prototype", () => {
    // `resolveAccountConfig` indexes `accounts` by the requested id. A bare
    // `accounts[accountId]` lookup answers "__proto__" with `Object.prototype`,
    // handing the merge a non-account object.
    const walked = walkLikeTheLoadPath(
      configJson5(`ops: { tlsCertFile: "/certs/ops.crt", tlsKeyFile: "/certs/ops.key" }`),
    );
    const result = validateConfigObject(walked);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected the config to be valid");
    }

    const channelIdentity = {
      caFile: "/certs/ca.crt",
      certFile: "/certs/default.crt",
      keyFile: "/certs/default.key",
    };
    for (const accountId of ["__proto__", "constructor", "tostring"]) {
      expect(
        resolveSignalTlsOptions(resolveSignalAccount({ cfg: result.config, accountId }).config),
      ).toEqual(channelIdentity);
    }
  });
});

// The defect is a CLASS: every walker that rebuilds an object key by key from an
// operator-supplied document had the same assignment. Fencing the schema only
// helps if the document still carries the key when it gets there, so the
// documented contract for every walker is the same one: `__proto__` is carried
// through as a genuine own property, and no walker mutates `Object.prototype`.
describe("config walkers preserve __proto__ as an own key without polluting", () => {
  const withProto = (): Record<string, unknown> =>
    JSON5.parse(`{ keep: "value", "__proto__": { polluted: "yes" } }`);

  const expectPreservedAndClean = (walked: unknown): void => {
    const result = walked as Record<string, unknown>;
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyNames(result)).toContain("__proto__");
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result.keep).toBe("value");
    // The pollution half of the same defect: an unsafe assignment would have
    // re-parented the rebuilt object onto the operator-supplied value.
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
  };

  it("include resolution (processObject)", () => {
    expectPreservedAndClean(resolveConfigIncludes(withProto(), "/tmp/c.json5", throwingResolver));
  });

  it("include resolution with a __proto__ SIBLING key (rest walker + deepMerge)", () => {
    // The sibling key drives BOTH the `rest[key]` walker (which collects sibling
    // keys) and `deepMerge` (which folds them onto the included document). Placing
    // __proto__ on the sibling side is what makes those two conversions
    // observable — an include-side key alone never reaches either assignment.
    const resolver: IncludeResolver = {
      readFile: () => `{ base: true }`,
      parseJson: (raw) => JSON5.parse(raw),
    };
    const doc = JSON5.parse(
      `{ $include: "./base.json5", "__proto__": { polluted: "yes" }, keep: "value" }`,
    );
    const walked = resolveConfigIncludes(doc, "/tmp/c.json5", resolver) as Record<string, unknown>;
    expect(Object.hasOwn(walked, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyNames(walked)).toContain("__proto__");
    expect(Object.getPrototypeOf(walked)).toBe(Object.prototype);
    expect(walked.base).toBe(true);
    expect(walked.keep).toBe("value");
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
  });

  it("include deepMerge folds a __proto__ key from BOTH sides as own, no pollution", () => {
    // Both the included document and the sibling set carry __proto__: deepMerge
    // must merge them into an own key rather than routing either through the
    // prototype setter or reading `result.__proto__` off the chain.
    const resolver: IncludeResolver = {
      readFile: () => `{ "__proto__": { fromInclude: "a" } }`,
      parseJson: (raw) => JSON5.parse(raw),
    };
    const doc = JSON5.parse(`{ $include: "./base.json5", "__proto__": { fromSibling: "b" } }`);
    const walked = resolveConfigIncludes(doc, "/tmp/c.json5", resolver) as Record<string, unknown>;
    expect(Object.hasOwn(walked, "__proto__")).toBe(true);
    expect(walked.__proto__).toEqual({ fromInclude: "a", fromSibling: "b" });
    expect(Object.getPrototypeOf(walked)).toBe(Object.prototype);
    expect(({} as { fromInclude?: string; fromSibling?: string }).fromInclude).toBeUndefined();
  });

  it("env substitution", () => {
    expectPreservedAndClean(resolveConfigEnvVars(withProto(), {}));
  });

  it("env-ref preservation on write-back", () => {
    expectPreservedAndClean(restoreEnvVarRefs(withProto(), withProto(), {}));
  });

  it("merge patch", () => {
    expectPreservedAndClean(applyMergePatch({ keep: "value" }, withProto()));
  });

  it("redact and restore round-trip (guessing walker)", () => {
    const original = JSON5.parse(`{ keep: "value", "__proto__": { apiKey: "s3cret" } }`);
    const redacted = redactConfigObject(original) as Record<string, unknown>;
    expect(Object.hasOwn(redacted, "__proto__")).toBe(true);
    expect((redacted.__proto__ as { apiKey?: string }).apiKey).toBe(REDACTED_SENTINEL);

    const restored = restoreRedactedValues(redacted, original, {});
    expect(restored.ok).toBe(true);
    if (!restored.ok) {
      throw new Error("expected the restore to succeed");
    }
    expectPreservedAndClean(restored.result);
    expect(
      ((restored.result as Record<string, unknown>).__proto__ as { apiKey?: string }).apiKey,
    ).toBe("s3cret");
  });

  it("redact and restore round-trip (lookup walker, __proto__ is a non-sensitive sibling)", () => {
    // Hints route redaction through `redactObjectWithLookup`/
    // `restoreRedactedValuesWithLookup` — a different pair of walkers from the
    // guessing case. Making __proto__ a NON-sensitive sibling (only `secret` is
    // marked) forces the key through each walker's DEFAULT key-by-key rebuild
    // (the branch that just copies a key straight across), which is exactly the
    // assignment that must be own-safe rather than the matched-branch re-write.
    const hints: ConfigUiHints = JSON5.parse(`{ "secret": { sensitive: true } }`);
    const original = JSON5.parse(`{ secret: "s3cret", "__proto__": { plain: "keep-me" } }`);
    const redacted = redactConfigObject(original, hints) as Record<string, unknown>;
    expect(Object.hasOwn(redacted, "__proto__")).toBe(true);
    expect(redacted.secret).toBe(REDACTED_SENTINEL);
    expect((redacted.__proto__ as { plain?: string }).plain).toBe("keep-me");

    const restored = restoreRedactedValues(redacted, original, hints);
    expect(restored.ok).toBe(true);
    if (!restored.ok) {
      throw new Error("expected the restore to succeed");
    }
    const result = restored.result as Record<string, unknown>;
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result.secret).toBe("s3cret");
    expect((result.__proto__ as { plain?: string }).plain).toBe("keep-me");
    expect(({} as { plain?: string }).plain).toBeUndefined();
  });

  it("restore does not read an absent __proto__ off the prototype chain", () => {
    // `restoreOriginalValueOrThrow` used `key in original`, which is true for
    // "__proto__" on EVERY object. With no own __proto__ in `original`, a bare
    // `in` read would "restore" the sentinel to `Object.prototype` and pollute;
    // the own-only guard must instead report that there is nothing to restore.
    const original = { keep: "value" } as Record<string, unknown>;
    const redacted: Record<string, unknown> = { keep: "value" };
    // A sensitive sentinel parked at __proto__ with no matching original own key.
    setProtoSentinel(redacted);
    // Built via JSON5 so the hint key is a genuine OWN "__proto__" — an object
    // literal would set the prototype and buildRedactionLookup would see nothing.
    const hints: ConfigUiHints = JSON5.parse(`{ "__proto__": { sensitive: true } }`);

    const restored = restoreRedactedValues(redacted, original, hints);
    expect(restored.ok).toBe(false);
    // And critically: nothing was written onto Object.prototype.
    expect(({} as { keep?: unknown }).keep).toBeUndefined();
  });
});

function setProtoSentinel(target: Record<string, unknown>): void {
  Object.defineProperty(target, "__proto__", {
    value: REDACTED_SENTINEL,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
