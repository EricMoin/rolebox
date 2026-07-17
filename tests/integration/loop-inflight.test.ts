/**
 * Loop inflight-dispatch integration tests — validates the dispatch-and-yield
 * inflight guard through the real loop push-chain and dispatch pipeline.
 *
 * These tests exercise the inflight guard fix:
 *   Subtask 1: inflight guard in handleSessionIdle (skips debounce when
 *              the worker session has inflight child dispatch tasks)
 *   Subtask 2: stale-timeout safety in evaluateAndComplete (refreshes
 *              lastProgressUpdate when healthy inflight children exist)
 *
 * Integration test scenarios:
 *   (a) Real AI worker dispatches a subagent via `dispatch()` tool —
 *       verifies the loop completes normally through the push-chain
 *       without premature advancement.
 *   (b) Direct inflight child injection — creates a child task via
 *       DispatchManager.launch() for the loop's worker session and
 *       verifies handleSessionIdle skips debounce while inflight > 0.
 *
 * IMPORTANT: These tests need long timeouts because each round dispatches
 * a real AI prompt against the opencode platform. Allow 60s+ per round.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";

import { DispatchManager } from "../../src/dispatch/core/manager.ts";
import { DEFAULT_CONFIG } from "../../src/dispatch/config.ts";
import { OpencodeSessionAdapter } from "../../src/platform/adapters/opencode/session.ts";
import { LoopCoordinator, DispatchAdapter } from "../../src/loop/index.ts";
import { cleanupTestState } from "./helpers.ts";

// ── Server-level setup ──────────────────────────────────────────────────────

let server: { url: string; close(): void };
let client: OpencodeClient;
let tmpDir: string;

beforeAll(async () => {
  cleanupTestState();
  tmpDir = mkdtempSync(path.join(tmpdir(), "loop-inflight-"));
  server = await createOpencodeServer({ port: 0, timeout: 300_000 });
  client = createOpencodeClient({ baseUrl: server.url, directory: tmpDir });
});

afterAll(() => {
  server.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a parent (origin) session on the real platform.
 */
async function createParentSession(): Promise<string> {
  const result = await client.session.create({
    query: { directory: tmpDir },
  });
  expect(result.data).toBeDefined();
  return result.data!.id;
}

/**
 * Poll the LoopCoordinator until a specific phase is reached.
 * Throws a descriptive error if the phase is not reached within the timeout.
 */
async function waitForPhase(
  coordinator: LoopCoordinator,
  originSessionId: string,
  targetPhase: string,
  timeoutMs = 120_000,
  pollIntervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = coordinator.getLoopState(originSessionId);
    if (state && state.phase === targetPhase) return;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  // Last check before throwing
  const state = coordinator.getLoopState(originSessionId);
  const phase = state?.phase ?? "(no state)";
  throw new Error(
    `Loop did not reach phase "${targetPhase}" within ${timeoutMs}ms (phase=${phase})`,
  );
}

/**
 * Poll the LoopCoordinator until the loop reaches a terminal phase
 * (complete, cancelled, error, interrupted).
 */
