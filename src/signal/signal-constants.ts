/**
 * Signal-type vocabulary — single source of truth.
 *
 * The 8-signal vocabulary and its category sets (terminating / pausing /
 * handoff / info) live here exactly once. Every consumer imports from
 * this module so the vocabulary is never duplicated.
 *
 * The type order is canonical — src/signal/signal-tool.ts derives its runtime
 * Zod enum from this array (`z.enum(SIGNAL_TYPES)`), so the validation
 * boundary can never drift from the vocabulary.
 */

/** The 8 valid signal types, in Zod-enum order. */
export const SIGNAL_TYPES = [
  "answer",
  "need_approval",
  "blocked",
  "need_clarification",
  "handoff",
  "progress",
  "revise_needed",
  "escalate",
] as const;

/** Union of the 8 valid signal types. */
export type SignalType = (typeof SIGNAL_TYPES)[number];

/**
 * Named signal type constants for ergonomic use (e.g. `SIGNAL_TYPE.ANSWER`).
 *
 * Type-bound to the SIGNAL_TYPES tuple via
 * `Record<Uppercase<SignalType>, SignalType>`: the compiler requires one key
 * per signal type (exhaustiveness) and rejects any key or value that is not
 * a valid signal type, so this object cannot drift from the vocabulary.
 */
export const SIGNAL_TYPE: Record<Uppercase<SignalType>, SignalType> = {
  ANSWER: "answer",
  NEED_APPROVAL: "need_approval",
  BLOCKED: "blocked",
  NEED_CLARIFICATION: "need_clarification",
  HANDOFF: "handoff",
  PROGRESS: "progress",
  REVISE_NEEDED: "revise_needed",
  ESCALATE: "escalate",
};

// ── Signal categories ───────────────────────────────────────────────────
//
// Each category is written once, as a literal tuple checked against
// `SignalType` by `satisfies`. The tuples — not widened `Set<string>`s — are
// the definition site, so a misspelled member fails to compile and the
// category sets cannot accumulate values outside the vocabulary.

/** Signals that satisfy `continue_until` — terminate the node's run. */
const TERMINATING_SIGNAL_TYPES = [
  "answer",
  "revise_needed",
  "escalate",
] as const satisfies readonly SignalType[];

/** Signals that trigger a pausing transition (approval / blocked / clarification). */
const PAUSING_SIGNAL_TYPES = [
  "need_approval",
  "blocked",
  "need_clarification",
] as const satisfies readonly SignalType[];

/** Signals that route work elsewhere without terminating. */
const HANDOFF_SIGNAL_TYPES = ["handoff"] as const satisfies readonly SignalType[];

/** Informational signals with no state transition. */
const INFO_SIGNAL_TYPES = ["progress"] as const satisfies readonly SignalType[];

/** Signals that satisfy `continue_until` — terminate the node's run. */
export const TERMINATING_SIGNALS: ReadonlySet<SignalType> = new Set(
  TERMINATING_SIGNAL_TYPES,
);

/** Signals that trigger a pausing transition (approval / blocked / clarification). */
export const PAUSING_SIGNALS: ReadonlySet<SignalType> = new Set(
  PAUSING_SIGNAL_TYPES,
);

/** Signals that route work elsewhere without terminating. */
export const HANDOFF_SIGNALS: ReadonlySet<SignalType> = new Set(
  HANDOFF_SIGNAL_TYPES,
);

/** Informational signals with no state transition. */
export const INFO_SIGNALS: ReadonlySet<SignalType> = new Set(INFO_SIGNAL_TYPES);

/** All 8 signal types — union of the four categories above. */
export const ALL_SIGNAL_TYPES: ReadonlySet<SignalType> = new Set([
  ...TERMINATING_SIGNAL_TYPES,
  ...PAUSING_SIGNAL_TYPES,
  ...HANDOFF_SIGNAL_TYPES,
  ...INFO_SIGNAL_TYPES,
]);

/** Every signal type named by one of the four category tuples above. */
type CategorizedSignalType =
  | (typeof TERMINATING_SIGNAL_TYPES)[number]
  | (typeof PAUSING_SIGNAL_TYPES)[number]
  | (typeof HANDOFF_SIGNAL_TYPES)[number]
  | (typeof INFO_SIGNAL_TYPES)[number];

/**
 * Compile-time proof that the four categories cover the vocabulary exactly.
 *
 * `Exclude<SignalType, CategorizedSignalType>` is a union of every signal type
 * missing from all four tuples; if it is not `never`, the empty object cannot
 * satisfy the required keys and this declaration fails to compile. Adding a
 * member to {@link SIGNAL_TYPES} therefore forces a categorization decision
 * instead of silently leaving it out of {@link ALL_SIGNAL_TYPES}.
 */
const _signalCategoryCoverage = {} satisfies Record<
  Exclude<SignalType, CategorizedSignalType>,
  true
>;

/**
 * Union of the signal types that terminate a node's run.
 *
 * Exported for the engine's node-completion seam (`NodeCompletionEvent` in
 * `src/graph/engine/engine-advance.ts`), which carries one of these for a
 * signal-driven transition plus its own synthetic `"timeout"` marker — so the
 * engine-side field is `TerminatingSignalType | "timeout"`, not this union
 * alone. The engine adds the timeout literal because a timeout is not a
 * signal.
 */
export type TerminatingSignalType = (typeof TERMINATING_SIGNAL_TYPES)[number];

/**
 * Terminating signals in descending severity order.
 *
 * Used by the completion evaluator so the highest-severity terminating signal
 * wins when multiple were recorded during a sub-agent session.
 */
export const TERMINATING_SIGNALS_BY_SEVERITY = ["escalate", "revise_needed", "answer"] as const;

/**
 * Synthetic terminating signal emitted by the completion evaluator for a
 * normally-completed task whose sub-agent never called `signal()`.
 *
 * A task that finished clean without an explicit `signal()` call IS a clean
 * `answer` — the plugin auto-emits on the sub-agent's behalf. The
 * `__inferred` marker is retained purely for observability so downstream
 * consumers know this signal was generated by the framework, not the
 * sub-agent.
 *
 * Shared constant — used by the completion evaluator (populate
 * `task.terminatingSignal`) and available to engine code for signal
 * classification.
 */
export const SYNTHETIC_ANSWER_SIGNAL = {
  type: "answer" as const,
  payload: { __inferred: true } as const,
} as const;
