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
 *     An unrecognized strategy — including a bare `"quorum"` with no count —
 *     is a deserialization ERROR, exactly like an unknown edge `type`: the
 *     join shapes downstream fan-in semantics, so dropping it silently would
 *     re-interpret "first answer wins" as "wait for everyone" (Y6).
 *   - `loop_groups[].mode` is read and checked against `LoopMode` instead of
 *     being dropped; an unknown value is a deserialization error (Y6).
 *   - `template` / `max_iterations` are mapped onto the declaration (they used
 *     to be documented as round-trip metadata but were never read, so every
 *     parse → serialize lost them) (Y6).
 *
 * Design reference: .rolebox/design/dag-yaml-schema.md (Appendix B canonical
 * example), src/types.graph-v2.ts, src/constants.ts (JoinStrategy).
 */

import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { createSubLogger } from "../logger.ts";
import { errorText } from "../utils/error-text.ts";
import { validateGraphDeclaration } from "./validator-v2.ts";
import type {
  GraphDeclaration,
  NodeConfig,
  EdgeDeclaration,
  EdgeType,
  LoopGroupDecl,
  JoinConfig,
  DataMapping,
  RetryConfig,
  NodeBudgetSpec,
  GraphBudgetSpec,
} from "../types.graph-v2.ts";
import {
  GRAPH_TEMPLATE_VALUES,
  JOIN_STRATEGY_VALUES,
  isGraphTemplate,
} from "../constants.ts";

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
          `YAML parse error: ${errorText(err)}`,
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

  // Declaration metadata. Both fields are documented as round-trip metadata,
  // so they are mapped rather than dropped: a declared template is retained
  // when it names a registered topology (built-in or runtime-registered) and
  // rejected when it does not, mirroring the unknown-edge-type contract.
  const template = asString(g.template);
  if (template !== null) {
    if (isGraphTemplate(template)) {
      graph.template = template;
    } else {
      errors.push(
        `"template" has unknown value "${template}" (expected one of: ` +
          `${[...GRAPH_TEMPLATE_VALUES].join(", ")})`,
      );
    }
  }

  const maxIterations = asNumber(g.max_iterations);
  if (maxIterations !== undefined) graph.max_iterations = maxIterations;

  const budget = mapNumericSpec(g.budget, GRAPH_BUDGET_FIELDS);
  if (budget !== undefined) graph.budget = budget;

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
    const join = mapJoin(rec.join, `node[${index}]`, errors);
    if (join !== undefined) node.join = join;
  }

  if (rec.budget !== undefined) {
    const budget = mapNumericSpec(rec.budget, NODE_BUDGET_FIELDS);
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

  // `mode` used to be ignored entirely: a declared mode vanished on
  // parse → serialize, and `fresh` never reached the documented-unsupported
  // check. Read it and reject an unknown value instead of dropping it (Y6) —
  // an unrecognized mode is a declaration error, not neutral metadata.
  if (rec.mode !== undefined) {
    const mode = asString(rec.mode);
    if (mode === "inherit" || mode === "fresh") {
      lg.mode = mode;
    } else {
      errors.push(
        `loop_groups[${index}] has unknown "mode" ${JSON.stringify(rec.mode)} ` +
          `(expected "inherit" or "fresh")`,
      );
    }
  }

  return lg;
}

/**
 * Map a declared `join` into the {@link JoinConfig} discriminated union.
 *
 * Unlike the other field mappers this one REPORTS instead of dropping: an
 * unrecognized strategy, a missing `strategy`, or a `"quorum"` without a
 * count is pushed onto `errors` (same contract as an unknown edge `type`),
 * because a silently dropped join changes fan-in semantics — the node falls
 * back to `"all"` and waits for every upstream (Y6).
 */
function mapJoin(
  raw: unknown,
  label: string,
  errors: string[],
): JoinConfig | undefined {
  // YAML §2.3.1 encodes the strategy as a single string: "all" | "any" | "quorum:N".
  const str = asString(raw);
  if (str !== null) {
    const strategyText = str.trim();
    if (strategyText === "quorum") {
      errors.push(
        `${label} join strategy "quorum" requires its count in the string form ` +
          `(expected "quorum:N", e.g. "quorum:2")`,
      );
      return undefined;
    }
    const join = parseJoinStrategyString(strategyText);
    if (join === undefined) {
      errors.push(unknownJoinStrategyMessage(label, strategyText));
    }
    return join;
  }

  const rec = asRecord(raw);
  if (rec === null) {
    errors.push(`${label} "join" must be a string or an object`);
    return undefined;
  }

  const strategyRaw = asString(rec.strategy);
  if (strategyRaw === null) {
    errors.push(`${label} join is missing required field "strategy"`);
    return undefined;
  }

  // The object form may spell the count in the strategy itself ("quorum:2") or
  // in the sibling `quorum` key; an explicit, numeric key wins over the
  // combined form.
  const strategyText = strategyRaw.trim();
  const combined = parseJoinStrategyString(strategyText);
  if (combined !== undefined) {
    if (combined.strategy !== "quorum") return combined;
    const explicit = asNumber(rec.quorum);
    return { strategy: "quorum", quorum: explicit ?? combined.quorum };
  }

  if (strategyText === "quorum") {
    const quorum = asNumber(rec.quorum);
    if (quorum === undefined) {
      errors.push(
        `${label} join strategy "quorum" requires a numeric "quorum" count ` +
          `(e.g. { strategy: "quorum", quorum: 2 })`,
      );
      return undefined;
    }
    return { strategy: "quorum", quorum };
  }

  errors.push(unknownJoinStrategyMessage(label, strategyText));
  return undefined;
}

