/**
 * Graph domain — the P1 field-ownership model
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * The ONE declaration of what each P1 domain object owns, who may write it, and
 * which existing durable record it replaces (P1 item 1). It exists so P1 item 3
 * can converge the three durable substrates — the v2 EngineState container, the
 * acceptance ledger and the host store — into ONE workspace-scoped database
 * without a second, unowned copy of any shape.
 *
 * RULES THIS MODULE ENCODES
 * - One definition per concept. A record that already exists and is CORRECT is
 *   ALIASED here (`CompiledPlan`, `NodeAttempt`, `Receipt`, `DispatchEffect`,
 *   `ExecutionBinding`) and never restated. Every reference is `import type`, so
 *   this module has no runtime dependency and any layer may import it.
 * - Every type names its existing counterpart under `Replaces:`, so a later node
 *   can tell a pure alias from a migration target.
 * - Nothing here imports either retired v2 type container — not even a type
 *   (P1 item 2's exit condition).
 *
 * WORKSPACE IS THE STORE'S SCOPE. §3.1 keeps one authoritative database per
 * workspace, so the workspace is not repeated on every row; a row cannot move
 * between stores without being re-addressed.
 *
 * KNOWN IDENTITY GAP (§3.2 vs the P0-frozen records). §3.2 requires every effect
 * and receipt to belong to a definite RUN/attempt, while today's ledger keys are
 * graph/attempt-qualified only (`ReceiptRecord`, `PendingEffectRecord`,
 * `HostDispatchExecution`) and a graph's state holds at most one run. The
 * aliases below keep those frozen shapes unchanged; the converged store must
 * RUN-QUALIFY those keys once a graph can have several runs. That decision
 * belongs to P1 item 3, and the aliases exist so no second copy appears before
 * it is taken.
 *
 * STATUS: declarations only — this module adds no runtime behavior.
 */

import type { GraphDeclarationV3 } from "../compiler/declaration-v3.ts";
import type { CompiledPlan as CompiledPlanRecord } from "../compiler/plan.ts";
import type { HostDispatchExecution } from "../host/execution-index.ts";
import type { PendingEffectRecord, ReceiptRecord } from "../ledger/types.ts";
import type { OutcomeGraphState, OutcomeNodeState } from "../outcome/graph-state.ts";
import type { HostInvocationIdentity } from "../outcome/host-identity.ts";

// ── Definition ──────────────────────────────────────────────────────────────

/**
 * The immutable definition of one logical graph.
 *
 * Owns: the logical graph identity (`graphId`), the validated declaration it was
 * compiled from, that declaration's canonical digest (the ADOPTION key: an
 * unchanged re-declaration is the same definition, a changed one is a new
 * revision), and the compiled plan that pins the effective contracts and
 * completion policies.
 * Writers: the declaration path only (`buildDeclaredOutcomeGraph`,
 * `src/graph/tools/declare-graph.ts`); the store commits the definition once and
 * no run, worker or query path rewrites it. A re-declaration with changed
 * content is a new definition, never an edit.
 * Replaces: `EngineState.graphDeclaration` + `EngineState.compiledPlan` +
 * `EngineState.planBinding` in the retired v2 engine container, today the only
 * durable copy and the carrier P1 item 5 stops writing, plus the `DeclaredOutcomeGraph`
 * carrier in `src/graph/tools/declare-graph.ts`. It also takes over the
 * DECLARING-PRINCIPAL attribution that `src/graph/host/invocation-origins.ts`
 * (`HostInvocationOrigin`) keeps today as a separate whole-file authority; that
 * attribution is PROVENANCE, not content, so it must not enter the definition's
 * content revision. `ReceiptRecord.planRevision` and
 * `GraphStateRecord.planRevision` remain the foreign keys that address a
 * definition.
 */
export interface GraphDefinition {
  /**
   * The logical graph id — the declaration's own name, because the v3 grammar
   * carries no separate identifier yet.
   */
  readonly graphId: string;
  /** The validated v3 declaration this definition was compiled from. */
  readonly declaration: GraphDeclarationV3;
  /** Content digest of the declaration — the adoption key. */
  readonly declarationDigest: string;
  /**
   * The immutable, content-addressed compiled plan; its own `planRevision`
   * names this exact content.
   */
  readonly plan: CompiledPlan;
}

