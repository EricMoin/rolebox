/**
 * Minimal JSONC (JSON with comments) support for host-config readers.
 *
 * rolebox reads JSONC host configuration (`opencode.jsonc` is the current
 * consumer), so the sanitizing walk has to stay string-aware: comment markers
 * and `}` / `]` characters inside a string literal are data, never syntax, and
 * an escaped `\"` does not terminate a string.
 *
 * There is ONE hand-written pass and no dependencies. {@link sanitize} walks
 * the text once and at each position either copies a full string literal
 * verbatim (escape-aware), blanks a comment region, blanks a comma that is a
 * trailing comma, or copies one character. {@link stripJsonComments} exposes
 * that core's comments-only result; {@link parseJsonc} runs the same core with
 * trailing commas enabled and defers to `JSON.parse`.
 *
 * The pass is LENGTH-PRESERVING: a comment region, a dropped trailing comma
 * and a leading byte order mark all become spaces instead of disappearing, so
 * the output has exactly the input's length and every offset — line
 * terminators included — still means what it meant in the input. Two tokens
 * can therefore never be glued together (a comment sitting between two numbers
 * used to concatenate them into one token), and a position a runtime reports
 * for the sanitized text (V8's `JSON.parse` messages carry `position` and
 * `line column`) still refers to the ORIGINAL document.
 *
 * {@link parseJsonc} also ignores a single leading byte order mark (U+FEFF),
 * which RFC 8259 permits a parser to skip and `JSON.parse` does not: without
 * that, a host config an editor saved as UTF-8-with-BOM would be unreadable.
 *
 * `parseJsonc` THROWS on malformed input, exactly like `JSON.parse`; callers
 * keep their own try/catch and fallback policy.
 *
 * @module
 */

// ── Sanitizing Walk ─────────────────────────────────────────────────────────

/**
 * The four characters JSON's grammar accepts as a line terminator.
 *
 * `\n` alone is not enough: in a document with CRLF or U+2028 / U+2029
 * endings, treating only `\n` as the end of a `//` comment swallows the rest
 * of the document, so a valid file fails to parse.
 */
function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
}

/**
 * The trivia the trailing-comma lookahead may skip: space, tab and the four
 * line terminators.
 *
 * Deliberately not `\s`: `\v`, `\f`, NBSP and U+FEFF are not JSON whitespace,
 * so a document containing them stays a `JSON.parse` syntax error instead of
 * this module silently repairing it into something that parses.
 */
function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || isLineTerminator(code);
}

/**
 * Index just past the comment opening at `start`, or `-1` when no comment
 * opens there.
 *
 * The single definition of comment syntax in this module: {@link sanitize}
 * calls it to blank a region and {@link isTrailingComma} calls it to step over
 * trivia, so the two can never disagree about a `/`.
 */
function skipComment(text: string, start: number): number {
  const length = text.length;

  // The documented precondition: a comment can only open where the character
  // AT `start` is the `/`. Without it a caller that probes an arbitrary
  // position (isTrailingComma) reads "anything followed by a slash" as an
  // opener, so a non-trailing comma before a `/`-leading token — or before a
  // string whose first character is `/` — is dropped and a real trailing
  // comma is kept.
  if (text[start] !== "/") return -1;

  if (text[start + 1] === "/") {
    let i = start + 2;
    while (i < length && !isLineTerminator(text.charCodeAt(i))) i++;

    // LF and CR are JSON whitespace, so the terminator is copied back as data.
    // U+2028 and U+2029 are not: `JSON.parse` accepts only space, tab, LF and
    // CR (RFC 8259 `ws`), so leaving one behind would fail the whole document
    // over a character the comment already consumed. The comment owns that
    // terminator, and it is blanked with the region.
    const terminator = text.charCodeAt(i);
    if (terminator === 0x2028 || terminator === 0x2029) i++;
    return i;
  }

  if (text[start + 1] === "*") {
    let i = start + 2;
    while (i < length && !(text[i] === "*" && text[i + 1] === "/")) i++;
    // An unterminated block comment runs to end of input. Blanking that tail
    // (rather than deleting it) keeps the documented leniency safe, because a
    // truncated tail can no longer be glued onto the last token.
    return i < length ? i + 2 : length;
  }

  return -1;
}

