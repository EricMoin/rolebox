/**
 * Concurrency integration tests — verifies the real ConcurrencyManager
 * wired to DispatchManager under concurrent dispatch load.
 *
 * Tests:
 *   (a) Slot limit is respected — 3 concurrent tasks acquired, overflow queued
 *   (b) Slot release promotes queued tasks when a running task's slot is freed
 *   (c) Different concurrency keys are independent (no cross-key contention)
 *
 * Uses the real opencode server (port 0 = OS-assigned) and real subagent
 * launches via DispatchManager. The ConcurrencyManager is NEVER mocked —
 * all tests go through the real acquire/release path.
 *
 * Each test creates its own temp directory for state isolation
 * (prevents recover() loading stale state from a prior test).
 *
 * Additive — creates a new file under tests/integration/ without modifying
 * any existing tests.
 */

import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";

import { DispatchManager } from "../../src/dispatch/core/manager.ts";
import { DEFAULT_CONFIG, type DispatchManagerConfig } from "../../src/dispatch/config.ts";
import { OpencodeSessionAdapter } from "../../src/platform/adapters/opencode/session.ts";
import { createMockClient, cleanupTestState } from "./helpers.ts";
import { hasOpencode } from "../helpers/opencode";

// ── Server-level setup ──────────────────────────────────────────────────────

let server: { url: string; close(): void };
let client: OpencodeClient;

beforeAll(async () => {
  cleanupTestState();
  if (!hasOpencode()) return;
  server = await createOpencodeServer({ port: 0, timeout: 15_000 });
  client = createOpencodeClient({ baseUrl: server.url });
});