/**
 * The immutable compiled plan — topology, outcome edges, terminal outcomes,
 * pinned contract and completion-policy snapshots, and executability: the
 * effective contract one definition revision executes.
 *
 * Owns: the compiled content addressed by `planRevision`. It is content, not
 * state: nothing in a run mutates it.
 * Writers: the compiler (`createCompiledPlan`, `src/graph/compiler/plan.ts`) at
 * declaration time; every other path only reads it.
 * Replaces: an ALIAS of the plan record the compiler already owns
 * (`CompiledPlan`) and of its durable projection `PersistedCompiledPlan` — no
 * shape is restated here. The durable record it replaces is
 * `EngineState.compiledPlan` / `EngineState.planBinding` in the v2 container.
 */
export type CompiledPlan = CompiledPlanRecord;

// ── Execution ───────────────────────────────────────────────────────────────

/**
 * One execution of one logical graph.
 *
 * Owns: run IDENTITY (`runId`, minted once per execution; a terminal graph
 * re-run mints a NEW one) on top of the run state the outcome reducer already
 * owns. It deliberately does not restate that state: the alias intersects
 * `OutcomeGraphState`, whose fields are the run phase, per-node progress, join
 * arrivals, loop traversals and progress, the stop record, and the state-body
 * version.
 * Writers: the run path mints `runId` (NEW in P1 item 3 — today a graph has a
 * single state row and no run identity); the reducer owns every other field and
 * commits the body inside the acceptance transaction (the ledger's
 * `runInTransaction` / `writeGraphState`). A load never writes.
 * Replaces: the ledger's `GraphStateRecord` (`src/graph/ledger/types.ts`), whose
 * `body` already IS this run state for an outcome-protocol graph — the record
 * gains the run identity §3.2 requires. The v2 container's `EngineState`
 * snapshot (phase, frontier, signal ledger, pending completions) is NOT replaced
 * by an equivalent; it is deleted with the container (§P1.5).
 */
export type GraphRun = OutcomeGraphState & {
  /** Identity of this execution; unique within the workspace's store. */
  readonly runId: string;
};

/**
 * One node's execution record inside a run.
 *
 * Owns: the node's CURRENT (or settling) attempt identity — `attemptId` and the
 * graph-wide `attemptSeq` that minted it — the DIGEST of the credential the
 * attempt's worker holds, the host invocation identity it was dispatched under,
 * the outcome that settled it, and the join ARRIVALS it is decided from. The
 * digest, never the credential value: a reader of the record must learn nothing
 * it could present.
 * Writers: the outcome reducer, at dispatch and at settlement, inside the
 * acceptance transaction. No worker writes this record.
 * Replaces: an ALIAS of `OutcomeNodeState` (`src/graph/outcome/graph-state.ts`),
 * the per-node entry the ledger's `GraphStateRecord.body` already carries — no
 * shape is restated. The record it replaces is the v2 `NodeRuntimeState`.
 * KNOWN GAP: this alias keeps only the current/settling attempt. §3.2 requires a
 * retry to be a NEW attempt with its own identity, and P3 owns that change; the
 * ledger's one-accepted-event-per-attempt rule is what makes two competing
 * terminal results impossible in the meantime.
 */
export type NodeAttempt = OutcomeNodeState;

// ── Accepted results and receipts ───────────────────────────────────────────

/**
 * The accepted business payload of one settled attempt.
 *
 * Owns: the bounded, schema-validated structured data (or immutable artifact
 * reference) an accepted outcome carried, addressed by the settlement key
 * (`graphId` + `attemptId`) and pinned to the plan revision it was accepted
 * under. It is DATA, never control: it cannot change routing, and a downstream
 * input is assembled from the compiled plan's fixed references, not from this
 * record's field names (§3.5).
 * Writers: the acceptance transaction only, as part of accepting a submission; a
 * rejected proposal stores nothing. Every other path reads. NO such record
 * exists today — the accepted payload is not yet durably stored, which is the
 * gap §P4.5 closes; this type declares the ownership, not an implemented writer.
 * Replaces: the retired v2 signal override slot — `SignalLedgerEntry.signals`
 * and `NodeRuntimeState.signalsObserved` — which §3.5 forbids as a routing
 * input. It does NOT replace the ledger's
 * `AcceptedEventRecord` (`src/graph/ledger/types.ts`): that row stays the
 * ROUTING identity of the acceptance, and this record carries only the payload
 * beside it. Like the event, at most one accepted result exists per attempt.
 */
