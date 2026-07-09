import type { FlowEdge } from "../types.ts";
import { PARENT_NODE } from "../constants.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("graph-parser");

// Regex for string edge syntax: "agent-a -> agent-b" or "agent-a -> agent-b: label text"
const STRING_EDGE_RE =
  /^\s*([^\s>:]+)\s*->\s*([^\s>:]+)(?:\s*:\s*(.*?))?\s*$/;

/**
 * Parse the `flow` field, which can contain a mix of string and object edges.
 */
export function parseFlow(raw: unknown): FlowEdge[] {
  if (!Array.isArray(raw)) return [];

  const edges: FlowEdge[] = [];

  for (const item of raw) {
    if (typeof item === "string") {
      const parsed = parseStringEdge(item);
      if (parsed) {
        edges.push(parsed);
      } else {
        log.warn(`invalid flow edge string: "${item}"`);
      }
    } else if (typeof item === "object" && item !== null) {
      const parsed = parseObjectEdge(item as Record<string, unknown>);
      if (parsed) {
        edges.push(parsed);
      } else {
        log.warn("invalid flow edge object");
      }
    } else {
      log.warn(`unsupported flow entry type: ${typeof item}`);
    }
  }

  return edges;
}

/**
 * Parse a string edge like `"coder -> reviewer: handoff label"` into a FlowEdge.
 */
export function parseStringEdge(text: string): FlowEdge | null {
  const match = text.match(STRING_EDGE_RE);
  if (!match) return null;

  const [, from, to, label] = match;

  const trimmedLabel = label?.trim();
  const edge: FlowEdge = {
    from,
    to,
    ...(trimmedLabel ? { label: trimmedLabel } : {}),
  };

  if (to === PARENT_NODE) {
    edge.exit = true;
  }

  return edge;
}

/**
 * Parse an object edge like `{ from: "a", to: "b", label: "review", exit: true }`.
 */
export function parseObjectEdge(
  obj: Record<string, unknown>,
): FlowEdge | null {
  if (typeof obj.from !== "string" || typeof obj.to !== "string") return null;
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
export function mergeEdges(
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
