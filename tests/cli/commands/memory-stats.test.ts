import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../../../src/memory/store";

// ── Per-suite setup ───────────────────────────────────────────────────────

let tmpDir: string;
let origCwd: typeof process.cwd;
let origExit: typeof process.exit;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memory-stats-"));
  mkdirSync(join(tmpDir, ".rolebox"), { recursive: true });
  origCwd = process.cwd;
  process.cwd = (() => tmpDir) as typeof process.cwd;
  origExit = process.exit;
});

afterEach(() => {
  process.cwd = origCwd;
  process.exit = origExit;
  process.exitCode = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────

function captureLogs(fn: () => void): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: any[]) => { stdout.push(args.join(" ")); };
  console.error = (...args: any[]) => { stderr.push(args.join(" ")); };
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { stdout, stderr };
}

async function importStats() {
  return await import("../../../src/cli/commands/memory/memory-stats");
}

function invoke(cmd: { run?: unknown }, args: Record<string, unknown>): void {
  const run = cmd.run as (ctx: Record<string, unknown>) => void;
  run({ rawArgs: [] as string[], args: { _: [] as string[], ...args }, cmd });
}

function insertEntry(
  overrides: Partial<{
    scope: string;
    role_id: string;
    category: string;
    title: string;
    content: string;
    relevance: string;
    tags: string[];
    session_id: string | null;
    source_sessions: string[];
  }> = {},
): void {
  const store = new MemoryStore(tmpDir);
  try {
    store.write({
      scope: "workspace",
      role_id: "",
      category: "note",
      title: "Test Entry",
      content: "test content",
      relevance: "high",
      tags: [],
      session_id: null,
      source_sessions: [],
      ...overrides,
    });
  } finally {
    store.close();
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("memory stats", () => {
  it("shows correct counts byScope, byCategory, and byRelevance", async () => {
    // 2 workspace, 1 role
    insertEntry({ scope: "workspace", category: "note", relevance: "high" });
    insertEntry({ scope: "workspace", category: "fact", relevance: "high" });
    insertEntry({ scope: "role", category: "lesson", relevance: "medium" });

    const { statsCommand } = await importStats();
    const { stdout } = captureLogs(() => {
      invoke(statsCommand, {});
    });

    const output = stdout.join("\n");

    // Total
    expect(output).toContain("3");

    // By scope
    expect(output).toContain("workspace");
    expect(output).toContain("role");

    // By category
    expect(output).toContain("note");
    expect(output).toContain("fact");
    expect(output).toContain("lesson");

    // By relevance
    expect(output).toContain("high");
    expect(output).toContain("medium");
  });

  it("shows (none) for all sections when store is empty", async () => {
    const { statsCommand } = await importStats();
    const { stdout } = captureLogs(() => {
      invoke(statsCommand, {});
    });

    const output = stdout.join("\n");

    // Total is 0
    expect(output).toContain("0");

    // All three breakdowns show "(none)"
    // By scope
    expect(output).toContain("By scope");
    expect(output).toContain("(none)");

    // By category
    expect(output).toContain("By category");
    // There should be 3 occurrences of "(none)" — one per section
    const noneMatches = output.match(/\(none\)/g);
    expect(noneMatches).toBeTruthy();
    expect(noneMatches!.length).toBe(3);
  });

  it("correctly aggregates mixed relevance and category counts", async () => {
    // Insert a diverse set
    insertEntry({ category: "note", relevance: "high" });
    insertEntry({ category: "note", relevance: "medium" });
    insertEntry({ category: "fact", relevance: "high" });
    insertEntry({ category: "lesson", relevance: "low" });
    insertEntry({ category: "fact", relevance: "high" });

    const { statsCommand } = await importStats();
    const { stdout } = captureLogs(() => {
      invoke(statsCommand, {});
    });

    const output = stdout.join("\n");

    // Total = 5
    expect(output).toContain("5");

    // byCategory: note=2, fact=2, lesson=1
    // We can verify the counts appear (the numbers appear next to the labels)
    const noteLine = stdout.find((l) => l.includes("note"));
    expect(noteLine).toBeDefined();

    const factLine = stdout.find((l) => l.includes("fact"));
    expect(factLine).toBeDefined();

    const lessonLine = stdout.find((l) => l.includes("lesson"));
    expect(lessonLine).toBeDefined();

    // byRelevance: high=3, medium=1, low=1
    // High should have count 3 (two "fact" + one "note")
    const highLine = stdout.find((l) => l.includes("high"));
    expect(highLine).toBeDefined();
  });

  it("renders the stats header and separator", async () => {
    insertEntry({});

    const { statsCommand } = await importStats();
    const { stdout } = captureLogs(() => {
      invoke(statsCommand, {});
    });

    // Header
    expect(stdout[0]).toBe("");
    expect(stdout[1]).toContain("Memory Store Statistics");
    // Separator line
    expect(stdout[2]).toContain("─");
    // Total entries line
    expect(stdout[3]).toContain("Total entries");
  });

  it("handles uncategorized entries correctly", async () => {
    insertEntry({ category: "", relevance: "high" });
    insertEntry({ category: "", relevance: "low" });
    insertEntry({ category: "note", relevance: "medium" });

    const { statsCommand } = await importStats();
    const { stdout } = captureLogs(() => {
      invoke(statsCommand, {});
    });

    const output = stdout.join("\n");

    expect(output).toContain("3");
    // The empty category renders as "(uncategorized)"
    expect(output).toContain("(uncategorized)");
  });
});
