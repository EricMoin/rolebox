/**
 * Graph Execution Engine v2 — Imperative `graph_*` Tool Registration
 *
 * Version: 3.0
 * Date: 2026-09-23
 *
 * Wraps the {@link GraphToolSet} tool-logic layer (`graph-tools.ts`) with zod
 * `args` schemas and `defineTool` registrations so the imperative `graph_*`
 * tools become platform-agnostic {@link CanonicalToolDef}s consumable by
 * `buildCanonicalTools`.
 *
 * The shipped surface is the OUTCOME run path's tool face —
 * {@link createOutcomeGraphTools}: `graph_declare` (the v3 authoring ingress),
 * `graph_submit_outcome` (the submission ingress), `graph_audit` (the
 * read-only store inventory) and `graph_status`. The legacy construction and
 * execution entries (`graph_create`, `graph_add_node`, `graph_add_edge`,
 * `graph_add_loop`, `graph_run`, `graph_cancel`, `graph_approve`) and the
 * `createGraphTools` factory that registered them were deleted with the legacy
 * runtime; no factory here can build a legacy engine.
 *
 * This module contains **no graph logic** — it only adapts types and error text.
 */

import { z } from "zod";
import type { CanonicalToolDef } from "../../platform/types.ts";
import { defineTool } from "../../platform/ports/tool-factory.ts";
import { errorText } from "../../utils/error-text.ts";
import {
  type GraphStatusFormat,
  type GraphToolSet,
} from "./graph-tools.ts";
import { NODE_STATUS_VALUES, type NodeStatus } from "../../constants.ts";

/** Render a plain-object tool result as an agent-readable JSON string. */
function json(input: unknown): string {
  return JSON.stringify(input, null, 2);
}

/**
 * Resolve the effective acting agent for a graph tool call.
 *
 * Mirrors the dispatch path's fallback chain (`src/dispatch/tools.ts:70-73`):
 * `context.agent` wins (opencode populates it natively), else the
 * platform-provided resolver (Pi / DSH, where `context.agent` is always empty)
 * supplies the orchestrator's active role, else `""`. This keeps the injected
 * `<system-reminder>` forwarding the orchestrator's real role instead of
 * falling back to `default_agent`.
 */
function resolveEffectiveAgent(
  agent: string | undefined,
  sessionID: string | undefined,
  resolver?: (sessionID?: string) => string,
): string {
  if (agent && agent.length > 0) return agent;
  return resolver?.(sessionID) ?? "";
}

const statusFormatEnum = z.enum(["summary", "tree", "json"]) satisfies z.ZodType<GraphStatusFormat>;

// ── The outcome run path's tool face ────────────────────────────────────────


export function createOutcomeGraphTools(
  toolset: GraphToolSet,
  opts: {
    /**
     * Platform-provided acting-agent resolver (Pi / DSH): `context.agent` wins
     * when populated, else this resolver supplies the orchestrator's role for
     * the injected `<system-reminder>`.
     */
    getEffectiveAgent?: (sessionID?: string) => string;
  } = {},
): Record<string, CanonicalToolDef> {
  return {
    graph_declare: createGraphDeclareTool(toolset, opts.getEffectiveAgent),
    graph_submit_outcome: createGraphSubmitOutcomeTool(toolset),
    graph_audit: createGraphAuditTool(toolset),
    graph_status: createGraphStatusTool(toolset),
    graph_control: createGraphControlTool(toolset, opts.getEffectiveAgent),
  };
}
/**
 * graph_control — THE ONE EXPLICIT CONTROL ENTRY (P3 item 1).
 *
 * A trusted lifecycle command (failure / cancel / timeout, plus the two
 * vocabulary members whose own work packages have not landed) applied to one
 * declared graph's run. The command is an explicit enum argument, never
 * inferred from a payload or a worker field (§3.4), and the PRINCIPAL is the
 * session the platform attributed to this call — the same call context the
 * submission ingress uses — never an argument. Permission, idempotency and
 * every refusal belong to the control application service
 * (`src/graph/control/application.ts`); this wrapper only adapts types and
 * error text.
 */
