import { errorText } from "../../utils/error-text.ts";
import type { CompiledPlan } from "../compiler/plan.ts";
import type { ApprovalRequestRecord } from "../ledger/types.ts";
import { dispatchEffectIdOf } from "../outcome/dispatch-effects.ts";
import { readOutcomeGraphState, type OutcomeGraphState } from "../outcome/graph-state.ts";
import { decodeStoredDefinition } from "../persistence/declared-record.ts";
import { APPROVAL_DEADLINE_REASON, type GraphStore, type GraphStoreTx } from "../store/graph-store.ts";
import type { GraphDefinitionRecord } from "../store/records.ts";
import { isApprovalDecision } from "./approval.ts";
import { applyApprovalCommand } from "./approval-command.ts";
import { refuse, type ControlCommandOutcome, type GraphControlRefused } from "./command-context.ts";
import type { GraphControlPrincipal, GraphControlRequest, GraphControlResult } from "./contracts.ts";
import { applyRetryCommand } from "./retry-command.ts";
import { applyStopCommand } from "./stop-command.ts";

export type {
  GraphControlPrincipal,
  GraphControlRetryCapability,
  GraphControlRequest,
  GraphControlRefusalCode,
  GraphControlRefusal,
  GraphControlAttemptDecision,
  GraphControlSkippedAttempt,
  GraphControlUnconfirmedExecution,
  GraphControlMintedAttempt,
  GraphControlReexecution,
  GraphControlApproval,
  GraphControlResult,
} from "./contracts.ts";

class ControlTransactionRefused extends Error {
  constructor(readonly result: GraphControlRefused) {
    super("graph-control: the refused command was rolled back");
    this.name = "ControlTransactionRefused";
  }
}

/** The sole transaction boundary for authorization, command writes and their reports. */
export function applyGraphControl(store: GraphStore, request: GraphControlRequest): GraphControlResult {
  const graphId = request.graphId;
  const principal = request.principal;
  if (
    typeof principal !== "object" || principal === null ||
    typeof principal.sessionId !== "string" || principal.sessionId.length === 0
  ) {
    return refuse(
      graphId,
      "control-principal-absent",
      "$.principal",
      "graph-control refused [control-principal-absent]: the call carries no session " +
      "attribution, so there is no principal to check against the graph's declaring " +
      "invocation — control belongs to the trusted invocation the platform attributed to " +
      "the call, never to a value in the request, and nothing was written",
    );
  }
  try {
    return store.transaction((tx) => {
      const outcome = applyInTransaction(tx, request, principal);
      if (outcome.kind === "refused") throw new ControlTransactionRefused(outcome);
      return outcome.kind === "committed-refusal" ? outcome.result : outcome;
    });
  } catch (error) {
    if (error instanceof ControlTransactionRefused) return error.result;
    throw error;
  }
}

function sweepApprovals(
  tx: GraphStoreTx,
  graphId: string,
  at: number,
): readonly ApprovalRequestRecord[] {
  return tx.approvals?.expireDueApprovals(graphId, at, APPROVAL_DEADLINE_REASON) ?? Object.freeze([]);
}

