import type { FlowEdge, LoopGroup } from "../types.ts";
import { PARENT_NODE } from "../constants.ts";

/**
 * Detect loop groups (strongly connected components) in the agent-to-agent
 * subgraph of a collaboration graph. Excludes the "parent" sentinel node.
 *
 * Each SCC with >1 node or a self-loop becomes a `LoopGroup`. Acyclic graphs
 * return an empty array.
 *
 * Uses Tarjan's SCC algorithm for deterministic, O(V+E) detection.
 */
export function detectLoopGroups(edges: FlowEdge[]): LoopGroup[] {
  const agentEdges = edges.filter(
    (e) => e.from !== PARENT_NODE && e.to !== PARENT_NODE,
  );

  const nodes = new Set<string>();
  for (const e of agentEdges) {
    nodes.add(e.from);
    nodes.add(e.to);
  }

  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const e of agentEdges) {
    adj.get(e.from)!.push(e.to);
  }

  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: LoopGroup[] = [];

  function strongconnect(v: string): void {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) || []) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v)! === indices.get(v)!) {
      const sccNodes: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        sccNodes.push(w);
      } while (w !== v);

      if (sccNodes.length > 1 || hasSelfLoop(sccNodes, agentEdges)) {
        groups.push(buildLoopGroup(sccNodes, agentEdges, indices));
      }
    }
  }

  for (const v of nodes) {
    if (!indices.has(v)) {
      strongconnect(v);
    }
  }

  return groups;
}

function hasSelfLoop(
  sccNodes: string[],
  edges: FlowEdge[],
): boolean {
  const set = new Set(sccNodes);
  for (const e of edges) {
    if (e.from === e.to && set.has(e.from)) return true;
  }
  return false;
}

function buildLoopGroup(
  sccNodes: string[],
  edges: FlowEdge[],
  indices: Map<string, number>,
): LoopGroup {
  const sorted = [...sccNodes].sort();
  const id = sorted.join(",");
  const nodeSet = new Set(sccNodes);

  const backEdges: FlowEdge[] = [];
  for (const e of edges) {
    if (!nodeSet.has(e.from) || !nodeSet.has(e.to)) continue;
    const fromIdx = indices.get(e.from)!;
    const toIdx = indices.get(e.to)!;
    // A back edge points to an already-discovered node in the same SCC.
    // Self-loops (toIdx === fromIdx) are included.
    if (toIdx <= fromIdx) {
      backEdges.push({ ...e });
    }
  }

  return { id, nodes: sorted, backEdges };
}
