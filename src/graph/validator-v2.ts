/**
 * Graph Model v2 — Structural Validator
 *
 * Phase 1, Subtask 2 (parsing & validation).
 *
 * Validates the STRUCTURE of a graph document only. By design there are no
 * node-type checks: the v2 model is role-agnostic (a node is {id, agent,
 * prompt}), so validation here never inspects agent/prompt semantics. It also
 * never checks whether an `agent` is a known dispatchable identifier — that is
 * an environment/binding concern, out of scope for structural validation.
 *
 * Checks (each produces an independent, human-readable message):
 *   1. `version` present and equal to 2
 *   2. node-id uniqueness
 *   3. edge endpoint validity (from/to must reference declared nodes)
 *   4. cycle containment (Tarjan SCC-based — see below)
 *   5. loop-group node references must be declared nodes (+ loop-group id
 *      uniqueness, symmetric to node-id uniqueness)
 *   6. `needs_approval` nodes may only have non-`always` outgoing edges
 *   7. `data_passthrough` shape (non-negative `max_chars`)
 *   8. loop-group root check — ERROR when, after excluding revise
 *      back-edges, no node has in-degree zero AND at least one loop
 *      group exists (pure-cycle deadlock). WARNING when no roots exist
 *      but no loop groups are declared. Additionally flags loop groups
 *      whose member nodes have no incoming edges from outside the group.
 *   9. `join.quorum` bounds for quorum-strategy nodes — quorum must be a
 *      positive integer, and must not exceed the node's in-degree (the
 *      join would be unsatisfiable). The upper-bound check is deferred
 *      while a node has no incoming edges yet (incremental construction).
 *  10. per-node `budget.timeout_ms` / `budget.max_retries` bounds —
 *      mirroring the `data_passthrough.max_chars` pattern (see rule 7):
 *      negative `timeout_ms` and non-nonnegative-integer `max_retries`
 *      are rejected. `timeout_ms: 0` is VALID (documented opt-out).
 *  11. `on_condition` edges must name a condition from the registered
 *      condition vocabulary (the same `KNOWN_CONDITIONS` source
 *      `asset_validate` uses) — an unknown name or a missing/empty
 *      `condition` is rejected, so a never-satisfiable edge cannot
 *      silently deadlock the graph at run.
 *
 * ## Cycle-containment semantics (check 4)
 *
 * The v2 model holds "the graph is a DAG at rest; cycles exist only inside
 * explicitly declared loop groups" (graph-model.md §4). We validate both
 * directions of that contract:
 *
 *   (a) ERROR — every declared loop group must actually induce a directed
 *       cycle over its declared nodes (via Tarjan on the induced subgraph).
 *       Declaring a "loop" over an acyclic node set is a structural error.
 *
 *   (b) WARNING/ERROR (mode-split) — every directed cycle in the full graph
 *       (a Tarjan SCC with >1 node or a self-loop) must be covered by at
 *       least one loop group. Each uncovered cyclic SCC is reported
 *       independently (see the mode split below).
 *
 * ### Direction (b) severity split by mode
 *
 * `validateGraphDeclaration` takes an optional `mode`:
 *   - `"construct"` (default) — incremental building. An uncovered cycle is
 *     a WARNING: the builder may add the cycle-closing edge first and declare
 *     the loop group afterward, so neither edge-first nor loop-first ordering
 *     may fail. Fully backward-compatible for existing callers.
 *   - `"execution"` — the graph is about to run. An uncovered cycle that
 *     contains a revise back-edge (an `on_signal` edge with
 *     `signal_filter: [revise_needed]`) stays a WARNING: that is exactly the
 *     canonical dag-yaml-schema.md Appendix B pattern, where a revise
 *     back-edge pulls a node (e.g. `final-gate`) into a loop group's SCC
 *     without declaring it in any loop group. Failing that document as an
 *     ERROR would contradict the documented canonical graph; surfacing it as
 *     a warning preserves the diagnostic while keeping the canonical graph
 *     valid. An uncovered cycle with NO revise back-edge (pure `always`-edge
 *     cycles, self-loops, non-revise signal/condition cycles) is promoted to
 *     an ERROR: no edge within the SCC can ever be excluded from root
 *     discovery (`checkLoopGroupRoots`), so the cycle can never activate and
 *     the graph deadlocks at runtime.
 *
 * Reuses the Tarjan SCC approach from ./loop-detector.ts (which operates on v1
 * FlowEdge) by way of a self-contained v2 EdgeDeclaration adaptation.
 *
 * Design reference: .rolebox/design/dag-yaml-schema.md §5, graph-model.md §4.
 */

