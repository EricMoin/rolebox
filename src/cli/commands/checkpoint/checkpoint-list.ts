/**
 * Checkpoint list subcommand.
 *
 * Lists all active checkpoints across all tasks from the filesystem.
 * Displays in a table sorted by created_at (most recent first).
 *
 * @module
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { bold, dim } from "../../format.ts";
import { formatDuration, formatTimestamp, truncateText } from "../../../utils/text-format.ts";
import { FileSystemCheckpointStore } from "../../../dispatch/checkpoint/checkpoint-store.ts";
import { DEFAULT_CHECKPOINT_TTL_MS } from "../../../dispatch/config.ts";

/**
 * Resolve the project root by looking for a `.rolebox` directory.
 */
function resolveProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, ".rolebox"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/**
 * Epoch milliseconds for a row's `created_at`, or `null` when it is missing,
 * non-ISO or otherwise unparseable.
 *
 * `created_at` is copied unvalidated out of parsed JSON, so every consumer has
 * to tolerate a malformed value instead of letting an `Invalid Date` reach the
 * sort comparator or a `toISOString()` call.
 */
function createdAtMs(createdAt: string): number | null {
  const ms = Date.parse(createdAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Trust-boundary coercion for a field copied out of unvalidated checkpoint
 * JSON.
 *
 * The canonical display helpers are typed `string` on purpose, so a value that
 * is not a non-empty string is replaced here instead of deep in the renderer:
 * `"-"` for fields with no other source, the file-derived task id for
 * `task_id`. `Date.parse` already tolerates every malformed `created_at`.
 */
function textField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * Format a duration in ms to a human-readable relative time string.
 *
 * `dim("unknown")` when `created_at` (or the derived remaining time) is
 * unparseable, `dim("expired")` for a non-positive remaining time; otherwise a
 * one-line delegation to `formatDuration(…, "largest")`.
 */
function formatExpiresIn(createdAt: string, ttlMs: number): string {
  const created = createdAtMs(createdAt);
  if (created === null) return dim("unknown");
  const remaining = created + ttlMs - Date.now();
  if (!Number.isFinite(remaining)) return dim("unknown");
  if (remaining <= 0) return dim("expired");
  return formatDuration(remaining, "largest");
}

export const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List active checkpoints across all tasks",
  },
  args: {
    task: {
      type: "string",
      alias: ["t"],
      description: "Filter to a specific task ID",
    },
  },
  async run({ args }) {
    const projectDir = resolveProjectRoot(process.cwd());

    const checkpointsDir = join(projectDir, ".rolebox", "state", "checkpoints");

    if (!existsSync(checkpointsDir)) {
      console.log("No checkpoint directory found. No checkpoints exist.");
      return;
    }

    let files: string[];
    try {
      files = await readdir(checkpointsDir);
    } catch {
      console.log("No checkpoints found.");
      return;
    }

    const checkpointFiles = files.filter((f) => f.endsWith(".json"));

    if (checkpointFiles.length === 0) {
      console.log("No checkpoints found.");
      return;
    }

    // Collect all checkpoint entries from all task files
    interface CheckpointRow {
      task_id: string;
      checkpoint_id: string;
      phase: string;
      completed: number;
      remaining: number;
      created_at: string;
      ttl_ms: number;
    }

    const rows: CheckpointRow[] = [];

    for (const file of checkpointFiles) {
      const taskId = file.replace(/\.json$/, "");

      // Apply task filter if specified
      if (args.task && taskId !== args.task) continue;

      try {
        const raw = await readFile(join(checkpointsDir, file), "utf-8");
        const entries = JSON.parse(raw) as Array<{
          task_id: string;
          checkpoint_id: string;
          phase: string;
          completed_items?: string[];
          remaining_items?: string[];
          created_at: string;
          ttl_ms: number;
        }>;

        if (!Array.isArray(entries)) continue;

        for (const entry of entries) {
          rows.push({
            task_id: textField(entry.task_id, taskId),
            checkpoint_id: textField(entry.checkpoint_id, "-"),
            phase: textField(entry.phase, "-"),
            completed: Array.isArray(entry.completed_items) ? entry.completed_items.length : 0,
            remaining: Array.isArray(entry.remaining_items) ? entry.remaining_items.length : 0,
            created_at: entry.created_at,
            ttl_ms: entry.ttl_ms ?? DEFAULT_CHECKPOINT_TTL_MS,
          });
        }
      } catch {
        // Skip corrupt files
        continue;
      }
    }

    if (rows.length === 0) {
      console.log("No checkpoints found.");
      return;
    }

    // Sort by created_at descending (most recent first). Rows whose created_at
    // cannot be parsed have no position in time and sort last, so a malformed
    // value can never produce a NaN comparator.
    rows.sort((a, b) => {
      const aMs = createdAtMs(a.created_at);
      const bMs = createdAtMs(b.created_at);
      if (aMs === null || bMs === null) {
        if (aMs === bMs) return 0;
        return aMs === null ? 1 : -1;
      }
      return bMs - aMs;
    });

    // Render table
    console.log(
      `  ${bold("Task ID".padEnd(20))} ${bold("CP ID".padEnd(22))} ${bold("Phase".padEnd(16))} ${bold("Done".padEnd(6))} ${bold("Rem".padEnd(6))} ${bold("Created".padEnd(20))} ${bold("Expires")}`,
    );
    console.log(dim("  " + "\u2500".repeat(98)));

    for (const row of rows) {
      // Canonical total timestamp: a malformed created_at renders "unknown"
      // instead of throwing RangeError from toISOString().
      const created = formatTimestamp(Date.parse(row.created_at));
      const expires = formatExpiresIn(row.created_at, row.ttl_ms);
      console.log(
        `  ${dim(truncateText(row.task_id, 20).padEnd(20))} ${dim(truncateText(row.checkpoint_id, 22).padEnd(22))} ${truncateText(row.phase, 16).padEnd(16)} ${String(row.completed).padEnd(6)} ${String(row.remaining).padEnd(6)} ${created} ${expires}`,
      );
    }
  },
});
