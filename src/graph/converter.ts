import type { CollaborationConfig, FlowEdge } from "../types.ts";
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
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("graph-converter");

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

/** Fallback iteration cap applied to detected cycles when the config is silent. */
const DEFAULT_MAX_ITERATIONS = 3;

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
      log.warn(
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
 * Resolve the effective iteration cap, matching parser.ts:82-89:
 * explicit non-negative value wins; otherwise 3 when a cycle exists; else 0.
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
