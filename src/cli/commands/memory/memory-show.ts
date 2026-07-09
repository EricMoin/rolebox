/**
 * Memory show subcommand.
 *
 * @module
 */

import { defineCommand } from "citty";
import { MemoryStore } from "../../../memory/store.ts";
import { bold, dim } from "../../format.ts";
import { resolveProjectRoot } from "./memory-helpers.ts";

export const showCommand = defineCommand({
  meta: {
    name: "show",
    description: "Show full details of a memory entry",
  },
  args: {
    id: {
      type: "positional",
      description: "Memory entry ID",
      required: true,
    },
  },
  run({ args }) {
    const projectDir = resolveProjectRoot(process.cwd());
    const store = new MemoryStore(projectDir);
    try {
      const entry = store.read(args.id);
      if (!entry) {
        console.error(`Memory not found: ${args.id}`);
        process.exit(1);
      }

      console.log("");
      console.log(`  ${bold(entry.title)}`);
      console.log(dim("  " + "\u2500".repeat(50)));
      console.log(`  ${dim("ID:".padEnd(14))} ${entry.id}`);
      console.log(`  ${dim("Scope:".padEnd(14))} ${entry.scope}`);
      if (entry.role_id) console.log(`  ${dim("Role:".padEnd(14))} ${entry.role_id}`);
      if (entry.category) console.log(`  ${dim("Category:".padEnd(14))} ${entry.category}`);
      console.log(`  ${dim("Relevance:".padEnd(14))} ${entry.relevance}`);
      console.log(`  ${dim("Created:".padEnd(14))} ${entry.created_at}`);
      console.log(`  ${dim("Updated:".padEnd(14))} ${entry.updated_at}`);
      console.log(`  ${dim("Accessed:".padEnd(14))} ${entry.accessed_at ?? "never"}`);
      console.log(`  ${dim("Access count:".padEnd(14))} ${entry.access_count}`);
      if (entry.tags && entry.tags.length > 0) {
        console.log(`  ${dim("Tags:".padEnd(14))} ${entry.tags.join(", ")}`);
      }
      if (entry.session_id) console.log(`  ${dim("Session:".padEnd(14))} ${entry.session_id}`);
      if (entry.source_sessions && entry.source_sessions.length > 0) {
        console.log(`  ${dim("Source sessions:".padEnd(14))} ${entry.source_sessions.join(", ")}`);
      }
      console.log("");
      console.log(`  ${bold("Content")}`);
      console.log(dim("  " + "\u2500".repeat(50)));
      console.log(`  ${entry.content}`);
      console.log("");
    } finally {
      store.close();
    }
  },
});
