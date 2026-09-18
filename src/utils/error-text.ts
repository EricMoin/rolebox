// ── Error Text Utility ──────────────────────────────────────────
//
// One safe stringification of a caught value.
//
// `catch (err)` is `unknown` under strict, and the two ad-hoc shapes in the
// repo disagree: `(err as Error).message` answers `undefined` for a non-Error
// throw, swallowing the failure reason, while `String(err)` itself throws on a
// value with no primitive conversion (`Object.create(null)`) — inside a catch
// block that turns one failure into an unrelated TypeError.

/** Returned when the caught value has no printable form. */
const UNPRINTABLE_THROWN_VALUE = "<unprintable thrown value>";

/**
 * A printable description of any caught value. Never throws.
 *
 * An `Error` answers its `message`, falling back to its `name` when the
 * message is empty (`new RangeError()` → `"RangeError"`). Every other value is
 * stringified; a symbol, and anything whose stringification throws or is
 * refused, answers `"<unprintable thrown value>"`.
 *
 * @param err - The value from a `catch` clause or a rejection handler.
 * @returns the value's text, or `"<unprintable thrown value>"` when it cannot
 *   be described. Only a value that stringifies to empty (`""`, `[]`) answers
 *   an empty string.
 */
export function errorText(err: unknown): string {
  try {
    if (err instanceof Error) {
      const message = typeof err.message === "string" ? err.message : "";
      if (message !== "") return message;
      const name = typeof err.name === "string" ? err.name : "";
      return name !== "" ? name : UNPRINTABLE_THROWN_VALUE;
    }
    // `String(symbol)` succeeds, but the implicit conversion call sites
    // actually write (`${err}` / `"" + err`) throws; the seam treats a thrown
    // symbol as having no message rather than leaking one form's output.
    if (typeof err === "symbol") return UNPRINTABLE_THROWN_VALUE;
    return String(err);
  } catch {
    return UNPRINTABLE_THROWN_VALUE;
  }
}
