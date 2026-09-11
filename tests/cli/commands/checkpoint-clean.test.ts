/**
 * Tests for checkpoint-clean CLI command.
 *
 * Tests cover: --all non-TTY guard, no checkpoint directory, no expired
 * checkpoints, expired-only cleanup, corrupt files skipped, and
 * empty-directory edge case.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CHECKPOINT_TTL_MS } from "../../../src/dispatch/config";

// ── Shared setup ───────────────────────────────────────────────────

let tmpDir: string;
let origCwd: () => string;
let origDateNow: () => number;
let origStdinIsTTY: any;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "checkpoint-clean-"));
  origCwd = process.cwd;
  process.cwd = () => tmpDir;
  origDateNow = Date.now;
  process.exitCode = 0;
  origStdinIsTTY = (process.stdin as any).isTTY;
  Object.defineProperty(process.stdin, "isTTY", {
    value: false,
    configurable: true,
  });
});

afterEach(() => {
  process.cwd = origCwd;
  Date.now = origDateNow;
  rmSync(tmpDir, { recursive: true, force: true });
  Object.defineProperty(process.stdin, "isTTY", {
    value: origStdinIsTTY,
    configurable: true,
  });
});

// ── Helpers ────────────────────────────────────────────────────────

function checkpointsDir(): string {
  return join(tmpDir, ".rolebox", "state", "checkpoints");
}

interface CheckpointEntry {
  task_id: string;
  checkpoint_id: string;
  phase: string;
  completed_items?: string[];
  remaining_items?: string[];
  created_at: string;
  ttl_ms?: number;
}

async function createCheckpointFile(
  taskId: string,
  entries: CheckpointEntry[],
): Promise<void> {
  const dir = checkpointsDir();
  mkdirSync(dir, { recursive: true });
  await writeFile(
    join(dir, `${taskId}.json`),
    JSON.stringify(entries),
    "utf-8",
  );
}

/**
 * Capture clack stdout and console.error stderr.
 * clack writes via process.stdout.write; Bun's console.error does NOT
 * go through process.stderr.write, so we intercept console.error directly.
 */
function captureOutput(
  fn: () => Promise<void>,
): { stdout: string[]; stderr: string[]; run: () => Promise<void> } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origConsoleError = console.error;

  // @ts-ignore - clack writes via process.stdout.write
  process.stdout.write = (chunk: any) => {
    stdout.push(String(chunk));
    return true;
  };
  // @ts-ignore - console.error in Bun bypasses process.stderr.write
  console.error = (...args: any[]) => {
    stderr.push(args.join(" "));
  };

  return {
    stdout,
    stderr,
    run: async () => {
      try {
        await fn();
      } finally {
        process.stdout.write = origStdoutWrite;
        console.error = origConsoleError;
      }
    },
  };
}

/** Call checkpoint-clean's run() with citty-compatible args. */
async function runClean(args: { all?: boolean }): Promise<void> {
  const mod = await import(
    "../../../src/cli/commands/checkpoint/checkpoint-clean"
  );
  await (mod.cleanCommand.run as any)({ args: { ...args, _: [] } });
}

// ── Tests ──────────────────────────────────────────────────────────

