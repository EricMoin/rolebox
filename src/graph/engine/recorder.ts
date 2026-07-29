/**
 * Graph Execution Engine v2 — Runtime Recorders (Subtask C-RECORD)
 *
 * Version: 2.0
 * Date: 2026-07-25
 *
 * The engine's mutation points write real execution data into the
 * OPTIONAL-ADDITIVE runtime fields declared by subtask C-STATE
 * (`src/types.engine-v2.ts`):
 *
 *   - `EngineState.checkpoints[nodeId]`      — lifecycle-transition snapshots
 *   - `LoopGroupRuntimeState.rounds[]`        — completed traversal-round history
 *   - `NodeRuntimeState.artifacts`            — genuinely produced artifact paths
 *   - `NodeRuntimeState.evidence`             — genuinely emitted evidence references
 *
 * Central rule: **a field is written only from real observed data; it is never
 * fabricated.** When nothing was actually recorded, the optional field stays
 * absent (the engine and persistence treat absence and emptiness identically).
 * The dual-write of `SignalLedgerEntry.history` lives at the signal-delivery
 * seam in `signal-bridge.ts:record` (subtask 6) and is NOT touched here — this
 * module owns the loop/lifecycle/result recorder points only.
 *
 * All recorders are pure additions at existing mutation points; they never
 * rewrite lifecycle or loop logic. They are safe to call in any order and are
 * idempotent with respect to data (each appends / overwrites a genuine snapshot).
 *
 * Design reference: `.rolebox/design/engine-state-machine.md` §2 (lifecycle),
 * `.rolebox/design/graph-model.md` §4 (bounded-cycle loop rounds).
 */

import { NodeStatus } from "../../constants.ts";
import type {
  CheckpointRecord,
  EngineState,
  LoopGroupRuntimeState,
  NodeRuntimeState,
  RoundHistoryEntry,
} from "../../types.engine-v2.ts";
import { markDirty } from "./engine-persistence.ts";

// ── Checkpoints (EngineState.checkpoints) ───────────────────────────────────

/**
 * Auto-save a {@link CheckpointRecord} into the owning state's
 * `EngineState.checkpoints[nodeId]` for a lifecycle status change.
 *
 * Called from `node-lifecycle.ts:transitionNode` after every legal transition
 * (`from → to`). Each transition overwrites the node's checkpoint slot with the
 * LATEST snapshot — `checkpoints` is a `Record<nodeId, CheckpointRecord>`, so a
 * node carries only its most recent status snapshot (matching the
 * `graph_status` `include_checkpoint` semantics). The record is built entirely
 * from real data: the node's own id, the actual `to` status, and a genuine
 * epoch-ms timestamp.
 *
 * In parallel, the same record is APPENDED to
 * `EngineState.checkpointHistory[nodeId]` (an ordered, additive list), so every
 * transition a node passes through is retained for traceability — not just the
 * latest one. Both fields are written from the same real data; neither is ever
 * fabricated.
 *
 * When `state` is falsy (standalone unit construction without an engine), this
 * is a no-op — no checkpoint is invented for a state that does not exist.
 */
export function recordCheckpointForNode(
  state: EngineState,
  node: NodeRuntimeState,
  _from: NodeStatus,
  to: NodeStatus,
  at: number,
): void {
  if (!state) return;
  const record: CheckpointRecord = { nodeId: node.nodeId, status: to, at };
  if (!state.checkpoints) {
    state.checkpoints = {};
  }
  state.checkpoints[node.nodeId] = record;
  // Append to the ordered per-node history (append-only traceability).
  if (!state.checkpointHistory) {
    state.checkpointHistory = {};
  }
  const history = state.checkpointHistory[node.nodeId] ?? [];
  history.push(record);
  state.checkpointHistory[node.nodeId] = history;
  state.updatedAt = at;
  markDirty(state);
}

// ── Loop round history (LoopGroupRuntimeState.rounds) ───────────────────────

/**
 * Append a completed traversal-round snapshot to a loop group's `rounds`.
 *
 * Callers build the entry from genuinely observed round data (round number,
 * current traversal count, the node ids re-entered this round, the aggregate
 * status, and real timestamps). The array is OPTIONAL-ADDITIVE: it is created
 * on the first recorded round and appended to thereafter, preserving order.
 */
export function recordLoopRound(
  state: EngineState,
  groupId: string,
  entry: RoundHistoryEntry,
): void {
  const group = state.loopGroups.get(groupId);
  if (!group) return;
  if (!group.rounds) {
    group.rounds = [];
  }
  group.rounds.push(entry);
  state.updatedAt = Date.now();
  markDirty(state);
}

// ── Artifacts / evidence (NodeRuntimeState.artifacts / evidence) ────────────

/**
 * Genuinely produced artifact file paths for a node, derived at completion.
 *
 * The only artifact the engine actually materializes today is the result
 * sidecar file (`MaterializedResultRef.sidecarPath`). When a completed node has
 * a non-failing materialized result, that sidecar is a real, produced file and
 * is recorded. When the node produced no materialized result (or materialization
 * failed), this returns an empty list — never an invented path.
 */
export function deriveNodeArtifacts(node: NodeRuntimeState): string[] {
  const ref = node.result;
  if (ref && ref.sidecarPath && !ref.fetchError) {
    return [ref.sidecarPath];
  }
  return [];
}

/**
 * Genuinely emitted evidence references for a node, derived from its terminal
 * signal payload.
 *
 * "Evidence" here is read strictly from what the worker actually emitted: a
 * terminal signal (`answer` / `revise_needed` / `escalate`) whose payload is an
 * object carrying an array-valued `evidence` field of strings. Only that
 * real payload is reflected; a node whose signals carry no such field yields an
 * empty list (no fabrication). Priorities mirror the escalation lattice so the
 * most severe terminal payload's evidence wins.
 */
export function deriveNodeEvidence(node: NodeRuntimeState): string[] {
  const terminalOrder: ("escalate" | "revise_needed" | "answer")[] = [
    "escalate",
    "revise_needed",
    "answer",
  ];
  for (const type of terminalOrder) {
    const payload = node.signalsObserved[type];
    if (payload === null || payload === undefined) continue;
    if (typeof payload === "object" && !Array.isArray(payload)) {
      const evidence = (payload as Record<string, unknown>).evidence;
      if (
        Array.isArray(evidence) &&
        evidence.every((e) => typeof e === "string")
      ) {
        return [...evidence];
      }
    }
  }
  return [];
}

/**
 * Record a completed node's genuinely produced artifacts and evidence into its
 * runtime state. Each field is written only when the derivation produced a
 * non-empty result; otherwise it stays absent (honest empty).
 */
export function recordNodeArtifactsAndEvidence(
  state: EngineState,
  node: NodeRuntimeState,
): void {
  let written = false;
  const artifacts = deriveNodeArtifacts(node);
  if (artifacts.length > 0) {
    node.artifacts = artifacts;
    written = true;
  }
  const evidence = deriveNodeEvidence(node);
  if (evidence.length > 0) {
    node.evidence = evidence;
    written = true;
  }
  if (written) {
    state.updatedAt = Date.now();
    markDirty(state);
  }
}
