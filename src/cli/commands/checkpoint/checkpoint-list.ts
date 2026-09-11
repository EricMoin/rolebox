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
 * Format a duration in ms to a human-readable relative time string.
 */
function formatExpiresIn(createdAt: string, ttlMs: number): string {
  const created = new Date(createdAt).getTime();
  const expires = created + ttlMs;
  const remaining = expires - Date.now();
  if (remaining <= 0) return dim("expired");
  if (remaining < 60_000) return `${Math.round(remaining / 1000)}s`;
  if (remaining < 3_600_000) return `${Math.round(remaining / 60_000)}m`;
  if (remaining < 86_400_000) return `${Math.round(remaining / 3_600_000)}h`;
  return `${Math.round(remaining / 86_400_000)}d`;
}

/**
 * Truncate a string to maxLen, appending "…" if truncated.
 */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "\u2026";
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
            task_id: entry.task_id || taskId,
            checkpoint_id: entry.checkpoint_id,
            phase: entry.phase,
            completed: (entry.completed_items || []).length,
            remaining: (entry.remaining_items || []).length,
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

    // Sort by created_at descending (most recent first)
    rows.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

    // Render table
    console.log(
      `  ${bold("Task ID".padEnd(20))} ${bold("CP ID".padEnd(22))} ${bold("Phase".padEnd(16))} ${bold("Done".padEnd(6))} ${bold("Rem".padEnd(6))} ${bold("Created".padEnd(20))} ${bold("Expires")}`,
    );
    console.log(dim("  " + "\u2500".repeat(98)));

    for (const row of rows) {
      const created = new Date(row.created_at).toISOString().slice(0, 19).replace("T", " ");
      const expires = formatExpiresIn(row.created_at, row.ttl_ms);
      console.log(
        `  ${dim(truncate(row.task_id, 20).padEnd(20))} ${dim(truncate(row.checkpoint_id, 22).padEnd(22))} ${truncate(row.phase, 16).padEnd(16)} ${String(row.completed).padEnd(6)} ${String(row.remaining).padEnd(6)} ${created} ${expires}`,
      );
    }
  },
});
