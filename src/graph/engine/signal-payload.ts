/**
 * Graph Execution Engine v2 — Shared Signal Payload Helpers
 *
 * Version: 2.0
 * Date: 2026-09-18
 *
 * One narrowing vocabulary for signal payloads and the per-node
 * `signalsObserved` ledger. Before this module the same "non-null, non-array
 * object" test was written out five times — twice in `signal-propagation.ts`,
 * three times in `loop-group-executor.ts` — each copy with its own key list and
 * its own handling of arrays, and reads elsewhere asserted their way past the
 * narrowing. Engine code reads payloads through {@link asRecord} or the
 * predicates built on it instead of asserting
 * `payload as Record<string, unknown>`.
 *
 * Dependency rule: this module imports nothing. The engine modules that consume
 * it sit at the bottom of the engine import graph, so a runtime import here
 * would close an import cycle; the parameter types are structural, so not even
 * a type-only import is needed.
 *
 * Contract notes for consumers:
 * - {@link extractReason} answers `undefined` when the payload carries no
 *   string reason. The private copies it replaces answered the literal
 *   `"escalated"`; a call site that needs that default writes
 *   `extractReason(payload) ?? "escalated"`. A stored empty `reason: ""`
 *   still wins over the default, matching the old behaviour.
 * - {@link revisionText} answers `undefined` where the private copy answered
 *   `""` for a payload with no text at all (null / number / boolean); both are
 *   falsy, which is how its only consumer tests the result.
 * - {@link getSignal} looks the key up exactly as given. Normalizing an
 *   author-supplied condition argument (trim + lowercase, as
 *   `condition-resolver.ts` does for `signal_observed`) stays the caller's job.
 */

// ── Key vocabulary ──────────────────────────────────────────────────────────

/** Payload keys that mark unresolved work, in check order. */
const UNRESOLVED_KEYS = ["unresolved", "items", "findings"] as const;

/** Verdict values that mark a payload as still unresolved. */
const UNRESOLVED_VERDICTS = new Set<string>(["veto", "revise"]);

/** Payload keys that carry revision feedback, in display priority order. */
const REVISION_TEXT_KEYS = ["findings", "verdict", "reason", "feedback", "review"] as const;

/** Payload keys that can carry a short reason, in priority order. */
const REASON_KEYS = ["reason", "error", "message"] as const;

/** Marker the completion evaluator puts on a synthetic answer payload. */
const INFERRED_MARKER_KEY = "__inferred";

/**
 * Ledger keys consumers look up in a node's `signalsObserved`.
 *
 * The four signal types have the same spelling as the signal vocabulary
 * (`src/signal/signal-constants.ts`); `partialApprove` is the non-signal stash
 * key `partial_approve` written by the approval path. Keys are literal-typed
 * so a typo at a call site fails to compile rather than silently reading
 * `undefined`.
 */
export const SIGNAL_KEY = {
  answer: "answer",
  escalate: "escalate",
  reviseNeeded: "revise_needed",
  partialApprove: "partial_approve",
  progress: "progress",
} as const;

// ── Payload narrowing ───────────────────────────────────────────────────────

/**
 * The payload as a plain record, or `undefined` for anything else.
 *
 * This is the single place the engine narrows `unknown` to
 * `Record<string, unknown>`. Arrays are excluded so a list payload never
 * answers key lookups through its index properties; functions are excluded
 * with the other non-objects.
 */
export function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

/**
 * Whether the payload is the framework's synthetic-answer marker
 * (`{ __inferred: true }`, `SYNTHETIC_ANSWER_SIGNAL`) rather than a payload a
 * worker emitted.
 *
 * Only the exact boolean `true` counts, and the marker does not count when it
 * sits on an array. Both mirror the check this replaces — which, for a falsy
 * payload, returned that payload instead of a boolean; this function always
 * returns one.
 */
export function isInferred(payload: unknown): boolean {
  const obj = asRecord(payload);
  return obj !== undefined && obj[INFERRED_MARKER_KEY] === true;
}

