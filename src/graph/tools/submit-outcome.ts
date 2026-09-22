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
 * contract out of the compiled plan inside it. A LEGACY (v2) graph is refused by
 * name — the signal protocol has its own ingress (`signal`), and interpreting a
 * severity-ranked signal as an accepted outcome is exactly what this protocol
 * forbids.
 *
 * THE SUBMISSION INGRESS IS THE ONLY COMPLETION SOURCE. Nothing here, and
 * nothing in the outcome run path, can settle a node from a legacy dispatch
 * completion: a declared graph is never an entry of the legacy registry, every
 * legacy tool entry point refuses it, and the runtime reads only accepted
 * outcomes committed through this ingress. There is no synthesis step and no
 * severity ranking anywhere on this path.
 *
 * TIME AND EFFECTS. The clock is an explicit protocol input: the toolset may
 * pin it (`outcomeNow`) or the runtime reads it. An accepted outcome's
 * successor dispatch is recorded as a `pending` effect in the SAME transaction
 * that writes the receipt, the accepted event and the graph state; executing
 * that effect beyond the dispatch seam is the deferred work, and the effect row
 * is what a later recovery reconciles.
 */

import { readFileSync } from "node:fs";

import type { CompiledPlan } from "../compiler/plan.ts";
import {
  DEFAULT_STORAGE_FORMAT_REGISTRY,
  engineStateDir,
  engineStatePath,
  loadEngineStateForResume,
  type EngineLoadResult,
} from "../engine/engine-persistence.ts";
import { SqliteAcceptanceLedger } from "../ledger/sqlite-ledger.ts";
import { OUTCOME_PROTOCOL } from "../protocol/execution-protocol.ts";
import type {
  AcceptanceDecision,
  RequirementEvaluation,
} from "../outcome/acceptance.ts";
import {
  OutcomeGraphRuntime,
  type OutcomeDispatchSeam,
  type OutcomeRuntimeRefusal,
  type OutcomeSubmissionResult,
} from "../outcome/runtime.ts";
import type {
  OutcomeGraphState,
  OutcomeStop,
} from "../outcome/graph-state.ts";
import {
  createValidatorRegistry,
  type ValidatorRegistry,
} from "../outcome/validators.ts";
import { readExistingDeclaredGraph } from "./declare-graph.ts";

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
 * never a judgement about the work.
 */
export interface SubmitOutcomeStop {
  readonly reason: string;
  /** The declared loop group whose hard cap binds. */
  readonly loop_group_id: string;
  /** The node whose accepted outcome could not continue. */
  readonly node_id: string;
  /** The continuation outcome that asked for the refused round. */
  readonly outcome_id: string;
  /** The attempt of `node_id` that the outcome settled. */
  readonly attempt_id: string;
  /** Continuations the group took: equal to `max_traversals`. */
  readonly traversals: number;
  /** The declared hard cap the refused continuation would have exceeded. */
  readonly max_traversals: number;
  /** Epoch milliseconds the stop was committed at. */
  readonly stopped_at: number;
}

// ── Refusals at the tool boundary ───────────────────────────────────────────

/** Why the tool could not even address the submission. Stable identifiers. */
export type OutcomeSubmitRefusalReason =
  /** No declared graph holds the id — this ingress serves declared graphs only. */
  | "unknown-graph"
  /** The id belongs to a LEGACY (v2) graph, whose ingress is the signal protocol. */
  | "legacy-graph"
  /** The graph is declared in memory only: its plan never reached the store. */
  | "plan-not-persisted"
  /** The persisted record could not be read as this build's declared plan. */
  | "unreadable-plan"
  /** No state directory is configured, so the ledger has no place to live. */
  | "no-state-directory";

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
  /** Whether THIS toolset holds the id as a legacy (v2) graph. */
  readonly legacyInMemory: boolean;
}

/**
 * Resolve the PERSISTED compiled plan of a declared graph, or refuse by name.
 *
 * Order is deliberate:
 * 1. a legacy id in this process's registry is refused FIRST — a caller that
 *    points this tool at a legacy graph gets the legacy-graph error even before
 *    any file is read;
 * 2. the persisted record is classified (absent / legacy / declared /
 *    unreadable) so each case gets its own reason;
 * 3. the record is loaded through the SAME loader every other consumer uses —
 *    storage-format gate, protocol gate and persisted-plan verification — and a
 *    record that is not a valid OUTCOME-protocol state is refused rather than
 *    partially trusted.
 *
 * The declaration is never an input: there is no path here that compiles
 * anything.
 */
