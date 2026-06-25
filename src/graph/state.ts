import type { FlowEdge, ResolvedGraph } from "../types.js";

export interface GraphExecutionState {
  currentStep: number;
  completedSteps: string[];
  iterationCount: number;
  status: "active" | "complete" | "exhausted";
}

export class GraphSessionState {
  private graphs: Map<string, ResolvedGraph> = new Map();
  private states: Map<string, GraphExecutionState> = new Map();

  initGraph(sessionID: string, graph: ResolvedGraph): void {
    this.graphs.set(sessionID, graph);
    this.states.set(sessionID, {
      currentStep: 0,
      completedSteps: [],
      iterationCount: 0,
      status: "active",
    });
  }

  advanceStep(sessionID: string, completedAgent: string): void {
    const state = this.states.get(sessionID);
    const graph = this.graphs.get(sessionID);
    if (!state || !graph) return;
    if (state.status !== "active") return;

    state.completedSteps.push(completedAgent);

    let nextIdx = -1;
    for (let i = 0; i < graph.edges.length; i++) {
      if (graph.edges[i].from === completedAgent) {
        nextIdx = i;
        break;
      }
    }

    if (nextIdx === -1) {
      state.status = "complete";
      return;
    }

    const nextEdge = graph.edges[nextIdx];

    if (nextEdge.exit || nextEdge.to === "parent") {
      state.currentStep = nextIdx;
      state.status = "complete";
      return;
    }

    if (state.completedSteps.includes(nextEdge.to)) {
      state.iterationCount++;
      if (state.iterationCount > graph.maxIterations) {
        state.status = "exhausted";
        state.currentStep = nextIdx;
        return;
      }
      state.currentStep = nextIdx;
      return;
    }

    state.currentStep = nextIdx;
  }

  getNextAction(state: GraphExecutionState, graph: ResolvedGraph): FlowEdge | undefined {
    if (state.status !== "active") return undefined;
    return graph.edges[state.currentStep];
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
  }
}

export const graphSessionState = new GraphSessionState();

export function buildGraphStateBlock(
  state: GraphExecutionState,
  graph: ResolvedGraph,
): string {
  const stepInfo = state.status === "active"
    ? graph.edges[state.currentStep]
    : null;

  const nextAction = stepInfo
    ? `Dispatch to ${stepInfo.to}${stepInfo.label ? ` (${stepInfo.label})` : ""}`
    : "Workflow complete";

  return `<collaboration_state>
  <status>${state.status}</status>
  <current_step>${state.currentStep}</current_step>
  <completed_steps>${state.completedSteps.join(", ") || "none"}</completed_steps>
  <iteration>${state.iterationCount}/${graph.maxIterations || "unlimited"}</iteration>
  <next_action>${nextAction}</next_action>
</collaboration_state>`;
}