/** Shared "unknown join strategy" diagnostic (vocabulary read from constants). */
function unknownJoinStrategyMessage(label: string, value: string): string {
  return (
    `${label} has unknown join strategy "${value}" ` +
    `(expected one of: ${JOIN_STRATEGY_VALUES.join(", ")}; ` +
    `"quorum" must carry its count as "quorum:N")`
  );
}

/**
 * Parse the combined `"all" | "any" | "quorum:N"` strategy STRING form
 * (YAML §2.3.1). A bare `"quorum"` carries no count in this form and answers
 * `undefined`; the object form expresses it with a sibling `quorum` key.
 */
function parseJoinStrategyString(s: string): JoinConfig | undefined {
  const quorumMatch = /^quorum\s*:\s*(\d+)$/i.exec(s);
  if (quorumMatch !== null) {
    return { strategy: "quorum", quorum: Number(quorumMatch[1]) };
  }
  if (s === "all" || s === "any") return { strategy: s };
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

/**
 * Numeric fields of {@link NodeBudgetSpec}, in declaration order. The
 * `satisfies` check pins every member to a real key of the spec, so a renamed
 * or removed field fails to compile instead of being parsed as a stray key.
 */
const NODE_BUDGET_FIELDS = [
  "max_input_tokens",
  "max_output_tokens",
  "max_cost_usd",
  "timeout_ms",
  "max_retries",
] as const satisfies readonly (keyof NodeBudgetSpec)[];

/** Numeric fields of {@link GraphBudgetSpec}, in declaration order. */
const GRAPH_BUDGET_FIELDS = [
  "max_total_input_tokens",
  "max_total_output_tokens",
  "max_total_cost_usd",
] as const satisfies readonly (keyof GraphBudgetSpec)[];

/**
 * Map the listed numeric fields of a budget record (Y7).
 *
 * One generic helper for the node- and graph-level budgets, which previously
 * had two byte-identical copies that both wrote through
 * `(budget as Record<string, unknown>)[field]`. `fields` is a readonly array
 * of keys of the target spec, so the result is a `Partial` of exactly those
 * keys and is assignable to the spec WITHOUT that cast — the cast was what let
 * a misspelled or removed field name pass silently. Malformed values are
 * dropped (the module's lenient scalar contract); a record with no usable
 * field answers `undefined`.
 */
function mapNumericSpec<K extends string>(
  raw: unknown,
  fields: readonly K[],
): Partial<Record<K, number>> | undefined {
  const rec = asRecord(raw);
  if (rec === null) return undefined;

  const spec: Partial<Record<K, number>> = {};
  for (const field of fields) {
    const value = asNumber(rec[field]);
    if (value !== undefined) spec[field] = value;
  }
  return Object.keys(spec).length > 0 ? spec : undefined;
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
 * (`validateGraphDeclaration` in ./validator-v2.ts) in EXECUTION mode — a
 * graph that could not actually run (an uncontained revise-free cycle, an
 * unknown `on_condition` name) is rejected. Returns the validated
 * `GraphDeclaration`, or `null` when the file is unreadable, fails to
 * deserialize, or fails execution-mode structural validation.
 *
 * @param filePath - absolute or relative path to a `.yaml`/`.yml`/`.json` graph file.
 * @returns the validated v2 graph declaration, or `null` on any failure.
 */
export function importGraphFromFile(filePath: string): GraphDeclaration | null {
  let source: string;
  try {
    source = readFileSync(filePath, "utf-8");
  } catch (err) {
    log.warn(`cannot read graph file "${filePath}": ${errorText(err)}`);
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
  // Execution-mode validation: a serialized graph file that CANNOT run — an
  // uncontained revise-free cycle (deadlocks at run) or an unknown
  // on_condition name (never-satisfiable edge) — is rejected here (null)
  // instead of validating clean and deadlocking when the graph is executed.
  const validation = validateGraphDeclaration(document, { mode: "execution" });
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
  // GraphDeclaration. Narrow the optional-version document with the predicate
  // below instead of asserting the cross-module contract — if the validator
  // ever relaxes the version rule, that shows up here rather than as a silent
  // `as` (B1).
  if (!isV2Document(document)) return null;
  return document;
}

/**
 * Whether a parsed document is exactly a v2 declaration. A type predicate so
 * {@link importGraphFromFile} narrows `GraphDocument` to `GraphDeclaration`
 * on the strength of the version check instead of asserting it (B1).
 */
function isV2Document(document: GraphDocument): document is GraphDeclaration {
  return document.version === 2;
}
