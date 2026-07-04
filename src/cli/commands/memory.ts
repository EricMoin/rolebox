import { defineCommand } from "citty";
import { existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { MemoryStore } from "../../memory/store.ts";
import { memoryDbPath } from "../../state-paths.ts";
import { bold, dim, green, yellow, red, cyan } from "../format.ts";

// ── Helpers ─────────────────────────────────────────────────────────

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

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "\u2026";
}

function relevanceLevels(minRelevance: string): string[] {
  const order = ["high", "medium", "low"];
  const idx = order.indexOf(minRelevance);
  if (idx === -1) return ["high", "medium", "low"];
  return order.slice(0, idx + 1);
}

// ── List subcommand ─────────────────────────────────────────────────

const listCommand = defineCommand({
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

// ── Show subcommand ─────────────────────────────────────────────────

const showCommand = defineCommand({
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

// ── Search subcommand ───────────────────────────────────────────────

const searchCommand = defineCommand({
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

// ── Delete subcommand ───────────────────────────────────────────────

const deleteCommand = defineCommand({
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
  run({ args }) {
    const projectDir = resolveProjectRoot(process.cwd());
    const store = new MemoryStore(projectDir);
    try {
      // Confirm unless --yes
      if (!args.yes) {
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

// ── Export subcommand ───────────────────────────────────────────────

const exportCommand = defineCommand({
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

// ── Clean subcommand ────────────────────────────────────────────────

const cleanCommand = defineCommand({
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

// ── Stats subcommand ────────────────────────────────────────────────

const statsCommand = defineCommand({
  meta: {
    name: "stats",
    description: "Show memory store statistics",
  },
  run({ args: _args }) {
    const projectDir = resolveProjectRoot(process.cwd());
    const store = new MemoryStore(projectDir);
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

// ── Main command ────────────────────────────────────────────────────

export default defineCommand({
  meta: {
    name: "memory",
    description: "Manage rolebox memory store",
  },
  subCommands: {
    list: listCommand,
    show: showCommand,
    search: searchCommand,
    delete: deleteCommand,
    export: exportCommand,
    clean: cleanCommand,
    stats: statsCommand,
  },
});