import type { EdgeDeclaration } from "../types.graph-v2.ts";
import type { GraphDocument } from "./parser-v2.ts";
import { KNOWN_CONDITIONS } from "../function/conditions.ts";

/**
 * Matches a `name(arg)` condition call — mirrors `CALL_RE` in
 * engine/condition-resolver.ts:60 (the resolver's own extraction is the source
 * of truth; this inline copy avoids a layering violation — validators live
 * above the engine module).
 */
const CALL_RE = /^([a-z][a-z0-9_]*)\(([^)]*)\)$/;

/** Result of structural validation — errors are fatal, warnings are not. */
export interface GraphValidationResult {
  /** `false` when at least one fatal structural error was found. */
  valid: boolean;
  /** Fatal structural errors (each describes exactly one failing rule). */
  errors: string[];
  /** Non-fatal diagnostics (e.g. an uncovered cycle). */
  warnings: string[];
}

/**
 * Validate the structure of a graph document. Never throws.
 *
 * @param graph - a parsed graph document (see parser-v2.ts `parseGraph`).
 * @param opts - optional validation context.
 * @param opts.mode - severity context: `"construct"` (default) treats
 *   uncovered cycles as warnings so incremental building (add the
 *   cycle-closing edge, then declare the loop group) keeps working;
 *   `"execution"` promotes uncovered cycles with no revise back-edge to
 *   errors, since such a cycle can never activate and deadlocks at runtime.
 * @returns a `GraphValidationResult` with independent messages per rule.
 */
export function validateGraphDeclaration(
  graph: GraphDocument,
  opts?: { mode?: "construct" | "execution" },
): GraphValidationResult {
  const mode = opts?.mode ?? "construct";
  const errors: string[] = [];
  const warnings: string[] = [];

  checkVersion(graph, errors);
  checkNodeIdUniqueness(graph, errors);
  checkEdgeEndpoints(graph, errors);
  checkEdgeConditionVocabulary(graph, errors);
  checkLoopGroupIdUniqueness(graph, errors);
  checkLoopGroupNodeRefs(graph, errors);
  checkLoopGroupOverlap(graph, errors);
  checkCycleContainment(graph, errors, warnings, mode);
  checkApprovalNodeOutgoing(graph, errors);
  checkDataPassthrough(graph, errors);
  checkLoopGroupRoots(graph, errors, warnings);
  checkJoinQuorumBounds(graph, errors);
  checkNodeBudgetBounds(graph, errors);

  return { valid: errors.length === 0, errors, warnings };
}

// ── Rule 1: version ──────────────────────────────────────────────────────

function checkVersion(graph: GraphDocument, errors: string[]): void {
  if (graph.version === undefined || graph.version === null) {
    errors.push('missing required field "version" (expected 2)');
  } else if (graph.version !== 2) {
    errors.push(
      `unsupported graph version "${graph.version}" (expected 2)`,
    );
  }
}

// ── Rule 2: node-id uniqueness ───────────────────────────────────────────

function checkNodeIdUniqueness(graph: GraphDocument, errors: string[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const node of graph.nodes) {
    if (seen.has(node.id)) duplicates.add(node.id);
    seen.add(node.id);
  }
  for (const id of duplicates) {
    errors.push(
      `duplicate node id "${id}" — node ids must be unique within a graph`,
    );
  }
}

