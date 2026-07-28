/**
 * Graph Model v2 — Structural Validator
 *
 * Phase 1, Subtask 2 (parsing & validation).
 *
 * Validates the STRUCTURE of a graph document only. By design there are no
 * node-type checks: the v2 model is role-agnostic (a node is {id, agent,
 * prompt}), so validation here never inspects agent/prompt semantics. It also
 * never checks whether an `agent` is a known dispatchable identifier — that is
 * an environment/binding concern, out of scope for structural validation.
 *
 * Checks (each produces an independent, human-readable message):
 *   1. `version` present and equal to 2
 *   2. node-id uniqueness
 *   3. edge endpoint validity (from/to must reference declared nodes)
 *   4. cycle containment (Tarjan SCC-based — see below)
 *   5. loop-group node references must be declared nodes (+ loop-group id
 *      uniqueness, symmetric to node-id uniqueness)
 *   6. `needs_approval` nodes may only have non-`always` outgoing edges
 *   7. `data_passthrough` shape (non-negative `max_chars`)
 *   8. loop-group root check — ERROR when, after excluding revise
 *      back-edges, no node has in-degree zero AND at least one loop
 *      group exists (pure-cycle deadlock). WARNING when no roots exist
 *      but no loop groups are declared. Additionally flags loop groups
 *      whose member nodes have no incoming edges from outside the group.
 *
 * ## Cycle-containment semantics (check 4)
 *
 * The v2 model holds "the graph is a DAG at rest; cycles exist only inside
 * explicitly declared loop groups" (graph-model.md §4). We validate both
 * directions of that contract:
 *
 *   (a) ERROR — every declared loop group must actually induce a directed
 *       cycle over its declared nodes (via Tarjan on the induced subgraph).
 *       Declaring a "loop" over an acyclic node set is a structural error.
 *
 *   (b) WARNING — every directed cycle in the full graph (a Tarjan SCC with
 *       >1 node or a self-loop) must be covered by at least one loop group.
 *       Nodes participating in a cycle yet absent from every loop group are
 *       reported as a warning, not an error.
 *
 * Direction (b) is deliberately a WARNING rather than an ERROR: the canonical
 * example in dag-yaml-schema.md Appendix B declares a single loop group
 * `review-cycle = [implementer, reviewer]`, yet its graph contains a
 * `final-gate -> implementer` (revise_needed) back-edge that pulls
 * `final-gate` into the SCC {implementer, reviewer, final-gate} without it
 * being declared in any loop group. Failing that document as an ERROR would
 * contradict the documented canonical graph; surfacing it as a warning
 * preserves the diagnostic while keeping the canonical graph valid.
 *
 * Reuses the Tarjan SCC approach from ./loop-detector.ts (which operates on v1
 * FlowEdge) by way of a self-contained v2 EdgeDeclaration adaptation.
 *
 * Design reference: .rolebox/design/dag-yaml-schema.md §5, graph-model.md §4.
 */

import type { EdgeDeclaration } from "../types.graph-v2.ts";
import type { GraphDocument } from "./parser-v2.ts";

/** Result of structural validation — errors are fatal, warnings are not. */
export interface GraphValidationResult {
  /** `false` when at least one fatal structural error was found. */
  valid: boolean;
  /** Fatal structural errors (each describes exactly one failing rule). */
  errors: string[];
  /** Non-fatal diagnostics (e.g. an uncovered cycle). */
  warnings: string[];
}

/**
 * Validate the structure of a graph document. Never throws.
 *
 * @param graph - a parsed graph document (see parser-v2.ts `parseGraph`).
 * @returns a `GraphValidationResult` with independent messages per rule.
 */
export function validateGraphDeclaration(
  graph: GraphDocument,
): GraphValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  checkVersion(graph, errors);
  checkNodeIdUniqueness(graph, errors);
  checkEdgeEndpoints(graph, errors);
  checkLoopGroupIdUniqueness(graph, errors);
  checkLoopGroupNodeRefs(graph, errors);
  checkCycleContainment(graph, errors, warnings);
  checkApprovalNodeOutgoing(graph, errors);
  checkDataPassthrough(graph, errors);
  checkLoopGroupRoots(graph, errors, warnings);

  return { valid: errors.length === 0, errors, warnings };
}