function applyInTransaction(
  tx: GraphStoreTx,
  request: GraphControlRequest,
  principal: GraphControlPrincipal,
): ControlCommandOutcome {
  const graphId = request.graphId;
  // Acquire the write lock before reads to avoid a shared-to-reserved lock promotion race.
  tx.runs?.lockControlWrite(graphId);

  const row: GraphDefinitionRecord | undefined = tx.readDefinition(graphId);
  if (row === undefined) {
    return refuse(
      graphId,
      "graph-unknown",
      "$.graph_id",
      "graph-control refused [graph-unknown]: the workspace store holds no definition " +
      "for graph " +
      JSON.stringify(graphId) +
      " — a control command is never applied to a graph this store does not know",
    );
  }
  const decoded = decodeStoredDefinition(row);
  if (decoded.kind !== "ok") {
    return refuse(
      graphId,
      "definition-unreadable",
      "$.graph_id",
      "graph-control refused [definition-unreadable]: the stored definition of graph " +
      JSON.stringify(graphId) +
      " is not one this build can run: " +
      decoded.issues
        .map((issue) => "[" + issue.code + "] " + issue.path + ": " + issue.message)
        .join("; "),
    );
  }
  const plan: CompiledPlan = decoded.declared.plan;

  const origin = tx.readInvocationOrigin(graphId);
  if (origin === undefined) {
    return refuse(
      graphId,
      "control-declarant-unknown",
      "$.principal",
      "graph-control refused [control-declarant-unknown]: graph " +
      JSON.stringify(graphId) +
      " has no recorded declaring invocation, so there is no principal this store can " +
      "authorize to control it — an unattributed graph is not a graph anyone may stop",
    );
  }
  const hostFailure = request.hostFailure;
  if (hostFailure !== undefined) {
    const binding = request.attemptId === undefined ? undefined : tx.readExecution({
      graphId, attemptId: request.attemptId, effectId: dispatchEffectIdOf(request.attemptId),
    });
    if (request.command !== "failure" || !request.nodeId || !request.attemptId ||
      binding?.state !== "created" || binding.execution?.executionId !== hostFailure.executionId ||
      binding.execution?.taskId !== hostFailure.taskId ||
      tx.readExecutionObservation(hostFailure.executionId)?.kind !== "failed") {
      return refuse(graphId, "control-not-authorized", "$.hostFailure", "Host failure does not match a confirmed attempt execution");
    }
  }
  if (hostFailure === undefined && origin.sessionId !== principal.sessionId && !isApprovalDecision(request.command)) {
    return refuse(
      graphId,
      "control-not-authorized",
      "$.principal",
      "graph-control refused [control-not-authorized]: the caller is session " +
      JSON.stringify(principal.sessionId) +
      " while graph " +
      JSON.stringify(graphId) +
      " was declared by session " +
      JSON.stringify(origin.sessionId) +
      " — control belongs to the DECLARING principal, never to a dispatched worker and " +
      "never to a caller that merely names the graph",
    );
  }

  const runs = tx.runs;
  const run = runs?.readRun(graphId);
  if (runs === undefined || run === undefined) {
    return refuse(
      graphId,
      "run-not-started",
      "$.graph_id",
      "graph-control refused [run-not-started]: graph " +
      JSON.stringify(graphId) +
      " holds no run identity — it has never begun an execution, so there is no run to " +
      "control and nothing was written",
    );
  }
  const record = tx.readGraphState(graphId);
  if (record === undefined) {
    return refuse(
      graphId,
      "run-state-unreadable",
      "$.graph_id",
      "graph-control refused [run-state-unreadable]: run " +
      JSON.stringify(run.runId) +
      " of graph " +
      JSON.stringify(graphId) +
      " has no state snapshot — the run's position cannot be established, so no attempt " +
      "is controlled",
    );
  }
  let state: OutcomeGraphState;
  try {
    state = readOutcomeGraphState(record, plan);
  } catch (error) {
    return refuse(
      graphId,
      "run-state-unreadable",
      "$.graph_id",
      "graph-control refused [run-state-unreadable]: the run state of graph " +
      JSON.stringify(graphId) +
      " is not this build's state for its plan (" +
      errorText(error) +
      ") — nothing was controlled",
    );
  }

  const context = {
    tx, runs, graphId, plan, run, state, principal,
    settled: new Set(tx.acceptedEvents(graphId).map((event) => event.attemptId)),
    expiredApprovals: isApprovalDecision(request.command)
      ? Object.freeze([])
      : sweepApprovals(tx, graphId, request.at),
  };
  const command = request.command;
  switch (command) {
    case "retry":
      return applyRetryCommand({ ...context, request: { ...request, command } });
    case "approval-request":
    case "approve":
    case "reject":
      return applyApprovalCommand({ ...context, request: { ...request, command } });
    case "failure":
    case "timeout":
    case "cancel":
    case "budget-stop":
      return applyStopCommand({ ...context, request: { ...request, command } });
    default: {
      const unsupported: never = command;
      throw new Error("graph-control: unsupported command " + String(unsupported));
    }
  }
}
