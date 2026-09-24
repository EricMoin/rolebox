// ── Key vocabulary ──────────────────────────────────────────────────────────

/**
 * Ledger keys consumers look up in a node's `signalsObserved`.
 *
 * The four signal types have the same spelling as the signal vocabulary
 * (`src/signal/signal-constants.ts`); `partialApprove` is the non-signal stash
 * key `partial_approve` the deleted approval path wrote, kept as vocabulary a
 * persisted record may still carry. Keys are literal-typed so a typo at a call
 * site fails to compile rather than silently reading `undefined`.
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
 * This is the single place the status surface narrows `unknown` to
 * `Record<string, unknown>`. Arrays are excluded so a list payload never
 * answers key lookups through its index properties; functions are excluded
 * with the other non-objects.
 */
export function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
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
 * @param guard - Type predicate deciding which stored payloads count; the
 *   caller owns the predicate.
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
