import type { ResolvedGraph, FlowEdge } from "../types.js";

/**
 * Validate a collaboration graph against a set of available agents.
 *
 * Checks:
 * 1. All nodes referenced in edges exist in `availableAgents` (or are `"parent"`)
 * 2. At least one exit edge exists (edge to `"parent"` or `exit: true`)
 * 3. An entry point exists (at least one edge from `"parent"`)
 * 4. No orphan agents — agents in `availableAgents` not referenced in any edge (warning)
 * 5. Cycles without `maxIterations` — warning and default to 3
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
  const knownAgents = new Set([...availableAgents, "parent"]);

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
    console.warn(
      `[graph-validator] Validation failed: ${warnings.join("; ")}`,
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
    (e) => e.exit === true || e.to === "parent",
  );
  if (!hasExit) {
    const msg = "No exit edge found: graph has no termination path";
    warnings.push(msg);
    console.warn(`[graph-validator] ${msg}`);
  }
}

/**
 * Check 3: Entry point exists (at least one edge from "parent").
 */
function validateEntryPointExists(
  graph: ResolvedGraph,
  warnings: string[],
): void {
  const hasEntry = graph.edges.some((e) => e.from === "parent");
  if (!hasEntry) {
    const msg =
      'No entry point found: graph must have at least one edge from "parent"';
    warnings.push(msg);
    console.warn(`[graph-validator] ${msg}`);
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
    if (edge.from !== "parent") agentsInEdges.add(edge.from);
    if (edge.to !== "parent") agentsInEdges.add(edge.to);
  }

  for (const agent of availableAgents) {
    if (!agentsInEdges.has(agent)) {
      const msg = `Orphan agent "${agent}" is not referenced in any edge`;
      warnings.push(msg);
      console.warn(`[graph-validator] ${msg}`);
    }
  }
}

/**
 * Check 5: Detect cycles in agent-to-agent edges.
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
    console.warn(`[graph-validator] ${msg}`);
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
    if (e.from !== "parent") nodes.add(e.from);
    if (e.to !== "parent") nodes.add(e.to);
  }

  // Build adjacency list (only agent-to-agent edges)
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    if (e.from !== "parent" && e.to !== "parent") {
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