function createGraphControlTool(
  toolset: GraphToolSet,
  getEffectiveAgent?: (sessionID?: string) => string,
): CanonicalToolDef {
  return defineTool({
    description:
      "Apply one TRUSTED lifecycle control command to a declared graph's run: " +
      "'failure' (the host reports one node's in-flight execution ended without " +
      "reaching its authorized outcome), 'timeout' (it exceeded its time), or " +
      "'cancel' (stop the run and record the cancel intent for every attempt still in " +
      "flight). A control command is NOT an outcome: it never writes an accepted result, " +
      "it never starts a successor, and a worker's submission can never issue one. The " +
      "command is durable: the decision is recorded on the attempt and the first command " +
      "recorded for the run is the one that stopped it, so a repeated command replays and " +
      "a competing command is refused rather than applied. Only the session that DECLARED " +
      "the graph may control it; a dispatched worker is refused before this body runs. " +
      "The answer names every still-unsettled effect and every execution the host has not " +
      "confirmed, so a stopped graph never hides an external task. 'retry' and " +
      "'budget-stop' are part of the declared vocabulary but their semantics are not " +
      "implemented in this build and are refused by name.",
    args: {
      graph_id: z.string().min(1).describe("The declared graph whose run is controlled."),
      command: z
        .enum(["failure", "cancel", "timeout", "retry", "budget-stop"])
        .describe(
          "The control command. 'failure', 'timeout' and 'cancel' are applied and " +
            "recorded durably; 'retry' and 'budget-stop' are refused by name until their " +
            "own semantics exist. No command is ever inferred from worker data.",
        ),
      node_id: z
        .string()
        .min(1)
        .optional()
        .describe(
          "The node the command names: REQUIRED for 'failure'/'timeout' (they name one " +
            "attempt) and refused for 'cancel' (which applies to the whole run).",
        ),
      attempt_id: z
        .string()
        .min(1)
        .optional()
        .describe(
          "The in-flight attempt the command names. Optional: the run's current attempt " +
            "for the node is used when omitted, and a value that is not the current " +
            "attempt is refused rather than re-attached.",
        ),
      reason: z
        .string()
        .min(1)
        .describe(
          "Why the command is applied. Stored verbatim on the durable decision and " +
            "reported by every later refusal, so it is the human-readable half of the fact.",
        ),
    },
    async execute(args, context) {
      try {
        return json(
          toolset.graph_control(
            args,
            context?.sessionID,
            resolveEffectiveAgent(context?.agent, context?.sessionID, getEffectiveAgent),
          ),
        );
      } catch (err) {
        return `graph_control failed: ${errorText(err)}`;
      }
    },
  });
}

/** graph_declare — author a v3 (outcome-protocol) graph and persist its plan. */
function createGraphDeclareTool(
  toolset: GraphToolSet,
  getEffectiveAgent?: (sessionID?: string) => string,
): CanonicalToolDef {
  return defineTool({
    description:
      "Declare a graph from a full v3 declaration (JSON text or an already-parsed " +
      "value): parse, compile, and persist the compiled plan with its contract " +
      "binding and the outcome-protocol identity. The graph runs under the OUTCOME " +
      "protocol — its declared entry nodes are dispatched from the compiled plan and " +
      "its outcomes are accepted through the graph-scoped outcome submission, which " +
      "commits the graph state with the acceptance — the outcome submission is its " +
      "ONLY completion source, and the graph never falls back to signal semantics. " +
      "A declaration that compiles only as a DRAFT " +
      "(acceptance requirements with no resolved validator capability) is refused " +
      "with every unresolved entry named and nothing is persisted; pass " +
      "supported_validators to resolve them. Unknown keys, wrong types and bad loop " +
      "limits are refused with stable codes and the failing path. Re-declaring an " +
      "existing id preserves an unchanged plan and refuses a changed one — a " +
      "persisted plan is never overwritten silently.",
    args: {
      declaration: z
        .json()
        .describe(
          "The v3 declaration as JSON text or an already-parsed JSON value: " +
            "{ version: 3, name, nodes[], edges[], loop_groups?[] } with the closed " +
            "v3 grammar (nodes declare outcomes; every edge binds one).",
        ),
      graph_id: z
        .string()
        .optional()
        .describe(
          "Optional graph id. The v3 grammar carries no separate identifier, so it " +
            "must equal the declaration's name; a mismatch is refused.",
        ),
      supported_validators: z
        .array(
          z.object({
            validator: z.string().min(1),
            version: z.number().int().positive().optional(),
          }),
        )
        .optional()
        .describe(
          "The validator capabilities this caller declares installed, used to " +
            "resolve every acceptance requirement at an EXACT version. Omitted, " +
            "acceptance requirements stay unresolved, compilation answers a " +
            "non-executable DRAFT and graph_declare refuses it.",
        ),
    },
    async execute(args, context) {
      try {
        return json(
          toolset.graph_declare(
            args,
            context?.sessionID,
            resolveEffectiveAgent(context?.agent, context?.sessionID, getEffectiveAgent),
          ),
        );
      } catch (err) {
        return `graph_declare failed: ${errorText(err)}`;
      }
    },
  });
}

/**
 * graph_submit_outcome — the outcome-protocol submission ingress (C3c).
 *
 * The model-facing `submit_outcome` capability: a worker claims one declared
 * outcome on one node of a DECLARED (protocol 2) graph and the outcome runtime
 * derives the execution identity, judges the plan's pinned gates and commits
 * the decision atomically with the graph state. The args are the minimum a
 * worker may supply — attempt id, submission id and plan revision are not
 * accepted and cannot be supplied — plus the attempt credential it was handed
 * in its dispatch request, which the runtime resolves against the persisted
 * binding instead of trusting the node id.
 */
