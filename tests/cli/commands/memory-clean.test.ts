/**
 * Tests for `opencode memory clean`.
 *
 * NOTE: The clean command bypasses MemoryStore for the SQL query and uses
 * `bun:sqlite` directly.  Tests pre-fill data via raw SQL INSERT so the
 * command's own Database() connection can read it.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { memoryDbPath } from "../../../src/utils/state-paths";
import { ensureMemorySchema } from "../../../src/memory/schema";

// ── Types ─────────────────────────────────────────────────────────────────

interface EntryOverrides {
  id?: string;
  scope?: string;
  category?: string;
  title?: string;
  content?: string;
  relevance?: string;
  access_count?: number;
  accessed_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

// ── Per-suite setup ───────────────────────────────────────────────────────

let tmpDir: string;
let origCwd: typeof process.cwd;
let origExit: typeof process.exit;
/** Captured exit code set by the mocked process.exit */
let exitCode: number | undefined;

/** Create/open the test DB with schema, at the temp dir's memory.db path. */
function openDb(): Database {
  const dbPath = memoryDbPath(tmpDir);
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  ensureMemorySchema(db);
  return db;
}

/** Insert a single entry using raw SQL (controlled timestamps). */
function insertEntry(db: Database, overrides: EntryOverrides = {}): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO memories
       (id, scope, role_id, category, title, content, tags,
        relevance, created_at, updated_at, accessed_at, access_count,
        session_id, source_sessions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      overrides.id ?? "test_" + Math.random().toString(36).slice(2, 10),
      overrides.scope ?? "workspace",
      "",
      overrides.category ?? "note",
      overrides.title ?? "Test Entry",
      overrides.content ?? "test content",
      "[]",
      overrides.relevance ?? "medium",
      overrides.created_at ?? now,
      overrides.updated_at ?? now,
      overrides.accessed_at ?? null,
      overrides.access_count ?? 0,
      null,
      "[]",
    ],
  );
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memory-clean-"));
  mkdirSync(join(tmpDir, ".rolebox"), { recursive: true });
  origCwd = process.cwd;
  process.cwd = (() => tmpDir) as typeof process.cwd;
  origExit = process.exit;
  exitCode = undefined;

  // Mock process.exit: capture the code and throw to halt execution
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    const err = new Error(`process.exit(${code})`);
    (err as any).__exitSignal = true;
    throw err;
  }) as typeof process.exit;
});

