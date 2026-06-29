import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { createSubLogger } from "../logger.ts";
import { getDataDir } from "../cli/paths.ts";
import { acquireStateLock } from "./state-lock.ts";
import type { DispatchTask, DispatchTaskStatus } from "./types.ts";

// ─── Serialization Interfaces ──────────────────────────────────────────────

/**
 * JSON-serializable mirror of TaskProgress.
 * Uses ISO strings instead of Date objects for round-trip safety.
 */
interface SerializedTaskProgress {
  lastUpdate: string;
  toolCalls: number;
}

/**
 * JSON-serializable mirror of MaterializedResultRef.
 * Only JSON-safe primitives — no Date objects.
 */
interface SerializedMaterializedResultRef {
  sidecarPath: string;
  totalChars: number;
  hadFence: boolean;
  fetchError?: string;
  materializedAt: string;
}

/**
 * JSON-serializable mirror of DispatchTask.
 * Date fields are stored as ISO strings and deserialized back on load.
 */
export interface SerializedDispatchTask {
  id: string;
  sessionId: string;
  parentSessionId: string;
  status: DispatchTaskStatus;
  agent: string;
  prompt: string;
  description?: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  progress: SerializedTaskProgress;
  concurrencyKey?: string;
  continuationOf?: string;
  messageCountAtStart?: number;
  timeoutMs?: number;
  mode?: string;
  depth?: number;
  result?: SerializedMaterializedResultRef;
}

/**
 * On-disk state file schema.
 * Version field enables future schema migrations.
 */
interface DispatchStateFile {
  version: 1 | 2 | 3 | 4 | 5;
  tasks: SerializedDispatchTask[];
  outbox?: string[];
}

// ─── TaskStateStore ─────────────────────────────────────────────────────────

const log = createSubLogger("dispatch:store");

/**
 * File-based persistence for DispatchManager task state.
 *
 * Writes are asynchronous (fs.promises.writeFile) with a serialization lock
 * to prevent concurrent writes from corrupting the state file.  Uses atomic
 * write pattern (.tmp + renameSync) to prevent file corruption from partial writes.
 *
 * Multi-instance isolation: each workspace directory gets its own state file
 * keyed by a 12-character sha256 hash of the directory path.
 */
export class TaskStateStore {
  private dirHash: string;
  private _saveLock: Promise<void> = Promise.resolve();
  private _lockState?: ReturnType<typeof acquireStateLock>;
  private _readOnly = false;

  constructor(directory: string) {
    this.dirHash = createHash("sha256").update(directory).digest("hex").slice(0, 12);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Lock State File for multi-instance isolation. */
  tryLock(): boolean {
    const lock = acquireStateLock(this.getStatePath());
    if (lock.ok) {
      this._lockState = lock;
      return true;
    }
    this._readOnly = true;
    return false;
  }

  /** Release lock if held. */
  unlock(): void {
    this._lockState?.release();
    this._lockState = undefined;
  }

  /** Is this store in read-only degraded mode? */
  get readOnly(): boolean {
    return this._readOnly;
  }

  /**
   * Persist the current task map to disk asynchronously.
   * Uses atomic write: write to .tmp, unlink existing, rename.
   * Never throws — logs a warning on failure and degrades gracefully.
   *
   * Serialization lock ensures only one write is in-flight at a time;
   * concurrent callers queue up behind the previous save.
   */
  async save(tasks: Map<string, DispatchTask>, outbox?: Set<string>): Promise<void> {
    if (this._readOnly) return;
    // Chain onto the previous save to serialize writes
    this._saveLock = this._saveLock.then(() => this._doSave(tasks, outbox), () => this._doSave(tasks, outbox));
    return this._saveLock;
  }

  private async _doSave(tasks: Map<string, DispatchTask>, outbox?: Set<string>): Promise<void> {
    try {
      const json = this.serialize(tasks, outbox);
      const statePath = this.getStatePath();
      const stateDir = join(statePath, "..");

      mkdirSync(stateDir, { recursive: true });

      const tmp = statePath + ".tmp";
      await writeFile(tmp, json, "utf-8");

      try { unlinkSync(statePath); } catch {}

      renameSync(tmp, statePath);
    } catch (err) {
      log.warn("Failed to persist dispatch state", err);
    }
  }

  /**
   * Load task state from disk.
   *
   * Returns null (clean start) in these cases:
   * - File does not exist (ENOENT) — first run
   * - File is corrupt JSON — logged as warning
   * - File has unexpected schema version — logged as warning
   *
   * On success, returns tasks map with ISO strings deserialized to Dates,
   * plus the outbox string array (empty for v1-v3 or when absent).
   */
  load(): { tasks: Map<string, DispatchTask>; outbox: string[] } | null {
    let raw: string;
    try {
      raw = readFileSync(this.getStatePath(), "utf-8");
    } catch (err: unknown) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        return null;
      }
      log.warn("Failed to read dispatch state file", err);
      return null;
    }

    const parsed = this.deserialize(raw);
    if (!parsed) return null;