// ── Rule 1: version ──────────────────────────────────────────────────────

function checkVersion(graph: GraphDocument, errors: string[]): void {
  if (graph.version === undefined || graph.version === null) {
    errors.push('missing required field "version" (expected 2)');
  } else if (graph.version !== 2) {
    errors.push(
      `unsupported graph version "${graph.version}" (expected 2)`,
    );
  }
}

// ── Rule 2: node-id uniqueness ───────────────────────────────────────────

function checkNodeIdUniqueness(graph: GraphDocument, errors: string[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const node of graph.nodes) {
    if (seen.has(node.id)) duplicates.add(node.id);
    seen.add(node.id);
  }
  for (const id of duplicates) {
    errors.push(
      `duplicate node id "${id}" — node ids must be unique within a graph`,
    );
  }
}

// ── Rule 3: edge endpoint validity ───────────────────────────────────────

function checkEdgeEndpoints(graph: GraphDocument, errors: string[]): void {
  const declared = new Set(graph.nodes.map((node) => node.id));
  for (const edge of graph.edges) {
    if (!declared.has(edge.from)) {
      errors.push(
        `edge from="${edge.from}" -> "${edge.to}" references an undeclared node in "from"`,
      );
    }
    if (!declared.has(edge.to)) {
      errors.push(
        `edge from="${edge.from}" -> "${edge.to}" references an undeclared node in "to"`,
      );
    }
  }
}

// ── Rule 5a: loop-group id uniqueness (symmetric to node ids) ────────────

function checkLoopGroupIdUniqueness(
  graph: GraphDocument,
  errors: string[],
): void {
  const groups = graph.loop_groups ?? [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const group of groups) {
    if (seen.has(group.id)) duplicates.add(group.id);
    seen.add(group.id);
  }
  for (const id of duplicates) {
    errors.push(
      `duplicate loop group id "${id}" — loop group ids must be unique within a graph`,
    );
  }
}

// ── Rule 5b: loop-group referenced nodes must be declared ────────────────

function checkLoopGroupNodeRefs(
  graph: GraphDocument,
  errors: string[],
): void {
  const declared = new Set(graph.nodes.map((node) => node.id));
  for (const group of graph.loop_groups ?? []) {
    for (const nodeId of group.nodes) {
      if (!declared.has(nodeId)) {
        errors.push(
          `loop group "${group.id}" references undeclared node "${nodeId}"`,
        );
      }
    }
  }
}

// ── Rule 6: needs_approval nodes — no type:"always" outgoing edges ───────

function checkApprovalNodeOutgoing(
  graph: GraphDocument,
  errors: string[],
): void {
  const outgoingByNode = new Map<string, EdgeDeclaration[]>();
  for (const edge of graph.edges) {
    const list = outgoingByNode.get(edge.from) ?? [];
    list.push(edge);
    outgoingByNode.set(edge.from, list);
  }

  for (const node of graph.nodes) {
    if (node.needs_approval !== true) continue;
    for (const edge of outgoingByNode.get(node.id) ?? []) {
      if (edge.type === "always") {
        errors.push(
          `node "${node.id}" has needs_approval: true but its outgoing edge ` +
            `"${edge.from} -> ${edge.to}" is type "always"; ` +
            `approval nodes may only have "on_signal" or "on_condition" outgoing edges`,
        );
      }
    }
  }
}

// ── Revise back-edge predicate (mirrors engine's isReviseBackEdge) ───────

/**
 * Whether an edge is a revision back-edge: an `on_signal` edge whose
 * `signal_filter` names `revise_needed`. These edges route revision feedback
 * backward within a loop group and must be excluded from in-degree
 * computations that determine graph roots — otherwise a loop's entry node
 * whose only incoming edge is a revise back-edge would never be discovered
 * as a root, deadlocking the graph.
 *
 * Implemented inline against `EdgeDeclaration` rather than importing the
 * engine's `isReviseBackEdge` from `src/graph/engine/` to avoid a layering
 * violation (validators live in `src/graph/`, above the engine module).
 */
