import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import type { DispatchManager } from "./manager.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("task-concurrency");

export function createTaskConcurrencyTool(manager: DispatchManager) {
  return tool({
    description:
      "Retrieve real-time concurrency slot status per concurrency key. " +
      "Shows active slots, limits, available capacity, reserved slots, and queue depth. " +
      "Returns a human-readable summary or JSON. Optionally exports the status JSON to a file.",
    args: {
      format: z
        .enum(["summary", "json"])
        .optional()
        .default("summary")
        .describe("Output format: 'summary' for human-readable, 'json' for machine parsing"),
      export_path: z
        .string()
        .optional()
        .describe("Optional file path to write the status JSON atomically"),
    },
    async execute(input, context) {
      const status = manager.getConcurrencyStatus();
      const jsonStr = JSON.stringify(status, null, 2);

      // Export to file if requested
      if (input.export_path) {
        const fullPath = resolve(
          (context as { worktree?: string; directory?: string }).worktree ||
          (context as { directory?: string }).directory ||
          ".",
          input.export_path,
        );
        const dir = dirname(fullPath);
        mkdirSync(dir, { recursive: true });
        const tmpPath = fullPath + ".tmp";
        writeFileSync(tmpPath, jsonStr, "utf-8");
        renameSync(tmpPath, fullPath);
      }

      if (input.format === "json") {
        return jsonStr;
      }

      // Handle empty state — no keys registered
      if (status.keys.length === 0) {
        return "No concurrency keys registered. No tasks have been dispatched yet.";
      }

      // Build human-readable summary
      const lines: string[] = ["## Task Concurrency Status", ""];

      // Per-key breakdown table
      lines.push("### Per-Key Breakdown");
      lines.push("");
      lines.push("| Key | Active | Limit | Available | Reserved | Queue Depth |");
      lines.push("|-----|--------|-------|-----------|----------|-------------|");
      for (const key of status.keys) {
        lines.push(
          `| ${key.key} | ${key.active} | ${key.limit} | ${key.available} | ${key.reserved} | ${key.queueDepth} |`,
        );
      }
      lines.push("");

      // Global summary
      lines.push("### Global Summary");
      lines.push("");
      lines.push(`- Total active: ${status.total.active}`);
      lines.push(`- Total limit: ${status.total.limit}`);
      lines.push(`- Total queue depth: ${status.total.queueDepth}`);
      lines.push(`- Concurrency keys: ${status.total.keys}`);

      return lines.join("\n");
    },
  });
}
