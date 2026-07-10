import type {
  ResolvedGraph,
  LoopGroup,
} from "../types.ts";
import { PARENT_NODE, GRAPH_TEMPLATE_VALUES } from "../constants.ts";
import { expandTemplate } from "./templates.ts";
import { validateGraph } from "./validator.ts";
import { hasCycle, isExitEdge } from "./graph-utils.ts";
import { detectLoopGroups } from "./loop-detector.ts";
import { parseFlow, mergeEdges } from "./edge-parser.ts";
import { parseTermination, registerTerminationParser, addTerminationConditionKey } from "./termination-parser.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("graph-parser");

export { registerTerminationParser, addTerminationConditionKey };

/**
 * Parse a collaboration graph from a raw YAML-parsed configuration object.
 */
export function parseCollaboration(
  raw: unknown,
  availableSubagentNames: string[],
): ResolvedGraph | null {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    log.warn("collaboration config is not an object");
    return null;
  }

  const obj = raw as Record<string, unknown>;

  const topology = validateTopology(obj.topology);
  if (topology === null) {
    return null;
  }

  const agents = extractStringArray(obj.agents);

  if (topology !== undefined && agents.length === 0) {
    log.warn("topology requires at least one agent in 'agents' field");
    return null;
  }

  const maxIterationsUser =
    typeof obj.max_iterations === "number"
      ? Math.max(0, obj.max_iterations)
      : undefined;

  const flowEdges = parseFlow(obj.flow);

  let templateEdges: import("../types.ts").FlowEdge[] = [];
  if (topology !== undefined && agents.length > 0) {
    try {
      templateEdges = expandTemplate(topology, agents);
    } catch (err) {
      log.warn(
        `expandTemplate failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  const edges = mergeEdges(templateEdges, flowEdges);

  if (edges.length === 0) {
    log.warn("no edges defined — provide topology+agents or flow");
    return null;
  }

  const nodeSet = new Set<string>();
  for (const edge of edges) {
    if (edge.from !== PARENT_NODE) nodeSet.add(edge.from);
    if (edge.to !== PARENT_NODE) nodeSet.add(edge.to);
  }
  const nodes = Array.from(nodeSet);

  let maxIterations: number;
  if (maxIterationsUser !== undefined) {
    maxIterations = maxIterationsUser;
  } else if (hasCycle(edges)) {
    maxIterations = 3;
  } else {
    maxIterations = 0;
  }

  const exitEdges = edges.filter(isExitEdge);
  const loopGroups = detectLoopGroups(edges);

  const termination = parseTermination(
    obj.termination,
    availableSubagentNames,
    loopGroups,
  );

  const finalLoopGroups = termination?.loopGroups ?? loopGroups;

  const resolvedGraph: ResolvedGraph = {
    edges,
    nodes,
    maxIterations,
    exitEdges,
    template: topology,
    loopGroups: finalLoopGroups,
    ...(termination ? { termination } : {}),
  };

  const { valid, warnings } = validateGraph(
    resolvedGraph,
    availableSubagentNames,
  );

  if (!valid) {
    log.warn(`validation failed: ${warnings.join("; ")}`);
    return null;
  }

  for (const warning of warnings) {
    log.info(warning);
  }

  return resolvedGraph;
}

// ─── Private helpers ─────────────────────────────────────────────────────

function validateTopology(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null) return undefined;

  if (typeof raw !== "string" || raw.trim() === "") {
    log.warn(`invalid topology — expected a string, got ${typeof raw}`);
    return null;
  }

  const trimmed = raw.trim();
  if (!GRAPH_TEMPLATE_VALUES.has(trimmed)) {
    log.warn(`unknown topology: "${trimmed}"`);
    return null;
  }

  return trimmed;
}

function extractStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}
