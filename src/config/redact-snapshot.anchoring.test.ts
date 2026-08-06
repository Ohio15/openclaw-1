import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import {
  __test__,
  REDACTED_SENTINEL,
  redactConfigSnapshot,
  restoreRedactedValues,
} from "./redact-snapshot.js";
import { __test__ as hintsTest } from "./schema.hints.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";
import { OpenClawSchema } from "./zod-schema.js";

/**
 * Raw-source redaction must be anchored to the sensitive PATH.
 *
 * The text-anywhere implementation had three defect classes, each reproduced
 * here as a regression:
 *  - D1: a global `replaceAll` of the secret's spellings matched text SPANNING
 *    document structure and spliced it apart, producing unparseable or —
 *    worse — parseable-but-wrong `raw`.
 *  - D2: matching by text redacted KEY NAMES and unrelated values that merely
 *    contained the same characters; `snapshot.raw` round-trips through the UI
 *    raw editor back into config.set, so the mangled document persisted
 *    silently.
 *  - D3: the fail-closed check was a verbatim `includes()` — zero coverage of
 *    escaped spellings, and it matched the redaction sentinel itself for
 *    secrets like `_` or `OPENCLAW`, withholding `raw` forever.
 *
 * Every served fixture asserts the full contract: redacted raw still parses,
 * the sensitive path decodes to the sentinel, every OTHER key and value is
 * byte-for-byte untouched, and the object round-trip restores exactly.
 */

const { mapSensitivePaths } = hintsTest;
const hints = mapSensitivePaths(OpenClawSchema, "", {});

const { findResidualLeak, MIN_GLOBAL_LEAK_CHECK_LENGTH } = __test__;

function makeSnapshot(config: Record<string, unknown>, raw: string): ConfigFileSnapshot {
  // Fixtures must be documents an operator could really have written.
  expect(JSON5.parse(raw)).toEqual(config);
  return {
    path: "/home/user/.openclaw/config.json5",
    exists: true,
    raw,
    parsed: config,
    resolved: config,
    valid: true,
    config,
    hash: "abc123",
    issues: [],
    warnings: [],
    legacyIssues: [],
  } as unknown as ConfigFileSnapshot;
}

function valueAt(root: unknown, path: string[]): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function tokenConfig(secret: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { gateway: { auth: { token: secret } }, note: "keep-me", ...extra };
}

