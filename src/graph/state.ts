import type { FlowEdge, ResolvedGraph } from "../types.ts";
import { PARENT_NODE } from "../constants.ts";
import { GraphStore } from "./graph-store.ts";

export interface GraphExecutionState {
  frontier: string[];
  completed: string[];
  iterationCount: number;
  status: "active" | "complete" | "exhausted";
}

export type AdvanceResult =
  | { kind: "advanced"; frontier: string[] }
  | { kind: "completed" }
  | { kind: "exhausted" }
  | { kind: "off_route"; expected: string[]; got: string }
  | { kind: "unknown"; got: string }
  | { kind: "ignored" };

export class GraphSessionState {
  private graphs: Map<string, ResolvedGraph> = new Map();
  private states: Map<string, GraphExecutionState> = new Map();
  private agentIds: Map<string, string> = new Map();
  private store?: GraphStore;
  private _dirty = false;
  private _persistTimer?: ReturnType<typeof setTimeout>;

  setStoreDirectory(dir: string): void {
    this.store = new GraphStore(dir);
  }

  initGraph(sessionID: string, graph: ResolvedGraph, agentId?: string): void {
    this.graphs.set(sessionID, graph);
    this.agentIds.set(sessionID, agentId ?? sessionID);
    const frontier: string[] = [];
    for (const e of graph.edges) {
      if (
        e.from === PARENT_NODE &&
        e.to !== PARENT_NODE &&
        !frontier.includes(e.to)
      ) {
        frontier.push(e.to);
      }
    }
    this.states.set(sessionID, {
      frontier,
      completed: [],
      iterationCount: 0,
      status: "active",
    });
    this._persist();
  }

  advanceStep(sessionID: string, completedAgent: string): AdvanceResult {
    const state = this.states.get(sessionID);
    const graph = this.graphs.get(sessionID);
    if (!state || !graph) return { kind: "ignored" };
    if (state.status !== "active") return { kind: "ignored" };

    if (!graph.nodes.includes(completedAgent)) {
      return { kind: "unknown", got: completedAgent };
    }

    if (!state.frontier.includes(completedAgent)) {
      return {
        kind: "off_route",
        expected: [...state.frontier],
        got: completedAgent,
      };
    }

    state.frontier = state.frontier.filter((a) => a !== completedAgent);

    const lastCompleted = state.completed[state.completed.length - 1];
    if (lastCompleted !== completedAgent) {
      state.completed.push(completedAgent);
    }

    const outgoing = graph.edges.filter((e) => e.from === completedAgent);
    const exitEdges = outgoing.filter((e) => e.exit || e.to === PARENT_NODE);
    const forward = outgoing.filter((e) => !e.exit && e.to !== PARENT_NODE);

    let skippedLoopDueToCap = false;
    for (const e of forward) {
      if (state.completed.includes(e.to)) {
        state.iterationCount++;
        if (state.iterationCount > graph.maxIterations) {
          skippedLoopDueToCap = true;
          continue;
        }
      }
      if (!state.frontier.includes(e.to)) {
        state.frontier.push(e.to);
      }
    }

    this._persist();

    if (state.frontier.length === 0) {
      if (
        forward.length > 0 &&
        skippedLoopDueToCap &&
        exitEdges.length === 0
      ) {
        state.status = "exhausted";
        return { kind: "exhausted" };
      }
      state.status = "complete";
      return { kind: "completed" };
    }

    return { kind: "advanced", frontier: [...state.frontier] };
  }

  getNextAction(
    state: GraphExecutionState,
    graph: ResolvedGraph,
  ): FlowEdge[] {
    if (state.status !== "active") return [];
    return graph.edges.filter((e) => state.frontier.includes(e.to));
  }

  getState(sessionID: string): GraphExecutionState | undefined {
    return this.states.get(sessionID);
  }

  getGraph(sessionID: string): ResolvedGraph | undefined {
    return this.graphs.get(sessionID);
  }

  isComplete(sessionID: string): boolean {
    const state = this.states.get(sessionID);
    if (!state) return false;
    return state.status === "complete" || state.status === "exhausted";
  }

  clear(sessionID: string): void {
    this.states.delete(sessionID);
    this.graphs.delete(sessionID);
    this.agentIds.delete(sessionID);
    this._persist();
  }

  private _persist(): void {
    if (!this.store) return;
    this._dirty = true;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(async () => {
      this._persistTimer = undefined;
      if (!this._dirty) return;
      this._dirty = false;
      try {
        const sessions = new Map<string, { agentId: string; state: GraphExecutionState }>();
        for (const [sessionID, state] of this.states) {
          sessions.set(sessionID, {
            agentId: this.agentIds.get(sessionID) ?? sessionID,
            state,
          });
        }
        await this.store!.save(sessions);
      } catch {}
    }, 500);
  }

  flushSync(): void {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = undefined;
    }
    if (!this._dirty) return;
    this._dirty = false;
    if (this.store) {
      try {
        const sessions = new Map<string, { agentId: string; state: GraphExecutionState }>();
        for (const [sessionID, state] of this.states) {
          sessions.set(sessionID, {
            agentId: this.agentIds.get(sessionID) ?? sessionID,
            state,
          });
        }
        this.store.saveSync(sessions);
      } catch {}
    }
  }

  recover(reattach: (sessionID: string) => ResolvedGraph | undefined): void {
    if (!this.store) return;
    const loaded = this.store.load();
    if (!loaded) return;
    for (const [sessionID, entry] of loaded) {
      const graph = reattach(sessionID);
      if (graph) {
        this.graphs.set(sessionID, graph);
        this.states.set(sessionID, entry.state);
        this.agentIds.set(sessionID, entry.agentId);
      }
    }
  }
}

export const graphSessionState = new GraphSessionState();

export function buildGraphStateBlock(
  state: GraphExecutionState,
  graph: ResolvedGraph,
): string {
  const frontierStr = state.frontier.join(", ") || "none";
  const completedStr = state.completed.join(", ") || "none";
  const iterStr = `${state.iterationCount}/${graph.maxIterations || "unlimited"}`;

  let nextAction: string;
  if (state.status === "active") {
    nextAction = state.frontier
      .map((target) => {
        const edge = graph.edges.find((e) => e.to === target);
        return `Dispatch to ${target}${edge?.label ? ` (${edge.label})` : ""}`;
      })
      .join("\n  ");
  } else if (state.status === "exhausted") {
    nextAction = "Workflow exhausted";
  } else {
    nextAction = "Workflow complete";
  }

  return `<collaboration_state>
  <status>${state.status}</status>
  <frontier>${frontierStr}</frontier>
  <completed>${completedStr}</completed>
  <iteration>${iterStr}</iteration>
  <next_action>${nextAction}</next_action>
</collaboration_state>`;
}
