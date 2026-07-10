/**
 * Memory list subcommand.
 *
 * @module
 */

import { defineCommand } from "citty";
import { MemoryStore } from "../../../memory/store.ts";
import { bold, dim } from "../../format.ts";
import { resolveProjectRoot, truncate } from "./memory-helpers.ts";

export const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List memory entries",
  },
  args: {
    scope: {
      type: "string",
      description: "Filter by scope (workspace|role|both)",
      default: "both",
    },
    category: {
      type: "string",
      description: "Filter by category",
    },
    limit: {
      type: "string",
      description: "Max entries (default: 20)",
      default: "20",
    },
    sort: {
      type: "string",
      description: "Sort order (recent|relevance|accessed)",
      default: "recent",
    },
  },
  run({ args }) {
    const projectDir = resolveProjectRoot(process.cwd());
    const store = new MemoryStore(projectDir);
    try {
      const entries = store.list({
        scope: args.scope,
        category: args.category,
        limit: parseInt(args.limit ?? "20", 10),
        sort: (args.sort ?? "recent") as "recent" | "relevance" | "accessed",
      });

      if (entries.length === 0) {
        console.log("No memory entries found.");
        return;
      }

      console.log(
        `  ${bold("ID".padEnd(12))} ${bold("Title".padEnd(30))} ${bold("Category".padEnd(16))} ${bold("Relevance".padEnd(10))} ${bold("Updated")}`,
      );
      console.log(dim("  " + "\u2500".repeat(88)));
      for (const entry of entries) {
        console.log(
          `  ${dim(entry.id.padEnd(12))} ${truncate(entry.title, 30).padEnd(30)} ${(entry.category || "-").padEnd(16)} ${entry.relevance.padEnd(10)} ${entry.updated_at.slice(0, 10)}`,
        );
      }
    } finally {
      store.close();
    }
  },
});
