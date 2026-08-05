import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import {
  REDACTED_SENTINEL,
  redactConfigSnapshot,
  restoreRedactedValues,
} from "./redact-snapshot.js";
import { __test__ } from "./schema.hints.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";
import { OpenClawSchema } from "./zod-schema.js";

/**
 * `snapshot.raw` is the config SOURCE, and a sensitive value can be spelled in it
 * in unboundedly many ways that all parse to the same string. Redaction that
 * matches the decoded value (or a fixed list of re-encodings of it) against the
 * source misses every spelling not on the list and emits the credential verbatim.
 *
 * This suite is therefore a matrix over SPELLINGS, not over fields: each case
 * writes the same secret in a different legal JSON5 encoding, at a different
 * config path, and asserts the secret survives in NO projection of the snapshot.
 * Every fixture is checked against the real JSON5 parser first, so a case can
 * never pass by being an illegal document nobody could have written.
 */

const { mapSensitivePaths } = __test__;
const hints = mapSensitivePaths(OpenClawSchema, "", {});

const BACKSLASH = String.fromCharCode(92);
const RAW_COMMENT = "// operator comment that the raw view exists to preserve";

const unitsOf = (value: string): string[] => {
  const units: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    units.push(value.charAt(index));
  }
  return units;
};

const hex = (unit: string, width: number): string =>
  unit.charCodeAt(0).toString(16).padStart(width, "0");

const jsonEscapeUnit = (unit: string): string => JSON.stringify(unit).slice(1, -1);

type Spelling = { name: string; encode: (secret: string) => string };

const SPELLINGS: Spelling[] = [
  {
    // The one spelling the previous implementation handled.
    name: "double-quoted JSON escapes",
    encode: (secret) => JSON.stringify(secret),
  },
  {
    name: "every character as a \\uXXXX escape",
    encode: (secret) =>
      `"${unitsOf(secret)
        .map((unit) => `${BACKSLASH}u${hex(unit, 4)}`)
        .join("")}"`,
  },
  {
    // A newline written as \u000a is plain strict JSON, not a JSON5 exotic.
    name: "newlines as \\u000a",
    encode: (secret) =>
      `"${unitsOf(secret)
        .map((unit) =>
          unit === "\n" || unit === "\r" ? `${BACKSLASH}u${hex(unit, 4)}` : jsonEscapeUnit(unit),
        )
        .join("")}"`,
  },
  {
    name: "JSON5 \\xNN hex escapes",
    encode: (secret) =>
      `"${unitsOf(secret)
        .map((unit) =>
          unit.charCodeAt(0) < 0x100
            ? `${BACKSLASH}x${hex(unit, 2)}`
            : `${BACKSLASH}u${hex(unit, 4)}`,
        )
        .join("")}"`,
  },
  {
    // Single-quoted JSON5 string: a double quote inside it needs no escape at all.
    name: "single-quoted JSON5 string",
    encode: (secret) =>
      `'${unitsOf(secret)
        .map((unit) => {
          if (unit === "'" || unit === BACKSLASH) {
            return `${BACKSLASH}${unit}`;
          }
          if (unit === '"') {
            return unit;
          }
          return jsonEscapeUnit(unit);
        })
        .join("")}'`,
  },
  {
    // Backslash + a real newline: a continuation contributes NOTHING to the
    // value, so no re-encoding of the value can ever produce this text.
    name: "JSON5 line continuations",
    encode: (secret) => {
      const tokens = unitsOf(secret).map(jsonEscapeUnit);
      const parts: string[] = [];
      tokens.forEach((token, index) => {
        if (index > 0 && index % 8 === 0) {
          parts.push(`${BACKSLASH}\n`);
        }
        parts.push(token);
      });
      return `"${parts.join("")}"`;
    },
  },
];

type Placement = { name: string; path: string[] };

const PLACEMENTS: Placement[] = [
  { name: "gateway.auth.password", path: ["gateway", "auth", "password"] },
  { name: "gateway.auth.token", path: ["gateway", "auth", "token"] },
  { name: "channel-level channels.irc.password", path: ["channels", "irc", "password"] },
  {
    name: "accounts.* channels.telegram.accounts.ops.botToken",
    path: ["channels", "telegram", "accounts", "ops", "botToken"],
  },
  {
    name: "models.providers.*.apiKey",
    path: ["models", "providers", "acme", "apiKey"],
  },
];

const SECRETS: Array<{ name: string; value: string }> = [
  { name: "single-line", value: "s3cr3t-gateway-token-a1b2c3d4e5" },
  {
    name: "multi-line (LF)",
    value: [
      "-----BEGIN PRIVATE KEY-----",
      "MIIBVgIBADANBgkqhkiG",
      "-----END PRIVATE KEY-----",
    ].join("\n"),
  },
  { name: "multi-line (CRLF)", value: ["alpha-secret", "beta-secret", "gamma"].join("\r\n") },
  { name: "containing a double quote", value: 'pa"ss"word-with-quotes-77' },
  {
    name: "base64",
    value: Buffer.from("openclaw-secret-material-0123456789-abcdefghij").toString("base64"),
  },
  { name: "larger than 4KB", value: `${"Kk9".repeat(1400)}-tail-secret` },
];

