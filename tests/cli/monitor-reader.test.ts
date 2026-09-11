import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Helpers ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "monitor-reader-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Shortcut to the .rolebox/state subdirectory inside tmpDir */
function stateDir(): string {
  return join(tmpDir, ".rolebox", "state");
}

/** Create the state directory and return its path */
function ensureStateDir(): string {
  const sd = stateDir();
  mkdirSync(sd, { recursive: true });
  return sd;
}

/** Write a JSON file under the state directory */
async function writeStateFile(filename: string, data: unknown): Promise<string> {
  const p = join(stateDir(), filename);
  await writeFile(p, JSON.stringify(data, null, 2));
  return p;
}

// ── Fixture factories ────────────────────────────────────────────────

/**
 * Build a valid loops-{hash}.json payload matching the LoopStore format.
 * The loops array contains { id, state } entries where state is a LoopState
 * shape that includes the fields read by readLoopSnapshots.
 */
function makeLoopFilePayload(
  loops: Array<{
    id: string;
    originSessionId: string;
    agent: string;
    phase: string;
    current: number;
    total: number;
    mode: string;
    startedAt: number;
    updatedAt: number;
    errorReason?: string;
    activeWorkerSessionId?: string;
    activeWorkerTaskId?: string;
  }>,
) {
  return {
    version: 1,
    loops: loops.map((l) => ({
      id: l.id,
      state: {
        originSessionId: l.originSessionId,
        agent: l.agent,
        basePrompt: "test prompt",
        mode: l.mode,
        total: l.total,
        current: l.current,
        phase: l.phase,
        cancelRequested: false,
        startedAt: l.startedAt,
        updatedAt: l.updatedAt,
        roundStartedAt: l.startedAt,
        rounds: [],
        schemaVersion: 2,
        ...(l.errorReason ? { errorReason: l.errorReason } : {}),
        ...(l.activeWorkerSessionId
          ? { activeWorkerSessionId: l.activeWorkerSessionId }
          : {}),
        ...(l.activeWorkerTaskId
          ? { activeWorkerTaskId: l.activeWorkerTaskId }
          : {}),
      },
    })),
  };
}

// ══════════════════════════════════════════════════════════════════════
// readLoopSnapshots
// ══════════════════════════════════════════════════════════════════════