// ── Rule 3: edge endpoint validity ───────────────────────────────────────

function checkEdgeEndpoints(graph: GraphDocument, errors: string[]): void {
  const declared = new Set(graph.nodes.map((node) => node.id));
  for (const edge of graph.edges) {
    if (!declared.has(edge.from)) {
      errors.push(
        `edge from="${edge.from}" -> "${edge.to}" references an undeclared node in "from"`,
      );
    }
    if (!declared.has(edge.to)) {
      errors.push(
        `edge from="${edge.from}" -> "${edge.to}" references an undeclared node in "to"`,
      );
    }
  }
}

// ── Rule 3b: on_condition edges must name a registered condition ──────────

/**
 * Reject `on_condition` edges whose `condition` names a function outside the
 * registered condition vocabulary.
 *
 * The engine's `defaultConditionResolver` (engine/condition-resolver.ts:97-98)
 * treats unknown condition names as always-false — so an `on_condition` edge
 * gated on a made-up condition can NEVER activate, deadlocking any downstream
 * node that depends solely on it ("graph deadlock: no active upstream can
 * satisfy pending node(s)"). Rejecting unknown names here surfaces the typo
 * at validation/construction time instead of at runtime.
 *
 * The vocabulary is the same `KNOWN_CONDITIONS` set the asset validator uses
 * (src/function/conditions.ts:100) — derived from the `NAMED_CONDITIONS`
 * implementations, so it can never drift from what actually evaluates. The
 * condition name is extracted with the same `name(arg)` pattern as the
 * resolver (engine/condition-resolver.ts:60): `name` = match[1] when the
 * condition matches `/^([a-z][a-z0-9_]*)\(([^)]*)\)$/`, else the whole string.
 * A missing/empty `condition` is likewise rejected (mirrors the tool-level
 * guard at graph-tools.ts:996-1001 for non-tool entry points like
 * parseGraph / importGraphFromFile).
 */
function checkEdgeConditionVocabulary(graph: GraphDocument, errors: string[]): void {
  for (const edge of graph.edges) {
    if (edge.type !== "on_condition") continue;
    if (!edge.condition || edge.condition.trim() === "") {
      errors.push(
        `edge from="${edge.from}" -> "${edge.to}" is type "on_condition" ` +
          `but no "condition" was provided`,
      );
      continue;
    }
    const call = edge.condition.match(CALL_RE);
    const name = call ? call[1] : edge.condition;
    if (!KNOWN_CONDITIONS.has(name)) {
      errors.push(
        `edge from="${edge.from}" -> "${edge.to}" is type "on_condition" ` +
          `with unknown condition "${name}" — expected a name from the ` +
          `registered condition vocabulary (${[...KNOWN_CONDITIONS].sort().join(", ")})`,
      );
    }
  }
}

// ── Rule 5a: loop-group id uniqueness (symmetric to node ids) ────────────

function checkLoopGroupIdUniqueness(
  graph: GraphDocument,
  errors: string[],
): void {
  const groups = graph.loop_groups ?? [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const group of groups) {
    if (seen.has(group.id)) duplicates.add(group.id);
    seen.add(group.id);
  }
  for (const id of duplicates) {
    errors.push(
      `duplicate loop group id "${id}" — loop group ids must be unique within a graph`,
    );
  }
}

// ── Rule 5b: loop-group referenced nodes must be declared ────────────────

function checkLoopGroupNodeRefs(
  graph: GraphDocument,
  errors: string[],
): void {
  const declared = new Set(graph.nodes.map((node) => node.id));
  for (const group of graph.loop_groups ?? []) {
    for (const nodeId of group.nodes) {
      if (!declared.has(nodeId)) {
        errors.push(
          `loop group "${group.id}" references undeclared node "${nodeId}"`,
        );
      }
    }
  }
}

