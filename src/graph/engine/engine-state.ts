/**
 * Graph Execution Engine v2 — Engine State Factory
 *
 * Version: 2.0
 * Date: 2026-07-24
 *
 * Creates and mutates the top-level {@link EngineState} container for a graph
 * execution instance. This module owns:
 *
 * - The engine lifecycle phase machine (`idle → executing → complete`).
 * - Frontier (ready-for-dispatch set) management.
 * - Node registration: `Map<NodeId, NodeRuntimeState>`.
 * - The `advancingLock` re-entrancy guard and `pendingCompletions` queue
 *   (reserved for the Phase-6 advancement critical section).
 * - Loop-group runtime state provisioning and traversal counters.
 * - A budget-tracking stub (graph-level cumulative consumption).
 *
 * Design reference: `.rolebox/design/engine-state-machine.md` §1.
 *
 * Scope note: `provision()` only performs topology bootstrap (root discovery +
 * initial node status assignment). Join evaluation, edge payload routing, and
 * node advancement are out of scope for this module (later phases).
 */

import { EnginePhase, NodeStatus } from "../../constants.ts";
import type { EdgeDeclaration, GraphDeclaration, NodeConfig } from "../../types.graph-v2.ts";
import type {
  EngineState,
  GraphBudgetState,
  LoopGroupRuntimeState,
  NodeRuntimeState,
  PhaseEventSink,
  BudgetEventSink,
} from "../../types.engine-v2.ts";
import { resolveJoinStrategy, isReviseBackEdge } from "./join-evaluator.ts";
import { bindNodeState } from "./recorder.ts";
import { markReady } from "./node-lifecycle.ts";

// ── Event sinks (write-side graph event log) ────────────────────────────────
//
// PhaseEventSink / BudgetEventSink types are defined on EngineState in
// types.engine-v2.ts. The engine runtime wires sinks onto the state at
// construction (see EngineRuntimeImpl in index.ts). Previously these were
// module-level mutable singletons set by GraphEventRecorder; they are now
// instance fields on EngineState so a deserialized or snapshot state never
// accidentally carries a stale function reference.

// ── Budget stub ───────────────────────────────────────────────────────────

/**
 * Zeroed `UsageRecord` used as the initial value for every node's
 * `tokensConsumed` and as the base for graph-level budget deltas.
 */
export const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, cost: 0 } as const;

/** Returns a freshly zeroed graph-level budget state. */
export function emptyGraphBudget(): GraphBudgetState {
  return {
    sessionsSpawned: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
  };
}

/**
 * Stub: apply a consumption delta to the graph-level budget.
 *
 * TODO(Phase 7): Budget *enforcement* (checking cumulative consumption against
 * `graphDeclaration.budget.max_total_*` limits before dispatch and rejecting
 * with `escalate` once exhausted) is out of scope here. This only accumulates
 * the graph-level counters embedded in `EngineState.budget`.
 */
export function applyBudgetDelta(
  state: EngineState,
  delta: {
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    sessions?: number;
  },
): void {
  const b = state.budget;
  b.sessionsSpawned += delta.sessions ?? 0;
  b.totalInputTokens += delta.inputTokens ?? 0;
  b.totalOutputTokens += delta.outputTokens ?? 0;
  b.totalCost += delta.cost ?? 0;
  state.updatedAt = Date.now();
  // Emit a budget-update event to the write-side log (no-op when no sink is
  // wired on the state). Never lets a recorder failure corrupt the budget update.
  try {
    state.budgetEventSink?.(state.graphId, b);
  } catch {
    // observability — never breaks the budget mutation
  }
}

// ── Engine lifecycle phase machine ─────────────────────────────────────────

/**
 * Allowed engine-phase transitions. The engine advances linearly through
 * `idle → executing → complete`; there is no `building` or `validating` phase
 * (role-agnostic primitive — see design doc §1 revision note).
 */
const VALID_PHASE_TRANSITIONS: Record<EnginePhase, readonly EnginePhase[]> = {
  idle: [EnginePhase.Executing],
  executing: [EnginePhase.Complete],
  complete: [],
};

/** Whether `state.phase → to` is a legal engine-phase transition. */
export function canTransitionPhase(state: EngineState, to: EnginePhase): boolean {
  return VALID_PHASE_TRANSITIONS[state.phase].includes(to);
}

/**
 * Transition the engine lifecycle phase, enforcing the
 * `idle → executing → complete` ordering. Any other transition is rejected
 * with an error.
 */
