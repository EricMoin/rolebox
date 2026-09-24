/** Pure graph transitions. Persistence decoding and join materialization have separate owners. */


import type {
  CompiledPlan
} from "../compiler/plan.ts";
import type { AcceptanceDecision } from "./acceptance.ts";
import {
  attemptCredentialBinding,
  attemptCredentialDigest, mintAttemptCredential,
  type AttemptCredentialSource
} from "./attempt-credential.ts";
import {
  compareProgress,
  type OutcomeLoopProgress,
  type ProgressProjection,
  type ProgressReport
} from "./progress.ts";
import {
  type HostInvocationIdentity
} from "./host-identity.ts";
import {
  assembleDownstreamInput, type AcceptedResultReading,
  type DownstreamInput, type ResolvedInput
} from "./inputs.ts";

import { type OutcomeNodeState, type OutcomeGraphPhase, type OutcomeProgressStalledStop, type OutcomeStop, type OutcomeGraphState, CURRENT_OUTCOME_STATE_BODY } from "./state-model.ts";
import { describeOutcomeStop } from "./state-codec.ts";
import { materializeArrivals, resolveArmSet, sameMembers } from "./join-state.ts";
export * from "./state-model.ts";
export * from "./state-codec.ts";
export * from "./state-errors.ts";
export { entryNodesOf } from "./join-state.ts";

const ADVANCEABLE_STATE_BODY_VERSIONS: readonly number[] = Object.freeze([CURRENT_OUTCOME_STATE_BODY]);

export type OutcomeAdvanceRefusalCode =

  | "unknown-node"

  | "node-not-dispatched"

  | "attempt-mismatch"

  | "no-route"

  | "reentry-outside-loop"

  | "graph-stopped"

  | "progress-unbound"

  | "state-ledger-disagreement"

  | "unsupported-state-version";

export class OutcomeAdvanceRefusedError extends Error {
  readonly code: OutcomeAdvanceRefusalCode;

  constructor(code: OutcomeAdvanceRefusalCode, message: string) {
    super(message);
    this.name = "OutcomeAdvanceRefusedError";
    this.code = code;
  }
}

export interface OutcomeDispatchIntent {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly agent: string;
  readonly prompt: string;

  readonly credential: string;

  readonly inputs: readonly ResolvedInput[];
}

export interface OutcomeAdvance {
  readonly state: OutcomeGraphState;
  readonly dispatches: readonly OutcomeDispatchIntent[];

  readonly progress: readonly ProgressReport[];
}

export interface OutcomeAdvanceInput {
  readonly plan: CompiledPlan;
  readonly state: OutcomeGraphState;

  readonly decision: AcceptanceDecision;

  readonly now: number;

  readonly mintCredential: AttemptCredentialSource;

  readonly readAcceptedResult?: (attemptId: string) => AcceptedResultReading;

  readonly progress?: readonly ProgressProjection[];

  readonly dispatchIdentity?: HostInvocationIdentity;
}

function sharedLoopGroup(
  plan: CompiledPlan,
  from: string,
  to: string,
): CompiledPlan["loopGroups"][number] | undefined {
  for (const group of plan.loopGroups) {
    if (group.nodes.includes(from) && group.nodes.includes(to)) return group;
  }
  return undefined;
}

function continuationGroups(
  plan: CompiledPlan,
  nodeId: string,
  outcomeId: string,
): readonly CompiledPlan["loopGroups"][number][] {
  return plan.loopGroups.filter(
    (group) =>
      group.continuationOutcome === outcomeId && group.nodes.includes(nodeId),
  );
}