function createGraphSubmitOutcomeTool(toolset: GraphToolSet): CanonicalToolDef {
  return defineTool({
    description:
      "Submit a worker's claimed outcome for one node of a DECLARED " +
      "(outcome-protocol) graph declared with graph_declare. This is the ONLY " +
      "completion source for such a graph: the outcome runtime resolves the node's " +
      "contract from the graph's SAVED compiled plan, derives the execution " +
      "identity (graph, attempt, submission) from its own state and the proposal " +
      "digest, runs every acceptance requirement the plan pins, and commits the " +
      "decision together with the graph state. Supply graph_id, node_id, " +
      "outcome_id, the attempt credential your dispatch request carried, and — " +
      "only if the outcome declares them — data and evidence_refs. The " +
      "credential names the one attempt this submission may settle: the runtime " +
      "refuses a missing, unknown, tampered or other node's credential instead " +
      "of falling back to the node's current attempt. Attempt/submission " +
      "identity and the plan revision are runtime provenance and are not " +
      "accepted here. A refusal returns structured " +
      "repair diagnostics (refusals) and writes nothing; a rejection returns the " +
      "per-requirement outcomes that failed and leaves the attempt open. A record " +
      "that is not this build's declared outcome-protocol state is refused by name.",
    args: {
      graph_id: z
        .string()
        .min(1)
        .describe("The declared (outcome-protocol) graph to submit to."),
      node_id: z
        .string()
        .min(1)
        .describe("The plan node whose outcome is claimed."),
      outcome_id: z
        .string()
        .min(1)
        .describe("The outcome id that node declares in the compiled plan."),
      credential: z
        .string()
        .min(1)
        .optional()
        .describe(
          "The attempt credential the outcome runtime issued to you in your " +
            "dispatch request for this node's in-flight attempt. Pass back exactly " +
            "the value that request carried: it is a bearer capability bound to " +
            "one attempt, it is never derived from the node id, and a missing, " +
            "unknown, tampered or other node's credential is refused rather than " +
            "re-bound to the node's current attempt.",
        ),
      data: z
        .json()
        .optional()
        .describe(
          "Optional outcome payload (any JSON value). The outcome's own gates " +
            "decide what it must contain; it is digested into the submission id.",
        ),
      evidence_refs: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Optional artifact references the outcome's acceptance gates validate, " +
            "each resolving inside the workspace artifact root.",
        ),
    },
    async execute(args, context) {
      try {
        return json(await toolset.graph_submit_outcome(args, context?.sessionID));
      } catch (err) {
        return `graph_submit_outcome failed: ${errorText(err)}`;
      }
    },
  });
}

/**
 * graph_audit — the READ-ONLY drain / migration inventory (E stage entry).
 *
 * The tool takes no arguments and returns the structured
 * {@link DrainAuditReport} as JSON: every persisted graph with its
 * `executionProtocolVersion`, whether it is terminal or still in flight, the
 * work it still owes (unsettled nodes and ledger effects), and — as explicit
 * BLOCKERS — every record that cannot be read or whose version is unknown. The
 * audit opens the acceptance ledger read-only, never creates a store, and
 * writes nothing; a store with no non-terminal graph but one unreadable record
 * is reported `blocked`, not `drained`.
 */
function createGraphAuditTool(toolset: GraphToolSet): CanonicalToolDef {
  return defineTool({
    description:
      "Read-only drain/migration audit of the persisted graph store. Reports every " +
      "graph with its executionProtocolVersion, whether it is TERMINAL (quiescent) or " +
      "still IN FLIGHT, the work it still owes (nodes in flight, effects still " +
      "pending/started), and — as explicit BLOCKERS — every record that cannot be read " +
      "or whose version is unknown, plus any accepted-but-unsettled effect. The verdict " +
      "is 'drained' ONLY when there is no blocker AND nothing in flight: a store with " +
      "zero non-terminal graphs but one unreadable record is 'blocked', and one " +
      "unsettled effect is 'in-flight'. Strictly read-only: no graph, state, ledger or " +
      "file is written, and the acceptance ledger is opened read-only (never created or " +
      "initialized).",
    args: {},
    async execute() {
      try {
        return json(await toolset.graph_audit());
      } catch (err) {
        return `graph_audit failed: ${errorText(err)}`;
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
          "Scope of the query. 'session' (default) reads the declared graphs this " +
            "process holds. 'persisted' reads graphs hydrated from the on-disk " +
            "engine-state store (a cross-session view). 'all' merges declared + " +
            "persisted (a declared graph wins on a graphId collision). With " +
            "persisted/all, the no-target list shows persisted graphs and " +
            "query/status/agent/from_date/to_date, group_by, and " +
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
      include_liveness: z
        .boolean()
        .optional()
        .describe(
          "Include each node's recorded liveness state from " +
            "NodeRuntimeState.liveness (lastActivityAt / heartbeatSource / " +
            "stallStatus / stallWarnedAt / stallReason). OPTIONAL-ADDITIVE — " +
            "only nodes WITH recorded liveness get the block; absent liveness " +
            "renders nothing, never fabricated. Running nodes always render " +
            "liveness regardless of this flag.",
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
        return `graph_status failed: ${errorText(err)}`;
      }
    },
  });
}

// Re-export the toolset factory + type so host assembly layers construct the one
// instance the outcome tool face is bound to.
export { createGraphToolSet, type GraphToolSet } from "./graph-tools.ts";
