import type { ResolvedGraph, GraphNodeRole } from "../types.ts";
import { GraphTemplate as GT, PARENT_NODE } from "../constants.ts";
import { RESULT_FENCE } from "../dispatch/result-extractor.ts";

// ── Helpers ────────────────────────────────────────────────────────────

function buildMetaMap(
  subagentMeta: Array<{ id: string; name: string; description: string }>,
): Map<string, { name: string; description: string }> {
  return new Map(subagentMeta.map((a) => [a.id, { name: a.name, description: a.description }]));
}

/** Resolve a display name for an agent, falling back to the id. */
function agentName(
  id: string,
  meta: Map<string, { name: string; description: string }>,
): string {
  return meta.get(id)?.name ?? id;
}

/**
 * Trace a linear path through the graph from "parent".
 * Follows each agent's first non-parent outgoing edge until no more unvisited agents remain.
 * Excludes edges to "parent" and already-visited agents.
 */
function traceLinearPath(graph: ResolvedGraph): string[] {
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = adj.get(e.from);
    if (list) {
      list.push(e.to);
    } else {
      adj.set(e.from, [e.to]);
    }
  }

  const path: string[] = [];
  const visited = new Set<string>();
  let current = PARENT_NODE;

  while (true) {
    const nextNodes = (adj.get(current) ?? []).filter(
      (n) => n !== PARENT_NODE,
    );
    if (nextNodes.length === 0) break;
    // Prefer the first unvisited node (non-loop edge); fall back to first
    const next = nextNodes.find((n) => !visited.has(n)) ?? nextNodes[0];
    if (visited.has(next)) break;
    path.push(next);
    visited.add(next);
    current = next;
  }

  return path;
}

/**
 * Find edges that loop backward in the linear path (from → to where from
 * appears after to in the path).
 */
function findLoopEdges(
  graph: ResolvedGraph,
  path: string[],
): { from: string; to: string }[] {
  const pathSet = new Set(path);
  const loops: { from: string; to: string }[] = [];
  for (const e of graph.edges) {
    if (!pathSet.has(e.from) || !pathSet.has(e.to)) continue;
    if (path.indexOf(e.from) > path.indexOf(e.to)) {
      loops.push({ from: e.from, to: e.to });
    }
  }
  return loops;
}

/** Agents in a star topology (have edges from parent and back to parent). */
function getStarWorkers(graph: ResolvedGraph): string[] {
  return graph.nodes.filter((n) => {
    const fromParent = graph.edges.some((e) => e.from === PARENT_NODE && e.to === n);
    const toParent = graph.edges.some((e) => e.from === n && e.to === PARENT_NODE);
    return fromParent && toParent;
  });
}

// ── Routing instruction builders ───────────────────────────────────────

const GUARD_RULES = `- NEVER do specialist work yourself. Always dispatch via task().
- Never call more than one specialist in a single step.
- Always pass the previous step's context and output when dispatching the next step.`;

function buildPipelineXml(
  path: string[],
  meta: Map<string, { name: string; description: string }>,
  maxIterations: number,
): string {
  const steps = path.map((agentId, i) => {
    const name = agentName(agentId, meta);
    if (i === 0) {
      return `Step ${i + 1}: Dispatch initial work to ${name} using task(subagent_type="${agentId}", ...)`;
    }
    return `Step ${i + 1}: Collect ${agentName(path[i - 1], meta)}'s output and dispatch to ${name} using task(subagent_type="${agentId}", prompt="[previous agent's full output]", ...)`;
  });

  const finalName = agentName(path[path.length - 1], meta);
  const collectStep = `Step ${path.length + 1}: ${finalName}'s output is the final result — no further dispatching needed.`;

  const allSteps = [...steps, collectStep];
  const routingLines = allSteps.map((s) => `  ${s}`).join("\n");

  return `<topology>pipeline</topology>
<routing>
${routingLines}
</routing>
<exit_conditions>
The graph completes when: the final agent returns their output, OR max ${maxIterations} iteration(s) reached.
</exit_conditions>
<routing_rules>
${GUARD_RULES}
</routing_rules>`;
}