function measureProgress(
  plan: CompiledPlan,
  groups: readonly CompiledPlan["loopGroups"][number][],
  recorded: Readonly<Record<string, OutcomeLoopProgress>>,
  decision: AcceptanceDecision,
  projections: readonly ProgressProjection[] | undefined,
  now: number,
): {
  readonly entries: Readonly<Record<string, OutcomeLoopProgress>>;
  readonly reports: readonly ProgressReport[];
  readonly stop?: OutcomeProgressStalledStop;
} {
  const entries: Record<string, OutcomeLoopProgress> = { ...recorded };
  const reports: ProgressReport[] = [];
  let stop: OutcomeProgressStalledStop | undefined;
  for (const group of groups) {
    const policy = group.progress;
    if (policy === undefined) continue;
    const entry = recorded[group.id];
    const projection = projections?.find((candidate) => candidate.loopGroupId === group.id);
    if (entry === undefined) {
      throw new OutcomeAdvanceRefusedError(
        "progress-unbound",
        "outcome-advance: loop group " + JSON.stringify(group.id) +
        " declares a progress policy, but the persisted state carries no progress record " +
        "for it — the declared comparison is refused rather than skipped",
      );
    }
    if (projection === undefined) {
      throw new OutcomeAdvanceRefusedError(
        "progress-unbound",
        "outcome-advance: loop group " + JSON.stringify(group.id) +
        " declares a progress policy, but this submission was measured into no projection " +
        "for it — a declared comparison is never skipped",
      );
    }
    if (!projectionMatchesDecision(plan, decision, projection)) {
      throw new OutcomeAdvanceRefusedError(
        "progress-unbound",
        "outcome-advance: the progress projection of loop group " + JSON.stringify(group.id) +
        " is bound to " + describeProjectionBinding(projection) +
        ", not to this submission (attempt " +
        JSON.stringify(decision.identity.attemptId) + " of plan revision " +
        JSON.stringify(plan.planRevision) + ", proposal " +
        JSON.stringify(decision.proposalDigest) +
        ") — a projection measures exactly the proposal it was produced for, so it is " +
        "refused rather than compared",
      );
    }
    const comparison = compareProgress({ policy, entry, projection });
    entries[group.id] = comparison.entry;
    reports.push(comparison.report);
    if (!comparison.report.stalled || stop !== undefined) continue;
    const baseline = comparison.entry.baseline;
    if (baseline === undefined) {
      throw new OutcomeAdvanceRefusedError(
        "progress-unbound",
        "outcome-advance: loop group " + JSON.stringify(group.id) +
        " reported a stall without a recorded baseline — this build produces no such " +
        "comparison, so the stop is refused rather than invented",
      );
    }
    stop = Object.freeze({
      reason: "progress-stalled" as const,
      loopGroupId: group.id,
      nodeId: decision.nodeId,
      outcomeId: decision.outcomeId,
      attemptId: decision.identity.attemptId,
      unchanged: comparison.entry.unchanged,
      maxUnchanged: policy.maxUnchanged,
      evaluator: comparison.entry.evaluator,
      evaluatorVersion: comparison.entry.version,
      subject: comparison.entry.subject,
      baseline,
      stoppedAt: now,
    });
  }
  return {
    entries: Object.freeze(entries),
    reports: Object.freeze(reports),
    ...(stop === undefined ? {} : { stop }),
  };
}

function projectionMatchesDecision(
  plan: CompiledPlan,
  decision: AcceptanceDecision,
  projection: ProgressProjection,
): boolean {
  const binding = projection.binding;
  return (
    binding.graphId === plan.graphId &&
    binding.planRevision === plan.planRevision &&
    binding.attemptId === decision.identity.attemptId &&
    binding.submissionId === decision.identity.submissionId &&
    binding.proposalDigest === decision.proposalDigest
  );
}

function describeProjectionBinding(projection: ProgressProjection): string {
  const binding = projection.binding;
  return (
    "graph " + JSON.stringify(binding.graphId) +
    ", plan revision " + JSON.stringify(binding.planRevision) +
    ", attempt " + JSON.stringify(binding.attemptId) +
    ", proposal " + JSON.stringify(binding.proposalDigest)
  );
}

