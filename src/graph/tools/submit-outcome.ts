/**
 * Graph Execution Engine v2 — `graph_submit_outcome` (C3c submission ingress)
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The MODEL-FACING submission ingress of the outcome protocol
 * (docs/graph-outcome-protocol.md § "Submission and acceptance"): the
 * graph-scoped `submit_outcome` capability, adapted to the toolset. It is
 * ADDITIVE — a new key beside the existing `graph_*` tools, whose schemas are
 * unchanged.
 *
 * WHAT THE CALLER MAY SAY, AND NOTHING MORE. The args are exactly what a worker
 * legitimately knows: which graph, which node, which declared outcome, the
 * ATTEMPT CREDENTIAL it was handed when it was dispatched, an optional payload
 * and optional evidence references. Attempt id, submission id and plan revision
 * are NOT args and are never read from anywhere a caller can reach: the plan
 * supplies the graph identity and the plan revision, the STATE resolves the
 * attempt from the credential's persisted binding, and the canonical proposal
 * digest supplies the submission id. `src/graph/outcome/runtime.ts` derives all
 * three, and the test for this tool forges every one of them and shows they
 * cannot move.
 *
 * THE CREDENTIAL IS A BEARER CAPABILITY, NOT A SELECTOR. It names no execution a
 * caller chooses: the runtime looks it up in the state it issued it into and
 * refuses a missing, unknown, tampered, superseded or other node's credential.
 * The ingress never echoes it back — the result carries the submission id (a
 * digest of the canonical proposal, which includes the credential) but not the
 * credential itself, so a tool transcript does not become a second copy of it.
 *
 * THE PLAN IS THE PERSISTED ONE. This module never recompiles a declaration and
 * never accepts a declaration argument: it loads the graph's persisted record,
 * requires it to be bound to the OUTCOME protocol, and resolves the node's
 * contract out of the compiled plan inside it. A record that is not a valid
 * outcome-protocol state is refused by name — interpreting a severity-ranked
 * signal as an accepted outcome is exactly what this protocol forbids.
 *
 * THE SUBMISSION INGRESS IS THE ONLY COMPLETION SOURCE. Nothing here, and
 * nothing in the outcome run path, can settle a node from a dispatch
 * completion: the runtime reads only accepted outcomes committed through this
 * ingress. There is no synthesis step and no severity ranking anywhere on this
 * path.
 *
 * TIME AND EFFECTS. The clock is an explicit protocol input: the toolset may
 * pin it (`outcomeNow`) or the runtime reads it. An accepted outcome's
 * successor dispatch is recorded as a `pending` effect in the SAME transaction
 * that writes the receipt, the accepted event and the graph state, and the
 * effect is then EXECUTED through the host dispatch adapter (D8): the create
 * returns, the row is marked `started`, and a crash inside that window leaves a
 * row a later recovery puts to the host's execution query instead of guessing.
 *
 * NO DISPATCHER, NO SUBMISSION (D8). This ingress refuses with
 * `dispatch-unavailable` BEFORE it opens a ledger when no adapter is injected:
 * a no-op dispatcher would accept the outcome and record a successor dispatch
 * that no host ever created. `src/graph/outcome/dispatch-effects.ts` owns the
 * adapter contract.
 */

import type { CompiledPlan } from "../compiler/plan.ts";
import type { CompletionPolicyRegistry } from "../policy/completion-policy.ts";
import { engineStateDir } from "../persistence/engine-persistence.ts";
import {
  describeStoredReading,
  readStoredDefinition,
} from "../persistence/declared-record.ts";
import { SqliteAcceptanceLedger } from "../ledger/sqlite-ledger.ts";
import type {
  AcceptanceDecision,
  RequirementEvaluation,
} from "../outcome/acceptance.ts";
import {
  OutcomeGraphRuntime,
  type OutcomeDispatchAdapter,
  type OutcomeRuntimeRefusal,
  type OutcomeSubmissionResult,
} from "../outcome/runtime.ts";
import type {
  OutcomeGraphState,
  OutcomeStop,
} from "../outcome/graph-state.ts";
import {
  credentialIsolationRefusal,
  readCredentialIsolationAdapter,
  type CredentialIsolationCapability,
} from "../outcome/credential-isolation.ts";
import {
  hostIdentityRefusal,
  readHostIdentityCapability,
  type HostIdentityCapability,
} from "../outcome/host-identity.ts";
import {
  createValidatorRegistry,
  type ValidatorRegistry,
} from "../outcome/validators.ts";

