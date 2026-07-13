/**
 * Checkpoint clean subcommand.
 *
 * Removes expired checkpoints (older than DEFAULT_CHECKPOINT_TTL_MS).
 * Accepts `--all` flag to remove ALL checkpoints regardless of TTL.
 * Prints count of removed checkpoints.
 *
 * @module
 */

import { defineCommand } from "citty";
import * as clack from "@clack/prompts";
import { existsSync } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { DEFAULT_CHECKPOINT_TTL_MS } from "../../../dispatch/config.ts";
import { FileSystemCheckpointStore } from "../../../dispatch/checkpoint/checkpoint-store.ts";

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

export const cleanCommand = defineCommand({
  meta: {
    name: "clean",
    description: "Remove expired or all checkpoints",
  },
  args: {
    all: {
      type: "boolean",
      alias: ["a"],
      description: "Remove ALL checkpoints regardless of TTL",
    },
  },
  async run({ args }) {
    const projectDir = resolveProjectRoot(process.cwd());
    const store = new FileSystemCheckpointStore(projectDir);

    if (args.all) {
      // ── Confirm before deleting all checkpoints ────────────────
      if (!process.stdin.isTTY) {
        console.error("Error: --all requires an interactive terminal for confirmation.");
        process.exitCode = 1;
        return;
      }

      clack.intro("checkpoint clean");

      const confirmed = await clack.confirm({
        message: "Remove ALL checkpoints? This cannot be undone.",
        active: "Yes, remove all",
        inactive: "No, cancel",
        initialValue: false,
      });

      if (clack.isCancel(confirmed) || !confirmed) {
        clack.cancel("Operation cancelled.");
        return;
      }

      // Remove all checkpoint files
      const checkpointsDir = join(projectDir, ".rolebox", "state", "checkpoints");
      if (!existsSync(checkpointsDir)) {
        clack.log.info("No checkpoint directory found. Nothing to clean.");
        clack.outro("Done.");
        return;
      }

      let files: string[];
      try {
        files = await readdir(checkpointsDir);
      } catch {
        clack.log.info("No checkpoints found.");
        clack.outro("Done.");
        return;
      }

      const checkpointFiles = files.filter((f) => f.endsWith(".json"));
      let removedCount = 0;

      for (const file of checkpointFiles) {
        try {
          await unlink(join(checkpointsDir, file));
          removedCount++;
        } catch {
          // Ignore individual file failures
        }
      }

      clack.log.success(`Removed ${removedCount} checkpoint file(s).`);
      clack.outro("Done.");
    } else {
      // ── Clean expired checkpoints only ─────────────────────────
      clack.intro("checkpoint clean");

      const checkpointsDir = join(projectDir, ".rolebox", "state", "checkpoints");
      if (!existsSync(checkpointsDir)) {
        clack.log.info("No checkpoint directory found. Nothing to clean.");
        clack.outro("Done.");
        return;
      }

      let files: string[];
      try {
        files = await readdir(checkpointsDir);
      } catch {
        clack.log.info("No checkpoints found.");
        clack.outro("Done.");
        return;
      }

      const checkpointFiles = files.filter((f) => f.endsWith(".json"));
      if (checkpointFiles.length === 0) {
        clack.log.info("No checkpoints found.");
        clack.outro("Done.");
        return;
      }

      // Count expired checkpoints before removal
      const { readFile } = await import("node:fs/promises");
      const now = Date.now();
      let expiredCount = 0;

      for (const file of checkpointFiles) {
        try {
          const raw = await readFile(join(checkpointsDir, file), "utf-8");
          const entries = JSON.parse(raw) as Array<{ created_at: string; ttl_ms?: number }>;
          if (!Array.isArray(entries)) continue;
          const allExpired = entries.every((entry) => {
            const createdAt = new Date(entry.created_at).getTime();
            const ttl = entry.ttl_ms ?? DEFAULT_CHECKPOINT_TTL_MS;
            return now - createdAt >= ttl;
          });
          if (allExpired) expiredCount += entries.length;
        } catch {
          // Skip corrupt files in counting
        }
      }

      if (expiredCount === 0) {
        clack.log.info("No expired checkpoints found.");
        clack.outro("Done.");
        return;
      }

      clack.log.info(`Found ${expiredCount} expired checkpoint(s).`);

      // Perform cleanup using the store's built-in cleanupExpired
      await store.cleanupExpired(DEFAULT_CHECKPOINT_TTL_MS);

      clack.log.success(`Removed ${expiredCount} expired checkpoint(s).`);
      clack.outro("Done.");
    }
  },
});
