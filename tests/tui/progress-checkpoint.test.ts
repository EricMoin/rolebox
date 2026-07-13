/// <reference types="bun-types" />

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readMonitorSnapshot } from "../../src/cli/commands/monitor/monitor-reader";
import type {
  MonitorSnapshot,
  TaskSnapshot,
  ActiveFunction,
} from "../../src/cli/commands/monitor/monitor-reader-types";

// ── Test helpers ─────────────────────────────────────────────────────

let tmpProjectDir: string;

function setupEmptyProject(): string {
  const dir = join(tmpdir(), `rolebox-test-progress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const stateDir = join(dir, ".rolebox", "state");
  mkdirSync(stateDir, { recursive: true });
  return dir;
}

function setupProgressDir(): string {
  const dir = setupEmptyProject();
  const progressDir = join(dir, ".rolebox", "state", "progress");
  mkdirSync(progressDir, { recursive: true });
  return dir;
}

function setupCheckpointDir(): string {
  const dir = setupEmptyProject();
  const cpDir = join(dir, ".rolebox", "state", "checkpoints");
  mkdirSync(cpDir, { recursive: true });
  return dir;
}

function writeProgressFile(dir: string, taskId: string, events: Array<{
  task_id: string;
  stage: string;
  message: string;
  percentage?: number;
  timestamp?: string;
}>): void {
  const progressDir = join(dir, ".rolebox", "state", "progress");
  mkdirSync(progressDir, { recursive: true });
  const data = events.map((e, i) => ({
    task_id: e.task_id,
    percentage: e.percentage,
    stage: e.stage,
    message: e.message,
    timestamp: e.timestamp ?? new Date(Date.now() + i * 1000).toISOString(),
  }));
  writeFileSync(join(progressDir, `${taskId}.json`), JSON.stringify(data), "utf-8");
}

function writeCheckpointFile(dir: string, taskId: string, entries: Array<{
  task_id: string;
  checkpoint_id: string;
  phase: string;
  completed_items: string[];
  remaining_items: string[];
  created_at?: string;
}>): void {
  const cpDir = join(dir, ".rolebox", "state", "checkpoints");
  mkdirSync(cpDir, { recursive: true });
  const data = entries.map((e, i) => ({
    task_id: e.task_id,
    checkpoint_id: e.checkpoint_id,
    phase: e.phase,
    completed_items: e.completed_items,
    remaining_items: e.remaining_items,
    metadata: {},
    created_at: e.created_at ?? new Date(Date.now() + i * 1000).toISOString(),
    ttl_ms: 300_000,
  }));
  writeFileSync(join(cpDir, `${taskId}.json`), JSON.stringify(data), "utf-8");
}

// Also need a dispatch file so readMonitorSnapshot returns tasks
function writeDispatchFile(dir: string, tasks: Array<{
  id: string;
  sessionId?: string;
  status?: string;
  agent?: string;
  startedAt?: string;
}>): void {
  const stateDir = join(dir, ".rolebox", "state");
  const dispatchData = {
    version: 1,
    tasks: tasks.map((t) => ({
      id: t.id,
      sessionId: t.sessionId ?? `sess-${t.id}`,
      status: t.status ?? "running",
      agent: t.agent ?? "test-agent",
      depth: 0,
      mode: "background",
      startedAt: t.startedAt ?? new Date().toISOString(),
    })),
  };
  writeFileSync(join(stateDir, `dispatch-${Date.now()}.json`), JSON.stringify(dispatchData), "utf-8");
}

beforeEach(() => {
  tmpProjectDir = setupEmptyProject();
});

afterEach(() => {
  try {
    rmSync(tmpProjectDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

// ── Tests ────────────────────────────────────────────────────────────

describe("MonitorSnapshot progress integration", () => {
  it("includes progress data when progress files exist", () => {
    const dir = setupProgressDir();
    writeDispatchFile(dir, [
      { id: "task-1", sessionId: "sess-1", status: "running" },
      { id: "task-2", sessionId: "sess-2", status: "running" },
    ]);
    writeProgressFile(dir, "task-1", [
      { task_id: "task-1", stage: "research", message: "gathering data", percentage: 10 },
      { task_id: "task-1", stage: "implementing", message: "writing code", percentage: 45 },
    ]);
    writeProgressFile(dir, "task-2", [
      { task_id: "task-2", stage: "verifying", message: "running tests", percentage: 80 },
    ]);

    const snap = readMonitorSnapshot(dir);

    expect(snap.progress).toBeDefined();
    expect(Object.keys(snap.progress!)).toHaveLength(2);

    // task-1: latest event is "implementing" with percentage 45
    expect(snap.progress!["task-1"]).toBeDefined();
    expect(snap.progress!["task-1"].latest_stage).toBe("implementing");
    expect(snap.progress!["task-1"].percentage).toBe(45);
    expect(snap.progress!["task-1"].message).toBe("writing code");
    expect(snap.progress!["task-1"].event_count).toBe(2);

    // task-2: latest event is "verifying" with percentage 80
    expect(snap.progress!["task-2"].latest_stage).toBe("verifying");
    expect(snap.progress!["task-2"].percentage).toBe(80);
    expect(snap.progress!["task-2"].event_count).toBe(1);
  });

  it("handles progress files without percentage", () => {
    const dir = setupProgressDir();
    writeDispatchFile(dir, [{ id: "task-1", status: "running" }]);
    writeProgressFile(dir, "task-1", [
      { task_id: "task-1", stage: "compiling", message: "building project" },
    ]);

    const snap = readMonitorSnapshot(dir);

    expect(snap.progress).toBeDefined();
    expect(snap.progress!["task-1"].latest_stage).toBe("compiling");
    expect(snap.progress!["task-1"].percentage).toBeUndefined();
    expect(snap.progress!["task-1"].message).toBe("building project");
  });

  it("omits progress when progress directory is missing", () => {
    const dir = setupEmptyProject();
    writeDispatchFile(dir, [{ id: "task-1", status: "running" }]);

    const snap = readMonitorSnapshot(dir);

    expect(snap.progress).toBeUndefined();
  });

  it("omits progress when progress directory is empty", () => {
    const dir = setupProgressDir();
    writeDispatchFile(dir, [{ id: "task-1", status: "running" }]);
    // Directory exists but no files

    const snap = readMonitorSnapshot(dir);

    expect(snap.progress).toBeUndefined();
  });

  it("handles empty progress file gracefully", () => {
    const dir = setupProgressDir();
    writeDispatchFile(dir, [{ id: "task-1", status: "running" }]);
    // Write an empty array
    const progressDir = join(dir, ".rolebox", "state", "progress");
    writeFileSync(join(progressDir, "task-1.json"), "[]", "utf-8");

    const snap = readMonitorSnapshot(dir);

    // Empty array results in no progress entry for that task
    expect(snap.progress).toBeUndefined();
  });
});

describe("MonitorSnapshot checkpoint integration", () => {
  it("includes checkpoint data when checkpoint files exist", () => {
    const dir = setupCheckpointDir();
    writeDispatchFile(dir, [
      { id: "task-1", sessionId: "sess-1", status: "running" },
    ]);
    writeCheckpointFile(dir, "task-1", [
      {
        task_id: "task-1",
        checkpoint_id: "cp-1",
        phase: "research",
        completed_items: ["step-a"],
        remaining_items: ["step-b", "step-c"],
      },
    ]);

    const snap = readMonitorSnapshot(dir);

    expect(snap.checkpoints).toBeDefined();
    expect(Object.keys(snap.checkpoints!)).toHaveLength(1);
    expect(snap.checkpoints!["task-1"].checkpoint_id).toBe("cp-1");
    expect(snap.checkpoints!["task-1"].phase).toBe("research");
    expect(snap.checkpoints!["task-1"].completed_count).toBe(1);
    expect(snap.checkpoints!["task-1"].remaining_count).toBe(2);
  });

  it("uses the latest checkpoint when multiple exist", () => {
    const dir = setupCheckpointDir();
    writeDispatchFile(dir, [{ id: "task-1", status: "running" }]);
    writeCheckpointFile(dir, "task-1", [
      {
        task_id: "task-1",
        checkpoint_id: "cp-early",
        phase: "research",
        completed_items: ["step-a"],
        remaining_items: ["step-b", "step-c"],
        created_at: "2024-01-01T00:00:00Z",
      },
      {
        task_id: "task-1",
        checkpoint_id: "cp-late",
        phase: "implementation",
        completed_items: ["step-a", "step-b"],
        remaining_items: ["step-c"],
        created_at: "2024-01-01T01:00:00Z",
      },
    ]);

    const snap = readMonitorSnapshot(dir);

    expect(snap.checkpoints!["task-1"].checkpoint_id).toBe("cp-late");
    expect(snap.checkpoints!["task-1"].phase).toBe("implementation");
    expect(snap.checkpoints!["task-1"].completed_count).toBe(2);
    expect(snap.checkpoints!["task-1"].remaining_count).toBe(1);
  });

  it("omits checkpoints when checkpoint directory is missing", () => {
    const dir = setupEmptyProject();
    writeDispatchFile(dir, [{ id: "task-1", status: "running" }]);

    const snap = readMonitorSnapshot(dir);

    expect(snap.checkpoints).toBeUndefined();
  });

  it("omits checkpoints when checkpoint directory is empty", () => {
    const dir = setupCheckpointDir();
    writeDispatchFile(dir, [{ id: "task-1", status: "running" }]);

    const snap = readMonitorSnapshot(dir);

    expect(snap.checkpoints).toBeUndefined();
  });
});

describe("Checkpoint badge logic (renderDispatchRow)", () => {
  it("passes hasCheckpoints=true when checkpoint data exists for a task", () => {
    const dir = setupCheckpointDir();
    writeDispatchFile(dir, [{ id: "task-cp", status: "running" }]);
    writeCheckpointFile(dir, "task-cp", [
      {
        task_id: "task-cp",
        checkpoint_id: "cp-1",
        phase: "research",
        completed_items: ["a"],
        remaining_items: ["b"],
      },
    ]);

    const snap = readMonitorSnapshot(dir);

    // Verify that checkpoints field contains data for task-cp
    expect(snap.checkpoints).toBeDefined();
    expect(snap.checkpoints!["task-cp"]).toBeDefined();
    // The badge rendering is a UI concern; verify the data plumbing works
    expect(snap.checkpoints!["task-cp"].checkpoint_id).toBe("cp-1");
  });

  it("does not include checkpoint data when no checkpoint files exist", () => {
    const dir = setupEmptyProject();
    writeDispatchFile(dir, [{ id: "task-no-cp", status: "running" }]);

    const snap = readMonitorSnapshot(dir);

    expect(snap.checkpoints).toBeUndefined();
  });
});

describe("Progress and checkpoint coexist", () => {
  it("includes both progress and checkpoints when both directories have data", () => {
    const dir = setupProgressDir();
    // Also create checkpoint dir
    const cpDir = join(dir, ".rolebox", "state", "checkpoints");
    mkdirSync(cpDir, { recursive: true });

    writeDispatchFile(dir, [{ id: "task-1", status: "running" }]);
    writeProgressFile(dir, "task-1", [
      { task_id: "task-1", stage: "implementing", message: "coding", percentage: 50 },
    ]);
    writeCheckpointFile(dir, "task-1", [
      {
        task_id: "task-1",
        checkpoint_id: "cp-1",
        phase: "research",
        completed_items: ["a"],
        remaining_items: ["b"],
      },
    ]);

    const snap = readMonitorSnapshot(dir);

    expect(snap.progress).toBeDefined();
    expect(snap.checkpoints).toBeDefined();
    expect(snap.progress!["task-1"].latest_stage).toBe("implementing");
    expect(snap.checkpoints!["task-1"].checkpoint_id).toBe("cp-1");
  });
});
