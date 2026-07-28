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
import { markDirty } from "./engine-persistence.ts";

// ── Signal-type vocabulary (imported from src/signal/signal-constants.ts) ────

import {
  SIGNAL_TYPES,
  TERMINATING_SIGNALS,
  PAUSING_SIGNALS,
  HANDOFF_SIGNALS,
  INFO_SIGNALS,
  type SignalType,
} from "../../signal/signal-constants.ts";
export { SIGNAL_TYPES, TERMINATING_SIGNALS, PAUSING_SIGNALS, HANDOFF_SIGNALS, INFO_SIGNALS, type SignalType };

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
    const now = Date.now();
    const value = payload !== undefined ? payload : null;

    const node = state.nodes.get(nodeId);
    if (node) {
      node.signalsObserved[type] = value;
    }

    // Build the timestamped history event. Payload is normalized to `null`
    // when absent, mirroring the `signals` field behavior just below.
    const event: SignalLedgerEvent = { signal: type, payload: value, atMs: now, source };

    // Keep the graph-level signal ledger in sync (lastSignalAt timestamp +
    // ordered history). The `history` array is OPTIONAL-ADDITIVE — it is
    // created on first signal and appended to on every subsequent emission.
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
    state.updatedAt = now;
    markDirty(state);

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
