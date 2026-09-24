import { errorText } from "../../utils/error-text.ts";
import { OutcomeRuntimeBudget } from "./runtime-budget.ts";
import { completionCapabilityRefusal, protocolCapabilityRefusal } from "./runtime-capabilities.ts";
import { describeValue, ledgerReadRefusal, readRuntimeClock, refused } from "./runtime-refusals.ts";
import type {
  AttemptReissueClaim,
  AttemptCredentialReissueFence,
  OutcomeRuntimeRefusal,
  OutcomeStartResult,
  OutcomeReexecutionResult,
  OutcomeSubmissionResult,
  OutcomeNaturalSettlementResult,
  OutcomeArmedNode,
  OutcomeReconciledReason,
  OutcomeReconciledEffect,
  OutcomeEffectDivergence,
  OutcomeResumeResult,
  OutcomeBudgetUsageReport,
  OutcomeBudgetReading,
  OutcomeBudgetUsageOutcome,
  OutcomeGraphRuntimeOptions,
  HostCompletionExecution,
  HostCompletionAuthority,
  HostCompletionFact,
} from "./runtime-contract.ts";
export type {
  AttemptReissueClaim,
  AttemptCredentialReissueFence,
  OutcomeRuntimeRefusalCode,
  OutcomeRuntimeRefusal,
  OutcomeStartResult,
  OutcomeReexecutionResult,
  OutcomeSubmissionResult,
  OutcomeNaturalSettlementResult,
  OutcomeArmedNode,
  OutcomeReconciledReason,
  OutcomeReconciledEffect,
  OutcomeEffectDivergence,
  OutcomeResumeResult,
  OutcomeAttemptUsage,
  OutcomeBudgetUsageReport,
  OutcomeBudgetUsageEntry,
  OutcomeBudgetNodeReport,
  OutcomeBudgetReport,
  OutcomeBudgetReading,
  OutcomeBudgetUsageOutcome,
  OutcomeGraphRuntimeOptions,
  HostCompletionExecution,
  HostCompletionAttemptRef,
  HostCompletionAuthority,
  HostCompletionFact,
} from "./runtime-contract.ts";

import type { CompiledNode, CompiledPlan } from "../compiler/plan.ts";
import type {
  AcceptanceLedger,
  AcceptanceLedgerTx,
  AcceptedResultEvidence,
  ApprovalRequestRecord,
  GraphStateRecord,
  PendingEffectRecord, RunControlRecord
} from "../ledger/types.ts";
import type { ExecutionProtocolRegistry } from "../protocol/execution-protocol.ts";
import {
  bindingOf,
  commitSubmission,
  validateSubmission,
  type AcceptanceDecision,
  type AcceptanceJoin,
  type AcceptanceJoinResult,
  type SubmissionRefusal, type SubmissionResult
} from "./acceptance.ts";
import {
  CURRENT_OUTCOME_STATE_BODY,
  OutcomeAdvanceRefusedError,
  OutcomeStateError,
  advanceOutcomeGraph,
  describeOutcomeStop,
  entryNodesOf,
  readOutcomeGraphState,
  stateRecordOf,
  type OutcomeAdvance,
  type OutcomeDispatchIntent,
  type OutcomeGraphPhase,
  type OutcomeGraphState,
  type OutcomeNodeState
} from "./graph-state.ts";
import {
  projectProgress,
  type OutcomeLoopProgress,
  type ProgressProjection
} from "./progress.ts";
import {
  RUNTIME_ATTEMPT_CREDENTIAL_SOURCE,
  attemptCredentialBinding,
  attemptCredentialDigest,
  isAttemptCredential,
  mintAttemptCredential,
  type AttemptCredentialSource,
} from "./attempt-credential.ts";
import {
  CREDENTIAL_ISOLATION_VERSION_V3,
  credentialIsolationRefusal,
  readCredentialIsolationStore,
  type CredentialIsolationCapability,
  type CredentialIsolationStore,
} from "./credential-isolation.ts";
import {
  hostIdentityCheckRefusal,
  hostIdentityRefusal,
  readCurrentHostIdentity,
  type HostIdentityCapability,
  type HostIdentityReading,
  type HostInvocationIdentity,
} from "./host-identity.ts";
import {
  blockingReexecutionEffectsOf,
  dispatchEffectIdOf,
  dispatchEffectKeyOf,
  normalizeOutcomeDispatch,
  type NormalizedOutcomeDispatch, type OutcomeDispatchEffectKey,
  type OutcomeDispatchRequest, type OutcomeDispatchTarget,
  type OutcomeExecutionLookup
} from "./dispatch-effects.ts";
import {
  type CompletionPolicyRef,
  type CompletionPolicyRegistry,
} from "../policy/completion-policy.ts";
import {
  assembleDownstreamInput,
  readResolvedInputs,
  type AcceptedResultFacts,
  type AcceptedResultReading,
  type DownstreamInputRefusal,
  type ResolvedInput,
} from "./inputs.ts";
import { proposalDigest, readOutcomeProposal } from "./proposal.ts";
import {
  naturalCompletionProposalOf,
  naturalCompletionSettlementOf,
  naturalCompletionSubmissionId,
  readNaturalCompletionDelivery
} from "./natural-completion.ts";
import type { ExecutionIdentity, ValidatorRegistry } from "./validators.ts";

// ── The dispatch seam ───────────────────────────────────────────────────────

/**
 * The dispatch-effect contract lives in `dispatch-effects.ts` (D8) and is
 * re-exported here so every existing import site keeps working: the target, the
 * request, the plain seam, and the host adapter that adds the one fact only the
 * host has — whether an execution for a stable effect id was already created.
 */
export type {
  OutcomeDispatchAdapter,
  OutcomeDispatchHost,
  OutcomeDispatchRequest,
  OutcomeDispatchSeam,
  OutcomeDispatchTarget,
  OutcomeExecutionLookup,
} from "./dispatch-effects.ts";

/**
 * Which trusted channel settles one attempt.
 *
 * A CLOSED, runtime-owned vocabulary. It is never read from a proposal or a
 * delivery: `submit` is the worker's claimed outcome, `settleNatural` is the
 * attempt's completion fact, and each entry point labels its own settlements.
 * The label reaches the durable record through the submission KEY (the natural
 * channel derives a `natural-completion:` key the ordinary ingress can never
 * mint), so a caller cannot claim the other channel's provenance.
 */
type SettlementSource = "submission" | "natural-completion";

/**
 * The run was refused because a dispatch could not be CLAIMED (P3 item 3).
 *
 * WHY A THROW AND NOT A VERDICT. It is raised from INSIDE the transaction that
 * arms an attempt — `start`'s first snapshot, `reexecute`'s successor run and
 * the acceptance that arms a successor node — so the whole transaction rolls
 * back: no attempt, no state change, no dispatch effect and no credential record
 * survives for a dispatch the budget did not authorize. The caller catches it
 * and answers with the SAME named refusal the store's verdict carries
 * (`budget-exhausted`), so a refusal at the claim and a refusal reported by the
 * store are indistinguishable to the caller.
 */
class DispatchBudgetExhaustedError extends Error {
  readonly refusal: OutcomeRuntimeRefusal;

  constructor(refusal: OutcomeRuntimeRefusal) {
    super(refusal.message);
    this.name = "DispatchBudgetExhaustedError";
    this.refusal = refusal;
  }
}

/**
 * A dispatch this transaction would have armed has an UNRESOLVABLE input, so the
 * transaction writes nothing at all (D6).
 *
 * WHY A THROW AND NOT A BLOCKED NODE. This is the FIRST-dispatch path: a run
 * whose entry node cannot be given what it declared has nothing to start from,
 * and committing a state that records an attempt nobody may run would be worse
 * than refusing the start. The caller catches it and answers with the named
 * refusals the assembly produced — one per offending input.
 *
 * On the SUCCESSOR path the same refusal does NOT throw: the acceptance is a
 * decision about the producing node and stands, while the successor is left
 * un-armed with its refusals recorded on its own state entry.
 */
class DispatchInputBlockedError extends Error {
  readonly refusals: readonly DownstreamInputRefusal[];

  constructor(refusals: readonly DownstreamInputRefusal[]) {
    super(
      "outcome-runtime: a dispatch was not armed because its declared inputs could " +
      "not be resolved (" +
      refusals.map((refusal) => refusal.code).join(", ") +
      ")",
    );
    this.name = "DispatchInputBlockedError";
    this.refusals = refusals;
  }
}

/** What the join reduced inside the acceptance transaction. */
interface JoinedReduction {
  readonly result: AcceptanceJoinResult;
  readonly advance?: OutcomeAdvance;
}

/**
 * The accepted result the acceptance transaction is committing RIGHT NOW, which
 * no read can see yet (D6).
 *
 * The successor's input assembly runs inside the same transaction as the
 * acceptance, BEFORE the batch that writes this result — so the one producer it
 * cannot read back is the attempt being settled, and the validation's retained
 * payload and revisions ARE that result. Overlaying them is what makes the
 * just-accepted result participate in the successor's binding in that same
 * transaction, instead of a later write filling the gap.
 */
interface JustAcceptedResult {
  readonly attemptId: string;
  readonly facts: AcceptedResultFacts;
}

/**
 * The run was STOPPED BY A TRUSTED CONTROL COMMAND while this submission was
 * between its two control checks (P3 item 1).
 *
 * WHY A THROW AND NOT A VERDICT. It is raised from INSIDE the acceptance
 * transaction, so it rolls the whole transaction back — the acceptance, the
 * graph state the join reduced and every host record the reducer's credential
 * mint wrote in the same boundary — leaving nothing that could be read as a
 * settlement of a controlled run. The caller catches it below and answers with
 * the SAME named refusal the pre-transaction check produces
 * ({@link OutcomeGraphRuntime.controlStopRefusal}: `control-stopped`), so a
 * command that commits before the gates and one that commits during them are
 * indistinguishable to the caller.
 */
class ControlStoppedError extends Error {
  readonly control: RunControlRecord;

  constructor(control: RunControlRecord) {
    super(
      "outcome-runtime: graph " +
      JSON.stringify(control.graphId) +
      " was stopped by the trusted control command " +
      JSON.stringify(control.command) +
      " while this settlement was in flight",
    );
    this.name = "ControlStoppedError";
    this.control = control;
  }
}

/**
 * The run path of one outcome-protocol graph.
 *
 * Construct it with the committed plan and the ledger, call {@link start} to
 * dispatch the plan's entry nodes, and hand each worker's outcome to
 * {@link submit}. The runtime is SYNCHRONOUS on purpose: the acceptance
 * transaction is a synchronous boundary, so the whole state transition happens
 * before the call returns, and the dispatch seam runs only after the commit.
 */
export class OutcomeGraphRuntime {
  /** The graph identity — the compiled plan's own `graphId`. */
  readonly graphId: string;
  /** The plan revision every receipt and state snapshot is bound to. */
  readonly planRevision: string;

  private readonly plan: CompiledPlan;
  private readonly ledger: AcceptanceLedger;
  private readonly dispatch: NormalizedOutcomeDispatch | undefined;
  /**
   * The host's create-right fence (plan §3.3). Absent means the mechanism is
   * not installed, and a re-issue refuses rather than running without it.
   */
  private readonly reissueFence: AttemptCredentialReissueFence | undefined;
  private readonly validators: ValidatorRegistry;
  private readonly artifactRoot: string;
  private readonly clock: () => number;
  private readonly protocols: ExecutionProtocolRegistry | undefined;
  private readonly mintCredential: AttemptCredentialSource;
  private readonly completionPolicies: CompletionPolicyRegistry | undefined;
  private readonly credentialIsolation: CredentialIsolationCapability | undefined;
  private readonly credentialStore: CredentialIsolationStore | undefined;
  private readonly hostIdentity: HostIdentityCapability | undefined;
  /**
   * The host's completion authority (P2 item 7): what substantiates a
   * completion fact that no worker bearer vouches for. Absent means the
   * host-completion channel is not enabled for this runtime, and it says so by
   * name instead of settling on the caller's word.
   */
  private readonly hostCompletions: HostCompletionAuthority | undefined;
  /**
   * The credential source the run path uses: the injected generator, wrapped so
   * that every credential it mints is ADOPTED BY THE HOST'S STORE before the
   * state recording its digest can be committed.
   *
   * WHY THE STORE SEES IT FIRST. The durable state keeps only the digest, so the
   * store is the only place the credential itself exists once this process is
   * gone. A credential the store never received would make its attempt
   * permanently un-deliverable — including in the commit-then-crash window D8
   * reconciles, where no create call ever ran. A store that throws therefore
   * fails the mint, and the transaction that would have recorded the attempt
   * writes nothing.
   *
   * BOTH CALLERS MINT INSIDE THEIR TRANSACTION. The start snapshot and the
   * acceptance advance reach this source from inside the store's single
   * boundary, and the host store's write joins the open transaction, so an
   * attempt the state records and the credential record a later submission is
   * checked against are one commit — a rolled-back start leaves neither.
   */
  private readonly credentialSource: AttemptCredentialSource;
  private readonly budget: OutcomeRuntimeBudget;

  constructor(options: OutcomeGraphRuntimeOptions) {
    this.plan = options.plan;
    this.graphId = options.plan.graphId;
    this.planRevision = options.plan.planRevision;
    this.ledger = options.ledger;
    this.dispatch = normalizeOutcomeDispatch(options.dispatch);
    this.reissueFence = options.reissueFence;
    this.validators = options.validators;
    this.artifactRoot = options.artifactRoot;
    this.clock = options.clock ?? (() => Date.now());
    this.protocols = options.protocols;
    this.mintCredential =
      options.mintCredential ?? RUNTIME_ATTEMPT_CREDENTIAL_SOURCE;
    this.completionPolicies = options.completionPolicies;
    this.credentialIsolation = options.credentialIsolation;
    this.credentialStore = readCredentialIsolationStore(options.credentialIsolation);
    this.credentialSource = (binding) => {
      const credential = mintAttemptCredential(this.mintCredential, binding);
      this.credentialStore?.remember(
        Object.freeze({
          graphId: binding.graphId,
          nodeId: binding.nodeId,
          attemptId: binding.attemptId,
        }),
        credential,
      );
      return credential;
    };
    this.hostIdentity = options.hostIdentity;
    this.hostCompletions = options.hostCompletions;
    this.budget = new OutcomeRuntimeBudget(this.plan, this.ledger, this.clock);
  }

  /**
   * Dispatch the plan's entry nodes and persist the starting state.
   *
   * IDEMPOTENT: a graph that already has a state snapshot is reported as
   * `already-started` and NOT re-dispatched — re-running an entry node would
   * overwrite the attempt a settled node's replay identity depends on.
   */
  start(now?: number): OutcomeStartResult {
    const at = readRuntimeClock(this.clock, now);
    if (typeof at !== "number") return refused([at]);
    const unavailable = this.executionCapabilityRefusal();
    if (unavailable !== undefined) return refused([unavailable]);
    // The identity of THIS invocation, read ONCE for the whole operation. A
    // `refused` reading is a host failure (a throwing `current()`, a malformed
    // answer) and refuses the operation: recording the attempts with no binding
    // under a host that declared one would drop the constraint silently.
    const hostIdentity = readCurrentHostIdentity(this.hostIdentity);
    if (hostIdentity.kind === "refused") return refused([hostIdentity.refusal]);
    const dispatchIdentity =
      hostIdentity.kind === "identified" ? hostIdentity.identity : undefined;
    const undispatchable = this.dispatchPreconditionRefusal();
    if (undispatchable !== undefined) return refused([undispatchable]);

    // A TRUSTED CONTROL COMMAND OUTRANKS STARTING (P3 item 1). A run that was
    // cancelled, failed or timed out is never begun again — not by a re-declare
    // whose id resolves to a stopped run, and not by a recovery window that
    // found the run row without a snapshot. The check runs before anything is
    // read as this plan's state and before anything is written, so the stop is
    // preserved exactly as it was recorded.
    const control = this.runControl();
    if (control !== undefined) return refused([this.controlStopRefusal(control)]);

    let existing: OutcomeGraphState | undefined;
    try {
      existing = this.state();
    } catch (error) {
      return refused([this.stateRefusal(error)]);
    }
    if (existing !== undefined) return { kind: "already-started", state: existing };

    const entries = entryNodesOf(this.plan);
    if (entries.length === 0) {
      return refused([
        {
          code: "no-entry-node",
          message:
            "outcome-runtime: plan revision " +
            this.planRevision +
            " declares no entry node — every node is the target of a non-loop edge, so " +
            "there is no node a run could start from",
        },
      ]);
    }

    // THE RUN IDENTITY the whole run is addressed by (P3 item 1). It is minted
    // HERE, inside the transaction that commits the first snapshot, so a run id
    // without the state it names is unrepresentable; `mintRun` keeps the
    // identity an earlier writer recorded, so two processes that raced this
    // graph's first execution agree on ONE run instead of each minting its own.
    // A graph that was RE-EXECUTED already holds runs, and `mintRun` then answers
    // the CURRENT one — the successor of a terminal run is minted exclusively by
    // `reexecute` (P3 item 2), never by a repeated start.
    const runId = runIdentityOf(this.graphId, at);
    // ONE transaction for the run identity, the starting snapshot, its dispatch
    // intents AND the credential record every armed attempt is settled with.
    // There is no acceptance to join yet; what must not come apart is the run
    // identity, the state that records the attempt, the effect that says the
    // attempt is to be started, and the credential the host store must hold for
    // it. The mint is synchronous and its store write joins this open boundary,
    // so a start that rolls back leaves no credential row for an attempt that
    // does not exist. The dispatch seam runs only after the commit, and what it
    // cannot deliver stays a durable, reconcilable row.
    let run: {
      readonly state: OutcomeGraphState;
      readonly dispatched: readonly OutcomeDispatchRequest[];
    };
    try {
      run = this.ledger.runInTransaction((tx) =>
        this.mintRunInTransaction(tx, at, {
          runId,
          // The identity the run's attempts are armed under (D9). Absent when the
          // host declared none: the absence IS the record, and no later process
          // back-fills one.
          dispatchIdentity,
          // A first run starts its graph-wide attempt counter at zero; a
          // re-execution continues it (P3 item 2), so attempt ids are unique for
          // the whole graph and a later run can never address an earlier run's
          // attempt.
          fromAttemptSeq: 0,
        }),
      );
    } catch (error) {
      // A dispatch the declared budget did not authorize rolls the WHOLE start
      // back — no run identity, no state, no effect, no credential — and is
      // answered the named refusal the store's claim produced.
      if (error instanceof DispatchBudgetExhaustedError) return refused([error.refusal]);
      // An ENTRY dispatch whose declared inputs cannot be resolved rolls the
      // whole start back the same way (D6): nothing is written, and the caller
      // is answered one named refusal per input that could not be resolved.
      if (error instanceof DispatchInputBlockedError) {
        return refused(error.refusals.map(inputRefusalOf));
      }
      throw error;
    }
    this.launchDispatches(run.dispatched);
    return { kind: "started", state: run.state, dispatched: run.dispatched };
  }

