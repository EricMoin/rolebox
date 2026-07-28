/**
 * Graph Execution Engine v2 — Imperative `graph_*` Tool Registration
 *
 * Version: 2.0
 * Date: 2026-07-25
 *
 * Phase 4, Subtask 6. Wraps the {@link GraphToolSet} tool-logic layer (subtask
 * 5, `graph-tools.ts`) with zod `args` schemas and `defineTool` registrations
 * so the eight imperative `graph_*` tools become platform-agnostic
 * {@link CanonicalToolDef}s consumable by `buildCanonicalTools`.
 *
 * The arg schemas mirror `.rolebox/design/tool-merge-map.md` §2.2, adapted to
 * the real TypeScript arg shapes exported by `graph-tools.ts` (which are
 * documented as divergences in that module's header — e.g. `join` is the
 * structured `JoinConfig`, edge `retry` accepts `number | RetryConfig`). This
 * module contains **no graph logic** — it only adapts types and error text.
 *
 * ## Precedence contract
 *
 * This factory is additive. Its keys are the `graph_*` namespace, which does
 * not collide with any existing `dispatch_*` / `loop_*` tool key. Registration
 * therefore never overrides a legacy tool. In `tool-assembly.ts` the graph
 * tools are merged with the same additive pattern as `extraTools` /
 * `loopToolsOverride` (Object.assign onto the assembled map).
 *
 * Design reference: `.rolebox/design/tool-merge-map.md` §2.2, §3, §4 (Phase A).
 */

import { z } from "zod";
import type { CanonicalToolDef } from "../../platform/types.ts";
import { defineTool } from "../../platform/ports/tool-factory.ts";
import type { DispatchManager } from "../../dispatch/core/manager.ts";
import {
  createGraphToolSet,
  type GraphToolSet,
  type GraphStatusFormat,
  type GraphNotifySource,
} from "./graph-tools.ts";
import { createGraphApproveTool } from "./approve-tools.ts";
import {
  JOIN_STRATEGY_VALUES,
  NODE_STATUS_VALUES,
  type NodeStatus,
} from "../../constants.ts";

// ── Reusable zod schema fragments ────────────────────────────────────────────

/** Graph-level budget spec (tool-merge-map.md §2.2 `GraphBudget`). */
const graphBudgetSchema = z
  .object({
    max_total_sessions: z.number().optional(),
    max_total_input_tokens: z.number().optional(),
    max_total_output_tokens: z.number().optional(),
    max_total_cost_usd: z.number().optional(),
  })
  .optional();

/** Per-node budget spec (tool-merge-map.md §2.2 `NodeBudget` + timeout/retry). */
const nodeBudgetSchema = z
  .object({
    max_sessions: z.number().optional(),
    max_input_tokens: z.number().optional(),
    max_output_tokens: z.number().optional(),
    max_cost_usd: z.number().optional(),
    timeout_ms: z.number().optional(),
    max_retries: z.number().optional(),
  })
  .optional();

/** Join/fan-in config — structured form (matches `JoinConfig`, divergence 1). */
const joinSchema = z
  .object({
    strategy: z.enum(JOIN_STRATEGY_VALUES),
    quorum: z.number().optional(),
  })
  .optional();

/** Edge retry policy — bare number coerced to `{ max }` (divergence 3). */
const retrySchema = z
  .union([
    z.number(),
    z.object({
      max: z.number(),
      backoff_ms: z.number().optional(),
    }),
  ])
  .optional();

/** Termination condition variants (TerminationCondition union). */
const termConditionSchema = z.union([
  z.object({ max_iterations: z.number() }),
  z.object({ timeout_ms: z.number() }),
  z.object({ converged: z.string() }),
  z.object({
    result_matches: z.object({
      agent: z.string(),
      contains: z.string().optional(),
      regex: z.string().optional(),
      score_gte: z.number().optional(),
      no_changes: z.boolean().optional(),
    }),
  }),
  z.object({ stuck: z.object({ repeats: z.number() }) }),
  z.object({ budget_exhausted: z.literal(true) }),
  z.object({ signal: z.string() }),
]);

/** Termination config for a loop group (any_of / all_of). */
const terminationSchema = z
  .object({
    any_of: z.array(termConditionSchema).optional(),
    all_of: z.array(termConditionSchema).optional(),
  })
  .optional();

