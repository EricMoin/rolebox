import type { ControlCommandName, RunControlRecord } from "../ledger/types.ts";
import { dispatchEffectIdOf } from "../outcome/dispatch-effects.ts";
import { principalOf, refuse, resolveNodeTarget, type ControlCommandContext } from "./command-context.ts";
import type { GraphControlAttemptDecision, GraphControlResult, GraphControlSkippedAttempt } from "./contracts.ts";
import { budgetReportField, unconfirmedExecutionsOf } from "./reports.ts";

export type StopCommandName = "cancel" | "budget-stop" | "failure" | "timeout";
const RUN_WIDE_COMMANDS: ReadonlySet<ControlCommandName> = new Set(["cancel", "budget-stop"]);

export function applyStopCommand(ctx: ControlCommandContext<StopCommandName>): GraphControlResult {
  const { tx, runs, graphId, plan, run, state, settled, request, principal, expiredApprovals } = ctx;
  const hostFailure = request.hostFailure;
  const targets: { readonly nodeId: string; readonly attemptId: string }[] = [];
  const skipped: GraphControlSkippedAttempt[] = [];

  if (RUN_WIDE_COMMANDS.has(request.command)) {
    if (request.nodeId !== undefined || request.attemptId !== undefined) {
      return refuse(
        graphId,
        "unknown-node",
        "$.node_id",
        "graph-control refused [unknown-node]: command " +
        JSON.stringify(request.command) +
        " applies to the whole run and names no node; pass neither node_id nor " +
        "attempt_id, or use a node-scoped command",
      );
    }
    for (const node of state.nodes) {
      if (node.status !== "dispatched" || node.attemptId === undefined) continue;
      if (settled.has(node.attemptId)) {
        skipped.push(
          Object.freeze({
            nodeId: node.nodeId,
            attemptId: node.attemptId,
            code: "attempt-already-settled" as const,
            message:
              "node " +
              node.nodeId +
              " attempt " +
              node.attemptId +
              " already settled through the acceptance core, so it is not cancelled — its " +
              "accepted result stands unchanged",
          }),
        );
        continue;
      }
      targets.push({ nodeId: node.nodeId, attemptId: node.attemptId });
    }
  } else {
    const target = resolveNodeTarget({
      graphId,
      state,
      settled,
      nodeId: request.nodeId,
      attemptId: request.attemptId,
      command: request.command,
    });
    if (target.kind === "refused") return target.result;
    targets.push({ nodeId: target.nodeId, attemptId: target.attemptId });
  }

  const decidedBy = principalOf(principal);
  const decided: GraphControlAttemptDecision[] = [];
  let runControl: RunControlRecord | undefined;
  for (const target of targets) {
    const written = runs.writeControlDecision({
      decision: Object.freeze({
        graphId,
        runId: run.runId,
        nodeId: target.nodeId,
        attemptId: target.attemptId,
        command: request.command,
        reason: request.reason,
        decidedAt: request.at,
        decidedBy,
      }),
      runControl: Object.freeze({
        graphId,
        runId: run.runId,
        command: request.command,
        reason: request.reason,
        decidedAt: request.at,
        decidedBy,
      }),
    });
    if (written.kind === "settled") {
      // The entry point rolls back earlier targets and the run fact when any
      // decisive write refuses the command.
      return refuse(
        graphId,
        "attempt-already-settled",
        "$.node_id",
        "graph-control refused [attempt-already-settled]: node " +
        JSON.stringify(target.nodeId) +
        " attempt " +
        JSON.stringify(target.attemptId) +
        " settled through the acceptance core while this command was being applied, so " +
        JSON.stringify(request.command) +
        " is not recorded for it and nothing was written — re-issue the command for the " +
        "attempts still in flight",
      );
    }
    if (written.kind === "conflict") {
      // An existing decision on one attempt must not block cancellation of the
      // rest of a fan-out. Keep that decision and report the attempt as skipped.
      if (RUN_WIDE_COMMANDS.has(request.command)) {
        skipped.push(
          Object.freeze({
            nodeId: target.nodeId,
            attemptId: target.attemptId,
            code: "control-already-decided" as const,
            message:
              "node " +
              target.nodeId +
              " attempt " +
              target.attemptId +
              " already carries the control command " +
              JSON.stringify(written.existing.command) +
              " (" +
              written.existing.reason +
              "), so " +
              JSON.stringify(request.command) +
              " is not recorded over it — the attempt keeps its own fact and is " +
              "reported as skipped while the command applies to the rest of the run",
          }),
        );
        continue;
      }
      return refuse(
        graphId,
        "control-already-decided",
        "$.attempt_id",
        "graph-control refused [control-already-decided]: node " +
        JSON.stringify(target.nodeId) +
        " attempt " +
        JSON.stringify(target.attemptId) +
        " already carries the control command " +
        JSON.stringify(written.existing.command) +
        " (" +
        written.existing.reason +
        "), so " +
        JSON.stringify(request.command) +
        " is not recorded over it — one attempt carries at most one control fact",
      );
    }
    runControl = written.runControl ?? runControl;
    decided.push(
      Object.freeze({
        nodeId: target.nodeId,
        attemptId: target.attemptId,
        decision: written.decision,
        replayed: written.kind === "replayed",
      }),
    );
  }

  if (runControl === undefined) {
    // A run with no eligible attempts still needs a durable stop.
    const claimed = runs.claimRunControl(
      Object.freeze({
        graphId,
        runId: run.runId,
        command: request.command,
        reason: request.reason,
        decidedAt: request.at,
        decidedBy,
      }),
    );
    if (claimed === undefined) {
      return refuse(
        graphId,
        "run-state-unreadable",
        "$.graph_id",
        "graph-control refused [run-state-unreadable]: run " +
        JSON.stringify(run.runId) +
        " of graph " +
        JSON.stringify(graphId) +
        " disappeared between this call's read and its write, so the control fact was " +
        "not recorded",
      );
    }
    runControl = claimed;
  }

  if (hostFailure !== undefined && request.attemptId && request.nodeId) {
    tx.markEffectFailed(graphId, dispatchEffectIdOf(request.attemptId));
    tx.budget?.releaseReservation({ graphId, runId: run.runId, nodeId: request.nodeId, attemptId: request.attemptId, at: request.at });
  }

  // Approval cannot resume a stopped run; expire its pending requests with the stop.
  const stoppedApprovals =
    tx.approvals === undefined
      ? Object.freeze([])
      : tx.approvals.expireRunApprovals(
        graphId,
        run.runId,
        request.at,
        "the run was stopped by the trusted control command " +
        JSON.stringify(request.command) +
        " (" +
        request.reason +
        "), so the approval pause it carried can never be answered",
      );

  return Object.freeze({
    kind: "applied" as const,
    graphId,
    runId: run.runId,
    command: request.command,
    scope: RUN_WIDE_COMMANDS.has(request.command) ? ("run" as const) : ("attempt" as const),
    minted: Object.freeze([]),
    decided: Object.freeze(decided),
    runControl,
    expiredApprovals: Object.freeze([...expiredApprovals, ...stoppedApprovals]),
    skipped: Object.freeze(skipped),
    unsettledEffects: Object.freeze(tx.pendingEffects(graphId, run.runId)),
    unconfirmedExecutions: unconfirmedExecutionsOf(tx, state),
    ...(request.command === "budget-stop"
      ? budgetReportField(tx, plan, graphId, run.runId)
      : {}),
  });
}
