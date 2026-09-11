/**
 * Tests for checkpoint-list CLI command.
 *
 * Tests cover: directory-not-found, empty directory, valid table output,
 * --task filtering, corrupt JSON files, formatExpiresIn boundaries
 * (expired, seconds, minutes, hours, days), and created_at sort order.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Shared setup ───────────────────────────────────────────────────

let tmpDir: string;
let origCwd: () => string;
let origDateNow: () => number;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "checkpoint-list-"));
  origCwd = process.cwd;
  process.cwd = () => tmpDir;
  origDateNow = Date.now;
});

afterEach(() => {
  process.cwd = origCwd;
  Date.now = origDateNow;
  rmSync(tmpDir, { recursive: true, force: true });
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

function captureLogs(
  fn: () => Promise<void>,
): { logs: string[]; run: () => Promise<void> } {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };
  return {
    logs,
    run: async () => {
      try {
        await fn();
      } finally {
        console.log = origLog;
      }
    },
  };
}

/** Call checkpoint-list's run() with citty-compatible args. */
async function runList(args: { task?: string }): Promise<void> {
  const mod = await import(
    "../../../src/cli/commands/checkpoint/checkpoint-list"
  );
  await (mod.listCommand.run as any)({ args: { ...args, _: [] } });
}

// ── Tests ──────────────────────────────────────────────────────────