const statusFormatEnum = z.enum(["summary", "tree", "json"]) satisfies z.ZodType<GraphStatusFormat>;

// ── createGraphTools ────────────────────────────────────────────────────────

/**
 * Build the eight imperative `graph_*` tools bound to a dispatch manager and
 * a single in-memory graph registry (one shared `GraphToolSet` instance).
 *
 * @param manager - Active {@link DispatchManager}; required for non dry-run
 *                  execution. Optional for construction/status/cancel/dry-run.
 * @param opts.directory - Working directory for graph node dispatches.
 * @param opts.stateDir - Optional engine-state persistence dir.
 * @param opts.graphNotify - Optional graph node-completion + graph-terminal
 *        notifier (subtask 3): a prebuilt `GraphCompletionHandler` or an owner
 *        config carrying the emperor session + session client. Threaded into
 *        every engine the toolset constructs so graph node completions AND
 *        graph-terminal transitions route to graph-notify targeting the emperor
 *        session. More here in src/graph/tools/graph-tools.ts.
 * @returns A record of `graph_*` key → {@link CanonicalToolDef}.
 */
export function createGraphTools(
  manager: DispatchManager | undefined,
  opts: {
    directory?: string;
    stateDir?: string;
    graphNotify?: GraphNotifySource;
  } = {},
): Record<string, CanonicalToolDef> {
  const toolset: GraphToolSet = createGraphToolSet({
    manager,
    directory: opts.directory,
    stateDir: opts.stateDir,
    graphNotify: opts.graphNotify,
  });

  return {
    graph_create: createGraphCreateTool(toolset),
    graph_add_node: createGraphAddNodeTool(toolset),
    graph_add_edge: createGraphAddEdgeTool(toolset),
    graph_add_loop: createGraphAddLoopTool(toolset),
    graph_run: createGraphRunTool(toolset),
    graph_status: createGraphStatusTool(toolset),
    graph_cancel: createGraphCancelTool(toolset),
    graph_approve: createGraphApproveTool(toolset),
  };
}

// Re-export the graph-notify config types (subtask 3) for platform assembly
// layers (tool-assembly.ts) that thread the emperor session + session client
// down into the engine's completion and graph-terminal seams.
export type {
  GraphNotifySource,
  GraphNotifyConfig,
} from "./graph-tools.ts";

// ── Individual tool factories ───────────────────────────────────────────────

/** Render a plain-object tool result as an agent-readable JSON string. */
function json(input: unknown): string {
  return JSON.stringify(input, null, 2);
}

/** graph_create — open a graph registry slot. */
function createGraphCreateTool(
  toolset: GraphToolSet,
): CanonicalToolDef {
  return defineTool({
    description:
      "Create a new graph / orchestration context. Returns a graph_id used " +
      "by all subsequent graph_add_node / graph_add_edge / graph_add_loop / " +
      "graph_run / graph_status / graph_cancel calls.",
    args: {
      name: z.string().min(1).describe("Human-readable graph name for logging."),
      budget: graphBudgetSchema.describe("Graph-level resource limits."),
    },
    async execute(args) {
      try {
        return json(toolset.graph_create(args));
      } catch (err) {
        return `graph_create failed: ${(err as Error).message}`;
      }
    },
  });
}

/** graph_add_node — dynamically add a node to the graph. */
function createGraphAddNodeTool(
  toolset: GraphToolSet,
): CanonicalToolDef {
  return defineTool({
    description:
      "Add a node to the graph. Nodes are role-agnostic {agent, prompt} " +
      "tuples. Structural validation runs atomically — an invalid node is " +
      "rejected without mutating the graph.",
    args: {
      graph_id: z.string().describe("Graph to add the node to."),
      id: z.string().describe("Unique node identifier within this graph."),
      agent: z.string().describe("Agent identifier to dispatch (e.g. a subagent full id)."),
      prompt: z.string().describe("The prompt this agent executes."),
      completion_condition: z
        .string()
        .optional()
        .describe("Named condition that auto-completes the node."),
      needs_approval: z
        .boolean()
        .optional()
        .describe("If true, the engine pauses at this node for human approval."),
      join: joinSchema.describe("Fan-in convergence strategy."),
      budget: nodeBudgetSchema.describe("Per-node resource limits."),
      timeout_ms: z
        .number()
        .optional()
        .describe("Wall-clock timeout for this node (ms)."),
      max_retries: z
        .number()
        .optional()
        .describe("Auto-retry count on escalate."),
    },
    async execute(args) {
      try {
        return json(toolset.graph_add_node(args));
      } catch (err) {
        return `graph_add_node failed: ${(err as Error).message}`;
      }
    },
  });
}