function resolvePersistedPlan(target: SubmitOutcomeTarget): CompiledPlan {
  const { graphId } = target;
  if (target.legacyInMemory) {
    throw legacyGraphRefusal(graphId, "this process holds it as a legacy graph");
  }
  if (target.workspaceDir === undefined) {
    throw new OutcomeSubmissionRefusedError(
      "no-state-directory",
      graphId,
      `graph_submit_outcome refused: no state directory is configured, so graph "${graphId}"` +
        " has no .rolebox/state store to hold its compiled plan and no acceptance ledger to" +
        " commit an outcome into. Construct the toolset with a stateDir.",
    );
  }
  const onDisk = readExistingDeclaredGraph(target.workspaceDir, graphId);
  if (onDisk.kind === "legacy") {
    throw legacyGraphRefusal(graphId, "a legacy state file owns the id");
  }
  if (onDisk.kind === "unreadable") {
    throw new OutcomeSubmissionRefusedError(
      "unreadable-plan",
      graphId,
      `graph_submit_outcome refused: the persisted record of graph "${graphId}" could not be` +
        ` read (${onDisk.reason}). A declaration-only graph is the only kind this ingress` +
        " accepts, and it is never guessed at or overwritten.",
    );
  }
  if (onDisk.kind === "absent") {
    throw new OutcomeSubmissionRefusedError(
      target.declaredInMemory ? "plan-not-persisted" : "unknown-graph",
      graphId,
      target.declaredInMemory
        ? `graph_submit_outcome refused: graph "${graphId}" is declared in memory but its` +
          " compiled plan never reached the store, so the outcome state has nowhere durable to" +
          " live. Declare it with a stateDir configured and submit again."
        : `graph_submit_outcome refused: graph "${graphId}" is not a declared` +
          " (outcome-protocol) graph. This ingress serves declaration-only graphs; call" +
          " graph_declare first. Legacy graphs complete through their own signal protocol.",
    );
  }

  const path = engineStatePath(target.workspaceDir, graphId);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    throw new OutcomeSubmissionRefusedError(
      "unreadable-plan",
      graphId,
      `graph_submit_outcome refused: the persisted record of graph "${graphId}" could not be` +
        ` read from ${path} (${errorText(error)}); nothing was submitted.`,
    );
  }
  const loaded = loadEngineStateForResume(
    raw,
    path,
    DEFAULT_STORAGE_FORMAT_REGISTRY,
  );
  if (loaded.kind !== "valid") {
    throw new OutcomeSubmissionRefusedError(
      "unreadable-plan",
      graphId,
      `graph_submit_outcome refused: the persisted record of graph "${graphId}" is not a` +
        ` loadable engine state (${describeLoad(loaded)}); nothing was submitted.`,
    );
  }
  if (loaded.executionProtocol !== OUTCOME_PROTOCOL) {
    throw legacyGraphRefusal(
      graphId,
      `its persisted record is bound to execution protocol ${loaded.executionProtocol}`,
    );
  }
  const plan = loaded.state.compiledPlan;
  if (plan === undefined) {
    throw new OutcomeSubmissionRefusedError(
      "unreadable-plan",
      graphId,
      `graph_submit_outcome refused: graph "${graphId}" is bound to the outcome protocol but` +
        " its persisted record carries no compiled plan, so the node's contract cannot be" +
        " resolved from the saved plan; nothing was submitted.",
    );
  }
  return plan;
}

/** The one legacy refusal, phrased once so no call site drifts. */
function legacyGraphRefusal(
  graphId: string,
  detail: string,
): OutcomeSubmissionRefusedError {
  return new OutcomeSubmissionRefusedError(
    "legacy-graph",
    graphId,
    `graph_submit_outcome refused: graph "${graphId}" is not a declaration-only` +
      ` (outcome-protocol) graph — ${detail}. A legacy v2 graph completes through the LEGACY` +
      " signal protocol, and this ingress never synthesizes an answer for it or interprets a" +
      " severity-ranked signal as an accepted outcome. Nothing was submitted.",
  );
}

/** Describe a non-valid load result for a diagnostic. */
function describeLoad(
  loaded: Exclude<EngineLoadResult, { kind: "valid" }>,
): string {
  switch (loaded.kind) {
    case "absent":
      return "no record";
    case "corrupt":
      return `corrupt ${loaded.dimension}: ${loaded.reason}`;
    case "unsupported":
      return `unsupported ${loaded.dimension}: ${loaded.detail}`;
    case "migration-required":
      return `migration-required storage ${loaded.from} -> ${loaded.to}`;
  }
}

// ── The submission ──────────────────────────────────────────────────────────

/** Everything the ingress needs besides the target and the args. */
export interface SubmitOutcomeDeps {
  /** Where a launched successor dispatch goes (effect execution is deferred). */
  readonly dispatch?: OutcomeDispatchSeam;
  /** The installed validator implementations the plan's gates resolve against. */
  readonly validators?: ValidatorRegistry;
  /** Root every evidence reference must resolve inside. */
  readonly artifactRoot: string;
  /** The clock, in epoch milliseconds; omitted → the runtime reads `Date.now()`. */
  readonly now?: number;
}

/** The dispatch seam used when the caller supplies none (see the sweep's). */
const NOOP_OUTCOME_DISPATCH: OutcomeDispatchSeam = () => undefined;

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
  const plan = resolvePersistedPlan(target);
  const ledger = await SqliteAcceptanceLedger.create(
    engineStateDir(workspaceOf(target)),
  );
  try {
    const runtime = new OutcomeGraphRuntime({
      plan,
      ledger,
      dispatch: deps.dispatch ?? NOOP_OUTCOME_DISPATCH,
      validators: deps.validators ?? EMPTY_VALIDATORS,
      artifactRoot: deps.artifactRoot,
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
    const result = runtime.submit(proposal, deps.now);
    return renderResult(plan, args, result);
  } finally {
    ledger.close();
  }
}

/** The workspace directory a submission is addressed against. */
function workspaceOf(target: SubmitOutcomeTarget): string {
  if (target.workspaceDir === undefined) {
    // Unreachable: resolvePersistedPlan refuses this before a ledger is opened.
    throw new OutcomeSubmissionRefusedError(
      "no-state-directory",
      target.graphId,
      `graph_submit_outcome refused: no state directory is configured for graph "${target.graphId}".`,
    );
  }
  return target.workspaceDir;
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

/** Project one persisted stop into the model-facing shape. */
function stopOf(stop: OutcomeStop): SubmitOutcomeStop {
  return Object.freeze({
    reason: stop.reason,
    loop_group_id: stop.loopGroupId,
    node_id: stop.nodeId,
    outcome_id: stop.outcomeId,
    attempt_id: stop.attemptId,
    traversals: stop.traversals,
    max_traversals: stop.maxTraversals,
    stopped_at: stop.stoppedAt,
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
