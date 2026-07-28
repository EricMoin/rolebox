import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, atomicWriteSync } from "../function/fs-util.ts";
import { shortHash } from "../utils/state-paths.ts";
import { createSubLogger } from "../logger.ts";
import { SIGNAL_TYPE, TERMINATING_SIGNALS_BY_SEVERITY } from "./signal-constants.ts";

export { SIGNAL_TYPE } from "./signal-constants.ts";

const log = createSubLogger("session-signal-ledger");

/**
 * HITL (human-in-the-loop) signals in descending priority order.
 * `getHitlSignal` returns the first one present.
 */
const HITL_PRIORITY = [
  SIGNAL_TYPE.NEED_APPROVAL,
  SIGNAL_TYPE.BLOCKED,
  SIGNAL_TYPE.NEED_CLARIFICATION,
] as const;

// ── Data shapes ────────────────────────────────────────────────────────────

interface SignalRecord {
  type: string;
  payload: unknown;
}

interface LedgerFileShape {
  version: 1;
  sessions: { sessionId: string; signals: SignalRecord[] }[];
}

// ── Persistent store (mirrors FunctionRuntimeStore) ────────────────────────

class SessionSignalLedgerStore {
  private directory: string;
  private dirHash: string;
  private _lock: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.directory = directory;
    this.dirHash = shortHash(directory);
  }

  private statePath(): string {
    return join(
      this.directory,
      ".rolebox",
      "state",
      `signalledger-${this.dirHash}.json`,
    );
  }

  private toFile(
    signals: Map<string, Map<string, SignalRecord>>,
  ): string {
    const sessions = [...signals].map(([sessionId, sigMap]) => ({
      sessionId,
      signals: [...sigMap.values()],
    }));
    return JSON.stringify(
      { version: 1, sessions } satisfies LedgerFileShape,
      null,
      2,
    );
  }

  async save(
    signals: Map<string, Map<string, SignalRecord>>,
  ): Promise<void> {
    this._lock = this._lock.then(
      () => this._doSave(signals),
      () => this._doSave(signals),
    );
    return this._lock;
  }

  private async _doSave(
    signals: Map<string, Map<string, SignalRecord>>,
  ): Promise<void> {
    try {
      await atomicWrite(this.statePath(), this.toFile(signals));
    } catch (err) {
      log.warn("SessionSignalLedgerStore._doSave failed", err);
    }
  }

  saveSync(signals: Map<string, Map<string, SignalRecord>>): void {
    try {
      atomicWriteSync(this.statePath(), this.toFile(signals));
    } catch (err) {
      log.warn("SessionSignalLedgerStore.saveSync failed", err);
    }
  }

  load(): Map<string, Map<string, SignalRecord>> | null {
    let raw: string;
    try {
      raw = readFileSync(this.statePath(), "utf-8");
    } catch {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as LedgerFileShape;
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
        return null;
      }
      const out = new Map<string, Map<string, SignalRecord>>();
      for (const s of parsed.sessions) {
        const m = new Map<string, SignalRecord>();
        for (const sig of s.signals) {
          m.set(sig.type, sig);
        }
        out.set(s.sessionId, m);
      }
      return out;
    } catch {
      return null;
    }
  }
}

// ── Session-level signal ledger ────────────────────────────────────────────

/**
 * A session-level signal ledger keyed by sessionID, independent of function
 * activation. Records signals emitted during a session and provides lookup
 * for terminating and HITL (human-in-the-loop) signals.
 *
 * Persistence mirrors the {@link FunctionRuntimeManager} pattern:
 * `setStoreDirectory` wires the store, `recover` hydrates from disk,
 * and every mutation debounce-persists.
 */
export class SessionSignalLedger {
  private signals = new Map<string, Map<string, SignalRecord>>();
  private store?: SessionSignalLedgerStore;
  private _dirty = false;
  private _timer?: ReturnType<typeof setTimeout>;

  // ── Store wiring ─────────────────────────────────────────────────────────

  /** Set the directory used for persistence (state file path derived from it). */
  setStoreDirectory(dir: string): void {
    this.store = new SessionSignalLedgerStore(dir);
  }

  /** Hydrate in-memory state from the persisted ledger file. */
  recover(): void {
    if (!this.store) return;
    const loaded = this.store.load();
    if (loaded) this.signals = loaded;
  }

  // ── Mutation ─────────────────────────────────────────────────────────────

  /**
   * Record a signal for the given session.
   *
   * - `payload` is normalized to `null` when absent or `undefined`.
   * - Recording the same type again overwrites the previous entry.
   */
  record(sessionID: string, type: string, payload?: unknown): void {
    let sessionSignals = this.signals.get(sessionID);
    if (!sessionSignals) {
      sessionSignals = new Map();
      this.signals.set(sessionID, sessionSignals);
    }
    sessionSignals.set(type, {
      type,
      payload: payload !== undefined ? payload : null,
    });
    this._persist();
  }

  // ── Query ────────────────────────────────────────────────────────────────

  /**
   * Return the highest-severity terminating signal for `sessionID`, or `null`
   * if none has been recorded.
   *
   * Severity order: escalate > revise_needed > answer.
   */
  getTerminating(sessionID: string): {
    type: string;
    payload: unknown;
  } | null {
    const sessionSignals = this.signals.get(sessionID);
    if (!sessionSignals) return null;
    for (const type of TERMINATING_SIGNALS_BY_SEVERITY) {
      const record = sessionSignals.get(type);
      if (record) return { type: record.type, payload: record.payload };
    }
    return null;
  }

  /**
   * Return the first HITL signal recorded for `sessionID`, or `null` if
   * none has been recorded.
   *
   * Priority order: need_approval > blocked > need_clarification.
   */
  getHitlSignal(sessionID: string): {
    type: string;
    payload: unknown;
  } | null {
    const sessionSignals = this.signals.get(sessionID);
    if (!sessionSignals) return null;
    for (const type of HITL_PRIORITY) {
      const record = sessionSignals.get(type);
      if (record) return { type: record.type, payload: record.payload };
    }
    return null;
  }

  /**
   * Check whether a signal of the given `type` has been recorded for
   * `sessionID`.
   */
  hasSignal(sessionID: string, type: string): boolean {
    return this.signals.get(sessionID)?.has(type) ?? false;
  }

  // ── Session lifecycle ────────────────────────────────────────────────────

  /** Remove all signals recorded for `sessionID`. */
  clearSession(sessionID: string): void {
    this.signals.delete(sessionID);
    this._persist();
  }

  // ── Persistence (debounced, mirrors FunctionRuntimeManager) ──────────────

  private _persist(): void {
    if (!this.store) return;
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = undefined;
      if (!this._dirty) return;
      this._dirty = false;
      this.store!.save(this.signals).catch((err) => {
        log.warn("Failed to persist session signal ledger", { err });
      });
    }, 500);
  }

  /** Flush any pending debounced persist synchronously. */
  flushSync(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
    if (!this._dirty || !this.store) return;
    this._dirty = false;
    this.store.saveSync(this.signals);
  }

  /**
   * Clear all in-memory state without creating a new instance.
   * Used by state-registry reset to avoid split-brain (multiple instances).
   * Does NOT persist the empty state — caller re-initializes as needed.
   */
  resetAll(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
    this.signals.clear();
    this._dirty = false;
  }
}

/** Singleton instance of the session-level signal ledger. */
export const sessionSignalLedger = new SessionSignalLedger();