function isReviseBackEdge(edge: EdgeDeclaration): boolean {
  if (edge.type !== "on_signal") return false;
  return (edge.signal_filter ?? []).includes("revise_needed");
}

// ── Rule 7: data_passthrough shape ───────────────────────────────────────

function checkDataPassthrough(graph: GraphDocument, errors: string[]): void {
  for (const edge of graph.edges) {
    const dm = edge.data_passthrough;
    if (dm === undefined) continue;
    // exclude entries are guaranteed strings by the parser's string-array
    // coercer; here we only guard the numeric truncation bound.
    if (dm.maxChars !== undefined && !(dm.maxChars >= 0)) {
      errors.push(
        `edge from="${edge.from}" -> "${edge.to}" data_passthrough.max_chars ` +
          `must be a non-negative number (got ${dm.maxChars})`,
      );
    }
  }
}

// ── Rule 8: loop-group root detection (deadlock) ────────────────────────

/**
 * Detects deadlock conditions in graph root entry and loop-group reachability.
 *
 * **Global root check (error):** when, after filtering out revise back-edges,
 * no node has in-degree zero AND at least one loop group is declared, the
 * graph has no entry point — a pure cycle that deadlocks the engine. This is
 * promoted from a warning to an ERROR because a loop-group-only cycle cannot
 * bootstrap without an external root.
 *
 * **Global root check (warning):** when no node has in-degree zero but NO
 * loop group is declared, emit a non-fatal warning — the absence of loop
 * groups means the engine has no structured recovery path, and deadlock is
 * probable but not certain (external triggers could intervene).
 *
 * **Per-loop-group isolation check (error):** for each declared loop group,
 * examine every member node. If every member node has in-degree ≥ 1 (after
 * excluding revise back-edges) AND all incoming edges originate from within
 * the same loop group, the group has no external entry — it is unreachable
 * and will deadlock. Flag it as an error naming the loop group id.
 *
 * A member node with in-degree zero is a graph root and counts as having
 * external entry for its loop group (the loop group is reachable from the
 * rest of the graph via that root member).
 */