function buildReviewLoopXml(
  path: string[],
  loopEdges: { from: string; to: string }[],
  meta: Map<string, { name: string; description: string }>,
  maxIterations: number,
): string {
  const steps = path.map((agentId, i) => {
    const name = agentName(agentId, meta);
    if (i === 0) {
      return `Step ${i + 1}: Dispatch initial work to ${name} using task(subagent_type="${agentId}", ...)`;
    }
    return `Step ${i + 1}: Collect ${agentName(path[i - 1], meta)}'s output and dispatch to ${name} using task(subagent_type="${agentId}", prompt="[previous agent's full output]", ...)`;
  });

  const routingLines = steps.map((s) => `  ${s}`).join("\n");

  let loopInstruction = "";
  if (loopEdges.length > 0) {
    const loopDescriptions = loopEdges.map(
      (le) =>
        `${agentName(le.from, meta)} may send work back to ${agentName(le.to, meta)}`,
    );
    loopInstruction = `\n  After the final agent responds, evaluate the result. If quality is insufficient, ${loopDescriptions.join("; ")} by dispatching again with task(subagent_type="${loopEdges[0].to}", prompt="[revision notes + previous output]", ...).`;
  }

  return `<topology>review-loop</topology>
<routing>
${routingLines}${loopInstruction}
</routing>
<exit_conditions>
The graph completes when: the final result meets quality criteria and exits, OR max ${maxIterations} iteration(s) reached.
</exit_conditions>
<routing_rules>
${GUARD_RULES}
</routing_rules>`;
}

function buildStarXml(
  workers: string[],
  meta: Map<string, { name: string; description: string }>,
  maxIterations: number,
): string {
  const steps = workers.map((agentId, i) => {
    const name = agentName(agentId, meta);
    return `Step ${i + 1}: Dispatch to ${name} using task(subagent_type="${agentId}", ...)`;
  });

  const routingLines = steps.map((s) => `  ${s}`).join("\n");

  return `<topology>star</topology>
<routing>
Dispatch work to each specialist in sequence (V1 limitation — parallel dispatch not supported):

${routingLines}

  Collect all outputs. The combined results from all agents complete the workflow.
</routing>
<exit_conditions>
The graph completes when: all agents have returned their outputs, OR max ${maxIterations} iteration(s) reached.
</exit_conditions>
<routing_rules>
- NEVER do specialist work yourself. Always dispatch via task().
- Never call more than one specialist in a single step.
</routing_rules>`;
}

function buildCustomXml(
  graph: ResolvedGraph,
  meta: Map<string, { name: string; description: string }>,
): string {
  const routingEdges = graph.edges.filter(
    (e) => e.from !== PARENT_NODE && e.to !== PARENT_NODE,
  );
  const parentEdges = graph.edges.filter(
    (e) => e.from === PARENT_NODE,
  );
  const exitEdges = graph.edges.filter(
    (e) => e.exit === true || e.to === PARENT_NODE,
  );

  const parts: string[] = [];

  if (parentEdges.length > 0) {
    const entryNames = parentEdges.map((e) => agentName(e.to, meta));
    parts.push(
      `The orchestrator dispatches initial work to: ${entryNames.join(", ")}.\n  Use task(subagent_type="<agent-id>", ...) to dispatch to each.`,
    );
  }

  if (routingEdges.length > 0) {
    parts.push(
      `Agent-to-agent transitions: ${routingEdges.map((e) => `${agentName(e.from, meta)} → ${agentName(e.to, meta)}`).join(", ")}.`,
    );
  }

  if (exitEdges.length > 0) {
    const exitNames = [...new Set(
      exitEdges.filter((e) => e.from !== PARENT_NODE).map((e) => agentName(e.from, meta)),
    )];
    parts.push(
      `Exit points: ${exitNames.join(", ")}. Their output completes the workflow.`,
    );
  }

  return `<topology>custom</topology>
<routing>
${parts.map((p) => `  ${p}`).join("\n\n")}
</routing>
<exit_conditions>
The graph completes when: an exit-point agent returns their output, OR max ${graph.maxIterations} iteration(s) reached.
</exit_conditions>
<routing_rules>
${GUARD_RULES}
</routing_rules>`;
}

