/**
 * Graph Execution Engine v2 — Loop progress: projection, comparison, baseline (D5)
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The PROGRESS EVALUATOR of the outcome protocol
 * (docs/graph-outcome-protocol.md section "Loop progress"): what a loop compares
 * across completed rounds, what "progressed", "unchanged" and "unknown" mean, and
 * the baseline a comparison is made against.
 *
 * THE PROJECTION IS PRODUCED OUTSIDE THE ACCEPTANCE TRANSACTION. A compiled loop
 * group may declare a progress policy — the comparison SEMANTICS (an evaluator
 * identity and its exact version), the comparison OBJECT (one field of the
 * outcome data) and an explicit stagnation threshold. Before a submission reaches
 * the acceptance transaction, {@link projectProgress} turns the worker payload
 * into a BOUNDED, IMMUTABLE {@link ProgressProjection}: the declared subject is
 * read ONCE, reduced to a token of at most {@link PROGRESS_VALUE_MAX_LENGTH}
 * characters (or to a bounded marker saying why it cannot be compared), and bound
 * to the proposal digest, the attempt, the plan revision and the validation it
 * was produced under. The comparison itself — read the persisted baseline,
 * compare, update the counters — runs INSIDE the transaction against the state
 * the acceptance commits with, so a crash cannot separate the acceptance from the
 * progress it implied.
 *
 * THE RAW PAYLOAD IS NEVER PERSISTED, AND NO DIGEST IS COMPUTED IN THE
 * TRANSACTION. The projection is a value, not a write: nothing here touches a
 * ledger. What is persisted is the BASELINE (the bounded token the run last
 * compared against) and the counters — see {@link OutcomeLoopProgress}. Reading
 * the payload, truncating it and binding it all happen before the transaction
 * opens, which is exactly why a large or unrepresentable payload cannot make the
 * acceptance transaction do file or hashing work.
 *
 * THE THREE-WAY ANSWER, AND WHY UNKNOWN EXISTS. A comparison answers:
 * - PROGRESSED — the token differs from the baseline, so the loop moved (the
 *   baseline is replaced and the unchanged streak resets);
 * - UNCHANGED — the token equals the baseline, so the round produced the same
 *   declared revision (the streak grows; reaching the declared threshold is the
 *   progress-stalled stop, the run stopping policy);
 * - UNKNOWN — the comparison COULD NOT BE MADE: the persisted baseline was
 *   recorded under another evaluator identity or version, or the observation is
 *   truncated or not a comparable token. Unknown is NOT "equal": it never
 *   increments the unchanged streak, never triggers the soft stop, and never
 *   replaces the baseline. An unknown leaves the persisted progress EXACTLY as
 *   it was, so the decision semantics survive a restart even when the comparison
 *   could not be made, and the declared HARD limits still apply to the run.
 *
 * WHAT IS COMPARABLE. The declared subject value must be a NON-EMPTY STRING — a
 * revision token, compared for exact equality. A value of any other JSON type (a
 * number, a boolean, null, an object, an array) is legal payload but is NOT
 * comparable, and this evaluator never coerces one into a token: coercion would
 * let two different JSON values look equal and turn an incomparable submission
 * into an invented "unchanged". A value longer than the bound is TRUNCATED for
 * the same reason: a prefix comparison is not a comparison.
 *
 * A MISSING SUBJECT IS REFUSED, NOT UNKNOWN. When a declared policy applies to
 * the submitted outcome, the declared subject is a REQUIRED field: an absent one
 * (or an explicit undefined) is a structured refusal (progress-subject-missing)
 * with nothing written, so the worker can repair the submission. Only a subject
 * that is PRESENT but not comparable is unknown.
 *
 * SUCCESSFUL OUTCOMES NEVER ENTER THIS PATH. A projection is produced only for an
 * outcome a declared policy actually governs — a loop CONTINUATION. The outcome
 * that leaves the loop (or terminates its node) is not compared, has no required
 * subject and cannot be refused for one: the revision-staleness question is about
 * continuing a loop, never about a result the loop accepted as finished.
 *
 * Dependency leaf: this module imports TYPES only (the plan policy shape and the
 * acceptance core validation binding), so a reducer, a runtime or a tool boundary
 * may depend on it without a runtime cycle.
 */

import type { CompiledProgressPolicy } from "../compiler/plan.ts";
import type { ValidationBinding } from "./acceptance.ts";

// ── The evaluator capability ────────────────────────────────────────────────

/**
 * The one comparison SEMANTICS this build implements: equality of the declared
 * subject revision token across rounds.
 *
 * A plan declares this identity and an exact version. An evaluator identity this
 * build does not implement is refused when a projection is asked for
 * (progress-evaluator-unavailable), never silently executed with different
 * semantics: the declared identity is what the comparison MEANS, so a plan that
 * declares something else must not be compared as if it had declared this.
 */
