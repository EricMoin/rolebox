/**
 * Graph Execution Engine v2 — Signal Bridge
 *
 * Version: 2.0
 * Date: 2026-07-24
 *
 * A read-only seam over the signal subsystem. When a graph node emits a
 * `signal()` call, the engine intercepts it here and:
 *
 * 1. Records the signal (type → payload) into the per-node
 *    `NodeRuntimeState.signalsObserved` ledger.
 * 2. For **terminating** signals, fires the `onNodeSignalEmitted` callback
 *    hook (implemented in a later subtask — this module only defines the
 *    interface and the callback-injection point).
 *
 * The 8-signal vocabulary is imported from `src/signal/signal-constants.ts`
 * (the single source of truth), then re-exported for backward-compatible
 * engine-side consumption. No signal-type definitions live here — every
 * constant is routed through `signal-constants.ts`.
 *
 * Design reference: `.rolebox/design/engine-state-machine.md` §3.4.
 */

import type { EngineState, SignalLedgerEvent, SignalLedgerSource } from "../../types.engine-v2.ts";
import { markNonCriticalDirty } from "./engine-persistence.ts";

// ── Signal-type vocabulary (imported from src/signal/signal-constants.ts) ────

import {
  SIGNAL_TYPES,
  TERMINATING_SIGNALS,
  PAUSING_SIGNALS,
  HANDOFF_SIGNALS,
  INFO_SIGNALS,
  ALL_SIGNAL_TYPES,
  type SignalType,
} from "../../signal/signal-constants.ts";
export { SIGNAL_TYPES, TERMINATING_SIGNALS, PAUSING_SIGNALS, HANDOFF_SIGNALS, INFO_SIGNALS, ALL_SIGNAL_TYPES, type SignalType };

// ── Callback interface (injection point for subtask 6) ──────────────────────

/**
 * Fired when a graph node emits a **terminating** signal.
 *
 * Implemented in a later subtask. This bridge defines the contract and the
 * injection point only — the implementation advances the node lifecycle
 * (running → completed/escalate), materializes results, and propagates edge
 * payloads.
 */
export type NodeSignalEmittedListener = (
  nodeId: string,
  type: SignalType,
  payload: unknown,
) => void;

// ── Shared ledger-write helper ──────────────────────────────────────────────

/**
 * Record a signal into the per-node ledger WITHOUT firing terminating
 * listeners. This is the single ledger-write path for the engine's synthetic
 * signal producers (the approval handler and the engine-advance race-guard
 * deferral) so `SignalLedgerEntry.history` / `lastSignalAt` stay complete for
 * every signal the engine records — matching live-worker signals that flow
 * through {@link SignalBridge.record}.
 *
 * - Writes `node.signalsObserved[type] = value` (payload normalized to `null`
 *   when absent, mirroring `SignalBridge.record` semantics).
 * - Updates the graph-level `signalLedger` entry (signals, lastSignalAt,
 *   ordered history) — the single ledger-write path that
 *   {@link SignalBridge.record} delegates to.
 * - Does NOT fire terminating listeners: firing is the control-flow concern
 *   owned by {@link SignalBridge.record}. Synthetic producers must not trigger
 *   re-entrant advancement, so they route through this pure helper instead.
 *
 * For non-signal context stashes (e.g. `approval_payload`) the node write is
 * performed but no ledger event is synthesized — the history backs real
 * signals only, per the `SignalLedgerEntry` contract in types.engine-v2.ts.
 *
 * @param state    Engine state (used for the graph-level `signalLedger` write).
 * @param nodeId   The node the signal is recorded for.
 * @param type     Signal type (or a non-signal stash key, e.g. `approval_payload`).
 * @param payload  Optional signal payload.
 * @param source   Origin discriminator for the ledger event.
 */