// ── Rule 5c: loop-group membership must be disjoint (fatal) ───────────────

/**
 * Reject any node that appears in more than one declared loop group.
 *
 * The engine assigns each member node a single `loopGroupId` by iterating loop
 * groups in declaration order and overwriting the previous value (last-wins) —
 * `buildLoopGroupMap` (engine-state.ts:220-230) and `provisionLoopGroups`
 * (engine-state.ts:349-353). A node declared in two groups therefore silently
 * binds to only the last one, losing its membership in the first. That silent
 * overwrite is a structural ambiguity, so we surface it as a fatal error here
 * rather than letting the engine resolve it implicitly.
 */
function checkLoopGroupOverlap(graph: GraphDocument, errors: string[]): void {
  const owner = new Map<string, string>(); // nodeId → first group that owns it
  const conflicts = new Map<string, string[]>(); // nodeId → owning group ids
  for (const group of graph.loop_groups ?? []) {
    for (const nodeId of group.nodes) {
      if (owner.has(nodeId)) {
        const list = conflicts.get(nodeId) ?? [];
        if (list.length === 0) list.push(owner.get(nodeId)!);
        list.push(group.id);
        conflicts.set(nodeId, list);
      } else {
        owner.set(nodeId, group.id);
      }
    }
  }
  for (const [nodeId, groupIds] of conflicts) {
    errors.push(
      `node "${nodeId}" appears in multiple loop groups ` +
        `[${groupIds.join(", ")}] — a node may belong to at most one loop group`,
    );
  }
}

// ── Rule 6: needs_approval nodes — no type:"always" outgoing edges ───────

function checkApprovalNodeOutgoing(
  graph: GraphDocument,
  errors: string[],
): void {
  const outgoingByNode = new Map<string, EdgeDeclaration[]>();
  for (const edge of graph.edges) {
    const list = outgoingByNode.get(edge.from) ?? [];
    list.push(edge);
    outgoingByNode.set(edge.from, list);
  }

  for (const node of graph.nodes) {
    if (node.needs_approval !== true) continue;
    for (const edge of outgoingByNode.get(node.id) ?? []) {
      if (edge.type === "always") {
        errors.push(
          `node "${node.id}" has needs_approval: true but its outgoing edge ` +
            `"${edge.from} -> ${edge.to}" is type "always"; ` +
            `approval nodes may only have "on_signal" or "on_condition" outgoing edges`,
        );
      }
    }
  }
}

// ── Revise back-edge predicate (mirrors engine's isReviseBackEdge) ───────

/**
 * Whether an edge is a revision back-edge: an `on_signal` edge whose
 * `signal_filter` names `revise_needed`. These edges route revision feedback
 * backward within a loop group and must be excluded from in-degree
 * computations that determine graph roots — otherwise a loop's entry node
 * whose only incoming edge is a revise back-edge would never be discovered
 * as a root, deadlocking the graph.
 *
 * Implemented inline against `EdgeDeclaration` rather than importing the
 * engine's `isReviseBackEdge` from `src/graph/engine/` to avoid a layering
 * violation (validators live in `src/graph/`, above the engine module).
 */
function isReviseBackEdge(edge: EdgeDeclaration): boolean {
  if (edge.type !== "on_signal") return false;
  return (edge.signal_filter ?? []).includes("revise_needed");
}

// ── Intra-loop-group always-edge predicate (mirrors engine) ───────────────

/**
 * Build a NodeId → LoopGroupId map from the graph declaration's loop_groups.
 *
 * Uses last-wins semantics (a later group overwrites an earlier group for the
 * same node id), exactly mirroring the engine's `buildLoopGroupMap`
 * (engine-state.ts:220-230). Overlapping membership is rejected by
 * `checkLoopGroupOverlap` (Rule 9), so this last-wins behavior only serves as a
 * defensive default for callers that run without the overlap check.
 *
 * Implemented inline against `GraphDocument` rather than importing the engine's
 * `buildLoopGroupMap` from `src/graph/engine/` to avoid a layering violation
 * (validators live in `src/graph/`, above the engine module — see the note on
 * `isReviseBackEdge` above).
 */
