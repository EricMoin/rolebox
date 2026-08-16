/**
 * Graph Execution Engine v2 — Scoped / Cascade Cancellation Primitive
 *
 * Version: 2.0
 * Date: 2026-07-26
 *
 * {@link cancelNodes} is a caller-driven cancellation primitive: cancel one or
 * more named node ids (optionally cascading to their transitive DOWNSTREAM
 * dependents), distinct from the existing auto-cancellation lanes:
 *
 * - `cancelPendingUpstreams` (`cascade-canceller.ts`) retires upstreams a
 *   convergence node no longer needs once its join resolves.
 * - `pruneDownstreamSubgraph` (`approval-handler.ts`) cancels the rejected
 *   branches' transitive dependents that cannot survive on approved sources
 *   alone during a partial approval.
 * - `EngineRuntime.cancel()` cancels the WHOLE graph.
 *
 * This primitive is the scoped, user-addressed version: it cancels exactly the
 * ids the caller asks for (not the whole graph), and when `cascade` is set it
 * also retires every node transitively downstream of those targets over
 * `graphDeclaration.edges` (forward closure). It reuses ONLY existing lifecycle
 * machinery — it never invents new transitions or whole-graph teardown:
 *
 *   1. Lifecycle: `markCancelled` / `markDone` through the generic
 *      `canTransitionNode` guard (`node-lifecycle.ts`) — identical to the
 *      cascade-canceller and approval-handler retirement pattern.
 *   2. Cancellable guard: only `pending | ready | running` nodes are retired
 *      (the `isCancellable` rule from `cascade-canceller.ts:167-172`).
 *      `completed`, `blocked`, `escalate`, `timeout`, `cancelled`, `done` are
 *      left untouched (the transition table enforces this by throwing — we
 *      guard before calling).
 *   3. Forward closure: the BFS-over-edges pattern from
 *      `pruneDownstreamSubgraph` (`approval-handler.ts:211-262`).
 *   4. Dispatch teardown: `NodeDispatchPort.cancelTask` fire-and-forget (never
 *      awaited) — the `CancelDispatchPort` seam, structurally satisfied by
 *      `NodeDispatchPort` (`engine-advance.ts`).
 *
 * Loop-target expansion: when a requested target is a member of a declared
 * loop group (`node.loopGroupId`), the whole loop group's member set is
 * cancelled, because a loop is an indivisible bounded cycle — retiring one
 * member without its partners strands the back-edge. Expansion reads
 * `graphDeclaration.loop_groups[].nodes`.
 *
 * This module is an import-only consumer of the lifecycle state machine and
 * frontier (`engine-state.ts`). It never dispatches, never touches
 * `upstreamResults`, and never cancels the whole graph for a scoped target.
 */

import { NodeStatus } from "../../constants.ts";
import type { EngineState, NodeRuntimeState } from "../../types.engine-v2.ts";
import { removeFromFrontier } from "./engine-state.ts";
import { canTransitionNode, markCancelled, markDone } from "./node-lifecycle.ts";
import type { CancelDispatchPort } from "./cascade-canceller.ts";

// ── Options & report ────────────────────────────────────────────────────────

/** Options for {@link cancelNodes}. */
export interface CancelScopeOptions {
  /**
   * When true, also cancel every node transitively downstream of the expanded
   * targets over `graphDeclaration.edges` (forward closure). Default false —
   * cancels only the requested targets.
   */
  cascade?: boolean;
}

/**
 * Notification hook invoked for every node actually retired by a scoped
 * cancellation (monitor H4). Receives the node id and the cancellation reason
 * AFTER the node's lifecycle advanced to `cancelled → done`. The engine
 * runtime wires it to the advance engine's `notifyNodeTerminal` seam so a
 * scoped cancellation is observable to the monitor (completion seam + durable
 * event log) exactly like signal-driven transitions. Optional — direct
 * consumers that don't need observation omit it.
 */
export type CancelNodeNotifier = (nodeId: string, reason: string) => void;