export function transitionPhase(state: EngineState, to: EnginePhase): void {
  if (!canTransitionPhase(state, to)) {
    throw new Error(`Invalid engine phase transition: ${state.phase} -> ${to}`);
  }
  const from = state.phase;
  const now = Date.now();
  state.phase = to;
  state.updatedAt = now;
  // Emit a phase-change event to the write-side log (no-op when no sink is
  // wired on the state). Never lets a recorder failure corrupt the phase transition.
  try {
    state.phaseEventSink?.(state.graphId, from, to);
  } catch {
    // observability — never breaks the lifecycle transition
  }
}

// ── Engine state factory ───────────────────────────────────────────────────

/**
 * Create a fresh {@link EngineState} in the `idle` phase for the given graph
 * declaration. The `nodes` map is empty until {@link provision} runs.
 */
export function createEngineState(
  graphDeclaration: GraphDeclaration,
  graphId: string,
): EngineState {
  const now = Date.now();
  return {
    phase: EnginePhase.Idle,
    graphId,
    graphDeclaration,
    nodes: new Map(),
    edges: new Map(),
    loopGroups: new Map(),
    frontier: [],
    budget: emptyGraphBudget(),
    signalLedger: new Map(),
    startedAt: now,
    updatedAt: now,
    advancingLock: false,
    pendingCompletions: [],
  };
}

// ── Node registration ──────────────────────────────────────────────────────

/**
 * Register a single node from its declaration into `state.nodes` as a fresh
 * `NodeRuntimeState` (status `pending`). Throws on duplicate node ID — node
 * IDs must be unique within a graph.
 */
export function registerNode(
  state: EngineState,
  config: NodeConfig,
): NodeRuntimeState {
  if (state.nodes.has(config.id)) {
    throw new Error(`Duplicate node id in graph "${state.graphId}": ${config.id}`);
  }
  const now = Date.now();
  const node: NodeRuntimeState = {
    nodeId: config.id,
    agent: config.agent,
    prompt: config.prompt,
    needsApproval: config.needs_approval ?? false,
    status: NodeStatus.Pending,
    signalsObserved: {},
    sessionsSpawned: 0,
    tokensConsumed: { inputTokens: 0, outputTokens: 0, cost: 0 },
    upstreamResults: new Map(),
    // Propagate the node's declared join (default "all") into the runtime field
    // via the same resolver join-evaluation uses, so they can never diverge.
    joinStrategy: resolveJoinStrategy(config.join),
    joinSatisfied: false,
    traversalCount: 0,
    startedAt: now,
    retryCount: 0,
  };
  state.nodes.set(config.id, node);
  // Bind the node to its owning state so the lifecycle transition point can
  // auto-save checkpoints into `EngineState.checkpoints` (subtask C-RECORD).
  bindNodeState(node, state);
  state.updatedAt = now;
  return node;
}

// ── Provisioning (topology bootstrap) ──────────────────────────────────────

/**
 * Build a NodeId → LoopGroupId map from the graph declaration's loop_groups.
 *
 * Returns `null` when no loop groups are declared so callers can skip the
 * intra-group edge check without evaluating every edge against an empty map.
 */
