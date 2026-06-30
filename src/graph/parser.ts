import type {
  FlowEdge,
  ResolvedGraph,
  GraphTemplate,
  TerminationConfig,
  LoopCondition,
  ResolvedTermination,
  LoopGroup,
} from "../types.ts";
import { PARENT_NODE, GRAPH_TEMPLATE_VALUES } from "../constants.ts";
import { expandTemplate } from "./templates.ts";
import { validateGraph } from "./validator.ts";
import { hasCycle, isExitEdge } from "./graph-utils.ts";
import { detectLoopGroups } from "./loop-detector.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("graph-parser");

// Regex for string edge syntax: "agent-a -> agent-b" or "agent-a -> agent-b: label text"
// Agent names match any characters except whitespace, '>' and ':' —
// this allows hyphens (my-agent), underscores (my_agent), and Unicode (研究者)
// The arrow '->' is matched literally between the capture groups.
const STRING_EDGE_RE =
  /^\s*([^\s>:]+)\s*->\s*([^\s>:]+)(?:\s*:\s*(.*?))?\s*$/;

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
 * `log.warn` via the `graph-parser` sub-logger.
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
    log.warn("collaboration config is not an object");
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
    log.warn(
      "topology requires at least one agent in 'agents' field",
    );
    return null;
  }

  // ── Extract user-specified maxIterations ──
  const maxIterationsUser =
    typeof obj.max_iterations === "number"
      ? Math.max(0, obj.max_iterations)
      : undefined;

  // ── Parse explicit flow edges (string or object syntax) ──
  const flowEdges = parseFlow(obj.flow);

  // ── Expand template → base edges ──
  let templateEdges: FlowEdge[] = [];
  if (topology !== undefined && agents.length > 0) {
    try {
      templateEdges = expandTemplate(topology, agents);
    } catch (err) {
      log.warn(
        `expandTemplate failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  // ── Merge: template edges first, flow edges appended (last wins per from→to) ──
  const edges = mergeEdges(templateEdges, flowEdges);

  if (edges.length === 0) {
    log.warn(
      "no edges defined — provide topology+agents or flow",
    );
    return null;
  }

  // ── Build deduplicated node list (exclude "parent" sentinel) ──
  const nodeSet = new Set<string>();
  for (const edge of edges) {
    if (edge.from !== PARENT_NODE) nodeSet.add(edge.from);
    if (edge.to !== PARENT_NODE) nodeSet.add(edge.to);
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
  const exitEdges = edges.filter(isExitEdge);

  // ── Detect loop groups via SCC ──
  const loopGroups = detectLoopGroups(edges);

  // ── Parse termination config ──
  const termination = parseTermination(
    obj.termination,
    availableSubagentNames,
    loopGroups,
  );

  // ── Use resolved loop groups (with per-loop maxIterations if from termination) ──
  const finalLoopGroups = termination?.loopGroups ?? loopGroups;

  // ── Assemble resolved graph ──
  const resolvedGraph: ResolvedGraph = {
    edges,
    nodes,
    maxIterations,
    exitEdges,
    template: topology,
    loopGroups: finalLoopGroups,
    ...(termination ? { termination } : {}),
  };

  // ── Validate against known agents ──
  const { valid, warnings } = validateGraph(
    resolvedGraph,
    availableSubagentNames,
  );

  if (!valid) {
    // validateGraph already logs its own warnings; surface here too
    log.warn(
      `validation failed: ${warnings.join("; ")}`,
    );
    return null;
  }

  // Forward non-fatal warnings from the validator
  for (const warning of warnings) {
    log.info(warning);
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
    log.warn(
      `invalid topology — expected a string, got ${typeof raw}`,
    );
    return null;
  }

  const trimmed = raw.trim();
  if (!GRAPH_TEMPLATE_VALUES.has(trimmed)) {
    log.warn(`unknown topology: "${trimmed}"`);
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
        log.warn(
          `invalid flow edge string: "${item}"`,
        );
      }
    } else if (typeof item === "object" && item !== null) {
      const parsed = parseObjectEdge(item as Record<string, unknown>);
      if (parsed) {
        edges.push(parsed);
      } else {
        log.warn("invalid flow edge object");
      }
    } else {
      log.warn(
        `unsupported flow entry type: ${typeof item}`,
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
  if (to === PARENT_NODE) {
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

// ─── Termination parsing helpers ─────────────────────────────────────

const KNOWN_CONDITION_KEYS = new Set([
  "max_iterations",
  "timeout_ms",
  "converged",
  "result_matches",
  "stuck",
]);

/**
 * Parse a raw termination config into a normalized `ResolvedTermination`.
 * Returns `undefined` when `raw` is absent, null, or not an object.
 * Validates agent references in `result_matches.agent` and `converged`
 * against `availableAgents` (logs warnings, not hard failures).
 * Tolerates unknown condition keys (logs and skips).
 */
function parseTermination(
  raw: unknown,
  availableAgents: string[],
  loopGroups: LoopGroup[],
): ResolvedTermination | undefined {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return undefined;
  }

  const obj = raw as Record<string, unknown>;
  const anyOf = parseConditionList(obj.any_of, availableAgents);
  const allOf = parseConditionList(obj.all_of, availableAgents);

  if (!anyOf && !allOf) return undefined;

  const config: TerminationConfig = {};
  if (anyOf) config.any_of = anyOf;
  if (allOf) config.all_of = allOf;

  const perLoopMaxIter = extractPerLoopMaxIterations(config);

  const resolvedGroups = loopGroups.map((lg) => ({
    ...lg,
    maxIterations: perLoopMaxIter ?? lg.maxIterations,
  }));

  return { config, loopGroups: resolvedGroups };
}

function parseConditionList(
  raw: unknown,
  availableAgents: string[],
): LoopCondition[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: LoopCondition[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      log.warn("termination condition is not an object, skipping");
      continue;
    }
    const obj = item as Record<string, unknown>;
    const parsed = parseLoopCondition(obj, availableAgents);
    if (parsed) result.push(parsed);
  }
  return result.length > 0 ? result : [];
}

function parseLoopCondition(
  obj: Record<string, unknown>,
  availableAgents: string[],
): LoopCondition | null {
  const keys = Object.keys(obj);
  // Log and ignore completely unrecognized keys
  if (keys.length === 0) {
    log.warn("termination condition is an empty object, skipping");
    return null;
  }

  // Check primary known key
  for (const key of keys) {
    if (KNOWN_CONDITION_KEYS.has(key)) {
      return parseKnownCondition(key, obj[key], obj, availableAgents);
    }
  }

  // No known key found
  log.warn(
    `unknown termination condition key(s): ${keys.join(", ")} — skipping`,
  );
  return null;
}

function parseKnownCondition(
  key: string,
  value: unknown,
  fullObj: Record<string, unknown>,
  availableAgents: string[],
): LoopCondition | null {
  // Warn about extra unknown keys alongside a known one
  for (const extraKey of Object.keys(fullObj)) {
    if (!KNOWN_CONDITION_KEYS.has(extraKey)) {
      log.warn(
        `unknown extra key "${extraKey}" in termination condition — ignored`,
      );
    }
  }

  switch (key) {
    case "max_iterations": {
      const n = typeof value === "number" ? value : NaN;
      if (isNaN(n) || n < 0) {
        log.warn(
          `invalid max_iterations value in termination: ${value}, skipping`,
        );
        return null;
      }
      return { max_iterations: Math.max(0, n) };
    }
    case "timeout_ms": {
      const n = typeof value === "number" ? value : NaN;
      if (isNaN(n) || n <= 0) {
        log.warn(
          `invalid timeout_ms value in termination: ${value}, skipping`,
        );
        return null;
      }
      return { timeout_ms: n };
    }
    case "converged": {
      if (typeof value !== "string" || value.trim() === "") {
        log.warn(
          `invalid converged agent reference: ${value}, skipping`,
        );
        return null;
      }
      const agent = value.trim();
      if (!availableAgents.includes(agent)) {
        log.warn(
          `converged references unknown agent "${agent}"`,
        );
      }
      return { converged: agent };
    }
    case "result_matches": {
      if (typeof value !== "object" || value === null) {
        log.warn(
          `invalid result_matches value: ${value}, skipping`,
        );
        return null;
      }
      const rm = value as Record<string, unknown>;
      if (typeof rm.agent !== "string" || rm.agent.trim() === "") {
        log.warn(
          "result_matches missing required 'agent' field, skipping",
        );
        return null;
      }
      const agent = rm.agent.trim();
      if (!availableAgents.includes(agent)) {
        log.warn(
          `result_matches references unknown agent "${agent}"`,
        );
      }
      const condition: Record<string, unknown> = { agent };
      if (typeof rm.contains === "string") condition.contains = rm.contains;
      if (typeof rm.regex === "string") condition.regex = rm.regex;
      if (typeof rm.score_gte === "number") condition.score_gte = rm.score_gte;
      if (typeof rm.no_changes === "boolean") {
        condition.no_changes = rm.no_changes;
      }
      return { result_matches: condition } as LoopCondition;
    }
    case "stuck": {
      if (typeof value !== "object" || value === null) {
        log.warn(`invalid stuck value: ${value}, skipping`);
        return null;
      }
      const s = value as Record<string, unknown>;
      const repeats =
        typeof s.repeats === "number" && s.repeats > 0 ? s.repeats : NaN;
      if (isNaN(repeats)) {
        log.warn(
          `stuck missing valid 'repeats' field: ${JSON.stringify(value)}, skipping`,
        );
        return null;
      }
      return { stuck: { repeats } };
    }
    default:
      return null;
  }
}

/**
 * Extract a per-loop `max_iterations` value from termination conditions.
 * Scans both `any_of` and `all_of` arrays; returns the first `max_iterations`
 * found. Undefined when no per-loop cap is configured.
 */
function extractPerLoopMaxIterations(
  config: TerminationConfig,
): number | undefined {
  const conditions = [...(config.any_of ?? []), ...(config.all_of ?? [])];
  for (const c of conditions) {
    if ("max_iterations" in c) return c.max_iterations;
  }
  return undefined;
}


