import { hasBudgetLimits, nodeBudgetLimitsOf } from "../domain/budget.ts";
import type { ControlDecisionRecord } from "../ledger/types.ts";
import {
  attemptCredentialBinding, attemptCredentialDigest, mintAttemptCredential, RUNTIME_ATTEMPT_CREDENTIAL_SOURCE,
} from "../outcome/attempt-credential.ts";
import { readCredentialIsolationStore } from "../outcome/credential-isolation.ts";
import { blockingReexecutionEffectsOf, dispatchEffectIdOf, type OutcomeDispatchTarget } from "../outcome/dispatch-effects.ts";
import { stateRecordOf, type OutcomeGraphState, type OutcomeNodeState } from "../outcome/graph-state.ts";
import { principalOf, refuse, type ControlCommandContext } from "./command-context.ts";
import type { GraphControlResult } from "./contracts.ts";
import { unconfirmedExecutionsOf } from "./reports.ts";

export function applyRetryCommand(ctx: ControlCommandContext<"retry">): GraphControlResult {
  const { tx, runs, graphId, plan, run, state, settled, request, principal } = ctx;
  if (request.nodeId === undefined) {
    if (request.attemptId !== undefined) {
      return refuse(
        graphId,
        "unknown-node",
        "$.node_id",
        "graph-control refused [unknown-node]: a RUN-SCOPED retry names the run to " +
        "re-execute and no attempt; pass neither node_id nor attempt_id, or name the node " +
        "whose attempt is superseded",
      );
    }
    return orderReexecution(ctx);
  }

  const decidedBy = principalOf(principal);
  const stopping = runs.readRunControlOf(graphId, run.runId);
  if (stopping !== undefined) {
    return refuse(
      graphId,
      "run-stopped",
      "$.node_id",
      "graph-control refused [run-stopped]: run " +
      JSON.stringify(run.runId) +
      " of graph " +
      JSON.stringify(graphId) +
      " was STOPPED by the trusted control command " +
      JSON.stringify(stopping.command) +
      " (" +
      stopping.reason +
      "), so no submission can settle an attempt of it — retrying the node in place " +
      "would mint an attempt nothing can accept; re-execute the graph as a NEW run " +
      "(a run-scoped retry), and nothing was written",
    );
  }
  if (state.stop !== undefined || state.phase === "stopped") {
    return refuse(
      graphId,
      "run-stopped",
      "$.node_id",
      "graph-control refused [run-stopped]: run " +
      JSON.stringify(run.runId) +
      " of graph " +
      JSON.stringify(graphId) +
      " ended on a declared stop (" +
      (state.stop === undefined ? state.phase : state.stop.reason) +
      "), so it takes no further step — retrying the node in place would mint an " +
      "attempt nothing can accept; re-execute the graph as a NEW run (a run-scoped " +
      "retry), and nothing was written",
    );
  }

  const node = state.nodes.find((entry) => entry.nodeId === request.nodeId);
  if (node === undefined) {
    return refuse(
      graphId,
      "unknown-node",
      "$.node_id",
      "graph-control refused [unknown-node]: graph " +
      JSON.stringify(graphId) +
      " declares no node " +
      JSON.stringify(request.nodeId),
    );
  }
  // Replay by the superseded attempt before checking currency: the first retry
  // replaced it, so an explicit repeat necessarily names an older attempt.
  const namedAttemptId = request.attemptId;
  if (namedAttemptId !== undefined) {
    const repeated = runs.readControlCommandDecision(
      graphId,
      run.runId,
      node.nodeId,
      namedAttemptId,
      "retry",
    );
    if (repeated !== undefined) return replayedRetry(ctx, repeated);
  }
  if (node.attemptId === undefined) {
    return refuse(
      graphId,
      "attempt-absent",
      "$.node_id",
      "graph-control refused [attempt-absent]: node " +
      JSON.stringify(node.nodeId) +
      " records no attempt at all (" +
      node.status +
      "), so there is no attempt for a retry to supersede",
    );
  }
  if (namedAttemptId !== undefined && namedAttemptId !== node.attemptId) {
    return refuse(
      graphId,
      "attempt-not-current",
      "$.attempt_id",
      "graph-control refused [attempt-not-current]: node " +
      JSON.stringify(node.nodeId) +
      " is in flight on attempt " +
      JSON.stringify(node.attemptId) +
      " and the command names " +
      JSON.stringify(namedAttemptId) +
      " — a retry supersedes the attempt the run actually holds, never one it has " +
      "already replaced; an attempt this run ALREADY retried replays that decision " +
      "instead",
    );
  }
  if (settled.has(node.attemptId)) {
    return refuse(
      graphId,
      "attempt-already-settled",
      "$.node_id",
      "graph-control refused [attempt-already-settled]: node " +
      JSON.stringify(node.nodeId) +
      " attempt " +
      JSON.stringify(node.attemptId) +
      " already settled through the acceptance core, and a settled attempt's result is " +
      "IMMUTABLE — it is never re-labelled, never re-run in place and never rewritten; " +
      "re-executing the graph as a new run (a run-scoped retry) is the way to run the " +
      "node again, and nothing was written",
    );
  }
  if (node.status !== "dispatched") {
    return refuse(
      graphId,
      "attempt-absent",
      "$.node_id",
      "graph-control refused [attempt-absent]: node " +
      JSON.stringify(node.nodeId) +
      " is " +
      node.status +
      ", not in flight, so there is no attempt for a retry to supersede",
    );
  }

  const supersededAttemptId = node.attemptId;
  // An implicit repeat reuses the current successor. Retrying that successor
  // again requires its explicit attempt ID.
  if (namedAttemptId === undefined) {
    const implicit = runs
      .controlDecisions(graphId, run.runId)
      .find(
        (decision) =>
          decision.command === "retry" &&
          decision.nodeId === node.nodeId &&
          decision.successorAttemptId === supersededAttemptId,
      );
    if (implicit !== undefined) return replayedRetry(ctx, implicit);
  }

  const capability = request.retry;
  const credentialStore =
    capability === undefined
      ? undefined
      : readCredentialIsolationStore(capability.credentialIsolation);
  if (credentialStore === undefined) {
    return refuse(
      graphId,
      "credential-isolation-unavailable",
      "$.retry",
      "graph-control refused [credential-isolation-unavailable]: a retry mints a NEW " +
      "attempt, and this process holds no readable version-3 credential-isolation " +
      "capability to adopt the attempt's credential into the host's protected store — an " +
      "attempt whose credential the host never held could never be delivered or " +
      "settled, so nothing was written",
    );
  }
  const planNode = plan.nodes.find((entry) => entry.id === node.nodeId);
  if (planNode === undefined) {
    return refuse(
      graphId,
      "unknown-node",
      "$.node_id",
      "graph-control refused [unknown-node]: the stored plan of graph " +
      JSON.stringify(graphId) +
      " declares no node " +
      JSON.stringify(node.nodeId) +
      ", so the successor attempt has no dispatch target — nothing was written",
    );
  }

  const attemptSeq = state.attemptSeq + 1;
  const successorAttemptId = node.nodeId + "#" + attemptSeq;
  // Carry the original input revisions. Resolving upstream nodes again could
  // feed this retry results from a later loop round.
  const carriedInputs = node.inputs ?? Object.freeze([]);
  if (
    node.inputs === undefined &&
    (planNode.inputs?.length ?? 0) > 0
  ) {
    return refuse(
      graphId,
      "input-binding-absent",
      "$.node_id",
      "graph-control refused [input-binding-absent]: node " +
      JSON.stringify(node.nodeId) +
      " DECLARES " +
      String(planNode.inputs?.length ?? 0) +
      " downstream input(s), and attempt " +
      JSON.stringify(supersededAttemptId) +
      " records no bound input view — it was armed before this build bound one, so " +
      "there is nothing to carry onto the successor and nothing was written. A " +
      "successor whose binding this command resolved from the producing nodes would " +
      "hand the worker a different round's result, which a retry must never do; " +
      "re-execute the graph as a new run to arm an attempt that carries the binding",
    );
  }
  const limitsReading = nodeBudgetLimitsOf(planNode.budget);
  if (limitsReading.kind === "refused") {
    return refuse(
      graphId,
      "budget-limit-unauthorized",
      "$.node_id",
      "graph-control refused [budget-limit-unauthorized]: the declared budget of node " +
      JSON.stringify(node.nodeId) +
      " is not one this build can enforce (" +
      limitsReading.refusal.code +
      " on " +
      limitsReading.refusal.key +
      "): " +
      limitsReading.refusal.message,
    );
  }
  const budget = tx.budget;
  if (budget === undefined) {
    if (hasBudgetLimits(limitsReading.limits) || plan.budget?.max_executions !== undefined) {
      return refuse(
        graphId,
        "budget-unavailable",
        "$.node_id",
        "graph-control refused [budget-unavailable]: node " +
        JSON.stringify(node.nodeId) +
        " declares a resource budget and this substrate holds no budget surface, so the " +
        "successor attempt was NOT minted — a ceiling nothing can record a claim against " +
        "is a ceiling nothing enforces",
      );
    }
  } else {
    // The old reservation stays until its external execution is accounted for.
    // This new reservation rolls back if a later step refuses the retry.
    const claimed = budget.reserveDispatch({
      maxExecutions: plan.budget?.max_executions,
      graphId,
      runId: run.runId,
      nodeId: node.nodeId,
      attemptId: successorAttemptId,
      effectId: dispatchEffectIdOf(successorAttemptId),
      limits: limitsReading.limits,
      at: request.at,
    });
    if (claimed.kind === "exhausted") {
      return refuse(
        graphId,
        "budget-exhausted",
        "$.node_id",
        "graph-control refused [budget-exhausted]: the successor attempt " +
        JSON.stringify(successorAttemptId) +
        " of node " +
        JSON.stringify(node.nodeId) +
        " was NOT authorized by the declared budget (" +
        claimed.exhausted.map((entry) => entry.message).join("; ") +
        ") — nothing was written: no decision, no state, no effect and no credential, and " +
        "the superseded attempt keeps its own claim because its execution may still be " +
        "running",
      );
    }
  }
  const payload: OutcomeDispatchTarget = Object.freeze({
    graphId,
    planRevision: plan.planRevision,
    nodeId: node.nodeId,
    attemptId: successorAttemptId,
    agent: planNode.agent,
    prompt: planNode.prompt,
    // The SAME view the state entry records below: the dispatch target and the
    // armed attempt can never describe two different bindings.
    inputs: carriedInputs,
  });
  // Record the decision before minting a credential. The store remains the
  // authority on settlement, and a refusal rolls back the budget reservation.
  const written = runs.writeControlDecision({
    decision: Object.freeze({
      graphId,
      runId: run.runId,
      nodeId: node.nodeId,
      attemptId: supersededAttemptId,
      command: "retry" as const,
      reason: request.reason,
      decidedAt: request.at,
      decidedBy,
      successorAttemptId,
    }),
    // NO runControl: a retry supersedes an attempt, it does not stop the run.
  });
  if (written.kind === "settled") {
    return refuse(
      graphId,
      "attempt-already-settled",
      "$.node_id",
      "graph-control refused [attempt-already-settled]: node " +
      JSON.stringify(node.nodeId) +
      " attempt " +
      JSON.stringify(supersededAttemptId) +
      " settled through the acceptance core while this retry was being applied, so the " +
      "retry is refused and NOTHING was written — a settled attempt's result is " +
      "immutable, and re-executing the graph as a new run is the way to run the node " +
      "again",
    );
  }
  if (written.kind === "conflict") {
    return refuse(
      graphId,
      "control-already-decided",
      "$.attempt_id",
      "graph-control refused [control-already-decided]: node " +
      JSON.stringify(node.nodeId) +
      " attempt " +
      JSON.stringify(supersededAttemptId) +
      " already carries the control command " +
      JSON.stringify(written.existing.command) +
      " (" +
      written.existing.reason +
      "), which the retry could not be recorded beside — nothing was written",
    );
  }
  if (written.kind === "replayed") {
    // The existing decision owns the successor; do not mint another credential.
    return replayedRetry(ctx, written.decision);
  }

  // ── Mint the successor attempt, its credential and its effect ─────────────
  const credential = mintAttemptCredential(
    capability?.mintCredential ?? RUNTIME_ATTEMPT_CREDENTIAL_SOURCE,
    attemptCredentialBinding({
      graphId,
      nodeId: node.nodeId,
      attemptId: successorAttemptId,
      planRevision: plan.planRevision,
    }),
  );
  // The host's store adopts the value INSIDE this transaction, so the state that
  // records its digest and the store that holds the value commit together.
  credentialStore.remember(
    Object.freeze({ graphId, nodeId: node.nodeId, attemptId: successorAttemptId }),
    credential,
  );
  const nodes: OutcomeNodeState[] = state.nodes.map((entry) =>
    entry.nodeId !== node.nodeId
      ? entry
      : Object.freeze({
        nodeId: node.nodeId,
        status: "dispatched" as const,
        attemptId: successorAttemptId,
        attemptSeq,
        attemptCredentialDigest: attemptCredentialDigest(credential),
        // The declarer is not the new worker. Its invocation identity must not
        // become the successor's dispatch identity.
        dispatchedAt: request.at,
        // The arrival record is not this command's to change: it is the
        // canonical list of settled feeders, and a retry settles nothing.
        arrivals: entry.arrivals ?? Object.freeze([]),
        // The binding carried from the attempt this retry supersedes (D6), so
        // the successor is delivered exactly what its predecessor was armed
        // with.
        inputs: carriedInputs,
      }),
  );
  const nextState: OutcomeGraphState = Object.freeze({
    ...state,
    nodes: Object.freeze(nodes),
    attemptSeq,
  });
  // State, effect, decision, reservation and protected credential share the
  // transaction owned by applyGraphControl.
  tx.writeGraphState(stateRecordOf(nextState, request.at));
  tx.writeEffect(
    Object.freeze({
      graphId,
      effectId: dispatchEffectIdOf(successorAttemptId),
      attemptId: successorAttemptId,
      kind: "dispatch",
      payload,
      createdAt: request.at,
      status: "pending" as const,
    }),
  );
  return Object.freeze({
    kind: "applied" as const,
    graphId,
    runId: run.runId,
    command: request.command,
    scope: "attempt" as const,
    minted: Object.freeze([
      Object.freeze({
        nodeId: node.nodeId,
        attemptId: successorAttemptId,
        attemptSeq,
        effectId: dispatchEffectIdOf(successorAttemptId),
      }),
    ]),
    decided: Object.freeze([
      Object.freeze({
        nodeId: node.nodeId,
        attemptId: supersededAttemptId,
        decision: written.decision,
        replayed: false,
      }),
    ]),
    runControl: written.runControl,
    skipped: Object.freeze([]),
    expiredApprovals: ctx.expiredApprovals,
    // Read the old state so the superseded attempt's external work stays visible.
    unsettledEffects: Object.freeze(tx.pendingEffects(graphId, run.runId)),
    unconfirmedExecutions: unconfirmedExecutionsOf(tx, state),
  });
}