  /**
   * Mint one run's identity, starting snapshot, dispatch effects and attempt
   * credentials INSIDE the caller's transaction — the ONE implementation of
   * "a run begins here" (P3 items 1-2).
   *
   * WHY ONE IMPLEMENTATION. A first execution (`start`) and a re-execution
   * (`reexecute`) publish the same kinds of fact about a run — its identity, the
   * state that records which attempts are armed, one dispatch effect per armed
   * attempt, and a credential per attempt adopted by the host's store in the
   * SAME commit. Two copies of that loop could drift into two different notions
   * of "a run began", which is exactly the second-authority shape §3.1 forbids.
   * The differences are ARGUMENTS, not branches: the attempt counter continues
   * from {@link fromAttemptSeq} when a graph-wide counter already moved, and the
   * run identity is minted here for a first execution but already minted by
   * `mintNextRun` for a successor.
   *
   * THE RUN IDENTITY IS MINTED FIRST. Every state and effect row is filed under
   * the graph's CURRENT run by the store, and the run this call mints becomes
   * current in the same statement sequence, so the rows cannot be filed under
   * the run they supersede.
   */
  private mintRunInTransaction(
    tx: AcceptanceLedgerTx,
    at: number,
    input: {
      readonly runId: string;
      readonly dispatchIdentity: HostInvocationIdentity | undefined;
      readonly fromAttemptSeq: number;
    },
  ): { readonly state: OutcomeGraphState; readonly dispatched: readonly OutcomeDispatchRequest[] } {
    const entries = entryNodesOf(this.plan);
    // One progress entry per loop group whose plan declares a policy, so the
    // state's own record is complete from the first snapshot: a body that
    // carried entries only after the first continuation could not be told from
    // one whose baseline was lost. A group without a policy gets no entry.
    const loopProgress: Record<string, OutcomeLoopProgress> = {};
    for (const group of this.plan.loopGroups) {
      const policy = group.progress;
      if (policy === undefined) continue;
      loopProgress[group.id] = Object.freeze({
        loopGroupId: group.id,
        evaluator: policy.evaluator,
        version: policy.version,
        subject: policy.subject,
        unchanged: 0,
      });
    }
    // The run identity commits WITH the snapshot it names. A substrate with no
    // run/control surface holds no runs, and therefore no control records
    // either — nothing minted here, and the control entry refuses by name. For
    // a RE-EXECUTION the successor was already minted by `mintNextRun`, so this
    // call is the idempotent no-op that answers the run that is current.
    tx.runs?.mintRun({
      graphId: this.graphId,
      runId: input.runId,
      startedAt: at,
      planRevision: this.planRevision,
    });
    const entryIds = new Set(entries.map((node) => node.id));
    const nodes: OutcomeNodeState[] = [];
    const dispatched: OutcomeDispatchRequest[] = [];
    const effects: PendingEffectRecord[] = [];
    let attemptSeq = input.fromAttemptSeq;
    for (const node of this.plan.nodes) {
      if (!entryIds.has(node.id)) {
        // No node has settled yet, so every arrival list is empty — which is
        // exactly the canonical materialization of a state where nothing has
        // arrived, and what the reader verifies against.
        nodes.push(
          Object.freeze({
            nodeId: node.id,
            status: "pending" as const,
            arrivals: Object.freeze([]),
          }),
        );
        continue;
      }
      attemptSeq += 1;
      const attemptId = node.id + "#" + attemptSeq;
      // THE ENTRY DISPATCH IS BOUND BEFORE ANYTHING IS RECORDED (D6). An entry
      // node normally declares no inputs — but a plan may declare one whose
      // producer is reachable only through a loop's back edge, and at a start
      // NOTHING has settled, so such an input cannot resolve. The refusal aborts
      // the WHOLE start: a run whose entry node nobody may start has nothing to
      // begin from, and a state recording an attempt that was never bound would
      // be worse than no state at all.
      const entryInputs = assembleDownstreamInput(
        node.inputs ?? [],
        () => undefined,
        this.acceptedResultReaderIn(tx),
      );
      if (entryInputs.kind === "blocked") {
        throw new DispatchInputBlockedError(entryInputs.refusals);
      }
      // THE DISPATCH IS CLAIMED AGAINST THE DECLARED BUDGET BEFORE IT IS ARMED
      // (P3 item 3). The claim is a conditional row write inside THIS
      // transaction, so a node whose ceiling has no headroom aborts the whole
      // start: no attempt, no state, no effect and no credential is left behind
      // for a dispatch nothing authorized. An entry node with no declared
      // ceiling claims only the dispatch itself, which is the execution-count
      // usage fact.
      const unbudgetedDispatch = this.budget.reserveDispatchIn(
        tx,
        input.runId,
        node.id,
        attemptId,
        at,
      );
      if (unbudgetedDispatch !== undefined) {
        throw new DispatchBudgetExhaustedError(unbudgetedDispatch);
      }
      // The credential is minted WITH the attempt INSIDE this transaction:
      // the source adopts it in the host's store, whose write joins the
      // boundary this snapshot commits in. The binding a later submission is
      // checked against is therefore the state's — never a credential from
      // an attempt whose start rolled back.
      const credential = mintAttemptCredential(
        this.credentialSource,
        attemptCredentialBinding({
          graphId: this.graphId,
          nodeId: node.id,
          attemptId,
          planRevision: this.planRevision,
        }),
      );
      nodes.push(
        Object.freeze({
          nodeId: node.id,
          status: "dispatched" as const,
          attemptId,
          attemptSeq,
          attemptCredentialDigest: attemptCredentialDigest(credential),
          // The host attribution this attempt is bound to (D9). Absent when the
          // host declared no identity for this invocation — the absence IS the
          // record, and no later process back-fills one.
          ...(input.dispatchIdentity === undefined
            ? {}
            : { dispatchIdentity: input.dispatchIdentity }),
          dispatchedAt: at,
          arrivals: Object.freeze([]),
          // The input view this attempt was armed with (D6) — empty for the
          // ordinary entry node, and written down where it was decided.
          inputs: entryInputs.entries,
        }),
      );
      dispatched.push(
        this.dispatchRequestOf(
          node.id,
          attemptId,
          node.agent,
          node.prompt,
          entryInputs.entries,
          credential,
        ),
      );
      // THE INTENT IS PART OF THE SAME SNAPSHOT (D8). The effect names this
      // attempt under the stable id its host dedupes and looks up by, so a
      // process that dies between this commit and the create leaves a row a
      // recovery can reconcile instead of a state that merely looks armed.
      effects.push(
        Object.freeze({
          graphId: this.graphId,
          effectId: dispatchEffectIdOf(attemptId),
          attemptId,
          kind: "dispatch",
          payload: this.dispatchTargetOf(
            node.id,
            attemptId,
            node.agent,
            node.prompt,
            entryInputs.entries,
          ),
          createdAt: at,
          status: "pending" as const,
        }),
      );
    }
    const state: OutcomeGraphState = Object.freeze({
      bodyVersion: CURRENT_OUTCOME_STATE_BODY,
      graphId: this.graphId,
      planRevision: this.planRevision,
      phase: "executing" as const,
      nodes: Object.freeze(nodes),
      loopTraversals: Object.freeze({}),
      attemptSeq,
      loopProgress: Object.freeze(loopProgress),
    });
    // The store files the row under the graph's CURRENT run, resolved inside
    // this transaction: the run minted above for a first execution, or the
    // successor `mintNextRun` already recorded for a re-execution.
    tx.writeGraphState(stateRecordOf(state, at));
    for (const effect of effects) tx.writeEffect(effect);
    return Object.freeze({ state, dispatched: Object.freeze(dispatched) });
  }

  /**
   * RE-EXECUTE one terminal run as a NEW RUN (P3 item 2; plan §4 "终态图重新执行：
   * 创建新 run，保留旧 run 和回执；修改有效 plan 形成新 revision，不能改写旧 attempt
   * 的语义").
 */
  reexecute(now?: number): OutcomeReexecutionResult {
    const at = readRuntimeClock(this.clock, now);
    if (typeof at !== "number") return refused([at]);
    const unavailable = this.executionCapabilityRefusal();
    if (unavailable !== undefined) return refused([unavailable]);
    const hostIdentity = readCurrentHostIdentity(this.hostIdentity);
    if (hostIdentity.kind === "refused") return refused([hostIdentity.refusal]);
    const dispatchIdentity =
      hostIdentity.kind === "identified" ? hostIdentity.identity : undefined;
    const undispatchable = this.dispatchPreconditionRefusal();
    if (undispatchable !== undefined) return refused([undispatchable]);

    const runs = this.ledger.runs;
    if (runs === undefined) {
      return refused([
        {
          code: "reexecution-not-authorized",
          path: "$.graphId",
          message:
            "outcome-runtime: this substrate holds no run/control surface, so it can hold " +
            "neither a run identity nor the trusted order a re-execution requires — nothing " +
            "was re-executed",
        },
      ]);
    }
    const run = runs.readRun(this.graphId);
    if (run === undefined) {
      return refused([
        {
          code: "graph-not-started",
          path: "$.graphId",
          message:
            "outcome-runtime: graph " +
            JSON.stringify(this.graphId) +
            " holds no run identity, so there is no terminal run to re-execute",
        },
      ]);
    }
    const order = runs.readReexecution(this.graphId, run.runId);
    if (order === undefined) {
      return refused([
        {
          code: "reexecution-not-authorized",
          path: "$.runId",
          message:
            "outcome-runtime: run " +
            JSON.stringify(run.runId) +
            " of graph " +
            JSON.stringify(this.graphId) +
            " carries no trusted order to be re-executed, and a new run is a trusted " +
            "decision rather than a side effect of reading — apply the run-scoped " +
            "\"retry\" control command first, and nothing was re-executed",
        },
      ]);
    }
    if (order.successorRunId !== undefined) {
      return refused([
        {
          code: "reexecution-raced",
          path: "$.runId",
          message:
            "outcome-runtime: run " +
            JSON.stringify(run.runId) +
            " was already re-executed as run " +
            JSON.stringify(order.successorRunId) +
            " while this call saw it as current — nothing was written; re-read the graph to " +
            "address the run that stands",
        },
      ]);
    }

    let record: GraphStateRecord | undefined;
    try {
      record = this.ledger.readGraphState(this.graphId);
    } catch (error) {
      return refused([ledgerReadRefusal(this.graphId, error)]);
    }
    if (record === undefined) {
      return refused([
        {
          code: "unreadable-state",
          path: "$.graphId",
          message:
            "outcome-runtime: run " +
            JSON.stringify(run.runId) +
            " of graph " +
            JSON.stringify(this.graphId) +
            " holds no state snapshot, so neither its terminal position nor its attempt " +
            "counter can be established — nothing was re-executed",
        },
      ]);
    }
    const position = rawRunPositionOf(record.body);
    if (position === undefined) {
      return refused([
        {
          code: "unreadable-state",
          path: "$.body",
          message:
            "outcome-runtime: the state snapshot of run " +
            JSON.stringify(run.runId) +
            " does not carry a readable phase and attempt counter, so a successor run " +
            "cannot continue its attempt sequence without risking an attempt id collision " +
            "— nothing was re-executed",
        },
      ]);
    }
    // A snapshot THIS plan can verify is read fully, so the terminal check and
    // the blocking-effect check below use the state's own node entries; a
    // snapshot of ANOTHER revision is not this plan's state and is read
    // defensively instead (the plan a re-execution runs may be a new revision).
    let state: OutcomeGraphState | undefined;
    try {
      state = readOutcomeGraphState(record, this.plan);
    } catch {
      state = undefined;
    }
    const control = runs.readRunControlOf(this.graphId, run.runId);
    const terminal =
      control !== undefined || position.phase === "complete" || position.phase === "stopped";
    if (!terminal) {
      return refused([
        {
          code: "reexecution-not-terminal",
          path: "$.runId",
          message:
            "outcome-runtime: run " +
            JSON.stringify(run.runId) +
            " of graph " +
            JSON.stringify(this.graphId) +
            " is " +
            position.phase +
            " and carries no control fact, so it is still executing — re-executing the " +
            "graph would run nodes this run has not finished; a node-scoped \"retry\" is " +
            "the command for a live run, and nothing was re-executed",
        },
      ]);
    }

    let effects: readonly PendingEffectRecord[];
    try {
      effects = this.ledger.pendingEffects(this.graphId, run.runId);
    } catch (error) {
      return refused([ledgerReadRefusal(this.graphId, error)]);
    }
    let confirmedCancellations: readonly string[];
    try {
      confirmedCancellations = this.ledger.confirmedCancelAttempts(this.graphId, run.runId);
    } catch (error) {
      return refused([ledgerReadRefusal(this.graphId, error)]);
    }
    const blocking = blockingReexecutionEffectsOf(effects, {
      cancelled: new Set(confirmedCancellations),
      ...(state === undefined
        ? {}
        : {
          inFlight: new Set(
            state.nodes
              .filter((node) => node.status === "dispatched" && node.attemptId !== undefined)
              .map((node) => node.attemptId as string),
          ),
          settled: new Set(
            state.nodes
              .filter((node) => node.status === "settled" && node.attemptId !== undefined)
              .map((node) => node.attemptId as string),
          ),
        }),
    });
    if (blocking.length > 0) {
      return refused([
        {
          code: "reexecution-unsettled-effects",
          path: "$.runId",
          message:
            "outcome-runtime: run " +
            JSON.stringify(run.runId) +
            " of graph " +
            JSON.stringify(this.graphId) +
            " still owes external work whose fate is unknown — " +
            blocking
              .map(
                (effect) =>
                  effect.effectId +
                  " (attempt " +
                  effect.attemptId +
                  ", " +
                  effect.status +
                  ")",
              )
              .join(", ") +
            " — so re-executing the graph could run a side effect that is still live; a " +
            "platform-confirmed cancellation of those attempts clears them, and nothing " +
            "was re-executed",
        },
      ]);
    }

    const successorRunId = reexecutionRunIdentityOf(this.graphId, at, run.runSeq + 1);
    let started: { state: OutcomeGraphState; dispatched: readonly OutcomeDispatchRequest[] };
    try {
      started = this.ledger.runInTransaction((tx) => {
        const successor = tx.runs?.mintNextRun(
          {
            graphId: this.graphId,
            runId: successorRunId,
            startedAt: at,
            planRevision: this.planRevision,
          },
          run.runId,
        );
        if (successor === undefined) throw new ReexecutionRacedError("current-run-moved");
        const marked = tx.runs?.markReexecutionExecuted(
          this.graphId,
          run.runId,
          successorRunId,
          at,
        );
        if (marked !== true) throw new ReexecutionRacedError("order-already-consumed");
        return this.mintRunInTransaction(tx, at, {
          runId: successorRunId,
          dispatchIdentity,
          // THE ATTEMPT COUNTER CONTINUES (see the method doc): a successor run
          // can never mint an attempt id an earlier run already used, so the old
          // attempt's receipts and accepted events stay addressable and a stale
          // credential can never resolve to the successor's attempt.
          fromAttemptSeq: position.attemptSeq,
        });
      });
    } catch (error) {
      if (error instanceof ReexecutionRacedError) {
        return refused([
          {
            code: "reexecution-raced",
            path: "$.runId",
            message:
              "outcome-runtime: the re-execution of run " +
              JSON.stringify(run.runId) +
              " lost the race for the current run (" +
              error.message +
              ") — nothing was written and no run was minted; re-read the graph to address " +
              "the run that stands",
          },
        ]);
      }
      if (error instanceof OutcomeStateError) {
        return refused([this.stateRefusal(error)]);
      }
      // A successor run whose entry dispatch the declared budget did not
      // authorize rolls the whole mint back — run row, order link, state, effect
      // and credential — and is answered the named refusal.
      if (error instanceof DispatchBudgetExhaustedError) return refused([error.refusal]);
      // The same rule for an entry dispatch whose declared inputs cannot be
      // resolved (D6): the whole mint rolls back and the refusals are named, so
      // a re-executed run never begins on a hole.
      if (error instanceof DispatchInputBlockedError) {
        return refused(error.refusals.map(inputRefusalOf));
      }
      throw error;
    }
    this.launchDispatches(started.dispatched);
    const armed = armedReading(started.state);
    const unsettled = this.unsettledEffectReading();
    return {
      kind: "reexecuted",
      runId: successorRunId,
      runSeq: run.runSeq + 1,
      planRevision: this.planRevision,
      fromRunId: run.runId,
      state: started.state,
      dispatched: started.dispatched,
      // The inventory is read AFTER the launch, from the state the transaction
      // committed: a failed launch leaves its effect unsettled and still listed,
      // so nothing this report omits was silently dropped.
      armed: armed.armed,
      ...("code" in unsettled ? { unsettledEffects: Object.freeze([]) } : { unsettledEffects: unsettled }),
    };
  }

  /**
   * Submit one worker proposal and advance the graph on an accepted outcome.
   *
   * The execution identity is derived from the runtime's own context: the plan
   * names the graph, the state names the attempt, and the proposal's canonical
   * digest names the submission. A refusal or a rejected gate writes no state
   * change; an accepted outcome's state write, receipt, accepted event and
   * pending effects share ONE transaction.
   *
   * This is the WORKER-CLAIMED channel: the proposal is untrusted input and its
   * submission key is `submission:<digest>`. {@link settleNatural} is the
   * attempt-completion channel and shares every line below through
   * {@link settleSubmission} — there is deliberately no second settlement
   * implementation to drift from this one.
   *
   * `invocation` IS THE CALL'S OWN IDENTITY when the caller captured it. The
   * host capability it comes from is a mutable holder a host moves per tool
   * call, so a caller that awaits before settling must read it in its own
   * synchronous prologue and hand the reading here; the runtime then checks the
   * attempt's recorded identity against THAT reading instead of re-reading the
   * holder, which a concurrent call may have moved. Omitting it keeps the
   * ambient read for callers whose settlement runs inside their own capture
   * window (the host completion authority re-enters the delivery's identity for
   * exactly that reason).
   */
  submit(
    proposal: unknown,
    now?: number,
    invocation?: HostIdentityReading,
  ): OutcomeSubmissionResult {
    return this.settleSubmission(proposal, now, "submission", undefined, undefined, invocation);
  }

