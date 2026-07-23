import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../../../src/memory/store";

// ── Per-suite setup ───────────────────────────────────────────────────────

let tmpDir: string;
let origCwd: typeof process.cwd;
let origExit: typeof process.exit;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memory-export-"));
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

async function importExport() {
  return await import("../../../src/cli/commands/memory/memory-export");
}

function invoke(cmd: { run?: unknown }, args: Record<string, unknown>): void {
  const run = cmd.run as (ctx: Record<string, unknown>) => void;
  run({ rawArgs: [] as string[], args: { _: [] as string[], ...args }, cmd });
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
      title: "Exported Entry",
      content: "This is the export test content.",
      relevance: "high",
      tags: ["tag-a", "tag-b"],
      session_id: null,
      source_sessions: [],
      ...overrides,
    });
  } finally {
    store.close();
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("memory export", () => {
  it("exports markdown to stdout with header and entry structure", async () => {
    await insertEntry({
      title: "My Markdown Entry",
      content: "Markdown body text.",
      tags: ["alpha", "beta"],
    });

    const { exportCommand } = await importExport();
    const { stdout } = captureLogs(() => {
      invoke(exportCommand, { format: "markdown" });
    });

    const output = stdout.join("\n");

    // Header
    expect(output).toContain("# Memory Export");

    // Entry rendered as markdown heading
    expect(output).toContain("## My Markdown Entry");

    // Fields
    expect(output).toContain("**ID:**");
    expect(output).toContain("**Scope:** workspace");
    expect(output).toContain("**Role:** test-role");
    expect(output).toContain("**Category:** note");
    expect(output).toContain("**Relevance:** high");
    expect(output).toContain("**Tags:** alpha, beta");

    // Content body
    expect(output).toContain("Markdown body text.");
  });

  it("exports json to stdout as valid JSON array", async () => {
    const entryId = await insertEntry({
      title: "JSON Entry",
      content: "JSON body.",
    });

    const { exportCommand } = await importExport();
    const { stdout } = captureLogs(() => {
      invoke(exportCommand, { format: "json" });
    });

    const raw = stdout.join("\n");
    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(raw);
    }).not.toThrow();

    expect(Array.isArray(parsed)).toBe(true);
    const arr = parsed as Array<Record<string, unknown>>;
    expect(arr.length).toBe(1);
    expect(arr[0].title).toBe("JSON Entry");
    expect(arr[0].content).toBe("JSON body.");
    expect(arr[0].id).toBe(entryId);
  });

  it("--output writes markdown to a file instead of stdout", async () => {
    await insertEntry({ title: "File Export Entry" });

    const outPath = join(tmpDir, "exported.md");
    const { exportCommand } = await importExport();
    const { stdout } = captureLogs(() => {
      invoke(exportCommand, { format: "markdown", output: outPath });
    });

    // stdout should have the success message, not the full export
    expect(stdout.some((l) => l.includes(`Exported to ${outPath}`))).toBe(true);

    // File should exist and contain the entry
    expect(existsSync(outPath)).toBe(true);
    const content = readFileSync(outPath, "utf-8");
    expect(content).toContain("# Memory Export");
    expect(content).toContain("## File Export Entry");
  });

  it("--output writes json to a file instead of stdout", async () => {
    await insertEntry({ title: "JSON File Entry", content: "JSON file body" });

    const outPath = join(tmpDir, "exported.json");
    const { exportCommand } = await importExport();
    const { stdout } = captureLogs(() => {
      invoke(exportCommand, { format: "json", output: outPath });
    });

    expect(stdout.some((l) => l.includes(`Exported to ${outPath}`))).toBe(true);

    const content = readFileSync(outPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].title).toBe("JSON File Entry");
  });

  it("prints 'No memory entries to export' when store is empty", async () => {
    const { exportCommand } = await importExport();
    const { stdout } = captureLogs(() => {
      invoke(exportCommand, { format: "markdown" });
    });

    expect(stdout.some((l) => l.includes("No memory entries to export"))).toBe(true);
  });

  it("exits with code 1 for unknown format", async () => {
    await insertEntry();
    // Mock process.exit to throw so we can catch it
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    const { exportCommand } = await importExport();
    const { stderr } = captureLogs(() => {
      expect(() => {
        invoke(exportCommand, { format: "xml" });
      }).toThrow("process.exit(1)");
    });

    expect(stderr.some((l) => l.includes('Unknown format "xml"'))).toBe(true);
  });
});