describe("path-anchored raw redaction", () => {
  it("relies on paths that really are sensitive (guards against schema drift)", () => {
    expect(hints["gateway.auth.token"]?.sensitive).toBe(true);
    expect(hints["models.providers.*.apiKey"]?.sensitive).toBe(true);
    expect(hints["channels.telegram.accounts.*.botToken"]?.sensitive).toBe(true);
  });

  it("D2: a secret equal to a key name redacts the value, never the key", () => {
    const config = {
      gateway: { auth: { token: "openai" } },
      models: { providers: { openai: { apiKey: "prov-key-123456789" } } },
      note: "openai-based setup",
    };
    const raw = `{
  gateway: { auth: { token: "openai" } },
  models: { providers: { "openai": { apiKey: "prov-key-123456789" } } },
  note: "openai-based setup",
}`;
    const result = redactConfigSnapshot(makeSnapshot(config, raw), hints);
    expect(result.raw).not.toBeNull();
    const parsed = JSON5.parse(result.raw as string);
    // The key survives by NAME — the whole point of anchoring.
    expect(Object.keys(valueAt(parsed, ["models", "providers"]) as object)).toEqual(["openai"]);
    expect(valueAt(parsed, ["models", "providers", "openai", "apiKey"])).toBe(REDACTED_SENTINEL);
    expect(valueAt(parsed, ["gateway", "auth", "token"])).toBe(REDACTED_SENTINEL);
    expect(valueAt(parsed, ["note"])).toBe("openai-based setup");
  });

  it("D2: a 2-character secret leaves unrelated values containing it untouched", () => {
    const config = tokenConfig("ab", { note: "absolute value" });
    const raw = `{ gateway: { auth: { token: "ab" } }, note: "absolute value" }`;
    const result = redactConfigSnapshot(makeSnapshot(config, raw), hints);
    expect(result.raw).not.toBeNull();
    const parsed = JSON5.parse(result.raw as string);
    expect(valueAt(parsed, ["gateway", "auth", "token"])).toBe(REDACTED_SENTINEL);
    expect(valueAt(parsed, ["note"])).toBe("absolute value");
  });

  for (const secret of ["_", "OPENCLAW", "RED"]) {
    it(`D3: a secret (${JSON.stringify(secret)}) inside the sentinel's own spelling does not withhold raw`, () => {
      const config = tokenConfig(secret);
      const raw = `{ gateway: { auth: { token: ${JSON.stringify(secret)} } }, note: "keep-me" }`;
      const result = redactConfigSnapshot(makeSnapshot(config, raw), hints);
      expect(result.raw).not.toBeNull();
      const parsed = JSON5.parse(result.raw as string);
      expect(valueAt(parsed, ["gateway", "auth", "token"])).toBe(REDACTED_SENTINEL);
      expect(valueAt(parsed, ["note"])).toBe("keep-me");
      const restored = restoreRedactedValues(result.config, config, hints);
      expect(restored.ok).toBe(true);
      expect(restored.result).toEqual(config);
    });
  }

  it("D1: a secret whose text spans unrelated structure no longer splices the document", () => {
    // The verbatim text of the secret — 'A", B' — occurs in the source ACROSS
    // x's closing quote, the comma, and B's key. The old global replaceAll
    // spliced that span out, destroying the B entry; anchored redaction edits
    // only the token literal.
    const secret = 'A", B';
    const config = tokenConfig(secret, { x: "A", B: "Cq" });
    const raw = `{ gateway: { auth: { token: 'A", B' } }, note: "keep-me", x: "A", B: "Cq" }`;
    const result = redactConfigSnapshot(makeSnapshot(config, raw), hints);
    expect(result.raw).not.toBeNull();
    const parsed = JSON5.parse(result.raw as string);
    expect(valueAt(parsed, ["gateway", "auth", "token"])).toBe(REDACTED_SENTINEL);
    expect(valueAt(parsed, ["x"])).toBe("A");
    expect(valueAt(parsed, ["B"])).toBe("Cq");
    const restored = restoreRedactedValues(result.config, config, hints);
    expect(restored.ok).toBe(true);
    expect(restored.result).toEqual(config);
  });

  it("redacts a short secret from a comment (comments are covered at every length)", () => {
    const secret = "tok12";
    const config = tokenConfig(secret);
    const raw = `{
  gateway: { auth: {
    // old value was tok12
    token: "tok12",
  } },
  note: "keep-me",
}`;
    const result = redactConfigSnapshot(makeSnapshot(config, raw), hints);
    expect(result.raw).not.toBeNull();
    expect(result.raw as string).toContain(`// old value was ${REDACTED_SENTINEL}`);
    expect(JSON5.parse(result.raw as string)).toBeTruthy();
  });

  it("withholds raw when a credential-length secret was pasted into a non-sensitive field", () => {
    // It cannot be redacted there without corrupting a field the operator will
    // save back through the raw editor, so the whole view is withheld instead
    // of served corrupted (old behavior) or served leaking.
    const secret = "s3cr3t-token-abc123";
    const config = tokenConfig(secret, { host: `paste ${secret} here` });
    const raw = `{ gateway: { auth: { token: ${JSON.stringify(secret)} } }, note: "keep-me", host: ${JSON.stringify(`paste ${secret} here`)} }`;
    const result = redactConfigSnapshot(makeSnapshot(config, raw), hints);
    expect(result.raw).toBeNull();
    // Object-side redaction of the sensitive path is unaffected.
    expect(valueAt(result.config, ["gateway", "auth", "token"])).toBe(REDACTED_SENTINEL);
  });

  it("withholds raw when a non-sensitive literal spells the secret in ESCAPED form", () => {
    // The exact class the old verbatim includes() check could never see.
    const secret = "s3cr3t-token-abc123";
    const escapedSpelling = '"s3cr3t\\u002dtoken\\u002dabc123"';
    const config = tokenConfig(secret, { host: secret });
    const raw = `{ gateway: { auth: { token: ${JSON.stringify(secret)} } }, note: "keep-me", host: ${escapedSpelling} }`;
    const result = redactConfigSnapshot(makeSnapshot(config, raw), hints);
    expect(result.raw).toBeNull();
  });

  it("withholds raw when an UNQUOTED key spells the secret via identifier escapes", () => {
    // Adversarial-review finding: a bare identifier key is neither a string
    // literal nor verbatim text, so without decoding bare tokens the gate
    // served this document with the credential intact.
    const secret = "supersecretkey123";
    const config = tokenConfig(secret, { [secret]: 1 });
    const raw = `{ gateway: { auth: { token: ${JSON.stringify(secret)} } }, note: "keep-me", supersecre\\u0074key123: 1 }`;
    const result = redactConfigSnapshot(makeSnapshot(config, raw), hints);
    expect(result.raw).toBeNull();
  });

  it("withholds raw when a quoted key spells a credential-length secret", () => {
    const secret = "supersecretkey123";
    const config = tokenConfig(secret, { [secret]: 1 });
    const raw = `{ gateway: { auth: { token: ${JSON.stringify(secret)} } }, note: "keep-me", ${JSON.stringify(secret)}: 1 }`;
    const result = redactConfigSnapshot(makeSnapshot(config, raw), hints);
    expect(result.raw).toBeNull();
  });

  it("redacts every account of a wildcard record and nothing else", () => {
    const config = {
      channels: {
        telegram: {
          accounts: {
            ops: { botToken: "ops-token-1234567890", name: "ops" },
            eu: { botToken: "eu-token-0987654321", name: "eu" },
          },
        },
      },
    };
    const raw = `{
  channels: { telegram: { accounts: {
    ops: { botToken: "ops-token-1234567890", name: "ops" },
    eu: { botToken: "eu-token-0987654321", name: "eu" },
  } } },
}`;
    const result = redactConfigSnapshot(makeSnapshot(config, raw), hints);
    expect(result.raw).not.toBeNull();
    const parsed = JSON5.parse(result.raw as string);
    const accounts = ["channels", "telegram", "accounts"];
    expect(valueAt(parsed, [...accounts, "ops", "botToken"])).toBe(REDACTED_SENTINEL);
    expect(valueAt(parsed, [...accounts, "eu", "botToken"])).toBe(REDACTED_SENTINEL);
    expect(valueAt(parsed, [...accounts, "ops", "name"])).toBe("ops");
    expect(valueAt(parsed, [...accounts, "eu", "name"])).toBe("eu");
    const restored = restoreRedactedValues(result.config, config, hints);
    expect(restored.ok).toBe(true);
    expect(restored.result).toEqual(config);
  });
});

