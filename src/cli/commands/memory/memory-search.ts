/**
 * Memory search subcommand.
 *
 * @module
 */

import { defineCommand } from "citty";
import { MemoryStore } from "../../../memory/store.ts";
import { bold, dim } from "../../format.ts";
import { resolveProjectRoot, truncate } from "./memory-helpers.ts";

export const searchCommand = defineCommand({
  meta: {
    name: "search",
    description: "Full-text search memory entries",
  },
  args: {
    query: {
      type: "positional",
      description: "Search query",
      required: true,
    },
    scope: {
      type: "string",
      description: "Filter by scope (workspace|role|both)",
      default: "both",
    },
    limit: {
      type: "string",
      description: "Max results (default: 10)",
      default: "10",
    },
  },
  run({ args }) {
    const projectDir = resolveProjectRoot(process.cwd());
    const store = new MemoryStore(projectDir);
    try {
      const results = store.search({
        query: args.query,
        scope: args.scope,
        limit: parseInt(args.limit ?? "10", 10),
      });

      if (results.length === 0) {
        console.log(`No results for "${args.query}".`);
        return;
      }

      console.log(
        `  ${bold("ID".padEnd(12))} ${bold("Title".padEnd(30))} ${bold("Category".padEnd(16))} ${bold("Relevance".padEnd(10))} ${bold("Content")}`,
      );
      console.log(dim("  " + "\u2500".repeat(88)));
      for (const entry of results) {
        const snippet = truncate(entry.content.replace(/\n/g, " "), 200);
        console.log(
          `  ${dim(entry.id.padEnd(12))} ${truncate(entry.title, 30).padEnd(30)} ${(entry.category || "-").padEnd(16)} ${entry.relevance.padEnd(10)} ${snippet}`,
        );
      }
    } finally {
      store.close();
    }
  },
});