export const PROGRESS_EVALUATOR_REVISION_TOKEN = "revision-token" as const;

/** The evaluator identities this build implements, in canonical order. */
export const PROGRESS_EVALUATORS: readonly string[] = Object.freeze([
  PROGRESS_EVALUATOR_REVISION_TOKEN,
]);

/**
 * The longest revision token a projection carries, in UTF-16 code units.
 *
 * The bound is what makes a projection a bounded value: a longer subject is
 * reported as a truncated {@link ProgressObservation} and compared as unknown, so
 * no payload can push an arbitrary amount of data into the run path — and a
 * truncated value is never compared by prefix.
 */
export const PROGRESS_VALUE_MAX_LENGTH = 256;

// ── The persisted progress record ───────────────────────────────────────────

/**
 * One loop group persisted progress: the evaluator identity the baseline was
 * recorded under, the baseline itself and the consecutive-unchanged counter.
 *
 * The baseline is ABSENT until the first comparable observation: there is nothing
 * to compare a first round against, so the first comparable token establishes the
 * baseline (and answers progressed — the run has not been observed to stand
 * still). The unchanged count never counts an unknown.
 */
export interface OutcomeLoopProgress {
  /** The declared loop group this progress belongs to. */
  readonly loopGroupId: string;
  /** The comparison semantics the baseline was recorded under. */
  readonly evaluator: string;
  /**
   * The exact version of {@link evaluator} the baseline was recorded under. A
   * comparison whose evaluator version differs from this one is unknown: the
   * meaning of "changed" may itself have changed, so this build never pretends
   * the two versions agree.
   */
  readonly version: number;
  /** The comparison object: the outcome-data field the token was read from. */
  readonly subject: string;
  /** Consecutive unchanged comparisons; never an unknown. */
  readonly unchanged: number;
  /** The last comparable token, absent until one has been recorded. */
  readonly baseline?: string;
}

// ── The projection ──────────────────────────────────────────────────────────

/**
 * What one projection could read from the declared subject.
 *
 * A projection NEVER carries the raw payload: it carries a bounded token, or a
 * bounded marker naming why the value could not be compared.
 */
export type ProgressObservation =
  | {
      /** A comparable revision token, at most {@link PROGRESS_VALUE_MAX_LENGTH}. */
      readonly kind: "token";
      readonly value: string;
    }
  | {
      /** The value was present but longer than the bound; only its length is kept. */
      readonly kind: "truncated";
      readonly length: number;
    }
  | {
      /** The value was present but is not comparable; only its shape is kept. */
      readonly kind: "incomparable";
      readonly received: string;
    };

/**
 * One bounded, immutable measurement of a submission, bound to the exact
 * validation it was produced under.
 *
 * The binding is the acceptance core own validation binding — graph, attempt,
 * submission, plan revision and proposal digest — so the reducer can prove INSIDE
 * the transaction that this projection measures the very decision being
 * committed, and refuse one that belongs to another proposal, attempt or plan
 * revision.
 */
export interface ProgressProjection {
  /** The proposal/attempt/plan/validation this projection was produced under. */
  readonly binding: ValidationBinding;
  /** The declared loop group whose policy asked for it. */
  readonly loopGroupId: string;
  /** The comparison semantics, from the plan declaration. */
  readonly evaluator: string;
  /** The exact evaluator version, from the plan declaration. */
  readonly version: number;
  /** The comparison object, from the plan declaration. */
  readonly subject: string;
  /** The bounded measurement itself. */
  readonly observation: ProgressObservation;
}

/** Why a projection was refused before anything was written. Stable codes. */
export type ProgressProjectionRefusalCode =
  /**
   * The declared subject is absent from the outcome data. The field is REQUIRED
   * by the declared policy, so this is a repairable refusal, not an incomparable
   * observation.
   */
  | "progress-subject-missing"
  /** The plan declares an evaluator identity this build does not implement. */
  | "progress-evaluator-unavailable";

/** One structured refusal of a projection. */
export interface ProgressProjectionRefusal {
  readonly code: ProgressProjectionRefusalCode;
  readonly message: string;
  readonly path?: string;
}

/** What {@link projectProgress} answered. */
export type ProgressProjectionReading =
  | { readonly kind: "projected"; readonly projection: ProgressProjection }
  | {
      readonly kind: "refused";
      readonly refusals: readonly ProgressProjectionRefusal[];
    };

/** Inputs to {@link projectProgress}. */
export interface ProgressProjectionInput {
  /** The trusted binding this measurement belongs to. */
  readonly binding: ValidationBinding;
  /** The declared loop group whose policy asked for it. */
  readonly loopGroupId: string;
  /** The node whose outcome was submitted, for diagnostics. */
  readonly nodeId: string;
  /** The outcome that was submitted, for diagnostics. */
  readonly outcomeId: string;
  /** The plan declared policy: semantics, subject and threshold. */
  readonly policy: CompiledProgressPolicy;
  /** The worker-supplied payload, untrusted and never persisted. */
  readonly data: unknown;
}

