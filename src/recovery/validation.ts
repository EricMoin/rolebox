/**
 * Runtime validation for values crossing into the recovery framework.
 *
 * Extension modules are user-authored JavaScript loaded at runtime, so the
 * types declared in `types.ts` describe what a well-behaved module *should*
 * return, not what it does. These guards are the trust boundary: they
 * validate untrusted values before the recovery engine stores or acts on them.
 *
 * @module recovery/validation
 */

import type { RecoveryError, RecoveryErrorCategory } from "./types.ts";

/**
 * Every recoverable error category the framework knows about, in
 * strategy-chain order.
 *
 * This is the single source of truth for runtime category validation and for
 * config parsing — keep {@link RecoveryErrorCategory} and this list in sync.
 */
export const RECOVERY_ERROR_CATEGORIES = [
  "session_error",
  "context_window",
  "edit_error",
  "json_error",
  "empty_response",
  "tool_pair",
  "guard_violation",
] as const satisfies readonly RecoveryErrorCategory[];

const RECOVERY_ERROR_CATEGORY_SET: ReadonlySet<string> = new Set(RECOVERY_ERROR_CATEGORIES);

/**
 * Whether `value` names one of the declared recovery error categories.
 *
 * Use this before storing a category or using it to select a strategy chain;
 * an unknown category would silently select no chain.
 */
export function isRecoveryErrorCategory(value: unknown): value is RecoveryErrorCategory {
  return typeof value === "string" && RECOVERY_ERROR_CATEGORY_SET.has(value);
}

/**
 * Whether `value` is a structurally valid {@link RecoveryError}.
 *
 * Requires a valid `category`, string `errorType`, string `message` and
 * numeric `timestamp`. The optional `raw` diagnostic payload is not
 * validated: it deliberately carries whatever the pattern saw.
 */
export function isRecoveryError(value: unknown): value is RecoveryError {
  if (typeof value !== "object" || value === null) return false;
  if (!("category" in value) || !isRecoveryErrorCategory(value.category)) return false;
  if (!("errorType" in value) || typeof value.errorType !== "string") return false;
  if (!("message" in value) || typeof value.message !== "string") return false;
  if (!("timestamp" in value) || typeof value.timestamp !== "number") return false;
  return true;
}
