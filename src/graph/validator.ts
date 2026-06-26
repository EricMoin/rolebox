import type { ResolvedGraph, FlowEdge } from "../types.ts";
import { PARENT_NODE } from "../constants.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("graph-validator");

/**
 * Validate a collaboration graph against a set of available agents.
 *
 * Checks:
 * 1. All nodes referenced in edges exist in `availableAgents` (or are `"parent"`)
 * 2. At least one exit edge exists (edge to `"parent"` or `exit: true`)
 * 3. An entry point exists (at least one edge from `"parent"`)
 * 4. No orphan agents — agents in `availableAgents` not referenced in any edge (warning)
 * 5. No disconnected nodes — all graph nodes reachable from `parent` via BFS (warning)
 * 6. Cycles without `maxIterations` — warning and default to 3
 *
 * @param graph - The resolved collaboration graph to validate
 * @param availableAgents - List of all available agent IDs in the system
 * @returns `{ valid, warnings }` — never throws
 */
export function validateGraph(
  graph: ResolvedGraph,
  availableAgents: string[],
): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];

  validateNodesExist(graph.edges, availableAgents, warnings);
  if (warnings.length > 0) return { valid: false, warnings };

  validateExitEdgeExists(graph, warnings);
  if (warnings.length > 0) return { valid: false, warnings };

  validateEntryPointExists(graph, warnings);
  if (warnings.length > 0) return { valid: false, warnings };

  validateOrphanAgents(graph.edges, availableAgents, warnings);
  validateConnectivity(graph, warnings);
  validateCycles(graph, warnings);

  return { valid: true, warnings };
}

// ─── Internal helpers ────────────────────────────────────────────────

/**
 * Check 1: All nodes in edges exist in `availableAgents` or are `"parent"`.
 */
function validateNodesExist(
  edges: FlowEdge[],
  availableAgents: string[],
  warnings: string[],
): void {
  const knownAgents = new Set([...availableAgents, PARENT_NODE]);

  for (const edge of edges) {
    if (!knownAgents.has(edge.from)) {
      warnings.push(
        `Edge references unknown agent "${edge.from}" in "from" field`,
      );
    }
    if (!knownAgents.has(edge.to)) {
      warnings.push(
        `Edge references unknown agent "${edge.to}" in "to" field`,
      );
    }
  }

  if (warnings.length > 0) {
    log.info(
      `Validation failed: ${warnings.join("; ")}`,
    );
  }
}

/**
 * Check 2: At least one exit edge exists (edge to "parent" or exit: true).
 */
function validateExitEdgeExists(
  graph: ResolvedGraph,
  warnings: string[],
): void {
  const hasExit = graph.edges.some(
    (e) => e.exit === true || e.to === PARENT_NODE,
  );
  if (!hasExit) {
    const msg = "No exit edge found: graph has no termination path";
    warnings.push(msg);
    log.info(msg);
  }
}

/**
 * Check 3: Entry point exists (at least one edge from "parent").
 */
function validateEntryPointExists(
  graph: ResolvedGraph,
  warnings: string[],
): void {
  const hasEntry = graph.edges.some((e) => e.from === PARENT_NODE);
  if (!hasEntry) {
    const msg =
      'No entry point found: graph must have at least one edge from "parent"';
    warnings.push(msg);
    log.info(msg);
  }
}

/**
 * Check 4: Orphan agents — agents in availableAgents not referenced in any edge.
 * Warnings only, not fatal.
 */
function validateOrphanAgents(
  edges: FlowEdge[],
  availableAgents: string[],
  warnings: string[],
): void {
  const agentsInEdges = new Set<string>();
  for (const edge of edges) {
    if (edge.from !== PARENT_NODE) agentsInEdges.add(edge.from);
    if (edge.to !== PARENT_NODE) agentsInEdges.add(edge.to);
  }

  for (const agent of availableAgents) {
    if (!agentsInEdges.has(agent)) {
      const msg = `Orphan agent "${agent}" is not referenced in any edge`;
      warnings.push(msg);
      log.info(msg);
    }
  }
}

/**
 * Check 5: Verify all nodes are reachable from the parent entry point via BFS.
 * Warnings only, not fatal — disconnected agents are never dispatched to.
 */
function validateConnectivity(
  graph: ResolvedGraph,
  warnings: string[],
): void {
  const reachable = new Set<string>();
  const queue = [PARENT_NODE];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const edge of graph.edges) {
      if (edge.from === current && !reachable.has(edge.to)) {
        queue.push(edge.to);
      }
    }
  }

  for (const node of graph.nodes) {
    if (!reachable.has(node)) {
      const msg = `Disconnected node "${node}" is not reachable from parent entry point`;
      warnings.push(msg);
      log.info(msg);
    }
  }
}

/**
 * Check 6: Detect cycles in agent-to-agent edges.
 * If a cycle exists and maxIterations is not set, warn and default to 3.
 */
function validateCycles(
  graph: ResolvedGraph,
  warnings: string[],
): void {
  if (!hasCycle(graph.edges)) return;

  if (!graph.maxIterations || graph.maxIterations <= 0) {
    const msg =
      "Cycle detected in graph but maxIterations is not set, defaulting to 3";
    warnings.push(msg);
    log.info(msg);
  }
}

/**
 * Detect a directed cycle in the subgraph of agent-to-agent edges.
 * Excludes edges to/from "parent" (which represent flow boundaries).
 * Uses DFS with a recursion stack for back-edge detection.
 */
function hasCycle(edges: FlowEdge[]): boolean {
  const nodes = new Set<string>();
  for (const e of edges) {
    if (e.from !== PARENT_NODE) nodes.add(e.from);
    if (e.to !== PARENT_NODE) nodes.add(e.to);
  }

  // Build adjacency list (only agent-to-agent edges)
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    if (e.from !== PARENT_NODE && e.to !== PARENT_NODE) {
      adj.get(e.from)!.push(e.to);
    }
  }

  // DFS cycle detection
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function dfs(node: string): boolean {
    if (recStack.has(node)) return true;
    if (visited.has(node)) return false;

    visited.add(node);
    recStack.add(node);

    for (const neighbor of adj.get(node) || []) {
      if (dfs(neighbor)) return true;
    }

    recStack.delete(node);
    return false;
  }

  for (const node of nodes) {
    if (dfs(node)) return true;
  }

  return false;
}