// ── Args and result ─────────────────────────────────────────────────────────

/**
 * Arguments accepted by `graph_submit_outcome`.
 *
 * Deliberately the MINIMUM a worker may supply. There is no attempt id, no
 * submission id and no plan revision — those are runtime provenance — and the
 * payload the tool hands the runtime is built from these fields alone, so an
 * extra key on a caller's object is simply never read.
 */
export interface GraphSubmitOutcomeArgs {
  /** The declared (outcome-protocol) graph the submission belongs to. */
  readonly graph_id: string;
  /** The plan node whose outcome is claimed. */
  readonly node_id: string;
  /** The outcome id that node declares. */
  readonly outcome_id: string;
  /**
   * The attempt credential the outcome runtime issued to this worker in its
   * dispatch request, passed back verbatim.
   *
   * Optional here so a missing one is a STRUCTURED refusal
   * (`credential-missing`, path `$.credential`) rather than a schema error;
   * it is never defaulted, derived or accepted from anywhere else.
   */
  readonly credential?: string;
  /** Optional outcome payload; opaque to this boundary. */
  readonly data?: unknown;
  /** Optional artifact references the outcome's gates may require. */
  readonly evidence_refs?: readonly string[];
}

/** One acceptance requirement's outcome, as the tool reports it. */
export interface SubmitRequirementOutcome {
  readonly validator: string;
  readonly version: number;
  readonly outcome: "pass" | "fail" | "indeterminate";
  readonly reason?: string;
}

/** One structured repair diagnostic — a refusal or an unlaunchable effect. */
export interface SubmitOutcomeDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

/**
 * What `graph_submit_outcome` reports to the model.
 *
 * `refusals` is NON-EMPTY exactly when nothing was written: the proposal was
 * refused before any decision, so the caller can repair one field and submit
 * again. `decision` is present for an accepted OR rejected submission, and a
 * rejected decision carries `requirements` — every gate's own answer — so the
 * caller learns which requirement failed without re-deriving anything.
 */
export interface GraphSubmitOutcomeResult {
  readonly graph_id: string;
  readonly node_id: string;
  readonly outcome_id: string;
  /** The plan revision resolved from the PERSISTED plan (never caller input). */
  readonly plan_revision: string;
  /** The attempt the runtime derived from its own state (never caller input). */
  readonly attempt_id?: string;
  /** The submission id the runtime derived from the proposal digest. */
  readonly submission_id?: string;
  /** Present when a decision was taken; absent on a refusal. */
  readonly decision?: "accepted" | "rejected";
  /**
   * The ledger's verdict. `replayed` means this exact submission was already
   * committed and the PERSISTED receipt was returned; `committed` means this
   * call's decision is the one that landed.
   */
  readonly verdict?: "committed" | "replayed" | "conflict" | "settled";
  /** Why a conflict or settlement was refused, verbatim from the ledger. */
  readonly verdict_reason?: string;
  /** Every required gate's outcome, for an accepted or rejected decision. */
  readonly requirements?: readonly SubmitRequirementOutcome[];
  /** Structured repair diagnostics; non-empty exactly when nothing was written. */
  readonly refusals: readonly SubmitOutcomeDiagnostic[];
  /** The graph phase after an accepted decision. */
  readonly phase?: string;
  /** Nodes settled in the resulting state. */
  readonly settled_nodes?: readonly string[];
  /**
   * Present exactly when the accepted outcome STOPPED the run: the declared hard
   * limit it hit, the round it had reached and the cap itself. The outcome was
   * still accepted (so `decision` is `accepted`) — the stop is why the graph can
   * go no further, and no successor was dispatched. A submission to a stopped
   * graph is refused with `graph-stopped` in `refusals` instead.
   */
  readonly stop?: SubmitOutcomeStop;
}

