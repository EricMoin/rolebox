/**
 * Memory clean subcommand.
 *
 * @module
 */

import { defineCommand } from "citty";
import { MemoryStore } from "../../memory/store.ts";
import { memoryDbPath } from "../../utils/state-paths.ts";
import { bold, dim } from "../format.ts";
import { resolveProjectRoot, truncate, relevanceLevels } from "./memory-helpers.ts";

export const cleanCommand = defineCommand({
  meta: {
    name: "clean",
    description: "Remove stale memory entries",
  },
  args: {
    "max-age-days": {
      type: "string",
      description: "Max age in days for entries with no access (default: 180)",
      default: "180",
    },
    "min-relevance": {
      type: "string",
      description: "Minimum relevance to keep (high|medium|low, default: low)",
      default: "low",
    },
    yes: {
      type: "boolean",
      alias: ["y"],
      description: "Perform deletion (without this flag it's a dry-run)",
    },
  },
  async run({ args }) {
    const projectDir = resolveProjectRoot(process.cwd());
    const store = new MemoryStore(projectDir);
    try {
      const maxAgeDays = parseInt(args["max-age-days"] ?? "180", 10);
      if (isNaN(maxAgeDays) || maxAgeDays < 1) {
        console.error("Error: --max-age-days must be a positive number");
        process.exit(1);
      }

      const minRelevance = args["min-relevance"] ?? "low";
      if (!["high", "medium", "low"].includes(minRelevance)) {
        console.error("Error: --min-relevance must be one of: high, medium, low");
        process.exit(1);
      }

      // Direct SQL query for efficiency — MemoryStore's public API doesn't
      // expose bulk query by access_count / accessed_at.
      const { Database } = await import("bun:sqlite");
      const dbPath = memoryDbPath(projectDir);
      const db = new Database(dbPath);

      try {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - maxAgeDays);
        const cutoffIso = cutoff.toISOString();

        const candidates = db
          .query(
            `SELECT id, title, category, relevance, accessed_at
             FROM memories
             WHERE access_count = 0 AND (accessed_at IS NULL OR accessed_at < ?)`,
          )
          .all(cutoffIso) as Array<{
          id: string;
          title: string;
          category: string;
          relevance: string;
          accessed_at: string | null;
        }>;

        // Filter by relevance
        const allowedLevels = relevanceLevels(minRelevance);
        const filtered = candidates.filter((c) => allowedLevels.includes(c.relevance));

        if (filtered.length === 0) {
          console.log("No stale memory entries to clean.");
          return;
        }

        if (args.yes) {
          const del = db.transaction(() => {
            let count = 0;
            for (const c of filtered) {
              db.run("DELETE FROM memories WHERE id = ?", [c.id]);
              count++;
            }
            return count;
          });
          const deleted = del();
          console.log(`Deleted ${deleted} stale memory entr${deleted === 1 ? "y" : "ies"}.`);
        } else {
          console.log(`Found ${filtered.length} candidate(s) for cleanup (dry-run):`);
          console.log(dim("  (use --yes to perform deletion)"));
          console.log("");
          console.log(
            `  ${bold("ID".padEnd(12))} ${bold("Title".padEnd(30))} ${bold("Relevance".padEnd(10))} ${bold("Last accessed")}`,
          );
          console.log(dim("  " + "\u2500".repeat(66)));
          for (const c of filtered) {
            const accessed = c.accessed_at ? c.accessed_at.slice(0, 10) : "never";
            console.log(
              `  ${dim(c.id.padEnd(12))} ${truncate(c.title, 30).padEnd(30)} ${c.relevance.padEnd(10)} ${accessed}`,
            );
          }
        }
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  },
});