function replayedRetry(
  ctx: ControlCommandContext<"retry">,
  decision: ControlDecisionRecord,
): GraphControlResult {
  const { tx, graphId, run, state, request } = ctx;
  const successorAttemptId = decision.successorAttemptId;
  const attemptSeq = successorAttemptId === undefined
    ? undefined
    : attemptSeqOf(successorAttemptId, decision.nodeId);
  if (successorAttemptId === undefined || attemptSeq === undefined) {
    return refuse(
      graphId,
      "run-state-unreadable",
      "$.node_id",
      "graph-control refused [run-state-unreadable]: the recorded retry of node " +
      JSON.stringify(decision.nodeId) +
      " attempt " +
      JSON.stringify(decision.attemptId) +
      " carries no valid successor attempt identity, so the attempt that stands cannot be established " +
      "and nothing was written",
    );
  }
  return Object.freeze({
    kind: "applied" as const,
    graphId,
    runId: run.runId,
    command: request.command,
    scope: "attempt" as const,
    minted: Object.freeze([
      Object.freeze({
        nodeId: decision.nodeId,
        attemptId: successorAttemptId,
        // The sequence is derived from the successor id the decision recorded,
        // and only when the id carries this node's own prefix — a successor id
        // from another node could not be this decision's attempt.
        attemptSeq,
        effectId: dispatchEffectIdOf(successorAttemptId),
      }),
    ]),
    decided: Object.freeze([
      Object.freeze({
        nodeId: decision.nodeId,
        attemptId: decision.attemptId,
        decision,
        replayed: true,
      }),
    ]),
    runControl: ctx.runs.readRunControlOf(graphId, run.runId),
    skipped: Object.freeze([]),
    expiredApprovals: ctx.expiredApprovals,
    unsettledEffects: Object.freeze(tx.pendingEffects(graphId, run.runId)),
    unconfirmedExecutions: unconfirmedExecutionsOf(tx, state),
  });
}

