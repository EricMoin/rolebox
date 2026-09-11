import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LoopStore, isTerminalPhase } from "../../src/loop/loop-store.ts";
import type { LoopState } from "../../src/loop/types.ts";
import type { WorkerTaskState } from "../../src/loop/loop-store.ts";

function makeLoop(overrides: Partial<LoopState> = {}): LoopState {
  return {
    originSessionId: "ses_001",
    agent: "test-agent",
    basePrompt: "do the thing",
    mode: "inherit",
    total: 5,
    current: 2,
    phase: "awaiting_worker",
    activeWorkerTaskId: "bg_abc123",
    activeWorkerSessionId: "ses_worker_001",
    cancelRequested: false,
    startedAt: 1000,
    updatedAt: 2000,
    roundStartedAt: 1500,
    schemaVersion: 1,
    ...overrides,
  };
}

function makeWorkerState(
  status: string,
  exists: boolean,
): WorkerTaskState {
  return { status, exists };
}

describe("LoopStore persistence", () => {
  let tempDir: string;
  let store: LoopStore;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "loop-store-test-"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    store = new LoopStore(tempDir);
    const { shortHash } = require("../../src/utils/state-paths.ts");
    const stateDir = join(tempDir, ".rolebox", "state");
    mkdirSync(stateDir, { recursive: true });
    const filePath = join(stateDir, `loops-${shortHash(tempDir)}.json`);
    try { rmSync(filePath, { force: true }); } catch {}
  });

  it("save → load round-trips a Map with 2 entries", async () => {
    const loop1 = makeLoop({ current: 2, phase: "awaiting_worker" });
    const loop2 = makeLoop({
      originSessionId: "ses_010",
      agent: "other-agent",
      basePrompt: "build feature",
      mode: "fresh",
      total: 3,
      current: 1,
      phase: "summarizing",
      activeWorkerTaskId: "bg_def456",
      activeWorkerSessionId: "ses_worker_002",
      cancelRequested: true,
      lastSummary: "round 1 done",
      startedAt: 3000,
      updatedAt: 4000,
      roundStartedAt: 3500,
    });

    const input = new Map<string, LoopState>([
      ["loop-1", loop1],
      ["loop-2", loop2],
    ]);

    await store.save(input);

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.size).toBe(2);
    expect(loaded!.get("loop-1")).toEqual(loop1);
    expect(loaded!.get("loop-2")).toEqual(loop2);
  });

  it("save → load preserves all new LoopState fields", async () => {
    const loop = makeLoop({
      phase: "dispatching",
      activeWorkerTaskId: "bg_xyz789",
      activeWorkerSessionId: "ses_w3",
      basePrompt: "custom base prompt",
      errorReason: "something went wrong",
      lastSummary: "previous summary text",
    });

    const input = new Map<string, LoopState>([["full", loop]]);
    await store.save(input);

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    const restored = loaded!.get("full")!;
    expect(restored.phase).toBe("dispatching");
    expect(restored.activeWorkerTaskId).toBe("bg_xyz789");
    expect(restored.activeWorkerSessionId).toBe("ses_w3");
    expect(restored.basePrompt).toBe("custom base prompt");
    expect(restored.errorReason).toBe("something went wrong");
    expect(restored.lastSummary).toBe("previous summary text");
  });

  it("saveSync → load round-trips correctly", () => {
    const loop = makeLoop({
      originSessionId: "ses_sync",
      agent: "sync-agent",
      basePrompt: "sync test",
      mode: "fresh",
      total: 1,
      current: 1,
      phase: "complete",
      activeWorkerTaskId: "bg_sync_001",
      activeWorkerSessionId: "ses_sync_w1",
      startedAt: 5000,
      updatedAt: 6000,
      roundStartedAt: 5000,
    });

    const input = new Map<string, LoopState>([["sync-loop", loop]]);
    store.saveSync(input);

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.size).toBe(1);
    expect(loaded!.get("sync-loop")).toEqual(loop);
  });

  it("corrupt JSON → load() returns null", () => {
    const { shortHash } = require("../../src/utils/state-paths.ts");
    const stateDir = join(tempDir, ".rolebox", "state");
    mkdirSync(stateDir, { recursive: true });
    const filePath = join(stateDir, `loops-${shortHash(tempDir)}.json`);
    writeFileSync(filePath, "not valid json {{{");

    const result = store.load();
    expect(result).toBeNull();
  });

  it("unrecognised version → load() returns null", () => {
    const { shortHash } = require("../../src/utils/state-paths.ts");
    const stateDir = join(tempDir, ".rolebox", "state");
    mkdirSync(stateDir, { recursive: true });
    const filePath = join(stateDir, `loops-${shortHash(tempDir)}.json`);
    writeFileSync(filePath, JSON.stringify({ version: 99, loops: [] }));

    const result = store.load();
    expect(result).toBeNull();
  });

  it("v2 file is migrated, not rejected", () => {
    const { shortHash } = require("../../src/utils/state-paths.ts");
    const stateDir = join(tempDir, ".rolebox", "state");
    mkdirSync(stateDir, { recursive: true });
    const filePath = join(stateDir, `loops-${shortHash(tempDir)}.json`);
    // Write a v2 record that lacks the four new optional fields
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 2,
        loops: [
          {
            id: "old-loop",
            state: {
              originSessionId: "ses_v2",
              agent: "v2-agent",
              basePrompt: "do work",
              mode: "inherit",
              total: 3,
              current: 1,
              phase: "complete",
              cancelRequested: false,
              startedAt: 100,
              updatedAt: 200,
              roundStartedAt: 100,
              schemaVersion: 2,
            },
          },
        ],
      }),
    );

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.size).toBe(1);
    const restored = loaded!.get("old-loop")!;
    // All four new fields land as undefined; schemaVersion bumped to 3
    expect(restored.parentLoopId).toBeUndefined();
    expect(restored.consecutiveStaleRounds).toBeUndefined();
    expect(restored.objective).toBeUndefined();
    expect(restored.promptFingerprint).toBeUndefined();
    expect(restored.schemaVersion).toBe(3);
  });

  it("new optional fields survive save→load round-trip", async () => {
    const loop = makeLoop({
      phase: "dispatching",
      objective: "write tests",
      promptFingerprint: "fp_abc",
      parentLoopId: "parent-loop-1",
      consecutiveStaleRounds: 2,
    });
    const input = new Map<string, LoopState>([["l1", loop]]);
    await store.save(input);

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    const restored = loaded!.get("l1")!;
    expect(restored.objective).toBe("write tests");
    expect(restored.promptFingerprint).toBe("fp_abc");
    expect(restored.parentLoopId).toBe("parent-loop-1");
    expect(restored.consecutiveStaleRounds).toBe(2);
  });

  it("writes version 3 in the persisted file", async () => {
    const loop = makeLoop({ phase: "complete" });
    await store.save(new Map([["l1", loop]]));

    const { shortHash } = require("../../src/utils/state-paths.ts");
    const stateDir = join(tempDir, ".rolebox", "state");
    const filePath = join(stateDir, `loops-${shortHash(tempDir)}.json`);

    const raw = require("node:fs").readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(3);
  });

  it("empty file → load() returns null", () => {
    const { shortHash } = require("../../src/utils/state-paths.ts");
    const stateDir = join(tempDir, ".rolebox", "state");
    mkdirSync(stateDir, { recursive: true });
    const filePath = join(stateDir, `loops-${shortHash(tempDir)}.json`);
    writeFileSync(filePath, "");

    const result = store.load();
    expect(result).toBeNull();
  });
});