async function waitForLoopTerminal(
  coordinator: LoopCoordinator,
  originSessionId: string,
  timeoutMs = 180_000,
  pollIntervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let stuckAtDispatching = 0;

  while (Date.now() < deadline) {
    const state = coordinator.getLoopState(originSessionId);
    if (!state) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      continue;
    }
    const terminal = ["complete", "cancelled", "error", "interrupted"];
    if (terminal.includes(state.phase)) return;

    // Detect if stuck at dispatching for more than 60s
    if (state.phase === "dispatching") {
      stuckAtDispatching += pollIntervalMs;
      if (stuckAtDispatching >= 60_000) {
        throw new Error(
          `Loop stuck at "dispatching" for ${stuckAtDispatching}ms — ` +
          `launch did not complete. loop state: ` +
          `activeWorkerTaskId=${state.activeWorkerTaskId ?? "(none)"}, ` +
          `rounds=${state.rounds?.length ?? 0}`,
        );
      }
    } else {
      stuckAtDispatching = 0;
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  const state = coordinator.getLoopState(originSessionId);
  const phase = state?.phase ?? "(no state)";
  throw new Error(
    `Loop did not reach terminal phase within ${timeoutMs}ms (phase=${phase})`,
  );
}

/**
 * Create a LoopCoordinator wired through the real dispatch pipeline.
 */
async function createRealLoopCoordinator(opts?: {
  dispatchConfig?: Partial<typeof DEFAULT_CONFIG>;
  roundTimeoutMs?: number;
}): Promise<{
  coordinator: LoopCoordinator;
  manager: DispatchManager;
}> {
  const sessionAdapter = new OpencodeSessionAdapter(client);
  const manager = new DispatchManager(sessionAdapter, {
    ...DEFAULT_CONFIG,
    watchdogIntervalMs: 5_000,
    globalSweepIntervalMs: 10_000,
    idleDebounceMs: 10_000,
    materializeTimeoutMs: 30_000,
    minRuntimeMs: 1_000,
    ...opts?.dispatchConfig,
  });
  manager.setStoreDirectory(tmpDir);
  await manager.recover();

  const adapter = new DispatchAdapter(manager, sessionAdapter, tmpDir);
  const coordinator = new LoopCoordinator(adapter, {
    delayMs: 0,
    roundTimeoutMs: opts?.roundTimeoutMs ?? 120_000,
  });

  return { coordinator, manager };
}

/**
 * Wait for a dispatch task to move out of "pending" into "running"
 * (i.e., it has acquired a concurrency slot and created a session).
 */
async function waitForTaskRunning(
  manager: DispatchManager,
  taskId: string,
  timeoutMs = 30_000,
  pollIntervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = manager.getTask(taskId);
    if (task && (task.status === "running" || task.status === "completed" || task.status === "error")) return;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  const task = manager.getTask(taskId);
  const status = task?.status ?? "(unknown)";
  throw new Error(`Task ${taskId} did not leave pending within ${timeoutMs}ms (status=${status})`);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("loop inflight dispatch guard — integration", () => {

  /**
   * (a) Real AI worker dispatches a subagent.
   *
   * Register a loop whose worker prompt instructs the AI to call
   * dispatch() with run_in_background=true for a subagent, then
   * produce final output. This exercises the full push-chain with
   * an inflight child present:
   *
   *   1. Loop dispatches worker → worker session runs
   *   2. Worker AI calls dispatch(subagent=emperor, run_in_background=true)
   *   3. Worker AI finishes and produces output
   *   4. session.idle fires → handleSessionIdle checks inflight count
   *   5. WITH guard: skip debounce, parent stays running
   *   6. Subagent completes → parent notified → worker terminal
   *   7. onWorkerCompleted → loop advances to summary → finalize
   *
   * If the AI does NOT call dispatch (unreliable model behavior), the
   * test still verifies the push-chain completes normally — a weaker
   * but still valid assertion.
   */
  it("completes a 1-round loop where the worker dispatches a background subagent [test a]", async () => {
    const { coordinator, manager } = await createRealLoopCoordinator();

    try {
      const parentSessionId = await createParentSession();

      // Register a loop where the worker is instructed to call dispatch.
      // The prompt uses step-by-step instructions to increase the chance
      // that the AI actually calls the dispatch function.
      coordinator.register({
        originSessionId: parentSessionId,
        agent: "emperor",
        prompt: [
          "You MUST follow these steps in order:",
          "Step 1: Call the dispatch function with subagent='emperor', prompt='Reply with exactly: child-ok', run_in_background=true",
          "Step 2: Wait for the subagent to complete.",
          "Step 3: After the subagent is done, reply with exactly: ROUND-COMPLETE",
        ].join("\n"),
        mode: "fresh",
        iterations: 1,
      });

      // Give the microtask-driven kickoff time to start
      await new Promise((r) => setTimeout(r, 100));

      // Wait for awaiting_worker — the worker session is created and running
      const state0 = coordinator.getLoopState(parentSessionId);
      if (state0?.phase !== "awaiting_worker") {
        await waitForPhase(coordinator, parentSessionId, "awaiting_worker", 60_000);
      }

      // At this point, the worker is running. If the AI called dispatch,
      // there should be an inflight child. Check via the manager.
      const workerSessionId = coordinator.getLoopState(parentSessionId)?.activeWorkerSessionId;
      if (workerSessionId) {
        const inflightCount = manager.getInflightCount(workerSessionId);
        // Note: inflightCount may be 0 if the AI hasn't called dispatch yet
        // or if it chose not to follow the instruction. This is informational.
        if (inflightCount > 0) {
          // The inflight guard exists — verify the worker isn't prematurely completed.
          // handleSessionIdle would be called by the event handler when the
          // worker's session goes idle. We call it directly to verify the guard.
          await manager.handleSessionIdle(workerSessionId);

          // Worker should still be running (inflight guard prevented debounce)
          const workerTaskId = coordinator.getLoopState(parentSessionId)?.activeWorkerTaskId;
          if (workerTaskId) {
            const workerTask = manager.getTask(workerTaskId);
            expect(workerTask).toBeDefined();
            // The guard should have kept the task running
            expect(workerTask!.status).toBe("running");
          }
        }
      }

      // Wait for the push-chain to drive the loop to completion
      await waitForLoopTerminal(coordinator, parentSessionId, 240_000);

      // Assert loop reached "complete" phase with 1 round
      const state = coordinator.getLoopState(parentSessionId);
      expect(state).toBeDefined();
      expect(state!.phase).toBe("complete");
      expect(state!.rounds).toHaveLength(1);
      const round = state!.rounds![0];
      expect(round.status).toBe("completed");
      expect(round.workerTaskId).toBeTruthy();
      expect(round.workerSessionId).toBeTruthy();

    } finally {
      coordinator.dispose();
    }
  }, 300_000); // 5 min — generous for AI dispatch round

  /**
   * (b) Direct inflight child injection via DispatchManager.launch().
   *
   * This test deterministically creates an inflight child for the loop's
   * worker session, then verifies:
   *   - handleSessionIdle skips debounce (guard works)
   *   - The worker task is NOT prematurely completed
   *   - The loop eventually advances after the child completes
   *
   * This approach does NOT depend on the AI calling the dispatch tool,
   * making it fully deterministic.
   */
  it("inflight guard prevents handleSessionIdle from prematurely completing the worker [test b]", async () => {
    const { coordinator, manager } = await createRealLoopCoordinator({
      dispatchConfig: {
        // Fast idle debounce so evaluateAndComplete fires quickly
        idleDebounceMs: 1_000,
        // Long stale timeout to prevent the parent from timing out
        // while we set up the inflight child
        backgroundStaleTimeoutMs: 120_000,
        minRuntimeMs: 0,
      },
    });

    try {
      const parentSessionId = await createParentSession();

      // Register a 1-iteration loop with a quick worker prompt.
      coordinator.register({
        originSessionId: parentSessionId,
        agent: "emperor",
        prompt: "Reply with exactly: DONE",
        mode: "fresh",
        iterations: 1,
      });

      // Wait for the loop microtask kickoff to dispatch the worker
      await waitForPhase(coordinator, parentSessionId, "awaiting_worker", 60_000);

      const loopState = coordinator.getLoopState(parentSessionId)!;
      const workerTaskId = loopState.activeWorkerTaskId!;
      const workerSessionId = loopState.activeWorkerSessionId!;

      // ── Phase 1: Launch an inflight child for the worker's session ──
      // The child's parentSessionId will be set to workerSessionId,
      // which is exactly what getInflightCount counts.
      const childTask = await manager.launch(
        {
          subagent: "emperor",
          prompt: "Reply with exactly: child-ok",
          run_in_background: true,
        },
        {
          sessionID: workerSessionId,
          agent: "emperor",
          directory: tmpDir,
        },
      );

      expect(childTask).toBeDefined();
      expect(childTask.id).toMatch(/^bg_/);

      // Wait for the child to acquire a concurrency slot and start running
      await waitForTaskRunning(manager, childTask.id, 30_000);

      // Verify inflight count is > 0
      const inflightCount = manager.getInflightCount(workerSessionId);
      expect(inflightCount).toBeGreaterThanOrEqual(1);

      // ── Phase 2: Verify the inflight guard ──
      // Call handleSessionIdle — if the guard works, it should detect
      // inflight > 0 and skip starting the debounce timer.
      await manager.handleSessionIdle(workerSessionId);

      // The worker should still be running (NOT prematurely completed)
      const workerAfterIdle = manager.getTask(workerTaskId);
      expect(workerAfterIdle).toBeDefined();
      expect(workerAfterIdle!.status).toBe("running");

      // ── Phase 3: Wait for completion ──
      // Both the worker and child will complete on their own timelines.
      // The push-chain will advance the loop after the worker's
      // terminated listener fires (which only happens when the worker
      // actually finishes, not when handleSessionIdle would have
      // prematurely completed it).
      await waitForLoopTerminal(coordinator, parentSessionId, 180_000);

      // ── Phase 4: Verify final state ──
      const finalState = coordinator.getLoopState(parentSessionId);
      expect(finalState).toBeDefined();
      expect(finalState!.phase).toBe("complete");
      expect(finalState!.rounds).toHaveLength(1);

      const round = finalState!.rounds![0];
      expect(round.status).toBe("completed");
      expect(round.round).toBe(1);

      // The worker task should now be completed or cleaned up
      const finalWorker = manager.getTask(workerTaskId);
      if (finalWorker) {
        expect(
          finalWorker.status === "completed" || finalWorker.status === "error",
        ).toBe(true);
      }

    } finally {
      coordinator.dispose();
    }
  }, 240_000); // 4 min

  /**
   * (c) Two-round loop with inflight child in round 1.
   *
   * Verifies that the inflight guard does not break multi-round loops.
   * After round 1's inflight child completes, the push-chain should
   * advance to round 2 normally.
   */
  it("multi-round loop advances past inflight worker without stalling [test c]", async () => {
    const { coordinator, manager } = await createRealLoopCoordinator({
      dispatchConfig: {
        backgroundStaleTimeoutMs: 120_000,
        minRuntimeMs: 0,
      },
    });

    try {
      const parentSessionId = await createParentSession();

      // 2-iteration loop
      coordinator.register({
        originSessionId: parentSessionId,
        agent: "emperor",
        prompt: "Reply with exactly: round-one",
        mode: "fresh",
        iterations: 2,
      });

      // Wait for round 1 to be awaiting_worker
      await waitForPhase(coordinator, parentSessionId, "awaiting_worker", 60_000);

      // Inject inflight child for round 1's worker
      const state = coordinator.getLoopState(parentSessionId)!;
      const workerSessionId = state.activeWorkerSessionId!;
      expect(workerSessionId).toBeTruthy();

      const childTask = await manager.launch(
        {
          subagent: "emperor",
          prompt: "Reply with exactly: child-complete",
          run_in_background: true,
        },
        {
          sessionID: workerSessionId,
          agent: "emperor",
          directory: tmpDir,
        },
      );

      await waitForTaskRunning(manager, childTask.id, 30_000);

      // Wait for the full 2-round loop to complete
      await waitForLoopTerminal(coordinator, parentSessionId, 300_000);

      const finalState = coordinator.getLoopState(parentSessionId);
      expect(finalState).toBeDefined();
      expect(finalState!.phase).toBe("complete");
      expect(finalState!.rounds).toHaveLength(2);

      // Both rounds should have completed
      for (const round of finalState!.rounds!) {
        expect(round.status).toBe("completed");
      }

      // Round numbers should be 1 and 2
      const roundNumbers = finalState!.rounds!.map((r) => r.round).sort();
      expect(roundNumbers).toEqual([1, 2]);

    } finally {
      coordinator.dispose();
    }
  }, 360_000); // 6 min — generous for 2 AI rounds + inflight child
});