afterEach(() => {
  process.cwd = origCwd;
  process.exit = origExit;
  process.exitCode = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────

async function captureLogs(
  fn: () => Promise<void>,
): Promise<{ stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: any[]) => {
    stdout.push(args.join(" "));
  };
  console.error = (...args: any[]) => {
    stderr.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { stdout, stderr };
}

async function invokeClean(
  args: Record<string, unknown>,
): Promise<void> {
  const { cleanCommand } = await import(
    "../../../src/cli/commands/memory/memory-clean"
  );
  const run = cleanCommand.run as (ctx: Record<string, unknown>) => Promise<void>;
  await run({
    rawArgs: [] as string[],
    args: { _: [] as string[], ...args },
    cmd: cleanCommand,
  });
}

/** Number of rows currently in the memories table. */
function countRows(): number {
  const dbPath = memoryDbPath(tmpDir);
  const db = new Database(dbPath);
  try {
    return (db.query("SELECT COUNT(*) AS cnt FROM memories").get() as any).cnt;
  } finally {
    db.close();
  }
}

/** Titles currently in the memories table. */
function allTitles(): string[] {
  const dbPath = memoryDbPath(tmpDir);
  const db = new Database(dbPath);
  try {
    return (
      db.query("SELECT title FROM memories ORDER BY title").all() as Array<{
        title: string;
      }>
    ).map((r) => r.title);
  } finally {
    db.close();
  }
}

// ── Constants ─────────────────────────────────────────────────────────────

/** ISO date ~200 days ago — definitely outside the default 180d cutoff. */
const OLD_ISO = new Date(Date.now() - 200 * 86400000).toISOString();
/** ISO date yesterday — well inside the cutoff window. */
const RECENT_ISO = new Date(Date.now() - 86400000).toISOString();
/** ISO date 90 days ago — inside the cutoff but useful for medium-aged entries. */
const MID_ISO = new Date(Date.now() - 90 * 86400000).toISOString();

// ── Tests ─────────────────────────────────────────────────────────────────

describe("memory clean", () => {
  // ── Validation errors ─────────────────────────────────────────────────

  describe("validation", () => {
    it("rejects non-numeric --max-age-days", async () => {
      const { stderr } = await captureLogs(async () => {
        try {
          await invokeClean({ "max-age-days": "abc" });
        } catch {
          /* expected — process.exit throws */
        }
      });
      expect(exitCode).toBe(1);
      expect(stderr[0]).toContain("must be a positive number");
    });

    it("rejects negative --max-age-days", async () => {
      const { stderr } = await captureLogs(async () => {
        try {
          await invokeClean({ "max-age-days": "-1" });
        } catch {
          /* expected */
        }
      });
      expect(exitCode).toBe(1);
      expect(stderr[0]).toContain("must be a positive number");
    });

    it("rejects zero --max-age-days", async () => {
      const { stderr } = await captureLogs(async () => {
        try {
          await invokeClean({ "max-age-days": "0" });
        } catch {
          /* expected */
        }
      });
      expect(exitCode).toBe(1);
      expect(stderr[0]).toContain("must be a positive number");
    });

    it("rejects invalid --min-relevance", async () => {
      const { stderr } = await captureLogs(async () => {
        try {
          await invokeClean({ "min-relevance": "invalid" });
        } catch {
          /* expected */
        }
      });
      expect(exitCode).toBe(1);
      expect(stderr[0]).toContain("must be one of");
    });
  });

  // ── Empty store ───────────────────────────────────────────────────────

  describe("empty store", () => {
    it('prints "No stale memory entries to clean." when store is empty', async () => {
      // Create schema (no entries)
      const db = openDb();
      db.close();

      const { stdout } = await captureLogs(() => invokeClean({}));
      expect(stdout.some((l) => l.includes("No stale memory entries to clean."))).toBe(true);
    });
  });

  // ── Dry-run ───────────────────────────────────────────────────────────

  describe("dry-run", () => {
    it("lists candidates without deleting them when --yes is absent", async () => {
      const db = openDb();
      insertEntry(db, {
        id: "stale_1",
        title: "Stale Entry",
        accessed_at: OLD_ISO,
        access_count: 0,
      });
      insertEntry(db, {
        id: "stale_2",
        title: "Another Stale",
        accessed_at: OLD_ISO,
        access_count: 0,
      });
      insertEntry(db, {
        id: "fresh",
        title: "Fresh Entry",
        accessed_at: RECENT_ISO,
        access_count: 0,
      });
      db.close();

      const { stdout } = await captureLogs(() => invokeClean({}));

      // Shows candidate summary
      expect(stdout.some((l) => l.includes("candidate"))).toBe(true);
      expect(stdout.some((l) => l.includes("dry-run"))).toBe(true);

      // Entries still exist after dry-run
      expect(countRows()).toBe(3);
    });
  });

  // ── Delete ────────────────────────────────────────────────────────────

  describe("delete", () => {
    it("removes stale entries and keeps non-stale when --yes is passed", async () => {
      const db = openDb();
      // Stale: access_count=0, accessed_at far in the past
      insertEntry(db, {
        id: "stale1",
        title: "Stale Alpha",
        accessed_at: OLD_ISO,
        access_count: 0,
        relevance: "low",
      });
      insertEntry(db, {
        id: "stale2",
        title: "Stale Beta",
        accessed_at: null,
        access_count: 0,
        relevance: "low",
      });
      // Non-stale: recent access
      insertEntry(db, {
        id: "fresh1",
        title: "Fresh Entry",
        accessed_at: RECENT_ISO,
        access_count: 0,
        relevance: "low",
      });
      db.close();

      const { stdout } = await captureLogs(() =>
        invokeClean({ yes: true }),
      );

      expect(stdout.some((l) => l.includes("Deleted"))).toBe(true);
      expect(stdout.some((l) => l.includes("entries"))).toBe(true);
      expect(countRows()).toBe(1);
      expect(allTitles()).toEqual(["Fresh Entry"]);
    });

    it("does not delete entries with access_count > 0", async () => {
      const db = openDb();
      // access_count > 0, old accessed_at — should NOT be cleaned
      insertEntry(db, {
        id: "busy",
        title: "Busy Entry",
        accessed_at: OLD_ISO,
        access_count: 5,
        relevance: "low",
      });
      // Truly stale
      insertEntry(db, {
        id: "stale",
        title: "Stale Entry",
        accessed_at: OLD_ISO,
        access_count: 0,
        relevance: "low",
      });
      db.close();

      const { stdout } = await captureLogs(() =>
        invokeClean({ yes: true }),
      );

      expect(stdout.some((l) => l.includes("Deleted"))).toBe(true);
      expect(countRows()).toBe(1);
      expect(allTitles()).toEqual(["Busy Entry"]);
    });

    it("respects --min-relevance filter when deleting", async () => {
      const db = openDb();
      // All stale (old accessed_at, access_count=0)
      insertEntry(db, {
        id: "high1",
        title: "High Relevance",
        accessed_at: OLD_ISO,
        access_count: 0,
        relevance: "high",
      });
      insertEntry(db, {
        id: "med1",
        title: "Medium Relevance",
        accessed_at: OLD_ISO,
        access_count: 0,
        relevance: "medium",
      });
      insertEntry(db, {
        id: "low1",
        title: "Low Relevance",
        accessed_at: OLD_ISO,
        access_count: 0,
        relevance: "low",
      });
      db.close();

      // --min-relevance=high means only "high" entries are candidates
      const { stdout } = await captureLogs(() =>
        invokeClean({ yes: true, "min-relevance": "high" }),
      );

      expect(stdout.some((l) => l.includes("Deleted 1"))).toBe(true);
      expect(countRows()).toBe(2);
      expect(allTitles()).toEqual(["Low Relevance", "Medium Relevance"]);
    });
  });
});
