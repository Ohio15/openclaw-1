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
  return scanJson5Document(source).literals;
}

export type Json5LiteralRole = "key" | "value";

export type Json5DocumentLiteral = Json5StringLiteral & {
  /** Whether the literal sits in key position or value position. */
  role: Json5LiteralRole;
  /**
   * Config path of the value this literal IS (role "value") or NAMES
   * (role "key"): dot-joined keys with `[]` for array elements, "" for a root
   * scalar — the same shape the parsed-config walkers use. `null` when the
   * surrounding structure is too broken to assign one (a value with no
   * preceding key, text past an unbalanced close).
   */
  path: string | null;
};

export type Json5CommentSpan = {
  /** Span of the whole comment, delimiters included, `[start, end)`. */
  start: number;
  end: number;
  /** Span of the comment TEXT between the delimiters, `[textStart, textEnd)`. */
  textStart: number;
  textEnd: number;
};

export type Json5BareToken = {
  /** Span of the token in the source, `[start, end)`. */
  start: number;
  end: number;
  /** The token text with `\uXXXX` identifier escapes resolved. */
  decoded: string;
};

export type Json5DocumentScan = {
  literals: Json5DocumentLiteral[];
  comments: Json5CommentSpan[];
  /**
   * Every unquoted token (identifier keys, `true`, numbers), DECODED. An
   * unquoted key can spell a secret through `\uXXXX` identifier escapes, so a
   * leak check that only looks at string literals and verbatim text has a
   * blind spot without these.
   */
  bareTokens: Json5BareToken[];
};

type ScanFrame =
  | { kind: "object"; path: string | null; expectKey: boolean; key: string | null }
  | { kind: "array"; path: string | null };

/**
 * The config path a value beginning at the current position would carry.
 * `null` when it cannot be known (broken structure); "" for the root value.
 */
function currentValuePath(stack: ScanFrame[]): string | null {
  const top = stack[stack.length - 1];
  if (!top) {
    return "";
  }
  if (top.path === null) {
    return null;
  }
  if (top.kind === "array") {
    return `${top.path}[]`;
  }
  if (top.expectKey || top.key === null) {
    return null;
  }
  return top.path === "" ? top.key : `${top.path}.${top.key}`;
}

const STRUCTURAL_CHARS = new Set(["{", "}", "[", "]", ":", ",", '"', "'", "/"]);

/**
 * Read a bare (unquoted) token — an identifier key, `true`, a number.
 * JSON5 identifiers may contain `\uXXXX` escapes, which are decoded so the
 * token compares equal to the key the parser produces.
 */
function readBareToken(source: string, start: number): { end: number; decoded: string } {
  let index = start;
  let decoded = "";
  while (index < source.length) {
    const ch = source[index];
    if (STRUCTURAL_CHARS.has(ch) || /\s/.test(ch)) {
      break;
    }
    if (ch === "\\" && source[index + 1] === "u") {
      const hex = source.slice(index + 2, index + 6);
      if (hex.length === 4 && [...hex].every((digit) => isHexDigit(digit))) {
        decoded += String.fromCharCode(Number.parseInt(hex, 16));
        index += 6;
        continue;
      }
    }
    decoded += ch;
    index += 1;
  }
  return { end: index, decoded };
}

/**
 * Scan a JSON5 document once, producing every string literal WITH its
 * structural position (key vs. value, config path) and every comment span.
 *
 * Path tracking exists so a caller can redact "the literal that IS the value
 * at a sensitive path" instead of "any literal that happens to contain matching
 * text" — matching by text alone redacts key names and unrelated values, and a
 * round-trip through the raw editor then persists the damage.
 *
 * The tracker never throws: redaction only runs on documents the real parser
 * already accepted, so unbalanced structure here means a scanner bug or hostile
 * input, and either way the safe output is `path: null` (callers treat unknown
 * position as not-redactable and fail closed downstream).
 */
export function scanJson5Document(source: string): Json5DocumentScan {
  const literals: Json5DocumentLiteral[] = [];
  const comments: Json5CommentSpan[] = [];
  const bareTokens: Json5BareToken[] = [];
  const stack: ScanFrame[] = [];
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "/" && source[index + 1] === "/") {
      const textStart = index + 2;
      let end = textStart;
      while (end < source.length && !isLineTerminator(source[end])) {
        end += 1;
      }
      comments.push({ start: index, end, textStart, textEnd: end });
      index = end;
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      const textStart = index + 2;
      const close = source.indexOf("*/", textStart);
      const textEnd = close === -1 ? source.length : close;
      const end = close === -1 ? source.length : close + 2;
      comments.push({ start: index, end, textStart, textEnd });
      index = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const literal = readStringLiteral(source, index);
      const top = stack[stack.length - 1];
      if (top?.kind === "object" && top.expectKey) {
        top.key = literal.decoded;
        const named =
          top.path === null
            ? null
            : top.path === ""
              ? literal.decoded
              : `${top.path}.${literal.decoded}`;
        literals.push({ ...literal, role: "key", path: named });
      } else {
        literals.push({ ...literal, role: "value", path: currentValuePath(stack) });
      }
      index = literal.end;
      continue;
    }
    if (ch === "{") {
      stack.push({ kind: "object", path: currentValuePath(stack), expectKey: true, key: null });
      index += 1;
      continue;
    }
    if (ch === "[") {
      stack.push({ kind: "array", path: currentValuePath(stack) });
      index += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      index += 1;
      continue;
    }
    if (ch === ":") {
      const top = stack[stack.length - 1];
      if (top?.kind === "object") {
        top.expectKey = false;
      }
      index += 1;
      continue;
    }
    if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top?.kind === "object") {
        top.expectKey = true;
        top.key = null;
      }
      index += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }
    const token = readBareToken(source, index);
    const top = stack[stack.length - 1];
    if (top?.kind === "object" && top.expectKey && token.decoded.length > 0) {
      top.key = token.decoded;
    }
    if (token.decoded.length > 0) {
      bareTokens.push({ start: index, end: token.end, decoded: token.decoded });
    }
    index = token.end > index ? token.end : index + 1;
  }
  return { literals, comments, bareTokens };
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
