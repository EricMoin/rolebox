import { approvalSpecProblem, type ApprovalCommandName } from "./approval.ts";
import { principalOf, refuse, resolveNodeTarget, type ControlCommandContext, type ControlCommandOutcome } from "./command-context.ts";
import { unconfirmedExecutionsOf } from "./reports.ts";

export function applyApprovalCommand(ctx: ControlCommandContext<ApprovalCommandName>): ControlCommandOutcome {
  const { tx, runs, graphId, run, state, settled, request, principal, expiredApprovals } = ctx;
  const command = request.command;
  const approvals = tx.approvals;
  if (approvals === undefined) {
    return refuse(
      graphId,
      "approval-unavailable",
      "$.command",
      "graph-control refused [approval-unavailable]: this substrate holds no approval " +
      "records, so command " +
      JSON.stringify(request.command) +
      " was not applied — a pause that cannot be stored is not a pause, and nothing was " +
      "written",
    );
  }
  const decidedBy = principalOf(principal);

  if (command === "approval-request") {
    const target = resolveNodeTarget({
      graphId,
      state,
      settled,
      nodeId: request.nodeId,
      attemptId: request.attemptId,
      command,
    });
    if (target.kind === "refused") return target.result;
    const spec = request.approval;
    if (spec === undefined) {
      return refuse(
        graphId,
        "approval-request-malformed",
        "$.approval",
        "graph-control refused [approval-request-malformed]: an approval request must carry " +
        "the session that may decide it and the deadline it expires at, and this call " +
        "carried neither — a request no decision could legitimately resolve is a strand, " +
        "so nothing was written",
      );
    }
    const problem = approvalSpecProblem(spec, request.at);
    if (problem !== undefined) {
      return refuse(
        graphId,
        "approval-request-malformed",
        "$.approval",
        "graph-control refused [approval-request-malformed]: " + problem + " — nothing was written",
      );
    }
    const authority = request.approvalPolicy?.authorize(graphId, target.nodeId, principal.sessionId, spec.approverSessionId);
    if (authority === undefined) {
      return refuse(graphId, "approval-not-authorized", "$.approval",
        "the installed approval policy does not authorize this approver; independent review forbids self-approval");
    }
    // Neither a trusted command stop nor a declared stop can be resumed by approval.
    const stopped = runs.readRunControlOf(graphId, run.runId);
    if (stopped !== undefined) {
      return refuse(
        graphId,
        "run-stopped",
        "$.graph_id",
        "graph-control refused [run-stopped]: run " +
        JSON.stringify(run.runId) +
        " was already stopped by the trusted control command " +
        JSON.stringify(stopped.command) +
        " (" +
        stopped.reason +
        "), so an approval request would pause work that can no longer proceed — nothing " +
        "was written",
      );
    }
    if (state.phase === "stopped" || state.stop !== undefined) {
      return refuse(
        graphId,
        "run-stopped",
        "$.graph_id",
        "graph-control refused [run-stopped]: the run ended on a declared stop, " +
        "so an approval request cannot make its remaining attempts settle — nothing was written",
      );
    }
    const raised = approvals.raiseApprovalRequest(
      Object.freeze({
        graphId,
        runId: run.runId,
        nodeId: target.nodeId,
        attemptId: target.attemptId,
        status: "pending" as const,
        reason: request.reason,
        requestedAt: request.at,
        requestedBy: decidedBy,
        approverSessionId: spec.approverSessionId,
        authority,
        expiresAt: spec.expiresAt,
      }),
    );
    if (raised.kind === "settled") {
      return refuse(
        graphId,
        "attempt-already-settled",
        "$.node_id",
        "graph-control refused [attempt-already-settled]: node " +
        JSON.stringify(target.nodeId) +
        " attempt " +
        JSON.stringify(target.attemptId) +
        " settled through the acceptance core while this request was being raised, so it " +
        "is not paused — a settled attempt's result is immutable and nothing was written",
      );
    }
    // The request and its audit decision must commit together.
    const written = runs.writeControlDecision({
      decision: Object.freeze({
        graphId,
        runId: run.runId,
        nodeId: target.nodeId,
        attemptId: target.attemptId,
        command: "approval-request",
        reason: request.reason,
        decidedAt: request.at,
        decidedBy,
      }),
    });
    if (written.kind !== "recorded" && written.kind !== "replayed") {
      throw new Error(
        "graph-control: the approval request of attempt " +
        JSON.stringify(target.attemptId) +
        " landed but its control decision did not (" +
        written.kind +
        ") — the transaction is rolled back so no half-written pause survives",
      );
    }
    return Object.freeze({
      kind: "applied" as const,
      graphId,
      runId: run.runId,
      command: request.command,
      scope: "attempt" as const,
      minted: Object.freeze([]),
      decided: Object.freeze([
        Object.freeze({
          nodeId: target.nodeId,
          attemptId: target.attemptId,
          decision: written.decision,
          replayed: raised.kind === "replayed" || written.kind === "replayed",
        }),
      ]),
      runControl: runs.readRunControlOf(graphId, run.runId),
      skipped: Object.freeze([]),
      approval: Object.freeze({
        nodeId: target.nodeId,
        attemptId: target.attemptId,
        request: raised.request,
        replayed: raised.kind === "replayed",
      }),
      expiredApprovals,
      unsettledEffects: Object.freeze(tx.pendingEffects(graphId, run.runId)),
      unconfirmedExecutions: unconfirmedExecutionsOf(tx, state),
    });
  }

  // A decision can replay after settlement through that approval. Authorization
  // comes from the stored request and its pinned policy.
  const target = resolveNodeTarget({
    graphId,
    state,
    settled,
    nodeId: request.nodeId,
    attemptId: request.attemptId,
    command,
    requireInFlight: false,
  });
  if (target.kind === "refused") return target.result;
  const existing = approvals.readApprovalRequest(graphId, target.attemptId);
  if (existing === undefined) {
    return refuse(
      graphId,
      "approval-absent",
      "$.node_id",
      "graph-control refused [approval-absent]: node " +
      JSON.stringify(target.nodeId) +
      " attempt " +
      JSON.stringify(target.attemptId) +
      " carries no approval request, so " +
      JSON.stringify(request.command) +
      " has nothing to decide — raise one first with an 'approval-request' command",
    );
  }
  if (existing.approverSessionId !== principal.sessionId) {
    return refuse(
      graphId,
      "approval-not-authorized",
      "$.principal",
      "graph-control refused [approval-not-authorized]: the caller is session " +
      JSON.stringify(principal.sessionId) +
      " while the approval request of node " +
      JSON.stringify(target.nodeId) +
      " attempt " +
      JSON.stringify(target.attemptId) +
      " names " +
      JSON.stringify(existing.approverSessionId) +
      " as the ONLY session that may decide it — the declaring principal's control " +
      "authority does not imply approval authority, and nothing was written",
    );
  }
  const authority = request.approvalPolicy?.authorize(graphId, target.nodeId,
    existing.requestedBy?.sessionId ?? "", principal.sessionId);
  if (authority === undefined || authority.digest !== existing.authority.digest ||
    authority.mode !== existing.authority.mode || authority.policyId !== existing.authority.policyId ||
    authority.revision !== existing.authority.revision) {
    return refuse(graphId, "approval-not-authorized", "$.principal",
      "the approval policy pinned to this request is unavailable or changed; no decision was recorded");
  }
  const decided = approvals.decideApprovalRequest(
    Object.freeze({
      graphId,
      runId: run.runId,
      nodeId: target.nodeId,
      attemptId: target.attemptId,
      command,
      reason: request.reason,
      decidedAt: request.at,
      decidedBy,
    }),
  );
  if (decided.kind === "absent") {
    return refuse(
      graphId,
      "approval-absent",
      "$.node_id",
      "graph-control refused [approval-absent]: the approval request of attempt " +
      JSON.stringify(target.attemptId) +
      " disappeared before it could be decided, so nothing was written",
    );
  }
  if (decided.kind === "expired") {
    return {
      kind: "committed-refusal",
      result: refuse(
        graphId,
        "approval-expired",
        "$.node_id",
        "graph-control refused [approval-expired]: the approval request of node " +
        JSON.stringify(target.nodeId) +
        " attempt " +
        JSON.stringify(target.attemptId) +
        " reached its deadline " +
        String(decided.request.expiresAt) +
        " before this " +
        JSON.stringify(request.command) +
        " arrived, so the request is durably EXPIRED (" +
        String(decided.request.decisionReason ?? "") +
        ") and an expired request is never approved afterwards — the attempt cannot settle " +
        "unless the trusted path retries the node or cancels the run",
      ),
    };
  }
  if (decided.kind === "conflict") {
    return refuse(
      graphId,
      "approval-already-decided",
      "$.node_id",
      "graph-control refused [approval-already-decided]: the approval request of node " +
      JSON.stringify(target.nodeId) +
      " attempt " +
      JSON.stringify(target.attemptId) +
      " already stands " +
      JSON.stringify(decided.request.status) +
      " (" +
      String(decided.request.decisionReason ?? "") +
      ", decided at " +
      String(decided.request.decidedAt ?? 0) +
      " by " +
      JSON.stringify(decided.request.decidedBy?.sessionId ?? "the deadline") +
      "), so " +
      JSON.stringify(request.command) +
      " is not recorded over it — one request carries exactly one answer and nothing was " +
      "written",
    );
  }
  // Record the audit decision only after the request accepts or replays it.
  const written = runs.writeControlDecision({
    decision: Object.freeze({
      graphId,
      runId: run.runId,
      nodeId: target.nodeId,
      attemptId: target.attemptId,
      command: request.command,
      reason: request.reason,
      decidedAt: decided.request.decidedAt ?? request.at,
      decidedBy,
    }),
  });
  if (written.kind !== "recorded" && written.kind !== "replayed") {
    throw new Error(
      "graph-control: approval " +
      JSON.stringify(request.command) +
      " of attempt " +
      JSON.stringify(target.attemptId) +
      " landed but its control decision did not (" +
      written.kind +
      ") — the transaction is rolled back so no half-written decision survives",
    );
  }
  return Object.freeze({
    kind: "applied" as const,
    graphId,
    runId: run.runId,
    command: request.command,
    scope: "attempt" as const,
    minted: Object.freeze([]),
    decided: Object.freeze([
      Object.freeze({
        nodeId: target.nodeId,
        attemptId: target.attemptId,
        decision: written.decision,
        replayed: decided.kind === "replayed" || written.kind === "replayed",
      }),
    ]),
    runControl: runs.readRunControlOf(graphId, run.runId),
    skipped: Object.freeze([]),
    approval: Object.freeze({
      nodeId: target.nodeId,
      attemptId: target.attemptId,
      request: decided.request,
      replayed: decided.kind === "replayed",
    }),
    expiredApprovals,
    unsettledEffects: Object.freeze(tx.pendingEffects(graphId, run.runId)),
    unconfirmedExecutions: unconfirmedExecutionsOf(tx, state),
  });
}