describe("LoopStore reconcile", () => {
  let store: LoopStore;

  beforeEach(() => {
    store = new LoopStore("/tmp/irrelevant-reconcile");
  });

  it("removes terminal loops", async () => {
    const loops = new Map<string, LoopState>([
      ["l1", makeLoop({ phase: "complete" })],
      ["l2", makeLoop({ phase: "cancelled" })],
      ["l3", makeLoop({ phase: "interrupted" })],
      ["l4", makeLoop({ phase: "error" })],
    ]);

    const getWorkerState = async (_taskId: string) => {
      throw new Error("should not be called");
    };

    await store.reconcile(loops, getWorkerState);

    expect(loops.size).toBe(0);
  });

  it("preserves non-terminal loops", async () => {
    const loops = new Map<string, LoopState>([
      ["l1", makeLoop({ phase: "activating" })],
      ["l2", makeLoop({ phase: "awaiting_worker" })],
    ]);

    const getWorkerState = async (_taskId: string) =>
      makeWorkerState("running", true);

    await store.reconcile(loops, getWorkerState);

    expect(loops.size).toBe(2);
  });

  it("marks interrupted when no activeWorkerTaskId", async () => {
    const loop = makeLoop({
      phase: "dispatching",
      activeWorkerTaskId: undefined,
      activeWorkerSessionId: undefined,
    });
    const loops = new Map<string, LoopState>([["l1", loop]]);

    const getWorkerState = async (_taskId: string) => {
      throw new Error("should not be called");
    };

    await store.reconcile(loops, getWorkerState);

    expect(loop.phase).toBe("interrupted");
    expect(loop.errorReason).toContain("No active worker task");
  });

  it("sets summarizing when worker completed", async () => {
    const loop = makeLoop({ phase: "awaiting_worker" });
    const loops = new Map<string, LoopState>([["l1", loop]]);

    const getWorkerState = async (_taskId: string) =>
      makeWorkerState("completed", true);

    await store.reconcile(loops, getWorkerState);

    expect(loop.phase).toBe("summarizing");
  });

  it("sets awaiting_worker when worker is running", async () => {
    const loop = makeLoop({ phase: "dispatching" });
    const loops = new Map<string, LoopState>([["l1", loop]]);

    const getWorkerState = async (_taskId: string) =>
      makeWorkerState("running", true);

    await store.reconcile(loops, getWorkerState);

    expect(loop.phase).toBe("awaiting_worker");
  });

  it("sets awaiting_worker when worker is pending", async () => {
    const loop = makeLoop({ phase: "dispatching" });
    const loops = new Map<string, LoopState>([["l1", loop]]);

    const getWorkerState = async (_taskId: string) =>
      makeWorkerState("pending", true);

    await store.reconcile(loops, getWorkerState);

    expect(loop.phase).toBe("awaiting_worker");
  });

  it("marks interrupted when worker does not exist", async () => {
    const loop = makeLoop({ phase: "awaiting_worker" });
    const loops = new Map<string, LoopState>([["l1", loop]]);

    const getWorkerState = async (_taskId: string) =>
      makeWorkerState("completed", false);

    await store.reconcile(loops, getWorkerState);

    expect(loop.phase).toBe("interrupted");
    expect(loop.errorReason).toContain("lost");
  });

  it("marks interrupted when worker is in error", async () => {
    const loop = makeLoop({ phase: "awaiting_worker" });
    const loops = new Map<string, LoopState>([["l1", loop]]);

    const getWorkerState = async (_taskId: string) =>
      makeWorkerState("error", true);

    await store.reconcile(loops, getWorkerState);

    expect(loop.phase).toBe("interrupted");
    expect(loop.errorReason).toContain("error");
  });

  it("marks interrupted when worker is cancelled", async () => {
    const loop = makeLoop({ phase: "awaiting_worker" });
    const loops = new Map<string, LoopState>([["l1", loop]]);

    const getWorkerState = async (_taskId: string) =>
      makeWorkerState("cancelled", true);

    await store.reconcile(loops, getWorkerState);

    expect(loop.phase).toBe("interrupted");
    expect(loop.errorReason).toContain("cancelled");
  });

  it("marks interrupted when worker is timeout", async () => {
    const loop = makeLoop({ phase: "awaiting_worker" });
    const loops = new Map<string, LoopState>([["l1", loop]]);

    const getWorkerState = async (_taskId: string) =>
      makeWorkerState("timeout", true);

    await store.reconcile(loops, getWorkerState);

    expect(loop.phase).toBe("interrupted");
    expect(loop.errorReason).toContain("timeout");
  });

  it("marks interrupted when getWorkerState throws", async () => {
    const loop = makeLoop({ phase: "awaiting_worker" });
    const loops = new Map<string, LoopState>([["l1", loop]]);

    const getWorkerState = async (_taskId: string) => {
      throw new Error("dispatch down");
    };

    await store.reconcile(loops, getWorkerState);

    expect(loop.phase).toBe("interrupted");
    expect(loop.errorReason).toContain("lookup failed");
  });

  it("handles mixed recovery scenarios", async () => {
    const loops = new Map<string, LoopState>([
      ["complete", makeLoop({ phase: "complete", activeWorkerTaskId: "bg_c1" })],
      ["no-worker", makeLoop({ phase: "dispatching", activeWorkerTaskId: undefined })],
      ["worker-done", makeLoop({ phase: "awaiting_worker", activeWorkerTaskId: "bg_done" })],
      ["worker-running", makeLoop({ phase: "awaiting_worker", activeWorkerTaskId: "bg_run" })],
      ["worker-lost", makeLoop({ phase: "awaiting_worker", activeWorkerTaskId: "bg_lost" })],
      ["worker-error", makeLoop({ phase: "awaiting_worker", activeWorkerTaskId: "bg_err" })],
    ]);

    const getWorkerState = async (taskId: string): Promise<WorkerTaskState> => {
      switch (taskId) {
        case "bg_done": return makeWorkerState("completed", true);
        case "bg_run": return makeWorkerState("running", true);
        case "bg_lost": return makeWorkerState("completed", false);
        case "bg_err": return makeWorkerState("error", true);
        default: throw new Error("unexpected taskId");
      }
    };

    await store.reconcile(loops, getWorkerState);

    expect(loops.has("complete")).toBe(false);
    expect(loops.get("no-worker")!.phase).toBe("interrupted");
    expect(loops.get("worker-done")!.phase).toBe("summarizing");
    expect(loops.get("worker-running")!.phase).toBe("awaiting_worker");
    expect(loops.get("worker-lost")!.phase).toBe("interrupted");
    expect(loops.get("worker-error")!.phase).toBe("interrupted");
  });

  it("updates updatedAt on every non-terminal mutation", async () => {
    const originalTime = 1000;
    const loop = makeLoop({
      phase: "awaiting_worker",
      updatedAt: originalTime,
    });
    const loops = new Map<string, LoopState>([["l1", loop]]);

    const getWorkerState = async (_taskId: string) =>
      makeWorkerState("completed", true);

    await store.reconcile(loops, getWorkerState);

    expect(loop.updatedAt).toBeGreaterThan(originalTime);
  });
});

