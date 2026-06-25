import type {
  FlowEdge,
  ResolvedGraph,
  GraphTemplate,
} from "../types.js";
import { expandTemplate } from "./templates.js";
import { validateGraph } from "./validator.js";

const PARENT = "parent";
const VALID_TEMPLATES = new Set<string>(["pipeline", "review-loop", "star"]);

// Regex for string edge syntax: "agent-a -> agent-b" or "agent-a -> agent-b: label text"
// Agent names must match \w+(?:-\w+)*  (words separated by hyphens, no trailing hyphens)
const STRING_EDGE_RE =
  /^\s*(\w+(?:-\w+)*)\s*->\s*(\w+(?:-\w+)*)(?:\s*:\s*(.*?))?\s*$/;

/**
 * Parse a collaboration graph from a raw YAML-parsed configuration object.
 *
 * Handles the `collaboration:` field from a role's role.yaml, producing a
 * normalized `ResolvedGraph` that downstream code can consume directly.
 *
 * Supports three modes:
 * 1. **Template-only** — `{ topology: "pipeline", agents: ["a", "b"] }`
 * 2. **Flow-only**   — `{ flow: ["parent -> a", "a -> b: handoff", "b -> parent"] }`
 * 3. **Mixed**       — template + additional flow edges; flow edges override
 *                      template edges with the same from→to pair (last wins).
 *
 * Returns `null` on any configuration-level failure (missing agents for a
 * template, unknown topology, validation failure). Logs details via
 * `console.warn` with the `[graph-parser]` prefix.
 *
 * @param raw - The raw `collaboration:` value parsed from YAML (can be any shape).
 * @param availableSubagentNames - All agent IDs known to the system; used to
 *   validate that every node in the graph corresponds to a real agent.
 * @returns A `ResolvedGraph` on success, or `null` on failure.
 */
