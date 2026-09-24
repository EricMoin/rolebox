import { mkdirSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { GraphNodeView, GraphQueryResult, GraphView } from "./graph-query.ts";

export interface GraphStatusArgs {
  graph_id?: string;
  run_id?: string;
  node_id?: string;
  loop_id?: string;
  scope?: "session" | "persisted" | "all";
  format?: "summary" | "tree" | "json";
  query?: string;
  status?: string;
  agent?: string;
  from_date?: string;
  to_date?: string;
  group_by?: "hour" | "day" | "agent";
  limit?: number;
  depth?: number;
  include_output?: boolean;
  include_history?: boolean;
  include_budget?: boolean;
  include_loops?: boolean;
  include_progress?: boolean;
  include_artifacts?: boolean;
  include_evidence?: boolean;
  max_chars?: number;
  offset?: number;
  tail?: boolean;
  export_path?: string;
}

export function filterNodes(nodes: readonly GraphNodeView[], args: GraphStatusArgs): GraphNodeView[] {
  const from = args.from_date === undefined ? undefined : Date.parse(args.from_date);
  const to = args.to_date === undefined ? undefined : Date.parse(args.to_date);
  if ((from !== undefined && !Number.isFinite(from)) || (to !== undefined && !Number.isFinite(to))) {
    throw new Error("Invalid date window");
  }
  return nodes.filter((node) =>
    (args.node_id === undefined || node.nodeId === args.node_id) &&
    (args.query === undefined || `${node.nodeId} ${node.agent} ${node.prompt}`.toLowerCase().includes(args.query.toLowerCase())) &&
    (args.status === undefined || node.status === args.status) &&
    (args.agent === undefined || node.agent === args.agent) &&
    (from === undefined || (node.dispatchedAt !== undefined && node.dispatchedAt >= from)) &&
    (to === undefined || (node.settledAt !== undefined && node.settledAt <= to)),
  );
}

function snapshot(graph: GraphView, args: GraphStatusArgs) {
  const run = args.run_id === undefined ? graph.current : graph.runs.find((item) => item.runId === args.run_id);
  if (args.run_id !== undefined && run === undefined) throw new Error(`Unknown run ${args.run_id}`);
  const loop = args.loop_id === undefined ? undefined : graph.declaration.loop_groups?.find((item) => item.id === args.loop_id);
  if (args.loop_id !== undefined && loop === undefined) throw new Error(`Unknown loop ${args.loop_id}`);
  let nodes = filterNodes(run?.nodes ?? graph.nodes, args);
  if (loop !== undefined) nodes = nodes.filter((node) => loop.nodes.includes(node.nodeId));
  if (args.node_id !== undefined && !(run?.nodes ?? graph.nodes).some((node) => node.nodeId === args.node_id)) {
    throw new Error(`Unknown node ${args.node_id}`);
  }
  const limit = args.limit !== undefined && args.limit > 0 ? args.limit : nodes.length;
  nodes = nodes.slice(0, limit);
  const selected = new Set(nodes.map((node) => node.nodeId));
  const attempts = run?.attempts.filter((attempt) => selected.has(attempt.nodeId)).map((attempt) => ({
    ...attempt,
    result: args.include_output || args.include_history || args.include_artifacts || args.include_evidence
      ? attempt.result
      : attempt.result === undefined ? undefined : {
        attemptId: attempt.result.attemptId, acceptedAt: attempt.result.acceptedAt,
      },
  }));
  return {
    graph_id: graph.graphId, plan_revision: graph.planRevision,
    run_id: run?.runId, phase: run?.phase ?? graph.phase, updated_at: run?.updatedAt ?? graph.updatedAt,
    nodes: nodes.map(({ nodeId, ...node }) => ({ node_id: nodeId, ...node })),
    attempts, control: run?.control, stop: run?.stop,
    approvals: run?.approvals ?? [], decisions: run?.decisions ?? [],
    budget: run?.budget, loops: run?.loops ?? [], unsettled_effects: run?.unsettledEffects ?? [],
    runs: args.include_history ? graph.runs : graph.runs.map(({ runId, runSeq, phase }) => ({ runId, runSeq, phase })),
  };
}

function tree(graph: GraphView, args: GraphStatusArgs, view: ReturnType<typeof snapshot>): string {
  const selected = new Map(view.nodes.map((node) => [node.node_id, node]));
  const emitted = new Set<string>();
  const lines: string[] = [];
  const visit = (id: string, depth: number) => {
    const node = selected.get(id);
    if (node === undefined) return;
    if (args.depth === undefined || depth <= args.depth) lines.push(`${"  ".repeat(depth)}${id} [${node.status}]${emitted.has(id) ? " (see above)" : ""}`);
    if (emitted.has(id)) return;
    emitted.add(id);
    for (const edge of graph.declaration.edges.filter((item) => item.from === id)) visit(edge.to, depth + 1);
  };
  for (const node of selected.values()) {
    if (!graph.declaration.edges.some((edge) => edge.to === node.node_id && selected.has(edge.from))) visit(node.node_id, 0);
  }
  for (const id of selected.keys()) if (!emitted.has(id)) visit(id, 0);
  return lines.join("\n");
}

export function renderGraphQuery(query: GraphQueryResult, args: GraphStatusArgs, sessionIds: ReadonlySet<string>): string {
  if (query.blocked !== undefined) throw new Error(`Graph store unreadable: ${query.blocked}`);
  if (args.graph_id !== undefined) {
    const refused = query.refused.find((item) => item.graphId === args.graph_id);
    if (refused !== undefined) throw new Error(`Graph ${refused.graphId} is unreadable: ${refused.reason}`);
  }
  let graphs = query.graphs.filter((graph) => args.scope !== undefined && args.scope !== "session" || sessionIds.has(graph.graphId));
  if (args.graph_id !== undefined) graphs = graphs.filter((graph) => graph.graphId === args.graph_id);
  else if (args.node_id || args.loop_id) {
    graphs = graphs.filter((graph) => args.node_id
      ? graph.nodes.some((node) => node.nodeId === args.node_id)
      : graph.declaration.loop_groups?.some((loop) => loop.id === args.loop_id));
    if (graphs.length > 1) throw new Error("Ambiguous target; provide graph_id");
  }
  if ((args.graph_id || args.node_id || args.loop_id) && graphs.length === 0) {
    if (query.refused.length > 0) throw new Error(`Target unresolved: unreadable graphs ${query.refused.map((item) => item.graphId).join(", ")}`);
    throw new Error("Unknown graph in the selected scope");
  }
  const views = graphs.map((graph) => snapshot(graph, args));
  let text: string;
  if (args.group_by) {
    const groups = new Map<string, number>();
    for (const view of views) for (const node of view.nodes) {
      if (node.status !== "settled" || node.settledAt === undefined) continue;
      const key = args.group_by === "agent" ? node.agent : new Date(node.settledAt).toISOString().slice(0, args.group_by === "day" ? 10 : 13);
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    text = JSON.stringify({ groups: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => ({ key, count })) }, null, 2);
  } else if (args.format === "json") {
    text = JSON.stringify(args.graph_id || args.node_id || args.loop_id ? views[0] : { graphs: views, refused: query.refused }, null, 2);
  } else {
    text = views.map((view, index) => {
      const rows = args.format === "tree" ? tree(graphs[index]!, args, view) : view.nodes.map((node) => `  ${node.node_id} [${node.status}] ${node.agent}`).join("\n");
      return `Graph ${view.graph_id} [phase: ${view.phase}]\n${rows}\n` + JSON.stringify({
        control: view.control, stop: view.stop,
        approvals: view.approvals.length ? view.approvals : undefined,
        unsettled_effects: view.unsettled_effects.length ? view.unsettled_effects : undefined,
        ...(args.include_budget ? { budget: view.budget } : {}),
        ...(args.include_loops || args.include_progress ? { loops: view.loops } : {}),
        ...(args.include_output || args.include_artifacts || args.include_evidence ? { attempts: view.attempts } : {}),
        ...(args.include_history ? { runs: view.runs, decisions: view.decisions } : {}),
      }, null, 2);
    }).join("\n\n");
    if (text.length === 0) text = "No readable graphs in this scope. Call graph_declare to declare one.";
    if (query.refused.length) text += `\nUnreadable graphs: ${query.refused.map((item) => `${item.graphId}: ${item.reason}`).join("; ")}`;
  }
  if (args.export_path !== undefined) {
    mkdirSync(dirname(args.export_path), { recursive: true });
    const temporary = `${args.export_path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
      renameSync(temporary, args.export_path);
    } finally { rmSync(temporary, { force: true }); }
    return `Exported graph query to ${args.export_path}`;
  }
  if (args.max_chars !== undefined && args.max_chars > 0 && args.format !== "json") {
    const start = args.tail ? Math.max(0, text.length - args.max_chars) : Math.max(0, args.offset ?? 0);
    return text.slice(start, start + args.max_chars);
  }
  return text;
}
