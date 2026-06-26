import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { createSubLogger } from "../logger.ts";
import { getDataDir } from "../cli/paths.ts";
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
}

/**
 * On-disk state file schema.
 * Version field enables future schema migrations.
 */
interface DispatchStateFile {
  version: 1;
  tasks: SerializedDispatchTask[];
}

// ─── TaskStateStore ─────────────────────────────────────────────────────────

const log = createSubLogger("dispatch:store");

/**
 * File-based persistence for DispatchManager task state.
 *
 * Writes are synchronous (writeFileSync) — acceptable for ≤5 concurrent
 * tasks with infrequent mutations.  Uses atomic write pattern (.tmp + renameSync)
 * to prevent file corruption from partial writes.
 *
 * Multi-instance isolation: each workspace directory gets its own state file
 * keyed by a 12-character sha256 hash of the directory path.
 */
export class TaskStateStore {
  private dirHash: string;

  constructor(directory: string) {
    this.dirHash = createHash("sha256").update(directory).digest("hex").slice(0, 12);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Persist the current task map to disk.
   * Uses atomic write: write to .tmp, unlink existing, rename.
   * Never throws — logs a warning on failure and degrades gracefully.
   */
  save(tasks: Map<string, DispatchTask>): void {
    try {
      const json = this.serialize(tasks);
      const statePath = this.getStatePath();
      const stateDir = join(statePath, "..");

      mkdirSync(stateDir, { recursive: true });

      const tmp = statePath + ".tmp";
      writeFileSync(tmp, json, "utf-8");

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
   * On success, returns a Map<string, DispatchTask> with ISO strings
   * deserialized back to Date objects.
   */
  load(): Map<string, DispatchTask> | null {
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
    if (version !== 1) {
      log.warn(`Unsupported dispatch state schema version ${version}, starting fresh`);
      return null;
    }

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
      });
    }

    return map;
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

  // ── Private ─────────────────────────────────────────────────────────────

  /** Compute the state file path: {dataDir}/state/dispatch-{hash12}.json */
  private getStatePath(): string {
    return join(getDataDir(), "state", `dispatch-${this.dirHash}.json`);
  }

  /** Convert a live task map to a JSON string. */
  private serialize(tasks: Map<string, DispatchTask>): string {
    const serialized: SerializedDispatchTask[] = [];

    for (const task of tasks.values()) {
      serialized.push({
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
      });
    }

    const file: DispatchStateFile = {
      version: 1,
      tasks: serialized,
    };

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
  if (obj.version !== 1) return false;
  if (!Array.isArray(obj.tasks)) return false;
  return true;
}

/** Narrow an unknown error to an ErrnoException for code checks. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
