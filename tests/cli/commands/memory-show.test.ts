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
  tmpDir = mkdtempSync(join(tmpdir(), "memory-show-"));
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

async function importShow() {
  return await import("../../../src/cli/commands/memory/memory-show");
}

function invoke(cmd: { run?: unknown }, args: Record<string, unknown>): void {
  const run = cmd.run as (ctx: Record<string, unknown>) => void;
  run({ rawArgs: [] as string[], args: { _: [] as string[], ...args }, cmd });
}

async function insertDefaultEntry(): Promise<string> {
  const store = await MemoryStore.create(tmpDir);
  try {
    return store.write({
      scope: "workspace",
      role_id: "test-role",
      category: "note",
      title: "Test Memory Title",
      content: "This is the memory content body.",
      relevance: "high",
      tags: ["alpha", "beta"],
      session_id: "sess-001",
      source_sessions: ["sess-001", "sess-002"],
    });
  } finally {
    store.close();
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("memory show", () => {
  it("renders all fields for an existing entry", async () => {
    const entryId = await insertDefaultEntry();

    const { showCommand } = await importShow();
    const { stdout } = captureLogs(() => {
      invoke(showCommand, { id: entryId, _: [entryId] });
    });

    const output = stdout.join("\n");

    // Title rendered bold-style (just the text check)
    expect(output).toContain("Test Memory Title");

    // ID
    expect(output).toContain(entryId);

    // Scope
    expect(output).toContain("workspace");

    // Role
    expect(output).toContain("test-role");

    // Category
    expect(output).toContain("note");

    // Relevance
    expect(output).toContain("high");

    // Content
    expect(output).toContain("This is the memory content body.");

    // Tags
    expect(output).toContain("alpha");
    expect(output).toContain("beta");

    // Session
    expect(output).toContain("sess-001");

    // Source sessions
    expect(output).toContain("sess-002");

    // Timestamps rendered (ISO date pattern)
    // accessed_at appears with lines like "  Accessed:      ..." or "  Access count: ..."
    expect(output).toContain("Access count");
  });

  it("shows 'Memory not found' on stderr and exits with code 1 for unknown ID", async () => {
    // Mock process.exit to throw so we can catch it
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    const { showCommand } = await importShow();
    const { stdout, stderr } = captureLogs(() => {
      expect(() => {
        invoke(showCommand, { id: "nonexistent-id", _: ["nonexistent-id"] });
      }).toThrow("process.exit(1)");
    });

    expect(stderr.some((l) => l.includes("Memory not found: nonexistent-id"))).toBe(true);
    expect(stdout.length).toBe(0);
  });

  it("exits with code 1 when store is empty and any ID is queried", async () => {
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    const { showCommand } = await importShow();
    const { stderr } = captureLogs(() => {
      expect(() => {
        invoke(showCommand, { id: "any-id", _: ["any-id"] });
      }).toThrow("process.exit(1)");
    });

    expect(stderr.some((l) => l.includes("Memory not found: any-id"))).toBe(true);
  });
});