/**
 * Whether an `answer` payload still carries unresolved work, so the caller can
 * downgrade it to `revise_needed` semantics instead of converging.
 *
 * True only for a record with a non-empty array at `unresolved`, `items` or
 * `findings`, or with a `verdict` of `"veto"` / `"revise"`. Strings, arrays
 * and objects without those markers are resolved; a signal that carried no
 * payload is stored as `null`.
 *
 * The predicate narrows to the record it tested, so a caller that has already
 * confirmed unresolved work can read the payload's keys without a second
 * narrowing.
 */
export function hasUnresolvedPayload(
  payload: unknown,
): payload is Record<string, unknown> {
  const obj = asRecord(payload);
  if (obj === undefined) return false;
  for (const key of UNRESOLVED_KEYS) {
    const value = obj[key];
    if (Array.isArray(value) && value.length > 0) return true;
  }
  const verdict = obj["verdict"];
  return typeof verdict === "string" && UNRESOLVED_VERDICTS.has(verdict);
}

// ── Payload → text ──────────────────────────────────────────────────────────

/**
 * Best-effort short reason from an `escalate` payload: a non-empty string
 * payload, or the first string among `reason`, `error`, `message`.
 *
 * `undefined` means the payload carried no reason. Call sites that must keep
 * the historical default write `extractReason(payload) ?? "escalated"` — not
 * `||`, so a deliberately empty `reason: ""` is preserved.
 */
export function extractReason(payload: unknown): string | undefined {
  if (typeof payload === "string") return payload === "" ? undefined : payload;
  const obj = asRecord(payload);
  if (obj !== undefined) {
    for (const key of REASON_KEYS) {
      const value = obj[key];
      if (typeof value === "string") return value;
    }
  }
  return undefined;
}

/**
 * Best-effort human-readable revision feedback from a `revise_needed` payload,
 * for merging into the re-executed node's prompt.
 *
 * A string payload is used verbatim. A record is searched for the first of
 * `findings` / `verdict` / `reason` / `feedback` / `review` that is a string,
 * or holds an array of strings (rendered as a bullet list). Any other object —
 * arrays included, whose key lookups would be meaningless — falls back to its
 * JSON text, exactly as the private copy did; primitives have no feedback text
 * and answer `undefined`.
 *
 * A falsy result means "no feedback" (an empty string is possible), so callers
 * test truthiness rather than comparing against `undefined`.
 */
export function revisionText(payload: unknown): string | undefined {
  if (typeof payload === "string") return payload;
  const obj = asRecord(payload);
  if (obj !== undefined) {
    for (const key of REVISION_TEXT_KEYS) {
      const value = obj[key];
      if (typeof value === "string") return value;
      if (
        Array.isArray(value) &&
        value.every((item) => typeof item === "string")
      ) {
        return value.map((item) => `- ${item}`).join("\n");
      }
    }
  }
  if (payload !== null && typeof payload === "object") {
    return JSON.stringify(payload);
  }
  return undefined;
}

// ── Ledger access ───────────────────────────────────────────────────────────

/**
 * Read one payload from a node's `signalsObserved` ledger.
 *
 * Returns the stored value only when `guard` accepts it, so a caller's
 * `as T` assertion becomes a runtime check; otherwise `undefined`. A missing
 * or malformed ledger (corrupt persisted state) also answers `undefined`
 * rather than throwing.
 *
 * @param node - Any object carrying the per-node ledger; structurally a
 *   `NodeRuntimeState`.
 * @param key - Ledger key, e.g. `SIGNAL_KEY.answer`; looked up exactly.
 * @param guard - Type predicate deciding which stored payloads count; a
 *   predicate from this module, such as {@link hasUnresolvedPayload}, works
 *   directly.
 * @returns the accepted payload, or `undefined` when it is absent or rejected.
 */
export function getSignal<T>(
  node: { signalsObserved: Record<string, unknown> },
  key: string,
  guard: (v: unknown) => v is T,
): T | undefined {
  const obj = asRecord(node.signalsObserved);
  if (obj === undefined) return undefined;
  const value = obj[key];
  return guard(value) ? value : undefined;
}