/** Result of {@link cancelNodes}, for diagnostics and tests. */
export interface CancelScopeReport {
  /**
   * The effective target set after loop-member expansion: the requested ids
   * plus, for any target that is a loop-group member, that group's full member
   * set. Deduplicated.
   */
  target: string[];
  /**
   * Node ids actually retired to `cancelled → done` (and, when a cancel seam
   * was present and the node carried a dispatch task, handed to `cancelTask`).
   * Includes the targets and — when `cascade` — their transitive downstream.
   */
  cancelled: string[];
  /**
   * Node ids encountered (effective targets and, under `cascade`, downstream
   * dependents) that were NOT cancellable — already `completed`, `blocked`, or
   * terminal (`escalate` / `timeout` / `cancelled` / `done`). Left untouched.
   */
  skipped: string[];
  /** Dispatch task ids handed to `cancelTask` fire-and-forget (best-effort). */
  cancelCalls: string[];
}

// ── Forward closure ─────────────────────────────────────────────────────────

/**
 * Compute the transitive downstream closure of `seed` over
 * `graphDeclaration.edges`. Mirrors the BFS pattern in
 * `pruneDownstreamSubgraph` (`approval-handler.ts:221-237`) but walks every
 * edge lane (`always` / `on_signal` / `on_condition`): once a node is
 * cancelled it emits nothing, so no downstream lane can ever activate from it
 * — the whole downstream is dead regardless of edge semantics. The seed nodes
 * are included (they are their own zero-length closure).
 */
function downstreamClosure(state: EngineState, seed: readonly string[]): Set<string> {
  const closure = new Set<string>(seed);
  const queue = [...seed];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of state.graphDeclaration.edges) {
      if (edge.from !== current) continue;
      if (closure.has(edge.to)) continue;
      closure.add(edge.to);
      queue.push(edge.to);
    }
  }
  return closure;
}

// ── Cancellable guard ───────────────────────────────────────────────────────

/**
 * Whether a node is still eligible for scoped cancellation: only `pending`,
 * `ready`, and `running` nodes can be cancelled (the node-status Cancellable
 * rule used by `cascade-canceller.ts:167-172`). A node already `completed`,
 * `blocked`, or terminal (`escalate` / `timeout` / `cancelled` / `done`) is
 * resolved or done and must not be touched — `canTransitionNode` would throw on
 * it, so we guard first.
 */
function isCancellable(node: NodeRuntimeState): boolean {
  return (
    node.status === NodeStatus.Pending ||
    node.status === NodeStatus.Ready ||
    node.status === NodeStatus.Running
  );
}

// ── Cancellation core ───────────────────────────────────────────────────────

/**
 * Expand a requested target set into its effective member set: any target that
 * is a loop-group member pulls in its loop group's full `nodes[]` member set
 * (a loop is an indivisible bounded cycle). Deduplicates.
 */
export function expandLoopMembers(state: EngineState, requested: readonly string[]): string[] {
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const id of requested) {
    if (seen.has(id)) continue;
    const node = state.nodes.get(id);
    const groupId = node?.loopGroupId;
    if (groupId) {
      const decl = state.graphDeclaration.loop_groups?.find((g) => g.id === groupId);
      if (decl) {
        // Emit the whole member set (declaration order). The target's own id is
        // a member, so it is emitted here — do NOT pre-mark it seen first.
        for (const memberId of decl.nodes) {
          if (!seen.has(memberId)) {
            seen.add(memberId);
            expanded.push(memberId);
          }
        }
        continue;
      }
    }
    seen.add(id);
    expanded.push(id);
  }
  return expanded;
}

/**
 * Cancel one node's lifecycle (`pending | ready | running → cancelled → done`)
 * and, when a cancel seam is present and the node carries a dispatch task, tear
 * it down fire-and-forget (never awaited). Reuses the exact retirement pattern
 * shared by `cancelPendingUpstreams` (`cascade-canceller.ts:144-154`) and
 * `cancelNode` (`approval-handler.ts:333-345`).
 */