describe("checkpoint-list", () => {
  it('shows "No checkpoint directory found" when .rolebox dir does not exist', async () => {
    const { logs, run } = captureLogs(() => runList({}));
    await run();
    expect(
      logs.some((l) => l.includes("No checkpoint directory found")),
    ).toBe(true);
  });

  it('shows "No checkpoints found" when directory is empty (no files)', async () => {
    mkdirSync(checkpointsDir(), { recursive: true });

    const { logs, run } = captureLogs(() => runList({}));
    await run();
    expect(logs.some((l) => l.includes("No checkpoints found"))).toBe(true);
  });

  it('shows "No checkpoints found" when directory exists but has no .json files', async () => {
    mkdirSync(checkpointsDir(), { recursive: true });
    await writeFile(
      join(checkpointsDir(), "README.txt"),
      "not a checkpoint",
      "utf-8",
    );

    const { logs, run } = captureLogs(() => runList({}));
    await run();
    expect(logs.some((l) => l.includes("No checkpoints found"))).toBe(true);
  });

  it("displays table with column headers for valid checkpoint entries", async () => {
    await createCheckpointFile("task-1", [
      {
        task_id: "task-1",
        checkpoint_id: "cp-001",
        phase: "research",
        completed_items: ["step-a", "step-b"],
        remaining_items: ["step-c"],
        created_at: "2026-07-15T10:00:00.000Z",
      },
    ]);

    const { logs, run } = captureLogs(() => runList({}));
    await run();

    const allOutput = logs.join("\n");
    // Column headers (plain text within ANSI codes)
    expect(allOutput).toContain("Task ID");
    expect(allOutput).toContain("CP ID");
    expect(allOutput).toContain("Phase");
    expect(allOutput).toContain("Done");
    expect(allOutput).toContain("Rem");
    expect(allOutput).toContain("Created");
    expect(allOutput).toContain("Expires");
    // Data values present
    expect(allOutput).toContain("task-1");
    expect(allOutput).toContain("cp-001");
    expect(allOutput).toContain("research");
    // Counts
    expect(allOutput).toContain("2"); // completed_items length
    expect(allOutput).toContain("1"); // remaining_items length
    // Timestamp
    expect(allOutput).toContain("2026-07-15 10:00:00");
  });

  it("sorts entries by created_at descending (most recent first)", async () => {
    await createCheckpointFile("task-1", [
      {
        task_id: "task-1",
        checkpoint_id: "cp-old",
        phase: "phase-a",
        completed_items: [],
        remaining_items: [],
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    await createCheckpointFile("task-2", [
      {
        task_id: "task-2",
        checkpoint_id: "cp-new",
        phase: "phase-b",
        completed_items: [],
        remaining_items: [],
        created_at: "2026-07-15T00:00:00.000Z",
      },
    ]);

    const { logs, run } = captureLogs(() => runList({}));
    await run();

    const allOutput = logs.join("\n");
    // Most recent first: task-2 (July) should appear before task-1 (Jan)
    const task1Index = allOutput.indexOf("task-1");
    const task2Index = allOutput.indexOf("task-2");
    expect(task2Index).toBeLessThan(task1Index);
  });

  it("--task filter only shows matching task ID", async () => {
    await createCheckpointFile("task-alpha", [
      {
        task_id: "task-alpha",
        checkpoint_id: "cp-alpha",
        phase: "impl",
        completed_items: ["a"],
        remaining_items: ["b"],
        created_at: "2026-07-15T12:00:00.000Z",
      },
    ]);
    await createCheckpointFile("task-beta", [
      {
        task_id: "task-beta",
        checkpoint_id: "cp-beta",
        phase: "review",
        completed_items: [],
        remaining_items: ["x"],
        created_at: "2026-07-15T13:00:00.000Z",
      },
    ]);

    const { logs, run } = captureLogs(() => runList({ task: "task-alpha" }));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toContain("task-alpha");
    expect(allOutput).toContain("cp-alpha");
    expect(allOutput).not.toContain("task-beta");
    expect(allOutput).not.toContain("cp-beta");
  });

  it("handles corrupt JSON files gracefully (skips them)", async () => {
    await createCheckpointFile("good-task", [
      {
        task_id: "good-task",
        checkpoint_id: "cp-good",
        phase: "ok",
        completed_items: [],
        remaining_items: [],
        created_at: "2026-07-15T12:00:00.000Z",
      },
    ]);

    // Write corrupt JSON
    const dir = checkpointsDir();
    await writeFile(join(dir, "bad-task.json"), "{invalid json!", "utf-8");

    const { logs, run } = captureLogs(() => runList({}));
    await run();

    const allOutput = logs.join("\n");
    // Good task's data should be present
    expect(allOutput).toContain("good-task");
    expect(allOutput).toContain("cp-good");
    // Should NOT crash or show "bad-task"
    expect(allOutput).not.toContain("bad-task");
  });

  it('shows "No checkpoints found" when all files are corrupt', async () => {
    const dir = checkpointsDir();
    mkdirSync(dir, { recursive: true });
    await writeFile(join(dir, "corrupt-1.json"), "not json at all", "utf-8");
    await writeFile(join(dir, "corrupt-2.json"), "{truncated", "utf-8");

    const { logs, run } = captureLogs(() => runList({}));
    await run();
    expect(logs.some((l) => l.includes("No checkpoints found"))).toBe(true);
  });

  // ── formatExpiresIn boundary tests (tested indirectly via command output) ──

  it('formatExpiresIn: shows "expired" when remaining <= 0', async () => {
    Date.now = () => 1_700_000_000_000;

    await createCheckpointFile("task-exp", [
      {
        task_id: "task-exp",
        checkpoint_id: "cp-exp",
        phase: "done",
        completed_items: [],
        remaining_items: [],
        // 100s before frozen-now, TTL only 50s → remaining = -50s → expired
        created_at: new Date(1_700_000_000_000 - 100_000).toISOString(),
        ttl_ms: 50_000,
      },
    ]);

    const { logs, run } = captureLogs(() => runList({}));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toContain("expired");
  });

  it('formatExpiresIn: shows seconds when remaining < 60s', async () => {
    Date.now = () => 1_700_000_000_000;

    await createCheckpointFile("task-sec", [
      {
        task_id: "task-sec",
        checkpoint_id: "cp-sec",
        phase: "fast",
        completed_items: [],
        remaining_items: [],
        // 5s before frozen-now, TTL 60s → remaining = 55s → "55s"
        created_at: new Date(1_700_000_000_000 - 5_000).toISOString(),
        ttl_ms: 60_000,
      },
    ]);

    const { logs, run } = captureLogs(() => runList({}));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toMatch(/\d+s/);
  });

  it('formatExpiresIn: shows minutes when remaining < 60m', async () => {
    Date.now = () => 1_700_000_000_000;

    await createCheckpointFile("task-min", [
      {
        task_id: "task-min",
        checkpoint_id: "cp-min",
        phase: "medium",
        completed_items: [],
        remaining_items: [],
        // 60s before frozen-now, TTL 1h → remaining = 3540s = 59m → "59m"
        created_at: new Date(1_700_000_000_000 - 60_000).toISOString(),
        ttl_ms: 3_600_000,
      },
    ]);

    const { logs, run } = captureLogs(() => runList({}));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toMatch(/\d+m/);
  });

  it('formatExpiresIn: shows hours when remaining < 24h', async () => {
    Date.now = () => 1_700_000_000_000;

    await createCheckpointFile("task-hr", [
      {
        task_id: "task-hr",
        checkpoint_id: "cp-hr",
        phase: "long",
        completed_items: [],
        remaining_items: [],
        // 1h before frozen-now, TTL 24h → remaining = 23h → "23h"
        created_at: new Date(1_700_000_000_000 - 3_600_000).toISOString(),
        ttl_ms: 86_400_000,
      },
    ]);

    const { logs, run } = captureLogs(() => runList({}));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toMatch(/\d+h/);
  });

  it('formatExpiresIn: shows days when remaining >= 24h', async () => {
    Date.now = () => 1_700_000_000_000;

    await createCheckpointFile("task-day", [
      {
        task_id: "task-day",
        checkpoint_id: "cp-day",
        phase: "longhaul",
        completed_items: [],
        remaining_items: [],
        // now (same as frozen), TTL 48h → remaining = 48h → "2d"
        created_at: new Date(1_700_000_000_000).toISOString(),
        ttl_ms: 172_800_000,
      },
    ]);

    const { logs, run } = captureLogs(() => runList({}));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toMatch(/\d+d/);
  });

  it('formatExpiresIn: all five boundaries in a single table', async () => {
    Date.now = () => 1_700_000_000_000;

    await createCheckpointFile("boundary-test", [
      {
        task_id: "boundary-test",
        checkpoint_id: "cp-exp",
        phase: "expired",
        completed_items: [],
        remaining_items: [],
        created_at: new Date(1_700_000_000_000 - 100_000).toISOString(),
        ttl_ms: 50_000,
      },
      {
        task_id: "boundary-test",
        checkpoint_id: "cp-sec",
        phase: "seconds",
        completed_items: [],
        remaining_items: [],
        created_at: new Date(1_700_000_000_000 - 5_000).toISOString(),
        ttl_ms: 60_000,
      },
      {
        task_id: "boundary-test",
        checkpoint_id: "cp-min",
        phase: "minutes",
        completed_items: [],
        remaining_items: [],
        created_at: new Date(1_700_000_000_000 - 60_000).toISOString(),
        ttl_ms: 3_600_000,
      },
      {
        task_id: "boundary-test",
        checkpoint_id: "cp-hr",
        phase: "hours",
        completed_items: [],
        remaining_items: [],
        created_at: new Date(1_700_000_000_000 - 3_600_000).toISOString(),
        ttl_ms: 86_400_000,
      },
      {
        task_id: "boundary-test",
        checkpoint_id: "cp-day",
        phase: "days",
        completed_items: [],
        remaining_items: [],
        created_at: new Date(1_700_000_000_000).toISOString(),
        ttl_ms: 172_800_000,
      },
    ]);

    const { logs, run } = captureLogs(() => runList({}));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toContain("expired");
    expect(allOutput).toMatch(/\d+s/);
    expect(allOutput).toMatch(/\d+m/);
    expect(allOutput).toMatch(/\d+h/);
    expect(allOutput).toMatch(/\d+d/);
  });

  it("uses DEFAULT_CHECKPOINT_TTL_MS when ttl_ms is absent from entry", async () => {
    Date.now = () => 1_700_000_000_000;

    await createCheckpointFile("task-default-ttl", [
      {
        task_id: "task-default-ttl",
        checkpoint_id: "cp-default",
        phase: "test",
        completed_items: [],
        remaining_items: [],
        // No ttl_ms → uses default 86_400_000 (24h)
        // 1h before frozen-now → remaining = 23h → "23h"
        created_at: new Date(1_700_000_000_000 - 3_600_000).toISOString(),
        // ttl_ms intentionally omitted
      },
    ]);

    const { logs, run } = captureLogs(() => runList({}));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toMatch(/\d+h/);
    expect(allOutput).toContain("task-default-ttl");
  });

  it("handles entries with empty completed_items and remaining_items", async () => {
    await createCheckpointFile("empty-lists", [
      {
        task_id: "empty-lists",
        checkpoint_id: "cp-empty",
        phase: "started",
        completed_items: [],
        remaining_items: [],
        created_at: "2026-07-15T10:00:00.000Z",
      },
    ]);

    const { logs, run } = captureLogs(() => runList({}));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toContain("empty-lists");
    expect(allOutput).toContain("cp-empty");
    expect(allOutput).toContain("started");
    // Zero counts should be visible
    expect(allOutput).toContain(" 0 ");
  });

  it("handles missing completed_items / remaining_items fields gracefully", async () => {
    await createCheckpointFile("missing-fields", [
      {
        task_id: "missing-fields",
        checkpoint_id: "cp-missing",
        phase: "progress",
        // Neither completed_items nor remaining_items provided
        created_at: "2026-07-16T00:00:00.000Z",
      } as any,
    ]);

    const { logs, run } = captureLogs(() => runList({}));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toContain("missing-fields");
    expect(allOutput).toContain("cp-missing");
    // Should show 0 for both missing arrays
    expect(allOutput).toContain(" 0 ");
  });

  it("shows multiple checkpoints within a single task file", async () => {
    await createCheckpointFile("multi-cp-task", [
      {
        task_id: "multi-cp-task",
        checkpoint_id: "cp-001",
        phase: "research",
        completed_items: ["a"],
        remaining_items: ["b", "c"],
        created_at: "2026-07-15T10:00:00.000Z",
      },
      {
        task_id: "multi-cp-task",
        checkpoint_id: "cp-002",
        phase: "implementation",
        completed_items: ["d", "e"],
        remaining_items: ["f"],
        created_at: "2026-07-15T11:00:00.000Z",
      },
    ]);

    const { logs, run } = captureLogs(() => runList({}));
    await run();

    const allOutput = logs.join("\n");
    expect(allOutput).toContain("cp-001");
    expect(allOutput).toContain("cp-002");
    expect(allOutput).toContain("research");
    expect(allOutput).toContain("implementation");
    // cp-002 (later) should appear first (descending sort)
    const cp001Idx = allOutput.indexOf("cp-001");
    const cp002Idx = allOutput.indexOf("cp-002");
    expect(cp002Idx).toBeLessThan(cp001Idx);
  });

  it("handles --task filter that matches no entries gracefully", async () => {
    await createCheckpointFile("task-xyz", [
      {
        task_id: "task-xyz",
        checkpoint_id: "cp-xyz",
        phase: "test",
        completed_items: [],
        remaining_items: [],
        created_at: "2026-07-15T10:00:00.000Z",
      },
    ]);

    const { logs, run } = captureLogs(() =>
      runList({ task: "nonexistent-task" }),
    );
    await run();

    expect(logs.some((l) => l.includes("No checkpoints found"))).toBe(true);
  });
});