/**
 * One stop as the tool reports it, in the tool's snake_case surface.
 *
 * `reason` comes from the closed vocabulary `graph-state.ts` owns
 * (`OUTCOME_STOP_REASONS`) — a condition decided from the plan and the state,
 * never a judgement about the work. The fields a reason does not define are
 * ABSENT rather than reported as zero: a hard cap stop has no baseline, and a
 * progress stop has no traversal count, so neither invents the other numbers.
 */
export interface SubmitOutcomeStop {
  readonly reason: string;
  /** The declared loop group whose cap or progress policy binds. */
  readonly loop_group_id: string;
  /** The node whose accepted outcome could not continue. */
  readonly node_id: string;
  /** The continuation outcome that asked for the refused round. */
  readonly outcome_id: string;
  /** The attempt of `node_id` that the outcome settled. */
  readonly attempt_id: string;
  /** `loop-exhausted` only: continuations the group took, equal to the cap. */
  readonly traversals?: number;
  /** `loop-exhausted` only: the declared hard cap the round would have exceeded. */
  readonly max_traversals?: number;
  /** `progress-stalled` only: consecutive unchanged comparisons, equal to the threshold. */
  readonly unchanged?: number;
  /** `progress-stalled` only: the declared stagnation threshold. */
  readonly max_unchanged?: number;
  /** `progress-stalled` only: the comparison semantics the baseline was recorded under. */
  readonly evaluator?: string;
  /** `progress-stalled` only: the exact version of that evaluator. */
  readonly evaluator_version?: number;
  /** `progress-stalled` only: the comparison object (an outcome-data field). */
  readonly subject?: string;
  /** `progress-stalled` only: the bounded revision token the run stood still on. */
  readonly baseline?: string;
  /** Epoch milliseconds the stop was committed at. */
  readonly stopped_at: number;
}

// ── Refusals at the tool boundary ───────────────────────────────────────────

/** Why the tool could not even address the submission. Stable identifiers. */
export type OutcomeSubmitRefusalReason =
  /** No declared graph holds the id — this ingress serves declared graphs only. */
  | "unknown-graph"
  /** The graph is declared in memory only: its plan never reached the store. */
  | "plan-not-persisted"
  /** The persisted record could not be read as this build's declared plan. */
  | "unreadable-plan"
  /** No state directory is configured, so the ledger has no place to live. */
  | "no-state-directory"
  /**
   * This process holds no readable HOST credential-isolation capability (D7):
   * the credential a submission is checked against has to be stored and
   * delivered by the host, so the ingress refuses before it opens a ledger
   * rather than resolving against a capability it does not have.
   */
  | "credential-isolation-unavailable"
  /**
   * This process holds NO dispatch adapter (D8). A dispatch intent has to go
   * somewhere, and a no-op dispatcher would let the run record an execution
   * nobody started (and hand no worker its attempt credential), so the ingress
   * refuses BEFORE it opens a ledger rather than simulating success.
   */
  | "dispatch-unavailable"
  /**
   * This process was handed an UNREADABLE host identity capability (D9). A
   * declared identity constraint is never downgraded to an unconstrained
   * submission, so the ingress refuses BEFORE it opens a ledger; a host that
   * declares no identity capability at all is unaffected (nothing is checked).
   */
  | "host-identity-unavailable";

/**
 * A submission the TOOL cannot address — as opposed to one the runtime refuses.
 *
 * This is a typed error rather than a result because it is not repairable by
 * editing the submission: the caller named a graph this ingress does not serve,
 * or the store is not configured. It is thrown BEFORE a ledger is opened, so a
 * refusal here writes nothing at all. The registered tool catches it and renders
 * it as `graph_submit_outcome failed: <message>`.
 */