// ── Result contract ────────────────────────────────────────────────────

/**
 * Guidance block telling subagents to wrap their final deliverable
 * inside a fenced ```result block so the orchestrator can extract it cleanly.
 *
 * This is guidance, not a hard requirement — extraction falls back to
 * full text when no fence is present.
 */
export const SUBAGENT_RESULT_CONTRACT = `<result_contract>
When you finish, put your final deliverable inside a fenced \`\`\`${RESULT_FENCE} block so the orchestrator can extract it cleanly. Everything outside the block is treated as working notes.
</result_contract>`;

/**
 * Build the `<result_contract>` guidance block for subagents.
 *
 * Injects a concise reminder to use the result fence.
 */
export function buildResultContract(): string {
  return SUBAGENT_RESULT_CONTRACT;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Build the parent (orchestrator) collaboration block.
 *
 * Generates the `<collaboration_graph>` XML block containing topology info,
 * step-by-step routing instructions, exit conditions, and guard rules.
 * The block is injected into the parent role's system prompt.
 */
export function buildCollaborationBlock(
  graph: ResolvedGraph,
  subagentMeta: Array<{ id: string; name: string; description: string }>,
): string {
  if (graph.nodes.length === 0) return "";

  const meta = buildMetaMap(subagentMeta);
  const template = graph.template ?? "custom";

  let routingXml: string;
  switch (template) {
    case GT.Pipeline: {
      const path = traceLinearPath(graph);
      if (path.length < graph.nodes.length) {
        routingXml = buildCustomXml(graph, meta);
      } else {
        routingXml = buildPipelineXml(path, meta, graph.maxIterations);
      }
      break;
    }
    case GT.ReviewLoop: {
      const path = traceLinearPath(graph);
      const loopEdges = findLoopEdges(graph, path);
      if (path.length < graph.nodes.length) {
        routingXml = buildCustomXml(graph, meta);
      } else {
        routingXml = buildReviewLoopXml(path, loopEdges, meta, graph.maxIterations);
      }
      break;
    }
    case GT.Star:
      routingXml = buildStarXml(
        getStarWorkers(graph),
        meta,
        graph.maxIterations,
      );
      break;
    default:
      routingXml = buildCustomXml(graph, meta);
      break;
  }

  return `<collaboration_graph>
${routingXml}
</collaboration_graph>`;
}

/**
 * Build a subagent's collaboration role block.
 *
 * Generates the `<collaboration_role>` XML block describing the subagent's
 * position in the collaboration flow — entry, middle, or exit point.
 * The block is concise to preserve the subagent's context budget.
 */
export function buildSubagentRoleBlock(nodeRole: GraphNodeRole): string {
  const { upstream, downstream, isEntryPoint, isExitPoint } = nodeRole;

  let roleText: string;

  if (isEntryPoint && isExitPoint) {
    roleText =
      "You receive work from the orchestrator. Your output completes the workflow.";
  } else if (isEntryPoint) {
    roleText = "You receive work from the orchestrator.";
    if (downstream.length > 0) {
      const targets = downstream.join(", ");
      roleText += ` Your output will be passed to: ${targets}.`;
    }
  } else if (isExitPoint) {
    if (upstream.length > 0) {
      roleText = `You receive work from: ${upstream.join(", ")}. Your output completes the workflow.`;
    } else {
      roleText = "Your output completes the workflow.";
    }
  } else {
    const parts: string[] = [];
    if (upstream.length > 0) {
      parts.push(`receives work from: ${upstream.join(", ")}`);
    }
    if (downstream.length > 0) {
      parts.push(`passes output to: ${downstream.join(", ")}`);
    }
    if (parts.length === 2) {
      roleText = `You are a middle agent in the collaboration. You ${parts[0]} and ${parts[1]}.`;
    } else if (parts.length === 1) {
      roleText = `You are a middle agent in the collaboration. You ${parts[0]}.`;
    } else {
      roleText = "You are a middle agent in the collaboration.";
    }
  }

  return `<collaboration_role>
${roleText}
</collaboration_role>`;
}
