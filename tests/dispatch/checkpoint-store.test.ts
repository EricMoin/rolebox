import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FileSystemCheckpointStore, MAX_CHECKPOINTS_PER_TASK } from "../../src/dispatch/checkpoint/checkpoint-store.ts";
import type { CheckpointData } from "../../src/dispatch/types.checkpoint.ts";

function makeCheckpoint(overrides: Partial<CheckpointData> = {}): CheckpointData {
  return {
    task_id: "task-1",
    checkpoint_id: "cp-" + Date.now(),
    phase: "implementation",
    completed_items: ["item1", "item2"],
    remaining_items: ["item3", "item4"],
    created_at: new Date().toISOString(),
    ttl_ms: 86_400_000,
    ...overrides,
  };
}

describe("FileSystemCheckpointStore", () => {
  let testDir: string;
  let store: FileSystemCheckpointStore;

  beforeEach(() => {
    testDir = join(tmpdir(), `checkpoint-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    store = new FileSystemCheckpointStore(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // ── saveCheckpoint / getLatestCheckpoint ───────────────────────────

  it("saveCheckpoint persists a checkpoint and getLatestCheckpoint returns it", async () => {
    const data = makeCheckpoint({ task_id: "task-save-1" });
    await store.saveCheckpoint("task-save-1", data);

    const latest = await store.getLatestCheckpoint("task-save-1");
    expect(latest).not.toBeNull();
    expect(latest!.checkpoint_id).toBe(data.checkpoint_id);
    expect(latest!.phase).toBe("implementation");
    expect(latest!.completed_items).toEqual(["item1", "item2"]);
    expect(latest!.remaining_items).toEqual(["item3", "item4"]);
  });

  it("getLatestCheckpoint returns the most recent checkpoint by created_at", async () => {
    const earlier = makeCheckpoint({
      task_id: "task-latest",
      checkpoint_id: "cp-earlier",
      completed_items: ["a"],
      created_at: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
    });
    const later = makeCheckpoint({
      task_id: "task-latest",
      checkpoint_id: "cp-later",
      completed_items: ["a", "b"],
      created_at: new Date().toISOString(), // now
    });

    await store.saveCheckpoint("task-latest", earlier);
    await store.saveCheckpoint("task-latest", later);

    const latest = await store.getLatestCheckpoint("task-latest");
    expect(latest).not.toBeNull();
    expect(latest!.checkpoint_id).toBe("cp-later");
    expect(latest!.completed_items).toEqual(["a", "b"]);
  });

  it("getLatestCheckpoint returns null when no checkpoints exist", async () => {
    const result = await store.getLatestCheckpoint("nonexistent-task");
    expect(result).toBeNull();
  });

  // ── listCheckpoints ──────────────────────────────────────────────

  it("listCheckpoints returns all checkpoints sorted newest first", async () => {
    const oldest = makeCheckpoint({
      task_id: "task-list",
      checkpoint_id: "cp-oldest",
      created_at: new Date(Date.now() - 120_000).toISOString(),
    });
    const middle = makeCheckpoint({
      task_id: "task-list",
      checkpoint_id: "cp-middle",
      created_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const newest = makeCheckpoint({
      task_id: "task-list",
      checkpoint_id: "cp-newest",
      created_at: new Date().toISOString(),
    });

    // Save out of order
    await store.saveCheckpoint("task-list", middle);
    await store.saveCheckpoint("task-list", newest);
    await store.saveCheckpoint("task-list", oldest);

    const list = await store.listCheckpoints("task-list");
    expect(list).toHaveLength(3);
    expect(list[0].checkpoint_id).toBe("cp-newest");
    expect(list[1].checkpoint_id).toBe("cp-middle");
    expect(list[2].checkpoint_id).toBe("cp-oldest");
  });

  it("listCheckpoints returns empty array for unknown task", async () => {
    const list = await store.listCheckpoints("nonexistent-task");
    expect(list).toEqual([]);
  });

  // ── deleteCheckpoint ─────────────────────────────────────────────

  it("deleteCheckpoint removes the checkpoint file from disk", async () => {
    const data = makeCheckpoint({ task_id: "task-del" });
    await store.saveCheckpoint("task-del", data);

    // Verify file exists
    const filePath = join(testDir, ".rolebox", "state", "checkpoints", "task-del.json");
    expect(existsSync(filePath)).toBe(true);

    await store.deleteCheckpoint("task-del");

    expect(existsSync(filePath)).toBe(false);
    const latest = await store.getLatestCheckpoint("task-del");
    expect(latest).toBeNull();
  });

  it("deleteCheckpoint is a no-op when file does not exist", async () => {
    // Should not throw
    await store.deleteCheckpoint("never-saved");
  });

  // ── cleanupExpired ───────────────────────────────────────────────

  it("cleanupExpired removes entries older than the TTL", async () => {
    const fresh = makeCheckpoint({
      task_id: "task-expire",
      checkpoint_id: "cp-fresh",
      created_at: new Date().toISOString(),
      ttl_ms: 86_400_000, // 24h TTL
    });
    const stale = makeCheckpoint({
      task_id: "task-expire",
      checkpoint_id: "cp-stale",
      created_at: new Date(Date.now() - 10_000).toISOString(), // 10s ago
      ttl_ms: 1_000, // 1s TTL — expired
    });

    await store.saveCheckpoint("task-expire", fresh);
    await store.saveCheckpoint("task-expire", stale);

    // Before cleanup — both present
    let list = await store.listCheckpoints("task-expire");
    expect(list).toHaveLength(2);

    // Cleanup with 5s TTL — stale is older than 5s ago, so it should be removed
    await store.cleanupExpired(5_000);

    list = await store.listCheckpoints("task-expire");
    expect(list).toHaveLength(1);
    expect(list[0].checkpoint_id).toBe("cp-fresh");
  });

  it("cleanupExpired deletes the file when all entries are expired", async () => {
    const stale = makeCheckpoint({
      task_id: "task-all-stale",
      created_at: new Date(Date.now() - 10_000).toISOString(),
      ttl_ms: 1_000,
    });

    await store.saveCheckpoint("task-all-stale", stale);

    const filePath = join(testDir, ".rolebox", "state", "checkpoints", "task-all-stale.json");
    expect(existsSync(filePath)).toBe(true);

    await store.cleanupExpired(1_000);

    expect(existsSync(filePath)).toBe(false);
  });

  it("cleanupExpired is a no-op when the checkpoint directory does not exist", async () => {
    // Use a new store with a non-existent directory
    const emptyStore = new FileSystemCheckpointStore("/tmp/does-not-exist-checkpoint-test");
    // Should not throw
    await emptyStore.cleanupExpired(86_400_000);
  });

  it("cleanupExpired keeps all entries when none are expired", async () => {
    const cp1 = makeCheckpoint({
      task_id: "task-fresh",
      checkpoint_id: "cp-1",
      created_at: new Date().toISOString(),
    });
    const cp2 = makeCheckpoint({
      task_id: "task-fresh",
      checkpoint_id: "cp-2",
      created_at: new Date().toISOString(),
    });

    await store.saveCheckpoint("task-fresh", cp1);
    await store.saveCheckpoint("task-fresh", cp2);

    await store.cleanupExpired(86_400_000);

    const list = await store.listCheckpoints("task-fresh");
    expect(list).toHaveLength(2);
  });

  // ── buildRetryContext ────────────────────────────────────────────

  it("buildRetryContext produces correct markdown format", async () => {
    const data = makeCheckpoint({
      task_id: "task-ctx",
      checkpoint_id: "cp-ctx-1",
      phase: "research",
      completed_items: ["Analyzed API", "Gathered requirements"],
      remaining_items: ["Implement solution", "Write tests"],
      metadata: { source: "test", attempt: 2 },
      created_at: "2026-07-13T10:00:00.000Z",
    });
    await store.saveCheckpoint("task-ctx", data);

    const context = await store.buildRetryContext("task-ctx");
    expect(context).not.toBeNull();

    // Verify structure
    expect(context!).toContain("## Checkpoint Resume Context");
    expect(context!).toContain("**Phase:** research");
    expect(context!).toContain("**Checkpoint ID:** cp-ctx-1");
    expect(context!).toContain("**Created:** 2026-07-13T10:00:00.000Z");
    expect(context!).toContain("### Completed Items");
    expect(context!).toContain("- Analyzed API");
    expect(context!).toContain("- Gathered requirements");
    expect(context!).toContain("### Remaining Items");
    expect(context!).toContain("- Implement solution");
    expect(context!).toContain("- Write tests");
    expect(context!).toContain("### Metadata");
    expect(context!).toContain('"source"');
    expect(context!).toContain('"attempt"');
    expect(context!).toContain("---");
    expect(context!).toContain("Resume from this checkpoint. Do NOT redo completed items.");
  });

  it("buildRetryContext omits metadata section when metadata is empty", async () => {
    const data = makeCheckpoint({
      task_id: "task-no-meta",
      checkpoint_id: "cp-no-meta",
      completed_items: ["Step 1"],
      remaining_items: ["Step 2"],
      metadata: {},
    });
    await store.saveCheckpoint("task-no-meta", data);

    const context = await store.buildRetryContext("task-no-meta");
    expect(context).not.toBeNull();
    expect(context!).not.toContain("### Metadata");
  });

  it("buildRetryContext returns null when no checkpoint exists", async () => {
    const context = await store.buildRetryContext("nonexistent-task");
    expect(context).toBeNull();
  });

  // ── File structure ───────────────────────────────────────────────

  it("stores checkpoints as JSON array at the expected path", async () => {
    const data = makeCheckpoint({ task_id: "task-file" });
    await store.saveCheckpoint("task-file", data);

    const filePath = join(testDir, ".rolebox", "state", "checkpoints", "task-file.json");
    expect(existsSync(filePath)).toBe(true);

    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].checkpoint_id).toBe(data.checkpoint_id);
  });

  it("appends to existing checkpoint array on subsequent saves", async () => {
    const cp1 = makeCheckpoint({
      task_id: "task-append",
      checkpoint_id: "cp-1",
      created_at: new Date(Date.now() - 10_000).toISOString(), // 10s earlier
    });
    const cp2 = makeCheckpoint({
      task_id: "task-append",
      checkpoint_id: "cp-2",
      created_at: new Date().toISOString(), // now
    });

    await store.saveCheckpoint("task-append", cp1);
    await store.saveCheckpoint("task-append", cp2);

    const list = await store.listCheckpoints("task-append");
    expect(list).toHaveLength(2);
    expect(list[0].checkpoint_id).toBe("cp-2");
    expect(list[1].checkpoint_id).toBe("cp-1");

  });

  // ── Checkpoint entry cap ───────────────────────────────────────────

  it("caps checkpoints to MAX_CHECKPOINTS_PER_TASK via FIFO eviction", async () => {
    const taskId = "task-cap";
    for (let i = 0; i < MAX_CHECKPOINTS_PER_TASK + 1; i++) {
      const cp = makeCheckpoint({
        task_id: taskId,
        checkpoint_id: "cp-" + i,
        created_at: new Date(Date.now() + i).toISOString(),
      });
      await store.saveCheckpoint(taskId, cp);
    }

    const list = await store.listCheckpoints(taskId);
    expect(list).toHaveLength(MAX_CHECKPOINTS_PER_TASK);

    // The oldest checkpoint (cp-0) should have been evicted
    const ids = list.map((c) => c.checkpoint_id);
    expect(ids).not.toContain("cp-0");
    // The newest checkpoint (cp-100) should be present
    expect(ids).toContain("cp-" + MAX_CHECKPOINTS_PER_TASK);
  });
});
