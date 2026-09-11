import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, atomicWriteSync } from "../function/fs-util.ts";
import { shortHash } from "../utils/state-paths.ts";
import type { LoopPhase, LoopState } from "./types.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("loop-store");

interface FileShape {
  version: number;
  loops: { id: string; state: LoopState }[];
}

const TERMINAL_PHASES: ReadonlySet<LoopPhase> = new Set([
  "complete",
  "cancelled",
  "interrupted",
  "error",
]);

export function isTerminalPhase(phase: LoopPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

export interface WorkerTaskState {
  /** "pending" | "running" | "completed" | "error" | "cancelled" | "timeout" */
  status: string;
  /** False when the task ID is unknown to the dispatch system. */
  exists: boolean;
}

export class LoopStore {
  private directory: string;
  private dirHash: string;

  // ── Debounce fields ─────────────────────────────────────────────────────
  private _latestLoops: Map<string, LoopState> | null = null;
  private _dirty = false;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _resolveFns: Array<() => void> = [];

  constructor(directory: string) {
    this.directory = directory;
    this.dirHash = shortHash(directory);
  }

  private statePath(): string {
    return join(this.directory, ".rolebox", "state", `loops-${this.dirHash}.json`);
  }

  private toFile(loops: Map<string, LoopState>): string {
    const entries = [...loops].map(([id, state]) => ({ id, state }));
    return JSON.stringify({ version: 3, loops: entries } satisfies FileShape, null, 2);
  }

  /**
   * Debounced save: stores the latest loops reference, sets dirty flag,
   * and restarts a 200ms timer. When the timer fires, the I/O is performed
   * and all pending promises are resolved.
   *
   * Multiple rapid calls are coalesced into a single I/O operation.
   */
  async save(loops: Map<string, LoopState>): Promise<void> {
    this._latestLoops = loops;
    this._dirty = true;

    // Clear any existing timer — restart the 200ms window
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
    }

    return new Promise<void>((resolve) => {
      this._resolveFns.push(resolve);

      this._debounceTimer = setTimeout(async () => {
        this._debounceTimer = null;
        if (this._dirty) {
          this._dirty = false;
          try {
            await this._doSave(this._latestLoops!);
          } catch {
            // Best-effort — errors are logged inside _doSave
          }
        }
        this._flushResolves();
      }, 200);
    });
  }

  /** Resolve all pending save promises. */
  private _flushResolves(): void {
    const fns = this._resolveFns;
    this._resolveFns = [];
    for (const fn of fns) {
      fn();
    }
  }

  private async _doSave(loops: Map<string, LoopState>): Promise<void> {
    try {
      await atomicWrite(this.statePath(), this.toFile(loops));
    } catch (err) { log.warn("LoopStore._doSave failed", err); }
  }

  saveSync(loops: Map<string, LoopState>): void {
    try {
      atomicWriteSync(this.statePath(), this.toFile(loops));
    } catch (err) { log.warn("LoopStore.saveSync failed", err); }
  }

  load(): Map<string, LoopState> | null {
    let raw: string;
    try {
      raw = readFileSync(this.statePath(), "utf-8");
    } catch {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as FileShape;
      if (parsed.version < 1 || parsed.version > 3 || !Array.isArray(parsed.loops)) return null;
      const needsMigration = parsed.version < 3;
      const out = new Map<string, LoopState>();
      for (const entry of parsed.loops) {
        if (needsMigration) {
          const state = entry.state;
          state.parentLoopId = state.parentLoopId ?? undefined;
          state.consecutiveStaleRounds = state.consecutiveStaleRounds ?? undefined;
          state.objective = state.objective ?? undefined;
          state.promptFingerprint = state.promptFingerprint ?? undefined;
          state.schemaVersion = 3;
        }
        out.set(entry.id, entry.state);
      }
      return out;
    } catch {
      return null;
    }
  }

  /**
   * Reconcile persisted loops against dispatch task state after a restart.
   *
   * For each non-terminal loop with an active worker task, queries dispatch
   * state to decide the correct recovery action. Terminal loops are pruned.
   *
   * @returns The mutated `loadedLoops` map (same reference) with recovery applied.
   */
  async reconcile(
    loadedLoops: Map<string, LoopState>,
    getWorkerState: (taskId: string) => Promise<WorkerTaskState>,
  ): Promise<Map<string, LoopState>> {
    const toRemove: string[] = [];

    for (const [id, state] of loadedLoops) {
      if (isTerminalPhase(state.phase)) {
        toRemove.push(id);
        continue;
      }

      if (!state.activeWorkerTaskId) {
        state.phase = "interrupted";
        state.errorReason = "No active worker task — interrupted during restart";
        state.updatedAt = Date.now();
        continue;
      }

      let workerState: WorkerTaskState;
      try {
        workerState = await getWorkerState(state.activeWorkerTaskId);
      } catch {
        state.phase = "interrupted";
        state.errorReason = "Worker task state lookup failed during restart";
        state.updatedAt = Date.now();
        continue;
      }

      if (!workerState.exists) {
        state.phase = "interrupted";
        state.errorReason = "Worker task lost during restart";
        state.updatedAt = Date.now();
        continue;
      }

      switch (workerState.status) {
        case "completed":
          state.phase = "summarizing";
          break;
        case "running":
        case "pending":
          state.phase = "awaiting_worker";
          break;
        default:
          state.phase = "interrupted";
          state.errorReason = `Worker task state: ${workerState.status}`;
      }
      state.updatedAt = Date.now();
    }

    for (const id of toRemove) {
      loadedLoops.delete(id);
    }

    return loadedLoops;
  }

  /**
   * Clean up the pending debounce timer. Should be called when the store
   * is being disposed to prevent stale timer callbacks.
   */
  dispose(): void {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._dirty = false;
    // Resolve any pending saves so callers don't hang.
    this._flushResolves();
  }
}
