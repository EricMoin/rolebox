import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, atomicWriteSync } from "../function/fs-util.ts";
import { shortHash } from "../state-paths.ts";
import type { LoopPhase, LoopState } from "./types.ts";

interface FileShape {
  version: 1;
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
  private _lock: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.directory = directory;
    this.dirHash = shortHash(directory);
  }

  private statePath(): string {
    return join(this.directory, ".rolebox", "state", `loops-${this.dirHash}.json`);
  }

  private toFile(loops: Map<string, LoopState>): string {
    const entries = [...loops].map(([id, state]) => ({ id, state }));
    return JSON.stringify({ version: 1, loops: entries } satisfies FileShape, null, 2);
  }

  async save(loops: Map<string, LoopState>): Promise<void> {
    this._lock = this._lock.then(
      () => this._doSave(loops),
      () => this._doSave(loops),
    );
    return this._lock;
  }

  private async _doSave(loops: Map<string, LoopState>): Promise<void> {
    try {
      await atomicWrite(this.statePath(), this.toFile(loops));
    } catch {}
  }

  saveSync(loops: Map<string, LoopState>): void {
    try {
      atomicWriteSync(this.statePath(), this.toFile(loops));
    } catch {}
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
      if (parsed.version !== 1 || !Array.isArray(parsed.loops)) return null;
      const out = new Map<string, LoopState>();
      for (const entry of parsed.loops) {
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
}
