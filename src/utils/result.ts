// ── Result Utility ──────────────────────────────────────────────
//
// One discriminated result for rolebox-INTERNAL call sites that report a
// verdict instead of throwing: { ok: true; value } or { ok: false; error }.
//
// Scope is deliberate, and it is a rule — a shape belongs on Result only when
// the operation has exactly ONE success outcome and ONE failure outcome, the
// failure arm carries a reason rather than a distinct payload, and Result can
// express it WITHOUT INFORMATION LOSS. In-repo shapes that fail that rule are
// deliberately NOT converted:
//   - GraphValidationResult (deleted with src/graph/validator-v2.ts) — a REPORT
//     with two independent diagnostic channels (errors AND warnings); warnings
//     are meaningful even when valid, so a Result<void, string[]> would drop
//     them. Not expressible.
//   - LockResult (src/dispatch/concurrency/state-lock.ts) — an acquired
//     resource HANDLE carrying a release() capability and a plain ok: boolean
//     field (not a discriminant). A capability is not a verdict.
//   - RoleSwitchErrorBody / the monitor route bodies
//     (src/platform/adapters/dsh/web-*route.ts) — a SERIALIZED JSON WIRE
//     contract crossing to the browser client, and one variant carries an extra
//     field ({ ok: false; disabled: true; error }). Not an in-process union.
//   - RecoveryStrategyResult (src/recovery/types.ts) — a 4-state machine
//     (success | retry | next_strategy | abort), not a 2-arm verdict.
//   - HotReloadResult (src/core/services/hot-reload-service.ts) and
//     DshRoleboxReloadResult (src/platform/adapters/dsh/rolebox-reload.ts) —
//     a MULTI-OUTCOME report, not a 2-arm verdict: success, an explicitly
//     non-error "disabled" state (success: false; disabled: true; documented
//     "not an error"), and failure, with progress counters (discovered /
//     resolved / skipped) meaningful on more than one path. A Result's two
//     arms cannot express a third, non-error outcome without flattening it
//     into the error arm. Not expressible.
// The rule also leaves three seams alone — they are not verdicts at all:
//   - Host-facing callbacks keep their "no opinion" form: the dsh
//     presentCall / presentResult / finalizeContent members are typed
//     X | undefined BY THE HOST CONTRACT (see the honesty rule at
//     src/platform/adapters/dsh/tool-factory.ts:742-744) and undefined there
//     means "no opinion / fall back to the host default", never "failed".
//   - A lookup miss is a query answer, not a failure: Map.get, getService
//     and the probe* optional-capability seams stay X | undefined.
//   - The canonical tool failure path stays a throw: CanonicalToolDef.execute
//     mirrors the host's throw-based ToolDefinition.execute.

/** A value, or a reported reason there is none. E defaults to a plain message. */
export type Result<T = void, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/** Success. Call with no argument for a unit result (Result<void, E>). */
export function ok(): Result<void, never>;
export function ok<T>(value: T): Result<T, never>;
export function ok<T>(value?: T): Result<T | undefined, never> {
  return { ok: true, value };
}

/** Failure carrying error. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Narrow to the success arm. */
export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

/** Narrow to the failure arm. */
export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}
