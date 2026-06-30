import type { FlowEdge } from "../types.ts";
import { PARENT_NODE } from "../constants.ts";

/**
 * Detect a directed cycle in the subgraph of agent-to-agent edges.
 * Excludes edges to/from "parent" (which represent flow boundaries, not cycles).
 * Uses DFS with a recursion-stack for back-edge detection.
 */
export function hasCycle(edges: FlowEdge[]): boolean {
  const nodes = new Set<string>();
  for (const e of edges) {
    if (e.from !== PARENT_NODE) nodes.add(e.from);
    if (e.to !== PARENT_NODE) nodes.add(e.to);
  }

  // Build adjacency list — only agent-to-agent edges
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    if (e.from !== PARENT_NODE && e.to !== PARENT_NODE) {
      adj.get(e.from)!.push(e.to);
    }
  }

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

/**
 * Check whether a flow edge is an exit edge (terminates the collaboration flow).
 * An edge is an exit edge if it points to "parent" or has `exit: true`.
 */
export function isExitEdge(e: FlowEdge): boolean {
  return e.exit === true || e.to === PARENT_NODE;
}