export class OutcomeSubmissionRefusedError extends Error {
  readonly reason: OutcomeSubmitRefusalReason;
  readonly graphId: string;

  constructor(reason: OutcomeSubmitRefusalReason, graphId: string, message: string) {
    super(message);
    this.name = "OutcomeSubmissionRefusedError";
    this.reason = reason;
    this.graphId = graphId;
  }
}

// ── Target resolution ───────────────────────────────────────────────────────

/** Where a submission is addressed, as the toolset knows it. */
export interface SubmitOutcomeTarget {
  /** The workspace whose `.rolebox/state` holds the graph's records. */
  readonly workspaceDir: string | undefined;
  readonly graphId: string;
  /** Whether THIS toolset holds the id as a declared (outcome-protocol) graph. */
  readonly declaredInMemory: boolean;
}

/**
 * Resolve the STORED compiled plan of a declared graph, or refuse by name.
 *
 * Order is deliberate:
 * 1. the store's own verdict and the graph's definition are classified
 *    (absent / declared / unreadable) so each case gets its own reason;
 * 2. the stored definition is decoded through `persistence/declared-record.ts`
 *    — the strict v3 front end, the declaration digest, and the persisted-plan
 *    gate (executability, topology, contracts, node bindings, plan revision) —
 *    and a definition that fails any of them is refused rather than partially
 *    trusted.
 *
 * The plan comes from the STORE. The retired per-graph v2 container is never
 * read here, and a store this build may not read (`unsupported` / `corrupt`,
 * including a root that still holds a retired container) is refused by name
 * rather than answered as "no such graph" — which is what would let a
 * submission be judged against a plan nobody could verify.
 *
 * The declaration is never an input: there is no path here that compiles
 * anything.
 */
function resolvePersistedPlan(
  target: SubmitOutcomeTarget,
  storeDirectory: string | undefined,
): CompiledPlan {
  const { graphId } = target;
  if (storeDirectory === undefined) {
    throw new OutcomeSubmissionRefusedError(
      "no-state-directory",
      graphId,
      `graph_submit_outcome refused: no state directory is configured, so graph "${graphId}"` +
        " has no graph store to hold its compiled plan and no acceptance ledger to" +
        " commit an outcome into. Construct the toolset with a stateDir.",
    );
  }
  // ONE store read decides every branch: the store's own verdict, the definition
  // row and the plan all come from the same call, so two reads can never
  // disagree and a refusal names what is actually there.
  const reading = readStoredDefinition(storeDirectory, graphId);
  if (reading.kind === "blocked" && reading.verdict.kind === "absent") {
    // AN ABSENT STORE IS ABSENT: nothing was ever declared under this id here.
    // (No store and no retired record beside it is the one reading a caller may
    // start a graph from; every other verdict is a refusal below.)
    throw new OutcomeSubmissionRefusedError(
      target.declaredInMemory ? "plan-not-persisted" : "unknown-graph",
      graphId,
      target.declaredInMemory
        ? `graph_submit_outcome refused: graph "${graphId}" is declared in memory but its` +
          " definition never reached the graph store, so the outcome state has nowhere durable" +
          " to live. Declare it with a graph store configured and submit again."
        : `graph_submit_outcome refused: graph "${graphId}" is not a declared` +
          " (outcome-protocol) graph. This ingress serves declared graphs; call" +
          " graph_declare first.",
    );
  }
  if (reading.kind !== "ok") {
    throw new OutcomeSubmissionRefusedError(
      "unreadable-plan",
      graphId,
      `graph_submit_outcome refused: the stored record of graph "${graphId}" could not be` +
        ` read (${describeStoredReading(reading)}). A declared graph is the only kind this` +
        " ingress accepts, and it is never guessed at or overwritten.",
    );
  }
  return reading.declared.plan;
}

// ── The submission ──────────────────────────────────────────────────────────

