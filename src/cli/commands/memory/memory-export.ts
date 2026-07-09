/**
 * Memory export subcommand.
 *
 * @module
 */

import { defineCommand } from "citty";
import { writeFileSync } from "node:fs";
import { MemoryStore } from "../../../memory/store.ts";
import { resolveProjectRoot } from "./memory-helpers.ts";

export const exportCommand = defineCommand({
  meta: {
    name: "export",
    description: "Export memory entries to markdown or json",
  },
  args: {
    format: {
      type: "string",
      description: "Output format (markdown|json)",
      default: "markdown",
    },
    output: {
      type: "string",
      alias: ["o"],
      description: "Write to file instead of stdout",
    },
  },
  run({ args }) {
    const projectDir = resolveProjectRoot(process.cwd());
    const store = new MemoryStore(projectDir);
    try {
      const summaries = store.list({ limit: 1000 });

      if (summaries.length === 0) {
        console.log("No memory entries to export.");
        return;
      }

      const format = args.format ?? "markdown";

      if (format === "json") {
        // Read full entries
        const entries = summaries
          .map((s) => store.read(s.id))
          .filter((e): e is NonNullable<typeof e> => e !== null);
        const output = JSON.stringify(entries, null, 2) + "\n";

        if (args.output) {
          writeFileSync(args.output, output, "utf-8");
          console.log(`Exported to ${args.output}`);
        } else {
          console.log(output);
        }
      } else if (format === "markdown") {
        const lines: string[] = [];
        lines.push("# Memory Export");
        lines.push("");
        lines.push(`Exported on ${new Date().toISOString()}`);
        lines.push("");

        for (const summary of summaries) {
          const entry = store.read(summary.id);
          if (!entry) continue;

          lines.push(`## ${entry.title}`);
          lines.push("");
          lines.push(`- **ID:** ${entry.id}`);
          lines.push(`- **Scope:** ${entry.scope}`);
          if (entry.role_id) lines.push(`- **Role:** ${entry.role_id}`);
          if (entry.category) lines.push(`- **Category:** ${entry.category}`);
          lines.push(`- **Relevance:** ${entry.relevance}`);
          lines.push(`- **Created:** ${entry.created_at}`);
          lines.push(`- **Updated:** ${entry.updated_at}`);
          lines.push(`- **Accessed:** ${entry.accessed_at ?? "never"}`);
          lines.push(`- **Access count:** ${entry.access_count}`);
          if (entry.tags && entry.tags.length > 0) {
            lines.push(`- **Tags:** ${entry.tags.join(", ")}`);
          }
          lines.push("");
          lines.push(entry.content);
          lines.push("");
        }

        const output = lines.join("\n");

        if (args.output) {
          writeFileSync(args.output, output, "utf-8");
          console.log(`Exported to ${args.output}`);
        } else {
          console.log(output);
        }
      } else {
        console.error(`Error: Unknown format "${format}". Use "markdown" or "json".`);
        process.exit(1);
      }
    } finally {
      store.close();
    }
  },
});