function buildLoopGroupMap(state: EngineState): Map<string, string> | null {
  const groups = state.graphDeclaration.loop_groups;
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
 * Return `true` when `edge` is a type-`always` connection whose both
 * endpoints belong to the same declared loop group.  These intra-group
 * always-edges form the bounded cycle backbone and must not count as external
 * in-edges blocking root discovery — otherwise a loop group whose members are
 * connected only by `always` edges (e.g. A ⇄ B) would have no node with
 * in-degree zero and the graph would deadlock.
 *
 * Signal-routed edges within a loop group (e.g. `impl → review` on `answer`)
 * are NOT excluded — they represent forward dependencies that must be honored.
 * Revise back-edges are already excluded separately by {@link isReviseBackEdge}.
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

/** Return the node IDs that have no incoming edges (graph roots). */
export function getRootNodeIds(state: EngineState): string[] {
  const upstream = new Map<string, number>();
  const loopGroupMap = buildLoopGroupMap(state);
  for (const edge of state.graphDeclaration.edges) {
    if (isReviseBackEdge(edge)) continue;
    if (isIntraLoopGroupAlwaysEdge(edge, loopGroupMap)) continue;
    upstream.set(edge.to, (upstream.get(edge.to) ?? 0) + 1);
  }
  const roots: string[] = [];
  for (const config of state.graphDeclaration.nodes) {
    if ((upstream.get(config.id) ?? 0) === 0) {
      roots.push(config.id);
    }
  }
  return roots;
}

/**
 * Provision the engine state from its graph declaration.
 *
 * For every node: root nodes (no upstream edges) are placed in `ready` status
 * and added to the frontier; every other node starts in `pending`. This is a
 * pure topology bootstrap — no edges are evaluated, no joins resolved.
 */
export function provision(state: EngineState): void {
  const declaration = state.graphDeclaration;
  const upstream = new Map<string, number>();
  const loopGroupMap = buildLoopGroupMap(state);
  for (const edge of declaration.edges) {
    if (isReviseBackEdge(edge)) continue;
    if (isIntraLoopGroupAlwaysEdge(edge, loopGroupMap)) continue;
    upstream.set(edge.to, (upstream.get(edge.to) ?? 0) + 1);
  }

  for (const config of declaration.nodes) {
    const node = registerNode(state, config);
    const incoming = upstream.get(config.id) ?? 0;
    if (incoming === 0) {
      markReady(node);
      addToFrontier(state, config.id);
    } else {
      node.status = NodeStatus.Pending;
    }
  }

  // Populate loop-group runtime state and tag member nodes (Phase 2).
  provisionLoopGroups(state);

  // Inject signal contracts for loop-group member nodes that have
  // on_signal outbound edges (so they know which signals to emit).
  injectSignalContracts(state);
}

// ── Loop-group runtime state ───────────────────────────────────────────────

/**
 * Bootstrap `state.loopGroups` from `graphDeclaration.loop_groups` and tag
 * every member node with its `loopGroupId`.
 *
 * Each loop group starts with `traversalCount: 0`. Design reference:
 * `.rolebox/design/graph-model.md` §4 and
 * `.rolebox/design/engine-state-machine.md` §2.2.
 */
function provisionLoopGroups(state: EngineState): void {
  const groups = state.graphDeclaration.loop_groups;
  if (!groups) return;
  const now = Date.now();
  for (const decl of groups) {
    state.loopGroups.set(decl.id, {
      id: decl.id,
      maxTraversals: decl.max_traversals,
      traversalCount: 0,
      startTimeMs: now,
      termination: decl.termination,
      consecutiveStale: 0,
    });
    for (const nodeId of decl.nodes) {
      const node = state.nodes.get(nodeId);
      if (node) {
        node.loopGroupId = decl.id;
      }
    }
  }
}

// ── Signal contract injection ───────────────────────────────────────────────

/**
 * Build the signal contract text for a loop-group member node.
 *
 * Generates a `<signal_contract>` XML block telling the agent which signals
 * to emit and when. The contract is dynamic — it includes only the signal
 * types found in the node's on_signal outbound edges (plus the universal
 * `answer` and `escalate` signals, which every node needs).
 *
 * Non-loop nodes and nodes without `on_signal` outbound edges are unaffected.
 */
export function buildSignalContract(signalTypes: string[]): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("<signal_contract>");
  lines.push("You are inside a graph loop group. You MUST signal your completion using the signal tool:");

  // Universal signals every loop-group node needs to know about.
  lines.push('- When complete and everything passes / converges: signal(type="answer")');

  // Document each specific signal from the node's outbound on_signal edges.
  for (const st of signalTypes) {
    switch (st) {
      case "revise_needed":
        lines.push('- When revisions are needed / iteration must continue: signal(type="revise_needed") with findings in payload (e.g., signal(type="revise_needed", payload={findings: "..."}))');
        break;
      case "escalate":
        lines.push('- On unrecoverable failure / cannot proceed: signal(type="escalate") with reason in payload');
        break;
      case "answer":
        // answer is documented above as universal; skip here to avoid duplication.
        break;
      default:
        lines.push(`- To activate the "${st}" path: signal(type="${st}") with relevant context in payload`);
        break;
    }
  }

  // Unrecoverable failure is always documented (omitted above when escalate
  // is NOT in signalTypes — we add it here to ensure it's always present).
  if (!signalTypes.includes("escalate")) {
    lines.push('- On unrecoverable failure / cannot proceed: signal(type="escalate") with reason in payload');
  }

  lines.push("</signal_contract>");
  return lines.join("\n");
}

/**
 * Inject signal contract instructions into every loop-group member node
 * that has one or more `on_signal` outbound edges.
 *
 * When a node is part of a loop group AND has outgoing edges that are
 * signal-activated (type === "on_signal"), the agent needs to know which
 * signals to emit so the engine can route the result correctly. This
 * function scans the graph declaration and appends a <signal_contract>
 * block to the node's prompt.
 *
 * Non-loop nodes and loop nodes without on_signal outbound edges are
 * left unchanged.
 */
