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
 *     (DERIVED latest view of `checkpointHistory[nodeId]` — see Y9 below)
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
import { TERMINATING_SIGNALS_BY_SEVERITY } from "../../signal/signal-constants.ts";
import type {
  CheckpointRecord,
  EngineState,
  LoopGroupRuntimeState,
  NodeRuntimeState,
  RoundHistoryEntry,
} from "../../types.engine-v2.ts";
import { markDirty } from "../persistence/engine-persistence.ts";
import { asRecord } from "../tools/signal-payload.ts";

// ── Checkpoints (EngineState.checkpoints) ───────────────────────────────────

/**
 * Maximum number of checkpoint-history entries retained per node.
 *
 * The history (`EngineState.checkpointHistory[nodeId]`) is an append-only
 * traceability list; bounding it keeps long loop/retry chains from growing it
 * without limit. Only the history is trimmed — the latest snapshot in
 * `EngineState.checkpoints[nodeId]` is never dropped.
 */
const CHECKPOINT_HISTORY_CAP = 50;

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
 * The same record is APPENDED to `EngineState.checkpointHistory[nodeId]` (an
 * ordered, additive list), so every transition a node passes through is
 * retained for traceability — not just the latest one.
 *
 * Y9 write-side contract (N1): `checkpointHistory` is the AUTHORITATIVE
 * append-only list and `checkpoints` is its DERIVED latest-snapshot view.
 * There is exactly one write source — the history — and the single-snapshot
 * field is assigned from the history's tail, so the two fields can never
 * disagree (the previous implementation wrote the same record into both slots
 * independently, which is only consistent by construction-by-hand). A legacy
 * state that carries a `checkpoints` entry but no history keeps that entry
 * until the node's next transition; the derived view then holds the new
 * transition (the old snapshot was only ever a latest-snapshot, not history).
 *
 * `state` is required (B12): every caller is a live engine state. The former
 * `if (!state) return` guard was unreachable under the declared signature and
 * its JSDoc invited a construction mode no caller uses.
 */
export function recordCheckpointForNode(
  state: EngineState,
  node: NodeRuntimeState,
  _from: NodeStatus,
  to: NodeStatus,
  at: number,
): void {
  const record: CheckpointRecord = { nodeId: node.nodeId, status: to, at };
  // Append to the authoritative ordered per-node history.
  if (!state.checkpointHistory) {
    state.checkpointHistory = {};
  }
  const history = state.checkpointHistory[node.nodeId] ?? [];
  history.push(record);
  // Retain only the most recent CHECKPOINT_HISTORY_CAP entries — the history
  // is traceability, not the latest snapshot, so trimming the front keeps it
  // bounded in long loop/retry chains without losing the newest transitions.
  if (history.length > CHECKPOINT_HISTORY_CAP) {
    history.splice(0, history.length - CHECKPOINT_HISTORY_CAP);
  }
  state.checkpointHistory[node.nodeId] = history;
  // Derive the latest-snapshot view from the authoritative history (Y9). A
  // defensive copy keeps the two fields from aliasing the same record object.
  const latest = history[history.length - 1];
  if (!state.checkpoints) {
    state.checkpoints = {};
  }
  state.checkpoints[node.nodeId] = { ...latest };
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
  // Severity order comes from the shared single source of truth
  // (`signal-constants.ts` TERMINATING_SIGNALS_BY_SEVERITY, L1) so a new
  // terminating signal type cannot silently fork this precedence.
  for (const type of TERMINATING_SIGNALS_BY_SEVERITY) {
    const payload = node.signalsObserved[type];
    if (payload === null || payload === undefined) continue;
    const evidence = asRecord(payload)?.evidence;
    if (
      Array.isArray(evidence) &&
      evidence.every((e) => typeof e === "string")
    ) {
      return [...evidence];
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