/** Everything the ingress needs besides the target and the args. */
export interface SubmitOutcomeDeps {
  /**
   * Where a launched successor dispatch goes — the HOST dispatch adapter (D8),
   * with the create channel and the execution query.
   *
   * REQUIRED IN PRACTICE: without one this ingress refuses
   * (`dispatch-unavailable`) before it opens a ledger. A bare seam is accepted
   * as the degenerate adapter (it can create but cannot be queried); a recovery
   * that needs the query reports the effect instead of re-issuing a create.
   */
  readonly dispatch?: OutcomeDispatchAdapter;
  /** The installed validator implementations the plan's gates resolve against. */
  readonly validators?: ValidatorRegistry;
  /**
   * The HOST-INSTALLED completion-policy capability (D6). A persisted plan
   * that pins a natural-completion authorization is corroborated against it
   * before the submission is judged; without it such a plan is refused with
   * `completion-policy-unavailable` and nothing is written. A plan that pins
   * none does not need it.
   */
  readonly completionPolicies?: CompletionPolicyRegistry;
  /**
   * The HOST's credential-isolation capability (D7) — the production
   * enablement condition of this ingress, exactly as it is of the runtime.
   *
   * WITHOUT it this ingress refuses (`credential-isolation-unavailable`)
   * BEFORE it opens a ledger: the compiled plan would still be read, but the
   * credential itself is the host's to store and deliver, so nothing is opened
   * and nothing is written. With it, the ledger is opened at the adapter's
   * declared `credentialStoreRoot` instead of the workspace default.
   */
  readonly credentialIsolation?: CredentialIsolationCapability;
  /**
   * The HOST's invocation-identity capability (D9), threaded to the runtime
   * unchanged. It is the ADDITIONAL constraint on top of the bearer credential:
   * an attempt dispatched under a host identity is settled only by a submission
   * the host attributes to the same invocation. OMITTED is legal and is the
   * pre-existing behavior — nothing is recorded and nothing is checked — while a
   * value this build CANNOT READ refuses the ingress before a ledger is opened
   * (`host-identity-unavailable`), because dropping a declared constraint
   * silently is the one outcome this rule must not produce.
   */
  readonly hostIdentity?: HostIdentityCapability;
  /** Root every evidence reference must resolve inside. */
  readonly artifactRoot: string;
  /** The clock, in epoch milliseconds; omitted → the runtime reads `Date.now()`. */
  readonly now?: number;
}

/**
 * Submit one worker proposal to a declared graph's outcome run path.
 *
 * The proposal handed to the runtime is BUILT HERE from the args' own fields —
 * node, outcome, optional data and optional evidence references — so a caller's
 * extra keys cannot reach the proposal at all (the runtime's shape gate would
 * refuse them anyway; this boundary does not depend on that).
 *
 * The ledger is opened for the call and closed in a `finally`, so the ingress
 * neither leaks a handle nor keeps a connection alive between tool calls.
 */
