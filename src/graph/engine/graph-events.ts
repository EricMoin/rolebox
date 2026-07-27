/**
 * Graph Engine — Write-Side Durable Graph Event Log
 *
 * A best-effort, append-only JSON-lines event log for a graph execution
 * instance. {@link GraphEventRecorder} records the write-side transitions an
 * engine performs — node dispatch, node terminal transition, engine phase
 * change, and budget update — so a running graph can be audited / replayed
 * after the fact from `.rolebox/state/graph-events-{hash}.ndjson`.
 *
 * Durability contract:
 *
 * - **Append-only.** One JSON line per event, written synchronously via
 *   `appendFileSync`. Each event is a single, complete line (the JSON record +
 *   a newline in one write call) so a reader never observes a half-written
 *   line from this writer.
 * - **Total.** A recorder never throws. Any write failure (missing/uncreatable
 *   directory, filesystem error, corrupt path) is swallowed and the engine
 *   proceeds — this is observability, never a control path. `JSON.stringify`
 *   on a JSON-safe record cannot throw.
 * - **No-op-safe.** With no `stateDir` configured no recorder is constructed,
 *   so there is no file activity and the engine behaves exactly as before.
 *
 * The phase-change and budget-event sinks live in `engine-state.ts`
 * (`setPhaseEventSink` / `setBudgetEventSink`) so the engine's pure
 * `transitionPhase` / `applyBudgetDelta` can reach the recorder without an
 * import cycle. Constructing a recorder registers those sinks; a recorder is
 * the only writer, so the module-level sink is last-writer-wins (single-engine
 * execution).
 *
 * Writes mirror the `engine-persistence.ts` philosophy (write-through, never
 * breaks advancement) but use `appendFileSync` for the log instead of a
 * `.tmp`+`rename` snapshot, because an event log must *accumulate* rather than
 * overwrite.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { EnginePhase } from "../../constants.ts";
import type { GraphBudgetState } from "../../types.engine-v2.ts";
import type { NodeCompletionEvent } from "./engine-advance.ts";

// ── Event vocabulary ────────────────────────────────────────────────────────

/**
 * The kinds of write-side graph events this log records.
 *
 * - `node_dispatched` — a ready node became `running` and was launched.
 * - `node_completed` — a node reached a terminal / notable transition
 *   (`answer` / `revise_needed` / `escalate` / `timeout`, carrying `nodeStatus`).
 * - `phase_change` — the engine lifecycle advanced `idle → executing → complete`.
 * - `budget_update` — graph-level cumulative budget counters were updated.
 */
export type GraphEventType =
  | "node_dispatched"
  | "node_completed"
  | "phase_change"
  | "budget_update";

/**
 * One JSON line in the event log. Optional fields (`?`) are omitted from the
 * serialized line when undefined (JSON-safe): a `node_dispatched` line has no
 * `signalType`/`completedAt`, a `phase_change` line has no `nodeId`, etc.
 */
export interface GraphEventRecord {
  /** Epoch-ms timestamp when the event was recorded. */
  ts: number;
  /** Owning graph id. */
  graphId: string;
  /** Node id — present for node-scoped events (`node_dispatched` / `node_completed`). */
  nodeId?: string;
  /** The event kind. */
  event: GraphEventType;
  /**
   * A generic status: the target `EnginePhase` for `phase_change`, the
   * `NodeStatus` for `node_completed`, `"running"` for `node_dispatched`.
   */
  status?: string;
  /** The terminating signal for `node_completed` (`answer` / `revise_needed` / …). */
  signalType?: string;
  /** The node's bound agent id (node-scoped events). */
  agent?: string;
  /** When the node started (node-scoped events). */
  startedAt?: number;
  /** When the node completed (node_completed). */
  completedAt?: number;
  /** The cumulative graph budget snapshot for `budget_update`. */
  budget?: GraphBudgetState;
}

// ── Path helpers ────────────────────────────────────────────────────────────

