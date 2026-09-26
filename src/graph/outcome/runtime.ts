import { errorText } from "../../utils/error-text.ts";
import { OutcomeRuntimeBudget } from "./runtime-budget.ts";
import { completionCapabilityRefusal, protocolCapabilityRefusal } from "./runtime-capabilities.ts";
import {
  approvalBlockRefusal,
  controlStopRefusal,
  controlledInFlightRefusals,
  inputRefusalOf,
  ledgerReadRefusal,
  readRuntimeClock,
  refusalForStoppingDecision,
  refused,
  runControl,
  stateRefusal,
  stoppedInFlightRefusals,
  stoppingDecisionOf,
  toRuntimeRefusal,
} from "./runtime-refusals.ts";
import { OutcomeDispatchRecovery } from "./runtime-recovery.ts";
import { resolveSettlementIdentity } from "./settlement-identity.ts";
import {
  ReexecutionRacedError,
  armedReading,
  rawRunPositionOf,
  readHostCompletionFact,
  reexecutionRunIdentityOf,
  runIdentityOf,
  type SettlementSource,
} from "./runtime-readings.ts";
import type {
  AttemptCredentialReissueFence,
  OutcomeRuntimeRefusal,
  OutcomeStartResult,
  OutcomeReexecutionResult,
  OutcomeSubmissionResult,
  OutcomeNaturalSettlementResult,
  OutcomeHostDerivedSettlementResult,
  OutcomeResumeResult,
  OutcomeBudgetUsageReport,
  OutcomeBudgetReading,
  OutcomeBudgetUsageOutcome,
  OutcomeGraphRuntimeOptions,
  HostCompletionExecution,
  HostCompletionAuthority,
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
  OutcomeHostDerivedSettlementResult,
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

import type { CompiledPlan } from "../compiler/plan.ts";
import type {
  AcceptanceLedger,
  AcceptanceLedgerTx,
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
  mintAttemptCredential,
  type AttemptCredentialSource,
} from "./attempt-credential.ts";
import {
  credentialIsolationRefusal,
  readCredentialIsolationStore,
  type CredentialIsolationCapability,
  type CredentialIsolationStore,
} from "./credential-isolation.ts";
import {
  hostIdentityRefusal,
  readCurrentHostIdentity,
  type HostIdentityCapability,
  type HostIdentityReading,
  type HostInvocationIdentity,
} from "./host-identity.ts";
import {
  blockingReexecutionEffectsOf,
  dispatchEffectIdOf,
  normalizeOutcomeDispatch,
  type NormalizedOutcomeDispatch,
  type OutcomeDispatchRequest,
} from "./dispatch-effects.ts";
import type { CompletionPolicyRegistry } from "../policy/completion-policy.ts";
import {
  acceptedResultReaderOf,
  assembleDownstreamInput,
  type DownstreamInputRefusal,
  type JustAcceptedResult,
} from "./inputs.ts";
import { proposalDigest, readOutcomeProposal } from "./proposal.ts";
import {
  naturalCompletionAuthorityOf,
  naturalCompletionProposalOf,
  naturalCompletionSettlementOf,
  readNaturalCompletionDelivery
} from "./natural-completion.ts";
import {
  hostDerivedProposalOf,
  hostDerivedSettlementOf,
  readHostDerivedCompletionFact
} from "./host-derived.ts";
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
  /**
   * THE DISPATCH AND CREDENTIAL-RECOVERY COLLABORATOR (D8, plan §3.3): the
   * launch seam, the restart reconciliation, the credential-store reads and the
   * conditional re-issue. It is built from THIS runtime's own seam and
   * identities and holds no fact the runtime does not already own.
   */
  private readonly recovery: OutcomeDispatchRecovery;

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
    this.recovery = new OutcomeDispatchRecovery({
      graphId: this.graphId,
      planRevision: this.planRevision,
      plan: this.plan,
      ledger: this.ledger,
      dispatch: this.dispatch,
      reissueFence: this.reissueFence,
      credentialStore: this.credentialStore,
      credentialSource: this.credentialSource,
    });
  }

  /**
   * Dispatch the plan's entry nodes and persist the starting state.
   *
   * IDEMPOTENT: a graph that already has a state snapshot is reported as
   * `already-started` and NOT re-dispatched — re-running an entry node would
   * overwrite the attempt a settled node's replay identity depends on.
   */
  start(now?: number): OutcomeStartResult {
    // THE RUN PREFLIGHT, in its one order (see {@link runPreflight}).
    const preflight = this.runPreflight(now);
    if ("refusal" in preflight) return refused([preflight.refusal]);
    const { at, dispatchIdentity } = preflight;

    // A RUN-WIDE TRUSTED CONTROL COMMAND OUTRANKS STARTING (P3 item 1). A run
    // that was cancelled or budget-stopped is never begun again — not by a re-declare
    // whose id resolves to a stopped run, and not by a recovery window that
    // found the run row without a snapshot. The check runs before anything is
    // read as this plan's state and before anything is written, so the stop is
    // preserved exactly as it was recorded.
    const control = runControl(this.ledger, this.graphId);
    if (control !== undefined) return refused([controlStopRefusal(this.graphId, control)]);

    let existing: OutcomeGraphState | undefined;
    try {
      existing = this.state();
    } catch (error) {
      return refused([stateRefusal(this.graphId, error)]);
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
    this.recovery.launch(run.dispatched);
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
        acceptedResultReaderOf(this.graphId, tx),
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
        this.recovery.dispatchRequestOf(
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
          payload: this.recovery.dispatchTargetOf(
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
    // THE RUN PREFLIGHT, in its one order (see {@link runPreflight}).
    const preflight = this.runPreflight(now);
    if ("refusal" in preflight) return refused([preflight.refusal]);
    const { at, dispatchIdentity } = preflight;

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

    const read = this.readStateRecord();
    if ("refusal" in read) return refused([read.refusal]);
    const record = read.record;
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
        return refused([stateRefusal(this.graphId, error)]);
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
    this.recovery.launch(started.dispatched);
    const armed = armedReading(started.state);
    const unsettled = this.recovery.unsettledEffectReading();
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
    // THE RUN PREFLIGHT, in its one order, with THIS CALL's own D9 identity when
    // the caller captured it (see {@link runPreflight} and {@link submit}).
    const preflight = this.runPreflight(now, invocation);
    if ("refusal" in preflight) return refused([preflight.refusal]);
    const { at, hostIdentity } = preflight;
    // A RUN-WIDE TRUSTED CONTROL COMMAND ENDS THE RUN (P3 item 1): only a
    // `cancel` or a `budget-stop` records the run's control fact, and no
    // submission — the worker's or the host's — advances a run it stopped. A
    // NODE-SCOPED `failure`/`timeout` does NOT stop the run: it ends one
    // attempt, so it is checked against the attempt below, after the identity is
    // resolved. This check runs BEFORE the state is read and before anything is
    // written, so a late settlement cannot resurrect a run control already
    // ended, and the refusal names the command, its reason and who decided it.
    //
    // IT IS NOT THE ONLY CHECK. The declared gates, the payload read and the
    // progress projection below all run OUTSIDE the acceptance transaction, so
    // a command that commits in that window would be followed by a business
    // success unless the SAME fact is re-read inside the transaction. It is:
    // see the join below, which refuses with the identical `control-stopped`
    // refusal and rolls the whole transaction back.
    const control = runControl(this.ledger, this.graphId);
    if (control !== undefined) return refused([controlStopRefusal(this.graphId, control)]);

    const read = this.readStateRecord();
    if ("refusal" in read) return refused([read.refusal]);
    const record = read.record;
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
    const stateReading = this.readPlanState(record);
    if ("code" in stateReading) return refused([stateReading]);
    const state = stateReading;

    const identity = resolveSettlementIdentity(
      {
        graphId: this.graphId,
        plan: this.plan,
        planRevision: this.planRevision,
      },
      proposal,
      state,
      hostIdentity,
      source,
      expectedAttemptId,
      hostCompletion,
    );
    if ("refusal" in identity) return refused([identity.refusal]);
    // A STOPPED ATTEMPT ACCEPTS NOTHING (P3 item 1). A trusted `failure`,
    // `timeout`, `cancel` or `budget-stop` that names THIS attempt ended it, so
    // nothing this submission carries can settle it — the attempt's result would
    // be a second, contradictory terminal fact about an execution a trusted
    // principal already declared over. The check runs AFTER the attempt is
    // resolved (the decision is keyed by attempt) and BEFORE the declared gates
    // are evaluated, so a stopped attempt costs no validation work.
    //
    // THE RUN IS NOT WHAT STOPPED — UNLESS IT IS. A node-scoped stop claims no
    // run fact (see `applyStopCommand`), so siblings keep executing and still
    // settle; a run-wide `cancel`/`budget-stop` DOES claim it, and the check
    // above applies first. THE TWO READS ARE NOT ONE TRANSACTION, though, so
    // the answer is CLASSIFIED against the run fact as it stands NOW, AFTER the
    // decision was read (`refusalForStoppingDecision`): a run-wide command that
    // claimed the run between the check above and this one would otherwise be
    // answered with the attempt-level code and a message saying the run still
    // executes — false from the instant that command committed. It is NOT the
    // guarantee either: validation and the progress projection run outside the
    // acceptance transaction, so the ledger's own guarded INSERT re-reads the
    // same decision inside it (verdict `attempt-stopped`, classified the same
    // way) and whichever of a stopping command and an acceptance commits first
    // is the fact that stands.
    const stoppedAttempt = stoppingDecisionOf(this.ledger, this.graphId, identity.attemptId);
    if (stoppedAttempt !== undefined) {
      return refused([
        refusalForStoppingDecision(
          this.graphId,
          stoppedAttempt,
          runControl(this.ledger, this.graphId),
        ),
      ]);
    }
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
      // a `cancel` or a `budget-stop` that commits during that window
      // would otherwise be followed by an accepted event, a receipt, a state
      // advance and the successor's dispatch effect: a business success forged
      // on top of a run a trusted command stopped. (A node-scoped `failure` or
      // `timeout` needs no re-read here: `commitAccepted`'s own receipt INSERT
      // carries the attempt-stop guard, so the batch is refused inside the very
      // statement that would write it.) Re-reading the run's control
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
        return refused([controlStopRefusal(this.graphId, error.control)]);
      }
      if (error instanceof OutcomeAdvanceRefusedError) {
        return refused([{ code: error.code, message: error.message }]);
      }
      if (error instanceof OutcomeStateError) {
        return refused([stateRefusal(this.graphId, error)]);
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
      return refused([controlStopRefusal(this.graphId, verdict.control)]);
    }
    // AN ATTEMPT PAUSED ON A TRUSTED APPROVAL ACCEPTS NOTHING (P3 item 3). The
    // ledger's own guard refused the batch because the attempt carries an
    // approval request whose status is not `approved` — or because a raising
    // command committed while this submission was being validated — so nothing
    // was accepted and the request is answered by name. This is the INVERSE half
    // of the rule the fast path below applies before validation: whichever of the
    // raising command and the acceptance COMMITS first is the fact that stands,
    // and no field of the submission is consulted either way.
    // A STOPPED ATTEMPT ACCEPTS NOTHING (P3 item 1). The ledger's own guard
    // refused the batch because a stopping decision for this attempt committed
    // while the submission was being decided — after the fast path above read
    // the attempt's decisions — so nothing was written and the attempt is
    // answered by name. The RUN itself is not stopped: this is deliberately not
    // `control-stopped`, and the siblings of this attempt keep executing. The
    // ledger classified those two facts inside the transaction it rolled back,
    // so the answer is classified again on the facts that stand NOW (see
    // `refusalForStoppingDecision`): a run-wide command that claimed the run
    // since then is answered `control-stopped`, never with a message about a
    // run that is in fact stopped.
    if (verdict.kind === "attempt-stopped") {
      return refused([
        refusalForStoppingDecision(
          this.graphId,
          verdict.decision,
          runControl(this.ledger, this.graphId),
        ),
      ]);
    }
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
        ? planned.dispatches.map((intent) => this.recovery.requestOf(intent))
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
    this.recovery.launch(dispatched);
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
    const authorization = naturalCompletionAuthorityOf(this.plan, this.planRevision, reading.delivery.nodeId);
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
    const authentication = this.authenticatedHostExecution(fact, {
      unavailable:
        "outcome-runtime: a host completion fact for attempt " +
        JSON.stringify(fact.attemptId) +
        " of graph " +
        JSON.stringify(this.graphId) +
        " arrived through the host-completion channel, but this runtime holds no " +
        "host-completion authority: no durable execution record can corroborate the fact, " +
        "and a completion is never settled on the caller's word (plan §3.3). Nothing was " +
        "written; the host must inject the authority it can substantiate",
      threw: "nothing was written",
      missing:
        "this completion has no host fact to authenticate against — a delivery " +
        "observation alone is not a completion and nothing was written",
      delivery: "the delivery",
    });
    if ("refusal" in authentication) return refused([authentication.refusal]);
    const execution = authentication.execution;
    // The authorization is a PLAN-LEVEL fact, resolved before the state is
    // touched, exactly as it is on the bearer channel: the host-completion
    // channel settles the same pinned mapping and never an outcome of its own.
    const authorization = naturalCompletionAuthorityOf(this.plan, this.planRevision, fact.nodeId);
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
   * Settle one attempt from the outcome the WORKER'S OWN LAST TURN declared —
   * the HOST-DERIVED completion channel (defect 2).
   *
   * WHY IT EXISTS. An execution can end without ever presenting an outcome: a
   * worker that timed out, a process killed mid-turn, a provider that returned
   * no final submission. The outcome is NOT invented to fill that gap — the
   * worker's own final turn declared it and the HOST reads the declaration from
   * the turn it already holds — and this entry settles it through the SAME
   * acceptance core as every other channel, so the plan still decides whether
   * the named outcome exists (an undeclared one is refused by the core) and
   * whether it passes its declared gates (a failing gate is a REJECTION, and
   * the attempt stays open).
   *
   * CREDENTIAL-FREE BY CONSTRUCTION. The fact's shape has no credential and an
   * unknown key is refused by name, so nothing can present a bearer here; the
   * attempt is instead resolved by the SAME credential-free identity path
   * `settleHostCompletion` uses (persisted state + the delivery's attempt name
   * + the host's durable execution record), which already refuses a proposal
   * that carries a credential. No tool binds this entry: a worker cannot reach
   * it, and the outcome it carries is the worker's own declaration rather than
   * anything the host chooses.
   *
   * THE ORDER OF THE CHECKS IS THE RULE:
   * 1. the ENVELOPE — a malformed fact is not a fact, so an unknown key (a
   *    `credential`, an `approved` flag, a second outcome field) is refused by
   *    name before the plan, the authority or the ledger is consulted;
   * 2. the CLOCK;
   * 3. the HOST COMPLETION AUTHORITY — absent means no durable record can
   *    corroborate the fact, so nothing is settled on the caller's word;
   * 4. the host's OWN record for THIS attempt — an authority that throws, holds
   *    no confirmed execution, or names a DIFFERENT execution refuses by name,
   *    and the fact is never re-bound to whichever execution happens to exist;
   * 5. the PLAN'S COMPLETION POLICY — a node whose plan pinned a natural
   *    completion is refused with `derived-completion-natural-node`: the plan
   *    already chose that node's outcome, and this channel must not choose
   *    another (an absent or `explicit` policy is allowed);
   * 6. the ONE settlement path, with the host's execution as the proof.
   */
  settleHostDerivedCompletion(
    delivery: unknown,
    now?: number,
  ): OutcomeHostDerivedSettlementResult {
    // (1) The envelope is read FIRST, exactly as the other channels read their
    // own: a malformed completion fact is not a completion.
    const reading = readHostDerivedCompletionFact(delivery);
    if (reading.kind === "malformed") {
      return refused(
        reading.issues.map((issue) => ({
          code: issue.code,
          path: issue.path,
          message: issue.message,
        })),
      );
    }
    const fact = reading.fact;
    // (2) Time is an explicit input.
    const at = readRuntimeClock(this.clock, now);
    if (typeof at !== "number") return refused([at]);
    // (3) THE HOST'S DURABLE RECORD, or nothing: this channel has no bearer to
    // check, so the authority IS its authentication and an absent capability is
    // a refusal rather than a downgrade.
    // (4) THE HOST'S OWN FACT FOR THIS ATTEMPT — asked with the attempt identity
    // only, never with a credential, and never re-bound: a throw is an
    // unanswered question, `undefined` is "no confirmed execution", and a
    // different id is a disagreement. In all three cases the delivery is refused.
    const authentication = this.authenticatedHostExecution(fact, {
      unavailable:
        "outcome-runtime: the outcome the worker's own last turn declared for attempt " +
        JSON.stringify(fact.attemptId) +
        " of graph " +
        JSON.stringify(this.graphId) +
        " arrived through the host-derived channel, but this runtime holds no " +
        "host-completion authority: no durable execution record can corroborate it, and " +
        "an outcome is never settled on the caller's word (plan §3.3). Nothing was " +
        "written; the host must inject the authority it can substantiate",
      threw: "the host-derived completion was not settled and nothing was written",
      missing:
        "the host-derived completion has no host fact to authenticate against — " +
        "the worker's last turn alone is not a completion and nothing was written",
      delivery: "the derived completion",
    });
    if ("refusal" in authentication) return refused([authentication.refusal]);
    const execution = authentication.execution;
    // (5) THE PLAN'S OWN COMPLETION POLICY DECIDES WHETHER THIS CHANNEL MAY
    // CHOOSE. A node whose plan pinned a natural completion has exactly ONE
    // authorized outcome, already decided by the plan: settling it here would let
    // the worker's last turn pick a different one, so the channel refuses BY NAME
    // instead. A plan that left the policy absent, or declared it `explicit`,
    // leaves the outcome to the attempt — which is exactly what this channel
    // carries — and the declared outcomes and gates decide the rest.
    const node = this.plan.nodes.find((entry) => entry.id === fact.nodeId);
    if (node?.completion?.mode === "natural") {
      return refused([
        {
          code: "derived-completion-natural-node",
          path: "$.nodeId",
          message:
            "outcome-runtime: node " +
            JSON.stringify(fact.nodeId) +
            " of plan revision " +
            this.planRevision +
            " declares a NATURAL completion into outcome " +
            JSON.stringify(node.completion.outcome) +
            ", so the plan has already pinned which outcome settles this node — the " +
            "host-derived channel carries the outcome the worker's own last turn declared " +
            "and must not choose another, so nothing was settled; the attempt is completed " +
            "through the completion fact of the execution the host observed finishing",
        },
      ]);
    }
    // (6) THE ONE SETTLEMENT PATH. The proposal is the fact's own declaration —
    // node, outcome, payload and evidence, never a credential — and the host's
    // execution is the proof its identity resolution accepts.
    const result = this.settleSubmission(
      hostDerivedProposalOf(fact),
      at,
      "host-derived",
      fact.attemptId,
      execution,
    );
    if (result.kind === "refused") return result;
    // The provenance record names the very submission key the receipt persists,
    // derived from the canonical proposal digest the decision was addressed by.
    const completion = hostDerivedSettlementOf({
      nodeId: fact.nodeId,
      attemptId: fact.attemptId,
      outcomeId: fact.outcomeId,
      proposalDigest: result.decision.proposalDigest,
      ...(fact.derivation === undefined ? {} : { derivation: fact.derivation }),
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
   * THE HOST-AUTHENTICATION PREAMBLE the two host-completion channels share
   * (P2 items 6/7): the authority that must exist, the host's own durable record
   * for THIS attempt, and the three answers that fail to authenticate the fact —
   * a throw, no confirmed execution, and a DIFFERENT execution. Every step
   * refuses by NAME and the fact is never re-bound to whichever execution
   * happens to exist.
   *
   * The caller supplies its OWN wording: the two entry points name the same
   * failures in their own terms — the delivery channel speaks of the completion
   * fact it was handed, the host-derived channel of the outcome the worker's
   * last turn declared — and those sentences are part of each channel's
   * contract, so they stay with the entry point that owns them.
   */
  private authenticatedHostExecution(
    fact: { readonly attemptId: string; readonly executionId: string },
    wording: {
      /** The refusal when this runtime holds no host-completion authority. */
      readonly unavailable: string;
      /** What follows "…an authenticated execution, so " when the authority throws. */
      readonly threw: string;
      /** What follows ", so " when the host holds no confirmed execution. */
      readonly missing: string;
      /** How this channel names the fact in the execution-id disagreement. */
      readonly delivery: string;
    },
  ):
    | { readonly execution: HostCompletionExecution }
    | { readonly refusal: OutcomeRuntimeRefusal } {
    const authority = this.hostCompletions;
    if (authority === undefined) {
      return {
        refusal: {
          code: "host-completion-unavailable",
          path: "$.hostCompletions",
          message: wording.unavailable,
        },
      };
    }
    let execution: HostCompletionExecution | undefined;
    try {
      execution = authority.executionFor(
        Object.freeze({ graphId: this.graphId, attemptId: fact.attemptId }),
      );
    } catch (error) {
      // The authority was handed the attempt identity only — no credential is in
      // scope on this channel — so its own failure text is quotable.
      return {
        refusal: {
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
            ") — an unanswered question is not an authenticated execution, so " +
            wording.threw,
        },
      };
    }
    if (execution === undefined) {
      return {
        refusal: {
          code: "host-completion-unauthenticated",
          path: "$.executionId",
          message:
            "outcome-runtime: the host holds no CONFIRMED execution for attempt " +
            JSON.stringify(fact.attemptId) +
            " of graph " +
            JSON.stringify(this.graphId) +
            ", so " +
            wording.missing,
        },
      };
    }
    if (execution.executionId !== fact.executionId) {
      return {
        refusal: {
          code: "host-completion-unauthenticated",
          path: "$.executionId",
          message:
            "outcome-runtime: " +
            wording.delivery +
            " names execution " +
            JSON.stringify(fact.executionId) +
            " for attempt " +
            JSON.stringify(fact.attemptId) +
            ", but the host's own record names " +
            JSON.stringify(execution.executionId) +
            " — a completion is never re-bound to whichever execution happens to exist",
        },
      };
    }
    return { execution };
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

    const initial = this.readStateRecord();
    if ("refusal" in initial) return refused([initial.refusal]);
    let record: GraphStateRecord | undefined = initial.record;

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
        const effects = this.recovery.unsettledEffectReading();
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
      const reread = this.readStateRecord();
      if ("refusal" in reread) return refused([reread.refusal]);
      record = reread.record;
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

    const stateReading = this.readPlanState(record);
    if ("code" in stateReading) return refused([stateReading]);
    const state = stateReading;

    // A RUN A RUN-WIDE TRUSTED CONTROL COMMAND STOPPED IS REPORTED, NOT
    // CONTINUED (P3 item 1). It is the same rule as the declared stop below,
    // one level up: a cancelled or budget-stopped RUN launches nothing, arms
    // nothing and reconciles nothing, so a second resume (and every boot sweep
    // after it) reports the SAME control fact and clears nothing. A node-scoped
    // `failure`/`timeout` is NOT this case — it stopped one attempt, so the run
    // continues and the reconciliation below runs, refusing to (re-)launch the
    // stopped attempt's effect.
    //
    // The attempts a RUN-WIDE stop left in flight are NOT armed — no submission
    // can settle them — and they are named in `refusals`, with their effects
    // still in `unsettledEffects`: an external execution whose fate this process
    // cannot confirm stays VISIBLE instead of being hidden to make the stop look
    // converged.
    const control = runControl(this.ledger, this.graphId);
    if (control !== undefined) {
      const stopped = this.recovery.unsettledEffectReading();
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
      const effects = this.recovery.unsettledEffectReading();
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

    const resolved = this.recovery.reconcile(state, at);
    if ("refusal" in resolved) return refused([resolved.refusal]);
    const effects = this.recovery.unsettledEffectReading();
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

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * THE RUN PREFLIGHT — the clock, the execution capability, the host's identity
   * for THIS invocation and the dispatch preconditions — performed in ONE place
   * and in ONE order, and answered as the refusals the operation would return.
   *
   * THE ORDER IS THE RULE, and it is the same for every operation that can
   * dispatch: time is an explicit input, a runtime that cannot execute refuses
   * before the host is asked anything, the identity is read ONCE for the whole
   * operation, and the dispatch preconditions are checked last — each step
   * short-circuiting, so an operation that is refused for one of them never had
   * a later check performed on its behalf.
   *
   * `invocation` is the call's OWN D9 identity when the caller captured it (see
   * {@link submit}); it wins over the ambient read for exactly the reason the
   * parameter exists.
   */
  private runPreflight(
    now: number | undefined,
    invocation?: HostIdentityReading,
  ):
    | {
      readonly at: number;
      readonly hostIdentity: HostIdentityReading;
      readonly dispatchIdentity: HostInvocationIdentity | undefined;
    }
    | { readonly refusal: OutcomeRuntimeRefusal } {
    const at = readRuntimeClock(this.clock, now);
    if (typeof at !== "number") return { refusal: at };
    const unavailable = this.executionCapabilityRefusal();
    if (unavailable !== undefined) return { refusal: unavailable };
    // The identity of THIS invocation, read ONCE for the whole operation. A
    // `refused` reading is a host failure (a throwing `current()`, a malformed
    // answer) and refuses the operation: recording the attempts with no binding
    // under a host that declared one would drop the constraint silently.
    //
    // THE CALL'S OWN READING WINS OVER THE AMBIENT ONE. A caller that captured
    // the identity synchronously passes it, so a concurrent call that moved the
    // host's shared holder cannot change what this submission is judged by.
    const hostIdentity = invocation ?? readCurrentHostIdentity(this.hostIdentity);
    if (hostIdentity.kind === "refused") return { refusal: hostIdentity.refusal };
    const dispatchIdentity =
      hostIdentity.kind === "identified" ? hostIdentity.identity : undefined;
    const undispatchable = this.dispatchPreconditionRefusal();
    if (undispatchable !== undefined) return { refusal: undispatchable };
    return { at, hostIdentity, dispatchIdentity };
  }

  /**
   * The graph's state row, or the refusal a ledger that cannot answer is
   * reported as. The read is the first thing every recovery path does — before
   * any state is interpreted and before anything is written — and the row it
   * answers is handed back as it stands, `undefined` included.
   */
  private readStateRecord():
    | { readonly record: GraphStateRecord | undefined }
    | { readonly refusal: OutcomeRuntimeRefusal } {
    try {
      return { record: this.ledger.readGraphState(this.graphId) };
    } catch (error) {
      return { refusal: ledgerReadRefusal(this.graphId, error) };
    }
  }

  /**
   * The state this PLAN reads out of one row, or the refusal a snapshot this
   * build cannot read is reported as. A state that cannot be read is never
   * silently replaced by a fresh one — see {@link state}.
   */
  private readPlanState(
    record: GraphStateRecord,
  ): OutcomeGraphState | OutcomeRuntimeRefusal {
    try {
      return readOutcomeGraphState(record, this.plan);
    } catch (error) {
      return stateRefusal(this.graphId, error);
    }
  }

  private executionCapabilityRefusal(): OutcomeRuntimeRefusal | undefined {
    return protocolCapabilityRefusal(this.protocols)
      ?? credentialIsolationRefusal(this.credentialIsolation)
      ?? hostIdentityRefusal(this.hostIdentity);
  }

  private dispatchPreconditionRefusal(): OutcomeRuntimeRefusal | undefined {
    return this.recovery.dispatchCapabilityRefusal()
      ?? completionCapabilityRefusal(this.plan, this.completionPolicies)
      ?? this.budget.capabilityRefusal();
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
      readAcceptedResult: acceptedResultReaderOf(this.graphId, tx, justAccepted),
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
      payload: this.recovery.dispatchPayloadOf(intent),
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

}