function buildLoopGroupMap(graph: GraphDocument): Map<string, string> | null {
  const groups = graph.loop_groups;
  if (!groups || groups.length === 0) return null;
  const map = new Map<string, string>();
  for (const group of groups) {
    for (const nodeId of group.nodes) {
      map.set(nodeId, group.id);
    }
  }
  return map;
}

/**
 * Whether an edge is a type-`always` connection whose both endpoints belong to
 * the same declared loop group. Mirrors the engine's `isIntraLoopGroupAlwaysEdge`
 * (engine-state.ts:244-253): these intra-group always-edges form the bounded
 * cycle backbone and must not count as external in-edges blocking root
 * discovery — otherwise a loop group whose members are connected only by
 * `always` edges (e.g. A ⇄ B) would have no node with in-degree zero and the
 * graph would deadlock.
 *
 * Signal-routed edges within a loop group are NOT excluded (they represent
 * forward dependencies that must be honored), and revise back-edges are already
 * excluded separately by `isReviseBackEdge`.
 */
function isIntraLoopGroupAlwaysEdge(
  edge: EdgeDeclaration,
  loopGroupMap: Map<string, string> | null,
): boolean {
  if (edge.type !== "always") return false;
  if (!loopGroupMap) return false;
  const fromGroup = loopGroupMap.get(edge.from);
  if (fromGroup === undefined) return false;
  return fromGroup === loopGroupMap.get(edge.to);
}

// ── Rule 7: data_passthrough shape ───────────────────────────────────────

function checkDataPassthrough(graph: GraphDocument, errors: string[]): void {
  for (const edge of graph.edges) {
    const dm = edge.data_passthrough;
    if (dm === undefined) continue;
    // exclude entries are guaranteed strings by the parser's string-array
    // coercer; here we only guard the numeric truncation bound.
    if (dm.maxChars !== undefined && !(dm.maxChars >= 0)) {
      errors.push(
        `edge from="${edge.from}" -> "${edge.to}" data_passthrough.max_chars ` +
          `must be a non-negative number (got ${dm.maxChars})`,
      );
    }
  }
}

// ── Rule 8: loop-group root detection (deadlock) ────────────────────────

/**
 * Detects deadlock conditions in graph root entry and loop-group reachability.
 *
 * **Global root check (error):** when, after filtering out revise back-edges,
 * no node has in-degree zero AND at least one loop group is declared, the
 * graph has no entry point — a pure cycle that deadlocks the engine. This is
 * promoted from a warning to an ERROR because a loop-group-only cycle cannot
 * bootstrap without an external root.
 *
 * **Global root check (warning):** when no node has in-degree zero but NO
 * loop group is declared, emit a non-fatal warning — the absence of loop
 * groups means the engine has no structured recovery path, and deadlock is
 * probable but not certain (external triggers could intervene).
 *
 * **Per-loop-group isolation check (error):** for each declared loop group,
 * examine every member node. If every member node has in-degree ≥ 1 (after
 * excluding revise back-edges) AND all incoming edges originate from within
 * the same loop group, the group has no external entry — it is unreachable
 * and will deadlock. Flag it as an error naming the loop group id.
 *
 * A member node with in-degree zero is a graph root and counts as having
 * external entry for its loop group (the loop group is reachable from the
 * rest of the graph via that root member).
 */