function attemptSeqOf(successorAttemptId: string, nodeId: string): number | undefined {
  const prefix = nodeId + "#";
  if (!successorAttemptId.startsWith(prefix)) return undefined;
  const parsed = Number(successorAttemptId.slice(prefix.length));
  return Number.isSafeInteger(parsed) && parsed > 0 && successorAttemptId === prefix + parsed
    ? parsed
    : undefined;
}

function orderReexecution(
  ctx: ControlCommandContext<"retry">,
): GraphControlResult {
  const { tx, runs, graphId, run, state, request, principal } = ctx;
  const decidedBy = principalOf(principal);
  const stopping = runs.readRunControlOf(graphId, run.runId);
  const terminal =
    stopping !== undefined || state.phase === "complete" || state.phase === "stopped";
  if (!terminal) {
    return refuse(
      graphId,
      "run-not-terminal",
      "$.graph_id",
      "graph-control refused [run-not-terminal]: run " +
      JSON.stringify(run.runId) +
      " of graph " +
      JSON.stringify(graphId) +
      " is " +
      state.phase +
      " and carries no control fact, so it is still executing — a new run replaces a " +
      "FINISHED one; supersede one attempt with a node-scoped retry, and nothing was " +
      "written",
    );
  }
  const inFlight = new Set<string>();
  const settledAttempts = new Set<string>();
  for (const node of state.nodes) {
    if (node.attemptId === undefined) continue;
    if (node.status === "dispatched") inFlight.add(node.attemptId);
    if (node.status === "settled") settledAttempts.add(node.attemptId);
  }
  const blocking = blockingReexecutionEffectsOf(tx.pendingEffects(graphId, run.runId), {
    // A platform-CONFIRMED cancellation is the fact that accounts for an
    // abandoned execution, and it is a TERMINAL cancel effect — so it is read
    // separately from the unsettled set the loop above walks.
    cancelled: new Set(tx.confirmedCancelAttempts(graphId, run.runId)),
    inFlight,
    settled: settledAttempts,
  });
  if (blocking.length > 0) {
    return refuse(
      graphId,
      "run-has-unsettled-effects",
      "$.effect_id",
      "graph-control refused [run-has-unsettled-effects]: run " +
      JSON.stringify(run.runId) +
      " of graph " +
      JSON.stringify(graphId) +
      " still owes external work whose fate is unknown — " +
      blocking
        .map(
          (effect) =>
            effect.effectId + " (attempt " + effect.attemptId + ", " + effect.status + ")",
        )
        .join(", ") +
      " — so re-executing the graph could re-run a side effect that is still live; a " +
      "platform-confirmed cancellation of those attempts clears them, and nothing was " +
      "written",
    );
  }

  const recorded = runs.recordReexecution(
    Object.freeze({
      graphId,
      runId: run.runId,
      reason: request.reason,
      decidedAt: request.at,
      decidedBy,
    }),
  );
  const order = recorded.reexecution;
  const successor = order.successorRunId === undefined
    ? undefined
    : runs.readRunOf(graphId, order.successorRunId);
  if (order.successorRunId !== undefined && successor === undefined) {
    return refuse(
      graphId,
      "run-state-unreadable",
      "$.graph_id",
      "graph-control refused [run-state-unreadable]: the recorded reexecution of run " +
      JSON.stringify(run.runId) + " names successor " + JSON.stringify(order.successorRunId) +
      " which has no stored run identity — nothing was written",
    );
  }
  // Close this run in the same transaction as the order. An earlier stop keeps
  // its original command; the store fences late writes once a successor starts.
  runs.claimRunControl(
    Object.freeze({
      graphId,
      runId: run.runId,
      command: "retry" as const,
      reason: request.reason,
      decidedAt: request.at,
      decidedBy,
    }),
  );
  return Object.freeze({
    kind: "applied" as const,
    graphId,
    runId: run.runId,
    command: request.command,
    scope: "run" as const,
    minted: Object.freeze([]),
    decided: Object.freeze([]),
    runControl: runs.readRunControlOf(graphId, run.runId),
    skipped: Object.freeze([]),
    expiredApprovals: ctx.expiredApprovals,
    reexecution: Object.freeze({
      fromRunId: run.runId,
      order,
      ...(successor === undefined
        ? {}
        : {
          successorRunId: successor.runId,
          successorRunSeq: successor.runSeq,
        }),
    }),
    unsettledEffects: Object.freeze(tx.pendingEffects(graphId, run.runId)),
    unconfirmedExecutions: unconfirmedExecutionsOf(tx, state),
  });
}
