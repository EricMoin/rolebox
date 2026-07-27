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
  tmpDir = mkdtempSync(join(tmpdir(), "memory-delete-"));
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

async function importDelete() {
  return await import("../../../src/cli/commands/memory/memory-delete");
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
): Promise<string> {
  const store = await MemoryStore.create(tmpDir);
  try {
    return store.write({
      scope: "workspace",
      role_id: "test-role",
      category: "note",
      title: "Delete Me",
      content: "Content to be deleted.",
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

describe("memory delete", () => {
  it("--yes deletes an existing entry and removes it from the store", async () => {
    const entryId = await insertEntry();

    // Verify entry exists before delete
    const storeBefore = await MemoryStore.create(tmpDir);
    try {
      expect(storeBefore.read(entryId)).not.toBeNull();
    } finally {
      storeBefore.close();
    }

    const { deleteCommand } = await importDelete();
    const { stdout } = await captureLogs(() =>
        invoke(deleteCommand, { id: entryId, yes: true, _: [entryId] }),
    );

    expect(stdout.some((l) => l.includes(`Deleted: ${entryId}`))).toBe(true);

    // Verify entry is actually removed from store
    const storeAfter = await MemoryStore.create(tmpDir);
    try {
      expect(storeAfter.read(entryId)).toBeNull();
    } finally {
      storeAfter.close();
    }
  });

  it("--yes on non-existent entry prints 'Not found'", async () => {
    const { deleteCommand } = await importDelete();
    const { stdout } = await captureLogs(() =>
        invoke(deleteCommand, { id: "nonexistent-id", yes: true, _: ["nonexistent-id"] }),
    );

    expect(stdout.some((l) => l.includes("Not found: nonexistent-id"))).toBe(true);
    // Should NOT say Deleted
    expect(stdout.some((l) => l.includes("Deleted"))).toBe(false);
  });

  it("without --yes shows confirmation prompt text", async () => {
    const entryId = await insertEntry();

    const { deleteCommand } = await importDelete();
    const { stdout } = await captureLogs(() =>
        invoke(deleteCommand, { id: entryId, yes: false, _: [entryId] }),
    );

    // The prompt message is printed before any stdin read
    expect(stdout.some((l) => l.includes(`Delete memory ${entryId}? (y/N)`))).toBe(true);

    // With no stdin input, prompt() returns null → falls to "" → not y/yes → "Cancelled."
    // Entry should still exist
    expect(stdout.some((l) => l.includes("Cancelled."))).toBe(true);
    expect(stdout.some((l) => l.includes("Deleted"))).toBe(false);

    const store = await MemoryStore.create(tmpDir);
    try {
      expect(store.read(entryId)).not.toBeNull();
    } finally {
      store.close();
    }
  });
});