function checkLoopGroupRoots(
  graph: GraphDocument,
  errors: string[],
  warnings: string[],
): void {
  // Compute in-degree excluding revise back-edges.
  const inDegree = new Map<string, number>();
  for (const node of graph.nodes) {
    inDegree.set(node.id, 0);
  }
  for (const edge of graph.edges) {
    if (isReviseBackEdge(edge)) continue;
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const hasRoot = [...inDegree.values()].some((deg) => deg === 0);
  const hasLoopGroups = (graph.loop_groups ?? []).length > 0;

  if (!hasRoot && hasLoopGroups) {
    errors.push(
      "the graph has no entry node (all nodes have at least one incoming edge) — " +
        "pure cycles without an external root deadlock the engine",
    );
  } else if (!hasRoot) {
    warnings.push(
      "the graph has no unblocked entry point after excluding " +
        "revise back-edges and may deadlock",
    );
  }

  // Per-loop-group external entry check.
  for (const group of graph.loop_groups ?? []) {
    const memberSet = new Set(group.nodes);
    let hasExternalEntry = false;

    for (const nodeId of group.nodes) {
      // A member with in-degree zero is a graph root — the loop group
      // is reachable from outside via this root entry.
      if ((inDegree.get(nodeId) ?? 0) === 0) {
        hasExternalEntry = true;
        break;
      }

      // Check whether any non-revise incoming edge originates
      // from outside the loop group.
      for (const edge of graph.edges) {
        if (edge.to !== nodeId) continue;
        if (isReviseBackEdge(edge)) continue;
        if (!memberSet.has(edge.from)) {
          hasExternalEntry = true;
          break;
        }
      }
      if (hasExternalEntry) break;
    }

    if (!hasExternalEntry) {
      errors.push(
        `loop group "${group.id}" has no external entry — ` +
          "all incoming edges of member nodes originate from within the loop group; " +
          "the group is unreachable and will deadlock",
      );
    }
  }
}

// ── Rule 4: cycle containment (Tarjan SCC-based) ─────────────────────────

function checkCycleContainment(
  graph: GraphDocument,
  errors: string[],
  warnings: string[],
): void {
  // (a) ERROR — a declared loop group must actually induce a cycle.
  for (const group of graph.loop_groups ?? []) {
    const groupSet = new Set(group.nodes);
    const inducedEdges = graph.edges.filter(
      (edge) => groupSet.has(edge.from) && groupSet.has(edge.to),
    );
    if (!hasCycle(inducedEdges)) {
      errors.push(
        `loop group "${group.id}" declares nodes [${group.nodes.join(", ")}] ` +
          `that do not form a directed cycle`,
      );
    }
  }

  // (b) WARNING — every full-graph cycle must be covered by a loop group.
  const covered = new Set<string>();
  for (const group of graph.loop_groups ?? []) {
    for (const nodeId of group.nodes) covered.add(nodeId);
  }
  const uncoveredCycleNodes = findCycleParticipatingNodes(graph.edges);
  const uncovered = [...uncoveredCycleNodes].filter((node) => !covered.has(node));
  if (uncovered.length > 0) {
    warnings.push(
      `cycle detected involving node(s) [${[...uncovered].sort().join(", ")}] ` +
        `that are not contained in any declared loop group`,
    );
  }
}

// ── Tarjan SCC over v2 EdgeDeclaration ───────────────────────────────────

interface TarjanResult {
  components: Map<number, string[]>;
  selfLoop: Set<string>;
}

/**
 * Compute strongly-connected components over a set of v2 edges. Nodes are
 * derived from the edges themselves (a node absent from every edge is acyclic
 * by definition and needs no component).
 */
function tarjanScc(edges: EdgeDeclaration[]): TarjanResult {
  const nodeSet = new Set<string>();
  for (const edge of edges) {
    nodeSet.add(edge.from);
    nodeSet.add(edge.to);
  }
  const nodes = [...nodeSet];

  const adj = new Map<string, string[]>();
  const selfLoop = new Set<string>();
  for (const node of nodes) adj.set(node, []);
  for (const edge of edges) {
    if (edge.from === edge.to) selfLoop.add(edge.from);
    adj.get(edge.from)!.push(edge.to);
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
      if (!indices.has(neighbor)) {
        strongConnect(neighbor);
        lowlink.set(node, Math.min(lowlink.get(node)!, lowlink.get(neighbor)!));
      } else if (onStack.has(neighbor)) {
        lowlink.set(node, Math.min(lowlink.get(node)!, indices.get(neighbor)!));
      }
    }

    if (lowlink.get(node) === indices.get(node)) {
      const component: string[] = [];
      let popped: string;
      do {
        popped = stack.pop()!;
        onStack.delete(popped);
        component.push(popped);
      } while (popped !== node);
      components.set(componentId, component);
      componentId++;
    }
  }

  for (const node of nodes) {
    if (!indices.has(node)) strongConnect(node);
  }

  return { components, selfLoop };
}

/** A component is cyclic when it has >1 node or is a self-loop. */
function isCyclicComponent(component: string[], selfLoop: Set<string>): boolean {
  if (component.length > 1) return true;
  return selfLoop.has(component[0]);
}

/** True when the given edge set contains at least one directed cycle. */
export function hasCycle(edges: EdgeDeclaration[]): boolean {
  const { components, selfLoop } = tarjanScc(edges);
  for (const component of components.values()) {
    if (isCyclicComponent(component, selfLoop)) return true;
  }
  return false;
}

/** Node ids that participate in at least one directed cycle in the edge set. */
function findCycleParticipatingNodes(edges: EdgeDeclaration[]): Set<string> {
  const { components, selfLoop } = tarjanScc(edges);
  const out = new Set<string>();
  for (const component of components.values()) {
    if (isCyclicComponent(component, selfLoop)) {
      for (const node of component) out.add(node);
    }
  }
  return out;
}