export function injectSignalContracts(state: EngineState): void {
  const edges = state.graphDeclaration.edges;

  for (const node of state.nodes.values()) {
    // Only loop-group member nodes need signal contracts.
    if (node.loopGroupId === undefined) continue;

    const outbound = edges.filter(
      (e: EdgeDeclaration) => e.from === node.nodeId && e.type === "on_signal",
    );
    if (outbound.length === 0) continue;

    // Collect the union of all signal_filter values from the node's
    // outbound on_signal edges, excluding `answer` (which is already
    // universal and always gets documented).
    const signalTypes = new Set<string>();
    for (const e of outbound) {
      for (const s of e.signal_filter ?? []) {
        if (s !== "answer") signalTypes.add(s);
      }
    }
    // Only inject when there are non-answer signal types to document.
    // (A loop node with only on_signal(answer) edges doesn't need extra
    // instructions — the universal answer line in the contract covers it.)
    if (signalTypes.size === 0) continue;

    node.prompt += buildSignalContract([...signalTypes]);
  }
}

/**
 * Increment a loop group's traversal counter.
 *
 * Returns `false` (no-op) when the group is already at `maxTraversals` — the
 * `revise_needed` back-edge is deactivated once the hard cap is reached, per
 * `.rolebox/design/graph-model.md` §4.2. Otherwise increments and returns
 * `true`. Throws for an unknown group id.
 */
export function incrementLoopTraversal(state: EngineState, groupId: string): boolean {
  const group = getLoopGroup(state, groupId);
  if (group.traversalCount >= group.maxTraversals) {
    return false;
  }
  group.traversalCount += 1;
  state.updatedAt = Date.now();
  return true;
}

/** Whether a loop group has reached its `maxTraversals` hard cap. */
export function isLoopExhausted(state: EngineState, groupId: string): boolean {
  const group = getLoopGroup(state, groupId);
  return group.traversalCount >= group.maxTraversals;
}

/** Convenience: look up a loop group's runtime state, or throw if absent. */
function getLoopGroup(state: EngineState, groupId: string): LoopGroupRuntimeState {
  const group = state.loopGroups.get(groupId);
  if (!group) {
    throw new Error(`Unknown loop group "${groupId}" in graph "${state.graphId}"`);
  }
  return group;
}

// ── Frontier management ────────────────────────────────────────────────────

/** Whether `nodeId` is currently in the frontier (ready-for-dispatch) set. */
export function isInFrontier(state: EngineState, nodeId: string): boolean {
  return state.frontier.includes(nodeId);
}

/** Add a node to the frontier. No-op (returns false) if already present. */
export function addToFrontier(state: EngineState, nodeId: string): boolean {
  if (state.frontier.includes(nodeId)) {
    return false;
  }
  state.frontier.push(nodeId);
  state.updatedAt = Date.now();
  return true;
}

/** Remove a node from the frontier. Returns false if it was not present. */
export function removeFromFrontier(state: EngineState, nodeId: string): boolean {
  const idx = state.frontier.indexOf(nodeId);
  if (idx === -1) {
    return false;
  }
  state.frontier.splice(idx, 1);
  state.updatedAt = Date.now();
  return true;
}

// ── Re-entrancy guard (reserved for Phase-6 advancement) ───────────────────

/**
 * Acquire the advancement re-entrancy lock.
 *
 * Returns `true` if the lock was acquired (was not already held), `false` if it
 * was already held. Only one advancement critical section may run at a time,
 * per the `_advancing` pattern in `.rolebox/design/engine-state-machine.md`
 * §3.3.
 */
export function acquireAdvancingLock(state: EngineState): boolean {
  if (state.advancingLock) {
    return false;
  }
  state.advancingLock = true;
  state.updatedAt = Date.now();
  return true;
}

/** Release the advancement lock. */
export function releaseAdvancingLock(state: EngineState): void {
  state.advancingLock = false;
  state.updatedAt = Date.now();
}

/**
 * Queue a completion deferred during an advancement critical section. The
 * completions are drained by {@link drainPendingCompletions} in the
 * critical section's `finally` block.
 */
export function queuePendingCompletion(state: EngineState, nodeId: string): void {
  if (!state.pendingCompletions.includes(nodeId)) {
    state.pendingCompletions.push(nodeId);
  }
}

/**
 * Drain and return the deferred completions, resetting the pending queue.
 * Completions that arrive while `advancingLock` is held are re-processed after
 * the critical section exits.
 */
export function drainPendingCompletions(state: EngineState): string[] {
  const drained = state.pendingCompletions;
  state.pendingCompletions = [];
  state.updatedAt = Date.now();
  return drained;
}

/** Convenience: look up a node's runtime state, or throw if absent. */
export function getNode(state: EngineState, nodeId: string): NodeRuntimeState {
  const node = state.nodes.get(nodeId);
  if (!node) {
    throw new Error(`Unknown node id "${nodeId}" in graph "${state.graphId}"`);
  }
  return node;
}
