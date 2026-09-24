/** The only two fields cycle detection reads from an edge. */
export interface CycleEdge {
  readonly from: string;
  readonly to: string;
}

/** One Tarjan result: the SCCs plus the self-loop membership set. */
export interface TarjanResult {
  /** Components keyed by discovery order; each list is in pop order. */
  readonly components: Map<number, string[]>;
  /** Nodes with an edge to themselves — a cyclic component of one node. */
  readonly selfLoop: Set<string>;
}

/** Whether a value is a usable endpoint identifier. */
function isNodeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Read one edge's endpoints, or `null` when it is not a readable edge. */
function readEndpoints(edge: unknown): CycleEdge | null {
  if (typeof edge !== "object" || edge === null) return null;
  let from: unknown;
  let to: unknown;
  try {
    from = Reflect.get(edge, "from");
    to = Reflect.get(edge, "to");
  } catch {
    return null;
  }
  if (!isNodeId(from) || !isNodeId(to)) return null;
  return { from, to };
}

/**
 * Compute strongly-connected components over a set of edges. Nodes are derived
 * from the edges themselves (a node absent from every edge is acyclic by
 * definition and needs no component).
 */
export function stronglyConnectedComponents(
  edges: readonly unknown[],
): TarjanResult {
  const nodeSet = new Set<string>();
  const readable: CycleEdge[] = [];
  for (const edge of edges) {
    const endpoints = readEndpoints(edge);
    if (endpoints === null) continue;
    readable.push(endpoints);
    nodeSet.add(endpoints.from);
    nodeSet.add(endpoints.to);
  }
  const nodes = [...nodeSet];

  const adj = new Map<string, string[]>();
  const selfLoop = new Set<string>();
  for (const node of nodes) adj.set(node, []);
  for (const edge of readable) {
    if (edge.from === edge.to) selfLoop.add(edge.from);
    adj.get(edge.from)?.push(edge.to);
  }

  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components = new Map<number, string[]>();

  let index = 0;
  let componentId = 0;

  function strongConnect(node: string): void {
    indices.set(node, index);
    lowlink.set(node, index);
    index++;
    stack.push(node);
    onStack.add(node);

    for (const neighbor of adj.get(node) ?? []) {
      const neighborIndex = indices.get(neighbor);
      if (neighborIndex === undefined) {
        strongConnect(neighbor);
        lowlink.set(
          node,
          Math.min(lowlink.get(node) ?? 0, lowlink.get(neighbor) ?? 0),
        );
      } else if (onStack.has(neighbor)) {
        lowlink.set(node, Math.min(lowlink.get(node) ?? 0, neighborIndex));
      }
    }

    if (lowlink.get(node) === indices.get(node)) {
      const component: string[] = [];
      let popped = stack.pop();
      while (popped !== undefined) {
        onStack.delete(popped);
        component.push(popped);
        if (popped === node) break;
        popped = stack.pop();
      }
      components.set(componentId, component);
      componentId++;
    }
  }

  for (const node of nodes) {
    if (!indices.has(node)) strongConnect(node);
  }

  return { components, selfLoop };
}

/** A component is cyclic when it has more than one node or is a self-loop. */
export function isCyclicComponent(
  component: readonly string[],
  selfLoop: ReadonlySet<string>,
): boolean {
  if (component.length > 1) return true;
  const only = component[0];
  return only !== undefined && selfLoop.has(only);
}

/** True when the given edge set contains at least one directed cycle. */
export function hasDirectedCycle(edges: readonly unknown[]): boolean {
  const { components, selfLoop } = stronglyConnectedComponents(edges);
  for (const component of components.values()) {
    if (isCyclicComponent(component, selfLoop)) return true;
  }
  return false;
}
