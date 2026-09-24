import { basename, dirname } from "node:path";
import { EnginePhase, NodeStatus } from "../../../constants.ts";
import { queryGraphs, type GraphView } from "../../../graph/query/graph-query.ts";
import { graphStoreRoot } from "../../../graph/store/schema.ts";
import { getDataDir } from "../../paths.ts";
import type { EngineGraphSnapshot } from "./monitor-reader-types.ts";

const displayStatus = { pending: NodeStatus.Pending, dispatched: NodeStatus.Running, settled: NodeStatus.Completed };

export function projectEngineGraph(graph: GraphView): EngineGraphSnapshot {
  const nodeStatusCounts: Record<string, number> = {};
  const nodes = graph.nodes.map((node) => {
    const status = displayStatus[node.status];
    nodeStatusCounts[status] = (nodeStatusCounts[status] ?? 0) + 1;
    const attempts = graph.current?.attempts.filter((attempt) => attempt.nodeId === node.nodeId) ?? [];
    const current = attempts.find((attempt) => attempt.attemptId === node.attemptId);
    return {
      nodeId: node.nodeId, agent: node.agent, status,
      startedAt: node.dispatchedAt === undefined ? undefined : new Date(node.dispatchedAt).toISOString(),
      completedAt: node.settledAt === undefined ? undefined : new Date(node.settledAt).toISOString(),
      retryCount: Math.max(0, attempts.length - 1),
      dispatchTaskId: current?.execution?.execution?.taskId ?? current?.execution?.execution?.executionId,
      errorReason: graph.current?.control?.reason ?? graph.current?.stop?.reason,
    };
  });
  const totals = graph.current?.budget.totals;
  return {
    graphId: graph.graphId,
    phase: graph.phase === "ready" ? EnginePhase.Idle : graph.phase === "executing" ? EnginePhase.Executing : graph.phase === "stopped" ? "stopped" : EnginePhase.Complete,
    graph,
    nodeCount: nodes.length, nodeStatusCounts, nodes,
    budget: { sessionsSpawned: totals?.executions ?? 0, totalInputTokens: totals?.inputTokens ?? 0,
      totalOutputTokens: totals?.outputTokens ?? 0, totalCost: totals?.costUsd ?? 0 },
    frontier: graph.current?.unsettledEffects.filter((effect) => effect.kind === "dispatch").map((effect) => effect.attemptId) ?? [],
    loopGroups: (graph.current?.loops ?? []).map((loop) => ({ id: loop.id, traversalCount: loop.traversals, maxTraversals: loop.maxTraversals })),
    startedAt: new Date(graph.current?.startedAt ?? graph.recordedAt).toISOString(),
    updatedAt: new Date(graph.updatedAt).toISOString(), updatedAtMs: graph.updatedAt, hasCheckpoints: false,
  };
}

function workspaceOf(stateDirectory: string): string {
  return basename(stateDirectory) === "state" && basename(dirname(stateDirectory)) === ".rolebox"
    ? dirname(dirname(stateDirectory)) : stateDirectory;
}

export function readEngineGraphs(stateDirectory: string): EngineGraphSnapshot[] {
  const result = queryGraphs(graphStoreRoot(getDataDir(), workspaceOf(stateDirectory)));
  if (result.blocked !== undefined) throw new Error(`Graph monitor: ${result.blocked}`);
  if (result.refused.length) throw new Error(`Graph monitor: ${result.refused.map((item) => `${item.graphId}: ${item.reason}`).join("; ")}`);
  return result.graphs.map(projectEngineGraph);
}

export function readLiveEngineGraphs(stateDir?: string): EngineGraphSnapshot[] {
  return readEngineGraphs(stateDir ?? process.cwd());
}

function isStaleTerminalGraph(snapshot: EngineGraphSnapshot, now: number): boolean {
  if (snapshot.graph?.current?.unsettledEffects.length) return false;
  return snapshot.phase === EnginePhase.Complete && now - snapshot.updatedAtMs > 60_000;
}

export function mergeLiveEngineGraphs(disk: readonly EngineGraphSnapshot[], live: readonly EngineGraphSnapshot[], now = Date.now()): EngineGraphSnapshot[] {
  const current = new Map(live.map((graph) => [graph.graphId, graph]));
  return [...live, ...disk.filter((graph) => !current.has(graph.graphId) && !isStaleTerminalGraph(graph, now))];
}