describe("isTerminalPhase", () => {
  it("returns true for terminal phases", () => {
    expect(isTerminalPhase("complete")).toBe(true);
    expect(isTerminalPhase("cancelled")).toBe(true);
    expect(isTerminalPhase("interrupted")).toBe(true);
    expect(isTerminalPhase("error")).toBe(true);
  });

  it("returns false for non-terminal phases", () => {
    expect(isTerminalPhase("activating")).toBe(false);
    expect(isTerminalPhase("dispatching")).toBe(false);
    expect(isTerminalPhase("awaiting_worker")).toBe(false);
    expect(isTerminalPhase("summarizing")).toBe(false);
    expect(isTerminalPhase("finalizing")).toBe(false);
  });
});

// ── LoopStore debounce ────────────────────────────────────────────────

describe("LoopStore debounce", () => {
  let tempDir: string;
  let store: LoopStore;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "loop-store-debounce-"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    store = new LoopStore(tempDir);
    const { shortHash } = require("../../src/utils/state-paths.ts");
    const stateDir = join(tempDir, ".rolebox", "state");
    mkdirSync(stateDir, { recursive: true });
    const filePath = join(stateDir, `loops-${shortHash(tempDir)}.json`);
    try { rmSync(filePath, { force: true }); } catch {}
  });

  it("save() with debounce eventually persists data", async () => {
    const loop = makeLoop({ current: 1, phase: "activating" });
    const input = new Map<string, LoopState>([["l1", loop]]);

    await store.save(input);

    // After await resolves, the save should be complete
    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.size).toBe(1);
    expect(loaded!.get("l1")).toEqual(loop);
  });

  it("multiple rapid save() calls coalesce into one I/O", async () => {
    // Save three versions rapidly — only the last should be persisted
    const loop1 = makeLoop({ current: 1, phase: "activating" });
    const loop2 = makeLoop({ current: 2, phase: "awaiting_worker" });
    const loop3 = makeLoop({ current: 3, phase: "complete" });

    // Fire all three near-instantaneously (no await between them)
    const p1 = store.save(new Map([["l1", loop1]]));
    const p2 = store.save(new Map([["l1", loop2]]));
    const p3 = store.save(new Map([["l1", loop3]]));

    // Wait for all to resolve (they share the same debounced timer)
    await Promise.all([p1, p2, p3]);

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    // Only the latest (loop3) should have been saved
    expect(loaded!.get("l1")!.current).toBe(3);
    expect(loaded!.get("l1")!.phase).toBe("complete");
  });

  it("dispose() clears pending timer and pending resolves", () => {
    const loop = makeLoop({ current: 1, phase: "activating" });
    const input = new Map<string, LoopState>([["l1", loop]]);

    // Call save() to start the timer but don't await
    const savePromise = store.save(input);

    // Immediately dispose — timer should be cleared
    store.dispose();

    // The promise should resolve (even though we disposed)
    // We just need to ensure no crash or hanging
    // Use a short timeout to verify the promise resolves
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("save promise never resolved")), 500),
    );
    return Promise.race([
      savePromise.then(() => { /* ok — disposed, resolved */ }),
      timeout,
    ]);
  });

  it("subsequent save() after dispose starts fresh", async () => {
    const loop = makeLoop({ current: 5, phase: "complete" });

    store.dispose();

    // After dispose, save should still work
    await store.save(new Map([["fresh", loop]]));

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.get("fresh")!.current).toBe(5);
  });
});
