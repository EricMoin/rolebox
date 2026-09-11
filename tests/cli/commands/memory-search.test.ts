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
  tmpDir = mkdtempSync(join(tmpdir(), "memory-search-"));
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

async function captureLogs(fn: () => Promise<void> | void): Promise<{ stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: any[]) => { stdout.push(args.join(" ")); };
  console.error = (...args: any[]) => { stderr.push(args.join(" ")); };
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { stdout, stderr };
}

async function importSearch() {
  return await import("../../../src/cli/commands/memory/memory-search");
}

function invoke(cmd: { run?: unknown }, args: Record<string, unknown>): Promise<void> {
  const run = cmd.run as (ctx: Record<string, unknown>) => Promise<void>;
  return run({ rawArgs: [] as string[], args: { _: [] as string[], ...args }, cmd });
}

async function insertEntry(
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
): Promise<void> {
  const store = await MemoryStore.create(tmpDir);
  try {
    store.write({
      scope: "workspace",
      role_id: "",
      category: "note",
      title: "Test Entry",
      content: "default content for testing purposes",
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

describe("memory search", () => {
  it("returns matching entries in table format with header", async () => {
    await insertEntry({ title: "Apple Entry", content: "This entry is about apples and orchards." });
    await insertEntry({ title: "Banana Entry", content: "This entry is about bananas." });

    const { searchCommand } = await importSearch();
    const { stdout } = await captureLogs(() =>
      invoke(searchCommand, { query: "apple", scope: "both", limit: "10", _: ["apple"] }),
    );

    // Header row
    expect(stdout[0]).toContain("ID");
    expect(stdout[0]).toContain("Title");
    expect(stdout[0]).toContain("Category");
    expect(stdout[0]).toContain("Relevance");
    expect(stdout[0]).toContain("Content");

    // Separator
    expect(stdout[1]).toContain("─");

    // Matching entry appears
    const dataLine = stdout.slice(2).find((l) => l.includes("Apple Entry"));
    expect(dataLine).toBeDefined();
    // Content snippet should contain the matched text
    expect(dataLine).toContain("apples");

    // Non-matching entry should not appear
    const bananaLine = stdout.slice(2).find((l) => l.includes("Banana Entry"));
    expect(bananaLine).toBeUndefined();
  });

  it("shows 'No results' message when query matches nothing", async () => {
    await insertEntry({ title: "Existing Entry", content: "something searchable" });

    const { searchCommand } = await importSearch();
    const { stdout } = await captureLogs(() =>
      invoke(searchCommand, { query: "nonexistent-term", scope: "both", limit: "10", _: ["nonexistent-term"] }),
    );

    expect(stdout.some((l) => l.includes('No results for "nonexistent-term"'))).toBe(true);
  });

  it("filters by scope", async () => {
    await insertEntry({ scope: "workspace", title: "Workspace Match", content: "unique searchable data x1yz" });
    await insertEntry({ scope: "role", title: "Role Match", content: "unique searchable data x1yz" });

    const { searchCommand } = await importSearch();

    // Scope = workspace
    const r1 = await captureLogs(() =>
      invoke(searchCommand, { query: "x1yz", scope: "workspace", limit: "10", _: ["x1yz"] }),
    );
    expect(r1.stdout.some((l) => l.includes("Workspace Match"))).toBe(true);
    expect(r1.stdout.some((l) => l.includes("Role Match"))).toBe(false);

    // Scope = role
    const r2 = await captureLogs(() =>
      invoke(searchCommand, { query: "x1yz", scope: "role", limit: "10", _: ["x1yz"] }),
    );
    expect(r2.stdout.some((l) => l.includes("Role Match"))).toBe(true);
    expect(r2.stdout.some((l) => l.includes("Workspace Match"))).toBe(false);
  });

  it("respects limit argument", async () => {
    await insertEntry({ title: "Entry One", content: "common term zzzmatch" });
    await insertEntry({ title: "Entry Two", content: "common term zzzmatch" });
    await insertEntry({ title: "Entry Three", content: "common term zzzmatch" });

    const { searchCommand } = await importSearch();
    const { stdout } = await captureLogs(() =>
      invoke(searchCommand, { query: "zzzmatch", scope: "both", limit: "2", _: ["zzzmatch"] }),
    );

    const entryLines = stdout.filter(
      (l) => l.includes("Entry One") || l.includes("Entry Two") || l.includes("Entry Three"),
    );
    expect(entryLines.length).toBe(2);
  });

  it("defines query argument as positional and required", async () => {
    const { searchCommand } = await importSearch();
    const queryDef = (searchCommand as any).args?.query;
    expect(queryDef).toBeDefined();
    expect(queryDef.type).toBe("positional");
    expect(queryDef.required).toBe(true);
  });

  it("truncates long content in the output", async () => {
    const longContent = "truncateme " + "A ".repeat(148);
    await insertEntry({
      title: "Long Content Entry",
      content: longContent,
    });

    const { searchCommand } = await importSearch();
    const { stdout } = await captureLogs(() =>
      invoke(searchCommand, { query: "truncateme", scope: "both", limit: "10", _: ["truncateme"] }),
    );

    // Content snippet should be truncated (end with …)
    const dataLine = stdout.slice(2).find((l) => l.includes("Long Content Entry"));
    expect(dataLine).toBeDefined();
    expect(dataLine).toMatch(/…$/);
  });
});
