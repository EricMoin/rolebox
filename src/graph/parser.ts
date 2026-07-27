import type {
  ResolvedGraph,
  LoopGroup,
  FlowEdge,
  TerminationConfig,
  CollaborationConfig,
} from "../types.ts";
import { PARENT_NODE } from "../constants.ts";
import { validateGraph } from "./validator.ts";
import { hasCycle, isExitEdge } from "./graph-utils.ts";
import { detectLoopGroups } from "./loop-detector.ts";
import { registerTerminationParser, addTerminationConditionKey } from "./termination-parser.ts";
import { createSubLogger, rootLogger } from "../logger.ts";
// ── Graph Engine v2: file import integration ────────────────────────────
import { readFileSync } from "node:fs";
import type { GraphDeclaration } from "../types.graph-v2.ts";
import { parseGraph, type GraphDocument } from "./parser-v2.ts";
import { validateGraphDeclaration } from "./validator-v2.ts";
import { convertCollaborationToGraphDeclaration } from "./converter.ts";

const log = createSubLogger("graph-parser");

/** Fallback iteration cap applied to detected cycles (mirrors parser v1). */
const DEFAULT_MAX_ITERATIONS = 3;

export { registerTerminationParser, addTerminationConditionKey };

// ─────────────────────────────────────────────────────────────────────────
// Graph Engine v2 — import a graph declaration from a serialized YAML/JSON file
// ─────────────────────────────────────────────────────────────────────────
//
// This is the v2 external-integration entry point. It is additive and
// independent from the legacy `collaboration:` import path (which now routes
// through `autoConvertCollaboration` + `graphDeclarationToResolvedGraph`).

/**
 * Load a graph declaration from a serialized YAML/JSON file on disk.
 *
 * Reads the file, deserializes it via the v2 parser (`parseGraph` in
 * ./parser-v2.ts — YAML and JSON are both accepted), then runs structural
 * validation (`validateGraphDeclaration` in ./validator-v2.ts). Returns the
 * validated `GraphDeclaration`, or `null` when the file is unreadable, fails
 * to deserialize, or fails structural validation.
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

// ─────────────────────────────────────────────────────────────────────────
// Graph Engine v2 — legacy `collaboration:` → v2 auto-conversion
// ─────────────────────────────────────────────────────────────────────────
//
// Transparent bridge from the legacy v1 `collaboration:` import path to the
// v2 imperative graph model. It delegates entirely to
// `convertCollaborationToGraphDeclaration` (src/graph/converter.ts) — the
// conversion logic is NOT duplicated here — and emits a one-time deprecation
// notice so callers know the returned value is a v2 `GraphDeclaration`, not a
// legacy `ResolvedGraph`.

/**
 * Auto-convert a legacy `collaboration:` config to a v2 `GraphDeclaration`.
 *
 * `collaboration:` is a legacy import path. When a role config carries it,
 * this bridge transparently reinterprets the config under the v2
 * imperative `graph_*` / `graph:` schema by delegating to
 * `convertCollaborationToGraphDeclaration` and returning its lossless v2
 * declaration. A deprecation warning is logged so downstream tooling can
 * flag and migrate the config.
 *
 * @param collab - the legacy `collaboration:` block from the role config.
 * @param opts - routing/identity for the produced declaration:
 *   - `parentAgentId`: dispatchable subagent id of the orchestrating (parent) role.
 *   - `roleName`: human-readable name assigned to the graph declaration
 *     (mapped to the converter's `name` field).
 * @returns a v2 `GraphDeclaration` equivalent to what an explicit
 *   `convertCollaborationToGraphDeclaration` call would produce.
 */
