/**
 * Graph Execution Engine v2 — Durable acceptance ledger: record model and port
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The durable half of the outcome protocol's submission path
 * (docs/graph-outcome-protocol.md § "Submission and acceptance" and § "State,
 * storage, and effects"): the records an accepted submission commits, and the
 * PORT every substrate implements so the store stays swappable.
 *
 * What this module owns:
 * - `ReceiptRecord` — one committed decision per logical submission, keyed by
 *   `(graphId, attemptId, submissionId)`. That key is the idempotency key: the
 *   same key with the same normalized proposal returns the PERSISTED receipt,
 *   the same key with a different digest is a conflict, and a distinct terminal
 *   submission for an attempt that already settled is refused. All three rules
 *   are encoded in {@link CommitResult}.
 * - `AcceptedEventRecord` — the accepted-event stream, with AT MOST ONE event
 *   per `(graphId, attemptId)`: accepting a second terminal outcome for one
 *   execution is impossible by construction, not by convention.
 * - `PendingEffectRecord` — the effect ledger. Effects carry a STABLE id and a
 *   status, so a process that dies between the commit and the work can list
 *   what a previous process left `pending` or `started` and reconcile by id.
 *   Nothing in this module (or in the shipped store) EXECUTES an effect; it
 *   records one.
 *
 * {@link AcceptanceLedger} is the port. `ledgerFormatVersion` names the
 * durable layout the implementation writes, and every method is SYNCHRONOUS so
 * it can join a caller-supplied transaction. `runInTransaction` is the
 * documented EXTENSION POINT for the ONE atomic boundary the protocol requires
 * — acceptance receipt + accepted event + engine state change + pending effects
 * committed together — and it exposes the same write surface inside the
 * caller's transaction so the state write can join it when the reducer lands.
 * THE ENGINE STATE DOES NOT YET JOIN IT: no reducer exists, nothing routes into
 * this port, and the store writes only its own tables today.
 *
 * Timestamps are EPOCH MILLISECONDS supplied by the CALLER. Time is an explicit
 * input to the protocol (docs § "State, storage, and effects"), so the store
 * never reads a clock and a commit is reproducible from its batch alone.
 *
 * Dependency leaf: this module imports nothing (not even a type), so any
 * implementation, reducer or recovery module may depend on it without a cycle —
 * the same rationale as `storage-format.ts` / `execution-protocol.ts`.
 */

// ── Format identity ─────────────────────────────────────────────────────────

/**
 * The ledger layout this build writes.
 *
 * It is a named identity rather than a bare literal because the durable layout
 * is versioned independently of the records it holds: a store may only open a
 * file whose version row says EXACTLY this value, and an unknown, newer or
 * older version is refused rather than recreated or downgraded.
 */
export const LEDGER_FORMAT_VERSION = 1;

// ── Records ─────────────────────────────────────────────────────────────────

/**
 * One committed decision for one logical submission.
 *
 * The triple `(graphId, attemptId, submissionId)` is the submission's stable
 * idempotency key. `proposalDigest` is the digest of the normalized proposal
 * as the protocol computed it; a repeated key with the SAME digest is a replay,
 * with a DIFFERENT digest a conflict. `decision` is terminal for the
 * submission: a rejected proposal writes its receipt but does not enter the
 * accepted-event stream and does not settle the attempt.
 */
export interface ReceiptRecord {
  readonly graphId: string;
  readonly attemptId: string;
  readonly submissionId: string;
  /** The plan revision the attempt is bound to. */
  readonly planRevision: string;
  /** Digest of the normalized proposal this decision was taken over. */
  readonly proposalDigest: string;
  readonly decision: "accepted" | "rejected";
  /** Epoch milliseconds, supplied by the caller. */
  readonly committedAt: number;
}

/**
 * One accepted outcome, appended to the accepted-event stream.
 *
 * At most ONE event may exist per `(graphId, attemptId)`: settlement is
 * single-shot, so a later submission can never overwrite the accepted result.
 * A rejected decision produces no event at all.
 */
export interface AcceptedEventRecord {
  readonly graphId: string;
  readonly attemptId: string;
  readonly submissionId: string;
  readonly planRevision: string;
  /** The accepted outcome identifier the plan routes on. */
  readonly outcomeId: string;
  /** Epoch milliseconds, supplied by the caller. */
  readonly acceptedAt: number;
}

/**
 * The lifecycle status of one effect.
 *
 * `pending` and `started` are UNSETTLED — a restart lists both, because an
 * effect a dead process left `started` still needs reconciliation. `done` and
 * `failed` are TERMINAL: a settled effect is never listed for resume and is
 * never rewound.
 */
export type EffectStatus = "pending" | "started" | "done" | "failed";

/**
 * One durable effect, keyed by `(graphId, effectId)`.
 *
 * The id is STABLE across processes (docs § "State, storage, and effects":
 * dispatch creation must support lookup/reconciliation by effect ID across the
 * crash-after-launch window). `payload` is opaque to the store, which persists
 * its JSON projection so an effect written by one process is readable by the
 * next.
 */
export interface PendingEffectRecord {
  readonly graphId: string;
  readonly effectId: string;
  readonly attemptId: string;
  readonly kind: string;
  readonly payload: unknown;
  /** Epoch milliseconds, supplied by the caller. */
  readonly createdAt: number;
  readonly status: EffectStatus;
}

// ── Commit surface ──────────────────────────────────────────────────────────

/** The idempotency key of one logical submission. */
export interface SubmissionKey {
  readonly graphId: string;
  readonly attemptId: string;
  readonly submissionId: string;
}

