import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProgressEvent, ProgressStore } from "../types.progress.ts";
import {
  DEFAULT_PROGRESS_TTL_MS,
  MAX_PROGRESS_EVENTS_PER_TASK,
  GLOBAL_SWEEP_INTERVAL_MS,
} from "../config.ts";

/**
 * In-memory progress event store with optional disk spill for crash recovery.
 *
 * Events are stored per task in a ring buffer capped at MAX_PROGRESS_EVENTS_PER_TASK
 * (oldest events are dropped when the buffer is full).
 *
 * Disk writes are debounced (5 s per task) to avoid excessive I/O.
 * Files are written to `.rolebox/state/progress/{taskId}.json` using the
 * atomic write pattern (write to .tmp, then rename).
 */
export class InMemoryProgressStore implements ProgressStore {
  private store = new Map<string, ProgressEvent[]>();
  private directory: string;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly DEBOUNCE_MS = 5_000;

  /** Optional periodic sweeper timer. */
  private _sweeperTimer: ReturnType<typeof setInterval> | undefined;

  constructor(directory: string) {
    this.directory = directory;
  }

  // ── ProgressStore interface ──────────────────────────────────────

  addProgressEvent(taskId: string, event: ProgressEvent): void {
    let events = this.store.get(taskId);
    if (!events) {
      events = [];
      this.store.set(taskId, events);
    }

    // Ring buffer: drop oldest when at capacity
    if (events.length >= MAX_PROGRESS_EVENTS_PER_TASK) {
      events.shift();
    }

    events.push(event);
    this.schedulePersist(taskId);
  }

  getProgressStream(taskId: string, since?: string): ProgressEvent[] {
    const events = this.store.get(taskId);
    if (!events) return [];

    if (since !== undefined) {
      return events.filter((e) => e.timestamp > since);
    }
    return [...events];
  }

  clearProgress(taskId: string): void {
    this.store.delete(taskId);
    this.cancelPersist(taskId);
    // Reflect the cleared state on disk (write empty file)
    this.persistTaskSync(taskId, []);
  }

  cleanupExpired(ttlMs: number = DEFAULT_PROGRESS_TTL_MS): void {
    const cutoff = Date.now() - ttlMs;
    const cutoffStr = new Date(cutoff).toISOString();

    for (const [taskId, events] of this.store.entries()) {
      const filtered = events.filter((e) => e.timestamp >= cutoffStr);

      if (filtered.length === 0) {
        // No remaining events — remove the task entirely
        this.store.delete(taskId);
        this.cancelPersist(taskId);
        this.removeDiskFile(taskId);
      } else if (filtered.length < events.length) {
        // Some events expired — update and persist
        this.store.set(taskId, filtered);
        this.schedulePersist(taskId);
      }
      // else: nothing expired — no-op
    }
  }

  // ── Directory management ─────────────────────────────────────────

  /** Update the base directory (used when DispatchManager.setStoreDirectory is called). */
  setDirectory(directory: string): void {
    this.directory = directory;
  }

  // ── Sweeper lifecycle ────────────────────────────────────────────

  /**
   * Start a periodic cleanup sweeper that removes expired events.
   * Uses the global sweep interval from config.
   */
  startSweeper(): void {
    if (this._sweeperTimer) return;
    this._sweeperTimer = setInterval(() => {
      this.cleanupExpired(DEFAULT_PROGRESS_TTL_MS);
    }, GLOBAL_SWEEP_INTERVAL_MS);
    if (this._sweeperTimer && typeof this._sweeperTimer === "object" && "unref" in this._sweeperTimer) {
      (this._sweeperTimer as any).unref();
    }
  }

  /** Stop the periodic sweeper. */
  stopSweeper(): void {
    if (this._sweeperTimer) {
      clearInterval(this._sweeperTimer);
      this._sweeperTimer = undefined;
    }
  }

  // ── Test accessors ───────────────────────────────────────────────

  /** Exposed for testing: force-flush all pending debounced writes synchronously. */
  flushSync(): void {
    for (const [taskId] of this.debounceTimers) {
      this.cancelPersist(taskId);
      const events = this.store.get(taskId);
      if (events) {
        this.persistTaskSync(taskId, events);
      }
    }
  }

  /** Exposed for testing: access the in-memory map size. */
  get taskCount(): number {
    return this.store.size;
  }

  // ── Private helpers ──────────────────────────────────────────────

  private getProgressPath(taskId: string): string {
    return join(this.directory, ".rolebox", "state", "progress", `${taskId}.json`);
  }

  private schedulePersist(taskId: string): void {
    this.cancelPersist(taskId);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(taskId);
      this.persistTask(taskId).catch(() => {
        // Non-critical — disk spill is best-effort
      });
    }, this.DEBOUNCE_MS);
    this.debounceTimers.set(taskId, timer);
  }

  private cancelPersist(taskId: string): void {
    const timer = this.debounceTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(taskId);
    }
  }

  private async persistTask(taskId: string): Promise<void> {
    const events = this.store.get(taskId);
    if (!events) return;
    await this.writeAtomically(taskId, events);
  }

  private persistTaskSync(taskId: string, events: ProgressEvent[]): void {
    this.writeAtomicallySync(taskId, events);
  }

  private async writeAtomically(taskId: string, events: ProgressEvent[]): Promise<void> {
    const path = this.getProgressPath(taskId);
    const dir = join(path, "..");
    mkdirSync(dir, { recursive: true });

    const json = JSON.stringify(events);
    const tmp = path + ".tmp";
    await writeFile(tmp, json, "utf-8");
    try {
      unlinkSync(path);
    } catch {
      // File may not exist yet — that is fine
    }
    renameSync(tmp, path);
  }

  private writeAtomicallySync(taskId: string, events: ProgressEvent[]): void {
    const path = this.getProgressPath(taskId);
    const dir = join(path, "..");
    mkdirSync(dir, { recursive: true });

    const json = JSON.stringify(events);
    const tmp = path + ".tmp";
    writeFileSync(tmp, json, "utf-8");
    try {
      unlinkSync(path);
    } catch {
      // File may not exist yet
    }
    renameSync(tmp, path);
  }

  private removeDiskFile(taskId: string): void {
    const path = this.getProgressPath(taskId);
    try {
      unlinkSync(path);
    } catch {
      // File may not exist
    }
    try {
      unlinkSync(path + ".tmp");
    } catch {
      // Temp file may not exist
    }
  }
}