export function autoConvertCollaboration(
  collab: CollaborationConfig,
  opts: { parentAgentId: string; roleName: string },
): GraphDeclaration {
  // Routed through the live `rootLogger` proxy (not the module `log`) so the
  // deprecation is observable to any transport attached to the root logger —
  // it is a cross-cutting migration notice, not a graph-parser-scoped detail.
  rootLogger.warn(
    "collaboration: is a legacy import path and is being auto-converted to the v2 imperative graph_* / graph: schema",
  );
  return convertCollaborationToGraphDeclaration(collab, {
    parentAgentId: opts.parentAgentId,
    name: opts.roleName,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Graph Engine v2 — v2 GraphDeclaration → v1 ResolvedGraph bridge
// ─────────────────────────────────────────────────────────────────────────
//
// The resolver's downstream prompt/state builders (`buildCollaborationBlock`,
// `computeNodeRole`, `buildGraphStateBlock`) consume the legacy v1
// `ResolvedGraph` shape. This bridge derives that shape from a v2
// `GraphDeclaration` produced by the converter, reproducing the exact
// topology the legacy collaboration parser (now removed) would have produced:
//   - nodes   = every declared node except the terminal `PARENT_NODE`
//     approval node (`needs_approval: true`). The parent is a flow boundary,
//     not a routing agent, so it is excluded from `ResolvedGraph.nodes` and its
//     incoming edges become v1 exit edges.
//   - edges   = v1 FlowEdges with direction and the optional provenance
//     `label` preserved; exit semantics fall out of `isExitEdge`
//     (`to === PARENT_NODE` or a preserved `exit` flag).
//   - loopGroups = recomputed via `detectLoopGroups` so the v1 `backEdges`
//     match the legacy output exactly.
//   - maxIterations / template / termination = read from the converter's
//     provenance fields (`decl.max_iterations`, `decl.template`,
//     `decl.termination`), which are set only for converted declarations and
//     ignored by the engine.
//
// When `availableSubagentNames` is supplied, the reconstructed graph is run
// through the v1 `validateGraph` (the same gate the legacy parser used) so an
// invalid collaboration still resolves to `null` — preserving the resolver's
// existing behavior.

/**
 * Derive a legacy v1 `ResolvedGraph` from a v2 `GraphDeclaration`.
 *
 * Reverses `convertCollaborationToGraphDeclaration` for the fields the legacy
 * prompt/state builders consume, honoring the `PARENT_NODE` approval-node
 * semantics (`needs_approval: true` terminal node). Returns `null` when the
 * reconstruction fails v1 validation (only when `availableSubagentNames` is
 * given).
 *
 * @param decl - a v2 graph declaration, typically from `autoConvertCollaboration`.
 * @param opts - `availableSubagentNames` optionally enables the v1 validation gate.
 * @returns the reconstructed legacy `ResolvedGraph`, or `null` on validation failure.
 */
export function graphDeclarationToResolvedGraph(
  decl: GraphDeclaration,
  opts: { availableSubagentNames?: string[] } = {},
): ResolvedGraph | null {
  const edges: FlowEdge[] = decl.edges.map((e) => ({
    from: e.from,
    to: e.to,
    ...(e.label ? { label: e.label } : {}),
  }));

  const nodes = decl.nodes
    .filter((n) => n.id !== PARENT_NODE)
    .map((n) => n.id);

  const exitEdges = edges.filter(isExitEdge);
  const loopGroups: LoopGroup[] = detectLoopGroups(edges);

  const maxIterations =
    typeof decl.max_iterations === "number" && Number.isFinite(decl.max_iterations)
      ? Math.max(0, decl.max_iterations)
      : loopGroups.length > 0
        ? (loopGroups[0].maxIterations ?? DEFAULT_MAX_ITERATIONS)
        : hasCycle(edges)
          ? DEFAULT_MAX_ITERATIONS
          : 0;

  const resolvedGraph: ResolvedGraph = {
    edges,
    nodes,
    maxIterations,
    exitEdges,
    ...(decl.template !== undefined ? { template: decl.template } : {}),
    loopGroups,
    // Converter-produced declarations only ever carry v1-shaped conditions, so
    // narrowing the wider v2 TerminationDecl to the v1 TerminationConfig is safe.
    ...(decl.termination
      ? { termination: { config: decl.termination as unknown as TerminationConfig, loopGroups } }
      : {}),
  };

  if (opts.availableSubagentNames) {
    const { valid, warnings } = validateGraph(
      resolvedGraph,
      opts.availableSubagentNames,
    );
    if (!valid) {
      log.warn(`validation failed: ${warnings.join("; ")}`);
      return null;
    }
    for (const warning of warnings) {
      log.info(warning);
    }
  }

  return resolvedGraph;
}
