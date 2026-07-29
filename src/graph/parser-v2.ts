/**
 * Graph Model v2 — YAML/JSON Deserializer
 *
 * Phase 1, Subtask 2 (parsing & validation).
 *
 * Produces a `GraphDocument` (a `GraphDeclaration` whose `version` is optional
 * at the type level so that a missing/invalid `version` can flow through to the
 * structural validator, which reports it) from a YAML string, a JSON string, or
 * an already-parsed object tree (as produced by `JSON.parse` or a YAML loader).
 *
 * The parser performs SHAPE / required-field mapping only:
 *   - extracts the top-level `graph:` block (legacy `dag:` accepted as alias)
 *   - coerces YAML idioms into the TS v2 types (see field-mapping notes below)
 *   - reports deserialization-level errors (missing required scalars, unknown
 *     edge `type`, non-array collections)
 *
 * CROSS-REFERENTIAL structural rules (node-id uniqueness, edge endpoint
 * validity, cycle containment, loop-group node refs, approval-node outgoing
 * constraints) are NOT checked here — they belong to
 * `validateGraphDeclaration` in ./validator-v2.ts. The existing v1 split
 * (parser.ts maps, validator.ts checks) is preserved for v2.
 *
 * Field-mapping divergence notes (YAML schema §dag-yaml-schema.md vs TS types):
 *   - `data_passthrough.include` (YAML) -> `DataMapping.fields` (TS);
 *     `data_passthrough.exclude` -> `DataMapping.exclude` (string array), and
 *     `data_passthrough.max_chars` -> `DataMapping.maxChars` (number).
 *   - `retry` may be a bare number (YAML §2.4) or `{max, backoff_ms}` (TS
 *     RetryConfig); both forms are accepted.
 *   - `join.strategy` uses the `"quorum:N"` combined string form (YAML §2.3.1)
 *     which is expanded into `{ strategy: "quorum", quorum: N }` (TS JoinConfig).
 *
 * Design reference: .rolebox/design/dag-yaml-schema.md (Appendix B canonical
 * example), src/types.graph-v2.ts, src/constants.ts (JoinStrategy).
 */

import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { createSubLogger } from "../logger.ts";
import { validateGraphDeclaration } from "./validator-v2.ts";
import type {
  GraphDeclaration,
  NodeConfig,
  EdgeDeclaration,
  EdgeType,
  LoopGroupDecl,
  JoinConfig,
  TerminationDecl,
  TerminationCondition,
  DataMapping,
  RetryConfig,
  NodeBudgetSpec,
  GraphBudgetSpec,
} from "../types.graph-v2.ts";
import { JoinStrategy, JOIN_STRATEGY_VALUES } from "../constants.ts";

/**
 * A graph document as parsed from disk. `version` is optional at the type level
 * so a document missing `version` is representable here and handed to the
 * validator, which is responsible for the "version missing" structural error.
 * When `version === 2` this is exactly a `GraphDeclaration`.
 */
export type GraphDocument = Omit<GraphDeclaration, "version"> & {
  version?: number;
};

/** Result of parsing — a discriminated union so callers never cast. */
export type GraphParseResult =
  | { ok: true; graph: GraphDocument }
  | { ok: false; errors: string[] };

// ── Edge type vocabulary ─────────────────────────────────────────────────

const EDGE_TYPES: readonly EdgeType[] = ["always", "on_signal", "on_condition"];

// ── Public entry point ───────────────────────────────────────────────────

/**
 * Deserialize a graph from a YAML/JSON string or an already-parsed object.
 *
 * @param source - YAML/JSON text, or a parsed object tree.
 * @returns `{ ok: true, graph }` on success, or `{ ok: false, errors }` with
 *   human-readable deserialization errors on failure. Never throws for
 *   malformed *content*; throws nothing at all on the happy path.
 */
