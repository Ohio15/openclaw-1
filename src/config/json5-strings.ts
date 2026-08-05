/**
 * JSON5 string-literal scanner with a source-span map.
 *
 * Text-level redaction of the config SOURCE has to answer one question:
 * "does this piece of the document *mean* the secret?", not "is the secret
 * spelled here the way the parser handed it to me?". A value carrying a
 * newline can be written `\n` or `\u000a` (both plain strict JSON), `\x0a`
 * (a JSON5 hex escape), or as a JSON5 line continuation — a backslash followed
 * by a real newline — and every one of those parses to the same string.
 * Matching the decoded value — or any fixed list of re-encodings of it —
 * against the source therefore misses an unbounded set of legal spellings, and
 * each miss emits the credential verbatim.
 *
 * So instead of enumerating spellings, this scanner walks the document once,
 * finds every string literal (both JSON5 quote styles, comments skipped),
 * DECODES it, and remembers which source characters produced each decoded
 * character. A caller can then compare decoded text against a secret and edit
 * exactly the source span that produced it — spelling-independent by
 * construction, and non-destructive to the formatting and comments that are
 * the whole reason `snapshot.raw` exists.
 */

export type Json5StringLiteral = {
  /** Index of the opening quote. */
  start: number;
  /** Index just past the closing quote (or end of input if unterminated). */
  end: number;
  /** The literal's value, with every escape resolved. */
  decoded: string;
  /**
   * `spans[i]` is the `[start, end)` source range that produced `decoded[i]`.
   * Indices are UTF-16 code units on both sides, so a surrogate pair spells two
   * entries — the same unit granularity `String.prototype.indexOf` works in.
   */
  spans: Array<[number, number]>;
  /** The quote character that delimits the literal. */
  quote: '"' | "'";
  /** False when the input ended before the closing quote. */
  terminated: boolean;
};

const SINGLE_CHAR_ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

const isLineTerminator = (ch: string): boolean =>
  ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029";

const isHexDigit = (ch: string | undefined): boolean => ch !== undefined && /[0-9a-fA-F]/.test(ch);

/**
 * Read one string literal starting at the opening quote at `start`.
 */
function readStringLiteral(source: string, start: number): Json5StringLiteral {
  const quote = source[start] as '"' | "'";
  const decodedParts: string[] = [];
  const spans: Array<[number, number]> = [];
  const pushDecoded = (text: string, from: number, to: number) => {
    decodedParts.push(text);
    for (let unit = 0; unit < text.length; unit += 1) {
      spans.push([from, to]);
    }
  };

  let index = start + 1;
  while (index < source.length) {
    const ch = source[index];
    if (ch === quote) {
      return {
        start,
        end: index + 1,
        decoded: decodedParts.join(""),
        spans,
        quote,
        terminated: true,
      };
    }
    if (ch !== "\\") {
      // A raw line terminator inside a literal is a JSON5 syntax error, but a
      // scanner has no business throwing on input the parser already accepted
      // or rejected; carry it through as an ordinary character.
      pushDecoded(ch, index, index + 1);
      index += 1;
      continue;
    }

    const next = source[index + 1];
    if (next === undefined) {
      // Trailing backslash at EOF: unterminated literal.
      break;
    }
    if (isLineTerminator(next)) {
      // Line continuation — contributes NOTHING to the value. This is the
      // spelling that a "re-encode the value and search for it" redactor can
      // never produce, because there is no value-side character to re-encode.
      const isCrLf = next === "\r" && source[index + 2] === "\n";
      index += isCrLf ? 3 : 2;
      continue;
    }
    if (next === "x") {
      const hex = source.slice(index + 2, index + 4);
      if (hex.length === 2 && isHexDigit(hex[0]) && isHexDigit(hex[1])) {
        pushDecoded(String.fromCharCode(Number.parseInt(hex, 16)), index, index + 4);
        index += 4;
        continue;
      }
      // Malformed: fall through to the literal-character rule below.
    }
    if (next === "u") {
      const hex = source.slice(index + 2, index + 6);
      if (hex.length === 4 && [...hex].every((digit) => isHexDigit(digit))) {
        pushDecoded(String.fromCharCode(Number.parseInt(hex, 16)), index, index + 6);
        index += 6;
        continue;
      }
      // Malformed: fall through to the literal-character rule below.
    }
    const simple = SINGLE_CHAR_ESCAPES[next];
    if (simple !== undefined && !(next === "0" && /[0-9]/.test(source[index + 2] ?? ""))) {
      pushDecoded(simple, index, index + 2);
      index += 2;
      continue;
    }
    // `\"`, `\'`, `\\`, `\/` and every other escape stand for the escaped
    // character itself.
    pushDecoded(next, index, index + 2);
    index += 2;
  }

  return {
    start,
    end: source.length,
    decoded: decodedParts.join(""),
    spans,
    quote,
    terminated: false,
  };
}

/**
 * Find every string literal in a JSON5 document, in source order.
 *
 * Comments are skipped so a quote character inside one cannot desynchronize the
 * scan. Keys are literals too when they are quoted; the caller decides whether
 * a match in key position is interesting.
 */
export function scanJson5StringLiterals(source: string): Json5StringLiteral[] {
  const literals: Json5StringLiteral[] = [];
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && !isLineTerminator(source[index])) {
        index += 1;
      }
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close === -1 ? source.length : close + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const literal = readStringLiteral(source, index);
      literals.push(literal);
      index = literal.end;
      continue;
    }
    index += 1;
  }
  return literals;
}

export type LiteralReplacement = {
  /** Source range to replace, `[start, end)`. */
  start: number;
  end: number;
};

/**
 * Locate the source spans inside `literal` whose DECODED text equals one of
 * `needles`. Longest needle wins at any given position, matches never overlap,
 * and the returned ranges are in source order.
 */
export function findDecodedMatches(
  literal: Json5StringLiteral,
  needles: readonly string[],
): LiteralReplacement[] {
  const ordered = [...new Set(needles.filter((needle) => needle.length > 0))].toSorted(
    (a, b) => b.length - a.length,
  );
  if (ordered.length === 0) {
    return [];
  }
  const matches: LiteralReplacement[] = [];
  const { decoded, spans } = literal;
  let cursor = 0;
  while (cursor < decoded.length) {
    const hit = ordered.find((needle) => decoded.startsWith(needle, cursor));
    if (!hit) {
      cursor += 1;
      continue;
    }
    const firstSpan = spans[cursor];
    const lastSpan = spans[cursor + hit.length - 1];
    if (firstSpan && lastSpan) {
      matches.push({ start: firstSpan[0], end: lastSpan[1] });
    }
    cursor += hit.length;
  }
  return matches;
}