export interface AcceptedResult {
  /** The graph the settled attempt belongs to. */
  readonly graphId: string;
  /** The settled attempt — the other half of the accepted-event key. */
  readonly attemptId: string;
  /** The plan revision this result was accepted under. */
  readonly planRevision: string;
  /**
   * The accepted data or an immutable artifact reference. Never a control hint,
   * never truncated into a smaller accepted value.
   */
  readonly payload: unknown;
}

/**
 * One committed decision for one logical submission.
 *
 * Owns: the terminal decision (`accepted` / `rejected`) over one submission,
 * the digest of the normalized proposal it was taken over, and the plan revision
 * the attempt is bound to. The triple (graphId, attemptId, submissionId) is the
 * idempotency key: same key + same digest replays the PERSISTED receipt, same
 * key + different digest is a conflict, and a distinct terminal submission for
 * an already-settled attempt is refused.
 * Writers: the acceptance transaction (`AcceptanceLedger.commitAccepted`) and
 * nothing else; a replay writes nothing.
 * Replaces: an ALIAS of the ledger's `ReceiptRecord`
 * (`src/graph/ledger/types.ts`) — the durable record itself, not a copy. See the
 * module header's identity gap: §3.2's run qualification is a store-level key
 * change, not a second receipt shape.
 */
export type Receipt = ReceiptRecord;

// ── Effects and host bindings ───────────────────────────────────────────────

/**
 * One durable intent to perform external work for an attempt — a dispatch
 * creation, a cancellation, any successor effect.
 *
 * Owns: a STABLE (graphId, effectId) identity (stable across processes, so a
 * crash-after-launch can be reconciled by effect id), the attempt it belongs to,
 * its kind, an opaque payload the store persists as JSON, and its status:
 * `pending` and `started` are UNSETTLED and are the resume set, while `done`
 * and `failed` are terminal and are never rewound.
 * Writers: the acceptance transaction writes the effect as the durable INTENT of
 * work the same transaction is about to authorize; the dispatch/recovery path is
 * the only writer of the status transitions, through the ledger's guarded
 * `markEffectStarted` / `markEffectDone` / `markEffectFailed`.
 * Replaces: an ALIAS of the ledger's `PendingEffectRecord`
 * (`src/graph/ledger/types.ts`) — the durable record itself, not a copy. The v2
 * container's implied dispatch state (`NodeRuntimeState.dispatchTaskId`, the
 * pending-completion and frontier containers) is deleted with the container, not
 * migrated (§P1.5).
 */
export type DispatchEffect = PendingEffectRecord;

/**
 * The host's BINDING of one dispatch effect to a real platform execution.
 *
 * Owns: which of the three create steps actually happened — `pending` (a create
 * right is held and NOTHING has been handed to the platform), `creating` (the
 * request was handed over and the result is UNKNOWN), `created` (the platform
 * confirmed it and named a real execution/task id) — plus the owning instance
 * (`ownerId`) and the claim/update timestamps. The primary key
 * (graphId, effectId) is the cross-instance uniqueness the create-once rule
 * needs, and the store's own CHECK makes `created` without an execution id
 * unrepresentable.
 * Writers: the host registry only — `HostExecutionIndex.claim` /
 * `markCreating` / `confirm` / `release`
 * (`src/graph/host/execution-index.ts`). A graph-side intent never writes a
 * host fact.
 * Replaces: an ALIAS of `HostDispatchExecution`, the typed view of the
 * `host_dispatch_executions` row of the workspace's ONE graph store
 * (`src/graph/store/schema.ts`), which P1 item 3 moved into the converged
 * database and P1 item 5 finished by deleting the retired host-store module. It does NOT own credentials: the
 * credential record is `host_attempt_credentials`
 * (`src/graph/host/credential-vault.ts`) and the attempt's credential DIGEST
 * belongs to `NodeAttempt`. It is also the durable record that must make the
 * in-process completion bindings of `src/graph/host/completion-bridge.ts`
 * redundant (A07, P2).
 */
export type ExecutionBinding = HostDispatchExecution;

// ── Trusted control ─────────────────────────────────────────────────────────

/**
 * The lifecycle/control commands a TRUSTED principal may apply to a run.
 *
 * None of these is a business outcome: failure, cancellation, timeout, retry, a
 * budget stop and an approval (a pause and the decision that answers it) are
 * decided by the trusted lifecycle path, and a worker cannot manufacture one by
 * submitting a payload (§3.4). The approval commands join this closed
 * vocabulary rather than getting a second table with its own permission rule:
 * §3.1 allows ONE trusted decision path, and an approval is a lifecycle fact
 * like the rest.
 */