/** graph_add_edge — add a directed edge between two nodes. */
function createGraphAddEdgeTool(
  toolset: GraphToolSet,
): CanonicalToolDef {
  return defineTool({
    description:
      "Add a directed edge between two nodes. Edges define data flow and " +
      "signal routing. type 'on_signal' requires signal_filter; type " +
      "'on_condition' requires condition.",
    args: {
      graph_id: z.string().describe("Graph to add the edge to."),
      from: z.string().describe("Source node ID."),
      to: z.string().describe("Target node ID."),
      type: z
        .enum(["always", "on_signal", "on_condition"])
        .optional()
        .describe("Edge activation rule."),
      signal_filter: z
        .array(z.string())
        .optional()
        .describe("Signal types that activate this edge (required when type=on_signal)."),
      condition: z
        .string()
        .optional()
        .describe("Named condition that must evaluate true (required when type=on_condition)."),
      data_passthrough_include: z
        .array(z.string())
        .optional()
        .describe("Whitelist of payload fields to pass downstream."),
      data_passthrough_exclude: z
        .array(z.string())
        .optional()
        .describe("Blacklist of payload fields to omit (accepted for shape compat)."),
      data_passthrough_max_chars: z
        .number()
        .optional()
        .describe("Truncation limit for passed context (accepted for shape compat)."),
      retry: retrySchema.describe("Auto-retry count when the source node emits escalate."),
    },
    async execute(args) {
      try {
        return json(toolset.graph_add_edge(args));
      } catch (err) {
        return `graph_add_edge failed: ${(err as Error).message}`;
      }
    },
  });
}

/** graph_add_loop — declare a bounded-cycle loop group. */
function createGraphAddLoopTool(
  toolset: GraphToolSet,
): CanonicalToolDef {
  return defineTool({
    description:
      "Declare a loop group — a set of nodes that form a bounded cycle — " +
      "with a hard traversal cap and optional soft termination conditions. " +
      "Optional 'mode' selects the loop rounds' session-isolation flavor: " +
      "'inherit' (real) records that rounds re-dispatch within the SAME " +
      "engine state; 'fresh' (per-round session isolation) is not supported " +
      "and returns an explicit error — use a separate graph per round for " +
      "session isolation. Omitting mode keeps default behavior.",
    args: {
      graph_id: z.string().describe("Graph to add the loop group to."),
      id: z.string().describe("Unique loop group identifier."),
      nodes: z
        .array(z.string())
        .min(1)
        .describe("Node IDs forming the cycle."),
      max_traversals: z
        .number()
        .int()
        .min(1)
        .describe("Hard cap — loop exits after this many traversals."),
      termination: terminationSchema.describe("Soft termination conditions for early exit."),
      mode: z
        .enum(["inherit", "fresh"])
        .optional()
        .describe(
          "Session-isolation mode for loop rounds. 'inherit' (real) records that " +
            "rounds re-dispatch within the same engine state. 'fresh' is " +
            "documented-unsupported — returns an explicit error naming the " +
            "alternative path (a separate graph per round). Omit for default.",
        ),
    },
    async execute(args) {
      try {
        return json(toolset.graph_add_loop(args));
      } catch (err) {
        return `graph_add_loop failed: ${(err as Error).message}`;
      }
    },
  });
}

/** graph_run — execute (or dry-run validate) a constructed graph. */
function createGraphRunTool(
  toolset: GraphToolSet,
): CanonicalToolDef {
  return defineTool({
    description:
      "Non-blocking — dispatches ready root nodes and returns immediately " +
      "with phase, active_nodes, and pending_nodes. End your turn after graph_run; the " +
      "engine emits a [GRAPH COMPLETE] system-reminder when all nodes " +
      "finish, or [GRAPH BLOCKED] when a node awaits approval. On the " +
      "next turn, read results once via graph_status(graph_id, " +
      "include_output=true). Poll graph_status only as a fallback when " +
      "no reminder arrives. With dry_run=true, validates structure " +
      "without executing.",
    args: {
      graph_id: z.string().describe("Graph to execute."),
      node_id: z
        .string()
        .optional()
        .describe("If specified, re-run a specific node."),
      retry: z
        .boolean()
        .optional()
        .describe("When true with node_id, retry that node."),
      modify_prompt: z
        .string()
        .optional()
        .describe("When retrying, optionally modify the node's prompt."),
      dry_run: z
        .boolean()
        .optional()
        .describe("Validate the graph structure without executing."),
    },
    async execute(args, context) {
      try {
        // Subtask 3: forward the invoking session id (the orchestrator/emperor
        // session running graph_run) so the graph-notify completion seam targets
        // the correct emperor session at runtime.
        return json(await toolset.graph_run(args, context?.sessionID));
      } catch (err) {
        return `graph_run failed: ${(err as Error).message}`;
      }
    },
  });
}