/**
 * Whether the comma at `start` is a trailing comma: the next significant
 * position — skipping whitespace and whole comments — holds `}` or `]`.
 *
 * The lookahead stops at the first significant character, so it never rescans
 * trivia and total lookahead work stays bounded by the document length. At end
 * of input the comma is KEPT, so `JSON.parse` still rejects a dangling comma
 * instead of this module inventing a valid document.
 */
function isTrailingComma(text: string, start: number): boolean {
  const length = text.length;
  let i = start + 1;

  for (;;) {
    while (i < length && isJsonWhitespace(text.charCodeAt(i))) i++;
    const end = skipComment(text, i);
    if (end === -1) break;
    i = end;
  }

  return text[i] === "}" || text[i] === "]";
}

/**
 * Walk `text` once and return a same-length sanitized copy: every comment
 * region and (when `dropTrailingCommas` is set) every trailing comma becomes
 * one space per code unit, string literals are copied verbatim, and everything
 * else is copied unchanged.
 *
 * The walk uses an index loop rather than `for...of` so a comment holding an
 * astral character still yields one space per UTF-16 code unit: an emoji is
 * two code units and so must be two spaces.
 */
function sanitize(text: string, dropTrailingCommas: boolean): string {
  const chunks: string[] = [];
  const length = text.length;
  let i = 0;

  // A single leading BOM is blanked rather than sliced off, so every later
  // index still matches the original document. Only the leading one: a U+FEFF
  // anywhere else is copied and stays a syntax error.
  if (text.charCodeAt(0) === 0xfeff) {
    chunks.push(" ");
    i = 1;
  }

  while (i < length) {
    const char = text[i];

    if (char === '"') {
      const start = i;
      i++;
      while (i < length) {
        if (text[i] === "\\") {
          i += 2;
        } else if (text[i] === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
      chunks.push(text.slice(start, i));
      continue;
    }

    if (char === "/") {
      const end = skipComment(text, i);
      if (end !== -1) {
        chunks.push(" ".repeat(end - i));
        i = end;
        continue;
      }
    }

    if (dropTrailingCommas && char === "," && isTrailingComma(text, i)) {
      chunks.push(" ");
      i++;
      continue;
    }

    chunks.push(char);
    i++;
  }

  return chunks.join("");
}

// ── Comment Stripping ───────────────────────────────────────────────────────

/**
 * Blank `//` line comments and block comments in a JSONC document while
 * preserving string literals.
 *
 * The historical name is kept for callers; what changed is that comments are
 * BLANKED, one space per code unit, rather than deleted, so the result has
 * exactly the input's length and every offset keeps its index (see the module
 * doc for what that buys).
 *
 * String content is copied through verbatim, including backslash escapes, so
 * comment markers inside a string stay untouched and an escaped quote does not
 * end the literal. A `//` runs to the next line terminator — `\n`, `\r`,
 * U+2028 or U+2029 — and a block comment opener runs to the next `*` / `/`
 * pair; an unterminated block comment is blanked through end of input. One
 * leading U+FEFF is blanked as well, so the length invariant holds for a
 * UTF-8-with-BOM file too.
 */
export function stripJsonComments(input: string): string {
  return sanitize(input, false);
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse a JSONC string into a JavaScript value: a single leading byte order
 * mark is ignored, comments are blanked, trailing commas inside object/array
 * literals are dropped, and the result is handed to `JSON.parse`.
 *
 * Only the leading mark is skipped (RFC 8259 §8.1 lets a parser ignore it
 * rather than fail); a U+FEFF anywhere else is still a syntax error. Comments
 * are blanked rather than deleted, so a `JSON.parse` error position still
 * points into the original document.
 *
 * Malformed input THROWS (a `JSON.parse` SyntaxError) rather than degrading to
 * `null`/`undefined`, so callers own their fallback policy.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(sanitize(text, true));
}