function checkLoopGroupRoots(
  graph: GraphDocument,
  errors: string[],
  warnings: string[],
): void {
  // Compute in-degree excluding revise back-edges and intra-loop-group always
  // edges — exactly matching the engine's computeInDegrees/getRootNodeIds
  // (engine-state.ts:268-294) so root discovery can never diverge.
  const loopGroupMap = buildLoopGroupMap(graph);
  const inDegree = new Map<string, number>();
  for (const node of graph.nodes) {
    inDegree.set(node.id, 0);
  }
  for (const edge of graph.edges) {
    if (isReviseBackEdge(edge)) continue;
    if (isIntraLoopGroupAlwaysEdge(edge, loopGroupMap)) continue;
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const hasRoot = [...inDegree.values()].some((deg) => deg === 0);
  const hasLoopGroups = (graph.loop_groups ?? []).length > 0;

  if (!hasRoot && hasLoopGroups) {
    errors.push(
      "the graph has no entry node (all nodes have at least one incoming edge) — " +
        "pure cycles without an external root deadlock the engine",
    );
  } else if (!hasRoot) {
    warnings.push(
      "the graph has no unblocked entry point after excluding " +
        "revise back-edges and may deadlock",
    );
  }

  // Per-loop-group external entry check.
  for (const group of graph.loop_groups ?? []) {
    const memberSet = new Set(group.nodes);
    let hasExternalEntry = false;

    for (const nodeId of group.nodes) {
      // A member with in-degree zero is a graph root — the loop group
      // is reachable from outside via this root entry.
      if ((inDegree.get(nodeId) ?? 0) === 0) {
        hasExternalEntry = true;
        break;
      }

      // Check whether any non-revise incoming edge originates
      // from outside the loop group.
      for (const edge of graph.edges) {
        if (edge.to !== nodeId) continue;
        if (isReviseBackEdge(edge)) continue;
        if (!memberSet.has(edge.from)) {
          hasExternalEntry = true;
          break;
        }
      }
      if (hasExternalEntry) break;
    }

    if (!hasExternalEntry) {
      errors.push(
        `loop group "${group.id}" has no external entry — ` +
          "all incoming edges of member nodes originate from within the loop group; " +
          "the group is unreachable and will deadlock",
      );
    }
  }
}

// ── Rule 9: join quorum bounds ─────────────────────────────────────────────

/**
 * Enforce numeric bounds on `join.quorum` for quorum-strategy nodes.
 *
 * The zod tool layer already rejects non-positive-integer quorums up front,
 * but this validator is the defense-in-depth gate for non-zod callers (direct
 * `GraphToolSet` usage, persisted-state loads) — a structurally-broken quorum
 * would otherwise pass validation and misbehave at runtime:
 *   - quorum <= 0 → `evaluateJoin` (join-evaluator.ts:245) is satisfied by
 *     ZERO upstream answers (`answerCount >= n` with n <= 0), so a fan-in
 *     convergence node dispatches at graph start, ignoring its declared
 *     upstreams — a DAG-order violation.
 *   - quorum > in-degree → the join is unsatisfiable; the runtime force-fails
 *     the node ("quorum impossible", join-evaluator.ts:255) on every run.
 *
 * In-degree here is the number of DISTINCT upstream source ids over ALL
 * incoming edges (mirroring join-evaluator `getUpstreamNodeIds` with default
 * opts — revise back-edges and intra-loop-group edges are NOT excluded,
 * because a later loop traversal can legitimately count them as upstreams).
 * This is deliberately different from the root-discovery in-degree in
 * `checkLoopGroupRoots`, which excludes those edges to expose entry points.
 *
 * The upper-bound check is DEFERRED while a node has no incoming edges yet:
 * construction is incremental (`graph_add_node` always precedes the
 * `graph_add_edge` calls that create its in-degree), so a freshly-added quorum
 * node must not be rejected for an arity it cannot have acquired yet. A quorum
 * node with zero upstreams is also immediately satisfied at runtime
 * (join-evaluator.ts:230-235), so accepting it is harmless. The upper bound
 * fires from the moment the node's first incoming edge exists.
 */
function checkJoinQuorumBounds(graph: GraphDocument, errors: string[]): void {
  // Distinct upstream source ids per node over ALL incoming edges.
  const upstreamSources = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const set = upstreamSources.get(edge.to) ?? new Set<string>();
    set.add(edge.from);
    upstreamSources.set(edge.to, set);
  }

  for (const node of graph.nodes) {
    const join = node.join;
    if (join === undefined || join.strategy !== "quorum") continue;
    const quorum = join.quorum ?? 1; // documented default (join-evaluator.ts:65)

    if (!Number.isInteger(quorum) || quorum < 1) {
      errors.push(
        `node "${node.id}" join quorum must be a positive integer (got ${quorum})`,
      );
      continue;
    }

    const inDegree = upstreamSources.get(node.id)?.size ?? 0;
    if (inDegree > 0 && quorum > inDegree) {
      errors.push(
        `node "${node.id}" join quorum:${quorum} exceeds its in-degree (${inDegree}) ` +
          `— the join can never be satisfied by its declared upstreams`,
      );
    }
  }
}