afterAll(() => {
  if (server) server.close();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a unique temp directory for each test (state isolation).
 */
function makeTestDir(): string {
  return mkdtempSync(path.join(tmpdir(), "concurrency-int-"));
}

/**
 * Clean up a test-specific temp directory.
 */
function removeTestDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

/**
 * Create a parent session on the real platform.
 */
async function createParentSession(testDir: string): Promise<string> {
  const result = await client.session.create({
    query: { directory: testDir },
  });
  expect(result.data).toBeDefined();
  return result.data!.id;
}

/**
 * Build dispatch config tuned for concurrency testing:
 * - maxConcurrent=3, syncReservedSlots=0 → bgLimit=3
 * - Large timer intervals to prevent watchdog from interfering
 * - Enough queue depth to hold overflow tasks
 */
function concurrencyTestConfig(): Partial<DispatchManagerConfig> {
  return {
    maxConcurrent: 3,
    syncReservedSlots: 0,
    maxQueueDepth: 10,
    backpressureMaxRetries: 0,
    maxActivePerParent: 10,
    watchdogIntervalMs: 120_000,
    globalSweepIntervalMs: 120_000,
    idleDebounceMs: 120_000,
    taskTtlMs: 120_000,
    backgroundStaleTimeoutMs: 120_000,
    minRuntimeMs: 1_000,
  };
}

/**
 * Create a mock OpencodeClient whose session.create returns unique session IDs.
 */
function createUniqueMockClient(): OpencodeClient {
  let counter = 0;
  const base = createMockClient();
  base.session.create = mock(() =>
    Promise.resolve({ data: { id: `mock-session-${++counter}` }, error: undefined }),
  );
  return base;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe.skipIf(!hasOpencode())("concurrency integration — real ConcurrencyManager", () => {
  /**
   * (a) Slot limit is respected under real load.
   *
   * With maxConcurrent=3 and syncReservedSlots=0, the effective background
   * limit is 3. Launching 6 concurrent tasks should result in 3 acquired
   * (running) and 3 queued (pending). The ConcurrencyManager must report
   * active=3 and queueDepth=3 for the "default" key.
   */
  it("limits concurrent background slots and queues overflow tasks [test a]", async () => {
    const testDir = makeTestDir();
    try {
      const sessionAdapter = new OpencodeSessionAdapter(client);
      const manager = new DispatchManager(
        sessionAdapter,
        concurrencyTestConfig(),
      );
      manager.setStoreDirectory(testDir);
      // No recover() needed — fresh state

      const parentSessionId = await createParentSession(testDir);

      // Launch 6 tasks concurrently — 3 will be acquired, 3 queued
      const tasks = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          manager.launch(
            {
              subagent: "emperor",
              prompt: `Reply with exactly one word: task${i + 1}`,
              run_in_background: true,
            },
            {
              sessionID: parentSessionId,
              agent: "emperor--jinyiwei",
              directory: testDir,
            },
          ),
        ),
      );

      // Concurrency status should show 3 active + 3 queued
      const status = manager.getConcurrencyStatus();
      const defaultKey = status.keys.find((k) => k.key === "default");
      expect(defaultKey).toBeDefined();
      expect(defaultKey!.active).toBe(3);
      expect(defaultKey!.limit).toBe(3);
      expect(defaultKey!.reserved).toBe(0);
      expect(defaultKey!.queueDepth).toBe(3);

      // Task status distribution: 3 running, 3 pending
      const running = tasks.filter((t) => t.status === "running").length;
      const pending = tasks.filter((t) => t.status === "pending").length;
      expect(running).toBe(3);
      expect(pending).toBe(3);

      // All 3 pending tasks must have the "default" concurrency key set
      const pendingTasks = tasks.filter((t) => t.status === "pending");
      for (const t of pendingTasks) {
        expect(t.concurrencyKey).toBe("default");
      }
    } finally {
      removeTestDir(testDir);
    }
  }, 30_000);

  /**
   * (b) Slot release promotes queued tasks.
   *
   * Launch 4 tasks (3 acquired, 1 queued). Call manager.leaveRunning()
   * on one running task to release its slot. Verify the queued task
   * is promoted to running within the same tick/microtask cycle.
   */
  it("releases slots and promotes queued tasks on leaveRunning [test b]", async () => {
    const testDir = makeTestDir();
    try {
      const sessionAdapter = new OpencodeSessionAdapter(client);
      const manager = new DispatchManager(
        sessionAdapter,
        concurrencyTestConfig(),
      );
      manager.setStoreDirectory(testDir);

      const parentSessionId = await createParentSession(testDir);

      // Launch 4 tasks — 3 acquired, 1 queued
      const tasks = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          manager.launch(
            {
              subagent: "emperor",
              prompt: `Reply with exactly one word: hello${i + 1}`,
              run_in_background: true,
            },
            {
              sessionID: parentSessionId,
              agent: "emperor--jinyiwei",
              directory: testDir,
            },
          ),
        ),
      );

      const runningTasks = tasks.filter((t) => t.status === "running");
      const pendingTasks = tasks.filter((t) => t.status === "pending");
      expect(runningTasks).toHaveLength(3);
      expect(pendingTasks).toHaveLength(1);

      const promotedTaskId = pendingTasks[0].id;

      // Release one running task's concurrency slot.
      // leaveRunning() calls release() on the ConcurrencyManager,
      // which promotes the next eligible waiter from the queue.
      manager.leaveRunning(runningTasks[0].id);

      // Allow microtasks (promoteQueued's startBackgroundTask) to drain
      await new Promise((r) => setTimeout(r, 500));

      // Concurrency status: active should be 3 (was 3, one released + promoted)
      const status = manager.getConcurrencyStatus();
      const defaultKey = status.keys.find((k) => k.key === "default");
      expect(defaultKey).toBeDefined();
      expect(defaultKey!.active).toBe(3);
      // Queue depth should be 0 — the single queued task was promoted
      expect(defaultKey!.queueDepth).toBe(0);

      // The previously-pending task should now be running with a session
      const promoted = manager.getTask(promotedTaskId);
      expect(promoted).toBeDefined();
      expect(promoted!.status).toBe("running");
      expect(promoted!.sessionId).toBeTruthy();
      expect(promoted!.sessionId).not.toBe("");
    } finally {
      removeTestDir(testDir);
    }
  }, 30_000);

  /**
   * (c) Different concurrency keys are independent.
   *
   * Creates a subagentModelKey mapping two subagent IDs to distinct
   * concurrency keys ("key-a" and "key-b"). Fills key-a to its limit
   * (3 tasks), then launches on key-b and verifies it acquires
   * immediately — key-b's slots are unaffected by key-a occupancy.
   *
   * Also verifies that a 4th task on key-a is correctly queued while
   * key-b remains independent.
   *
   * Uses a mock client (unique session IDs) since this test only
   * validates concurrency key isolation, not server interaction.
   */
  it("different concurrency keys are independent [test c]", async () => {
    const testDir = makeTestDir();
    try {
      const mockClient = createUniqueMockClient();
      const sessionAdapter = new OpencodeSessionAdapter(mockClient as any);

      // Map two distinct subagent IDs to separate concurrency keys
      const subagentModelKey = new Map<string, string>([
        ["group-a", "key-a"],
        ["group-b", "key-b"],
      ]);

      const manager = new DispatchManager(
        sessionAdapter,
        concurrencyTestConfig(),
        subagentModelKey,
      );
      manager.setStoreDirectory(testDir);
      // No recover() — fresh state, no stale data to load

      const parentSessionId = await createParentSession(testDir);

      // Fill key-a to limit (3 tasks)
      const tasksA = await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          manager.launch(
            {
              subagent: "group-a",
              prompt: `Task A-${i}`,
              run_in_background: true,
            },
            {
              sessionID: parentSessionId,
              agent: "emperor--jinyiwei",
              directory: testDir,
            },
          ),
        ),
      );

      // key-a should have 3 active and 0 queued
      const statusAfterA = manager.getConcurrencyStatus();
      const keyA = statusAfterA.keys.find((k) => k.key === "key-a");
      expect(keyA).toBeDefined();
      expect(keyA!.active).toBe(3);
      expect(keyA!.limit).toBe(3);
      expect(keyA!.queueDepth).toBe(0);

      // All 3 key-a tasks are running
      expect(tasksA.every((t) => t.status === "running")).toBe(true);

      // Launch a task on key-b — should be acquired since key-b is empty
      const taskB = await manager.launch(
        {
          subagent: "group-b",
          prompt: "Task B",
          run_in_background: true,
        },
        {
          sessionID: parentSessionId,
          agent: "emperor--jinyiwei",
          directory: testDir,
        },
      );

      const statusAfterB = manager.getConcurrencyStatus();

      // key-b: 1 active (independent from key-a's full slots)
      const keyB = statusAfterB.keys.find((k) => k.key === "key-b");
      expect(keyB).toBeDefined();
      expect(keyB!.active).toBe(1);
      expect(keyB!.queueDepth).toBe(0);
      expect(taskB.status).toBe("running");

      // key-a: still 3 active, unaffected by key-b
      const keyAFinal = statusAfterB.keys.find((k) => k.key === "key-a");
      expect(keyAFinal).toBeDefined();
      expect(keyAFinal!.active).toBe(3);

      // Total active across all keys: 3 (key-a) + 1 (key-b)
      expect(statusAfterB.total.active).toBe(4);
      expect(statusAfterB.total.keys).toBe(2);

      // Now fill key-a's overflow — 4th task on key-a should be queued
      const taskA4 = await manager.launch(
        {
          subagent: "group-a",
          prompt: "Task A-4 (overflow)",
          run_in_background: true,
        },
        {
          sessionID: parentSessionId,
          agent: "emperor--jinyiwei",
          directory: testDir,
        },
      );

      // 4th task on key-a should be queued (pending)
      expect(taskA4.status).toBe("pending");
      expect(taskA4.concurrencyKey).toBe("key-a");

      // key-a queue depth should be 1
      const statusFinal = manager.getConcurrencyStatus();
      const keyAFull = statusFinal.keys.find((k) => k.key === "key-a");
      expect(keyAFull!.queueDepth).toBe(1);

      // key-b still unaffected
      const keyBAfter = statusFinal.keys.find((k) => k.key === "key-b");
      expect(keyBAfter!.active).toBe(1);
      expect(keyBAfter!.queueDepth).toBe(0);

      // Total: 4 active, now with 1 queued
      expect(statusFinal.total.active).toBe(4);
      expect(statusFinal.total.keys).toBe(2);
    } finally {
      removeTestDir(testDir);
    }
  }, 30_000);
});