export async function submitDeclaredOutcome(
  target: SubmitOutcomeTarget,
  args: GraphSubmitOutcomeArgs,
  deps: SubmitOutcomeDeps,
): Promise<GraphSubmitOutcomeResult> {
  // ONE store root for the whole call: the same directory the ledger is opened
  // at is the one the definition is read from, so a plan and the acceptance it
  // licenses can never come from two different stores.
  const isolation = readCredentialIsolationAdapter(deps.credentialIsolation);
  const storeDirectory =
    isolation === undefined
      ? target.workspaceDir === undefined
        ? undefined
        : engineStateDir(target.workspaceDir)
      : isolation.credentialStoreRoot;
  const plan = resolvePersistedPlan(target, storeDirectory);
  // THE HOST CAPABILITY GATE (D7) RUNS BEFORE ANY STORE IS OPENED. Without a
  // readable host credential-isolation capability this build cannot keep the
  // attempt credentials it persists out of another same-account process's
  // reach, so the ingress refuses instead of resolving a submission under a
  // protection it does not have. The refusal is thrown before
  // `SqliteAcceptanceLedger.create`, so it creates no directory and no file.
  const unprotected = credentialIsolationRefusal(deps.credentialIsolation);
  if (unprotected !== undefined) {
    throw new OutcomeSubmissionRefusedError(
      "credential-isolation-unavailable",
      target.graphId,
      "graph_submit_outcome refused [" +
        unprotected.code +
        "]: " +
        unprotected.message,
    );
  }
  // THE HOST IDENTITY GATE (D9) RUNS BEFORE ANY STORE IS OPENED, exactly like
  // the credential gate: a capability this build cannot read is a declared
  // constraint it must not silently drop, so the ingress refuses instead of
  // resolving the submission under an identity check nobody can perform. No
  // capability at all is NOT a refusal — the binding is simply not enabled.
  const unreadableHostIdentity = hostIdentityRefusal(deps.hostIdentity);
  if (unreadableHostIdentity !== undefined) {
    throw new OutcomeSubmissionRefusedError(
      "host-identity-unavailable",
      target.graphId,
      "graph_submit_outcome refused [" +
        unreadableHostIdentity.code +
        "]: " +
        unreadableHostIdentity.message,
    );
  }
  // THE DISPATCH GATE (D8) RUNS BEFORE ANY STORE IS OPENED, for the same
  // reason: an accepted outcome can arm a successor, and a run with no adapter
  // would record that dispatch as performed while no host ever saw it. The
  // refusal is thrown before `SqliteAcceptanceLedger.create`, so it creates no
  // directory and no file, exactly like the credential gate.
  if (deps.dispatch === undefined) {
    throw new OutcomeSubmissionRefusedError(
      "dispatch-unavailable",
      target.graphId,
      "graph_submit_outcome refused [dispatch-unavailable]: no dispatch adapter is " +
        "installed for this process — a dispatch intent has to have a host that creates " +
        "the execution, and a no-op would record a dispatch nobody performed. Nothing " +
        "was submitted and no ledger was opened.",
    );
  }
  // The gate above admitted only an ABSENT or READABLE capability, so this
  // normalization only ever lifts a readable host declaration. The ledger is
  // opened at the SAME root the plan was read from (see `storeDirectory`).
  const hostIdentity = readHostIdentityCapability(deps.hostIdentity);
  const ledger = await SqliteAcceptanceLedger.create(
    workspaceOf(target, storeDirectory),
  );
  try {
    const runtime = new OutcomeGraphRuntime({
      plan,
      ledger,
      dispatch: deps.dispatch,
      validators: deps.validators ?? EMPTY_VALIDATORS,
      artifactRoot: deps.artifactRoot,
      ...(isolation === undefined ? {} : { credentialIsolation: isolation }),
      ...(hostIdentity === undefined ? {} : { hostIdentity }),
      ...(deps.completionPolicies === undefined
        ? {}
        : { completionPolicies: deps.completionPolicies }),
    });
    const proposal = {
      nodeId: args.node_id,
      outcomeId: args.outcome_id,
      ...(args.credential === undefined ? {} : { credential: args.credential }),
      ...(args.data === undefined ? {} : { data: args.data }),
      ...(args.evidence_refs === undefined
        ? {}
        : { evidenceRefs: [...args.evidence_refs] }),
    };
    // The acceptance transaction committed the run state to this store, and the
    // query paths read it from there: no second durable record is refreshed.
    const result = runtime.submit(proposal, deps.now);
    return renderResult(plan, args, result);
  } finally {
    ledger.close();
  }
}

/** The store directory a submission's ledger is opened at. */
function workspaceOf(
  target: SubmitOutcomeTarget,
  storeDirectory: string | undefined,
): string {
  if (storeDirectory === undefined) {
    // Unreachable: resolvePersistedPlan refuses this before a ledger is opened.
    throw new OutcomeSubmissionRefusedError(
      "no-state-directory",
      target.graphId,
      `graph_submit_outcome refused: no state directory is configured for graph "${target.graphId}".`,
    );
  }
  return storeDirectory;
}

/**
 * The validator capability used when the caller installs none: EMPTY.
 *
 * Not a silent pass — the acceptance core refuses a requirement whose exact
 * `{ validator, version }` has no registered implementation, so an empty
 * registry can only produce refusals, never an accepted gate nobody checked.
 */
