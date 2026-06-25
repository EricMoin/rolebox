import type { FlowEdge, GraphTemplate } from "../types.js";

const PARENT = "parent";

export function expandTemplate(
  topology: GraphTemplate,
  agents: string[],
): FlowEdge[] {
  if (agents.length === 0) {
    return [];
  }

  switch (topology) {
    case "pipeline":
      return expandPipeline(agents);
    case "review-loop":
      return expandReviewLoop(agents);
    case "star":
      return expandStar(agents);
    default:
      throw new Error(`Unknown template topology: ${topology}`);
  }
}

function expandPipeline(agents: string[]): FlowEdge[] {
  const edges: FlowEdge[] = [];
  edges.push({ from: PARENT, to: agents[0] });
  for (let i = 0; i < agents.length - 1; i++) {
    edges.push({ from: agents[i], to: agents[i + 1] });
  }
  edges.push({ from: agents[agents.length - 1], to: PARENT, exit: true });
  return edges;
}

function expandReviewLoop(agents: string[]): FlowEdge[] {
  const edges: FlowEdge[] = [];
  edges.push({ from: PARENT, to: agents[0] });
  for (let i = 0; i < agents.length - 1; i++) {
    edges.push({ from: agents[i], to: agents[i + 1] });
  }
  const lastAgent = agents[agents.length - 1];
  const firstAgent = agents[0];
  edges.push({ from: lastAgent, to: firstAgent, label: "loop" });
  edges.push({ from: lastAgent, to: PARENT, label: "exit", exit: true });
  return edges;
}

function expandStar(agents: string[]): FlowEdge[] {
  const edges: FlowEdge[] = [];
  for (const agent of agents) {
    edges.push({ from: PARENT, to: agent });
    edges.push({ from: agent, to: PARENT, exit: true });
  }
  return edges;
}
