import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { findDecodedMatches, scanJson5StringLiterals } from "./json5-strings.js";

const BACKSLASH = String.fromCharCode(92);

describe("scanJson5StringLiterals", () => {
  it("decodes every escape form to the same value the JSON5 parser produces", () => {
    const cases = [
      `"plain"`,
      `"tab${BACKSLASH}there"`,
      `"nl${BACKSLASH}nhere"`,
      `"hex${BACKSLASH}x41here"`,
      `"uni${BACKSLASH}u0041here"`,
      `"quote${BACKSLASH}"inside"`,
      `'double "quote" raw'`,
      `'esc${BACKSLASH}'apostrophe'`,
      `"cont${BACKSLASH}\ninued"`,
      `"nul${BACKSLASH}0end"`,
      `"emoji \u{1f600} tail"`,
    ];
    for (const source of cases) {
      const literals = scanJson5StringLiterals(source);
      expect(literals).toHaveLength(1);
      expect(literals[0].decoded).toBe(JSON5.parse(source));
      expect(literals[0].terminated).toBe(true);
      expect(literals[0].spans).toHaveLength(literals[0].decoded.length);
    }
  });

  it("maps each decoded unit back to the source text that produced it", () => {
    const source = `"a${BACKSLASH}u0062c"`;
    const [literal] = scanJson5StringLiterals(source);
    expect(literal.decoded).toBe("abc");
    expect(literal.spans.map(([start, end]) => source.slice(start, end))).toEqual([
      "a",
      `${BACKSLASH}u0062`,
      "c",
    ]);
  });

  it("skips quotes that live inside comments", () => {
    const source = `{\n  // a lone " in a comment\n  /* and ' another */\n  key: "value",\n}`;
    const literals = scanJson5StringLiterals(source);
    expect(literals.map((literal) => literal.decoded)).toEqual(["value"]);
  });

  it("reports an unterminated literal instead of running away", () => {
    const [literal] = scanJson5StringLiterals(`{ key: "oops`);
    expect(literal.terminated).toBe(false);
    expect(literal.decoded).toBe("oops");
  });

  it("finds both quote styles and keys", () => {
    const source = `{ "key": 'val', other: "x" }`;
    expect(scanJson5StringLiterals(source).map((literal) => literal.decoded)).toEqual([
      "key",
      "val",
      "x",
    ]);
  });
});

describe("findDecodedMatches", () => {
  it("returns the source span of a match spelled with escapes", () => {
    const source = `"prefix-${BACKSLASH}u0073ecret-suffix"`;
    const [literal] = scanJson5StringLiterals(source);
    const [match] = findDecodedMatches(literal, ["secret"]);
    expect(source.slice(match.start, match.end)).toBe(`${BACKSLASH}u0073ecret`);
  });

  it("spans a line continuation that splits the value", () => {
    const source = `"se${BACKSLASH}\ncret"`;
    const [literal] = scanJson5StringLiterals(source);
    expect(literal.decoded).toBe("secret");
    const [match] = findDecodedMatches(literal, ["secret"]);
    expect(source.slice(match.start, match.end)).toBe(`se${BACKSLASH}\ncret`);
  });

  it("prefers the longest needle and never overlaps matches", () => {
    const [literal] = scanJson5StringLiterals(`"abcabc"`);
    expect(findDecodedMatches(literal, ["ab", "abc"])).toEqual([
      { start: 1, end: 4 },
      { start: 4, end: 7 },
    ]);
  });

  it("ignores empty needles", () => {
    const [literal] = scanJson5StringLiterals(`"abc"`);
    expect(findDecodedMatches(literal, [""])).toEqual([]);
  });
});
