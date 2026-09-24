import { buildBudgetReport, nodeBudgetLimitsOf } from "../domain/budget.ts";
import { readOutcomeGraphState } from "../outcome/graph-state.ts";
import { decodeStoredDefinition, describeStoreVerdict } from "../persistence/declared-record.ts";
import type { GraphStore } from "../store/graph-store.ts";
import { loadGraphStoreSync } from "../store/load.ts";
import { errorText } from "../../utils/error-text.ts";

/** Read inside the caller's snapshot so definition, attempts and results agree. */
export function readGraphView(store: GraphStore, graphId: string) {
  const row = store.readDefinition(graphId);
  if (row === undefined) throw new Error(`Unknown graph ${JSON.stringify(graphId)}`);
  const decoded = decodeStoredDefinition(row);
  if (decoded.kind === "refused") {
    throw new Error(decoded.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "));
  }
  const { plan, declaration, recordedAt } = decoded.declared;
  const events = new Map(store.acceptedEvents(graphId).map((event) => [event.attemptId, event]));
  const runs = store.runsOf(graphId).map((run) => {
    const record = store.readGraphStateOf(graphId, run.runId);
    const state = record === undefined ? undefined : readOutcomeGraphState(record, plan);
    const control = store.readRunControlOf(graphId, run.runId);
    const attempts = store.budget.reservationsOf(graphId, run.runId).slice().sort((a, b) => a.reservedAt - b.reservedAt || Number(a.attemptId.slice(a.attemptId.lastIndexOf("#") + 1)) - Number(b.attemptId.slice(b.attemptId.lastIndexOf("#") + 1))).map((reservation) => ({
      nodeId: reservation.nodeId,
      attemptId: reservation.attemptId,
      effectId: reservation.effectId,
      armedAt: reservation.reservedAt,
      execution: store.readExecution({ graphId, attemptId: reservation.attemptId, effectId: reservation.effectId }),
      accepted: events.get(reservation.attemptId),
      result: store.readAcceptedResult(graphId, reservation.attemptId),
      budget: reservation,
    }));
    return {
      ...run,
      phase: control === undefined ? state?.phase ?? "ready" : "stopped",
      updatedAt: Math.max(record?.updatedAt ?? run.startedAt, control?.decidedAt ?? 0),
      control,
      stop: state?.stop,
      attempts,
      nodes: plan.nodes.map((node) => {
        const current = state?.nodes.find((item) => item.nodeId === node.id);
        return {
          nodeId: node.id, agent: node.agent, prompt: node.prompt,
          status: current?.status ?? "pending",
          attemptId: current?.attemptId,
          outcomeId: current?.outcomeId,
          dispatchedAt: current?.dispatchedAt,
          settledAt: current?.settledAt,
          inputs: current?.inputs,
          inputRefusals: current?.inputRefusals,
          arrivals: current?.arrivals,
        };
      }),
      loops: plan.loopGroups.map((loop) => ({
        ...loop, traversals: state?.loopTraversals[loop.id] ?? 0,
        progress: state?.loopProgress?.[loop.id],
      })),
      approvals: store.approvalRequestsOf(graphId, run.runId),
      decisions: store.controlDecisions(graphId, run.runId),
      unsettledEffects: store.pendingEffects(graphId, run.runId).map(({ payload: _payload, ...effect }) => effect),
      budget: buildBudgetReport({
        graphId, runId: run.runId, planRevision: plan.planRevision, runLimits: plan.budget,
        nodes: plan.nodes.map((node) => {
          const budget = nodeBudgetLimitsOf(node.budget);
          if (budget.kind !== "ok") throw new Error(`Invalid budget for ${node.id}`);
          return { nodeId: node.id, limits: budget.limits };
        }),
        usage: store.budget.budgetUsageOf(graphId, run.runId),
      }),
    };
  });
  const currentId = store.readRun(graphId)?.runId;
  const current = runs.find((run) => run.runId === currentId);
  return {
    graphId, planRevision: plan.planRevision, declaration, recordedAt,
    phase: current?.phase ?? "ready",
    updatedAt: current?.updatedAt ?? recordedAt,
    nodes: current?.nodes ?? plan.nodes.map((node) => ({
      nodeId: node.id, agent: node.agent, prompt: node.prompt, status: "pending" as const,
      attemptId: undefined, outcomeId: undefined, dispatchedAt: undefined, settledAt: undefined,
      inputs: undefined, inputRefusals: undefined, arrivals: undefined,
    })),
    current, runs,
  };
}

export type GraphView = ReturnType<typeof readGraphView>;
export type GraphNodeView = GraphView["nodes"][number];
export interface GraphQueryResult {
  readonly graphs: readonly GraphView[];
  readonly refused: readonly { graphId: string; reason: string }[];
  readonly blocked?: string;
}

/** Read-only inventory. Never initializes a missing store or repairs an unreadable one. */
export function queryGraphs(storeDirectory: string): GraphQueryResult {
  const loaded = loadGraphStoreSync(storeDirectory);
  if (loaded.kind === "absent") return { graphs: [], refused: [] };
  if (loaded.kind !== "valid") return { graphs: [], refused: [], blocked: describeStoreVerdict(loaded) };
  const store = loaded.value;
  try {
    return store.transaction(() => {
      const graphs: GraphView[] = [];
      const refused: { graphId: string; reason: string }[] = [];
      for (const graphId of store.definitionGraphIds()) {
        try { graphs.push(readGraphView(store, graphId)); }
        catch (error) { refused.push({ graphId, reason: errorText(error) }); }
      }
      graphs.sort((a, b) => b.updatedAt - a.updatedAt);
      return { graphs, refused };
    });
  } catch (error) {
    return { graphs: [], refused: [], blocked: errorText(error) };
  } finally {
    store.close();
  }
}
