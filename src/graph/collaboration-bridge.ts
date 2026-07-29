/**
 * Collaboration → v2 Graph Declaration bridge.
 *
 * Centralizes the cross-subsystem boundary between the legacy `collaboration:`
 * config surface and the v2 imperative graph model:
 *
 *   - `convertCollaborationToGraphDeclaration` — converts a legacy v1
 *     `collaboration:` config into a lossless v2 `GraphDeclaration`.
 *   - `autoConvertCollaboration` — bridges the legacy `collaboration:` import
 *     path to v2 by delegating to the converter and logging a deprecation
 *     notice.
 *   - `graphDeclarationToResolvedGraph` — derives the legacy v1 `ResolvedGraph`
 *     shape that the resolver's downstream prompt/state builders consume.
 *
 * These three functions now live here (this module, `src/graph/collaboration-bridge.ts`),
 * relocating what previously lived on the legacy v1 `src/graph/converter.ts` and
 * `src/graph/parser.ts` delete-target modules. Those modules are now thin re-export
 * shims and later removed. See the graph decommission doc, Stage 3.
 */

import type {
  CollaborationConfig,
  FlowEdge,
  LoopGroup,
  ResolvedGraph,
  TerminationConfig,
} from "../types.ts";
import type {
  EdgeDeclaration,
  GraphDeclaration,
  LoopGroupDecl,
  NodeConfig,
  TerminationDecl,
} from "../types.graph-v2.ts";
import { PARENT_NODE } from "../constants.ts";
import { expandTemplate } from "./templates.ts";
import { parseFlow, mergeEdges } from "./edge-parser.ts";
import { hasCycle, isExitEdge } from "./graph-utils.ts";
import { detectLoopGroups } from "./loop-detector.ts";
import { validateGraph } from "./collaboration-validator.ts";
import { createSubLogger, rootLogger } from "../logger.ts";

const converterLog = createSubLogger("graph-converter");
const parserLog = createSubLogger("graph-parser");

/** Fallback iteration cap applied to detected cycles when the config is silent. */
const DEFAULT_MAX_ITERATIONS = 3;

/**
 * Options that parameterize a collaboration → graph-declaration conversion.
 *
 * The collaboration config carries only agent *ids* and flow edges; it does
 * not know the parent role's dispatchable subagent id or the human-readable
 * name that should label the produced declaration. Both are supplied here so
 * the converter stays a pure, stateless function of `(collab, opts)`.
 */
export interface ConvertOptions {
  /** Dispatchable subagent id of the orchestrating (parent) role. */
  parentAgentId: string;
  /** Human-readable name assigned to the resulting graph declaration. */
  name: string;
}

/**
 * Convert a legacy `collaboration:` config (v1) into a lossless v2
 * `GraphDeclaration`.
 *
 * The conversion is deliberately reference-aligned with the legacy
 * collaboration parser (now removed): the same `expandTemplate` + `parseFlow`
 * + `mergeEdges` derivation yields the identical FlowEdge set, and the same
 * `max_iterations` defaulting (explicit value → 3 on a cycle → 0) is applied.
 * Node count, edge direction, and loop cap are therefore preserved exactly.
 *
 * Mapping rules:
 * - Each agent id (excluding `PARENT_NODE`) becomes a `NodeConfig {id, agent,
 *   prompt}`. In a collaboration config the agent ids *are* the subagent names,
 *   so `agent` equals the node id; `prompt` is synthesized from the graph name.
 * - All `PARENT_NODE` entry/exit edges and every `exit: true` edge are
 *   collapsed into ONE terminal approval node `{id: PARENT_NODE, agent:
 *   parentAgentId, needs_approval: true}`.
 * - Every remaining FlowEdge (including the terminal node's edges) maps to an
 *   `EdgeDeclaration {type: 'on_signal', signal_filter: ['answer']}` with
 *   direction preserved.
 * - Cycles are detected on the agent-to-agent subgraph and emitted as
 *   `loop_groups` via `detectLoopGroups`, each bounded by `max_traversals =
 *   max_iterations`. Collaboration termination is propagated to both the graph
 *   and each loop group when present.
 */
