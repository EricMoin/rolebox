/// <reference types="bun-types" />
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCheckpointTool } from "../../src/dispatch/query/checkpoint-tools.ts";
import { FileSystemCheckpointStore } from "../../src/dispatch/checkpoint/checkpoint-store.ts";
import type { DispatchManager } from "../../src/dispatch/core/manager.ts";
import type { CanonicalToolContext } from "../../src/platform/types.ts";

// ── Mock tool context ────────────────────────────────────────────────────

const mockToolContext: CanonicalToolContext = {
  sessionID: "ses_parent",
  messageID: "msg_test",
  agent: "role",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
};

describe("createCheckpointTool", () => {
  let testDir: string;
  let store: FileSystemCheckpointStore;
  let manager: DispatchManager;

  beforeEach(() => {
    testDir = join(tmpdir(), `checkpoint-tools-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });

    store = new FileSystemCheckpointStore(testDir);

    manager = {
      getCheckpointStore: () => store,
    } as unknown as DispatchManager;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("saves a checkpoint to the store and returns confirmation", async () => {
    const tool = createCheckpointTool(manager);

    const result = await tool.execute(
      {
        task_id: "bg_task1",
        phase: "implementation",
        completed_items: ["Setup project", "Define types"],
        remaining_items: ["Write tests", "Verify"],
      },
      mockToolContext,
    );

    // Verify the result message
    expect(result).toContain("Checkpoint saved:");
    expect(result).toContain("(phase: implementation, 2 done, 2 remaining)");

    // Verify it was actually persisted
    const saved = await store.getLatestCheckpoint("bg_task1");
    expect(saved).not.toBeNull();
    expect(saved!.task_id).toBe("bg_task1");
    expect(saved!.phase).toBe("implementation");
    expect(saved!.completed_items).toEqual(["Setup project", "Define types"]);
    expect(saved!.remaining_items).toEqual(["Write tests", "Verify"]);
  });

  it("generates a unique checkpoint_id each time", async () => {
    const tool = createCheckpointTool(manager);

    const result1 = await tool.execute(
      {
        task_id: "bg_task2",
        phase: "research",
        completed_items: [],
        remaining_items: ["All work"],
      },
      mockToolContext,
    );

    const result2 = await tool.execute(
      {
        task_id: "bg_task2",
        phase: "implementation",
        completed_items: ["Research done"],
        remaining_items: ["Implement"],
      },
      mockToolContext,
    );

    // Extract checkpoint IDs from the result strings
    const id1 = (await store.getLatestCheckpoint("bg_task2"))!;
    const list = await store.listCheckpoints("bg_task2");

    expect(list).toHaveLength(2);
    expect(list[0].checkpoint_id).not.toBe(list[1].checkpoint_id);
    expect(list[0].checkpoint_id).toMatch(/^cp_/);
    expect(list[1].checkpoint_id).toMatch(/^cp_/);
  });

  it("metadata is optional — omitting it produces a checkpoint without metadata", async () => {
    const tool = createCheckpointTool(manager);

    await tool.execute(
      {
        task_id: "bg_task3",
        phase: "verification",
        completed_items: ["Build", "Test"],
        remaining_items: ["Deploy"],
        // metadata omitted
      },
      mockToolContext,
    );

    const saved = await store.getLatestCheckpoint("bg_task3");
    expect(saved).not.toBeNull();
    expect(saved!.metadata).toBeUndefined();
  });

  it("metadata is preserved when provided", async () => {
    const tool = createCheckpointTool(manager);

    await tool.execute(
      {
        task_id: "bg_task4",
        phase: "research",
        completed_items: ["Step 1"],
        remaining_items: ["Step 2"],
        metadata: { source: "analysis", attempt: 3 },
      },
      mockToolContext,
    );

    const saved = await store.getLatestCheckpoint("bg_task4");
    expect(saved).not.toBeNull();
    expect(saved!.metadata).toEqual({ source: "analysis", attempt: 3 });
  });

  it("saved checkpoint has the default TTL", async () => {
    const tool = createCheckpointTool(manager);

    await tool.execute(
      {
        task_id: "bg_task5",
        phase: "implementation",
        completed_items: ["A"],
        remaining_items: ["B"],
      },
      mockToolContext,
    );

    const saved = await store.getLatestCheckpoint("bg_task5");
    expect(saved).not.toBeNull();
    // DEFAULT_CHECKPOINT_TTL_MS is 86_400_000 (24h)
    expect(saved!.ttl_ms).toBe(86_400_000);
  });

  it("can save a checkpoint with empty completed/remaining arrays", async () => {
    const tool = createCheckpointTool(manager);

    await tool.execute(
      {
        task_id: "bg_task6",
        phase: "start",
        completed_items: [],
        remaining_items: [],
      },
      mockToolContext,
    );

    const saved = await store.getLatestCheckpoint("bg_task6");
    expect(saved).not.toBeNull();
    expect(saved!.completed_items).toEqual([]);
    expect(saved!.remaining_items).toEqual([]);
  });

  it("checkpoint_id has the cp_ prefix format", async () => {
    const tool = createCheckpointTool(manager);

    const result = await tool.execute(
      {
        task_id: "bg_task7",
        phase: "test",
        completed_items: ["X"],
        remaining_items: ["Y"],
      },
      mockToolContext,
    );

    // The checkpoint ID is embedded in the result message
    const saved = await store.getLatestCheckpoint("bg_task7");
    expect(saved!.checkpoint_id).toMatch(/^cp_[0-9a-z]+_[0-9a-z]+$/);
  });
});