  /**
   * THE ONE SETTLEMENT PATH. Both entry points — a worker's claimed outcome
   * (`submit`) and an attempt's completion fact (`settleNatural`) — reach the
   * acceptance core here, so the attempt resolution, the run preconditions, the
   * declared acceptance gates, the join into the ONE acceptance transaction and
   * the ledger's replay rules are literally the same code.
   *
   * `source` labels the settlement for the SUBMISSION KEY only: the natural
   * channel derives `natural-completion:<digest>` where the ordinary ingress
   * derives `submission:<digest>`, which is how the persisted receipt and
   * accepted event say which channel committed (see
   * `natural-completion.ts`). It is runtime-owned, never proposal content.
   *
   * `expectedAttemptId` is the natural channel's additional cross-check: a
   * delivery NAMES the attempt it is about, and that name must agree with the
   * attempt the credential resolves to. The check runs HERE, against the same
   * state read that settles, so a delivery cannot be resolved against one state
   * and committed against another.
   */
  private settleSubmission(
    proposal: unknown,
    now: number | undefined,
    source: SettlementSource,
    expectedAttemptId?: string,
    /**
     * The host-authenticated execution, when this settlement arrives through the
     * HOST-COMPLETION channel ({@link settleHostCompletion}). Its presence is
     * what makes the identity resolution below accept the host's own durable
     * record INSTEAD of a bearer credential; it is never set for a proposal that
     * carries one.
     */
    hostCompletion?: HostCompletionExecution,
    /**
     * THE CALL'S OWN D9 IDENTITY, when the caller captured it before awaiting
     * (see {@link submit}). Omitted → the capability is read here, which is only
     * safe for a caller still inside its own capture window.
     */
    invocation?: HostIdentityReading,
  ): OutcomeSubmissionResult {
    const at = readRuntimeClock(this.clock, now);
    if (typeof at !== "number") return refused([at]);
    const unavailable = this.executionCapabilityRefusal();
    if (unavailable !== undefined) return refused([unavailable]);
    // THE CALL'S OWN READING WINS OVER THE AMBIENT ONE. A caller that captured
    // the identity synchronously passes it, so a concurrent call that moved the
    // host's shared holder cannot change what this submission is judged by.
    const hostIdentity = invocation ?? readCurrentHostIdentity(this.hostIdentity);
    if (hostIdentity.kind === "refused") return refused([hostIdentity.refusal]);
    const undispatchable = this.dispatchPreconditionRefusal();
    if (undispatchable !== undefined) return refused([undispatchable]);
    // A TRUSTED CONTROL COMMAND ENDS THE RUN (P3 item 1): a failure, a timeout
    // or a cancellation is a durable fact about the run, and no submission —
    // the worker's or the host's — advances a run it stopped. The check runs
    // BEFORE the state is read and before anything is written, so a late
    // settlement cannot resurrect an attempt control already ended, and the
    // refusal names the command, its reason and who decided it.
    //
    // IT IS NOT THE ONLY CHECK. The declared gates, the payload read and the
    // progress projection below all run OUTSIDE the acceptance transaction, so
    // a command that commits in that window would be followed by a business
    // success unless the SAME fact is re-read inside the transaction. It is:
    // see the join below, which refuses with the identical `control-stopped`
    // refusal and rolls the whole transaction back.
    const control = this.runControl();
    if (control !== undefined) return refused([this.controlStopRefusal(control)]);

    let record: GraphStateRecord | undefined;
    try {
      record = this.ledger.readGraphState(this.graphId);
    } catch (error) {
      return refused([ledgerReadRefusal(this.graphId, error)]);
    }
    if (record === undefined) {
      return refused([
        {
          code: "graph-not-started",
          path: "$.graphId",
          message:
            "outcome-runtime: graph " +
            JSON.stringify(this.graphId) +
            " has written no state snapshot, so it has no attempt for this submission to " +
            "belong to — call start() first",
        },
      ]);
    }
    let state: OutcomeGraphState;
    try {
      state = readOutcomeGraphState(record, this.plan);
    } catch (error) {
      return refused([this.stateRefusal(error)]);
    }

    const identity = this.identityFor(
      proposal,
      state,
      hostIdentity,
      source,
      expectedAttemptId,
      hostCompletion,
    );
    if ("refusal" in identity) return refused([identity.refusal]);
    // AN ATTEMPT PAUSED ON A TRUSTED APPROVAL CANNOT SETTLE (P3 item 3). The
    // durable request row is the ONLY source of this fact — no field of the
    // submission is read, so an `approved` flag inside the payload reaches
    // nothing. The check runs AFTER the attempt is resolved (the request is
    // keyed by attempt) and BEFORE the declared gates are evaluated, so a paused
    // attempt costs no validation work. It is NOT the guarantee: validation and
    // the progress projection run outside the acceptance transaction, so the
    // ledger's own guarded INSERT re-reads the same row inside it (verdict
    // `approval-blocked`) and whichever of a raising command and an acceptance
    // commits first is the fact that stands.
    const paused = this.ledger.approvals?.blockingApproval(this.graphId, identity.attemptId);
    if (paused !== undefined) return refused([approvalBlockRefusal(paused)]);

    const submission = {
      plan: this.plan,
      ledger: this.ledger,
      submittedPlanRevision: this.planRevision,
      identity,
      proposal,
      validators: this.validators,
      artifactRoot: this.artifactRoot,
      effects: [],
      now: at,
    };

    // VALIDATION RUNS OUTSIDE THE TRANSACTION, and so does the progress
    // PROJECTION. The gates and the payload read happen here, before the
    // serialized commit opens; what the transaction does is recheck the binding,
    // compare the projection against the baseline it can see, and write the
    // counters with the acceptance. A rejected decision is reported as the
    // gate's own rejection: the projection gate applies to an accepted outcome,
    // so a worker repairs the failing gate first and is told about the declared
    // comparison object on the submission that would otherwise settle.
    const validation = validateSubmission(submission);
    let projections: readonly ProgressProjection[] = Object.freeze([]);
    if (validation.kind === "validated" && validation.decision.kind === "accepted") {
      const projected = this.progressProjections(proposal, identity);
      if ("refusal" in projected) return refused([projected.refusal]);
      projections = projected;
    }

    // THE JUST-ACCEPTED RESULT IS AN INPUT OF THE SUCCESSOR'S BINDING (D6). It
    // is the validation's own retained payload and revisions — the values the
    // acceptance batch is about to write — so the successor's assembly sees
    // exactly what this commit makes durable, IN this commit, instead of a later
    // write filling the gap. Absent when the validation retained nothing, which
    // means no accepted result is written for this attempt at all: a consumer of
    // it is then blocked by name rather than handed a synthesized value.
    const justAccepted: JustAcceptedResult | undefined =
      validation.kind === "validated" &&
        validation.decision.kind === "accepted" &&
        validation.retained !== undefined
        ? {
          attemptId: validation.decision.identity.attemptId,
          facts: Object.freeze({
            outcomeId: validation.decision.outcomeId,
            payload: validation.retained.payload,
            artifacts: validation.retained.artifacts,
          }),
        }
        : undefined;

    let planned: OutcomeAdvance | undefined;
    const join: AcceptanceJoin = (tx, decision) => {
      // THE INVERSE RACE IS CLOSED HERE (P3 item 1, plan §3.4). The check above
      // ran before validation, and validation — the declared gates, the
      // artifact reads, a principal approval — happens OUTSIDE this transaction, so
      // a `failure`, `timeout` or `cancel` that commits during that window
      // would otherwise be followed by an accepted event, a receipt, a state
      // advance and the successor's dispatch effect: a business success forged
      // on top of a run a trusted command stopped. Re-reading the run's control
      // fact HERE — on the transaction's own view, through the same ledger port
      // — refuses it before `tx.commitAccepted` and before any successor can be
      // launched. The throw rolls the transaction back, so acceptance and
      // control can never both commit, and the caller is answered with the
      // named `control-stopped` refusal. This is the same rule the store
      // enforces structurally for every caller (`commitAccepted` answers
      // `controlled`); the join applies it where the run path can still name
      // the refusal and undo the reducer's own writes.
      const stopped = tx.runs?.readRunControl(this.graphId);
      if (stopped !== undefined) throw new ControlStoppedError(stopped);
      const joined = this.reduceInTransaction(
        tx,
        decision,
        at,
        projections,
        hostIdentity.kind === "identified" ? hostIdentity.identity : undefined,
        justAccepted,
      );
      planned = joined.advance;
      return joined.result;
    };

    let result: SubmissionResult;
    try {
      result = commitSubmission({ ...submission, validation }, join);
    } catch (error) {
      // A reducer rule violation rolls the transaction back and is reported as
      // the structured refusal it is. A storage failure is NOT swallowed: the
      // transaction has already rolled back, and the caller must see that the
      // state could not be stored rather than a benign-looking refusal.
      if (error instanceof ControlStoppedError) {
        return refused([this.controlStopRefusal(error.control)]);
      }
      if (error instanceof OutcomeAdvanceRefusedError) {
        return refused([{ code: error.code, message: error.message }]);
      }
      if (error instanceof OutcomeStateError) {
        return refused([this.stateRefusal(error)]);
      }
      // A successor the declared budget did not authorize (P3 item 3) rolls the
      // WHOLE acceptance back — receipt, accepted event, accepted result, state
      // advance and the successor's effect — and is answered the named refusal.
      if (error instanceof DispatchBudgetExhaustedError) return refused([error.refusal]);
      throw error;
    }

    if (result.kind === "refused") {
      return {
        kind: "refused",
        refusals: result.refusals.map(toRuntimeRefusal),
      };
    }
    const { decision: evaluated, verdict } = result;
    // The STORE refused the batch because the run is controlled (see
    // `LedgerTables.commitAccepted`). Reachable from here for a REJECTED
    // decision — the join above runs only for an accepted one — and for any
    // substrate that enforces the rule at the acceptance write itself. It is
    // answered exactly like the two checks that read the same fact first:
    // `control-stopped`, never a settlement.
    if (verdict.kind === "controlled") {
      return refused([this.controlStopRefusal(verdict.control)]);
    }
    // AN ATTEMPT PAUSED ON A TRUSTED APPROVAL ACCEPTS NOTHING (P3 item 3). The
    // ledger's own guard refused the batch because the attempt carries an
    // approval request whose status is not `approved` — or because a raising
    // command committed while this submission was being validated — so nothing
    // was accepted and the request is answered by name. This is the INVERSE half
    // of the rule the fast path below applies before validation: whichever of the
    // raising command and the acceptance COMMITS first is the fact that stands,
    // and no field of the submission is consulted either way.
    if (verdict.kind === "approval-blocked") {
      return refused([approvalBlockRefusal(verdict.request)]);
    }
    // A SUPERSEDED ATTEMPT ACCEPTS NOTHING (P3 item 2, the retry). The ledger's
    // own guard refused the batch because a trusted retry replaced this attempt
    // while the submission was being decided, so the attempt's result would
    // belong to an execution the node no longer holds. It is answered by name,
    // exactly like a control stop, and NEVER as a settlement: the successor
    // attempt carries the node forward, and the superseded attempt's receipt,
    // accepted event and decisions (if it had any) stay exactly as they were.
    if (verdict.kind === "superseded") {
      return refused([
        {
          code: "attempt-superseded",
          path: "$.attemptId",
          message:
            "outcome-runtime: attempt " +
            JSON.stringify(verdict.decision.attemptId) +
            " of node " +
            JSON.stringify(verdict.decision.nodeId) +
            " in graph " +
            JSON.stringify(this.graphId) +
            " was SUPERSEDED by the trusted retry decided at " +
            String(verdict.decision.decidedAt) +
            " (" +
            verdict.decision.reason +
            ") while this submission was being decided, so nothing was accepted: no " +
            "receipt, no accepted event, no state advance and no successor effect was " +
            "written for it — the successor attempt " +
            JSON.stringify(verdict.decision.successorAttemptId ?? "") +
            " carries the node forward",
        },
      ]);
    }
    // A CLOSED RUN ACCEPTS NOTHING (P3 item 2, the re-execution). The ledger's
    // own guard refused the batch because the attempt belongs to a run a
    // run-scoped retry already superseded: accepting it would write a new
    // terminal fact about a run whose receipts are the record of what it
    // accepted. Answered by name, exactly like a control stop, and NEVER as a
    // settlement.
    if (verdict.kind === "run-superseded") {
      return refused([
        {
          code: "run-superseded",
          path: "$.attemptId",
          message:
            "outcome-runtime: attempt " +
            JSON.stringify(evaluated.identity.attemptId) +
            " of graph " +
            JSON.stringify(this.graphId) +
            " belongs to run " +
            JSON.stringify(verdict.runId) +
            ", which the graph has SUPERSEDED with a later run, so nothing was accepted: no " +
            "receipt, no accepted event, no accepted result and no state advance was written " +
            "for it — re-read the graph to address the run that stands",
        },
      ]);
    }
    if (verdict.kind === "conflict" || verdict.kind === "settled") {
      return { kind: "not-committed", decision: evaluated, verdict };
    }
    // A REPLAY ANSWERS WITH THE PERSISTED DECISION, NEVER THIS CALL'S
    // EVALUATION. Validation runs outside the transaction, so a repeated
    // submission's gates are evaluated again; but a replay writes nothing, and
    // the receipt is the durable decision. Reporting the fresh evaluation would
    // claim a settlement the ledger does not hold — an acceptance for a
    // persisted rejection (no accepted event, no state advance, and the
    // content-addressed submission key can never be re-decided) or a rejection
    // for a settlement that did happen. The receipt's decision therefore
    // selects the result variant and `decision.kind`; `requirements` stays this
    // delivery's re-evaluation evidence, which nothing persisted.
    const decision: AcceptanceDecision =
      verdict.kind === "replayed" && verdict.receipt.decision !== evaluated.kind
        ? Object.freeze({ ...evaluated, kind: verdict.receipt.decision })
        : evaluated;
    if (decision.kind === "rejected") {
      return { kind: "rejected", decision, receipt: verdict.receipt };
    }

    const committed = verdict.kind === "committed";
    const dispatched =
      committed && planned !== undefined
        ? planned.dispatches.map((intent) => this.requestOf(intent))
        : [];
    // The PERSISTED state is what this answer carries. After a commit that is
    // the state the transaction just wrote, re-read below (a read failure must
    // not turn a committed acceptance into a thrown error, so the advance the
    // join computed is the fallback); after a replay it is the state the
    // settlement actually left behind — NEVER the advance the join computed,
    // which the transaction did not write.
    let persisted = committed && planned !== undefined ? planned.state : state;
    try {
      persisted = this.state() ?? persisted;
    } catch {
      // Keep the state the transaction wrote (a commit) or the state this call
      // read (a replay).
    }
    this.launchDispatches(dispatched);
    // The comparisons THIS call made. A replay re-runs none (the join is skipped
    // for an already-settled node) and writes nothing, so it reports none: the
    // persisted state is the authority, and a replay has already been reported.
    const progress = committed && planned !== undefined ? planned.progress : [];
    return {
      kind: "accepted",
      decision,
      receipt: verdict.receipt,
      state: persisted,
      dispatched: Object.freeze(dispatched),
      replayed: !committed,
      // The stop is reported from the state the transaction just committed (or,
      // for a replay, from the state it replayed against), never from a second
      // derivation: `state.stop` IS the durable stop.
      ...(persisted.stop === undefined ? {} : { stop: persisted.stop }),
      ...(progress.length === 0 ? {} : { progress }),
    };
  }

  /**
   * Settle one attempt from its COMPLETION FACT — the natural-completion entry
   * point the host's dispatch completion bridge calls.
 */
  settleNatural(delivery: unknown, now?: number): OutcomeNaturalSettlementResult {
    // The envelope is read FIRST because a malformed delivery is not a delivery:
    // an unknown key is refused by name before the plan, the capability or the
    // ledger is consulted.
    const reading = readNaturalCompletionDelivery(delivery);
    if (reading.kind === "malformed") {
      return refused(
        reading.issues.map((issue) => ({
          code: issue.code,
          path: issue.path,
          message: issue.message,
        })),
      );
    }
    const at = readRuntimeClock(this.clock, now);
    if (typeof at !== "number") return refused([at]);
    // The authorization is a PLAN-LEVEL fact, so the mapping is resolved before
    // any state is touched. An unauthorized node is refused here and can never
    // reach the settlement path at all.
    const authorization = this.naturalCompletionAuthorityOf(reading.delivery.nodeId);
    if ("refusal" in authorization) return refused([authorization.refusal]);
    const result = this.settleSubmission(
      naturalCompletionProposalOf({
        nodeId: reading.delivery.nodeId,
        outcomeId: authorization.outcome,
        credential: reading.delivery.credential,
      }),
      at,
      "natural-completion",
      reading.delivery.attemptId,
    );
    if (result.kind === "refused") return result;
    // The provenance record is derived from the canonical proposal digest the
    // decision was content-addressed by, so it names the very submission key the
    // receipt persists.
    const completion = naturalCompletionSettlementOf({
      nodeId: reading.delivery.nodeId,
      attemptId: reading.delivery.attemptId,
      outcomeId: authorization.outcome,
      proposalDigest: result.decision.proposalDigest,
      policy: authorization.policy,
    });
    switch (result.kind) {
      case "accepted":
        return { ...result, completion };
      case "rejected":
        return { ...result, completion };
      case "not-committed":
        return { ...result, completion };
    }
  }