export function parseGraph(source: string | unknown): GraphParseResult {
  let parsed: unknown;
  if (typeof source === "string") {
    try {
      parsed = yaml.load(source);
    } catch (err) {
      return {
        ok: false,
        errors: [
          `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
        ],
      };
    }
  } else {
    parsed = source;
  }

  if (parsed === null || parsed === undefined) {
    return { ok: false, errors: ["graph document is empty"] };
  }

  const root = asRecord(parsed);
  if (root === null) {
    return { ok: false, errors: ["graph document root is not an object"] };
  }

  // Primary key `graph:`; legacy `dag:` accepted as an alias (§dag-yaml-schema 4.1).
  const g = asRecord(root.graph) ?? asRecord(root.dag);
  if (g === null) {
    return {
      ok: false,
      errors: ['missing "graph:" (or legacy "dag:") block in document'],
    };
  }

  const errors: string[] = [];

  const version = asNumber(g.version);
  const name = asString(g.name) ?? "unnamed-graph";

  const nodes: NodeConfig[] = [];
  if (Array.isArray(g.nodes)) {
    g.nodes.forEach((nodeRaw, i) => nodes.push(mapNode(nodeRaw, i, errors)));
  } else if (g.nodes !== undefined) {
    errors.push('"nodes" must be an array');
  }

  const edges: EdgeDeclaration[] = [];
  if (Array.isArray(g.edges)) {
    g.edges.forEach((edgeRaw, i) => edges.push(mapEdge(edgeRaw, i, errors)));
  } else if (g.edges !== undefined) {
    errors.push('"edges" must be an array');
  }

  const loop_groups: LoopGroupDecl[] = [];
  if (g.loop_groups !== undefined) {
    if (Array.isArray(g.loop_groups)) {
      g.loop_groups.forEach((lgRaw, i) => {
        const lg = mapLoopGroup(lgRaw, i, errors);
        if (lg !== undefined) loop_groups.push(lg);
      });
    } else {
      errors.push('"loop_groups" must be an array');
    }
  }

  const graph: GraphDocument = { version, name, nodes, edges };

  const budget = mapGraphBudget(g.budget);
  if (budget !== undefined) graph.budget = budget;

  const termination = mapTermination(g.termination);
  if (termination !== undefined) graph.termination = termination;

  if (loop_groups.length > 0) graph.loop_groups = loop_groups;

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, graph };
}

// ── Field mappers ────────────────────────────────────────────────────────

function mapNode(raw: unknown, index: number, errors: string[]): NodeConfig {
  const empty: NodeConfig = { id: "", agent: "", prompt: "" };
  const rec = asRecord(raw);
  if (rec === null) {
    errors.push(`node[${index}] is not an object`);
    return empty;
  }

  const id = asString(rec.id) ?? "";
  const agent = asString(rec.agent) ?? "";
  const prompt = asString(rec.prompt) ?? "";

  if (id === "") errors.push(`node[${index}] is missing required field "id"`);
  if (agent === "")
    errors.push(`node[${index}] is missing required field "agent"`);
  if (prompt === "")
    errors.push(`node[${index}] is missing required field "prompt"`);

  const node: NodeConfig = { id, agent, prompt };

  const completionCondition = asString(rec.completion_condition);
  if (completionCondition !== null) node.completion_condition = completionCondition;

  const needsApproval = asBoolean(rec.needs_approval);
  if (needsApproval !== undefined) node.needs_approval = needsApproval;

  if (rec.join !== undefined) {
    const join = mapJoin(rec.join);
    if (join !== undefined) node.join = join;
  }

  if (rec.budget !== undefined) {
    const budget = mapNodeBudget(rec.budget);
    if (budget !== undefined) node.budget = budget;
  }

  return node;
}

function mapEdge(raw: unknown, index: number, errors: string[]): EdgeDeclaration {
  const empty: EdgeDeclaration = { from: "", to: "", type: "always" };
  const rec = asRecord(raw);
  if (rec === null) {
    errors.push(`edge[${index}] is not an object`);
    return empty;
  }

  const from = asString(rec.from) ?? "";
  const to = asString(rec.to) ?? "";
  if (from === "") errors.push(`edge[${index}] is missing required field "from"`);
  if (to === "") errors.push(`edge[${index}] is missing required field "to"`);

  let type: EdgeType = "always";
  const typeRaw = asString(rec.type);
  if (typeRaw !== null) {
    if ((EDGE_TYPES as readonly string[]).includes(typeRaw)) {
      type = typeRaw as EdgeType;
    } else {
      errors.push(`edge[${index}] has unknown type "${typeRaw}" (expected one of: ${EDGE_TYPES.join(", ")})`);
    }
  }

  const edge: EdgeDeclaration = { from, to, type };

  const signalFilter = asStringArray(rec.signal_filter);
  if (signalFilter !== undefined) edge.signal_filter = signalFilter;

  const condition = asString(rec.condition);
  if (condition !== null) edge.condition = condition;

  if (rec.data_passthrough !== undefined) {
    const dm = mapDataMapping(rec.data_passthrough);
    if (dm !== undefined) edge.data_passthrough = dm;
  }

  if (rec.retry !== undefined) {
    const retry = mapRetry(rec.retry);
    if (retry !== undefined) edge.retry = retry;
  }

  return edge;
}

function mapLoopGroup(
  raw: unknown,
  index: number,
  errors: string[],
): LoopGroupDecl | undefined {
  const rec = asRecord(raw);
  if (rec === null) {
    errors.push(`loop_groups[${index}] is not an object`);
    return undefined;
  }

  const id = asString(rec.id) ?? "";
  const nodes = asStringArray(rec.nodes) ?? [];
  const maxTraversals = asNumber(rec.max_traversals);

  if (id === "")
    errors.push(`loop_groups[${index}] is missing required field "id"`);
  if (rec.nodes !== undefined && !Array.isArray(rec.nodes)) {
    errors.push(`loop_groups[${index}] "nodes" must be an array`);
  }
  if (maxTraversals === undefined) {
    errors.push(`loop_groups[${index}] is missing required field "max_traversals"`);
  }

  const lg: LoopGroupDecl = {
    id,
    nodes,
    max_traversals: maxTraversals ?? 0,
  };

  if (rec.termination !== undefined) {
    const termination = mapTermination(rec.termination);
    if (termination !== undefined) lg.termination = termination;
  }

  return lg;
}

function mapJoin(raw: unknown): JoinConfig | undefined {
  // YAML §2.3.1 encodes the strategy as a single string: "all" | "any" | "quorum:N".
  const str = asString(raw);
  if (str !== null) return parseJoinStrategyString(str.trim());

  const rec = asRecord(raw);
  if (rec === null) return undefined;

  const strategyRaw = asString(rec.strategy);
  if (strategyRaw === null) return undefined;

  const join = parseJoinStrategyString(strategyRaw.trim());
  if (join === undefined) return undefined;

  const quorum = asNumber(rec.quorum);
  if (quorum !== undefined) join.quorum = quorum;
  return join;
}

function parseJoinStrategyString(s: string): JoinConfig | undefined {
  const quorumMatch = /^quorum\s*:\s*(\d+)$/i.exec(s);
  if (quorumMatch !== null) {
    return { strategy: "quorum", quorum: Number(quorumMatch[1]) };
  }
  if ((JOIN_STRATEGY_VALUES as readonly string[]).includes(s)) {
    return { strategy: s as JoinStrategy };
  }
  return undefined;
}

function mapDataMapping(raw: unknown): DataMapping | undefined {
  const rec = asRecord(raw);
  if (rec === null) return undefined;

  const fields = asStringArray(rec.include) ?? asStringArray(rec.fields);
  const exclude = asStringArray(rec.exclude);
  const maxChars = asNumber(rec.max_chars);

  const mapping: DataMapping = {};
  if (fields !== undefined && fields.length > 0) mapping.fields = fields;
  if (exclude !== undefined && exclude.length > 0) mapping.exclude = exclude;
  if (maxChars !== undefined) mapping.maxChars = maxChars;

  return Object.keys(mapping).length > 0 ? mapping : undefined;
}

function mapRetry(raw: unknown): RetryConfig | undefined {
  // Bare number form (YAML §2.4): retry: 3
  const bare = asNumber(raw);
  if (bare !== undefined) return { max: bare };

  const rec = asRecord(raw);
  if (rec === null) return undefined;
  const max = asNumber(rec.max);
  if (max === undefined) return undefined;

  const retry: RetryConfig = { max };
  const backoff = asNumber(rec.backoff_ms);
  if (backoff !== undefined) retry.backoff_ms = backoff;
  return retry;
}

const NODE_BUDGET_FIELDS = [
  "max_sessions",
  "max_input_tokens",
  "max_output_tokens",
  "max_cost_usd",
  "timeout_ms",
  "max_retries",
] as const;

function mapNodeBudget(raw: unknown): NodeBudgetSpec | undefined {
  const rec = asRecord(raw);
  if (rec === null) return undefined;

  const budget: NodeBudgetSpec = {};
  for (const field of NODE_BUDGET_FIELDS) {
    const value = asNumber(rec[field]);
    if (value !== undefined) (budget as Record<string, unknown>)[field] = value;
  }
  return Object.keys(budget).length > 0 ? budget : undefined;
}

const GRAPH_BUDGET_FIELDS = [
  "max_total_sessions",
  "max_total_input_tokens",
  "max_total_output_tokens",
  "max_total_cost_usd",
] as const;

function mapGraphBudget(raw: unknown): GraphBudgetSpec | undefined {
  const rec = asRecord(raw);
  if (rec === null) return undefined;

  const budget: GraphBudgetSpec = {};
  for (const field of GRAPH_BUDGET_FIELDS) {
    const value = asNumber(rec[field]);
    if (value !== undefined) (budget as Record<string, unknown>)[field] = value;
  }
  return Object.keys(budget).length > 0 ? budget : undefined;
}

function mapTermination(raw: unknown): TerminationDecl | undefined {
  const rec = asRecord(raw);
  if (rec === null) return undefined;

  const termination: TerminationDecl = {};
  const anyOf = mapConditions(rec.any_of);
  if (anyOf !== undefined) termination.any_of = anyOf;
  const allOf = mapConditions(rec.all_of);
  if (allOf !== undefined) termination.all_of = allOf;

  return termination.any_of || termination.all_of ? termination : undefined;
}

function mapConditions(raw: unknown): TerminationCondition[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const out: TerminationCondition[] = [];
  for (const cond of raw) {
    // YAML list items parse to single-key objects (e.g. `- converged: "reviewer"`),
    // which align directly with the TS TerminationCondition union variants.
    if (asRecord(cond) !== null) out.push(cond as TerminationCondition);
  }
  return out.length > 0 ? out : undefined;
}

// ── Scalar coercers (lenient — malformed values are dropped, not thrown) ─

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const s = asString(item);
    if (s !== null) out.push(s);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Graph Engine v2 — import a graph declaration from a serialized YAML/JSON file
// ─────────────────────────────────────────────────────────────────────────

const log = createSubLogger("graph-parser");

/**
 * Load a graph declaration from a serialized YAML/JSON file on disk.
 *
 * Reads the file, deserializes it via the v2 parser (`parseGraph` in this
 * module — YAML and JSON are both accepted), then runs structural validation
 * (`validateGraphDeclaration` in ./validator-v2.ts). Returns the validated
 * `GraphDeclaration`, or `null` when the file is unreadable, fails to
 * deserialize, or fails structural validation.
 *
 * @param filePath - absolute or relative path to a `.yaml`/`.yml`/`.json` graph file.
 * @returns the validated v2 graph declaration, or `null` on any failure.
 */
export function importGraphFromFile(filePath: string): GraphDeclaration | null {
  let source: string;
  try {
    source = readFileSync(filePath, "utf-8");
  } catch (err) {
    log.warn(
      `cannot read graph file "${filePath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  const parsed = parseGraph(source);
  if (!parsed.ok) {
    log.warn(
      `graph file "${filePath}" failed to parse: ${parsed.errors.join("; ")}`,
    );
    return null;
  }

  const document: GraphDocument = parsed.graph;
  const validation = validateGraphDeclaration(document);
  for (const warning of validation.warnings) {
    log.info(warning);
  }
  if (!validation.valid) {
    log.warn(
      `graph file "${filePath}" failed validation: ${validation.errors.join("; ")}`,
    );
    return null;
  }

  // Structural validation guarantees `version === 2`, which is exactly a
  // GraphDeclaration. Narrow the optional-version document to the declared type.
  return document as GraphDeclaration;
}
