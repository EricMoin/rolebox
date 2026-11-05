/**
 * Adapter for error patterns contributed by extension modules.
 *
 * A `recovery_patterns` extension is user-authored JavaScript, so its category
 * and match function are untrusted. This module validates them and wraps the
 * match function so the {@link PatternRegistry} only ever receives structurally
 * valid {@link RecoveryError} values.
 *
 * @module recovery/extension-pattern
 */

import { createSubLogger } from "../logger.ts";
import type { ErrorPattern, RecoveryError } from "./types.ts";
import { isRecoveryError, isRecoveryErrorCategory } from "./validation.ts";

const log = createSubLogger("recovery:extension-pattern");

/**
 * The shape of a module loaded for the `recovery_patterns` scope, as seen at
 * the trust boundary.
 *
 * Every field is `unknown` because a module can export anything; the adapter
 * validates each one before use.
 */
export interface RecoveryPatternCandidate {
  /** Declared error category — must be a {@link RecoveryErrorCategory}. */
  category?: unknown;
  /** Declared match function — must be callable. */
  match?: unknown;
}

/**
 * Narrow untrusted data to a callable matcher.
 *
 * A plain `typeof value === "function"` check narrows to the untyped
 * `Function` type, so its call result would not be typed; this predicate
 * keeps the call site typed as `unknown`.
 */
function isMatchFunction(value: unknown): value is (error: unknown) => unknown {
  return typeof value === "function";
}

/**
 * Adapt an extension-loaded pattern module into a validated {@link ErrorPattern}.
 *
 * Returns `null` when the module's category is not a known
 * {@link RecoveryErrorCategory} or its `match` export is not a function; the
 * caller reports the skip and continues with the remaining modules.
 *
 * The returned pattern's `match` calls the module's matcher and only surfaces
 * the result when it is a structurally valid {@link RecoveryError}. `null` and
 * `undefined` mean "no match"; any other malformed value is also treated as no
 * match, with one warning per adapted pattern (not per call) so a misbehaving
 * module cannot flood the log.
 *
 * @param name - Registered extension entry name; it becomes the pattern name
 *   and is used in logs, so it is stable regardless of what the module exports.
 * @param candidate - The untrusted module exports.
 * @returns A real `ErrorPattern`, or `null` when the module is invalid.
 */
export function adaptExtensionPattern(
  name: string,
  candidate: RecoveryPatternCandidate,
): ErrorPattern | null {
  const { category, match } = candidate;

  if (!isRecoveryErrorCategory(category)) return null;
  if (!isMatchFunction(match)) return null;

  const runPatternMatch = match;
  let warnedInvalidResult = false;

  return {
    name,
    category,
    match(error: unknown): RecoveryError | null {
      const result = runPatternMatch(error);
      if (result === null || result === undefined) return null;
      if (isRecoveryError(result)) return result;
      if (!warnedInvalidResult) {
        warnedInvalidResult = true;
        log.warn("Extension recovery pattern returned an invalid RecoveryError — treated as no match", {
          name,
          category,
        });
      }
      return null;
    },
  };
}