export function convertCollaborationToGraphDeclaration(
  collab: CollaborationConfig,
  opts: ConvertOptions,
): GraphDeclaration {
  const edges = deriveFlowEdges(collab);

  const agentIds = distinctAgentIds(edges);

  const hasTerminal = edges.some(
    (e) => isExitEdge(e) || e.from === PARENT_NODE,
  );

  const nodes: NodeConfig[] = agentIds.map((id) => ({
    id,
    agent: id,
    prompt: synthesizePrompt(id, opts.name),
  }));

  if (hasTerminal) {
    nodes.push({
      id: PARENT_NODE,
      agent: opts.parentAgentId,
      prompt: synthesizePrompt(PARENT_NODE, opts.name),
      needs_approval: true,
    });
  }

  const edgeDeclarations: EdgeDeclaration[] = edges.map((e) => ({
    from: e.from,
    to: e.to,
    type: "on_signal",
    signal_filter: ["answer"],
    ...(e.label ? { label: e.label } : {}),
  }));

  const maxIterations = computeMaxIterations(collab, edges);

  const termination = mapTermination(collab.termination);

  let loopGroups: LoopGroupDecl[] | undefined;
  if (hasCycle(edges)) {
    loopGroups = detectLoopGroups(edges).map((g) => ({
      id: g.id,
      nodes: [...g.nodes],
      max_traversals: maxIterations,
      ...(termination ? { termination } : {}),
    }));
  }

  return {
    version: 2,
    name: opts.name,
    nodes,
    edges: edgeDeclarations,
    ...(collab.topology ? { template: collab.topology } : {}),
    max_iterations: maxIterations,
    ...(loopGroups && loopGroups.length > 0 ? { loop_groups: loopGroups } : {}),
    ...(termination ? { termination } : {}),
  };
}

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
      parserLog.warn(`validation failed: ${warnings.join("; ")}`);
      return null;
    }
    for (const warning of warnings) {
      parserLog.info(warning);
    }
  }

  return resolvedGraph;
}

// ─── Private helpers ─────────────────────────────────────────────────────

/**
 * Derive the full FlowEdge set exactly as the legacy parser does (template
 * expansion when both a topology and agents are present, then merge the
 * explicitly declared flow).
 */
function deriveFlowEdges(collab: CollaborationConfig): FlowEdge[] {
  const agents = collab.agents ?? [];

  let templateEdges: FlowEdge[] = [];
  if (collab.topology !== undefined && agents.length > 0) {
    try {
      templateEdges = expandTemplate(collab.topology, agents);
    } catch (err) {
      converterLog.warn(
        `expandTemplate failed for topology "${collab.topology}": ${
          err instanceof Error ? err.message : String(err)
        } — falling back to explicit flow edges only`,
      );
      templateEdges = [];
    }
  }

  return mergeEdges(templateEdges, parseFlow(collab.flow));
}

/** Collect distinct agent ids in first-seen order, excluding PARENT_NODE. */
function distinctAgentIds(edges: FlowEdge[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const e of edges) {
    for (const id of [e.from, e.to]) {
      if (id === PARENT_NODE) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Resolve the effective iteration cap: explicit non-negative value wins;
 * otherwise 3 when a cycle exists; else 0.
 */
function computeMaxIterations(
  collab: CollaborationConfig,
  edges: FlowEdge[],
): number {
  if (
    typeof collab.max_iterations === "number" &&
    Number.isFinite(collab.max_iterations)
  ) {
    return Math.max(0, collab.max_iterations);
  }
  if (hasCycle(edges)) return DEFAULT_MAX_ITERATIONS;
  return 0;
}

/**
 * The collaboration config carries no per-agent role text, so the node prompt
 * is synthesized from the node id and the graph name. This is a stable,
 * meaningful default; richer prompts belong in an explicit v2 graph declaration.
 */
function synthesizePrompt(agentId: string, name: string): string {
  return `You are node "${agentId}" in collaboration graph "${name}". Execute your assigned step, then signal the next node when complete.`;
}

/**
 * Map the v1 TerminationConfig to the v2 TerminationDecl. Every v1 LoopCondition
 * variant is a member of the v2 TerminationCondition union, so the shape passes
 * through unchanged. Returns `undefined` when no termination is configured.
 */
function mapTermination(
  term: CollaborationConfig["termination"],
): TerminationDecl | undefined {
  if (!term) return undefined;
  const decl: TerminationDecl = {};
  if (term.any_of) decl.any_of = term.any_of;
  if (term.all_of) decl.all_of = term.all_of;
  return decl;
}
