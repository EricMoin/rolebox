import type { GraphDeclarationV3 } from "../compiler/declaration-v3.ts";
import type { CompiledPlan as CompiledPlanRecord } from "../compiler/plan.ts";
import type { HostDispatchExecution } from "../host/execution-index.ts";
import type { PendingEffectRecord, ReceiptRecord } from "../ledger/types.ts";
import type { OutcomeGraphState, OutcomeNodeState } from "../outcome/graph-state.ts";
import type { HostInvocationIdentity } from "../outcome/host-identity.ts";

// ── Definition ──────────────────────────────────────────────────────────────

/** The immutable declaration and compiled plan of one logical graph. Declaration writes it once; runs only reference its content revision. */
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

/** The compiler-owned immutable plan, including topology and pinned outcome contracts. */
export type CompiledPlan = CompiledPlanRecord;

// ── Execution ───────────────────────────────────────────────────────────────

/** One execution of a graph, with its durable run identity and reducer state. */
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
/**
 * One artifact revision an acceptance RETAINED, named by its content.
 *
 * Structurally the artifact primitive's own `ArtifactEvidence`: the reference
 * the proposal declared (PROVENANCE, never resolved again), the content identity
 * `sha256:<hex>` the bytes are stored under, that digest, and the size.
 *
 * It is restated here so the domain model stays free of any store or validator
 * import while still owning the shape every writer and reader shares — the
 * compiler checks the two are structurally identical at every assignment.
 */
export interface AcceptedArtifact {
  readonly ref: string;
  readonly artifactId: string;
  readonly digest: string;
  readonly size: number;
}

/**
 * One value that round-trips through JSON without loss.
 *
 * It is declared HERE, once: this module is a dependency leaf and must not
 * import the host SDK's identically-named helper type (that package is a
 * transitive devDependency of the host adapters), so this is the project's own
 * single spelling of "a value JSON can carry" — the alternative is a second,
 * drifting one.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Whether an accepted result carried DATA, and what it carried.
 *
 * PRESENCE IS EXPLICIT (v7 of the store format). A submission that supplied no
 * `data` at all is `absent`; a submission that supplied JSON `null`, `{}` or
 * `""` is a `value`. The two are different accepted results, and a reader must
 * be able to tell them apart — the pre-v7 row stored the bare payload, so
 * "absent" and "null" were byte-identical and no reader could recover which one
 * had been accepted.
 */
export type AcceptedData =
  | { readonly kind: "absent" }
  | { readonly kind: "value"; readonly value: JsonValue };

export interface AcceptedResult {
  /** The graph the settled attempt belongs to. */
  readonly graphId: string;
  /** The settled attempt — the other half of the accepted-event key. */
  readonly attemptId: string;
  /** The plan revision this result was accepted under. */
  readonly planRevision: string;
  /**
   * The accepted data, with its presence made explicit ({@link AcceptedData}).
   * Never a control hint, never truncated into a smaller accepted value: a
   * payload beyond the store's accepted-data ceiling is REFUSED by name rather
   * than shortened.
   */
  readonly payload: AcceptedData;
  /**
   * The artifact revisions this acceptance RETAINED, in evidence-reference
   * order (P4 item 5 / A17).
   *
   * ABSENT means the acceptance retained none — a submission whose gates took
   * no artifact evidence, or a host with no artifact store. It never means
   * "resolve the path again": a consumer that needs a revision and finds none
   * REFUSES, because the path may name different bytes by then and this record
   * is the only thing that says which revision was accepted.
   */
  readonly artifacts?: readonly AcceptedArtifact[];
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

/** A trusted lifecycle decision targeting one run and node. Worker payloads cannot create control decisions. */
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
 * One durable principal-approval request and its trusted decision.
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
