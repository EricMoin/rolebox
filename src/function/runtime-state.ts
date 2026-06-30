import { FunctionRuntimeStore } from "./runtime-store.ts";

export interface FnState {
  phase: "active" | "gated" | "complete";
  activatedAtTurn: number;
  currentTurn: number;
  evidenceObserved: Record<string, boolean>;
  toolsObserved: string[];
  continuationCount: number;
  cooldownUntilTurn: number;
  gateSatisfied: boolean;
  kv: Record<string, unknown>;
  schemaVersion: number;
}

// sessionID -> functionName -> FnState
export class FunctionRuntimeManager {
  private states = new Map<string, Map<string, FnState>>();
  private store?: FunctionRuntimeStore;
  private _dirty = false;
  private _timer?: ReturnType<typeof setTimeout>;

  setStoreDirectory(dir: string): void {
    this.store = new FunctionRuntimeStore(dir);
  }

  init(sessionID: string, fn: string, schemaVersion: number): FnState {
    let m = this.states.get(sessionID);
    if (!m) {
      m = new Map();
      this.states.set(sessionID, m);
    }
    const existing = m.get(fn);
    // Schema skew → reset
    if (existing && existing.schemaVersion !== schemaVersion) m.delete(fn);
    if (!m.has(fn)) {
      m.set(fn, {
        phase: "active",
        activatedAtTurn: 0,
        currentTurn: 0,
        evidenceObserved: {},
        toolsObserved: [],
        continuationCount: 0,
        cooldownUntilTurn: 0,
        gateSatisfied: false,
        kv: {},
        schemaVersion,
      });
      this._persist();
    }
    return m.get(fn)!;
  }

  get(sessionID: string, fn: string): FnState | undefined {
    return this.states.get(sessionID)?.get(fn);
  }

  all(sessionID: string): Map<string, FnState> {
    return this.states.get(sessionID) ?? new Map();
  }

  markDirty(): void {
    this._persist();
  }

  clearSession(sessionID: string): void {
    this.states.delete(sessionID);
    this._persist();
  }

  private _persist(): void {
    if (!this.store) return;
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = undefined;
      if (!this._dirty) return;
      this._dirty = false;
      this.store!.save(this.states).catch(() => {});
    }, 500);
  }

  flushSync(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
    if (!this._dirty || !this.store) return;
    this._dirty = false;
    this.store.saveSync(this.states);
  }

  recover(): void {
    if (!this.store) return;
    const loaded = this.store.load();
    if (loaded) this.states = loaded;
  }

  /**
   * Clear all in-memory state without creating a new instance.
   * Used by state-registry reset to avoid split-brain (multiple instances).
   * Does NOT persist the empty state — caller re-initializes as needed via init().
   */
  resetAll(): void {
    if (this._timer) { clearTimeout(this._timer); this._timer = undefined; }
    this.states.clear();
    this._dirty = false;
  }
}

export const functionRuntime = new FunctionRuntimeManager();