describe("findResidualLeak (the semantic fail-closed gate)", () => {
  const LONG = "x".repeat(MIN_GLOBAL_LEAK_CHECK_LENGTH);

  it("rejects a document that no longer parses", () => {
    expect(findResidualLeak(`{ broken`, [LONG], hints)).toMatch(/no longer parses/);
  });

  it("rejects a sensitive path that still decodes to its value, at any length", () => {
    const leak = findResidualLeak(`{ gateway: { auth: { token: "ab" } } }`, ["ab"], hints);
    expect(leak).toMatch(/sensitive path/);
  });

  it("rejects an escaped spelling of a credential-length secret anywhere", () => {
    const doc = `{ gateway: { auth: { token: "${REDACTED_SENTINEL}" } }, host: "${LONG.slice(1)}\\u0078" }`;
    expect(findResidualLeak(doc, [LONG], hints)).toMatch(/string literal/);
  });

  it("accepts its own sentinel for secrets that are substrings of it", () => {
    const doc = `{ gateway: { auth: { token: "${REDACTED_SENTINEL}" } }, note: "keep-me" }`;
    for (const secret of ["_", "OPENCLAW", "RED"]) {
      expect(findResidualLeak(doc, [secret], hints)).toBeNull();
    }
  });

  it("ignores sub-credential-length occurrences outside sensitive paths", () => {
    const doc = `{ gateway: { auth: { token: "${REDACTED_SENTINEL}" } }, note: "absolute" }`;
    expect(findResidualLeak(doc, ["ab"], hints)).toBeNull();
  });
});