describe("readLoopSnapshots", () => {
  it("returns loop snapshots for valid loop files", async () => {
    ensureStateDir();
    await writeStateFile(
      "loops-abc123.json",
      makeLoopFilePayload([
        {
          id: "session-1",
          originSessionId: "session-1",
          agent: "agent-alpha",
          phase: "dispatching",
          current: 2,
          total: 5,
          mode: "inherit",
          startedAt: 1000,
          updatedAt: 2000,
          activeWorkerSessionId: "worker-1",
        },
        {
          id: "session-2",
          originSessionId: "session-2",
          agent: "agent-beta",
          phase: "awaiting_worker",
          current: 1,
          total: 3,
          mode: "fresh",
          startedAt: 3000,
          updatedAt: 4000,
        },
      ]),
    );

    const { readLoopSnapshots } = await import(
      "../../src/cli/commands/monitor/monitor-reader.ts"
    );
    const result = readLoopSnapshots(stateDir());

    expect(result).toHaveLength(2);

    const first = result[0];
    expect(first.originSessionId).toBe("session-1");
    expect(first.agent).toBe("agent-alpha");
    expect(first.phase).toBe("dispatching");
    expect(first.current).toBe(2);
    expect(first.total).toBe(5);
    expect(first.mode).toBe("inherit");
    expect(first.activeWorkerSessionId).toBe("worker-1");
    expect(first.elapsedMs).toBeGreaterThan(0);

    const second = result[1];
    expect(second.originSessionId).toBe("session-2");
    expect(second.agent).toBe("agent-beta");
    expect(second.phase).toBe("awaiting_worker");
    expect(second.current).toBe(1);
    expect(second.total).toBe(3);
    expect(second.mode).toBe("fresh");
  });

  it("filters out terminal phases (complete, cancelled, interrupted, error)", async () => {
    ensureStateDir();
    await writeStateFile(
      "loops-abc123.json",
      makeLoopFilePayload([
        {
          id: "active-loop",
          originSessionId: "active-loop",
          agent: "agent-a",
          phase: "dispatching",
          current: 1,
          total: 3,
          mode: "inherit",
          startedAt: 1000,
          updatedAt: 2000,
        },
        {
          id: "completed-loop",
          originSessionId: "completed-loop",
          agent: "agent-b",
          phase: "complete",
          current: 5,
          total: 5,
          mode: "inherit",
          startedAt: 1000,
          updatedAt: 2000,
        },
        {
          id: "cancelled-loop",
          originSessionId: "cancelled-loop",
          agent: "agent-c",
          phase: "cancelled",
          current: 2,
          total: 5,
          mode: "fresh",
          startedAt: 1000,
          updatedAt: 2000,
        },
        {
          id: "interrupted-loop",
          originSessionId: "interrupted-loop",
          agent: "agent-d",
          phase: "interrupted",
          current: 1,
          total: 3,
          mode: "inherit",
          startedAt: 1000,
          updatedAt: 2000,
        },
        {
          id: "error-loop",
          originSessionId: "error-loop",
          agent: "agent-e",
          phase: "error",
          current: 2,
          total: 3,
          mode: "inherit",
          startedAt: 1000,
          updatedAt: 2000,
          errorReason: "Something went wrong",
        },
      ]),
    );

    const { readLoopSnapshots } = await import(
      "../../src/cli/commands/monitor/monitor-reader.ts"
    );
    const result = readLoopSnapshots(stateDir());

    expect(result).toHaveLength(1);
    expect(result[0].originSessionId).toBe("active-loop");
    expect(result[0].phase).toBe("dispatching");
  });

  it("returns empty array when no loop files exist", async () => {
    // stateDir exists but no loop files
    ensureStateDir();
    const { readLoopSnapshots } = await import(
      "../../src/cli/commands/monitor/monitor-reader.ts"
    );
    const result = readLoopSnapshots(stateDir());
    expect(result).toEqual([]);
  });

  it("returns empty array when state directory does not exist", async () => {
    // stateDir() path does not exist at all
    const { readLoopSnapshots } = await import(
      "../../src/cli/commands/monitor/monitor-reader.ts"
    );
    const result = readLoopSnapshots(stateDir());
    expect(result).toEqual([]);
  });

  it("returns empty array for malformed JSON", async () => {
    ensureStateDir();
    await writeFile(join(stateDir(), "loops-malformed.json"), "not valid json{{{");
    const { readLoopSnapshots } = await import(
      "../../src/cli/commands/monitor/monitor-reader.ts"
    );
    const result = readLoopSnapshots(stateDir());
    expect(result).toEqual([]);
  });

  it("skips loop file missing the 'loops' key", async () => {
    ensureStateDir();
    await writeStateFile("loops-bad.json", { version: 1, notLoops: [] });
    const { readLoopSnapshots } = await import(
      "../../src/cli/commands/monitor/monitor-reader.ts"
    );
    const result = readLoopSnapshots(stateDir());
    expect(result).toEqual([]);
  });

  it("includes errorReason when phase is non-terminal and errorReason is set", async () => {
    ensureStateDir();
    // "finalizing" can have an errorReason even though it's non-terminal
    await writeStateFile(
      "loops-err.json",
      makeLoopFilePayload([
        {
          id: "err-loop",
          originSessionId: "err-loop",
          agent: "agent-e",
          phase: "finalizing",
          current: 2,
          total: 3,
          mode: "inherit",
          startedAt: 1000,
          updatedAt: 2000,
          errorReason: "Recovery failed",
        },
      ]),
    );

    const { readLoopSnapshots } = await import(
      "../../src/cli/commands/monitor/monitor-reader.ts"
    );
    const result = readLoopSnapshots(stateDir());

    expect(result).toHaveLength(1);
    expect(result[0].errorReason).toBe("Recovery failed");
  });
});

// ══════════════════════════════════════════════════════════════════════
// computeDispatchSummary
// ══════════════════════════════════════════════════════════════════════

