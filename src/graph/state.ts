import type { FlowEdge, ResolvedGraph } from "../types.ts";
import { PARENT_NODE } from "../constants.ts";

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

    if (state.completedSteps.length > 0 && state.completedSteps[state.completedSteps.length - 1] === completedAgent) {
      return;
    }

    // Collect all outgoing edges from completedAgent
    const outgoingEdges = graph.edges.filter((e) => e.from === completedAgent);

    if (outgoingEdges.length === 0) {
      // Valid sink node: mark complete
      if (graph.nodes.includes(completedAgent)) {
        state.completedSteps.push(completedAgent);
        state.status = "complete";
        setTimeout(() => this.clear(sessionID), 0);
      }
      // Unknown agent: no-op, don't modify state
      return;
    }

    state.completedSteps.push(completedAgent);

    // Separate into exit edges and non-exit (loop) edges
    const exitEdges = outgoingEdges.filter(
      (e) => e.exit || e.to === PARENT_NODE,
    );
    const loopEdges = outgoingEdges.filter(
      (e) => !(e.exit || e.to === PARENT_NODE),
    );

    // Decide which edge to follow based on iteration state
    let chosenEdge: FlowEdge;
    if (
      state.iterationCount >= graph.maxIterations &&
      graph.maxIterations > 0
    ) {
      // Prefer exit when iteration limit reached
      chosenEdge = exitEdges[0] ?? loopEdges[0];
    } else {
      // Otherwise prefer looping back
      chosenEdge = loopEdges[0] ?? exitEdges[0];
    }

    const chosenIdx = graph.edges.indexOf(chosenEdge);

    // Handle exit edge
    if (chosenEdge.exit || chosenEdge.to === PARENT_NODE) {
      state.currentStep = chosenIdx;
      state.status = "complete";
      setTimeout(() => this.clear(sessionID), 0);
      return;
    }

    // Handle loop-back (target agent already visited)
    if (state.completedSteps.includes(chosenEdge.to)) {
      state.iterationCount++;
      if (state.iterationCount > graph.maxIterations) {
        state.status = "exhausted";
        state.currentStep = chosenIdx;
        setTimeout(() => this.clear(sessionID), 0);
        return;
      }
      state.currentStep = chosenIdx;
      return;
    }

    // Normal advance
    state.currentStep = chosenIdx;
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
