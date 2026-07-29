/**
 * Memory delete subcommand.
 *
 * @module
 */

import { defineCommand } from "citty";
import { MemoryStore } from "../../../memory/store.ts";
import { resolveProjectRoot } from "./memory-helpers.ts";

export const deleteCommand = defineCommand({
  meta: {
    name: "delete",
    description: "Delete a memory entry",
  },
  args: {
    id: {
      type: "positional",
      description: "Memory entry ID to delete",
      required: true,
    },
    yes: {
      type: "boolean",
      alias: ["y"],
      description: "Skip confirmation prompt",
    },
  },
  async run({ args }) {
    const projectDir = resolveProjectRoot(process.cwd());
    const store = await MemoryStore.create(projectDir);
    try {
      // Confirm unless --yes
      if (!args.yes) {
        // Refuse to block on a non-interactive stdin read; require --yes instead.
        if (!process.stdin.isTTY) {
          console.error(
            "Error: Confirmation requires an interactive terminal. Re-run with --yes to skip the prompt.",
          );
          process.exitCode = 1;
          return;
        }
        console.log(`Delete memory ${args.id}? (y/N)`);
        // Use a synchronous read from stdin for confirmation
        const answer = (prompt("") ?? "").toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          console.log("Cancelled.");
          return;
        }
      }

      const entry = store.read(args.id);
      if (!entry) {
        console.log(`Not found: ${args.id}`);
        return;
      }

      store.delete(args.id);
      console.log(`Deleted: ${args.id}`);
    } finally {
      store.close();
    }
  },
});