describe("computeDispatchSummary", () => {
  it("correctly counts tasks by status", async () => {
    const { computeDispatchSummary } = await import(
      "../../src/cli/commands/monitor/monitor-reader.ts"
    );
    const tasks = [
      { id: "1", status: "pending" as const, agent: "a", startedAt: "", durationMs: 0, depth: 0, mode: "sync" as const },
      { id: "2", status: "pending" as const, agent: "a", startedAt: "", durationMs: 0, depth: 0, mode: "sync" as const },
      { id: "3", status: "running" as const, agent: "b", startedAt: "", durationMs: 0, depth: 0, mode: "background" as const },
      { id: "4", status: "completed" as const, agent: "c", startedAt: "", durationMs: 0, depth: 0, mode: "sync" as const },
      { id: "5", status: "completed" as const, agent: "c", startedAt: "", durationMs: 0, depth: 0, mode: "sync" as const },
      { id: "6", status: "completed" as const, agent: "c", startedAt: "", durationMs: 0, depth: 0, mode: "sync" as const },
      { id: "7", status: "error" as const, agent: "d", startedAt: "", durationMs: 0, depth: 0, mode: "background" as const },
      { id: "8", status: "cancelled" as const, agent: "e", startedAt: "", durationMs: 0, depth: 0, mode: "sync" as const },
    ];

    const summary = computeDispatchSummary(tasks);

    expect(summary).toEqual({
      pending: 2,
      running: 1,
      completed: 3,
      error: 1,
      cancelled: 1,
    });
  });

  it("returns zeroed summary for empty task array", async () => {
    const { computeDispatchSummary } = await import(
      "../../src/cli/commands/monitor/monitor-reader.ts"
    );
    const summary = computeDispatchSummary([]);

    expect(summary).toEqual({
      pending: 0,
      running: 0,
      completed: 0,
      error: 0,
      cancelled: 0,
    });
  });

  it("counts timeout status tasks as neither pending/running/completed/error/cancelled (falls into default)", async () => {
    const { computeDispatchSummary } = await import(
      "../../src/cli/commands/monitor/monitor-reader.ts"
    );
    const tasks = [
      { id: "t1", status: "timeout" as const, agent: "a", startedAt: "", durationMs: 0, depth: 0, mode: "sync" as const },
    ];

    const summary = computeDispatchSummary(tasks);

    // "timeout" falls to the default case in the switch, not counted anywhere
    expect(summary).toEqual({
      pending: 0,
      running: 0,
      completed: 0,
      error: 0,
      cancelled: 0,
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// computeConcurrencyStatus
// ══════════════════════════════════════════════════════════════════════

describe("computeConcurrencyStatus", () => {
  it("aggregates concurrency gauges from metrics", async () => {
    const { computeConcurrencyStatus } = await import(
      "../../src/cli/commands/monitor/monitor-reader.ts"
    );

    const metrics = {
      counters: {},
      gauges: {
        "concurrency_active{model=gpt4}": { value: 2, labels: { model: "gpt4" } },
        "concurrency_active{model=claude}": { value: 1, labels: { model: "claude" } },
        "concurrency_queued{model=gpt4}": { value: 3, labels: { model: "gpt4" } },
        "concurrency_limit{model=gpt4}": { value: 5, labels: { model: "gpt4" } },
        "concurrency_limit{model=claude}": { value: 5, labels: { model: "claude" } },
        "inflight_tasks": { value: 7, labels: {} },
      },
      histograms: {},
    };

    const status = computeConcurrencyStatus(metrics);

    expect(status.active).toBe(3); // 2 + 1
    expect(status.queued).toBe(3);
    expect(status.limit).toBe(10); // 5 + 5
  });

  it("handles bare (unlabeled) concurrency gauge names", async () => {
    const { computeConcurrencyStatus } = await import(
      "../../src/cli/commands/monitor/monitor-reader.ts"
    );

    const metrics = {
      counters: {},
      gauges: {
        concurrency_active: { value: 1 },
        concurrency_queued: { value: 0 },
        concurrency_limit: { value: 3 },
      },
      histograms: {},
    };

    const status = computeConcurrencyStatus(metrics);

    expect(status.active).toBe(1);
    expect(status.queued).toBe(0);
    expect(status.limit).toBe(3);
  });

  it("returns zeroed status when metrics is null", async () => {
    const { computeConcurrencyStatus } = await import(
      "../../src/cli/commands/monitor/monitor-reader.ts"
    );

    const status = computeConcurrencyStatus(null);

    expect(status).toEqual({ active: 0, limit: 0, queued: 0 });
  });

  it("returns zeroed status when metrics is undefined", async () => {
    const { computeConcurrencyStatus } = await import(
      "../../src/cli/commands/monitor/monitor-reader.ts"
    );

    const status = computeConcurrencyStatus(undefined);

    expect(status).toEqual({ active: 0, limit: 0, queued: 0 });
  });

  it("returns zeroed status when no concurrency gauges exist", async () => {
    const { computeConcurrencyStatus } = await import(
      "../../src/cli/commands/monitor/monitor-reader.ts"
    );

    const metrics = {
      counters: {},
      gauges: { inflight_tasks: { value: 42 } },
      histograms: {},
    };

    const status = computeConcurrencyStatus(metrics);

    expect(status).toEqual({ active: 0, limit: 0, queued: 0 });
  });
});

// ══════════════════════════════════════════════════════════════════════
// readMonitorSnapshot — end-to-end
// ══════════════════════════════════════════════════════════════════════

describe("readMonitorSnapshot", () => {
  it("integrates all fields correctly end-to-end", async () => {
    const sd = ensureStateDir();

    // Write a dispatch file with mixed-status tasks
    await writeStateFile(
      "dispatch-main.json",
      {
        version: 1,
        tasks: [
          {
            id: "task-1",
            sessionId: "sess-a",
            status: "completed",
            agent: "agent-a",
            description: "First task",
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:01:00.000Z",
            depth: 0,
            mode: "sync",
          },
          {
            id: "task-2",
            sessionId: "sess-b",
            status: "running",
            agent: "agent-b",
            description: "Second task",
            startedAt: "2026-01-01T00:02:00.000Z",
            depth: 1,
            mode: "background",
          },
          {
            id: "task-3",
            sessionId: "sess-c",
            status: "pending",
            agent: "agent-c",
            startedAt: "2026-01-01T00:03:00.000Z",
            depth: 0,
            mode: "sync",
          },
        ],
      },
    );

    // Write a loop file with non-terminal loops
    await writeStateFile(
      "loops-abc.json",
      makeLoopFilePayload([
        {
          id: "loop-1",
          originSessionId: "loop-1",
          agent: "loop-agent",
          phase: "dispatching",
          current: 2,
          total: 4,
          mode: "inherit",
          startedAt: 1000,
          updatedAt: 2000,
          activeWorkerSessionId: "sess-b",
          activeWorkerTaskId: "task-2",
        },
      ]),
    );

    const { readMonitorSnapshot } = await import(
      "../../src/cli/commands/monitor/monitor-reader.ts"
    );
    const snapshot = readMonitorSnapshot(tmpDir);

    // — Top-level metadata —
    expect(snapshot.projectDir).toBe(tmpDir);
    expect(snapshot.timestamp).toBeDefined();
    expect(typeof snapshot.timestamp).toBe("string");

    // — Tasks —
    expect(snapshot.tasks).toHaveLength(3);
    expect(snapshot.tasks.map((t) => t.id)).toEqual(["task-1", "task-2", "task-3"]);

    // — Dispatch summary —
    expect(snapshot.dispatchSummary).toEqual({
      pending: 1,
      running: 1,
      completed: 1,
      error: 0,
      cancelled: 0,
    });

    // — Loops —
    expect(snapshot.loops).toHaveLength(1);
    expect(snapshot.loops[0].originSessionId).toBe("loop-1");

    // — Concurrency (no metrics file → zeroed) —
    expect(snapshot.concurrency).toEqual({ active: 0, limit: 0, queued: 0 });
  });

  it("populates empty arrays and zeroed counts when no state files exist", async () => {
    // Create an empty state directory — no dispatch, loops, or graph files
    ensureStateDir();

    const { readMonitorSnapshot } = await import(
      "../../src/cli/commands/monitor/monitor-reader.ts"
    );
    const snapshot = readMonitorSnapshot(tmpDir);

    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.loops).toEqual([]);
    expect(snapshot.dispatchSummary).toEqual({
      pending: 0,
      running: 0,
      completed: 0,
      error: 0,
      cancelled: 0,
    });
    expect(snapshot.concurrency).toEqual({ active: 0, limit: 0, queued: 0 });
    expect(snapshot.activeFunctions).toEqual([]);
  });

  it("handles state directory that does not exist", async () => {
    // tmpDir itself exists but .rolebox/state/ does not
    const { readMonitorSnapshot } = await import(
      "../../src/cli/commands/monitor/monitor-reader.ts"
    );
    const snapshot = readMonitorSnapshot(tmpDir);

    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.loops).toEqual([]);
    expect(snapshot.graphSessions).toEqual([]);
    expect(snapshot.dispatchSummary).toEqual({
      pending: 0, running: 0, completed: 0, error: 0, cancelled: 0,
    });
    expect(snapshot.concurrency).toEqual({ active: 0, limit: 0, queued: 0 });
  });

  it("gracefully handles malformed dispatch files", async () => {
    ensureStateDir();
    await writeFile(join(stateDir(), "dispatch-bad.json"), "{{{bad json}}}");

    const { readMonitorSnapshot } = await import(
      "../../src/cli/commands/monitor/monitor-reader.ts"
    );
    const snapshot = readMonitorSnapshot(tmpDir);

    // Malformed dispatch file should be skipped; tasks should be empty
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.dispatchSummary).toEqual({
      pending: 0, running: 0, completed: 0, error: 0, cancelled: 0,
    });
  });
});