export function recordSignalToLedger(
  state: EngineState,
  nodeId: string,
  type: string,
  payload?: unknown,
  source: SignalLedgerSource = "dispatch",
): void {
  const now = Date.now();
  const value = payload !== undefined ? payload : null;

  const node = state.nodes.get(nodeId);
  if (node) {
    node.signalsObserved[type] = value;
  }

  // Only real signals enter the ledger history. Non-signal context stashes
  // (e.g. `approval_payload`) are written to node.signalsObserved but never
  // synthesized as ledger events.
  if (ALL_SIGNAL_TYPES.has(type)) {
    const event: SignalLedgerEvent = { signal: type, payload: value, atMs: now, source };
    const existing = state.signalLedger.get(nodeId);
    if (existing) {
      existing.signals[type] = value;
      existing.lastSignalAt = now;
      if (existing.history) {
        existing.history.push(event);
      } else {
        existing.history = [event];
      }
    } else {
      state.signalLedger.set(nodeId, {
        signals: { [type]: value },
        lastSignalAt: now,
        history: [event],
      });
    }
  }

  state.updatedAt = now;
  // Signal-ledger history is non-critical churn (telemetry) — route through
  // the debounced tier. When the signal also drives a node lifecycle
  // transition, that transition marks the state critically dirty (sync write).
  markNonCriticalDirty(state);
}

// ── SignalBridge ────────────────────────────────────────────────────────────

/**
 * Intercepts signal emission for graph nodes and records it into per-node
 * runtime state. Owns the terminating-signal callback registry so a later
 * subtask can register its node-advancement handler without this module
 * knowing the concrete behavior.
 */
export class SignalBridge {
  /** Registered `onNodeSignalEmitted` listeners, keyed by nothing — all fire. */
  private listeners = new Set<NodeSignalEmittedListener>();

  /**
   * Register a terminating-signal listener. Returns an unsubscribe function.
   * Multiple listeners may be registered; each fires for every terminating signal.
   */
  onNodeSignalEmitted(listener: NodeSignalEmittedListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Remove all registered terminating-signal listeners. */
  clearListeners(): void {
    this.listeners.clear();
  }

  /**
   * Record a signal for the given node, then fire terminating listeners.
   *
   * - Writes `node.signalsObserved[type] = payload ?? null` (payload is `null`
   *   when absent, matching `signal-ledger.ts:recordSignal` semantics).
   * - Also updates the graph `signalLedger` entry (`lastSignalAt`) when a
   *   state is supplied.
   * - Returns `true` when the signal is terminating (a listener was fired).
   *
   * @param state    Optional engine state — when provided, the graph-level
   *                 `signalLedger` history entry is kept in sync.
   * @param source   Origin discriminator for this signal event (dispatch /
   *                 recovery / deferred / race_guard).
   * @returns `true` if `type` is terminating, `false` otherwise.
   */
  record(
    state: EngineState,
    nodeId: string,
    type: SignalType,
    payload?: unknown,
    source: SignalLedgerSource = "dispatch",
  ): boolean {
    // Single ledger-write path — the pure helper writes the node's
    // signalsObserved and the graph-level signalLedger (signals, lastSignalAt,
    // history). This method then owns the control-flow half: firing terminating
    // listeners.
    recordSignalToLedger(state, nodeId, type, payload, source);

    if (!TERMINATING_SIGNALS.has(type)) {
      return false;
    }

    for (const listener of this.listeners) {
      try {
        listener(nodeId, type, payload);
      } catch {
        // Listener failures must not break signal recording — swallow.
      }
    }
    return true;
  }

  // ── Signal classification helpers (single source: categories above) ───

  isTerminating(type: string): boolean {
    return TERMINATING_SIGNALS.has(type);
  }

  isPausing(type: string): boolean {
    return PAUSING_SIGNALS.has(type);
  }

  isHandoff(type: string): boolean {
    return HANDOFF_SIGNALS.has(type);
  }

  isInfo(type: string): boolean {
    return INFO_SIGNALS.has(type);
  }
}