/**
 * One atomic acceptance batch: the receipt, its accepted event, and the pending
 * effects the acceptance produces.
 *
 * `acceptedEvent` is REQUIRED for an `accepted` decision and FORBIDDEN for a
 * `rejected` one — a rejected proposal does not enter the accepted-event stream
 * or settle the attempt. Every effect enters the batch `pending`: a started or
 * terminal effect is a transition, not part of the acceptance commit.
 */
export interface AcceptanceBatch {
  readonly receipt: ReceiptRecord;
  readonly acceptedEvent?: AcceptedEventRecord;
  readonly effects?: readonly PendingEffectRecord[];
}

/**
 * The verdict of one `commitAccepted`, encoding the protocol's idempotency
 * rules verbatim:
 *
 * - `committed` — the submission key and the attempt were both unclaimed: the
 *   receipt, the accepted event and every pending effect were written in ONE
 *   transaction that has ALREADY committed when this verdict is returned.
 * - `replayed` — the SAME logical submission (`graphId + attemptId +
 *   submissionId`) with the SAME `proposalDigest`: nothing is written and the
 *   PERSISTED receipt is returned exactly as it was first committed.
 * - `conflict` — the same submission key with a DIFFERENT digest: nothing is
 *   written, and the key stays bound to the proposal already committed under
 *   it.
 * - `settled` — the attempt already has an accepted event and this is a
 *   distinct terminal submission: nothing is written and the accepted result
 *   is never overwritten. `reason` names the settlement.
 */
export type CommitResult =
  | { readonly kind: "committed"; readonly receipt: ReceiptRecord }
  | { readonly kind: "replayed"; readonly receipt: ReceiptRecord }
  | { readonly kind: "conflict"; readonly reason: string }
  | { readonly kind: "settled"; readonly reason: string };

/**
 * The verdict of one effect status transition.
 *
 * - `transitioned` — the row moved to the requested status.
 * - `unchanged` — the row already had that status; nothing was written.
 * - `refused` — the row is TERMINAL and the request would rewind it; nothing
 *   was written. A settled effect is never restarted — new work gets a new
 *   effect id.
 * - `missing` — no such effect in that graph; nothing was written.
 */
export type EffectTransition =
  | { readonly kind: "transitioned"; readonly effect: PendingEffectRecord }
  | { readonly kind: "unchanged"; readonly effect: PendingEffectRecord }
  | {
      readonly kind: "refused";
      readonly reason: string;
      readonly effect: PendingEffectRecord;
    }
  | { readonly kind: "missing"; readonly reason: string };

// ── Port ────────────────────────────────────────────────────────────────────

/**
 * The ledger's write surface, as seen INSIDE a transaction.
 *
 * A caller's `runInTransaction` callback receives this object instead of the
 * ledger itself, and it deliberately exposes every read and write the port
 * has — reads see the transaction's own uncommitted writes, and the engine
 * state write that lands with the reducer joins the same transaction through
 * this surface.
 */
export interface AcceptanceLedgerTx {
  /** Commit one batch atomically; see {@link CommitResult}. */
  commitAccepted(batch: AcceptanceBatch): CommitResult;
  /** The persisted receipt for a submission key, or `undefined`. */
  lookupReceipt(key: SubmissionKey): ReceiptRecord | undefined;
  /** Every accepted event of one graph, in accepted order. */
  acceptedEvents(graphId: string): readonly AcceptedEventRecord[];
  /**
   * The UNSETTLED effects of one graph — rows still `pending` or `started`.
   * Terminal effects are never listed; that stream IS the resume set.
   */
  pendingEffects(graphId: string): readonly PendingEffectRecord[];
  markEffectStarted(graphId: string, effectId: string): EffectTransition;
  markEffectDone(graphId: string, effectId: string): EffectTransition;
  markEffectFailed(graphId: string, effectId: string): EffectTransition;
}

/**
 * The durable acceptance ledger PORT.
 *
 * Implementations own a durable substrate and must provide:
 * - ATOMIC commit: every write of a batch commits together or not at all, and
 *   `committed` is never returned for an uncommitted batch.
 * - IDEMPOTENT replay, conflict and settlement rules exactly as
 *   {@link CommitResult} states them.
 * - RESTART SEMANTICS: a new instance over the same store sees the same rows,
 *   and `pendingEffects` answers what a previous process left unsettled.
 * - A FORMAT GATE: a store whose format version is unknown, newer or older —
 *   or that is not this ledger at all, down to the columns of its tables — is
 *   refused, never recreated or downgraded.
 * - A CLOSED ledger refuses further use with a clear error, and `close` is
 *   idempotent.
 */
export interface AcceptanceLedger extends AcceptanceLedgerTx {
  /** The ledger layout this implementation writes. */
  readonly ledgerFormatVersion: number;
  /**
   * Run `fn` inside ONE transaction and return its result after COMMIT.
   *
   * This is the protocol's single atomic boundary: the receipt, the accepted
   * event, the engine state change and the pending effects are meant to commit
   * together, and the callback receives the same write surface so the state
   * write can join. The callback MUST be synchronous — a callback that returns
   * a promise would run its writes outside the transaction — and a nested call
   * is refused rather than silently becoming a savepoint.
   *
   * THE ENGINE STATE DOES NOT YET JOIN THIS TRANSACTION. No reducer exists and
   * nothing routes into the ledger yet; today only the ledger's own tables are
   * written here. The seam is delivered so the reducer slice cannot inherit a
   * narrower boundary.
   */
  runInTransaction<R>(fn: (tx: AcceptanceLedgerTx) => R): R;
  /** Close the substrate. Idempotent; a closed ledger refuses further use. */
  close(): void;
}