  /**
   * Settle one attempt from a HOST-AUTHENTICATED completion fact (P2 items 6/7).
 */
  settleHostCompletion(delivery: unknown, now?: number): OutcomeNaturalSettlementResult {
    // The envelope is read first, exactly as the bearer channel reads its own:
    // a malformed completion fact is not a completion.
    const reading = readHostCompletionFact(delivery);
    if (reading.kind === "malformed") return refused(reading.issues);
    const fact = reading.fact;
    const at = readRuntimeClock(this.clock, now);
    if (typeof at !== "number") return refused([at]);
    const authority = this.hostCompletions;
    if (authority === undefined) {
      return refused([
        {
          code: "host-completion-unavailable",
          path: "$.hostCompletions",
          message:
            "outcome-runtime: a host completion fact for attempt " +
            JSON.stringify(fact.attemptId) +
            " of graph " +
            JSON.stringify(this.graphId) +
            " arrived through the host-completion channel, but this runtime holds no " +
            "host-completion authority: no durable execution record can corroborate the fact, " +
            "and a completion is never settled on the caller's word (plan §3.3). Nothing was " +
            "written; the host must inject the authority it can substantiate",
        },
      ]);
    }
    let execution: HostCompletionExecution | undefined;
    try {
      execution = authority.executionFor(
        Object.freeze({ graphId: this.graphId, attemptId: fact.attemptId }),
      );
    } catch (error) {
      // The authority was handed the attempt identity only — no credential is in
      // scope on this channel — so its own failure text is quotable.
      return refused([
        {
          code: "host-completion-unauthenticated",
          path: "$.executionId",
          message:
            "outcome-runtime: the host-completion authority threw while asked for the execution " +
            "of attempt " +
            JSON.stringify(fact.attemptId) +
            " of graph " +
            JSON.stringify(this.graphId) +
            " (" +
            errorText(error) +
            ") — an unanswered question is not an authenticated execution, so nothing was written",
        },
      ]);
    }
    if (execution === undefined) {
      return refused([
        {
          code: "host-completion-unauthenticated",
          path: "$.executionId",
          message:
            "outcome-runtime: the host holds no CONFIRMED execution for attempt " +
            JSON.stringify(fact.attemptId) +
            " of graph " +
            JSON.stringify(this.graphId) +
            ", so this completion has no host fact to authenticate against — a delivery " +
            "observation alone is not a completion and nothing was written",
        },
      ]);
    }
    if (execution.executionId !== fact.executionId) {
      return refused([
        {
          code: "host-completion-unauthenticated",
          path: "$.executionId",
          message:
            "outcome-runtime: the delivery names execution " +
            JSON.stringify(fact.executionId) +
            " for attempt " +
            JSON.stringify(fact.attemptId) +
            ", but the host's own record names " +
            JSON.stringify(execution.executionId) +
            " — a completion is never re-bound to whichever execution happens to exist",
        },
      ]);
    }
    // The authorization is a PLAN-LEVEL fact, resolved before the state is
    // touched, exactly as it is on the bearer channel: the host-completion
    // channel settles the same pinned mapping and never an outcome of its own.
    const authorization = this.naturalCompletionAuthorityOf(fact.nodeId);
    if ("refusal" in authorization) return refused([authorization.refusal]);
    const result = this.settleSubmission(
      naturalCompletionProposalOf({
        nodeId: fact.nodeId,
        outcomeId: authorization.outcome,
        credential: undefined,
      }),
      at,
      "natural-completion",
      fact.attemptId,
      execution,
    );
    if (result.kind === "refused") return result;
    // The provenance record names the very submission key the receipt persists,
    // derived from the canonical proposal digest the decision was addressed by.
    const completion = naturalCompletionSettlementOf({
      nodeId: fact.nodeId,
      attemptId: fact.attemptId,
      outcomeId: authorization.outcome,
      proposalDigest: result.decision.proposalDigest,
      policy: authorization.policy,
    });
    switch (result.kind) {
      case "accepted":
        return { ...result, completion };
      case "rejected":
        return { ...result, completion };
      case "not-committed":
        return { ...result, completion };
    }
  }

  /**
   * The natural-completion authorization the plan pinned for one node, or the
   * refusal that says why this node may not be settled by a completion fact.
   *
   * Three answers, one of which is a refusal by NAME — never a fallback:
   * - the plan declares no such node → `unknown-node`;
   * - the node is declared but its `completion` policy is not `natural`, or
   *   the plan pinned no authorization for it at all →
   *   `natural-completion-unauthorized`;
   * - the plan pinned an authorization whose outcome disagrees with the node's
   *   own declared mapping → `natural-completion-unauthorized` too: a plan that
   *   claims authority for an outcome the topology does not declare is refused
   *   rather than resolved in either direction.
   *
   * The outcome returned is the AUTHORIZATION's, never a caller's, which is what
   * makes "one attempt maps to exactly one outcome" structural.
   */
  private naturalCompletionAuthorityOf(
    nodeId: string,
  ):
    | { readonly outcome: string; readonly policy: CompletionPolicyRef }
    | { readonly refusal: OutcomeRuntimeRefusal } {
    const node = this.plan.nodes.find((entry) => entry.id === nodeId);
    if (node === undefined) {
      return {
        refusal: {
          code: "unknown-node",
          path: "$.nodeId",
          message:
            "outcome-runtime: node " +
            JSON.stringify(nodeId) +
            " is not declared by plan revision " +
            this.planRevision +
            " — a natural completion can only settle a node the compiled plan declares",
        },
      };
    }
    const authorization = (this.plan.completionAuthorizations ?? []).find(
      (entry) => entry.nodeId === nodeId,
    );
    const declared = node.completion;
    if (authorization === undefined || declared?.mode !== "natural") {
      return {
        refusal: {
          code: "natural-completion-unauthorized",
          path: "$.nodeId",
          message:
            "outcome-runtime: node " +
            JSON.stringify(nodeId) +
            " declares " +
            (declared === undefined
              ? "no completion policy"
              : declared.mode === "natural"
                ? "natural completion of outcome " + JSON.stringify(declared.outcome)
                : "explicit completion") +
            " and plan revision " +
            this.planRevision +
            " pins no natural-completion authorization for it — a completion fact is never " +
            "re-interpreted as an explicit submission and the completion policy is never " +
            "ignored, so nothing was settled",
        },
      };
    }
    if (declared.outcome !== authorization.outcome) {
      return {
        refusal: {
          code: "natural-completion-unauthorized",
          path: "$.nodeId",
          message:
            "outcome-runtime: node " +
            JSON.stringify(nodeId) +
            " declares natural completion of outcome " +
            JSON.stringify(declared.outcome) +
            ", but plan revision " +
            this.planRevision +
            " pins an authorization for outcome " +
            JSON.stringify(authorization.outcome) +
            " — the pinned mapping and the topology disagree, and neither is resolved in the " +
            "other's favour",
        },
      };
    }
    return { outcome: authorization.outcome, policy: authorization.policy };
  }

  /**
   * Continue this graph from its PERSISTED state — the restart-recovery entry
   * point (C3c).
 */
  resume(now?: number): OutcomeResumeResult {
    const at = readRuntimeClock(this.clock, now);
    if (typeof at !== "number") return refused([at]);
    const unavailable = this.executionCapabilityRefusal();
    if (unavailable !== undefined) return refused([unavailable]);
    const undispatchable = this.dispatchPreconditionRefusal();
    if (undispatchable !== undefined) return refused([undispatchable]);

    let record: GraphStateRecord | undefined;
    try {
      record = this.ledger.readGraphState(this.graphId);
    } catch (error) {
      return refused([ledgerReadRefusal(this.graphId, error)]);
    }

    if (record === undefined) {
      // FIRST EXECUTION. No state has ever been written for this graph, so the
      // run begins from the SAVED plan — the same plan a later recovery reads
      // back and continues (the review's D5), not a second interpretation of
      // it. A concurrent process that started the graph between the read above
      // and this write makes start() answer `already-started`; that state is
      // then resumed below instead of being reported as a fresh start.
      const started = this.start(at);
      if (started.kind === "refused") return started;
      if (started.kind === "started") {
        const effects = this.unsettledEffectReading();
        if ("code" in effects) return refused([effects]);
        const reading = armedReading(started.state);
        return {
          kind: "started",
          state: started.state,
          dispatched: started.dispatched,
          // A first execution resolved no crash window: every launch it made is
          // reported in `dispatched`, and the effects it just wrote are the
          // same launches.
          reconciled: Object.freeze([]),
          // Nothing to diverge from either: a first execution has no earlier
          // local record and no host fact about one.
          divergences: Object.freeze([]),
          armed: reading.armed,
          unsettledEffects: effects,
          refusals: reading.refusals,
        };
      }
      try {
        record = this.ledger.readGraphState(this.graphId);
      } catch (error) {
        return refused([ledgerReadRefusal(this.graphId, error)]);
      }
      if (record === undefined) {
        return refused([
          {
            code: "unreadable-state",
            message:
              "outcome-runtime: graph " +
              JSON.stringify(this.graphId) +
              " was reported already started, but the ledger holds no state snapshot for it — " +
              "refusing to guess which state to continue",
          },
        ]);
      }
    }

    // The state belongs to THIS graph before it is read as this plan's state:
    // a record for another graph is a different, nameable disagreement than a
    // record bound to another revision of this one.
    if (record.graphId !== this.graphId) {
      return refused([
        {
          code: "graph-mismatch",
          path: "$.graphId",
          message:
            "outcome-runtime: the persisted state of " +
            JSON.stringify(record.graphId) +
            " was read for graph " +
            JSON.stringify(this.graphId) +
            " — the state names a different graph, so nothing was resumed",
        },
      ]);
    }

    let state: OutcomeGraphState;
    try {
      state = readOutcomeGraphState(record, this.plan);
    } catch (error) {
      return refused([this.stateRefusal(error)]);
    }

    // A RUN A TRUSTED CONTROL COMMAND STOPPED IS REPORTED, NOT CONTINUED (P3
    // item 1). It is the same rule as the declared stop below, one level up:
    // a cancelled, failed or timed-out run launches nothing, arms nothing and
    // reconciles nothing, so a second resume (and every boot sweep after it)
    // reports the SAME control fact and clears nothing. The attempts the stop
    // left in flight are NOT armed — no submission can settle them — and they
    // are named in `refusals`, with their effects still in `unsettledEffects`:
    // an external execution whose fate this process cannot confirm stays
    // VISIBLE instead of being hidden to make the stop look converged.
    const control = this.runControl();
    if (control !== undefined) {
      const stopped = this.unsettledEffectReading();
      if ("code" in stopped) return refused([stopped]);
      return {
        kind: "resumed",
        state,
        dispatched: Object.freeze([]),
        reconciled: Object.freeze([]),
        divergences: Object.freeze([]),
        armed: Object.freeze([]),
        unsettledEffects: stopped,
        refusals: Object.freeze([
          ...controlledInFlightRefusals(state, control),
          ...(state.stop === undefined ? [] : stoppedInFlightRefusals(state)),
        ]),
        ...(state.stop === undefined ? {} : { stop: state.stop }),
        control,
      };
    }

    // A STOPPED RUN IS REPORTED, NOT CONTINUED. Nothing is launched — not even a
    // `pending` effect the crash window left behind — and nothing is offered as
    // armed, because no submission can settle anything once the run has stopped.
    // Reading and reporting are the only things this call does, so a second
    // resume reports the same stop and dispatches nothing (the `started` effect
    // bookkeeping below is what would otherwise move a row).
    if (state.stop !== undefined) {
      const effects = this.unsettledEffectReading();
      if ("code" in effects) return refused([effects]);
      return {
        kind: "resumed",
        state,
        dispatched: Object.freeze([]),
        // A stopped run reconciles nothing: resolving an effect could only
        // report a launch or a question, and no launch is permitted here — so
        // it asks the host nothing and reports no divergence either.
        reconciled: Object.freeze([]),
        divergences: Object.freeze([]),
        armed: Object.freeze([]),
        unsettledEffects: effects,
        refusals: stoppedInFlightRefusals(state),
        stop: state.stop,
      };
    }

    const resolved = this.reconcileUnsettledDispatches(state, at);
    if ("refusal" in resolved) return refused([resolved.refusal]);
    const effects = this.unsettledEffectReading();
    if ("code" in effects) return refused([effects]);
    // A RE-ISSUE REWROTE THE STATE, so the report carries the state that is
    // actually stored now: the pre-reconcile read differs from it in the
    // re-issued attempt's credential digest and in the record's timestamp, and
    // reporting the stale read would describe a state no reader can find. The
    // re-read cannot fail the resume — a failed read keeps the state this call
    // already reconciled and reported.
    let reported = state;
    if (resolved.reissued) {
      try {
        reported = this.state() ?? state;
      } catch {
        reported = state;
      }
    }
    // The armed report is credential-free by construction; an in-flight attempt
    // the state cannot corroborate with a credential is reported as refused.
    const readable = armedReading(reported);
    return {
      kind: "resumed",
      state: reported,
      dispatched: Object.freeze(resolved.launched),
      reconciled: resolved.reconciled,
      divergences: resolved.divergences,
      armed: readable.armed,
      unsettledEffects: effects,
      refusals: Object.freeze([...resolved.refusals, ...readable.refusals]),
    };
  }

  /**
   * The persisted state of this graph, or `undefined` when it never started.
   *
   * Throws an {@link OutcomeStateError} for a snapshot this build cannot read —
   * a state that cannot be read is never silently replaced by a fresh one.
   */
  state(): OutcomeGraphState | undefined {
    const record = this.ledger.readGraphState(this.graphId);
    if (record === undefined) return undefined;
    return readOutcomeGraphState(record, this.plan);
  }

  /**
   * The TRUSTED CONTROL FACT of this graph's run, or `undefined` (P3 item 1).
   *
   * READ THROUGH THE PORT THIS RUNTIME ALREADY HOLDS. The control record lives
   * in the SAME store as the run state — one file, one schema, one transaction
   * boundary — so the run path can ask about it without a second authority, a
   * second connection or a second capability to keep in sync with the store it
   * commits through.
   *
   * A SUBSTRATE WITHOUT THE SURFACE REPORTS NO CONTROL, and that is correct
   * rather than lenient: a ledger that cannot hold a control decision cannot
   * have one, so there is no stop to report. The control ENTRY is the other
   * half of that rule — it refuses by name when it has no surface to record a
   * command in, because a command nobody can record must never look applied.
   *
   * A READ THAT THROWS IS NOT SWALLOWED as "no control": the closed store and
   * the malformed row throw, and the callers let the error answer rather than
   * run a graph whose stop could not be read.
   */
  private runControl(): RunControlRecord | undefined {
    const runs = this.ledger.runs;
    if (runs === undefined) return undefined;
    return runs.readRunControl(this.graphId);
  }