// ── Rule 10: per-node budget numeric bounds ────────────────────────────────

/**
 * Enforce numeric bounds on per-node `budget.timeout_ms` / `budget.max_retries`,
 * mirroring the `checkDataPassthrough` (`max_chars >= 0`) pattern.
 *
 * The zod tool layer enforces the same bounds up front; this is the
 * defense-in-depth gate for non-zod callers and persisted-state loads:
 *   - a NEGATIVE `timeout_ms` would silently disable the staleness watchdog
 *     for that node (engine-recovery.ts:1166-1167 `deadline <= 0` → skip) —
 *     the node could hang forever, defeating the documented "a graph never
 *     hangs" invariant. `0` is VALID: it is the documented per-node opt-out
 *     sentinel (pinned by engine-recovery.test.ts "skips a running node whose
 *     per-node budget disables staleness (timeout_ms 0)").
 *   - a NEGATIVE or fractional `max_retries` is meaningless — retry counts
 *     are integer thresholds at runtime.
 */
function checkNodeBudgetBounds(graph: GraphDocument, errors: string[]): void {
  for (const node of graph.nodes) {
    const budget = node.budget;
    if (budget === undefined) continue;
    if (budget.timeout_ms !== undefined && !(budget.timeout_ms >= 0)) {
      errors.push(
        `node "${node.id}" budget.timeout_ms must be a non-negative number ` +
          `(got ${budget.timeout_ms}); 0 is the documented "disable staleness watchdog" opt-out`,
      );
    }
    if (
      budget.max_retries !== undefined &&
      (!Number.isInteger(budget.max_retries) || budget.max_retries < 0)
    ) {
      errors.push(
        `node "${node.id}" budget.max_retries must be a non-negative integer ` +
          `(got ${budget.max_retries})`,
      );
    }
  }
}

// ── Rule 4: cycle containment (Tarjan SCC-based) ─────────────────────────