/**
 * Measure one submission against one declared progress policy.
 *
 * TOTAL and pure: it reads the payload once, never writes, never throws and reads
 * no clock. A truncated observation is bounded to the value LENGTH and an
 * incomparable one to a shape description, so a hostile payload cannot make the
 * projection carry its own content.
 */
export function projectProgress(
  input: ProgressProjectionInput,
): ProgressProjectionReading {
  const { binding, loopGroupId, policy } = input;
  if (PROGRESS_EVALUATORS.find((known) => known === policy.evaluator) === undefined) {
    return {
      kind: "refused",
      refusals: [
        {
          code: "progress-evaluator-unavailable",
          path: "$.plan.loopGroups." + loopGroupId + ".progress.evaluator",
          message:
            "progress: loop group " + JSON.stringify(loopGroupId) +
            " declares evaluator " + JSON.stringify(policy.evaluator) +
            " at version " + policy.version + ", and this build implements " +
            describeEvaluators() +
            " — a comparison is never run under semantics the plan did not declare, " +
            "so nothing was written",
        },
      ],
    };
  }
  let present: boolean;
  let value: unknown;
  try {
    present =
      typeof input.data === "object" &&
      input.data !== null &&
      !Array.isArray(input.data) &&
      Object.prototype.hasOwnProperty.call(input.data, policy.subject);
    value = present
      ? (input.data as Record<string, unknown>)[policy.subject]
      : undefined;
  } catch (error) {
    // A property read that throws is not a comparable value; the acceptance core
    // refuses such a payload as unrepresentable, and this measurement says only
    // that it could not be compared.
    return {
      kind: "projected",
      projection: projectionOf(binding, loopGroupId, policy, {
        kind: "incomparable",
        received: "a property that could not be read (" + errorText(error) + ")",
      }),
    };
  }
  if (!present || value === undefined) {
    return {
      kind: "refused",
      refusals: [
        {
          code: "progress-subject-missing",
          path: "$.data." + policy.subject,
          message:
            "progress: loop group " + JSON.stringify(loopGroupId) +
            " declares progress subject " + JSON.stringify(policy.subject) +
            ", and outcome " + JSON.stringify(input.outcomeId) + " of node " +
            JSON.stringify(input.nodeId) + " did not carry it — the declared comparison " +
            "object is required, so the submission is refused for repair and nothing " +
            "was written",
        },
      ],
    };
  }
  return {
    kind: "projected",
    projection: projectionOf(binding, loopGroupId, policy, observe(value)),
  };
}

/** A human list of the evaluator identities this build implements. */
function describeEvaluators(): string {
  if (PROGRESS_EVALUATORS.length === 1) {
    return "only " + JSON.stringify(PROGRESS_EVALUATORS[0]);
  }
  return "[" + PROGRESS_EVALUATORS.map((id) => JSON.stringify(id)).join(", ") + "]";
}

/** Turn one present subject value into a bounded observation. */
function observe(value: unknown): ProgressObservation {
  if (typeof value !== "string") {
    return { kind: "incomparable", received: describeValue(value) };
  }
  if (value.length === 0) {
    return { kind: "incomparable", received: "an empty string" };
  }
  if (value.length > PROGRESS_VALUE_MAX_LENGTH) {
    return { kind: "truncated", length: value.length };
  }
  return { kind: "token", value };
}

/** Assemble one frozen projection. */
function projectionOf(
  binding: ValidationBinding,
  loopGroupId: string,
  policy: CompiledProgressPolicy,
  observation: ProgressObservation,
): ProgressProjection {
  return Object.freeze({
    binding: Object.freeze({ ...binding }),
    loopGroupId,
    evaluator: policy.evaluator,
    version: policy.version,
    subject: policy.subject,
    observation: Object.freeze(observation),
  });
}

// ── The comparison ──────────────────────────────────────────────────────────

/** The three-way answer one comparison produces. */
export type ProgressVerdict = "progressed" | "unchanged" | "unknown";

/**
 * Why a comparison answered unknown.
 *
 * Every member is a fact about the DATA, never a judgement about the work:
 * evaluator-identity-mismatch — the persisted baseline was recorded under another
 * evaluator identity or version (or another subject), so its value is not
 * comparable with this projection; truncated-value — the observation is longer
 * than the bound; incomparable-value — the subject was present but is not a
 * token.
 */
export type ProgressUnknownReason =
  | "evaluator-identity-mismatch"
  | "truncated-value"
  | "incomparable-value";