/** graph_status — query node, loop, or graph state. */
function createGraphStatusTool(
  toolset: GraphToolSet,
): CanonicalToolDef {
  return defineTool({
    description:
      "Unified observability endpoint — query node, loop, or graph state. " +
      "With no target, lists all graphs. format=tree renders the node " +
      "dependency tree; format=json returns a machine-readable snapshot.",
    args: {
      graph_id: z
        .string()
        .optional()
        .describe("Graph to query (inferred from node_id/loop_id if omitted)."),
      node_id: z.string().optional().describe("Query a specific node's runtime state."),
      loop_id: z.string().optional().describe("Query a loop group's state."),
      scope: z
        .enum(["session", "persisted", "all"])
        .optional()
        .describe(
          "Session-scope of the query. 'session' (default) reads only the in-memory " +
            "registry. 'persisted' reads graphs hydrated from the on-disk engine-state " +
            "store (a cross-session view). 'all' merges registry + persisted (registry " +
            "wins on a graphId collision). With persisted/all, the no-target list shows " +
            "persisted graphs and query/status/agent/from_date/to_date, group_by, and " +
            "include_budget aggregate across sessions. An empty store yields an explicit " +
            "honest-empty note — never fabricated rows.",
        ),
      format: statusFormatEnum
        .optional()
        .describe("Output format: summary (table), tree, or json."),
      query: z
        .string()
        .optional()
        .describe(
          "Filter nodes by case-insensitive substring match on nodeId / prompt / agent.",
        ),
      status: z
        .enum(NODE_STATUS_VALUES as [NodeStatus, ...NodeStatus[]])
        .optional()
        .describe("Filter nodes by exact lifecycle status (pending/ready/running/completed/blocked/timeout/escalate/cancelled/done)."),
      agent: z.string().optional().describe("Filter nodes by exact agent match."),
      from_date: z
        .string()
        .optional()
        .describe("ISO-8601 lower bound — include nodes with startedAt >= from_date."),
      to_date: z
        .string()
        .optional()
        .describe("ISO-8601 upper bound — include completed nodes with completedAt <= to_date."),
      group_by: z
        .enum(["hour", "day", "agent"])
        .optional()
        .describe(
          "Aggregate COMPLETED nodes into buckets by hour / day / agent over their " +
            "completedAt timestamp, returning the bucket list with counts (uncompleted " +
            "nodes are excluded honestly). A distinct view mode — takes precedence over " +
            "the row render.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Cap the number of node rows emitted in summary and json renders. Unset " +
            "leaves the output unbounded (byte-identical to legacy behavior).",
        ),
      depth: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Prune the tree render at N levels (0 = roots only). Unset = full depth " +
            "(byte-identical to legacy tree output).",
        ),
      include_output: z
        .boolean()
        .optional()
        .describe("Include materialized node result in response."),
      include_progress: z
        .boolean()
        .optional()
        .describe(
          "Include a node's latest progress signal payload, sourced from the " +
          "engine signal ledger / signalsObserved progress entry (the latest " +
          "payload per node, not a timestamped history).",
        ),
      include_budget: z
        .boolean()
        .optional()
        .describe("Include budget consumption breakdown."),
      include_metrics: z
        .boolean()
        .optional()
        .describe(
          "Include graph-engine runtime metrics. When paired with export_path, " +
            "writes a metrics JSON snapshot instead of rendering.",
        ),
      include_loops: z
        .boolean()
        .optional()
        .describe("Include all loop groups for this graph."),
      include_concurrency: z
        .boolean()
        .optional()
        .describe(
          "When set, render live dispatch-manager concurrency slot status (the " +
            "dispatch_concurrency merge) from manager.getConcurrencyStatus() — " +
            "per-key breakdown + global summary. When no dispatch manager is bound, " +
            "returns an explicit documented-unavailable note — never fabricated slot data.",
        ),
      include_checkpoint: z
        .boolean()
        .optional()
        .describe(
          "Include the node's recorded lifecycle checkpoint snapshot(s) from " +
            "EngineState.checkpoints[nodeId]. Absent until a checkpoint is recorded; " +
            "when none exist, an explicit 'no checkpoint recorded' note is shown.",
        ),
      include_artifacts: z
        .boolean()
        .optional()
        .describe(
          "Include the node's recorded artifact file paths from " +
            "NodeRuntimeState.artifacts[]. Nodes with no artifacts are omitted " +
            "honestly; a run with none yields an explicit 'no artifacts / evidence " +
            "recorded' note.",
        ),
      include_evidence: z
        .boolean()
        .optional()
        .describe(
          "Include the node's recorded evidence references from " +
            "NodeRuntimeState.evidence[]. Honest-empty like include_artifacts.",
        ),
      include_history: z
        .boolean()
        .optional()
        .describe(
          "Include each loop group's ordered round history from " +
            "LoopGroupRuntimeState.rounds[]. Absent rounds yield an explicit 'no " +
            "loop rounds recorded' note — never invented rows.",
        ),
      round: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Filter round history to a single 1-based round index within a loop " +
            "group (paired with include_history or alone). A round that was not " +
            "recorded yields an explicit 'round N: not recorded' note.",
        ),
      stream: z
        .boolean()
        .optional()
        .describe(
          "Surface the timestamped per-node signal-event history from " +
            "SignalLedgerEntry.history ({signal, payload, atMs}). An empty history " +
            "yields an explicit 'no events recorded' note — never fabricated rows.",
        ),
      since: z
        .string()
        .optional()
        .describe(
          "ISO-8601 lower bound — when stream (or alone) is set, include only " +
            "signal events at or after this timestamp. Events before since are " +
            "filtered out; if none remain, an explicit 'no events since <ts>' note.",
        ),
      max_chars: z
        .number()
        .optional()
        .describe("Output truncation limit."),
      offset: z
        .number()
        .optional()
        .describe("Pagination offset."),
      tail: z
        .boolean()
        .optional()
        .describe("Return the last max_chars characters of output."),
      export_path: z
        .string()
        .optional()
        .describe(
          "Atomically write an export to this path and return a confirmation " +
            "instead of a status render. Mode-dependent: a node_id writes that " +
            "node's materialized result text, include_metrics writes a metrics " +
            "JSON snapshot, and neither writes the owning graph's declaration " +
            "to YAML.",
        ),
    },
    async execute(args) {
      try {
        return toolset.graph_status(args);
      } catch (err) {
        return `graph_status failed: ${(err as Error).message}`;
      }
    },
  });
}