describe("checkpoint-clean", () => {
  it("--all with non-TTY stdin sets exitCode 1 and prints error to stderr", async () => {
    // In the test runner stdin is piped (isTTY is falsy), so the guard
    // naturally triggers without explicit mocking.
    const cap = captureOutput(() => runClean({ all: true }));
    await cap.run();

    expect(process.exitCode).toBe(1);
    const stderrText = cap.stderr.join("");
    expect(stderrText).toContain("--all requires an interactive terminal");
  });

  it('shows "No checkpoint directory found" when .rolebox dir does not exist', async () => {
    const cap = captureOutput(() => runClean({}));
    await cap.run();

    const output = cap.stdout.join("");
    expect(output).toContain("No checkpoint directory found");
  });

  it('shows "No expired checkpoints found" when no entries are expired', async () => {
    Date.now = () => 1_700_000_000_000;

    await createCheckpointFile("fresh-task", [
      {
        task_id: "fresh-task",
        checkpoint_id: "cp-fresh",
        phase: "active",
        completed_items: [],
        remaining_items: [],
        // created just now, TTL 1h → far from expired
        created_at: new Date(1_700_000_000_000).toISOString(),
        ttl_ms: 3_600_000,
      },
    ]);

    const freshPath = join(checkpointsDir(), "fresh-task.json");
    expect(existsSync(freshPath)).toBe(true);

    const cap = captureOutput(() => runClean({}));
    await cap.run();

    const output = cap.stdout.join("");
    expect(output).toContain("No expired checkpoints found");

    // File must still exist (no cleanup was performed)
    expect(existsSync(freshPath)).toBe(true);
  });

  it("cleans only expired checkpoint files and preserves fresh ones", async () => {
    Date.now = () => 1_700_000_000_000;

    // File A: all entries expired (48h old — well beyond 24h default TTL).
    // cleanupExpired() uses the global DEFAULT_CHECKPOINT_TTL_MS, not per-entry
    // ttl_ms, so entries must be older than 24h to actually be deleted.
    const twoDaysMs = 2 * DEFAULT_CHECKPOINT_TTL_MS;
    await createCheckpointFile("stale-task", [
      {
        task_id: "stale-task",
        checkpoint_id: "cp-stale",
        phase: "old",
        completed_items: ["a"],
        remaining_items: ["b"],
        created_at: new Date(1_700_000_000_000 - twoDaysMs).toISOString(),
        ttl_ms: 100_000,
      },
    ]);

    // File B: all entries fresh (now, TTL 1h)
    await createCheckpointFile("fresh-task", [
      {
        task_id: "fresh-task",
        checkpoint_id: "cp-fresh",
        phase: "current",
        completed_items: [],
        remaining_items: [],
        created_at: new Date(1_700_000_000_000).toISOString(),
        ttl_ms: 3_600_000,
      },
    ]);

    const stalePath = join(checkpointsDir(), "stale-task.json");
    const freshPath = join(checkpointsDir(), "fresh-task.json");

    expect(existsSync(stalePath)).toBe(true);
    expect(existsSync(freshPath)).toBe(true);

    const cap = captureOutput(() => runClean({}));
    await cap.run();

    // Stale file must be deleted; fresh file must survive
    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(freshPath)).toBe(true);

    const output = cap.stdout.join("");
    expect(output).toContain("Found");
    expect(output).toContain("Removed");
  });

  it("skips corrupt checkpoint files gracefully during cleanup", async () => {
    Date.now = () => 1_700_000_000_000;

    // Valid expired file (>24h old, >24h is required for cleanupExpired)
    await createCheckpointFile("good-stale", [
      {
        task_id: "good-stale",
        checkpoint_id: "cp-good",
        phase: "expired",
        completed_items: [],
        remaining_items: [],
        created_at: new Date(
          1_700_000_000_000 - 2 * DEFAULT_CHECKPOINT_TTL_MS,
        ).toISOString(),
        ttl_ms: 100_000,
      },
    ]);

    // Corrupt file (invalid JSON)
    const dir = checkpointsDir();
    await writeFile(join(dir, "corrupt.json"), "{not valid json}", "utf-8");

    const corruptPath = join(dir, "corrupt.json");
    const goodStalePath = join(dir, "good-stale.json");

    expect(existsSync(corruptPath)).toBe(true);
    expect(existsSync(goodStalePath)).toBe(true);

    const cap = captureOutput(() => runClean({}));
    await cap.run();

    // Valid expired file should be cleaned; corrupt file must remain
    expect(existsSync(goodStalePath)).toBe(false);
    expect(existsSync(corruptPath)).toBe(true);
  });

  it('shows "No checkpoints found" when directory exists but has no .json files', async () => {
    mkdirSync(checkpointsDir(), { recursive: true });
    await writeFile(
      join(checkpointsDir(), "readme.txt"),
      "not a checkpoint",
      "utf-8",
    );

    const cap = captureOutput(() => runClean({}));
    await cap.run();

    const output = cap.stdout.join("");
    expect(output).toContain("No checkpoints found");
  });
});
