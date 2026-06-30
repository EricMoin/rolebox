import type { ResolvedGraph } from "../types.ts";
import { PARENT_NODE } from "../constants.ts";
import { isExitEdge } from "./graph-utils.ts";
import { GraphStore } from "./graph-store.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("graph:state");

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

interface SessionEntry {
  graph: ResolvedGraph;
  state: GraphExecutionState;
  agentId: string;
}

export class GraphSessionState {
  private sessions: Map<string, SessionEntry> = new Map();
  private store?: GraphStore;
  private _dirty = false;
  private _persistTimer?: ReturnType<typeof setTimeout>;

  setStoreDirectory(dir: string): void {
    this.store = new GraphStore(dir);
  }

  initGraph(sessionID: string, graph: ResolvedGraph, agentId?: string): void {
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
    this.sessions.set(sessionID, {
      graph,
      agentId: agentId ?? sessionID,
      state: {
        frontier,
        completed: [],
        iterationCount: 0,
        status: "active",
      },
    });
    this._persist();
  }

  advanceStep(sessionID: string, completedAgent: string): AdvanceResult {
    const entry = this.sessions.get(sessionID);
    if (!entry) return { kind: "ignored" };
    const { state, graph } = entry;
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
    const exitEdges = outgoing.filter(isExitEdge);
    const forward = outgoing.filter((e) => !isExitEdge(e));

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

  getState(sessionID: string): GraphExecutionState | undefined {
    return this.sessions.get(sessionID)?.state;
  }

  getGraph(sessionID: string): ResolvedGraph | undefined {
    return this.sessions.get(sessionID)?.graph;
  }

  isComplete(sessionID: string): boolean {
    const state = this.sessions.get(sessionID)?.state;
    if (!state) return false;
    return state.status === "complete" || state.status === "exhausted";
  }

  clear(sessionID: string): void {
    this.sessions.delete(sessionID);
    this._persist();
  }

  private _snapshotForStore(): Map<string, { agentId: string; state: GraphExecutionState }> {
    const snapshot = new Map<string, { agentId: string; state: GraphExecutionState }>();
    for (const [sessionID, entry] of this.sessions) {
      snapshot.set(sessionID, { agentId: entry.agentId, state: entry.state });
    }
    return snapshot;
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
        await this.store!.save(this._snapshotForStore());
      } catch (err) {
        log.warn("Failed to persist graph state", err);
      }
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
        this.store.saveSync(this._snapshotForStore());
      } catch (err) {
        log.warn("Failed to persist graph state (sync)", err);
      }
    }
  }

  recover(reattach: (sessionID: string, agentId: string) => ResolvedGraph | undefined): void {
    if (!this.store) return;
    const loaded = this.store.load();
    if (!loaded) return;
    for (const [sessionID, entry] of loaded) {
      const graph = reattach(sessionID, entry.agentId);
      if (graph) {
        this.sessions.set(sessionID, {
          graph,
          state: entry.state,
          agentId: entry.agentId,
        });
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