/**
 * Derive the stable per-graph event-log filename fragment from a `graphId`.
 *
 * The hash (rather than the raw graph id) keeps the filename short and free of
 * any id characters that are unsafe on disk; hashing the graph id (not a random
 * nonce) means the same graph maps to the same file across a crash / recovery,
 * which is exactly what a durable audit log wants.
 */
export function graphEventsHash(graphId: string): string {
  return createHash("sha256").update(graphId).digest("hex").slice(0, 12);
}

/** Absolute path to a graph's event log: `.rolebox/state/graph-events-{hash}.ndjson`. */
export function graphEventsPath(directory: string, graphId: string): string {
  return join(
    directory,
    ".rolebox",
    "state",
    `graph-events-${graphEventsHash(graphId)}.ndjson`,
  );
}

// ── Recorder ────────────────────────────────────────────────────────────────

/**
 * Append-only, total JSON-lines event recorder for a single graph instance.
 *
 * Construct with a workspace directory (defaults to `process.cwd()`); the log
 * lives under `.rolebox/state/`. The recorder registers itself as the
 * phase-change and budget-event sinks in `engine-state.ts` so the engine's
 * pure transition functions can reach it. All public methods are total —
 * none of them throw, so wiring this into the engine can never break graph
 * advancement (identical discipline to `EnginePersistence.save`).
 */
export class GraphEventRecorder {
  private readonly directory: string;

  constructor(directory?: string) {
    this.directory = directory ?? process.cwd();
    // Sinks are now wired onto EngineState by the engine runtime at construction
    // (see EngineRuntimeImpl in index.ts). The recorder no longer registers
    // module-level singletons — those were removed to eliminate mutable global
    // state and the risk of stale function references in deserialized states.
  }

  // ── Event emitters (all total — never throw) ──────────────────────────────

  /** Record that a node was dispatched (ready → running, launched). */
  nodeDispatched(
    graphId: string,
    nodeId: string,
    agent: string,
    startedAt?: number,
  ): void {
    this._append({
      ts: Date.now(),
      graphId,
      nodeId,
      event: "node_dispatched",
      status: "running",
      agent,
      startedAt,
    });
  }

  /**
   * Record a node's terminal / notable transition, derived directly from the
   * engine's {@link NodeCompletionEvent} (the same immutable facts the
   * `onNodeCompletion` notifier seam carries). Covers `answer` /
   * `revise_needed` / `escalate` / `timeout` with the node's lifecycle status.
   */
  nodeCompleted(event: NodeCompletionEvent): void {
    this._append({
      ts: Date.now(),
      graphId: event.graphId,
      nodeId: event.nodeId,
      event: "node_completed",
      status: event.nodeStatus,
      signalType: event.signalType,
      agent: event.nodeAgent,
      startedAt: event.startedAt,
      completedAt: event.completedAt,
    });
  }

  /** Record an engine lifecycle phase transition (`idle → executing → complete`). */
  phaseChange(graphId: string, from: EnginePhase, to: EnginePhase): void {
    // `status` carries the target phase (the resulting engine phase, which is
    // the meaningful state). `from` is retained by the engine sink but is not
    // part of the serialized record shape.
    void from;
    this._append({
      ts: Date.now(),
      graphId,
      event: "phase_change",
      status: to,
    });
  }

  /** Record a graph-level cumulative budget update (snapshot of the counters). */
  budgetUpdate(graphId: string, budget: GraphBudgetState): void {
    this._append({
      ts: Date.now(),
      graphId,
      event: "budget_update",
      budget,
    });
  }

  // ── Low-level write (the only point that touches the filesystem) ──────────

  /**
   * Append one event line. Creates `.rolebox/state/` on demand and appends a
   * single complete line (`JSON.stringify(record) + "\n"`). Never throws: every
   * failure path (mkdir, append) is swallowed so a disk problem degrades to a
   * dropped log line, not a broken engine. JSON-safe records mean stringify
   * cannot throw.
   */
  private _append(record: GraphEventRecord): void {
    try {
      const path = graphEventsPath(this.directory, record.graphId);
      mkdirSync(join(path, ".."), { recursive: true });
      appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
    } catch {
      // Observability only — a failed write must never break graph advancement.
    }
  }
}