const EMPTY_VALIDATORS: ValidatorRegistry = createValidatorRegistry([]);

/** Render one runtime result into the model-facing shape. */
function renderResult(
  plan: CompiledPlan,
  args: GraphSubmitOutcomeArgs,
  result: OutcomeSubmissionResult,
): GraphSubmitOutcomeResult {
  const base = {
    graph_id: plan.graphId,
    node_id: args.node_id,
    outcome_id: args.outcome_id,
    plan_revision: plan.planRevision,
  };
  if (result.kind === "refused") {
    return {
      ...base,
      refusals: result.refusals.map(toDiagnostic),
    };
  }
  const decision = result.decision;
  const identity = {
    attempt_id: decision.identity.attemptId,
    submission_id: decision.identity.submissionId,
  };
  const requirements = requirementOutcomes(decision.requirements);
  if (result.kind === "not-committed") {
    // A not-committed verdict is a `conflict` or a `settled` (the runtime
    // narrows it), and both carry the ledger's own reason verbatim.
    const reason =
      result.verdict.kind === "conflict" || result.verdict.kind === "settled"
        ? result.verdict.reason
        : undefined;
    return {
      ...base,
      ...identity,
      decision: decision.kind,
      verdict: result.verdict.kind,
      ...(reason === undefined ? {} : { verdict_reason: reason }),
      requirements,
      refusals: [],
    };
  }
  if (result.kind === "rejected") {
    return {
      ...base,
      ...identity,
      decision: "rejected",
      verdict: "committed",
      requirements,
      refusals: [],
    };
  }
  return {
    ...base,
    ...identity,
    decision: "accepted",
    verdict: result.replayed ? "replayed" : "committed",
    requirements,
    refusals: [],
    phase: result.state.phase,
    settled_nodes: settledNodesOf(result.state),
    ...(result.stop === undefined ? {} : { stop: stopOf(result.stop) }),
  };
}

/** Project one persisted stop into the model-facing shape, per reason. */
function stopOf(stop: OutcomeStop): SubmitOutcomeStop {
  const base = {
    loop_group_id: stop.loopGroupId,
    node_id: stop.nodeId,
    outcome_id: stop.outcomeId,
    attempt_id: stop.attemptId,
    stopped_at: stop.stoppedAt,
  };
  if (stop.reason === "loop-exhausted") {
    return Object.freeze({
      ...base,
      reason: stop.reason,
      traversals: stop.traversals,
      max_traversals: stop.maxTraversals,
    });
  }
  return Object.freeze({
    ...base,
    reason: stop.reason,
    unchanged: stop.unchanged,
    max_unchanged: stop.maxUnchanged,
    evaluator: stop.evaluator,
    evaluator_version: stop.evaluatorVersion,
    subject: stop.subject,
    baseline: stop.baseline,
  });
}

/** Project every requirement evaluation into the model-facing shape. */
function requirementOutcomes(
  evaluations: readonly RequirementEvaluation[],
): readonly SubmitRequirementOutcome[] {
  return evaluations.map((entry) =>
    Object.freeze({
      validator: entry.requirement.id,
      version: entry.requirement.version,
      outcome: entry.outcome.kind,
      ...(entry.outcome.kind === "pass" ? {} : { reason: entry.outcome.reason }),
    }),
  );
}

/** The settled node ids of one state, in plan order. */
function settledNodesOf(state: OutcomeGraphState): readonly string[] {
  return Object.freeze(
    state.nodes.filter((node) => node.status === "settled").map((node) => node.nodeId),
  );
}

/** Map a runtime refusal onto a tool diagnostic verbatim. */
function toDiagnostic(refusal: OutcomeRuntimeRefusal): SubmitOutcomeDiagnostic {
  return {
    code: refusal.code,
    message: refusal.message,
    ...(refusal.path === undefined ? {} : { path: refusal.path }),
  };
}

/** The message of a caught value, without assuming it is an Error. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
