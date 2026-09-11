/**
 * Memory stats subcommand.
 *
 * @module
 */

import { defineCommand } from "citty";
import { MemoryStore } from "../../../memory/store.ts";
import { bold, dim, cyan } from "../../format.ts";
import { resolveProjectRoot } from "./memory-helpers.ts";

export const statsCommand = defineCommand({
  meta: {
    name: "stats",
    description: "Show memory store statistics",
  },
  async run({ args: _args }) {
    const projectDir = resolveProjectRoot(process.cwd());
    const store = await MemoryStore.create(projectDir);
    try {
      const s = store.stats();

      console.log("");
      console.log(`  ${bold("Memory Store Statistics")}`);
      console.log(dim("  " + "\u2500".repeat(36)));
      console.log(`  ${dim("Total entries:".padEnd(18))} ${cyan(String(s.total))}`);

      console.log(`  ${dim("By scope:".padEnd(18))}`);
      const scopeKeys = Object.keys(s.byScope);
      if (scopeKeys.length === 0) {
        console.log(`    ${dim("(none)")}`);
      } else {
        for (const key of scopeKeys) {
          console.log(`    ${key.padEnd(12)} ${cyan(String(s.byScope[key]))}`);
        }
      }

      console.log(`  ${dim("By category:".padEnd(18))}`);
      const catKeys = Object.keys(s.byCategory);
      if (catKeys.length === 0) {
        console.log(`    ${dim("(none)")}`);
      } else {
        for (const key of catKeys) {
          const label = key || "(uncategorized)";
          console.log(`    ${label.padEnd(16)} ${cyan(String(s.byCategory[key]))}`);
        }
      }

      console.log(`  ${dim("By relevance:".padEnd(18))}`);
      const relKeys = Object.keys(s.byRelevance);
      if (relKeys.length === 0) {
        console.log(`    ${dim("(none)")}`);
      } else {
        for (const key of relKeys) {
          console.log(`    ${key.padEnd(10)} ${cyan(String(s.byRelevance[key]))}`);
        }
      }

      console.log("");
    } finally {
      store.close();
    }
  },
});