    const { version, tasks } = parsed;
    if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5) {
      log.warn(`Unsupported dispatch state schema version ${version}, starting fresh`);
      return null;
    }

    // Collect outbox (v4+) — defaults to empty for v1-v3
    const outbox: string[] = ((version === 4 || version === 5) && Array.isArray(parsed.outbox))
      ? parsed.outbox.filter((x): x is string => typeof x === "string")
      : [];

    // Build the task map, applying v1→v2/v2→v3 defaults when migrating
    const map = new Map<string, DispatchTask>();
    for (const st of tasks) {
      map.set(st.id, {
        id: st.id,
        sessionId: st.sessionId,
        parentSessionId: st.parentSessionId,
        status: st.status,
        agent: st.agent,
        prompt: st.prompt,
        description: st.description,
        startedAt: new Date(st.startedAt),
        completedAt: st.completedAt ? new Date(st.completedAt) : undefined,
        error: st.error,
        progress: {
          lastUpdate: new Date(st.progress.lastUpdate),
          toolCalls: st.progress.toolCalls,
        },
        concurrencyKey: version === 1 ? "default" : st.concurrencyKey,
        continuationOf: version === 1 ? undefined : st.continuationOf,
        messageCountAtStart: version === 1 ? 0 : st.messageCountAtStart,
        timeoutMs: version === 1 || version === 2 ? undefined : st.timeoutMs,
        mode: version === 1 || version === 2 ? "background" : (st.mode as "background" | "sync" | undefined),
        depth: st.depth ?? 0,
        result: (version === 4 || version === 5) && st.result
          ? {
              sidecarPath: st.result.sidecarPath,
              totalChars: st.result.totalChars,
              hadFence: st.result.hadFence,
              fetchError: st.result.fetchError,
              materializedAt: st.result.materializedAt,
            }
          : undefined,
      });
    }

    // Re-save as v4 after single-shot migration (fire-and-forget —
    // will be picked up on next persist cycle even if this write fails)
    if (version === 1 || version === 2 || version === 3 || version === 4) {
      void this.save(map);
    }

    return { tasks: map, outbox };
  }

  /**
   * Delete the state file from disk.
   * No-op if the file does not exist. Never throws.
   */
  clear(): void {
    try {
      unlinkSync(this.getStatePath());
    } catch {}
  }

  /**
   * Synchronous version of save() for crash-safe persistence.
   * Mirrors the atomic write pattern from _doSave but fully synchronous.
   *
   * On process exit, this is last-writer-wins versus any in-flight async save(),
   * which is the desired behavior (exit state is authoritative).
   * Never throws — wraps errors in try/catch and logs a warning.
   */
  saveSync(tasks: Map<string, DispatchTask>, outbox?: Set<string>): void {
    if (this._readOnly) return;
    try {
      const json = this.serialize(tasks, outbox);
      const statePath = this.getStatePath();
      const stateDir = join(statePath, "..");

      mkdirSync(stateDir, { recursive: true });

      const tmp = statePath + ".tmp";
      writeFileSync(tmp, json, "utf-8");

      try { unlinkSync(statePath); } catch {}

      renameSync(tmp, statePath);
    } catch (err) {
      log.warn("Failed to persist dispatch state (sync)", err);
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────

  /** Compute the state file path: {dataDir}/state/dispatch-{hash12}.json */
  private getStatePath(): string {
    return join(getDataDir(), "state", `dispatch-${this.dirHash}.json`);
  }

  /** Convert a live task map to a JSON string. */
  private serialize(tasks: Map<string, DispatchTask>, outbox?: Set<string>): string {
    const serialized: SerializedDispatchTask[] = [];

    for (const task of tasks.values()) {
      const s: SerializedDispatchTask = {
        id: task.id,
        sessionId: task.sessionId,
        parentSessionId: task.parentSessionId,
        status: task.status,
        agent: task.agent,
        prompt: task.prompt,
        description: task.description,
        startedAt: task.startedAt.toISOString(),
        completedAt: task.completedAt?.toISOString(),
        error: task.error,
        progress: {
          lastUpdate: task.progress.lastUpdate.toISOString(),
          toolCalls: task.progress.toolCalls,
        },
        concurrencyKey: task.concurrencyKey,
        continuationOf: task.continuationOf,
        messageCountAtStart: task.messageCountAtStart,
        timeoutMs: task.timeoutMs,
        mode: task.mode,
        depth: task.depth,
      };

      if (task.result) {
        s.result = {
          sidecarPath: task.result.sidecarPath,
          totalChars: task.result.totalChars,
          hadFence: task.result.hadFence,
          fetchError: task.result.fetchError,
          materializedAt: task.result.materializedAt,
        };
      }

      serialized.push(s);
    }

    const file: DispatchStateFile = {
      version: 5,
      tasks: serialized,
    };

    if (outbox && outbox.size > 0) {
      file.outbox = [...outbox];
    }

    return JSON.stringify(file, null, 2);
  }

  /** Parse a JSON string back into a DispatchStateFile. Returns null on parse error. */
  private deserialize(data: string): DispatchStateFile | null {
    try {
      const parsed = JSON.parse(data) as unknown;
      if (!isDispatchStateFile(parsed)) {
        log.warn("Corrupt dispatch state file format, starting fresh");
        return null;
      }
      return parsed;
    } catch {
      log.warn("Corrupt dispatch state file (JSON parse error), starting fresh");
      return null;
    }
  }
}

// ─── Type Guards ───────────────────────────────────────────────────────────

/** Runtime check that an unknown value looks like a DispatchStateFile. */
function isDispatchStateFile(value: unknown): value is DispatchStateFile {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1 && obj.version !== 2 && obj.version !== 3 && obj.version !== 4 && obj.version !== 5) return false;
  if (!Array.isArray(obj.tasks)) return false;
  return true;
}

/** Narrow an unknown error to an ErrnoException for code checks. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