  /**
   * The structured refusal every step of a CONTROLLED run answers with.
   *
   * ONE code, `control-stopped`, for every command: the caller's repair is the
   * same in all three cases (the run is over; a new run is a new identity), and
   * the command, the reason and the deciding principal are carried in the
   * message so the refusal says WHICH trusted command ended it. The code is
   * never a business outcome and never a settlement.
   */
  private controlStopRefusal(control: RunControlRecord): OutcomeRuntimeRefusal {
    return {
      code: "control-stopped",
      path: "$.graphId",
      message:
        "outcome-runtime: graph " +
        JSON.stringify(this.graphId) +
        " was STOPPED by the trusted control command " +
        JSON.stringify(control.command) +
        " (reason: " +
        control.reason +
        ", decided at " +
        String(control.decidedAt) +
        (control.decidedBy === undefined
          ? ""
          : ", decided by session " + JSON.stringify(control.decidedBy.sessionId)) +
        ") — a controlled run dispatches nothing, arms nothing and settles nothing, so " +
        "this operation is refused and no state is written; the attempts the stop left in " +
        "flight stay exactly as they are and are reported",
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private executionCapabilityRefusal(): OutcomeRuntimeRefusal | undefined {
    return protocolCapabilityRefusal(this.protocols)
      ?? credentialIsolationRefusal(this.credentialIsolation)
      ?? hostIdentityRefusal(this.hostIdentity);
  }

  private dispatchPreconditionRefusal(): OutcomeRuntimeRefusal | undefined {
    return this.dispatchCapabilityRefusal()
      ?? completionCapabilityRefusal(this.plan, this.completionPolicies)
      ?? this.budget.capabilityRefusal();
  }

  /**
   * Check that this runtime holds a dispatch adapter at all (D8).
   *
   * A no-op dispatcher is not a neutral stand-in: the effect ledger would
   * record an execution that nobody started and the worker would never receive
   * its attempt credential, while every durable surface reads as if the node
   * were running. Refusing by name — before any state is read or written, in
   * `start`, `resume` and `submit` alike — is what makes "a dispatch is only
   * recorded when a host can perform it" true by construction. Production
   * entries check the same condition before they open a ledger, so the common
   * case never reaches this guard.
   */
  private dispatchCapabilityRefusal(): OutcomeRuntimeRefusal | undefined {
    if (this.dispatch !== undefined) return undefined;
    return {
      code: "dispatch-unavailable",
      message:
        "outcome-runtime: graph " +
        JSON.stringify(this.graphId) +
        " was given no dispatch adapter — a node's execution has to go somewhere, and a " +
        "no-op would let this runtime record a dispatch it never performed, so nothing is " +
        "started, resumed or settled",
    };
  }

  /**
   * Execute the dispatch effects a transaction THIS CALL committed (D8).
   *
   * THE ORDER IS UNCHANGED: the host is called in order and the first throw
   * stops the loop, so requests after it stay unlaunched exactly as before —
   * but now their effects are durable rows, not lost intentions. Each effect's
   * row is marked `started` AFTER its create returns: the status is a record of
   * a create that happened, never a substitute for one, so a crash inside the
   * call leaves a `pending` row a recovery can put to the host.
   *
   * WHY THIS PATH DOES NOT ASK THE HOST FIRST. Every request here belongs to an
   * effect the SAME transaction committed, under an attempt id minted in that
   * transaction, so no earlier process can have created it — there is no crash
   * window to resolve and the create is the first attempt, not a retry. The
   * reconciliation query exists for the OTHER path (`resume`), where the row
   * was written by a process that is gone.
   *
   * The one added rule is about what escapes: the host is the delivery channel
   * and necessarily receives each request's credential, so a failure text that
   * echoes the request it was given (a plausible adapter bug) must not become
   * the way that credential reaches a *report* — and for `submit` the caller
   * that would receive it is the submitting worker, which is not entitled to a
   * successor's credential. The message is therefore checked against the
   * launch set before it leaves this class.
   */
  private launchDispatches(requests: readonly OutcomeDispatchRequest[]): void {
    try {
      for (const request of requests) {
        this.createExecution(request);
        // THE CREATE RETURNED, SO THE ROW MAY SAY SO. A row that cannot be
        // marked is a disagreement worth failing on: the execution exists and
        // the ledger does not record it, which a recovery would otherwise have
        // to re-derive from the host.
        const marked = this.markDispatchStarted(request.attemptId);
        if (marked !== undefined) throw new Error(marked.message);
      }
    } catch (error) {
      throw this.credentialSafeDispatchError(error, requests);
    }
  }

  /**
   * Ask the host to create one effect's execution.
   *
   * The request travels with the stable effect key, so a host that dedupes on
   * it satisfies the contract's idempotency rule without re-deriving the id.
   */
  private createExecution(request: OutcomeDispatchRequest): void {
    const host = this.dispatch;
    if (host === undefined) {
      // Unreachable behind {@link dispatchCapabilityRefusal}; kept total so a
      // caller that bypasses the typed option gets the refusal, not a crash.
      throw new Error(this.dispatchCapabilityRefusal()?.message ?? "");
    }
    host.create(request, dispatchEffectKeyOf(this.graphId, request.attemptId));
  }

  /**
   * Record that one attempt's execution was created, or describe why the row
   * could not say so.
   *
   * `transitioned` and `unchanged` both mean the row now reads `started`.
   * `missing` means the effect row is not there at all and `refused` means a
   * terminal row would have to be rewound — both are state/ledger disagreements
   * about an execution the host may already have, so neither is swallowed.
   */
  private markDispatchStarted(
    attemptId: string,
  ): OutcomeRuntimeRefusal | undefined {
    const effectId = dispatchEffectIdOf(attemptId);
    const transition = this.ledger.markEffectStarted(this.graphId, effectId);
    if (transition.kind === "transitioned" || transition.kind === "unchanged") {
      return undefined;
    }
    return {
      code: "state-ledger-disagreement",
      path: "$.effectId",
      message:
        "outcome-runtime: the dispatch effect " +
        JSON.stringify(effectId) +
        " of graph " +
        JSON.stringify(this.graphId) +
        " could not be marked started (" +
        transition.reason +
        ") — the host may already hold this execution, so the attempt is not " +
        "re-launched and the effect stays unsettled",
    };
  }

  /** Reconcile trusted host usage without advancing graph execution. */
  recordUsage(report: OutcomeBudgetUsageReport): OutcomeBudgetUsageOutcome {
    return this.budget.recordUsage(report);
  }

  budgetReport(runId?: string): OutcomeBudgetReading {
    return this.budget.budgetReport(runId);
  }

  /**
   * Arm every successor the advance computed, claiming each one's budget — or
   * abort the whole transaction by naming the first node that has no headroom.
   *
   * The throw is deliberate: the acceptance that would arm this dispatch is
   * refused WHOLE, so a graph never commits a state whose successor cannot be
   * started, and the caller is answered the same `budget-exhausted` refusal a
   * refused claim produces at `start`.
   */
  private claimSuccessorDispatches(
    tx: AcceptanceLedgerTx,
    runId: string,
    intents: OutcomeAdvance["dispatches"],
    at: number,
  ): void {
    for (const intent of intents) {
      const refusal = this.budget.reserveDispatchIn(tx, runId, intent.nodeId, intent.attemptId, at);
      if (refusal !== undefined) throw new DispatchBudgetExhaustedError(refusal);
    }
  }

  /**
   * The error a failed dispatch launch is reported as, with every credential
   * the seam was handed removed from its message.
   *
   * The original name is carried over and the original value is attached as
   * `cause`, so an in-process caller that genuinely needs the unsanitized text
   * still has an explicit handle on it while the REPORTED message stays
   * credential-free. When nothing was replaced the original message is used
   * verbatim — sanitizing is visible, never silent.
   */
  private credentialSafeDispatchError(
    error: unknown,
    requests: readonly OutcomeDispatchRequest[],
  ): Error {
    const raw = errorText(error);
    const sanitized = this.withoutCredentials(
      raw,
      requests.map((request) => request.credential),
    );
    const reported =
      sanitized === raw
        ? raw
        : "outcome-runtime: the dispatch seam failed and its message echoed an attempt " +
        "credential, which was removed from this report: " +
        sanitized;
    const wrapped = new Error(reported, { cause: error });
    if (error instanceof Error) wrapped.name = error.name;
    return wrapped;
  }

  /** Every given credential value in `text`, replaced by one fixed marker. */
  private withoutCredentials(
    text: string,
    credentials: readonly string[],
  ): string {
    let out = text;
    for (const credential of credentials) {
      if (credential.length === 0 || !out.includes(credential)) continue;
      out = out.split(credential).join("[redacted attempt credential]");
    }
    return out;
  }

  /**
   * Resolve the unsettled dispatch effects the STATE corroborates (D8 resume).
   *
   * EVERY EFFECT GOES THROUGH THE SAME DECISION — ask the host, then act on its
   * answer — so a restart cannot resolve one crash window two different ways:
   *
   * - the host answers `created` → the execution exists. The row is marked
   *   `started` and reported as RECONCILED; the create is NEVER re-issued (a
   *   second create is exactly what could run one attempt twice);
   * - the host answers `absent` → the execution definitively does not exist
   *   (the crash-after-commit-before-launch window). It is created once, and the
   *   row is marked `started` only AFTER the create returns — the status
   *   records what happened, it is not a substitute for finding out;
   * - the host answers `unknown`, or there is no query capability at all →
   *   the runtime does not know whether the execution exists. NOTHING is
   *   launched and the effect is reported with `dispatch-unreconciled` as work
   *   for the host (or a human) to reconcile: re-issuing the create could
   *   execute an attempt twice, and reporting success would hide an attempt
   *   that never started.
   *
   * A row already `started` is NEVER re-created: a previous process recorded a
   * create that returned, and the report says so. If the host contradicts that
   * record with `absent`, the disagreement is REPORTED rather than acted on —
   * the stored fact and the host fact must be reconciled before either is
   * trusted with a second create.
   *
   * The STATE is the authority on the arm set — an effect the state does not
   * corroborate (wrong node, wrong attempt, node not dispatched) is never
   * launched and is reported as a refusal; it stays unsettled.
   */
  private reconcileUnsettledDispatches(
    state: OutcomeGraphState,
    /**
     * The instant this recovery runs at. It timestamps the one write recovery
     * performs — a §3.3 credential re-issue — so the state that records the new
     * verifier carries the same explicit time the caller supplied everywhere
     * else, never a clock read inside a transaction.
     */
    at: number,
  ):
    | {
      readonly launched: readonly OutcomeDispatchRequest[];
      readonly reconciled: readonly OutcomeReconciledEffect[];
      readonly divergences: readonly OutcomeEffectDivergence[];
      readonly refusals: readonly OutcomeRuntimeRefusal[];
      /**
       * Whether this pass REWROTE the persisted state by re-issuing a lost
       * attempt credential (§3.3). The caller re-reads the state it reports
       * when it did, so the reported state is the one that is stored.
       */
      readonly reissued: boolean;
    }
    | { readonly refusal: OutcomeRuntimeRefusal } {
    let effects: readonly PendingEffectRecord[];
    try {
      effects = this.ledger.pendingEffects(this.graphId);
    } catch (error) {
      return { refusal: ledgerReadRefusal(this.graphId, error) };
    }
    const host = this.dispatch;
    if (host === undefined) {
      // Unreachable behind {@link dispatchCapabilityRefusal}; kept total so an
      // untyped caller gets the refusal rather than a crash.
      const unavailable = this.dispatchCapabilityRefusal();
      return {
        refusal:
          unavailable ?? {
            code: "dispatch-unavailable",
            message:
              "outcome-runtime: no dispatch adapter is installed for graph " +
              JSON.stringify(this.graphId),
          },
      };
    }
    const launched: OutcomeDispatchRequest[] = [];
    const reconciled: OutcomeReconciledEffect[] = [];
    const divergences: OutcomeEffectDivergence[] = [];
    const refusals: OutcomeRuntimeRefusal[] = [];
    let reissued = false;
    for (const effect of effects) {
      if (effect.kind !== "dispatch") continue;
      const reading = readDispatchRequest(
        effect.payload,
        this.graphId,
        this.planRevision,
      );
      if (reading.kind === "malformed") {
        refusals.push({
          code: "malformed-effect",
          path: "$.payload",
          message: reading.message,
        });
        continue;
      }
      const target = reading.target;
      const armed = dispatchedNodeOf(state, target.nodeId);
      if (armed === undefined || armed.attemptId !== target.attemptId) {
        // A SETTLED ATTEMPT IS A COMPLETE DISPATCH. The state records the node
        // settled on exactly this attempt, so its execution demonstrably ran
        // (a settlement is only possible with the credential the create handed
        // out) and the row is closed instead of reported as a disagreement.
        const recorded = stateNodeOf(state, target.nodeId);
        if (
          recorded !== undefined &&
          recorded.status === "settled" &&
          recorded.attemptId === target.attemptId
        ) {
          this.ledger.markEffectDone(this.graphId, effect.effectId);
          reconciled.push(
            this.reconciledEffectOf(effect.effectId, target.attemptId, "attempt-settled"),
          );
          continue;
        }
        refusals.push({
          code: "state-ledger-disagreement",
          path: "$.attemptId",
          message:
            "outcome-runtime: dispatch effect " +
            JSON.stringify(effect.effectId) +
            " names node " +
            JSON.stringify(target.nodeId) +
            " on attempt " +
            JSON.stringify(target.attemptId) +
            ", but the persisted state does not record that attempt as in flight — " +
            "the effect was not launched and stays unsettled",
        });
        continue;
      }
      // THE INPUT VIEW IS DELIVERED FROM THE PERSISTED STATE, NEVER RE-DERIVED
      // (D6). The binding was decided in the transaction that armed this attempt
      // and the state carries it verbatim, so a restarted process hands the
      // worker exactly what the arming process resolved — a loop round, a retry
      // or a re-execution that moved a producing node to a newer attempt cannot
      // rebind a consumer that is already in flight.
      //
      // AN ATTEMPT WITH NO BOUND VIEW FOR A NODE THAT DECLARES INPUTS IS NEVER
      // LAUNCHED (D6): it was armed by a body version that did not bind one, and
      // starting it would give the worker a hole where its input should be. The
      // refusal is reported here, before the credential is re-issued, so nothing
      // is prepared for an execution that must not exist.
      const declaredInputs = this.compiledNodeOf(target.nodeId)?.inputs ?? [];
      if (armed.inputs === undefined && declaredInputs.length > 0) {
        refusals.push({
          code: "dispatch-input-unbound",
          path: "$.attemptId",
          message:
            "outcome-runtime: dispatch effect " +
            JSON.stringify(effect.effectId) +
            " targets node " +
            JSON.stringify(target.nodeId) +
            " on attempt " +
            JSON.stringify(target.attemptId) +
            ", which DECLARES " +
            String(declaredInputs.length) +
            " input(s), but the persisted state entry for that attempt records no bound " +
            "input view — it was armed before this build bound inputs to the attempt, so " +
            "it is NOT launched with a hole where its input should be: the effect stays " +
            "unsettled and this node must be armed again under this build (a trusted " +
            "retry or a re-execution mints an attempt that carries the binding)",
        });
        continue;
      }
      // THE STATE ENTRY IS THE AUTHORITY for the delivered view: it is the record
      // the reader verifies and the one this decision has just been made
      // against. An entry armed by this build always carries a list — empty when
      // the node declares none.
      const boundInputs: readonly ResolvedInput[] = armed.inputs ?? Object.freeze([]);
      // THE BINDING IS READ FROM THE PERSISTED STATE, AND THE CREDENTIAL FROM
      // THE HOST'S STORE. The payload is credential-free on purpose and the
      // state records only the DIGEST, so the credential a recovered worker
      // receives is resolved from the capability that adopted it at mint time.
      // An attempt whose entry carries no digest (a body version that persisted
      // the credential itself, or none at all) and one whose credential the host
      // store can no longer produce are BOTH refused rather than launched
      // without a credential or granted a fresh one for a new execution.
      if (armed.attemptCredentialDigest === undefined) {
        refusals.push({
          code: "credential-missing",
          path: "$.attemptCredentialDigest",
          message:
            "outcome-runtime: dispatch effect " +
            JSON.stringify(effect.effectId) +
            " targets node " +
            JSON.stringify(target.nodeId) +
            " on attempt " +
            JSON.stringify(target.attemptId) +
            ", but the persisted state entry for that attempt carries no attempt-credential " +
            "digest — a body version before this one persisted the credential itself and is " +
            "never re-delivered by this build, so the effect stays unsettled",
        });
        continue;
      }
      const key = dispatchEffectKeyOf(this.graphId, target.attemptId);
      // THE HOST'S OWN ANSWER IS READ BEFORE THE CREDENTIAL IS, because §3.3
      // makes it the CONDITION of re-issuing one: only a host that proves no
      // execution exists may have a lost credential replaced.
      const lookup = this.lookupExecution(key);
      const resolvedCredential = this.resolveStoredCredential(
        target.nodeId,
        target.attemptId,
      );
      let credential: string;
      if (resolvedCredential.kind === "resolved") {
        credential = resolvedCredential.credential;
      } else {
        const reissuedCredential = this.reissueLostCredential({
          effect,
          target,
          lookup,
          at,
          reason: resolvedCredential.reason,
          // The verifier recovery OBSERVED for this attempt. The re-issue
          // replaces exactly this generation and refuses if the recorded one
          // has already moved, so it can never overwrite a newer verifier.
          observedDigest: armed.attemptCredentialDigest,
        });
        if ("refusal" in reissuedCredential) {
          refusals.push(reissuedCredential.refusal);
          continue;
        }
        credential = reissuedCredential.credential;
        reissued = true;
      }

      if (effect.status === "started") {
        // THE ROW SAYS A CREATE RETURNED. Nothing is re-created either way; a
        // host that contradicts the record turns into a report, not a launch.
        if (lookup.kind === "absent") {
          refusals.push({
            code: "dispatch-unreconciled",
            path: "$.effectId",
            message:
              "outcome-runtime: dispatch effect " +
              JSON.stringify(effect.effectId) +
              " is recorded as started, but the host reports no execution for it — the " +
              "stored fact and the host fact disagree, so the effect is left exactly as it " +
              "is and reported for reconciliation rather than started a second time",
          });
          // THE DIVERGENCE IS ITS OWN REPORT (D9). The refusal above says what was
          // NOT done; this record names the disagreement itself (local record
          // ahead of the host), so a caller reading only divergences still sees
          // the contradiction instead of inferring it from a refusal code.
          divergences.push(
            this.divergenceOf(effect.effectId, target.attemptId, "started", "absent"),
          );
          continue;
        }
        reconciled.push(this.reconciledEffectOf(effect.effectId, target.attemptId, "recorded-started"));
        continue;
      }

      if (lookup.kind === "unknown") {
        refusals.push({
          code: "dispatch-unreconciled",
          path: "$.effectId",
          message:
            "outcome-runtime: dispatch effect " +
            JSON.stringify(effect.effectId) +
            " (attempt " +
            JSON.stringify(target.attemptId) +
            ") was committed but its execution cannot be established: " +
            // The reason is host text and this refusal is a REPORT, so it is
            // sanitized against the attempt's own credential like every other
            // dispatch-failure report.
            this.withoutCredentials(lookup.reason, [credential]) +
            " — it was NOT launched and is reported as unsettled work for the host to " +
            "reconcile; a blind retry could run the attempt twice, and reporting success " +
            "would hide an attempt that never started",
        });
        continue;
      }

      if (lookup.kind === "created") {
        const marked = this.markDispatchStarted(target.attemptId);
        if (marked !== undefined) {
          refusals.push(marked);
          continue;
        }
        reconciled.push(this.reconciledEffectOf(effect.effectId, target.attemptId, "host-reported-created"));
        // AND THE DISAGREEMENT THAT WAS RECONCILED IS REPORTED AS ONE (D9): the
        // local row said `pending` while the host already had the execution, so
        // the row is marked and NEVER re-created. Reporting it here — rather than
        // only as a positive reconciliation — is what makes "the host was ahead"
        // observable instead of inferred.
        divergences.push(
          this.divergenceOf(effect.effectId, target.attemptId, "pending", "created"),
        );
        continue;
      }

      // ABSENT: the host confirms no execution exists, so this is the
      // commit-then-crash window and the create is the FIRST attempt, not a
      // retry. The row is marked started only after the create returned.
      try {
        this.createExecution(
          this.dispatchRequestOf(
            target.nodeId,
            target.attemptId,
            target.agent,
            target.prompt,
            boundInputs,
            credential,
          ),
        );
      } catch (error) {
        refusals.push({
          code: "dispatch-failed",
          path: "$.effectId",
          message:
            "outcome-runtime: the host threw while creating effect " +
            JSON.stringify(effect.effectId) +
            " (" +
            this.withoutCredentials(errorText(error), [credential]) +
            ") — the effect stays unsettled and is NOT reported as started; the next " +
            "recovery asks the host again before anything is created",
        });
        continue;
      }
      const marked = this.markDispatchStarted(target.attemptId);
      if (marked !== undefined) {
        refusals.push(marked);
        continue;
      }
      launched.push(
        this.dispatchRequestOf(
          target.nodeId,
          target.attemptId,
          target.agent,
          target.prompt,
          boundInputs,
          credential,
        ),
      );
    }
    return {
      launched: Object.freeze(launched),
      reconciled: Object.freeze(reconciled),
      divergences: Object.freeze(divergences),
      refusals: Object.freeze(refusals),
      reissued,
    };
  }

  /**
   * One restart divergence: the local effect status and the contradicting host
   * fact, with what this recovery did about it — `reconciled-started` when the
   * host was ahead and the row was marked without a create, and
   * `reported-unreconciled` when the record was ahead and nothing was changed.
   */
  private divergenceOf(
    effectId: string,
    attemptId: string,
    local: "pending" | "started",
    host: "created" | "absent",
  ): OutcomeEffectDivergence {
    return Object.freeze({
      effectId,
      attemptId,
      local,
      host,
      resolution:
        local === "pending" && host === "created"
          ? ("reconciled-started" as const)
          : ("reported-unreconciled" as const),
    });
  }

  /**
   * Ask the HOST'S STORE for the credential one attempt was issued.
   *
   * This is the only way a recovery can obtain a credential: the durable state
   * records its digest, so no amount of reading the ledger yields a value a
   * worker could present or a create could deliver. The store is the version-2
   * half of the credential-isolation capability; a process that holds only the
   * version-1 declaration (or no capability at all) has no store, and an effect
   * it cannot re-deliver is reported as unsettled rather than launched.
   *
   * TOTAL, AND NEVER QUOTING THE STORE. A store that throws, or answers
   * something that is not a credential, is reported as `unavailable` — never
   * converted into a launch and never replaced by a freshly minted value. The
   * reason is RUNTIME-AUTHORED text naming the failure category: this is the one
   * component that legitimately holds credentials, so neither a thrown message
   * nor an answered value is ever copied into a report (both are exactly where a
   * credential could surface).
   */
  private resolveStoredCredential(
    nodeId: string,
    attemptId: string,
  ):
    | { readonly kind: "resolved"; readonly credential: string }
    | { readonly kind: "unavailable"; readonly reason: string } {
    const store = this.credentialStore;
    if (store === undefined) {
      return Object.freeze({
        kind: "unavailable" as const,
        reason:
          "this process holds no version-" +
          CREDENTIAL_ISOLATION_VERSION_V3 +
          " credential-isolation capability with a { remember, resolve } store",
      });
    }
    let resolved: unknown;
    try {
      resolved = store.resolve(
        Object.freeze({ graphId: this.graphId, nodeId, attemptId }),
      );
    } catch {
      return Object.freeze({
        kind: "unavailable" as const,
        reason:
          "the host store threw while resolving it (its message is not quoted: this is " +
          "the component that legitimately holds credentials)",
      });
    }
    if (!isAttemptCredential(resolved)) {
      return Object.freeze({
        kind: "unavailable" as const,
        reason:
          "the host store did not answer a non-empty credential (the value is not " +
          "quoted for the same reason)",
      });
    }
    return Object.freeze({ kind: "resolved" as const, credential: resolved });
  }

  /**
   * THE RESTART AUTHORIZATION POLICY (plan §3.3, P2 item 8).
 */
  private reissueLostCredential(input: {
    readonly effect: PendingEffectRecord;
    readonly target: OutcomeDispatchTarget;
    readonly lookup: OutcomeExecutionLookup;
    readonly at: number;
    readonly reason: string;
    /**
     * The verifier recovery observed for this attempt. The replacement is
     * conditional on the recorded one still being this value.
     */
    readonly observedDigest: string;
  }): { readonly credential: string } | { readonly refusal: OutcomeRuntimeRefusal } {
    const effect = input.effect;
    const target = input.target;
    const effectId = effect.effectId;
    if (effect.status !== "pending") {
      return {
        refusal: {
          code: "credential-reissue-forbidden",
          path: "$.status",
          message:
            "outcome-runtime: dispatch effect " +
            JSON.stringify(effectId) +
            " names node " +
            JSON.stringify(target.nodeId) +
            " on attempt " +
            JSON.stringify(target.attemptId) +
            " and is recorded " +
            JSON.stringify(effect.status) +
            ", so a create RETURNED for it and an execution may exist — a lost credential is " +
            "never replaced for an effect that was handed to the platform (the reason the host " +
            "store could not produce it: " +
            input.reason +
            "); the effect stays unsettled and is reported",
        },
      };
    }
    if (input.lookup.kind !== "absent") {
      return {
        refusal: {
          code: "credential-reissue-forbidden",
          path: "$.effectId",
          message:
            "outcome-runtime: dispatch effect " +
            JSON.stringify(effectId) +
            " names node " +
            JSON.stringify(target.nodeId) +
            " on attempt " +
            JSON.stringify(target.attemptId) +
            ", its credential is gone (" +
            input.reason +
            "), and re-issuing one is permitted ONLY after the host proves no execution " +
            "exists. The host answered " +
            input.lookup.kind +
            (input.lookup.kind === "unknown" ? " (" + input.lookup.reason + ")" : "") +
            " — so the attempt is NOT re-issued and NOT re-delivered: a blind retry could run " +
            "it twice, and the block is reported rather than resolved by guessing",
        },
      };
    }
    // THE RE-ISSUE TAKES THE CREATE RIGHT BEFORE IT MINTS ANYTHING (plan §3.3).
    // The claim is the SAME conditional right the host's create takes, so while
    // this process holds it, a second recoverer is told `held` (or, through the
    // registry lookup, `unknown`) and cannot replace the verifier this process
    // is about to deliver. A host that installs no fence gets no re-issue.
    const key = dispatchEffectKeyOf(this.graphId, target.attemptId);
    const fence = this.reissueFence;
    if (fence === undefined) {
      return {
        refusal: {
          code: "credential-reissue-forbidden",
          path: "$.effectId",
          message:
            "outcome-runtime: dispatch effect " +
            JSON.stringify(effectId) +
            " names node " +
            JSON.stringify(target.nodeId) +
            " on attempt " +
            JSON.stringify(target.attemptId) +
            ", its credential is gone (" +
            input.reason +
            "), and re-issuing one needs the host's CREATE-RIGHT fence — this runtime holds " +
            "none, so the attempt is NOT re-issued and NOT re-delivered: without the fence a " +
            "second recoverer could replace the verifier of an attempt this process is about " +
            "to dispatch, and the effect stays unsettled and is reported",
        },
      };
    }
    let claim: Extract<AttemptReissueClaim, { kind: "claimed" }>;
    try {
      const reading = fence.claim(key);
      if (reading.kind === "held") {
        return {
          refusal: {
            code: "credential-reissue-forbidden",
            path: "$.effectId",
            message:
              "outcome-runtime: dispatch effect " +
              JSON.stringify(effectId) +
              " names node " +
              JSON.stringify(target.nodeId) +
              " on attempt " +
              JSON.stringify(target.attemptId) +
              ", its credential is gone (" +
              input.reason +
              "), and the create right for it is held elsewhere (" +
              reading.reason +
              ") — the re-issue is refused rather than overwriting a verifier another " +
              "recoverer may already have committed, so the effect stays unsettled and is " +
              "reported",
          },
        };
      }
      claim = reading;
    } catch (error) {
      return {
        refusal: {
          code: "credential-reissue-forbidden",
          path: "$.effectId",
          message:
            "outcome-runtime: dispatch effect " +
            JSON.stringify(effectId) +
            " names node " +
            JSON.stringify(target.nodeId) +
            " on attempt " +
            JSON.stringify(target.attemptId) +
            ", its credential is gone (" +
            input.reason +
            "), and the host's create-right fence could not be read (" +
            errorText(error) +
            ") — nothing was re-issued and the effect stays unsettled",
        },
      };
    }
    const replaced = this.replaceAttemptCredential(
      target.nodeId,
      target.attemptId,
      input.at,
      input.observedDigest,
    );
    if ("refusal" in replaced) {
      // The claim was taken and NOTHING was handed to the platform, so giving
      // it back is a proof-backed release: no execution was created.
      try {
        fence.abandon(
          key,
          claim.ownerId,
          "the credential re-issue refused before any create was attempted",
        );
      } catch {
        // The refusal is already the answer; the claim lapses with its lease.
      }
      return replaced;
    }
    return { credential: replaced.credential };
  }

  /**
   * Adopt ONE new credential generation for an attempt and replace the digest
   * the persisted state verifies against, in ONE transaction.
   *
   * The two writes are one commit by construction: {@link credentialSource}
   * ADOPTS the freshly minted value into the host's store (the version-3
   * capability's `remember`) and the state write that records its digest joins
   * the SAME `runInTransaction` boundary, so a failed write leaves neither.
   * That is what makes the previous generation invalid rather than merely
   * superseded: the old digest is not kept anywhere, so the old credential
   * matches no recorded verifier and is refused by name.
   *
   * REFUSES WHAT IT CANNOT REPLACE: a state this build cannot read, a node the
   * plan does not declare, an entry whose attempt is not the named one, a node
   * that is not in flight, and a body layout that is not this build's current
   * one are all structured refusals — recovery never rewrites a record it could
   * not read, and never advances an older body version.
   *
   * THE REPLACEMENT IS CONDITIONAL ON THE OBSERVED GENERATION. The transaction
   * re-reads the recorded verifier and writes only while it is still the one
   * recovery observed; a verifier that moved in between is a structured
   * `credential-reissue-forbidden` refusal and NO write happens. Together with
   * the create-right fence this is what makes two re-issues over one store a
   * single-winner operation: the loser reports instead of overwriting the
   * winner's verifier.
   */
  private replaceAttemptCredential(
    nodeId: string,
    attemptId: string,
    at: number,
    observedDigest: string,
  ): { readonly credential: string } | { readonly refusal: OutcomeRuntimeRefusal } {
    try {
      return this.ledger.runInTransaction(
        (tx): { readonly credential: string } | { readonly refusal: OutcomeRuntimeRefusal } => {
          const record = tx.readGraphState(this.graphId);
          if (record === undefined) {
            throw new OutcomeAdvanceRefusedError(
              "state-ledger-disagreement",
              "outcome-runtime: the state of graph " +
              JSON.stringify(this.graphId) +
              " disappeared between recovery's read and the credential re-issue — nothing " +
              "was re-issued",
            );
          }
          const state = readOutcomeGraphState(record, this.plan);
          if (state.bodyVersion !== CURRENT_OUTCOME_STATE_BODY) {
            throw new OutcomeAdvanceRefusedError(
              "unsupported-state-version",
              "outcome-runtime: graph " +
              JSON.stringify(this.graphId) +
              " records state body version " +
              String(state.bodyVersion) +
              ", which this build does not rewrite — the credential of a recovered attempt is " +
              "never re-issued into an older layout",
            );
          }
          const position = this.plan.nodes.findIndex((node) => node.id === nodeId);
          const current = position < 0 ? undefined : state.nodes[position];
          if (current === undefined || current.attemptId !== attemptId) {
            throw new OutcomeAdvanceRefusedError(
              "attempt-mismatch",
              "outcome-runtime: the credential re-issue was asked for node " +
              JSON.stringify(nodeId) +
              " attempt " +
              JSON.stringify(attemptId) +
              ", but the state records " +
              (current === undefined || current.attemptId === undefined
                ? "no such attempt"
                : "attempt " + JSON.stringify(current.attemptId)) +
              " — nothing was re-issued",
            );
          }
          if (current.status !== "dispatched" || current.attemptCredentialDigest === undefined) {
            throw new OutcomeAdvanceRefusedError(
              "node-not-dispatched",
              "outcome-runtime: node " +
              JSON.stringify(nodeId) +
              " is " +
              current.status +
              " (or records no credential digest), so its attempt is not one whose lost " +
              "credential this build re-issues — nothing was written",
            );
          }
          // THE CONDITIONAL WRITE (R1). The verifier is replaced only while it
          // is still the generation recovery OBSERVED; a value that moved in
          // between is reported, never overwritten.
          if (current.attemptCredentialDigest !== observedDigest) {
            return {
              refusal: {
                code: "credential-reissue-forbidden",
                path: "$.attemptCredentialDigest",
                message:
                  "outcome-runtime: node " +
                  JSON.stringify(nodeId) +
                  " attempt " +
                  JSON.stringify(attemptId) +
                  " was observed with one recorded credential verifier, but the state now " +
                  "records a DIFFERENT one — another recoverer re-issued this attempt's " +
                  "credential first, and this re-issue is refused rather than overwriting a " +
                  "verifier that may already belong to a dispatched worker",
              },
            };
          }
          const minted = this.credentialSource(
            attemptCredentialBinding({
              graphId: this.graphId,
              nodeId,
              attemptId,
              planRevision: this.planRevision,
            }),
          );
          const nodes = state.nodes.map((entry, index) =>
            index === position
              ? Object.freeze({
                ...entry,
                attemptCredentialDigest: attemptCredentialDigest(minted),
              })
              : entry,
          );
          tx.writeGraphState(
            stateRecordOf(Object.freeze({ ...state, nodes: Object.freeze(nodes) }), at),
          );
          return { credential: minted };
        },
      );
    } catch (error) {
      if (error instanceof OutcomeAdvanceRefusedError) {
        return {
          refusal: {
            code: error.code as OutcomeRuntimeRefusal["code"],
            path: "$.attemptCredentialDigest",
            message: error.message,
          },
        };
      }
      if (error instanceof OutcomeStateError) {
        return { refusal: this.stateRefusal(error) };
      }
      return {
        refusal: {
          code: "credential-missing",
          path: "$.attemptCredentialDigest",
          message:
            "outcome-runtime: the credential re-issue for node " +
            JSON.stringify(nodeId) +
            " attempt " +
            JSON.stringify(attemptId) +
            " could not be committed (" +
            // The failing call may be the HOST STORE (the mint adopts the value
            // there), so its own text is not quoted: this is one of the two
            // components that legitimately handle a credential.
            "the transaction rolled back) — nothing was re-issued and the effect stays " +
            "unsettled",
        },
      };
    }
  }

  /**
   * Ask the host whether one effect's execution exists, with a failure to
   * answer treated as the honest `unknown` rather than as a decision.
   *
   * A host whose lookup throws has not said "absent"; reporting that as a
   * launch would turn an unanswered question into a second execution.
   */
  private lookupExecution(
    effect: OutcomeDispatchEffectKey,
  ): OutcomeExecutionLookup {
    const host = this.dispatch;
    if (host === undefined) {
      return Object.freeze({
        kind: "unknown" as const,
        reason: "no dispatch adapter is installed",
      });
    }
    try {
      return host.lookup(effect);
    } catch (error) {
      return Object.freeze({
        kind: "unknown" as const,
        reason: "the host lookup failed (" + errorText(error) + ")",
      });
    }
  }

  /** One reconciliation record, frozen like every other reported value. */
  private reconciledEffectOf(
    effectId: string,
    attemptId: string,
    reason: OutcomeReconciledReason,
  ): OutcomeReconciledEffect {
    return Object.freeze({ effectId, attemptId, reason });
  }

  /**
   * Every effect the ledger still holds UNSETTLED (`pending` or `started`), or
   * a refusal when the ledger cannot answer.
   *
   * This is the reporting half of recovery: a `started` row a dead process
   * left behind is surfaced here, exactly as a `pending` row that could not be
   * launched is. Neither is ever dropped, and neither is silently rewound.
   */
  private unsettledEffectReading():
    | readonly PendingEffectRecord[]
    | OutcomeRuntimeRefusal {
    try {
      return this.ledger.pendingEffects(this.graphId);
    } catch (error) {
      return ledgerReadRefusal(this.graphId, error);
    }
  }
  /**
   * Derive the trusted execution identity of one submission.
   *
   * THE ORDER IS THE RULE: the credential is resolved against the persisted
   * state FIRST, and only the attempt it names is then handed to the acceptance
   * core. The node's CURRENT attempt is never consulted as a fallback — a
   * credential that names nothing, or names another node's attempt, is refused
   * outright, so a late submission cannot be re-bound to a newer attempt and a
   * crafted credential cannot select one. A well-formed proposal whose
   * credential resolves is bound to that recorded attempt (dispatched or
   * settled — a settled one is the replay path); a malformed one carries a
   * placeholder identity so the acceptance core — the owner of the proposal
   * shape gate — refuses it with its own diagnostics.
   *
   * AND THEN THE HOST IDENTITY IS CHECKED (D9), against the attempt's OWN
   * recorded dispatch identity: a submission from another host invocation is
   * refused by name before any gate runs and before anything is written.
   *
   * THE SOURCE LABELS THE SUBMISSION KEY, AND ONLY THE KEY. `source` decides
   * whether the content address is `submission:<digest>` or the
   * `natural-completion:` namespace; it never widens or narrows what the
   * credential may settle. `expectedAttemptId` is the natural channel's
   * cross-check: the delivery's own attempt NAME must agree with the attempt the
   * credential resolves to, so a credential can never be re-aimed at another
   * attempt by relabelling the delivery.
   */
  private identityFor(
    proposal: unknown,
    state: OutcomeGraphState,
    hostIdentity: HostIdentityReading,
    source: SettlementSource,
    expectedAttemptId?: string,
    hostCompletion?: HostCompletionExecution,
  ): ExecutionIdentity | { readonly refusal: OutcomeRuntimeRefusal } {
    const reading = readOutcomeProposal(proposal);
    if (reading.kind === "malformed") {
      return {
        graphId: this.graphId,
        attemptId: "unclaimed-attempt",
        submissionId: "unclaimed-submission",
      };
    }
    const index = this.plan.nodes.findIndex(
      (node) => node.id === reading.proposal.nodeId,
    );
    if (index < 0) {
      return {
        refusal: {
          code: "unknown-node",
          path: "$.nodeId",
          message:
            "outcome-runtime: node " +
            JSON.stringify(reading.proposal.nodeId) +
            " is not declared by plan revision " +
            this.planRevision +
            " — an outcome can only be claimed on a node the compiled plan declares",
        },
      };
    }
    // ── THE HOST-COMPLETION CHANNEL (P2 items 6/7) ─────────────────────────
    //
    // A host-authenticated completion resolves its attempt from the HOST'S OWN
    // durable execution record — already corroborated by the caller — and from
    // the attempt the PERSISTED STATE records for the named node. It never
    // reads, requires or fabricates a bearer credential: a restart that lost
    // the value must still be able to settle the execution the host created
    // (plan §3.3, "a trusted host completion must not depend on re-obtaining
    // the worker's bearer").
    if (hostCompletion !== undefined) {
      if (reading.proposal.credential !== undefined) {
        return {
          refusal: {
            code: "malformed-natural-delivery",
            path: "$.credential",
            message:
              "outcome-runtime: a host-completion delivery for node " +
              JSON.stringify(reading.proposal.nodeId) +
              " carries an attempt credential — this channel is authenticated by the host's " +
              "own durable execution record and never reads a bearer value, so the delivery is " +
              "refused instead of settling under whichever proof it happened to present",
          },
        };
      }
      if (expectedAttemptId === undefined) {
        return {
          refusal: {
            code: "attempt-mismatch",
            path: "$.attemptId",
            message:
              "outcome-runtime: a host completion for node " +
              JSON.stringify(reading.proposal.nodeId) +
              " names no attempt, so there is no execution the host's fact could belong to",
          },
        };
      }
      const recorded = stateNodeOf(state, reading.proposal.nodeId);
      if (recorded === undefined || recorded.attemptId !== expectedAttemptId) {
        return {
          refusal: {
            code: "attempt-mismatch",
            path: "$.attemptId",
            message:
              "outcome-runtime: the host reports attempt " +
              JSON.stringify(expectedAttemptId) +
              " of node " +
              JSON.stringify(reading.proposal.nodeId) +
              " finished, but the persisted state records " +
              (recorded === undefined || recorded.attemptId === undefined
                ? "no attempt for that node"
                : "attempt " + JSON.stringify(recorded.attemptId)) +
              " — a completion fact is never re-bound to the node's current attempt",
          },
        };
      }
      if (recorded.status === "pending") {
        return {
          refusal: {
            code: "node-not-dispatched",
            path: "$.nodeId",
            message:
              "outcome-runtime: node " +
              JSON.stringify(reading.proposal.nodeId) +
              " records attempt " +
              JSON.stringify(expectedAttemptId) +
              " while still pending, so no execution of it was ever dispatched for a host " +
              "completion to describe — nothing was settled",
          },
        };
      }
      // The host identity constraint applies to this channel too (D9): the
      // reference is the identity the DISPATCH recorded on the attempt, never
      // the invocation that happens to be observing the completion.
      const hostIdentityCheck = hostIdentityCheckRefusal(
        recorded.dispatchIdentity,
        hostIdentity,
      );
      if (hostIdentityCheck !== undefined) return { refusal: hostIdentityCheck };
      return {
        graphId: this.graphId,
        attemptId: expectedAttemptId,
        submissionId: submissionIdOf(proposal, source),
      };
    }

    const credential = reading.proposal.credential;
    if (credential === undefined) {
      return {
        refusal: {
          code: "credential-missing",
          path: "$.credential",
          message:
            "outcome-runtime: node " +
            JSON.stringify(reading.proposal.nodeId) +
            " was submitted without the attempt credential it was dispatched with — an outcome " +
            "is settled BY the attempt that holds the credential, and this runtime never " +
            "derives one from the node id; nothing was written",
        },
      };
    }
    // Resolve the attempt the credential was ISSUED for. The scan is over the
    // persisted binding — the DIGEST written on one attempt's entry — so the
    // comparison is "does this presented credential hash to a recorded
    // verifier", never "does it equal a stored copy of itself". It is never an
    // index into the node the proposal happens to name.
    const presented = attemptCredentialDigest(credential);
    let holder: OutcomeNodeState | undefined;
    for (const node of state.nodes) {
      if (node.attemptCredentialDigest === presented) {
        holder = node;
        break;
      }
    }
    if (holder === undefined) {
      return {
        refusal: {
          code: "credential-unknown",
          path: "$.credential",
          message:
            "outcome-runtime: the credential on this submission is not recorded by any attempt " +
            "of graph " +
            JSON.stringify(this.graphId) +
            " — no attempt's persisted DIGEST matches it, so it was never issued here, or " +
            "the attempt it was issued for has since been superseded (a body version that " +
            "persists the credential itself, or none at all, is never compared against a " +
            "presented value); the node's CURRENT attempt is never substituted for it, so " +
            "nothing was written",
        },
      };
    }
    if (holder.nodeId !== reading.proposal.nodeId) {
      return {
        refusal: {
          code: "credential-node-mismatch",
          path: "$.credential",
          message:
            "outcome-runtime: the credential was issued for node " +
            JSON.stringify(holder.nodeId) +
            ", but this submission claims node " +
            JSON.stringify(reading.proposal.nodeId) +
            " — a credential is bound to one node, and it is never re-aimed at another",
        },
      };
    }
    const attemptId = holder.attemptId;
    if (attemptId === undefined) {
      return {
        refusal: {
          code: "unreadable-state",
          path: "$.nodes[" + index + "].attemptId",
          message:
            "outcome-runtime: node " +
            JSON.stringify(reading.proposal.nodeId) +
            " records a credential on a " +
            holder.status +
            " entry but carries no attempt id — the binding cannot be resolved",
        },
      };
    }
    // THE DELIVERY'S ATTEMPT NAME MUST AGREE WITH THE CREDENTIAL'S ATTEMPT
    // (the natural-completion cross-check): the delivery says WHICH attempt
    // completed, and that name is checked against the attempt the credential
    // resolved to — never used to choose one. A credential issued for another
    // attempt of the SAME node is caught here rather than settling the attempt
    // the credential really belongs to.
    if (expectedAttemptId !== undefined && attemptId !== expectedAttemptId) {
      return {
        refusal: {
          code: "attempt-mismatch",
          path: "$.attemptId",
          message:
            "outcome-runtime: the delivery names attempt " +
            JSON.stringify(expectedAttemptId) +
            " of node " +
            JSON.stringify(reading.proposal.nodeId) +
            ", but its credential was issued for attempt " +
            JSON.stringify(attemptId) +
            " — a credential is bound to one attempt, and the delivery's name never selects it",
        },
      };
    }
    // THE HOST IDENTITY IS THE ADDITIONAL CONSTRAINT (D9), checked AFTER the
    // credential resolved the attempt and BEFORE any decision is taken. The
    // reference is the identity the DISPATCH recorded on this attempt's entry —
    // never the current invocation and never the node's current attempt — so an
    // attempt dispatched under no identity is unconstrained (the compatibility
    // rule) while an attempt that recorded one is settled only by a submission
    // the host attributes to the same invocation.
    const identityCheck = hostIdentityCheckRefusal(
      holder.dispatchIdentity,
      hostIdentity,
    );
    if (identityCheck !== undefined) return { refusal: identityCheck };
    return {
      graphId: this.graphId,
      attemptId,
      submissionId: submissionIdOf(proposal, source),
    };
  }

  /**
   * Reduce one ACCEPTED decision inside the acceptance transaction.
   *
   * The state is re-read from the TRANSACTION (not from the runtime's earlier
   * read), so the transition is a function of the rows the acceptance is
   * actually committing against. An already-settled node means this submission
   * is a replay: the ledger re-decides it, and this join contributes nothing —
   * which is what keeps a repeated submission from advancing the state twice.
   */
  private reduceInTransaction(
    tx: AcceptanceLedgerTx,
    decision: AcceptanceDecision,
    now: number,
    progress: readonly ProgressProjection[],
    dispatchIdentity: HostInvocationIdentity | undefined,
    /**
     * The accepted result THIS transaction commits (see
     * {@link JustAcceptedResult}). Absent when the validation retained none —
     * which means no accepted result is written for this attempt at all, so a
     * consumer of it is blocked by name rather than handed a synthesized value.
     */
    justAccepted: JustAcceptedResult | undefined,
  ): JoinedReduction {
    const record = tx.readGraphState(this.graphId);
    if (record === undefined) {
      throw new OutcomeAdvanceRefusedError(
        "state-ledger-disagreement",
        "outcome-runtime: the acceptance transaction sees no state snapshot for graph " +
        JSON.stringify(this.graphId) +
        " — nothing was applied",
      );
    }
    const current = readOutcomeGraphState(record, this.plan);
    const index = this.plan.nodes.findIndex(
      (node) => node.id === decision.nodeId,
    );
    const nodeState = index < 0 ? undefined : current.nodes[index];
    if (nodeState === undefined) {
      throw new OutcomeAdvanceRefusedError(
        "unknown-node",
        "outcome-runtime: the accepted decision names node " +
        JSON.stringify(decision.nodeId) +
        ", which the state does not carry — nothing was applied",
      );
    }
    if (nodeState.status === "settled") {
      const settled = tx
        .acceptedEvents(this.graphId)
        .some((event) => event.attemptId === decision.identity.attemptId);
      if (!settled) {
        throw new OutcomeAdvanceRefusedError(
          "state-ledger-disagreement",
          "outcome-runtime: node " +
          JSON.stringify(decision.nodeId) +
          " is settled in the state, but the ledger holds no accepted event for attempt " +
          JSON.stringify(decision.identity.attemptId) +
          " — refusing to advance on a state the ledger does not corroborate",
        );
      }
      return { result: {} };
    }
    const advance = advanceOutcomeGraph({
      plan: this.plan,
      state: current,
      decision,
      now,
      mintCredential: this.credentialSource,
      progress,
      // The invocation identity in effect for THIS submission (D9), written
      // onto every attempt this advance arms. Absent records nothing, which is
      // the honest statement for a host that declared no identity.
      ...(dispatchIdentity === undefined ? {} : { dispatchIdentity }),
      // THE DURABLE FACTS THE INPUT BINDING IS ASSEMBLED FROM (D6), read
      // through THIS transaction, with the result this very acceptance commits
      // overlaid because no read can see it yet.
      readAcceptedResult: this.acceptedResultReaderIn(tx, justAccepted),
    });
    const effects = advance.dispatches.map((intent) => ({
      effectId: dispatchEffectIdOf(intent.attemptId),
      // THE EFFECT IS THE ARMED ATTEMPT'S OWN (P3 item 2). `intent.attemptId` is
      // the attempt this dispatch is FOR, and it is not the submitting attempt:
      // accepting `work#1` in a `work -> review` chain arms `review#2`, so the
      // row must carry `review#2` — the attempt its effect id already names —
      // or every attempt-scoped fence (the run's unsettled-effect block, a
      // superseded run's acceptance guard) would join it to the settled feeder
      // whose acceptance decided to arm it, and the live successor execution
      // would be exempt from all of them.
      attemptId: intent.attemptId,
      kind: "dispatch",
      // CREDENTIAL-FREE payload: the durable effect names the dispatch target
      // and nothing else. Neither the effect nor the state carries the
      // credential itself — the state records its digest and the HOST's store
      // holds the value the launch is delivered with.
      payload: this.dispatchPayloadOf(intent),
    }));
    return {
      result: {
        effects: Object.freeze(effects),
        settle: (writeTx) => {
          // ── The budget moves WITH the settlement (P3 item 3) ─────────────
          //
          // THE SETTLED ATTEMPT'S CLAIM IS WITHDRAWN FIRST, in this same
          // transaction, so a node a loop re-arms is not refused headroom by the
          // very attempt whose acceptance freed it. It is released, not zeroed:
          // no usage was reported HERE, so its consumption stays UNKNOWN (a
          // platform report that arrives later still reconciles it).
          //
          // THE RUN COMES FROM THE STATE ROW THIS TRANSACTION READ, not from a
          // second read: the acceptance is committing against exactly that run,
          // and a substrate that mints no run identity has no budget rows to
          // move (its attempts were never claimed).
          const settledRunId = record.runId;
          if (settledRunId !== undefined) {
            this.budget.releaseDispatchClaim(
              writeTx,
              settledRunId,
              decision.nodeId,
              decision.identity.attemptId,
              now,
            );
            // EVERY SUCCESSOR THIS ACCEPTANCE ARMS IS CLAIMED BEFORE IT IS
            // WRITTEN. A node with no headroom throws, which rolls the entire
            // acceptance back: the graph never commits a state whose successor
            // cannot be dispatched.
            this.claimSuccessorDispatches(writeTx, settledRunId, advance.dispatches, now);
          }
          writeTx.writeGraphState(stateRecordOf(advance.state, now));
          // THE ATTEMPT'S DISPATCH IS COMPLETE ONCE ITS OUTCOME IS ACCEPTED
          // (D8). The transition rides the SAME transaction as the settlement,
          // so an effect can never be left unsettled by an attempt the state
          // already records as settled. A missing or already-terminal row is
          // not an error here: a body that predates the effect (or a row a
          // fixture stripped) must not fail an acceptance, and a terminal row
          // is exactly what this transition wants it to be.
          writeTx.markEffectDone(
            this.graphId,
            dispatchEffectIdOf(decision.identity.attemptId),
          );
        },
      },
      advance,
    };
  }

  /**
   * Measure one submission against every declared progress policy that governs
   * it — OUTSIDE the acceptance transaction.
   *
   * The projection reads the worker payload exactly ONCE and reduces the declared
   * comparison object to a bounded token (or to a bounded marker saying why it
   * cannot be compared), bound to this proposal digest, attempt, plan revision and
   * the validation the submission is about to be judged by. The raw payload never
   * travels further: the transaction compares a token, and what it persists is the
   * baseline and the counters.
   *
   * A group is projected only when the DECLARED POLICY governs this submission —
   * the group declares this outcome as its continuation and this node as a member.
   * An outcome that exits the loop, or terminates its node, is never measured and
   * never refused for a missing subject. A projection refusal is returned as the
   * runtime refusal it is (nothing is written), and an unreadable or
   * unrepresentable proposal yields no projections because the acceptance core
   * refuses those by name.
   */
  private progressProjections(
    proposal: unknown,
    identity: ExecutionIdentity,
  ): readonly ProgressProjection[] | { readonly refusal: OutcomeRuntimeRefusal } {
    const reading = readOutcomeProposal(proposal);
    if (reading.kind !== "ok") return Object.freeze([]);
    const { nodeId, outcomeId, data } = reading.proposal;
    const groups = this.plan.loopGroups.filter(
      (group) =>
        group.progress !== undefined &&
        group.continuationOutcome === outcomeId &&
        group.nodes.includes(nodeId),
    );
    if (groups.length === 0) return Object.freeze([]);
    let digest: string;
    try {
      digest = proposalDigest(reading.proposal);
    } catch {
      // Unrepresentable payloads have no content address, so there is no binding
      // to measure against; the acceptance core refuses that submission by name.
      return Object.freeze([]);
    }
    const binding = bindingOf(identity, this.planRevision, digest);
    const projections: ProgressProjection[] = [];
    for (const group of groups) {
      const policy = group.progress;
      if (policy === undefined) continue;
      const projected = projectProgress({
        binding,
        loopGroupId: group.id,
        nodeId,
        outcomeId,
        policy,
        data,
      });
      if (projected.kind === "refused") {
        const first = projected.refusals[0];
        return {
          refusal: {
            code: first.code,
            message: first.message,
            ...(first.path === undefined ? {} : { path: first.path }),
          },
        };
      }
      projections.push(projected.projection);
    }
    return Object.freeze(projections);
  }

  /**
   * The dispatch request one reducer intent becomes: runtime provenance plus the
   * credential the reducer minted for this attempt.
   */
  private requestOf(intent: OutcomeDispatchIntent): OutcomeDispatchRequest {
    return this.dispatchRequestOf(
      intent.nodeId,
      intent.attemptId,
      intent.agent,
      intent.prompt,
      intent.inputs,
      intent.credential,
    );
  }

  /** The credential-free payload one reducer intent is persisted as. */
  private dispatchPayloadOf(
    intent: OutcomeDispatchIntent,
  ): OutcomeDispatchTarget {
    return this.dispatchTargetOf(
      intent.nodeId,
      intent.attemptId,
      intent.agent,
      intent.prompt,
      intent.inputs,
    );
  }

  /**
   * The credential-free target one dispatch is persisted as.
   *
   * ONE SPELLING for the first dispatch and a successor: the effect payload of
   * an entry attempt and of a reducer intent are built by the same function, so
   * a recovery reads either one exactly the same way.
   */
  private dispatchTargetOf(
    nodeId: string,
    attemptId: string,
    agent: string,
    prompt: string,
    inputs: readonly ResolvedInput[],
  ): OutcomeDispatchTarget {
    return Object.freeze({
      graphId: this.graphId,
      planRevision: this.planRevision,
      nodeId,
      attemptId,
      agent,
      prompt,
      // ALWAYS PRESENT on a dispatch this build creates (D6): the empty list is
      // the resolved view of "this node declares no inputs", so an absent field
      // says only that the row was written before the binding existed.
      inputs,
    });
  }

  /** Build one dispatch target/request from the plan and the minted attempt. */
  private dispatchRequestOf(
    nodeId: string,
    attemptId: string,
    agent: string,
    prompt: string,
    inputs: readonly ResolvedInput[],
    credential: string,
  ): OutcomeDispatchRequest {
    return Object.freeze({
      graphId: this.graphId,
      planRevision: this.planRevision,
      nodeId,
      attemptId,
      agent,
      prompt,
      inputs,
      credential,
    });
  }

  /** The compiled node with this id, or `undefined` when the plan has none. */
  private compiledNodeOf(nodeId: string): CompiledNode | undefined {
    return this.plan.nodes.find((node) => node.id === nodeId);
  }

  /**
   * The DURABLE accepted-result read one transaction's input assembly uses (D6).
   *
   * WHY IT IS BUILT PER TRANSACTION. The facts a consumer's binding is made of
   * are read through the SAME boundary that is deciding it — the state and the
   * accepted results the transaction sees — and the attempt this transaction is
   * settling is overlaid from the validation because its accepted result is
   * written by the batch that has not landed yet (see
   * {@link JustAcceptedResult}). Everything else is read back by ATTEMPT ID:
   * what a producer accepted is looked up under the attempt the state records as
   * settled, never under "the node's latest result".
   *
   * TOTAL: a substrate without the read, a throwing read and a missing row are
   * three different answers (`unreadable`, `unreadable`, `none`) and never a
   * synthesized value. The accepted-event stream is read LAZILY — only when a
   * declared input actually resolves to an attempt — because the outcome an
   * attempt settled on is the accepted event's identity, not this record's.
   */
  private acceptedResultReaderIn(
    tx: AcceptanceLedgerTx,
    justAccepted?: JustAcceptedResult,
  ): (attemptId: string) => AcceptedResultReading {
    let outcomes: ReadonlyMap<string, string> | undefined;
    return (attemptId: string): AcceptedResultReading => {
      if (justAccepted !== undefined && justAccepted.attemptId === attemptId) {
        return Object.freeze({ kind: "facts" as const, facts: justAccepted.facts });
      }
      if (tx.readAcceptedResult === undefined) {
        return Object.freeze({
          kind: "unreadable" as const,
          reason:
            "this substrate exposes no accepted-result read " +
            "(AcceptanceLedgerTx.readAcceptedResult), so what attempt " +
            JSON.stringify(attemptId) +
            " accepted cannot be read back",
        });
      }
      outcomes ??= new Map(
        tx
          .acceptedEvents(this.graphId)
          .map((event) => [event.attemptId, event.outcomeId] as const),
      );
      const outcomeId = outcomes.get(attemptId);
      if (outcomeId === undefined) {
        return Object.freeze({ kind: "none" as const });
      }
      let record: AcceptedResultEvidence | undefined;
      try {
        record = tx.readAcceptedResult(this.graphId, attemptId);
      } catch (error) {
        return Object.freeze({
          kind: "unreadable" as const,
          reason:
            "the accepted result of attempt " +
            JSON.stringify(attemptId) +
            " could not be read (" +
            errorText(error) +
            ")",
        });
      }
      if (record === undefined) {
        return Object.freeze({ kind: "none" as const });
      }
      return Object.freeze({
        kind: "facts" as const,
        facts: Object.freeze({
          outcomeId,
          payload: record.payload,
          artifacts: record.artifacts ?? Object.freeze([]),
        }),
      });
    };
  }

  /**
   * Map a state-reading failure onto the runtime's refusal vocabulary.
   *
   * A state the strict reader refuses for an IDENTITY disagreement (another
   * graph or another plan revision) is reported as exactly that — the message
   * names which one — while a body this build cannot read stays
   * `unreadable-state`. Collapsing both would hide the one recovery failure a
   * caller can actually act on (a state bound to a superseded plan revision).
   */
  private stateRefusal(error: unknown): OutcomeRuntimeRefusal {
    if (error instanceof OutcomeStateError) {
      if (error.problem === "state-plan-mismatch") {
        return { code: "plan-revision-mismatch", message: error.message };
      }
      if (error.problem === "unsupported-state-version") {
        return { code: "unsupported-state-version", message: error.message };
      }
      return { code: "unreadable-state", message: error.message };
    }
    return {
      code: "unreadable-state",
      message:
        "outcome-runtime: the persisted state of graph " +
        JSON.stringify(this.graphId) +
        " could not be read (" +
        errorText(error) +
        ")",
    };
  }

}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Every in-flight attempt a submission can actually settle, plus a per-attempt
 * refusal for each in-flight attempt it cannot.
 *
 * An attempt whose persisted entry carries no credential (a body version that
 * predates credentials) is NOT reported as armed: recovery must refuse it, not
 * offer it as a node awaiting an outcome, because no submission can ever settle
 * it. It is reported in `refusals` instead, with the field that is missing.
 *
 * The credential ITSELF is never part of either report — the armed entry names
 * the node and attempt only, so a recovery report never becomes a second
 * distribution channel for the capability.
 */
function armedReading(state: OutcomeGraphState): {
  readonly armed: readonly OutcomeArmedNode[];
  readonly refusals: readonly OutcomeRuntimeRefusal[];
} {
  const armed: OutcomeArmedNode[] = [];
  const refusals: OutcomeRuntimeRefusal[] = [];
  state.nodes.forEach((node, index) => {
    if (node.status !== "dispatched" || node.attemptId === undefined) return;
    if (node.attemptCredentialDigest === undefined) {
      refusals.push({
        code: "credential-missing",
        path: "$.nodes[" + index + "].attemptCredentialDigest",
        message:
          "outcome-runtime: node " +
          JSON.stringify(node.nodeId) +
          " is recorded as in flight on attempt " +
          JSON.stringify(node.attemptId) +
          " but its persisted state entry carries no attempt-credential digest — " +
          "so no submission can settle it and it is reported as refused rather than armed",
      });
      return;
    }
    armed.push(Object.freeze({ nodeId: node.nodeId, attemptId: node.attemptId }));
  });
  return {
    armed: Object.freeze(armed),
    refusals: Object.freeze(refusals),
  };
}

/**
 * What a STOPPED run reports for the nodes still recorded in flight.
 *
 * Every one of them is a refusal, never an "armed" entry: `armed` promises that
 * a submission can settle the attempt, and on a stopped run no submission can —
 * the run path refuses it with the same `graph-stopped` code. The nodes are NOT
 * settled and NOT dropped: no outcome settled them, so fabricating a settlement
 * would invent a result, and the entries stay exactly as the stop left them.
 * Credential-free by construction, like every other report here.
 */
function stoppedInFlightRefusals(
  state: OutcomeGraphState,
): readonly OutcomeRuntimeRefusal[] {
  const stop = state.stop;
  if (stop === undefined) return Object.freeze([]);
  const refusals: OutcomeRuntimeRefusal[] = [];
  state.nodes.forEach((node, index) => {
    if (node.status !== "dispatched") return;
    refusals.push(
      Object.freeze({
        code: "graph-stopped" as const,
        path: "$.nodes[" + index + "].status",
        message:
          "outcome-runtime: node " +
          JSON.stringify(node.nodeId) +
          " is still recorded in flight" +
          (node.attemptId === undefined ? "" : " on attempt " + JSON.stringify(node.attemptId)) +
          ", but graph " +
          JSON.stringify(state.graphId) +
          " STOPPED (" +
          stop.reason + ": " + describeOutcomeStop(stop) +
          ") — a stopped run dispatches nothing and no submission can settle this attempt, " +
          "so it is reported as refused rather than armed",
      }),
    );
  });
  return Object.freeze(refusals);
}

/**
 * What a CONTROL-STOPPED run reports for the nodes still recorded in flight.
 *
 * The mirror of {@link stoppedInFlightRefusals} for the trusted-control case:
 * every in-flight attempt is a refusal with the `control-stopped` code and the
 * command, reason and decision time that stopped the run — never an "armed"
 * entry (no submission can settle it) and never a silent drop (the attempt is
 * still recorded, and an external execution nobody confirmed must stay
 * visible). Credential-free by construction, like every other report here.
 */
function controlledInFlightRefusals(
  state: OutcomeGraphState,
  control: RunControlRecord,
): readonly OutcomeRuntimeRefusal[] {
  const refusals: OutcomeRuntimeRefusal[] = [];
  state.nodes.forEach((node, index) => {
    if (node.status !== "dispatched") return;
    refusals.push(
      Object.freeze({
        code: "control-stopped" as const,
        path: "$.nodes[" + index + "].status",
        message:
          "outcome-runtime: node " +
          JSON.stringify(node.nodeId) +
          " is still recorded in flight" +
          (node.attemptId === undefined ? "" : " on attempt " + JSON.stringify(node.attemptId)) +
          ", but graph " +
          JSON.stringify(state.graphId) +
          " was STOPPED by the trusted control command " +
          JSON.stringify(control.command) +
          " (" +
          control.reason +
          ") — a controlled run dispatches nothing and no submission can settle this " +
          "attempt, so it is reported as refused rather than armed, and its execution (if " +
          "the host created one) is neither confirmed nor hidden by this report",
      }),
    );
  });
  return Object.freeze(refusals);
}

/**
 * The named refusal for one attempt paused on a trusted approval request (P3 item 3).
 *
 * ONE owner of the mapping from the request's own status onto the runtime's closed
 * refusal vocabulary, so the fast path and the ledger verdict answer in the same
 * words: `pending` → `approval-pending`, `rejected` → `approval-rejected`, and
 * anything else that is not `approved` → `approval-expired` (the status vocabulary
 * has exactly four members and `approved` never reaches here).
 *
 * The message names the ONLY session that can decide the request and says in so many
 * words that no submitted payload can: the gate reads the durable row, not the
 * submission, which is the whole point of separating control from outcome (§3.4).
 */
function approvalBlockRefusal(request: ApprovalRequestRecord): OutcomeRuntimeRefusal {
  const code =
    request.status === "pending"
      ? ("approval-pending" as const)
      : request.status === "rejected"
        ? ("approval-rejected" as const)
        : ("approval-expired" as const);
  const state =
    code === "approval-pending"
      ? "is still PENDING"
      : code === "approval-rejected"
        ? "was REJECTED"
        : "EXPIRED";
  return {
    code,
    path: "$.attempt_id",
    message:
      "outcome-runtime: attempt " +
      JSON.stringify(request.attemptId) +
      " of node " +
      JSON.stringify(request.nodeId) +
      " in graph " +
      JSON.stringify(request.graphId) +
      " is PAUSED on a trusted approval request that " +
      state +
      " (raised at " +
      String(request.requestedAt) +
      ", deadline " +
      String(request.expiresAt) +
      ", reason " +
      JSON.stringify(request.reason) +
      "), so nothing was accepted: no receipt, no accepted event, no accepted result " +
      "and no state advance was written. Approval is CONTROL, not an outcome — no field " +
      "of a submission (an `approved` flag, a claim inside `data`, any other content) " +
      "can satisfy it — and only session " +
      JSON.stringify(request.approverSessionId) +
      " can decide it through the trusted control entry",
  };
}

/**
 * The run identity minted for one graph's execution.
 *
 * DERIVED, NOT RANDOM, so the same (graph, decision time) always names the same
 * run and a test can predict it. Uniqueness is per graph — the run row's key —
 * and the graph id is part of the value so an id in a report is readable. A
 * RE-EXECUTION uses {@link reexecutionRunIdentityOf} instead, which adds the
 * run's own sequence so a successor can never collide with the id a first run
 * derived from the same instant.
 */
function runIdentityOf(graphId: string, startedAt: number): string {
  return graphId + "@" + String(startedAt);
}

/**
 * The run identity minted for one RE-EXECUTION of a graph.
 *
 * DERIVED, NOT RANDOM, like {@link runIdentityOf}, and it carries the run's own
 * sequence so two re-executions decided at the same millisecond cannot collide:
 * `run_seq` is unique within a graph by the store's own key, so the id a
 * successor proposes is unique by construction rather than by retry.
 */
function reexecutionRunIdentityOf(
  graphId: string,
  startedAt: number,
  runSeq: number,
): string {
  return graphId + "@" + String(startedAt) + "+" + String(runSeq);
}

/** The two facts a re-execution needs from a snapshot it may not be able to verify. */
interface RawRunPosition {
  readonly phase: OutcomeGraphPhase;
  readonly attemptSeq: number;
}

/**
 * Read one state body's PHASE and ATTEMPT COUNTER without verifying it against a
 * plan.
 *
 * WHY A DEFENSIVE READ IS REQUIRED HERE. Re-executing a graph is exactly the
 * operation that may run a CHANGED plan revision, and a snapshot of an earlier
 * revision cannot be verified against this plan's contracts or topology — the
 * strict reader would refuse it. These two facts are the exception: the phase
 * says whether the run is over, and the counter says where the graph-wide
 * attempt sequence stands. Both are read as VALUES, with a shape check, and
 * anything else about the body is ignored rather than trusted: nothing here
 * decides what the old run meant, and a body that does not carry them refuses
 * the re-execution instead of guessing a counter (a guessed one could mint an
 * attempt id an earlier run already used).
 */
function rawRunPositionOf(body: unknown): RawRunPosition | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const phase = record["phase"];
  const attemptSeq = record["attemptSeq"];
  if (phase !== "ready" && phase !== "executing" && phase !== "complete" && phase !== "stopped") {
    return undefined;
  }
  if (
    typeof attemptSeq !== "number" ||
    !Number.isSafeInteger(attemptSeq) ||
    attemptSeq < 0
  ) {
    return undefined;
  }
  return Object.freeze({ phase, attemptSeq });
}

/**
 * Internal: a re-execution whose conditional write did not land.
 *
 * Thrown INSIDE the minting transaction so the whole transaction rolls back —
 * the run row, the order's successor link and every effect it wrote — and caught
 * by {@link OutcomeGraphRuntime.reexecute}, which reports the race as a value.
 * It carries no message a caller sees verbatim: the refusal's own wording is the
 * report.
 */
class ReexecutionRacedError extends Error {
  constructor(readonly step: string) {
    super(step);
    this.name = "ReexecutionRacedError";
  }
}

/** The state's progress for one node, when that node is currently in flight. */
function dispatchedNodeOf(
  state: OutcomeGraphState,
  nodeId: string,
): OutcomeNodeState | undefined {
  const node = stateNodeOf(state, nodeId);
  return node?.status === "dispatched" ? node : undefined;
}

/**
 * The state's entry for one node, whatever its status.
 *
 * Recovery needs the settled case too: an effect whose attempt has settled is
 * COMPLETE, and reporting it as "the state does not record that attempt as in
 * flight" would turn a finished dispatch into a disagreement.
 */
function stateNodeOf(
  state: OutcomeGraphState,
  nodeId: string,
): OutcomeNodeState | undefined {
  for (const node of state.nodes) {
    if (node.nodeId === nodeId) return node;
  }
  return undefined;
}

/** What reading a raw host-completion delivery produced. */
type HostCompletionFactReading =
  | { readonly kind: "ok"; readonly fact: HostCompletionFact }
  | { readonly kind: "malformed"; readonly issues: readonly OutcomeRuntimeRefusal[] };

/**
 * Read an untrusted value as a {@link HostCompletionFact}.
 *
 * TOTAL, and CLOSED exactly like the bearer channel's envelope
 * (`natural-completion.ts`): the three fields must be non-empty strings and any
 * other key is refused BY NAME — an `outcomeId`, a payload or an evidence list
 * offered alongside a completion fact is not dropped, because a completion that
 * could carry a result would be a second submission channel. A property read
 * that throws (an accessor, a hostile Proxy) is contained as one more malformed
 * issue rather than escaping.
 */
function readHostCompletionFact(value: unknown): HostCompletionFactReading {
  const issues: OutcomeRuntimeRefusal[] = [];
  const malformed = (path: string, message: string): void => {
    issues.push({ code: "malformed-host-completion", path, message });
  };
  try {
    if (!isRecord(value)) {
      return {
        kind: "malformed",
        issues: [
          {
            code: "malformed-host-completion",
            path: "$",
            message:
              "a host-completion delivery is a record of { nodeId, attemptId, executionId }, " +
              "received " +
              describeValue(value),
          },
        ],
      };
    }
    for (const key of Object.keys(value)) {
      if (key !== "nodeId" && key !== "attemptId" && key !== "executionId") {
        malformed(
          "$." + key,
          "unknown key " +
          JSON.stringify(key) +
          " — a host-completion delivery carries only the node, the attempt and the host " +
          "execution that finished, and an unrecognized field is refused rather than " +
          "dropped: a completion fact is not a submission and has no channel for an outcome, " +
          "a payload or evidence",
        );
      }
    }
    // Read each field EXACTLY ONCE into a local, so an accessor-backed record
    // cannot answer one value to the check and another to the construction.
    const nodeId = nonEmptyString(value.nodeId);
    if (nodeId === undefined) {
      malformed(
        "$.nodeId",
        "nodeId is " + describeValue(value.nodeId) + ", not a non-empty node id",
      );
    }
    const attemptId = nonEmptyString(value.attemptId);
    if (attemptId === undefined) {
      malformed(
        "$.attemptId",
        "attemptId is " + describeValue(value.attemptId) + ", not a non-empty attempt id",
      );
    }
    const executionId = nonEmptyString(value.executionId);
    if (executionId === undefined) {
      malformed(
        "$.executionId",
        "executionId is " +
        describeValue(value.executionId) +
        ", not the non-empty host execution id the platform named",
      );
    }
    if (nodeId === undefined || attemptId === undefined || executionId === undefined) {
      return { kind: "malformed", issues };
    }
    return {
      kind: "ok",
      fact: Object.freeze({ nodeId, attemptId, executionId }),
    };
  } catch (error) {
    return {
      kind: "malformed",
      issues: [
        {
          code: "malformed-host-completion",
          path: "$",
          message:
            "the host-completion delivery could not be read (" + errorText(error) + ")",
        },
      ],
    };
  }
}

/** What reading a persisted dispatch-effect payload produced. */
type DispatchPayloadReading =
  | { readonly kind: "ok"; readonly target: OutcomeDispatchTarget }
  | { readonly kind: "malformed"; readonly message: string };

/**
 * Read one dispatch effect's persisted payload as a dispatch TARGET.
 *
 * The payload is JSON the ledger stored verbatim, so it is UNTRUSTED here
 * even though this runtime wrote it: the graph and plan revision it names must
 * be this runtime's own, every field must be a non-empty string, and anything
 * else is a malformed effect that is REPORTED rather than launched at a
 * guessed target. A payload that carries a `credential` key is malformed too:
 * the credential is never persisted on an effect, so one there means the row
 * was written by something that is not this runtime.
 */
function readDispatchRequest(
  payload: unknown,
  graphId: string,
  planRevision: string,
): DispatchPayloadReading {
  if (!isRecord(payload)) {
    return {
      kind: "malformed",
      message:
        "a dispatch effect payload is " +
        describeValue(payload) +
        ", not a dispatch request record",
    };
  }
  const namedGraph = nonEmptyString(payload.graphId);
  if (namedGraph !== graphId) {
    return {
      kind: "malformed",
      message:
        "dispatch request names graph " +
        describeValue(payload.graphId) +
        ", not " +
        JSON.stringify(graphId),
    };
  }
  const namedRevision = nonEmptyString(payload.planRevision);
  if (namedRevision !== planRevision) {
    return {
      kind: "malformed",
      message:
        "dispatch request names plan revision " +
        describeValue(payload.planRevision) +
        ", not " +
        JSON.stringify(planRevision),
    };
  }
  if (payload.credential !== undefined) {
    return {
      kind: "malformed",
      message:
        "a dispatch effect payload carries a credential — this runtime never persists one on an " +
        "effect, so the row was not written by this runtime and is not launched",
    };
  }
  const nodeId = nonEmptyString(payload.nodeId);
  const attemptId = nonEmptyString(payload.attemptId);
  const agent = nonEmptyString(payload.agent);
  const prompt = nonEmptyString(payload.prompt);
  if (
    nodeId === undefined ||
    attemptId === undefined ||
    agent === undefined ||
    prompt === undefined
  ) {
    return {
      kind: "malformed",
      message:
        "a dispatch request carries a node, attempt, agent and prompt that are not all " +
        "non-empty strings",
    };
  }
  // THE BOUND INPUT VIEW IS DECODED WITH THE STATE READER'S OWN RULES (D6), so a
  // body the state accepts is exactly a payload this accepts. ABSENT is read as
  // absent — a row written before this build bound inputs — and a row that
  // carries a malformed one is REPORTED rather than launched at a guessed view.
  let inputs: readonly ResolvedInput[] | undefined;
  if (payload.inputs !== undefined) {
    const reading = readResolvedInputs(payload.inputs, "$.inputs");
    if (reading.kind === "malformed") {
      return { kind: "malformed", message: reading.message };
    }
    inputs = reading.entries;
  }
  return {
    kind: "ok",
    target: Object.freeze({
      graphId,
      planRevision,
      nodeId,
      attemptId,
      agent,
      prompt,
      ...(inputs === undefined ? {} : { inputs }),
    }),
  };
}

/** A non-empty string, or `undefined` — the dispatch payload's field rule. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Whether a value is a non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * The submission id of one proposal: its canonical content digest, in the
 * namespace of the channel that settled.
 *
 * CONTENT-ADDRESSED on purpose. One logical submission is one proposal content
 * for one attempt, so a retried submission derives the SAME key and the ledger
 * replays the persisted decision instead of writing a second receipt. The
 * NAMESPACE is the provenance: the ordinary ingress always derives
 * `submission:<digest>`, the natural-completion channel derives
 * `natural-completion:<digest>` (see `natural-completion.ts`), and the
 * persisted receipt and accepted event therefore say which channel committed.
 * The two namespaces cannot collide, and a proposal's content cannot choose
 * one — only the runtime's own `source` can.
 *
 * A proposal that cannot be digested at all gets a placeholder key: the digest
 * failure is the acceptance core's refusal to report, and nothing is written
 * under either key.
 */
function submissionIdOf(proposal: unknown, source: SettlementSource): string {
  const reading = readOutcomeProposal(proposal);
  if (reading.kind !== "ok") return "unclaimed-submission";
  try {
    const digest = proposalDigest(reading.proposal);
    return source === "natural-completion"
      ? naturalCompletionSubmissionId(digest)
      : "submission:" + digest;
  } catch {
    return "unrepresentable-submission";
  }
}

/**
 * Map one UNRESOLVED declared input onto the runtime's refusal vocabulary (D6).
 *
 * The input's own code is NAMED inside the message rather than replacing the
 * runtime code: `dispatch-input-unbound` says what was not done (a dispatch
 * that would have started with a hole), and the nested code says exactly which
 * rule refused it, so a caller diagnoses from one value.
 */
function inputRefusalOf(refusal: DownstreamInputRefusal): OutcomeRuntimeRefusal {
  return {
    code: "dispatch-input-unbound",
    path: "$.nodes." + refusal.from + ".inputs",
    message:
      "outcome-runtime: the dispatch of a node that consumes " +
      JSON.stringify(refusal.from) +
      "/" +
      JSON.stringify(refusal.outcome) +
      " was NOT created [" +
      refusal.code +
      "]: " +
      refusal.message,
  };
}

/** Map an acceptance-core refusal onto the runtime's vocabulary verbatim. */
function toRuntimeRefusal(refusal: SubmissionRefusal): OutcomeRuntimeRefusal {
  return {
    code: refusal.code,
    message: refusal.message,
    ...(refusal.path === undefined ? {} : { path: refusal.path }),
  };
}
