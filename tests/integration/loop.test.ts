/**
 * Loop coordinator integration tests — exercises the real DispatchAdapter
 * (backed by a real DispatchManager + real opencode server) through the
 * LoopCoordinator push-chain completion flow.
 *
 * The push-chain:
 *   LoopCoordinator.register() → _kickoffFromActivating() → dispatchRound()
 *   → worker session completes → terminated listener fires → onWorkerCompleted()
 *   → _advanceFromSummarizing() → handleSummary() → dispatchRound() (next round)
 *   → ...repeat → finalizeLoop() after max iterations.
 *
 * This test verifies the production push-chain path — no FakeAdapter, no stubs.
 *
 * IMPORTANT: These tests need long timeouts because each round dispatches a
 * real AI prompt against the opencode platform. Allow 60s+ per round.
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
import { hasOpencode } from "../helpers/opencode";

// ── Server-level setup ──────────────────────────────────────────────────────

let server: { url: string; close(): void };
let client: OpencodeClient;
let tmpDir: string;

beforeAll(async () => {
  cleanupTestState();
  if (!hasOpencode()) return;
  tmpDir = mkdtempSync(path.join(tmpdir(), "loop-int-"));
  server = await createOpencodeServer({ port: 0, timeout: 300_000 }); // 5 min server idle timeout
  // Inject directory so the SDK interceptor adds ?directory= to all GET/HEAD
  // requests, preventing status() from hanging on the test server.
  client = createOpencodeClient({ baseUrl: server.url, directory: tmpDir });
});

afterAll(() => {
  if (server) server.close();
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
 * Poll the LoopCoordinator until the loop reaches a terminal phase
 * (complete, cancelled, error, interrupted).
 *
 * If the loop is still in "activating" after a brief wait, the microtask-based
 * kickoff may not have run yet — subsequent polls will catch it.
 */
async function waitForLoopTerminal(
  coordinator: LoopCoordinator,
  originSessionId: string,
  timeoutMs = 120_000,
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
    if (terminal.includes(state.phase)) {
      return;
    }
    // Detect if stuck at dispatching for more than 60s — likely a stalled launch
    if (state.phase === "dispatching") {
      stuckAtDispatching += pollIntervalMs;
      if (stuckAtDispatching >= 60_000) {
        // Check if the server is still responsive by inspecting the manager
        throw new Error(
          `Loop stuck at "dispatching" for ${stuckAtDispatching}ms — ` +
          `launch did not complete within 60s. ` +
          `loop state: activeWorkerTaskId=${state.activeWorkerTaskId ?? "(none)"}, ` +
          `rounds=${state.rounds?.length ?? 0}`,
        );
      }
    } else {
      stuckAtDispatching = 0;
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  // Last check before throwing
  const state = coordinator.getLoopState(originSessionId);
  const phase = state?.phase ?? "(no state)";
  throw new Error(
    `Loop did not reach terminal phase within ${timeoutMs}ms (phase=${phase})`,
  );
}

/**
 * Create a LoopCoordinator wired through the real dispatch pipeline.
 * Uses the real DispatchAdapter (no wrapper classes) with the test temp
 * directory injected so session creation uses tmpDir instead of process.cwd().
 *
 * @param opts Optional overrides for DispatchManager config timers.
 */
async function createRealLoopCoordinator(opts?: {
  dispatchConfig?: Partial<typeof DEFAULT_CONFIG>;
  roundTimeoutMs?: number;
}): Promise<{
  coordinator: LoopCoordinator;
  manager: DispatchManager;
}> {
  // Real OpencodeSessionAdapter — the client has directory baked in via
  // createOpencodeClient({ directory: tmpDir }), which makes the SDK
  // interceptor inject ?directory= into all GET/HEAD requests.
  const sessionAdapter = new OpencodeSessionAdapter(client);
  const manager = new DispatchManager(sessionAdapter, {
    ...DEFAULT_CONFIG,
    // Use moderately fast timers for watchdog reconcile
    watchdogIntervalMs: 5_000,
    globalSweepIntervalMs: 10_000,
    idleDebounceMs: 10_000,
    // Increase materialize/fetch timeout for test server responsiveness
    materializeTimeoutMs: 30_000,
    ...opts?.dispatchConfig,
  });
  manager.setStoreDirectory(tmpDir);
  await manager.recover();

  // Real DispatchAdapter with test directory injected — dispatchRound()
  // will use tmpDir instead of process.cwd(), and noParentInherit: true
  // is the real production value (not overridden).
  const adapter = new DispatchAdapter(manager, sessionAdapter, tmpDir);

  const coordinator = new LoopCoordinator(adapter, {
    delayMs: 0,
    roundTimeoutMs: opts?.roundTimeoutMs ?? 60_000,
  });

  return { coordinator, manager };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe.skipIf(!hasOpencode())("loop coordinator — real dispatch push-chain", () => {
  it("completes a 2-round loop through the real push-chain (register → kickoff → dispatch → terminated → advance → finalize)", async () => {
    const { coordinator, manager } = await createRealLoopCoordinator();

    try {
      const parentSessionId = await createParentSession();

      // (a) Register a 2-iteration loop.
      coordinator.register({
        originSessionId: parentSessionId,
        agent: "emperor",
        prompt: "Say OK and nothing else.",
        mode: "fresh",
        iterations: 2,
      });

      // (b) Wait for the push-chain to drive both rounds to completion.
      await waitForLoopTerminal(coordinator, parentSessionId, 180_000);

      // (c) Assert loop reached "complete" phase with 2 rounds.
      const state = coordinator.getLoopState(parentSessionId);
      expect(state).toBeDefined();
      expect(state!.phase).toBe("complete");
      expect(state!.rounds).toHaveLength(2);

      // Each round should have completed successfully
      for (const round of state!.rounds!) {
        expect(round.status).toBe("completed");
        expect(round.workerTaskId).toBeTruthy();
        expect(round.workerSessionId).toBeTruthy();
      }

      // Round numbers should be 1 and 2
      const roundNumbers = state!.rounds!.map((r) => r.round).sort();
      expect(roundNumbers).toEqual([1, 2]);
    } finally {
      coordinator.dispose();
    }
  }, 240_000); // 4 min — generous for 2 AI rounds

  it("registers a loop and directly transitions through the push-chain state machine", async () => {
    const { coordinator, manager } = await createRealLoopCoordinator();

    try {
      const parentSessionId = await createParentSession();

      // Register a single-iteration loop
      coordinator.register({
        originSessionId: parentSessionId,
        agent: "emperor",
        prompt: "Reply with exactly: round-1-done",
        mode: "fresh",
        iterations: 1,
      });

      // Give the microtask-based kickoff time to start
      await new Promise((r) => setTimeout(r, 100));

      // Should have transitioned past "activating"
      let state = coordinator.getLoopState(parentSessionId);
      expect(state).toBeDefined();
      expect(state!.phase).not.toBe("activating");

      // Wait for single-round completion
      await waitForLoopTerminal(coordinator, parentSessionId, 120_000);

      state = coordinator.getLoopState(parentSessionId);
      expect(state!.phase).toBe("complete");
      expect(state!.rounds).toHaveLength(1);

      // Verify the single round completed
      const round = state!.rounds![0];
      expect(round.round).toBe(1);
      expect(round.status).toBe("completed");
      expect(round.workerTaskId).toMatch(/^bg_/);
    } finally {
      coordinator.dispose();
    }
  }, 150_000);
});