export type ControlCommand =
  | "failure"
  | "cancel"
  | "timeout"
  | "retry"
  | "budget-stop"
  /**
   * Raise a durable approval request: the PAUSE on one node's in-flight attempt
   * (P3 item 3). Raised by the graph's declaring principal through the one
   * control entry, it names the ONLY session whose decision resolves it and the
   * deadline it expires at.
   */
  | "approval-request"
  /** Resolve a pending request in the affirmative; the only status that opens the gate. */
  | "approve"
  /** Resolve a pending request in the negative; a terminal refusal. */
  | "reject";

/**
 * One durable lifecycle/control decision.
 *
 * Owns: the record that one {@link ControlCommand} was applied to a definite run
 * and node (and attempt, when one exists), the reason, the decision time, and
 * the trusted invocation that decided when the host attributes one. A retry
 * decision is what mints the next attempt; a cancellation records the INTENT,
 * while the execution fact remains the {@link ExecutionBinding} it targets.
 * Writers: the control application service (P3) and ONLY it. A worker's
 * submission can never write one: control is not derived from a submitted
 * payload.
 * Replaces: nothing durable — there is no control record today. What it removes
 * is the v2 practice of inferring control from worker signal fields
 * (`NodeRuntimeState.signalsObserved`, `EngineState.pendingCompletions`),
 * which §3.4 forbids; those containers are deleted rather than migrated.
 */
export interface ControlDecision {
  readonly graphId: string;
  readonly runId: string;
  readonly nodeId: string;
  /** The attempt the command applies to, when the command names one. */
  readonly attemptId?: string;
  readonly command: ControlCommand;
  readonly reason: string;
  /** Epoch milliseconds, supplied by the caller. */
  readonly decidedAt: number;
  /** The trusted invocation that decided, when the host attributes one (D9). */
  readonly decidedBy?: HostInvocationIdentity;
}

/**
 * One durable human-approval request and its trusted decision.
 *
 * Owns: the paused node, run and ATTEMPT, the time the pause was raised, the
 * ONLY session whose decision resolves it, the deadline it expires at, and the
 * terminal decision — `approved`, `rejected` or `expired` — with the approver
 * identity, the decision time and the reason. A repeated approval or rejection
 * is a no-op on an already-decided request rather than a second decision, and
 * an expired request is never approved afterwards.
 * Writers: the trusted control path records `pending` when a pause is raised;
 * ONLY the request's NAMED approver may write a decision, and the expiry may
 * also be materialized by a deadline sweep. A worker's own `approved` field is
 * NOT an approval and never settles this record (§P3): this record is written
 * by the control service and read by the acceptance gate, and no field of a
 * submission is consulted by either.
 * Replaces: nothing — the v3 grammar declares no approval at all
 * (`NodeDeclarationV3` has no approval flag) and the v2 model treated a
 * synthetic human signal as approval (`SignalLedgerSource` `"approval"` in the
 * retired container). This is new surface P3 must implement; it deliberately
 * reuses the host invocation identity as the approver shape instead of inventing
 * a principal type.
 */
export interface ApprovalRequest {
  readonly graphId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly status: "pending" | "approved" | "rejected" | "expired";
  /** Why the pause was raised. Never overwritten by the decision. */
  readonly reason: string;
  /** Epoch milliseconds the pause was recorded at. */
  readonly requestedAt: number;
  /**
   * The trusted principal that RAISED the request, as the host attributed it.
   * Absent when the host attributed no invocation — absence is a fact, and it
   * never grants a decision right: {@link approverSessionId} is what does.
   */
  readonly requestedBy?: HostInvocationIdentity;
  /**
   * The ONE session whose decision resolves this request. The requester names
   * it, so the declaring principal's control authority does NOT imply approval
   * authority: a decision from any other session — including the declarer when
   * it named someone else — is refused by name.
   */
  readonly approverSessionId: string;
  /**
   * Epoch milliseconds this request stops being answerable at. The deadline is
   * part of the record because a pause with no deadline is a strand: expiry is
   * measured against THIS value and an explicit `at` input, never a clock read
   * inside the protocol.
   */
  readonly expiresAt: number;
  /** The approver that decided, present exactly when a principal decided it. */
  readonly decidedBy?: HostInvocationIdentity;
  /** Epoch milliseconds the decision was taken at, when decided. */
  readonly decidedAt?: number;
  /**
   * Why the request was approved, rejected or expired. Absent exactly when the
   * request is still `pending`.
   */
  readonly decisionReason?: string;
}