export function advanceOutcomeGraph(input: OutcomeAdvanceInput): OutcomeAdvance {
  const { plan, state, decision, now } = input;
  if (!ADVANCEABLE_STATE_BODY_VERSIONS.includes(state.bodyVersion)) {
    throw new OutcomeAdvanceRefusedError(
      "unsupported-state-version",
      "outcome-advance: the state was written in body version " + state.bodyVersion +
      ", which this build does not advance (it advances body versions " +
      ADVANCEABLE_STATE_BODY_VERSIONS.join(", ") +
      ") — the layouts it advances record the attempt credential as the DIGEST it " +
      "verifies against, while every version below them persists the credential itself " +
      "(never re-persisted, never compared against a presentation and never " +
      "re-delivered) or cannot carry the join arrivals and progress baselines this build " +
      "writes on every attempt, and a newer one is not read by this build — the state is " +
      "refused rather than advanced and rewritten in body version " +
      CURRENT_OUTCOME_STATE_BODY,
    );
  }
  if (state.loopProgress === undefined) {
    throw new OutcomeAdvanceRefusedError(
      "unsupported-state-version",
      "outcome-advance: the state declares body version " + state.bodyVersion +
      " but carries no loopProgress record — a body of this version records one progress " +
      "entry per declared policy, so the state is refused rather than advanced into a shape " +
      "this build could not read back",
    );
  }
  const recordedProgress: Readonly<Record<string, OutcomeLoopProgress>> =
    state.loopProgress;
  if (state.stop !== undefined) {
    throw new OutcomeAdvanceRefusedError(
      "graph-stopped",
      "outcome-advance: graph " + JSON.stringify(plan.graphId) + " STOPPED (" +
      state.stop.reason + ": " + describeOutcomeStop(state.stop) +
      ") — a stopped run advances no further, so this " +
      "outcome was not applied and the stop is left exactly as it is",
    );
  }
  const position = plan.nodes.findIndex((node) => node.id === decision.nodeId);
  if (position < 0) {
    throw new OutcomeAdvanceRefusedError(
      "unknown-node",
      "outcome-advance: the accepted decision names node " + JSON.stringify(decision.nodeId) +
      ", which plan revision " + plan.planRevision + " does not declare — nothing was applied",
    );
  }
  const current = state.nodes[position];
  if (current === undefined || current.nodeId !== decision.nodeId) {
    throw new OutcomeAdvanceRefusedError(
      "unknown-node",
      "outcome-advance: the state carries no progress for node " + JSON.stringify(decision.nodeId) +
      " — nothing was applied",
    );
  }
  if (current.status === "pending") {
    throw new OutcomeAdvanceRefusedError(
      "node-not-dispatched",
      "outcome-advance: node " + JSON.stringify(decision.nodeId) +
      " was never dispatched, so its outcome cannot settle an attempt — nothing was applied",
    );
  }
  if (current.status === "settled") {
    throw new OutcomeAdvanceRefusedError(
      "node-not-dispatched",
      "outcome-advance: node " + JSON.stringify(decision.nodeId) +
      " is already settled by outcome " + JSON.stringify(current.outcomeId ?? "") +
      " — a settled node is never advanced twice",
    );
  }
  if (current.attemptId !== decision.identity.attemptId) {
    throw new OutcomeAdvanceRefusedError(
      "attempt-mismatch",
      "outcome-advance: node " + JSON.stringify(decision.nodeId) + " is on attempt " +
      JSON.stringify(current.attemptId ?? "") + ", but the accepted decision belongs to attempt " +
      JSON.stringify(decision.identity.attemptId) +
      " — a stale acceptance is refused rather than applied to a newer attempt",
    );
  }

  const node = plan.nodes[position];
  const nodes: OutcomeNodeState[] = state.nodes.map((entry) => ({ ...entry }));
  nodes[position] = Object.freeze({
    nodeId: current.nodeId,
    status: "settled" as const,
    ...(current.attemptId === undefined ? {} : { attemptId: current.attemptId }),
    ...(current.attemptSeq === undefined ? {} : { attemptSeq: current.attemptSeq }),
    ...(current.inputs === undefined ? {} : { inputs: current.inputs }),
    ...(current.attemptCredentialDigest === undefined
      ? {}
      : { attemptCredentialDigest: current.attemptCredentialDigest }),
    ...(current.dispatchIdentity === undefined
      ? {}
      : { dispatchIdentity: current.dispatchIdentity }),
    outcomeId: decision.outcomeId,
    ...(current.dispatchedAt === undefined ? {} : { dispatchedAt: current.dispatchedAt }),
    settledAt: now,
  });

  let loopTraversals = state.loopTraversals;
  let loopProgress: Readonly<Record<string, OutcomeLoopProgress>> = recordedProgress;
  let attemptSeq = state.attemptSeq;
  const dispatches: OutcomeDispatchIntent[] = [];

  const progressReports: ProgressReport[] = [];

  let stop: OutcomeStop | undefined;

  const terminal = plan.terminalOutcomes.some(
    (entry) => entry.nodeId === decision.nodeId && entry.outcome === decision.outcomeId,
  );
  if (!terminal) {
    const successors = plan.edges.filter(
      (edge) => edge.from === decision.nodeId && edge.outcome === decision.outcomeId,
    );
    if (successors.length === 0) {
      throw new OutcomeAdvanceRefusedError(
        "no-route",
        "outcome-advance: outcome " + JSON.stringify(decision.outcomeId) + " of node " +
        JSON.stringify(decision.nodeId) + " is not a declared terminal and binds no edge — " +
        "the plan is inconsistent and nothing was applied",
      );
    }
    const groups = continuationGroups(plan, decision.nodeId, decision.outcomeId);
    if (groups.length > 0) {
      const next: Record<string, number> = { ...loopTraversals };
      let bound: CompiledPlan["loopGroups"][number] | undefined;
      for (const group of groups) {
        const traversals = (next[group.id] ?? 0) + 1;
        if (traversals > group.maxTraversals) {
          bound = group;
          break;
        }
        next[group.id] = traversals;
      }
      if (bound === undefined) {
        loopTraversals = Object.freeze(next);
      } else {
        stop = Object.freeze({
          reason: "loop-exhausted" as const,
          loopGroupId: bound.id,
          nodeId: decision.nodeId,
          outcomeId: decision.outcomeId,
          attemptId: decision.identity.attemptId,
          traversals: loopTraversals[bound.id] ?? 0,
          maxTraversals: bound.maxTraversals,
          stoppedAt: now,
        });
      }
    }
    if (stop === undefined) {
      const measured = measureProgress(
        plan,
        groups,
        recordedProgress,
        decision,
        input.progress,
        now,
      );
      loopProgress = measured.entries;
      for (const report of measured.reports) progressReports.push(report);
      stop = measured.stop;
    }
    const routed = stop === undefined ? successors : [];
    const candidateIds = new Set(routed.map((edge) => edge.to));
    for (const targetId of candidateIds) {
      if (!plan.nodes.some((entry) => entry.id === targetId)) {
        throw new OutcomeAdvanceRefusedError(
          "no-route",
          "outcome-advance: edge " + JSON.stringify(decision.nodeId) + " -> " +
          JSON.stringify(targetId) + " names a node the plan does not declare",
        );
      }
    }
    const candidates = plan.nodes
      .map((entry, index) => ({ node: entry, index }))
      .filter((candidate) => candidateIds.has(candidate.node.id));
    for (const candidate of candidates) {
      if (nodes[candidate.index].status !== "settled") continue;
      const shared = sharedLoopGroup(plan, decision.nodeId, candidate.node.id);
      if (shared === undefined) {
        throw new OutcomeAdvanceRefusedError(
          "reentry-outside-loop",
          "outcome-advance: edge " + JSON.stringify(decision.nodeId) + " -> " +
          JSON.stringify(candidate.node.id) + " re-enters a settled node, but the two do not " +
          "share a declared loop group — re-entry outside a declared loop is refused",
        );
      }
    }
    const settledAttemptOf = (nodeId: string): string | undefined => {
      const entry = nodes.find((candidate) => candidate.nodeId === nodeId);
      return entry !== undefined && entry.status === "settled"
        ? entry.attemptId
        : undefined;
    };
    const readAccepted: (attemptId: string) => AcceptedResultReading =
      input.readAcceptedResult ??
      ((): AcceptedResultReading => ({
        kind: "unreadable",
        reason:
          "this advance was given no durable accepted-result read, so a declared input " +
          "cannot be resolved from what the producers accepted",
      }));
    const armable = candidates.filter(
      (candidate) => nodes[candidate.index].status !== "dispatched",
    );
    let decisions: {
      candidate: (typeof candidates)[number];
      assembled: DownstreamInput;
    }[] = [];
    const blocked = new Set<string>();
    for (; ;) {
      const armSet = resolveArmSet(
        plan,
        nodes,
        armable.map((candidate) => candidate.node),
        blocked,
      );
      const routedCandidates = candidates.filter((candidate) =>
        armSet.has(candidate.node.id),
      );
      const assembleAgainst = (inFlight: ReadonlySet<string>) =>
        routedCandidates.map((candidate) => ({
          candidate,
          assembled: assembleDownstreamInput(
            candidate.node.inputs ?? [],
            (nodeId) => (inFlight.has(nodeId) ? undefined : settledAttemptOf(nodeId)),
            readAccepted,
          ),
        }));
      const armedAgainst = (inFlight: ReadonlySet<string>): ReadonlySet<string> =>
        new Set(
          assembleAgainst(inFlight)
            .filter((entry) => entry.assembled.kind === "resolved")
            .map((entry) => entry.candidate.node.id),
        );
      let basis: ReadonlySet<string> = new Set(
        routedCandidates.map((candidate) => candidate.node.id),
      );
      for (let round = 0; round <= routedCandidates.length; round += 1) {
        const swung = armedAgainst(armedAgainst(basis));
        if (sameMembers(swung, basis)) break;
        basis = swung;
      }
      const next: typeof decisions = [];
      let grew = false;
      for (const { candidate, assembled } of assembleAgainst(basis)) {
        next.push({ candidate, assembled });
        if (assembled.kind === "blocked" && !blocked.has(candidate.node.id)) {
          blocked.add(candidate.node.id);
          grew = true;
        }
      }
      decisions = next;
      if (!grew) break;
    }
    for (const { candidate, assembled } of decisions) {
      if (assembled.kind === "blocked") {
        const blockedEntry = nodes[candidate.index];
        if (blockedEntry === undefined) continue;
        nodes[candidate.index] = Object.freeze({
          ...blockedEntry,
          inputRefusals: assembled.refusals,
        });
        continue;
      }
      attemptSeq += 1;
      const attemptId = candidate.node.id + "#" + attemptSeq;
      const targetNode = candidate.node;
      const credential = mintAttemptCredential(
        input.mintCredential,
        attemptCredentialBinding({
          graphId: plan.graphId,
          nodeId: targetNode.id,
          attemptId,
          planRevision: plan.planRevision,
        }),
      );
      nodes[candidate.index] = Object.freeze({
        nodeId: targetNode.id,
        status: "dispatched" as const,
        attemptId,
        attemptSeq,
        attemptCredentialDigest: attemptCredentialDigest(credential),
        ...(input.dispatchIdentity === undefined
          ? {}
          : { dispatchIdentity: input.dispatchIdentity }),
        dispatchedAt: now,
        arrivals: Object.freeze([]),
        inputs: assembled.entries,
      });
      dispatches.push(
        Object.freeze({
          nodeId: targetNode.id,
          attemptId,
          agent: targetNode.agent,
          prompt: targetNode.prompt,
          credential,
          inputs: assembled.entries,
        }),
      );
    }
  }
  const canonicalArrivals = materializeArrivals(plan, nodes);
  for (let index = 0; index < nodes.length; index += 1) {
    const entry = nodes[index];
    if (entry === undefined) continue;
    nodes[index] = Object.freeze({
      ...entry,
      arrivals: canonicalArrivals.get(entry.nodeId) ?? Object.freeze([]),
    });
  }

  const dispatched = nodes.some((entry) => entry.status === "dispatched");
  const attempted = nodes.some((entry) => entry.status !== "pending");
  const phase: OutcomeGraphPhase =
    stop !== undefined
      ? "stopped"
      : dispatched
        ? "executing"
        : attempted
          ? "complete"
          : "ready";
  return Object.freeze({
    state: Object.freeze({
      bodyVersion: CURRENT_OUTCOME_STATE_BODY,
      graphId: state.graphId,
      planRevision: state.planRevision,
      phase,
      nodes: Object.freeze(nodes),
      loopTraversals,
      attemptSeq,
      ...(stop === undefined ? {} : { stop }),
      loopProgress,
    }),
    dispatches: Object.freeze(dispatches),
    progress: Object.freeze(progressReports),
  });
}
