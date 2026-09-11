import type { FlowEdge, GraphTemplate } from "../types.ts";
import { GraphTemplate as GT, PARENT_NODE } from "../constants.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("graph-templates");

// Private registry for custom topologies
const customTopologies = new Map<string, (agents: string[]) => FlowEdge[]>();

/**
 * Register a custom graph topology expander at runtime.
 * If the name already exists, logs a warning and overwrites.
 */
export function registerTopology(
  name: string,
  expander: (agents: string[]) => FlowEdge[],
): void {
  if (customTopologies.has(name)) {
    log.warn(`overwriting existing custom topology: "${name}"`);
  }
  customTopologies.set(name, expander);
}

export function expandTemplate(
  topology: GraphTemplate | string,
  agents: string[],
): FlowEdge[] {
  if (agents.length === 0) {
    return [];
  }

  // Check custom topologies first
  const customExpander = customTopologies.get(topology);
  if (customExpander) {
    return customExpander(agents);
  }

  // Fall through to built-in templates
  switch (topology) {
    case GT.Pipeline:
      return expandPipeline(agents);
    case GT.ReviewLoop:
      return expandReviewLoop(agents);
    case GT.Star:
      return expandStar(agents);
    default:
      throw new Error(`Unknown template topology: ${topology}`);
  }
}

function expandPipeline(agents: string[]): FlowEdge[] {
  const edges: FlowEdge[] = [];
  edges.push({ from: PARENT_NODE, to: agents[0] });
  for (let i = 0; i < agents.length - 1; i++) {
    edges.push({ from: agents[i], to: agents[i + 1] });
  }
  edges.push({ from: agents[agents.length - 1], to: PARENT_NODE, exit: true });
  return edges;
}

function expandReviewLoop(agents: string[]): FlowEdge[] {
  const edges: FlowEdge[] = [];
  edges.push({ from: PARENT_NODE, to: agents[0] });
  for (let i = 0; i < agents.length - 1; i++) {
    edges.push({ from: agents[i], to: agents[i + 1] });
  }
  const lastAgent = agents[agents.length - 1];
  const firstAgent = agents[0];
  edges.push({ from: lastAgent, to: firstAgent, label: "loop" });
  edges.push({ from: lastAgent, to: PARENT_NODE, label: "exit", exit: true });
  return edges;
}

function expandStar(agents: string[]): FlowEdge[] {
  const edges: FlowEdge[] = [];
  for (const agent of agents) {
    edges.push({ from: PARENT_NODE, to: agent });
    edges.push({ from: agent, to: PARENT_NODE, exit: true });
  }
  return edges;
}