/** graph_cancel — cancel a graph, node, or loop group. */
function createGraphCancelTool(
  toolset: GraphToolSet,
): CanonicalToolDef {
  return defineTool({
    description:
      "Cancel a graph, node, or loop group. With neither node_id nor " +
      "loop_id, the entire graph is cancelled. A node_id or loop_id cancels " +
      "only the scoped target (loop targets resolve to their full member set); " +
      "when cascade is true, the cancellation propagates to every node " +
      "transitively downstream of the target (forward closure over edges). " +
      "Returns the ACTUAL cancelled node ids from the engine, not a guess. " +
      "Note (semantics, Q3 Option A): this is a human-gated control — graph_cancel " +
      "is intended for human monitoring and intervention, not for agent-driven " +
      "self-cancellation of a running workflow.",
    args: {
      graph_id: z.string().describe("Graph containing the target."),
      node_id: z
        .string()
        .optional()
        .describe("Cancel a specific node."),
      loop_id: z
        .string()
        .optional()
        .describe("Cancel a loop group (resolved to its member node set)."),
      cascade: z
        .boolean()
        .optional()
        .describe(
          "When true, also cancel every node transitively downstream of the " +
            "target (forward closure over graph edges). Default: true for a loop " +
            "target, false for a bare node_id. Ignored for whole-graph cancel.",
        ),
    },
    async execute(args) {
      try {
        return json(await toolset.graph_cancel(args));
      } catch (err) {
        return `graph_cancel failed: ${(err as Error).message}`;
      }
    },
  });
}