export function parseCollaboration(
  raw: unknown,
  availableSubagentNames: string[],
): ResolvedGraph | null {
  // ── Guard: must be a non-null, plain object ──
  if (raw === null || raw === undefined || typeof raw !== "object") {
    console.warn("[graph-parser] collaboration config is not an object");
    return null;
  }

  const obj = raw as Record<string, unknown>;

  // ── Extract and validate topology ──
  const topology = validateTopology(obj.topology);
  if (topology === null) {
    return null; // validateTopology already logged the warning
  }

  // ── Extract agents list ──
  const agents = extractStringArray(obj.agents);

  // ── Template requires at least one agent ──
  if (topology !== undefined && agents.length === 0) {
    console.warn(
      "[graph-parser] topology requires at least one agent in 'agents' field",
    );
    return null;
  }

  // ── Extract user-specified maxIterations ──
  const maxIterationsUser =
    typeof obj.max_iterations === "number"
      ? obj.max_iterations
      : undefined;

  // ── Parse explicit flow edges (string or object syntax) ──
  const flowEdges = parseFlow(obj.flow);

  // ── Expand template → base edges ──
  let templateEdges: FlowEdge[] = [];
  if (topology !== undefined && agents.length > 0) {
    try {
      templateEdges = expandTemplate(topology, agents);
    } catch (err) {
      console.warn(
        `[graph-parser] expandTemplate failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  // ── Merge: template edges first, flow edges appended (last wins per from→to) ──
  const edges = mergeEdges(templateEdges, flowEdges);

  if (edges.length === 0) {
    console.warn(
      "[graph-parser] no edges defined — provide topology+agents or flow",
    );
    return null;
  }

  // ── Build deduplicated node list (exclude "parent" sentinel) ──
  const nodeSet = new Set<string>();
  for (const edge of edges) {
    if (edge.from !== PARENT) nodeSet.add(edge.from);
    if (edge.to !== PARENT) nodeSet.add(edge.to);
  }
  const nodes = Array.from(nodeSet);

  // ── Determine maxIterations ──
  let maxIterations: number;
  if (maxIterationsUser !== undefined) {
    maxIterations = maxIterationsUser;
  } else if (hasCycle(edges)) {
    maxIterations = 3;
  } else {
    maxIterations = 0;
  }

  // ── Identify exit edges ──
  const exitEdges = edges.filter(
    (e) => e.to === PARENT || e.exit === true,
  );

  // ── Assemble resolved graph ──
  const resolvedGraph: ResolvedGraph = {
    edges,
    nodes,
    maxIterations,
    exitEdges,
    template: topology,
  };

  // ── Validate against known agents ──
  const { valid, warnings } = validateGraph(
    resolvedGraph,
    availableSubagentNames,
  );

  if (!valid) {
    // validateGraph already logs its own warnings; surface here too
    console.warn(
      `[graph-parser] validation failed: ${warnings.join("; ")}`,
    );
    return null;
  }

  // Forward non-fatal warnings from the validator
  for (const warning of warnings) {
    console.warn(`[graph-parser] ${warning}`);
  }

  return resolvedGraph;
}

// ─── Private helpers ─────────────────────────────────────────────────────

/**
 * Validate and normalize the topology field.
 * Returns the topology string if valid, `undefined` if absent/empty,
 * or signals failure by returning `null` (after logging a warning).
 */
function validateTopology(
  raw: unknown,
): GraphTemplate | undefined | null {
  if (raw === undefined || raw === null) return undefined;

  if (typeof raw !== "string" || raw.trim() === "") {
    console.warn(
      `[graph-parser] invalid topology — expected a string, got ${typeof raw}`,
    );
    return null;
  }

  const trimmed = raw.trim();
  if (!VALID_TEMPLATES.has(trimmed)) {
    console.warn(`[graph-parser] unknown topology: "${trimmed}"`);
    return null;
  }

  return trimmed as GraphTemplate;
}

/**
 * Extract a string array from an unknown value.
 * Filters out non-string entries silently.
 */
function extractStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

/**
 * Parse the `flow` field, which can contain a mix of string and object edges.
 *
 * String edge syntax: `"agent-a -> agent-b"` or `"agent-a -> agent-b: label"`
 * Object edge syntax: `{ from: string; to: string; label?: string; exit?: boolean }`
 */
function parseFlow(raw: unknown): FlowEdge[] {
  if (!Array.isArray(raw)) return [];

  const edges: FlowEdge[] = [];

  for (const item of raw) {
    if (typeof item === "string") {
      const parsed = parseStringEdge(item);
      if (parsed) {
        edges.push(parsed);
      } else {
        console.warn(
          `[graph-parser] invalid flow edge string: "${item}"`,
        );
      }
    } else if (typeof item === "object" && item !== null) {
      const parsed = parseObjectEdge(item as Record<string, unknown>);
      if (parsed) {
        edges.push(parsed);
      } else {
        console.warn("[graph-parser] invalid flow edge object");
      }
    } else {
      console.warn(
        `[graph-parser] unsupported flow entry type: ${typeof item}`,
      );
    }
  }

  return edges;
}

/**
 * Parse a string edge like `"coder -> reviewer: handoff label"` into a FlowEdge.
 * Returns `null` if the string does not match the expected syntax.
 */
function parseStringEdge(text: string): FlowEdge | null {
  const match = text.match(STRING_EDGE_RE);
  if (!match) return null;

  const [, from, to, label] = match;

  const trimmedLabel = label?.trim();
  const edge: FlowEdge = {
    from,
    to,
    ...(trimmedLabel ? { label: trimmedLabel } : {}),
  };

  // For consistency with template expansion, edges to "parent" get exit: true.
  if (to === PARENT) {
    edge.exit = true;
  }

  return edge;
}

/**
 * Parse an object edge like `{ from: "a", to: "b", label: "review", exit: true }`.
 * Returns `null` if the required `from` or `to` fields are missing or invalid.
 */
function parseObjectEdge(
  obj: Record<string, unknown>,
): FlowEdge | null {
  if (typeof obj.from !== "string" || typeof obj.to !== "string")
    return null;
  if (obj.from.trim() === "" || obj.to.trim() === "") return null;

  const edge: FlowEdge = { from: obj.from, to: obj.to };

  if (typeof obj.label === "string" && obj.label.trim() !== "") {
    edge.label = obj.label;
  }

  if (typeof obj.exit === "boolean") {
    edge.exit = obj.exit;
  }

  return edge;
}

/**
 * Merge template edges and explicit flow edges.
 * Template edges come first. Flow edges are appended and override any
 * existing edge with the same `from→to` key (last wins for duplicates).
 */
function mergeEdges(
  templateEdges: FlowEdge[],
  flowEdges: FlowEdge[],
): FlowEdge[] {
  const edgeMap = new Map<string, FlowEdge>();

  for (const edge of templateEdges) {
    const key = `${edge.from}->${edge.to}`;
    edgeMap.set(key, edge);
  }

  for (const edge of flowEdges) {
    const key = `${edge.from}->${edge.to}`;
    edgeMap.set(key, edge);
  }

  return Array.from(edgeMap.values());
}

/**
 * Detect a directed cycle in the subgraph of agent-to-agent edges.
 * Excludes edges to/from `"parent"` (which represent flow boundaries, not cycles).
 * Uses DFS with a recursion-stack for back-edge detection.
 */
function hasCycle(edges: FlowEdge[]): boolean {
  const nodes = new Set<string>();
  for (const e of edges) {
    if (e.from !== PARENT) nodes.add(e.from);
    if (e.to !== PARENT) nodes.add(e.to);
  }

  // Build adjacency list — only agent-to-agent edges
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    if (e.from !== PARENT && e.to !== PARENT) {
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
