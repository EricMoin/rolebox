import type {
  AcceptanceLedgerTx,
  EffectStatus,
  EffectTransition,
  PendingEffectRecord,
} from "../ledger/types.ts";
import type {
  OutcomeDispatchEffectKey,
  OutcomeDispatchInvocation,
  OutcomeExecutionIdentity,
} from "./dispatch-effects.ts";
// ── The durable cancel effect ───────────────────────────────────────────────

/**
 * The effect kind one attempt's platform cancellation is recorded under.
 *
 * A KIND, NOT A NAMING CONVENTION: the dispatch reconciliation and the boot sweep both skip every
 * effect whose kind is not `"dispatch"`, so a cancel effect can never be launched as a node and a
 * dispatch effect can never be read as a cancellation.
 */
export const CANCEL_EFFECT_KIND = "cancel";

/**
 * The effect id one attempt's cancel is recorded under.
 *
 * THE ONE SPELLING, derived from the attempt exactly as the dispatch effect id is, so the same
 * attempt always reaches the same row in every process and after every restart.
 */
export function cancelEffectIdOf(attemptId: string): string {
  return "cancel:" + attemptId;
}

/**
 * What one cancel effect records, as its opaque payload.
 *
 * Every field is PROVENANCE the host already holds — the graph, the node and attempt the trusted
 * decision named, why it was decided, when the host recorded it, and the platform's own execution
 * id when one could be named. No credential, no caller content: a cancel effect is bookkeeping a
 * recovery reads, not an authority anyone presents.
 */
export interface OutcomeCancelEffectTarget {
  readonly graphId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly reason: string;
  /** Epoch milliseconds the host recorded the intent at. */
  readonly requestedAt: number;
  /** The platform's own execution id, when the host could name one. */
  readonly executionId?: string;
  /** The platform's task id, when it names the task apart from the execution. */
  readonly taskId?: string;
}

// ── The platform port ───────────────────────────────────────────────────────

/**
 * What a platform answered about ONE execution's cancellation.
 *
 * A CLOSED three-way answer, and the difference between the first two is the whole point:
 *
 * - `confirmed` — the platform SUBSTANTIATED that this execution is cancelled. This is the only
 *   answer that may be reported as a cancellation, and the only one that writes `done`.
 * - `requested` — the cancel was handed to the platform and the platform cannot (or does not yet)
 *   confirm it. The execution stays visible and unsettled; nothing is reported as cancelled.
 * - `unsupported` — the platform offers no cancellation surface for this execution (no in-process
 *   handle, no addressable task, no queryable record). Nothing was substantiated; the execution
 *   stays visible.
 *
 * A port that cannot tell MUST answer `requested` or `unsupported`, never `confirmed`: an
 * unsubstantiated success is the one failure mode this contract exists to make unrepresentable.
 */
export type OutcomeExecutionCancelAnswer =
  | { readonly kind: "confirmed"; readonly reason: string }
  | { readonly kind: "requested"; readonly reason: string }
  | { readonly kind: "unsupported"; readonly reason: string };

/**
 * What one platform is asked to cancel, and everything it needs to find the execution.
 *
 * `effect` is the stable dispatch-effect identity of the attempt being cancelled (the same key the
 * create call carried, so a platform can correlate the cancel with the execution it created);
 * `execution` is the platform's OWN execution/task id when the host could name one — a platform that
 * has no id to address cannot cancel, and says so; `invocation` is the parent invocation the create
 * was composed under, for a platform whose control plane is scoped to a parent.
 */
export interface OutcomeExecutionCancelProbe {
  readonly effect: OutcomeDispatchEffectKey;
  readonly nodeId: string;
  readonly invocation?: OutcomeDispatchInvocation;
  readonly execution?: OutcomeExecutionIdentity;
  /** The trusted decision's reason, so the platform's own records carry why. */
  readonly reason: string;
}

/**
 * THE PLATFORM CANCEL PORT.
 *
 * One method, and it is ASYNCHRONOUS because every shipped platform cancel is: dsh disposes a run
 * handle, Pi awaits a dispatch-manager transition. It MUST be total — an execution it cannot cancel
 * answers `unsupported`, a control plane it cannot reach answers `requested` — and it must never
 * claim `confirmed` without the platform's own substantiation.
 */
export interface OutcomeExecutionCancellation {
  /** Ask the platform to cancel one execution. Never claims a fact it cannot substantiate. */
  cancel(probe: OutcomeExecutionCancelProbe): Promise<OutcomeExecutionCancelAnswer>;
}

// ── The durable state rules ─────────────────────────────────────────────────

