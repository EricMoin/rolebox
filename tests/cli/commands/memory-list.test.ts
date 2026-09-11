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
  tmpDir = mkdtempSync(join(tmpdir(), "memory-list-"));
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

async function importList() {
  return await import("../../../src/cli/commands/memory/memory-list");
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

function invoke(cmd: { run?: unknown }, args: Record<string, unknown>): Promise<void> {
  const run = cmd.run as (ctx: Record<string, unknown>) => Promise<void>;
  return run({ rawArgs: [] as string[], args: { _: [] as string[], ...args }, cmd });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("memory list", () => {
  it("shows 'No memory entries found' when store is empty", async () => {
    const { listCommand } = await importList();
    const { stdout } = await captureLogs(() =>
        invoke(listCommand, { scope: "both", limit: "20", sort: "recent" }),
    );
    expect(stdout.some((l) => l.includes("No memory entries found"))).toBe(true);
  });

  it("displays entries in table format with header and separator", async () => {
    await insertEntry({ title: "Alpha Entry" });

    const { listCommand } = await importList();
    const { stdout } = await captureLogs(() =>
        invoke(listCommand, { scope: "both", limit: "20", sort: "recent" }),
    );

    // Header row
    expect(stdout[0]).toContain("ID");
    expect(stdout[0]).toContain("Title");
    expect(stdout[0]).toContain("Category");
    expect(stdout[0]).toContain("Relevance");
    expect(stdout[0]).toContain("Updated");

    // Separator (dimmed line)
    expect(stdout[1]).toContain("─");

    // Data row includes the entry title
    const dataLine = stdout.slice(2).find((l) => l.includes("Alpha Entry"));
    expect(dataLine).toBeDefined();
  });

  it("filters by scope", async () => {
    await insertEntry({ scope: "workspace", title: "Workspace Entry" });
    await insertEntry({ scope: "role", title: "Role Entry" });

    const { listCommand } = await importList();

    const r1 = await captureLogs(() =>
        invoke(listCommand, { scope: "workspace", limit: "20", sort: "recent" }),
    );
    expect(r1.stdout.some((l) => l.includes("Workspace Entry"))).toBe(true);
    expect(r1.stdout.some((l) => l.includes("Role Entry"))).toBe(false);

    const r2 = await captureLogs(() =>
        invoke(listCommand, { scope: "role", limit: "20", sort: "recent" }),
    );
    expect(r2.stdout.some((l) => l.includes("Role Entry"))).toBe(true);
    expect(r2.stdout.some((l) => l.includes("Workspace Entry"))).toBe(false);
  });

  it("filters by category", async () => {
    await insertEntry({ category: "note", title: "Note Entry" });
    await insertEntry({ category: "fact", title: "Fact Entry" });

    const { listCommand } = await importList();
    const { stdout } = await captureLogs(() =>
        invoke(listCommand, { scope: "both", category: "note", limit: "20", sort: "recent" }),
    );
    expect(stdout.some((l) => l.includes("Note Entry"))).toBe(true);
    expect(stdout.some((l) => l.includes("Fact Entry"))).toBe(false);
  });

  it("respects non-default limit", async () => {
    await insertEntry({ title: "Entry A" });
    await insertEntry({ title: "Entry B" });

    const { listCommand } = await importList();
    const { stdout } = await captureLogs(() =>
        invoke(listCommand, { scope: "both", limit: "1", sort: "recent" }),
    );
    // Only one entry should appear in the data rows
    const entryLines = stdout.filter((l) => l.includes("Entry A") || l.includes("Entry B"));
    expect(entryLines.length).toBe(1);
  });

  it("sorts by relevance (high before low)", async () => {
    await insertEntry({ relevance: "low", title: "Low Entry" });
    await insertEntry({ relevance: "high", title: "High Entry" });

    const { listCommand } = await importList();
    const { stdout } = await captureLogs(() =>
        invoke(listCommand, { scope: "both", limit: "20", sort: "relevance" }),
    );
    const highIdx = stdout.findIndex((l) => l.includes("High Entry"));
    const lowIdx = stdout.findIndex((l) => l.includes("Low Entry"));
    expect(highIdx).toBeGreaterThanOrEqual(0);
    expect(lowIdx).toBeGreaterThanOrEqual(0);
    expect(highIdx).toBeLessThan(lowIdx);
  });
});