function cancelOne(
  state: EngineState,
  node: NodeRuntimeState,
  reason: string,
  dispatchPort: CancelDispatchPort | undefined,
  cancelCalls: string[],
  onCancelled?: CancelNodeNotifier,
): void {
  // Double guard: transition-table legality + the Cancellable rule.
  if (!canTransitionNode(node.status, NodeStatus.Cancelled)) return;
  markCancelled(state, node, reason);
  markDone(state, node);
  removeFromFrontier(state, node.nodeId);
  if (dispatchPort?.cancelTask && node.dispatchTaskId) {
    cancelCalls.push(node.dispatchTaskId);
    void dispatchPort.cancelTask(node.dispatchTaskId);
  }
  // Monitor (H4): a scoped cancellation is a lifecycle transition performed
  // OUTSIDE the signal-driven advancement — surface the retirement through the
  // caller-provided hook (the engine runtime routes it to
  // `advance.notifyNodeTerminal`) so the monitor sees the per-node completion
  // event + durable event log line, identical to signal-driven transitions.
  onCancelled?.(node.nodeId, reason);
}

/**
 * Cancel one or more named node ids (optionally cascading to their transitive
 * downstream dependents), reusing ONLY the existing lifecycle machinery.
 *
 * Policy:
 * - Each requested id is expanded to its effective member set (loop-group
 *   targets pull in their full member set). Unknown ids are ignored (skipped).
 * - Every effective-target node in `pending | ready | running` is retired to
 *   `cancelled → done` via {@link markCancelled} / {@link markDone}, removed
 *   from the frontier, and — when a cancel seam is present and it carries a
 *   `dispatchTaskId` — has its dispatch task cancelled fire-and-forget (never
 *   awaited).
 * - With `cascade`, the effective targets' transitive downstream closure over
 *   `graphDeclaration.edges` is retired the same way.
 * - Nodes already `completed`, `blocked`, or terminal are reported in `skipped`
 *   and left untouched. The whole-graph `cancel()` path is never invoked.
 *
 * Pure synchronous state mutation + fire-and-forget dispatch teardown — never
 * awaits a cancellation acknowledgement (matches the cascade-canceller §3.3
 * convention).
 *
 * @param state         Engine state (source of per-node runtime state).
 * @param nodeIds       Node ids to cancel (loop targets expand to their members).
 * @param options       `{ cascade?: boolean }` — cascade the cancellation to
 *                      transitive downstream dependents when true.
 * @param dispatchPort  Optional cancellation seam; when omitted, only the node
 *                      lifecycle is advanced (no dispatch task teardown).
 * @param onCancelled   Optional per-node notification hook (monitor H4) invoked
 *                      with `(nodeId, reason)` for every node actually retired;
 *                      wired by the engine runtime to `notifyNodeTerminal`.
 * @returns A {@link CancelScopeReport} describing what was retired and skipped.
 */
export function cancelNodes(
  state: EngineState,
  nodeIds: string[],
  options: CancelScopeOptions = {},
  dispatchPort?: CancelDispatchPort,
  onCancelled?: CancelNodeNotifier,
): CancelScopeReport {
  const cascade = options.cascade === true;

  const target = expandLoopMembers(state, nodeIds);
  const scope = cascade ? [...downstreamClosure(state, target)] : target;

  const cancelled: string[] = [];
  const skipped: string[] = [];
  const cancelCalls: string[] = [];
  const reason = cascade
    ? `cancelled by scoped cascade from target "${target.join(",")}" in graph "${state.graphId}"`
    : `cancelled by scoped cancel of "${target.join(",")}" in graph "${state.graphId}"`;

  for (const id of scope) {
    const node = state.nodes.get(id);
    if (!node) {
      skipped.push(id); // unknown id — reported, not silently dropped
      continue;
    }
    if (!isCancellable(node)) {
      skipped.push(id);
      continue;
    }
    cancelOne(state, node, reason, dispatchPort, cancelCalls, onCancelled);
    cancelled.push(id);
  }

  return { target, cancelled, skipped, cancelCalls };
}
