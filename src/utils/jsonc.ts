/**
 * Minimal JSONC (JSON with comments) support for host-config readers.
 *
 * rolebox reads JSONC host configuration (`opencode.jsonc` is the current
 * consumer), so comment stripping has to stay string-aware: comment markers
 * and `}` / `]` characters inside a string literal are data, never syntax,
 * and an escaped `"` does not terminate a string.
 *
 * Two pure passes, both hand-written character walks with no dependencies:
 * {@link stripJsonComments} removes comments, then {@link parseJsonc} drops
 * trailing commas before a closing `}` / `]` and defers to `JSON.parse`.
 * {@link parseJsonc} also ignores a single leading byte order mark (U+FEFF),
 * which RFC 8259 permits a parser to skip and `JSON.parse` does not: without
 * that, a host config an editor saved as UTF-8-with-BOM would be unreadable.
 *
 * `parseJsonc` THROWS on malformed input, exactly like `JSON.parse`; callers
 * keep their own try/catch and fallback policy.
 *
 * @module
 */

// ── Comment Stripping ───────────────────────────────────────────────────────

/**
 * Strip `//` line comments and block comments from a JSONC document while
 * preserving string literals.
 *
 * String content is copied through verbatim, including backslash escapes, so
 * comment markers inside a string stay untouched and an escaped quote does not
 * end the literal. A `//` runs to the end of its line; a block comment opener
 * runs to the next `*` and `/` pair. An unterminated block comment swallows
 * the remainder of the input.
 */
export function stripJsonComments(input: string): string {
  let result = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] === '"') {
      result += '"';
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\") {
          result += input[i] + (input[i + 1] || "");
          i += 2;
        } else {
          result += input[i];
          i++;
        }
      }
      if (i < input.length) {
        result += '"';
        i++;
      }
    } else if (input[i] === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") i++;
    } else if (input[i] === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
    } else {
      result += input[i];
      i++;
    }
  }
  return result;
}

// ── Trailing Commas ─────────────────────────────────────────────────────────

/**
 * Remove trailing commas that sit between the last element and a closing
 * `}` or `]`, ignoring commas inside string literals.
 *
 * The walk mirrors {@link stripJsonComments}: string literals (escapes
 * included) are copied verbatim, so only a comma followed — after optional
 * whitespace — by a closing brace/bracket outside a string is dropped.
 */
function stripTrailingCommas(input: string): string {
  let result = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] === '"') {
      result += '"';
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\") {
          result += input[i] + (input[i + 1] || "");
          i += 2;
        } else {
          result += input[i];
          i++;
        }
      }
      if (i < input.length) {
        result += '"';
        i++;
      }
    } else if (input[i] === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j++;
      if (input[j] === "}" || input[j] === "]") {
        // Trailing comma — drop it; the closer is copied on a later pass.
        i++;
      } else {
        result += input[i];
        i++;
      }
    } else {
      result += input[i];
      i++;
    }
  }
  return result;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse a JSONC string into a JavaScript value: a single leading byte order
 * mark is ignored, comments are stripped, trailing commas inside object/array
 * literals are removed, and the result is handed to `JSON.parse`.
 *
 * Only the leading mark is skipped (RFC 8259 §8.1 lets a parser ignore it
 * rather than fail); a U+FEFF anywhere else is still a syntax error.
 *
 * Malformed input THROWS (a `JSON.parse` SyntaxError) rather than degrading to
 * `null`/`undefined`, so callers own their fallback policy.
 */
export function parseJsonc(text: string): unknown {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return JSON.parse(stripTrailingCommas(stripJsonComments(body)));
}