function checkCycleContainment(
  graph: GraphDocument,
  errors: string[],
  warnings: string[],
  mode: "construct" | "execution",
): void {
  // (a) ERROR — a declared loop group must actually induce a cycle.
  for (const group of graph.loop_groups ?? []) {
    const groupSet = new Set(group.nodes);
    const inducedEdges = graph.edges.filter(
      (edge) => groupSet.has(edge.from) && groupSet.has(edge.to),
    );
    if (!hasCycle(inducedEdges)) {
      errors.push(
        `loop group "${group.id}" declares nodes [${group.nodes.join(", ")}] ` +
          `that do not form a directed cycle`,
      );
    }
  }

  // (b) Every full-graph cycle must be covered by a loop group. Iterate the
  // Tarjan SCCs of the FULL graph and judge each uncovered cyclic SCC on its
  // own: an SCC that contains a revise back-edge is the canonical
  // dag-yaml-schema.md Appendix B pattern (a revise edge pulls a node into a
  // loop group's SCC without declaring it) and stays a warning in BOTH modes.
  // An SCC with no revise back-edge can never be excluded from root discovery,
  // so in execution mode it is promoted to a fatal error; construct mode keeps
  // it a warning so incremental building (add cycle-closing edge, then declare
  // the loop group) works in either ordering.
  const covered = new Set<string>();
  for (const group of graph.loop_groups ?? []) {
    for (const nodeId of group.nodes) covered.add(nodeId);
  }
  const { components, selfLoop } = tarjanScc(graph.edges);
  for (const component of components.values()) {
    if (!isCyclicComponent(component, selfLoop)) continue;
    const nodes = new Set(component);
    if ([...nodes].every((node) => covered.has(node))) continue;
    const hasReviseBackEdge = graph.edges.some(
      (edge) =>
        nodes.has(edge.from) && nodes.has(edge.to) && isReviseBackEdge(edge),
    );
    const baseMessage =
      `cycle detected involving node(s) [${[...nodes].sort().join(", ")}] ` +
      `that are not contained in any declared loop group`;
    if (mode === "execution" && !hasReviseBackEdge) {
      errors.push(
        `${baseMessage} and contain no revise back-edge — the graph can ` +
          `never activate and deadlocks at runtime`,
      );
    } else {
      warnings.push(baseMessage);
    }
  }
}

// ── Tarjan SCC over v2 EdgeDeclaration ───────────────────────────────────

interface TarjanResult {
  components: Map<number, string[]>;
  selfLoop: Set<string>;
}

/**
 * Compute strongly-connected components over a set of v2 edges. Nodes are
 * derived from the edges themselves (a node absent from every edge is acyclic
 * by definition and needs no component).
 */
function tarjanScc(edges: EdgeDeclaration[]): TarjanResult {
  const nodeSet = new Set<string>();
  for (const edge of edges) {
    nodeSet.add(edge.from);
    nodeSet.add(edge.to);
  }
  const nodes = [...nodeSet];

  const adj = new Map<string, string[]>();
  const selfLoop = new Set<string>();
  for (const node of nodes) adj.set(node, []);
  for (const edge of edges) {
    if (edge.from === edge.to) selfLoop.add(edge.from);
    adj.get(edge.from)!.push(edge.to);
  }

  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components = new Map<number, string[]>();

  let index = 0;
  let componentId = 0;

  function strongConnect(node: string): void {
    indices.set(node, index);
    lowlink.set(node, index);
    index++;
    stack.push(node);
    onStack.add(node);

    for (const neighbor of adj.get(node) ?? []) {
      if (!indices.has(neighbor)) {
        strongConnect(neighbor);
        lowlink.set(node, Math.min(lowlink.get(node)!, lowlink.get(neighbor)!));
      } else if (onStack.has(neighbor)) {
        lowlink.set(node, Math.min(lowlink.get(node)!, indices.get(neighbor)!));
      }
    }

    if (lowlink.get(node) === indices.get(node)) {
      const component: string[] = [];
      let popped: string;
      do {
        popped = stack.pop()!;
        onStack.delete(popped);
        component.push(popped);
      } while (popped !== node);
      components.set(componentId, component);
      componentId++;
    }
  }

  for (const node of nodes) {
    if (!indices.has(node)) strongConnect(node);
  }

  return { components, selfLoop };
}

/** A component is cyclic when it has >1 node or is a self-loop. */
function isCyclicComponent(component: string[], selfLoop: Set<string>): boolean {
  if (component.length > 1) return true;
  return selfLoop.has(component[0]);
}

/** True when the given edge set contains at least one directed cycle. */
export function hasCycle(edges: EdgeDeclaration[]): boolean {
  const { components, selfLoop } = tarjanScc(edges);
  for (const component of components.values()) {
    if (isCyclicComponent(component, selfLoop)) return true;
  }
  return false;
}