/** What the durable cancel effect already said when a delivery reached it. */
export type OutcomeCancelRequestStep =
  /** The intent row was newly recorded (and, when handed over, moved to `started`). */
  | { readonly kind: "recorded" }
  /** The row was already `started`: requested before, still unconfirmed. */
  | { readonly kind: "already-requested" }
  /** The row is terminal `done`: the platform confirmed a previous request. */
  | { readonly kind: "already-confirmed" }
  /**
   * The row is terminal and is NOT `done` — a state this build never writes for a cancel. It is NOT
   * a confirmation; the delivery reports it by name.
   */
  | { readonly kind: "unexpected-terminal"; readonly status: EffectStatus };

/** One attempt's durable cancel intent, as the host records it. */
export interface OutcomeCancelIntentInput {
  readonly graphId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly reason: string;
  /** Epoch milliseconds, supplied by the caller: time is an explicit input. */
  readonly requestedAt: number;
  /** The platform's own execution, when the host could name one. */
  readonly execution?: OutcomeExecutionIdentity;
}

/** The effect record of one cancel intent, in the one shape both steps use. */
function cancelEffectOf(input: OutcomeCancelIntentInput): PendingEffectRecord {
  const target: OutcomeCancelEffectTarget = Object.freeze({
    graphId: input.graphId,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    reason: input.reason,
    requestedAt: input.requestedAt,
    ...(input.execution === undefined ? {} : { executionId: input.execution.executionId }),
    ...(input.execution?.taskId === undefined ? {} : { taskId: input.execution.taskId }),
  });
  return Object.freeze({
    graphId: input.graphId,
    effectId: cancelEffectIdOf(input.attemptId),
    attemptId: input.attemptId,
    kind: CANCEL_EFFECT_KIND,
    payload: target,
    createdAt: input.requestedAt,
    status: "pending" as const,
  });
}
/**
 * STEP 1 — record the durable cancel INTENT, and change nothing else.
 *
 * Committed BEFORE the platform is asked, so a process that dies inside the window between the
 * trusted decision and the host's platform call resumes with a `pending` cancel effect: the intent
 * is visible, the resume set names it, and the next host window hands it over. The write never
 * rewinds an existing row (`AcceptanceLedgerTx.writeEffect`): a repeat of a delivery that already
 * requested, confirmed or (impossibly) failed this attempt's cancel leaves that row exactly as it
 * stands.
 */
export function recordCancelIntent(
  tx: AcceptanceLedgerTx,
  input: OutcomeCancelIntentInput,
): PendingEffectRecord {
  const effect = cancelEffectOf(input);
  tx.writeEffect(effect);
  return effect;
}

/**
 * STEP 2 — move the intent to `started`: the host is handing this cancel to the platform now.
 *
 * This is the REQUEST transition and the state probe at once (see the module header): a row that is
 * `pending` moves to `started`; one that is already `started` is `unchanged` and reported
 * `already-requested`; a terminal row is `refused` and is read WITHOUT being rewritten.
 *
 * A `missing` verdict (nothing recorded the intent) is reported as `recorded` — the caller records
 * the intent in the same delivery, and reporting "already recorded" for a row that does not exist
 * would be the kind of claim this contract forbids. The caller's own write is what makes that true;
 * the state rules here never invent a row.
 */
export function markCancelRequested(
  tx: AcceptanceLedgerTx,
  graphId: string,
  attemptId: string,
): OutcomeCancelRequestStep {
  const verdict: EffectTransition = tx.markEffectStarted(graphId, cancelEffectIdOf(attemptId));
  switch (verdict.kind) {
    case "transitioned":
      return Object.freeze({ kind: "recorded" as const });
    case "unchanged":
      return Object.freeze({ kind: "already-requested" as const });
    case "refused":
      return verdict.effect.status === "done"
        ? Object.freeze({ kind: "already-confirmed" as const })
        : Object.freeze({
          kind: "unexpected-terminal" as const,
          status: verdict.effect.status,
        });
    case "missing":
      // The caller records the intent before it asks, so a caller that reached this step without one
      // has a store that lost the row between two statements of the same delivery. Treating it as
      // `recorded` keeps the delivery total and the platform ask honest: the platform is asked, and
      // only a confirmed answer can ever write done.
      return Object.freeze({ kind: "recorded" as const });
  }
}

/**
 * STEP 3 — record the platform's confirmation. THE ONLY WAY A CANCEL BECOMES `done`.
 *
 * Called exactly once per delivery, and only for an answer of kind `confirmed`. A row that is already
 * terminal is `refused` (never rewound to a different state) — a confirmation of a fact already
 * recorded is still the same fact. A `missing` verdict is a CONTRADICTION (step 1 always records the
 * intent first) and is returned as-is for the caller to report rather than hidden.
 */
export function confirmCancelIntent(
  tx: AcceptanceLedgerTx,
  graphId: string,
  attemptId: string,
): EffectTransition {
  return tx.markEffectDone(graphId, cancelEffectIdOf(attemptId));
}