/**
 * One comparison, as reported to the caller.
 *
 * The unchanged count is the counter AFTER the comparison, the baseline the
 * persisted token after it, and stalled whether this comparison reached the
 * declared stagnation threshold — the explicit stopping policy the plan declares.
 */
export interface ProgressReport {
  readonly loopGroupId: string;
  readonly verdict: ProgressVerdict;
  /** Present exactly when the verdict is unknown. */
  readonly unknownReason?: ProgressUnknownReason;
  readonly evaluator: string;
  readonly version: number;
  readonly subject: string;
  readonly unchanged: number;
  readonly baseline?: string;
  readonly stalled: boolean;
}

/** What one comparison produced: the report and the entry to persist. */
export interface ProgressComparison {
  readonly report: ProgressReport;
  /** The progress record after the comparison (unchanged for an unknown). */
  readonly entry: OutcomeLoopProgress;
}

/** Inputs to {@link compareProgress}. */
export interface ProgressComparisonInput {
  /** The plan declared policy. */
  readonly policy: CompiledProgressPolicy;
  /** The persisted progress of this loop group, read inside the transaction. */
  readonly entry: OutcomeLoopProgress;
  /** The projection measured outside the transaction. */
  readonly projection: ProgressProjection;
}

/**
 * Compare one projection against the persisted baseline.
 *
 * PURE: the caller reads the entry inside the acceptance transaction and persists
 * the returned one in the same commit. The rules, in order:
 *
 * 1. IDENTITY — the entry evaluator, version and subject must be the projection
 *    ones. Any disagreement (in practice a baseline recorded under a different
 *    evaluator VERSION, since the reader ties identity and subject to the plan) is
 *    unknown: a change of comparison semantics is not evidence that the revision
 *    stood still, and it is never answered as unchanged or progressed. The entry
 *    is returned exactly as it was, so the baseline and the counters survive a
 *    restart rather than being silently reset;
 * 2. OBSERVATION — a truncated or incomparable observation is unknown, and the
 *    entry is returned exactly as it was (nothing is recorded that could be
 *    compared later);
 * 3. TOKEN — with no baseline recorded yet the comparison is progressed: the
 *    baseline is ESTABLISHED (there was no earlier value to stand still against,
 *    so the run has not been observed to repeat itself). With a baseline,
 *    equality is unchanged and inequality is progressed.
 *
 * Only unchanged increments the counter, so an unknown can never reach the
 * threshold: the soft stop is decided by repeated COMPARABLE repetition alone,
 * and the declared hard limits remain the run outer bound.
 */
export function compareProgress(
  input: ProgressComparisonInput,
): ProgressComparison {
  const { policy, entry, projection } = input;
  if (
    entry.evaluator !== projection.evaluator ||
    entry.version !== projection.version ||
    entry.subject !== projection.subject
  ) {
    return {
      report: reportOf(entry, "unknown", "evaluator-identity-mismatch", false),
      entry,
    };
  }
  if (projection.observation.kind === "truncated") {
    return { report: reportOf(entry, "unknown", "truncated-value", false), entry };
  }
  if (projection.observation.kind === "incomparable") {
    return { report: reportOf(entry, "unknown", "incomparable-value", false), entry };
  }
  const token = projection.observation.value;
  if (entry.baseline === undefined) {
    const established: OutcomeLoopProgress = Object.freeze({
      ...entry,
      unchanged: 0,
      baseline: token,
    });
    return {
      report: reportOf(established, "progressed", undefined, false),
      entry: established,
    };
  }
  if (entry.baseline === token) {
    const unchanged = entry.unchanged + 1;
    const stalled = unchanged >= policy.maxUnchanged;
    const same: OutcomeLoopProgress = Object.freeze({ ...entry, unchanged });
    return { report: reportOf(same, "unchanged", undefined, stalled), entry: same };
  }
  const progressed: OutcomeLoopProgress = Object.freeze({
    ...entry,
    unchanged: 0,
    baseline: token,
  });
  return {
    report: reportOf(progressed, "progressed", undefined, false),
    entry: progressed,
  };
}

/** Assemble one frozen report from the entry a comparison produced. */
function reportOf(
  entry: OutcomeLoopProgress,
  verdict: ProgressVerdict,
  unknownReason: ProgressUnknownReason | undefined,
  stalled: boolean,
): ProgressReport {
  return Object.freeze({
    loopGroupId: entry.loopGroupId,
    verdict,
    ...(unknownReason === undefined ? {} : { unknownReason }),
    evaluator: entry.evaluator,
    version: entry.version,
    subject: entry.subject,
    unchanged: entry.unchanged,
    ...(entry.baseline === undefined ? {} : { baseline: entry.baseline }),
    stalled,
  });
}

// ── Descriptions ────────────────────────────────────────────────────────────

/** Describe a rejected value for a diagnostic without ever throwing. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return typeof value;
}

/** The message of a caught value, without assuming it is an Error. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
