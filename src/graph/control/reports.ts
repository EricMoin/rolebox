import type { CompiledPlan } from "../compiler/plan.ts";
import { buildBudgetReport, nodeBudgetLimitsOf, type BudgetReport, type NodeBudgetLimits } from "../domain/budget.ts";
import { dispatchEffectIdOf } from "../outcome/dispatch-effects.ts";
import type { OutcomeGraphState } from "../outcome/graph-state.ts";
import type { GraphStoreTx } from "../store/graph-store.ts";
import type { GraphControlUnconfirmedExecution } from "./contracts.ts";

export function unconfirmedExecutionsOf(
  tx: GraphStoreTx,
  state: OutcomeGraphState,
): readonly GraphControlUnconfirmedExecution[] {
  const out: GraphControlUnconfirmedExecution[] = [];
  for (const node of state.nodes) {
    if (node.status !== "dispatched" || node.attemptId === undefined) continue;
    const effectId = dispatchEffectIdOf(node.attemptId);
    const row = tx.readExecution({
      graphId: state.graphId,
      effectId,
      attemptId: node.attemptId,
    });
    if (row === undefined || row.attemptId !== node.attemptId) continue;
    if (row.state === "created") continue;
    out.push(
      Object.freeze({
        nodeId: node.nodeId,
        attemptId: node.attemptId,
        effectId,
        state: row.state,
        ...(row.execution === undefined ? {} : { executionId: row.execution.executionId }),
        ...(row.execution?.taskId === undefined ? {} : { taskId: row.execution.taskId }),
      }),
    );
  }
  return Object.freeze(out);
}

export function budgetReportField(
  tx: GraphStoreTx,
  plan: CompiledPlan,
  graphId: string,
  runId: string,
): { readonly budget?: BudgetReport } {
  const budget = tx.budget;
  if (budget === undefined) return {};
  const nodes: { readonly nodeId: string; readonly limits: NodeBudgetLimits }[] = [];
  for (const node of plan.nodes) {
    const reading = nodeBudgetLimitsOf(node.budget);
    if (reading.kind === "refused") return {};
    nodes.push({ nodeId: node.id, limits: reading.limits });
  }
  try {
    return {
      budget: buildBudgetReport({
        graphId,
        runId,
        planRevision: plan.planRevision,
        nodes,
        usage: budget.budgetUsageOf(graphId, runId),
        runLimits: plan.budget,
      }),
    };
  } catch {
    // An unreadable budget row is NOT dressed up as an empty report: the stop
    // stands, and the field is simply absent.
    return {};
  }
}