function buildConfig(path: string[], secret: string): Record<string, unknown> {
  let value: unknown = secret;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    value =
      index === path.length - 1
        ? { [path[index]]: value, note: "keep-me" }
        : { [path[index]]: value };
  }
  return value as Record<string, unknown>;
}

function buildRaw(path: string[], literal: string): string {
  let text = `{\n  ${RAW_COMMENT}\n  ${path[path.length - 1]}: ${literal},\n  note: 'keep-me',\n}`;
  for (let index = path.length - 2; index >= 0; index -= 1) {
    text = `{\n  ${path[index]}: ${text},\n}`;
  }
  return text;
}

function makeSnapshot(config: Record<string, unknown>, raw: string): ConfigFileSnapshot {
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

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out);
    }
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      collectStrings(item, out);
    }
  }
  return out;
}

function expectNoSecret(label: string, value: unknown, secret: string): void {
  for (const text of collectStrings(value)) {
    expect(text.includes(secret), `${label} leaked the secret`).toBe(false);
  }
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

function runCase(placement: Placement, secret: string, spelling: Spelling): void {
  const config = buildConfig(placement.path, secret);
  const raw = buildRaw(placement.path, spelling.encode(secret));

  // The fixture must be a document an operator could really have written, and it
  // must MEAN the secret — otherwise a green assertion proves nothing.
  expect(JSON5.parse(raw)).toEqual(config);

  const snapshot = makeSnapshot(config, raw);
  const result = redactConfigSnapshot(snapshot, hints);

  expect(result.raw).not.toBeNull();
  const rawAfter = result.raw as string;
  // Structure and comments survive; only the credential span is edited.
  expect(rawAfter).toContain(RAW_COMMENT);
  const rawParsed = JSON5.parse(rawAfter);
  expect(valueAt(rawParsed, placement.path)).toBe(REDACTED_SENTINEL);
  expect(valueAt(rawParsed, [...placement.path.slice(0, -1), "note"])).toBe("keep-me");

  expectNoSecret("raw", rawParsed, secret);
  expect(rawAfter.includes(secret)).toBe(false);
  expectNoSecret("config", result.config, secret);
  expectNoSecret("parsed", result.parsed, secret);
  expectNoSecret("resolved", result.resolved, secret);
  expect(valueAt(result.config, placement.path)).toBe(REDACTED_SENTINEL);
  expect(valueAt(result.parsed, placement.path)).toBe(REDACTED_SENTINEL);
  expect(valueAt(result.resolved, placement.path)).toBe(REDACTED_SENTINEL);

  const restored = restoreRedactedValues(result.config, snapshot.config, hints);
  expect(restored.ok).toBe(true);
  expect(restored.result).toEqual(config);
}

describe("redactConfigSnapshot raw source spellings", () => {
  it("treats every tested path as sensitive (guards against schema drift)", () => {
    expect(hints["gateway.auth.password"]?.sensitive).toBe(true);
    expect(hints["gateway.auth.token"]?.sensitive).toBe(true);
    expect(hints["channels.irc.password"]?.sensitive).toBe(true);
    expect(hints["channels.telegram.accounts.*.botToken"]?.sensitive).toBe(true);
    expect(hints["models.providers.*.apiKey"]?.sensitive).toBe(true);
  });

  for (const secret of SECRETS) {
    for (const spelling of SPELLINGS) {
      it(`redacts a ${secret.name} secret written as ${spelling.name}`, () => {
        runCase(PLACEMENTS[0], secret.value, spelling);
      });
    }
  }

  for (const placement of PLACEMENTS) {
    for (const spelling of SPELLINGS) {
      it(`redacts ${placement.name} written as ${spelling.name}`, () => {
        runCase(placement, SECRETS[1].value, spelling);
        runCase(placement, SECRETS[3].value, spelling);
      });
    }
  }

  it("redacts a credential left in a comment as well", () => {
    const secret = "s3cr3t-gateway-token-a1b2c3d4e5";
    const config = buildConfig(["gateway", "auth", "token"], secret);
    const raw = `{\n  gateway: {\n    auth: {\n      // old value was ${secret}\n      token: ${JSON.stringify(secret)},\n      note: 'keep-me',\n    },\n  },\n}`;
    expect(JSON5.parse(raw)).toEqual(config);
    const result = redactConfigSnapshot(makeSnapshot(config, raw), hints);
    expect(result.raw).not.toBeNull();
    expect((result.raw as string).includes(secret)).toBe(false);
  });

  it("does not touch a non-sensitive field that happens to be spelled with escapes", () => {
    const config = { gateway: { auth: { token: "tok-1234567890" }, host: "a\nb" } };
    const raw = `{\n  gateway: {\n    auth: { token: "tok-1234567890" },\n    host: "a${BACKSLASH}u000ab",\n  },\n}`;
    expect(JSON5.parse(raw)).toEqual(config);
    const result = redactConfigSnapshot(makeSnapshot(config, raw), hints);
    const rawParsed = JSON5.parse(result.raw as string);
    expect(valueAt(rawParsed, ["gateway", "host"])).toBe("a\nb");
    expect((result.raw as string).includes(`a${BACKSLASH}u000ab`)).toBe(true);
  });
});
