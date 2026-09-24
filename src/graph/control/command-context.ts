import type { CompiledPlan } from "../compiler/plan.ts";
import type {
  ApprovalRequestRecord, ControlCommandName, ControlPrincipalRecord, RunControlLedger, StoredRunIdentity,
} from "../ledger/types.ts";
import type { OutcomeGraphState } from "../outcome/graph-state.ts";
import type { GraphStoreTx } from "../store/graph-store.ts";
import { isApprovalCommand } from "./approval.ts";
import type { GraphControlPrincipal, GraphControlRefusalCode, GraphControlRequest, GraphControlResult } from "./contracts.ts";

export type GraphControlRefused = Extract<GraphControlResult, { readonly kind: "refused" }>;

/** A refusal commits only when a handler explicitly records a terminal fact, such as expiry. */
export type ControlCommandOutcome = GraphControlResult | {
  readonly kind: "committed-refusal";
  readonly result: GraphControlRefused;
};

export interface ControlCommandContext<C extends ControlCommandName> {
  readonly tx: GraphStoreTx;
  readonly runs: RunControlLedger;
  readonly graphId: string;
  readonly plan: CompiledPlan;
  readonly run: StoredRunIdentity;
  readonly state: OutcomeGraphState;
  readonly settled: ReadonlySet<string>;
  readonly request: GraphControlRequest & { readonly command: C };
  readonly principal: GraphControlPrincipal;
  readonly expiredApprovals: readonly ApprovalRequestRecord[];
}

export function refuse(
  graphId: string,
  code: GraphControlRefusalCode,
  path: string,
  message: string,
): GraphControlRefused {
  return Object.freeze({
    kind: "refused" as const,
    graphId,
    refusals: Object.freeze([Object.freeze({ code, path, message })]),
  });
}

export function principalOf(
  principal: GraphControlPrincipal,
): ControlPrincipalRecord {
  if (principal.agentId === undefined || principal.agentId.length === 0) {
    return Object.freeze({ sessionId: principal.sessionId });
  }
  return Object.freeze({ sessionId: principal.sessionId, agentId: principal.agentId });
}

type NodeTargetResult =
  | { readonly kind: "resolved"; readonly nodeId: string; readonly attemptId: string }
  | { readonly kind: "refused"; readonly result: GraphControlRefused };

/** Approval decisions may replay after settlement; other commands require an in-flight attempt. */
export function resolveNodeTarget(args: {
  readonly graphId: string;
  readonly state: OutcomeGraphState;
  readonly settled: ReadonlySet<string>;
  readonly nodeId: string | undefined;
  readonly attemptId: string | undefined;
  readonly command: ControlCommandName;
  readonly requireInFlight?: boolean;
}): NodeTargetResult {
  const { graphId, state, settled, nodeId, attemptId, command } = args;
  const requireInFlight = args.requireInFlight ?? true;
  if (nodeId === undefined) {
    return {
      kind: "refused",
      result: refuse(
        graphId,
        "unknown-node",
        "$.node_id",
        "graph-control refused [unknown-node]: command " +
        JSON.stringify(command) +
        " names the attempt it applies to, so node_id is required and was not supplied",
      ),
    };
  }
  const node = state.nodes.find((entry) => entry.nodeId === nodeId);
  if (node === undefined) {
    return {
      kind: "refused",
      result: refuse(
        graphId,
        "unknown-node",
        "$.node_id",
        "graph-control refused [unknown-node]: graph " +
        JSON.stringify(graphId) +
        " declares no node " +
        JSON.stringify(nodeId),
      ),
    };
  }
  if (node.attemptId === undefined) {
    return {
      kind: "refused",
      result: refuse(
        graphId,
        "attempt-absent",
        "$.node_id",
        "graph-control refused [attempt-absent]: node " +
        JSON.stringify(node.nodeId) +
        " records no attempt at all (" +
        node.status +
        "), so there is no attempt for " +
        JSON.stringify(command) +
        " to record",
      ),
    };
  }
  if (attemptId !== undefined && attemptId !== node.attemptId) {
    return {
      kind: "refused",
      result: refuse(
        graphId,
        "attempt-not-current",
        "$.attempt_id",
        "graph-control refused [attempt-not-current]: node " +
        JSON.stringify(node.nodeId) +
        " is in flight on attempt " +
        JSON.stringify(node.attemptId) +
        " and the command names " +
        JSON.stringify(attemptId) +
        " — a control fact is never attached to an attempt the run no longer holds",
      ),
    };
  }
  if (requireInFlight && settled.has(node.attemptId)) {
    return {
      kind: "refused",
      result: refuse(
        graphId,
        "attempt-already-settled",
        "$.node_id",
        "graph-control refused [attempt-already-settled]: node " +
        JSON.stringify(node.nodeId) +
        " attempt " +
        JSON.stringify(node.attemptId) +
        " already settled through the acceptance core, and a settled attempt is never " +
        (isApprovalCommand(command)
          ? "paused for approval or otherwise re-labelled"
          : "re-labelled as failed, timed out or cancelled"),
      ),
    };
  }
  if (requireInFlight && node.status !== "dispatched") {
    return {
      kind: "refused",
      result: refuse(
        graphId,
        "attempt-absent",
        "$.node_id",
        "graph-control refused [attempt-absent]: node " +
        JSON.stringify(node.nodeId) +
        " is " +
        node.status +
        ", not in flight, so there is nothing for " +
        JSON.stringify(command) +
        " to record",
      ),
    };
  }
  return { kind: "resolved", nodeId: node.nodeId, attemptId: node.attemptId };
}
