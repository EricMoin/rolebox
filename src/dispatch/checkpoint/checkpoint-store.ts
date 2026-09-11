/**
 * FileSystemCheckpointStore — persistent checkpoint storage on disk.
 *
 * Stores checkpoint data as JSON arrays in `.rolebox/state/checkpoints/{task_id}.json`,
 * one array per task (supporting multiple checkpoints per task).
 *
 * Uses the same atomic write pattern (.tmp + renameSync) as TaskStateStore
 * and MetricsPersister to prevent file corruption from partial writes.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createSubLogger } from "../../logger.ts";
import type { CheckpointData, CheckpointStore } from "../types.checkpoint.ts";

// ── Logger ────────────────────────────────────────────────────────────────

const log = createSubLogger("dispatch:checkpoint");


/** Maximum checkpoints retained per task. Older entries are evicted (FIFO). */
export const MAX_CHECKPOINTS_PER_TASK = 100;
// ── FileSystemCheckpointStore ──────────────────────────────────────────────

export class FileSystemCheckpointStore implements CheckpointStore {
  private directory: string;

  /**
   * @param directory  Base workspace directory (usually process.cwd()).
   *                   Checkpoints are stored under `.rolebox/state/checkpoints/`.
   */
  constructor(directory: string) {
    this.directory = directory;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Append a checkpoint to the task's checkpoint array and persist to disk
   * atomically (tmp file + rename).
   */
  async saveCheckpoint(taskId: string, data: CheckpointData): Promise<void> {
    const dir = this.getCheckpointsDir();
    mkdirSync(dir, { recursive: true });

    const filePath = this.getCheckpointPath(taskId);
    let entries: CheckpointData[] = [];

    // Read existing entries if the file exists
    try {
      const raw = await readFile(filePath, "utf-8");
      entries = JSON.parse(raw) as CheckpointData[];
      if (!Array.isArray(entries)) {
        entries = [];
      }
    } catch {
      // File does not exist or is corrupt — start fresh
      entries = [];
    }

    // Append the new checkpoint
    entries.push(data);
    // Atomic write
    // Evict oldest entries if over the cap (FIFO)
    if (entries.length > MAX_CHECKPOINTS_PER_TASK) {
      entries = entries.slice(-MAX_CHECKPOINTS_PER_TASK);
    }
    // Atomic write
    const tmp = filePath + ".tmp";
    await writeFile(tmp, JSON.stringify(entries, null, 2), "utf-8");
    try {
      unlinkSync(filePath);
    } catch {
      // File may not exist yet — ignore
    }
    renameSync(tmp, filePath);
  }

  /**
   * Read all checkpoints for a task and return the most recent (by created_at),
   * or null if none exist.
   */
  async getLatestCheckpoint(taskId: string): Promise<CheckpointData | null> {
    const entries = await this._readAll(taskId);
    if (entries.length === 0) return null;

    // Sort descending by created_at
    entries.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    return entries[0];
  }

  /**
   * Read all checkpoints for a task, sorted by created_at (newest first).
   */
  async listCheckpoints(taskId: string): Promise<CheckpointData[]> {
    const entries = await this._readAll(taskId);
    entries.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    return entries;
  }

  /**
   * Delete the checkpoint file for a task.
   * No-op if the file does not exist.
   */
  async deleteCheckpoint(taskId: string): Promise<void> {
    const filePath = this.getCheckpointPath(taskId);
    try {
      unlinkSync(filePath);
    } catch {
      // File does not exist — ignore
    }
  }

  /**
   * Scan all checkpoint files, remove entries whose (created_at + ttl_ms)
   * is in the past relative to `now`, rewrite files that have remaining
   * entries, and delete files that become empty.
   *
   * @param ttlMs  Time-to-live in milliseconds. Entries older than
   *               (now - ttlMs) are removed. When ttlMs <= 0, all are expired.
   */
  async cleanupExpired(ttlMs: number): Promise<void> {
    const dir = this.getCheckpointsDir();
    let taskFiles: string[];
    try {
      taskFiles = await readdir(dir);
    } catch {
      // Directory does not exist — nothing to clean
      return;
    }

    const now = Date.now();
    const checkpointFiles = taskFiles.filter((f) => f.endsWith(".json"));

    for (const file of checkpointFiles) {
      const filePath = join(dir, file);
      let entries: CheckpointData[];
      try {
        const raw = await readFile(filePath, "utf-8");
        entries = JSON.parse(raw) as CheckpointData[];
        if (!Array.isArray(entries)) {
          entries = [];
        }
      } catch {
        // Corrupt or unreadable — skip
        continue;
      }

      // Filter out expired entries
      const valid = entries.filter((e) => {
        const createdAt = new Date(e.created_at).getTime();
        return now - createdAt < ttlMs;
      });

      if (valid.length === 0) {
        // File is now empty — delete it
        try {
          unlinkSync(filePath);
        } catch {
          // Ignore
        }
      } else if (valid.length < entries.length) {
        // Some entries were removed — rewrite
        const tmp = filePath + ".tmp";
        try {
          await writeFile(tmp, JSON.stringify(valid, null, 2), "utf-8");
          try {
            unlinkSync(filePath);
          } catch {
            // Ignore
          }
          renameSync(tmp, filePath);
        } catch (err) {
          log.warn("Failed to rewrite checkpoint file after cleanup", {
            file,
            error: String(err),
          });
        }
      }
      // else: all entries are still valid — no-op
    }
  }

  /**
   * Build a human-readable retry context string from the latest checkpoint.
   * Returns null when no checkpoint exists.
   */
  async buildRetryContext(taskId: string): Promise<string | null> {
    const latest = await this.getLatestCheckpoint(taskId);
    if (!latest) return null;

    const completedBullets = latest.completed_items
      .map((item) => `- ${item}`)
      .join("\n");
    const remainingBullets = latest.remaining_items
      .map((item) => `- ${item}`)
      .join("\n");
    const metadataBlock =
      latest.metadata && Object.keys(latest.metadata).length > 0
        ? `\n### Metadata\n${JSON.stringify(latest.metadata, null, 2)}\n`
        : "";

    return [
      "## Checkpoint Resume Context",
      "",
      `**Phase:** ${latest.phase}`,
      `**Checkpoint ID:** ${latest.checkpoint_id}`,
      `**Created:** ${latest.created_at}`,
      "",
      "### Completed Items",
      completedBullets || "_(none)_",
      "",
      "### Remaining Items",
      remainingBullets || "_(none)_",
      "",
      metadataBlock ? metadataBlock.trim() : "",
      "---",
      "Resume from this checkpoint. Do NOT redo completed items.",
    ]
      .filter((line) => line !== "")
      .join("\n");
  }

  /**
   * Check if at least one checkpoint exists for the given task.
   * Returns false when no checkpoint file exists, the file is corrupt, or the array is empty.
   * Lighter than getLatestCheckpoint when only existence matters.
   */
  async hasCheckpoint(taskId: string): Promise<boolean> {
    const entries = await this._readAll(taskId);
    return entries.length > 0;
  }

  // ── Private ───────────────────────────────────────────────────────────

  /** Get the absolute path to the checkpoints directory. */
  private getCheckpointsDir(): string {
    return join(this.directory, ".rolebox", "state", "checkpoints");
  }

  /** Get the absolute path to a task's checkpoint file. */
  private getCheckpointPath(taskId: string): string {
    return join(this.getCheckpointsDir(), `${taskId}.json`);
  }

  /**
   * Read all checkpoint entries for a task from disk.
   * Returns an empty array if the file does not exist or is corrupt.
   */
  private async _readAll(taskId: string): Promise<CheckpointData[]> {
    const filePath = this.getCheckpointPath(taskId);
    try {
      const raw = await readFile(filePath, "utf-8");
      const entries = JSON.parse(raw) as CheckpointData[];
      if (!Array.isArray(entries)) return [];
      return entries;
    } catch {
      return [];
    }
  }
}
