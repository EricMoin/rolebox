/**
 * S4 — per-request session-slot refunds for CANCELLED / TIMED-OUT dispatch tasks.
 *
 * The `maxTotalSessionsPerRequest` budget is the runaway-loop safety valve: a
 * parent (or graph) that spawns unbounded children is capped once the counter
 * reaches the cap. Pre-S4 the counter ONLY ever incremented (and reset on
 * session.deleted), so a cancelled or timed-out task — which produced NO result
 * — kept holding its slot forever, permanently starving later launches.
 *
 * S4 adds `decRequestSessions` (src/dispatch/core/lifecycle-shared.ts), called
 * from every task-termination path that ends in `cancelled` or `timeout`:
 *   - task cancellation (task-cancellation.ts — all three branches)
 *   - the timeout branches of completion evaluation
 *     (completion-evaluator.ts — timeoutAndRelease + handleTaskTimeout)
 *   - cleanup (lifecycle-shared.ts scheduleCleanup — safety net)
 *
 * Guardrails pinned here:
 *   - `completed`, `error` (the `escalate` signal path) and
 *     `awaiting_approval` (`blocked`) tasks KEEP counting — no refund.
 *   - The decrement is IDEMPOTENT per task id (one refund max).
 *   - The counter never goes negative.
 *
 * Run: bun test tests/dispatch/budget-refund.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { DispatchManager } from "../../src/dispatch/core/manager";
import {
  incRequestSessions,
  decRequestSessions,
  getRequestSessions,
  type TaskLifecycleDeps,
} from "../../src/dispatch/core/lifecycle-shared";
import type { DispatchTask, DispatchTaskStatus } from "../../src/dispatch/types";
import { createMockClient, parentContext } from "./helpers";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools";
import {
  clearSentFinalNotifies,
  clearParentQueues,
} from "../../src/dispatch/notification";

const settle = () => new Promise((r) => setTimeout(r, 25));

beforeEach(() => {
  clearSentFinalNotifies();
  clearParentQueues();
});

afterEach(() => {
  clearSentFinalNotifies();
  clearParentQueues();
});

// ── Unit tests of the decRequestSessions helper ─────────────────────────────

/** Minimal TaskLifecycleDeps containing only what inc/dec/getRequestSessions read. */
function makeDeps(): TaskLifecycleDeps {
  return {
    tasks: new Map<string, DispatchTask>(),
    sessionsByRequest: new Map<string, number>(),
    budgetCountedTasks: new Set<string>(),
  } as unknown as TaskLifecycleDeps;
}

function makeTask(id: string, status: DispatchTaskStatus): DispatchTask {
  return {
    id,
    sessionId: "ses",
    parentSessionId: "root",
    depth: 1,
    status,
    agent: "a",
    prompt: "p",
    startedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 0 },
    priority: 0,
  };
}

describe("decRequestSessions (helper semantics)", () => {
  it("refunds cancelled and timeout slots; completed / error / awaiting_approval keep counting", () => {
    const d = makeDeps();
    const root = "root";

    // cancelled → refund
    const t1 = makeTask("t1", "cancelled");
    d.tasks.set("t1", t1);
    incRequestSessions(d, root, "t1");
    decRequestSessions(d, "t1");
    expect(getRequestSessions(d, root)).toBe(0);

    // timeout → refund
    const t2 = makeTask("t2", "timeout");
    d.tasks.set("t2", t2);
    incRequestSessions(d, root, "t2");
    decRequestSessions(d, "t2");
    expect(getRequestSessions(d, root)).toBe(0);

    // completed → NO refund (guardrail)
    const t3 = makeTask("t3", "completed");
    d.tasks.set("t3", t3);
    incRequestSessions(d, root, "t3");
    decRequestSessions(d, "t3");
    expect(getRequestSessions(d, root)).toBe(1);

    // error (the escalate signal path) → NO refund (guardrail)
    const t4 = makeTask("t4", "error");
    d.tasks.set("t4", t4);
    incRequestSessions(d, root, "t4");
    decRequestSessions(d, "t4");
    expect(getRequestSessions(d, root)).toBe(2);

    // awaiting_approval (blocked) → NO refund (guardrail)
    const t5 = makeTask("t5", "awaiting_approval");
    d.tasks.set("t5", t5);
    incRequestSessions(d, root, "t5");
    decRequestSessions(d, "t5");
    expect(getRequestSessions(d, root)).toBe(3);
  });

  it("is idempotent per task id — one refund max", () => {
    const d = makeDeps();
    const root = "root";
    const t1 = makeTask("t1", "cancelled");
    d.tasks.set("t1", t1);
    incRequestSessions(d, root, "t1");
    decRequestSessions(d, "t1");
    decRequestSessions(d, "t1"); // second refund → no-op
    decRequestSessions(d, "t1"); // third → no-op
    expect(getRequestSessions(d, root)).toBe(0);

    // Two distinct counted tasks both refund independently.
    const t2 = makeTask("t2", "timeout");
    d.tasks.set("t2", t2);
    incRequestSessions(d, root, "t2");
    decRequestSessions(d, "t2");
    expect(getRequestSessions(d, root)).toBe(0);
  });

  it("never goes negative and no-ops for tasks that never counted", () => {
    const d = makeDeps();
    const root = "root";

    // A task whose slot was reset away (session.deleted) must not push the
    // counter below zero when it later terminates cancelled.
    const t1 = makeTask("t1", "cancelled");
    d.tasks.set("t1", t1);
    incRequestSessions(d, root, "t1");
    d.sessionsByRequest.delete(root); // resetRequestSessions equivalent
    decRequestSessions(d, "t1");
    expect(getRequestSessions(d, root)).toBe(0);

    // Never counted (budget-rejected launch, restored-after-restart task,
    // sync task cancelled before session creation) → dec is a no-op.
    decRequestSessions(d, "never-counted");
    expect(getRequestSessions(d, root)).toBe(0);
  });
});

// ── Dispatch-level: N launches + M cancellations leaves N-M ─────────────────

describe("S4 budget refunds — cancellation", () => {
  it("N launches + M cancellations leaves budget N-M and relaunch succeeds", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, {
      maxConcurrent: 5,
      maxTotalSessionsPerRequest: 3,
      taskTtlMs: 60_000,
    } as any);
    const mgr = manager as any;
    const ctx = parentContext({ sessionID: "s4-nm-parent" });
    try {
      const t1 = await manager.launch(
        { subagent: "helper", prompt: "a", run_in_background: true },
        ctx,
      );
      const t2 = await manager.launch(
        { subagent: "helper", prompt: "b", run_in_background: true },
        ctx,
      );
      const t3 = await manager.launch(
        { subagent: "helper", prompt: "c", run_in_background: true },
        ctx,
      );
      expect(["running", "pending"]).toContain(t1.status);
      expect(["running", "pending"]).toContain(t2.status);
      expect(["running", "pending"]).toContain(t3.status);
      expect(mgr.getRequestSessions(ctx.sessionID)).toBe(3);

      // 4th launch while the cap is genuinely consumed → rejected.
      const t4 = await manager.launch(
        { subagent: "helper", prompt: "d", run_in_background: true },
        ctx,
      );
      expect(t4.status).toBe("error");
      expect(t4.error).toMatch(/budget/i);

      // Cancel 2 of the 3 (M=2) → budget must drop to N-M = 1.
      expect(await manager.cancelTask(t1.id)).toBe(true);
      expect(await manager.cancelTask(t2.id)).toBe(true);
      expect(mgr.getRequestSessions(ctx.sessionID)).toBe(1);

      // Relaunch now succeeds (the runaway-loop valve is no longer stuck).
      const t5 = await manager.launch(
        { subagent: "helper", prompt: "e", run_in_background: true },
        ctx,
      );
      expect(["running", "pending"]).toContain(t5.status);
      expect(mgr.getRequestSessions(ctx.sessionID)).toBe(2);

      // Idempotent at the manager level too: re-cancelling an already
      // cancelled task returns false and does NOT double-refund.
      expect(await manager.cancelTask(t1.id)).toBe(false);
      expect(mgr.getRequestSessions(ctx.sessionID)).toBe(2);
    } finally {
      await manager.dispose();
    }
  });

  it("timeout refunds the slot (handleTaskTimeout) so a later launch succeeds", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, {
      maxConcurrent: 5,
      maxTotalSessionsPerRequest: 1,
      taskTtlMs: 60_000,
    } as any);
    const mgr = manager as any;
    const ctx = parentContext({ sessionID: "s4-timeout-parent" });
    try {
      const t1 = await manager.launch(
        { subagent: "helper", prompt: "a", run_in_background: true },
        ctx,
      );
      expect(["running", "pending"]).toContain(t1.status);
      expect(mgr.getRequestSessions(ctx.sessionID)).toBe(1);

      // Cap genuinely consumed → 2nd launch rejected.
      const t2 = await manager.launch(
        { subagent: "helper", prompt: "b", run_in_background: true },
        ctx,
      );
      expect(t2.status).toBe("error");
      expect(t2.error).toMatch(/budget/i);

      // Timeout the running task → slot refunded.
      manager.handleTaskTimeout(t1.id, "test timeout");
      expect(mgr.getRequestSessions(ctx.sessionID)).toBe(0);

      // Relaunch succeeds.
      const t3 = await manager.launch(
        { subagent: "helper", prompt: "c", run_in_background: true },
        ctx,
      );
      expect(["running", "pending"]).toContain(t3.status);
      expect(mgr.getRequestSessions(ctx.sessionID)).toBe(1);
    } finally {
      await manager.dispose();
    }
  });

  it("timeout via completion evaluation (timeoutAndRelease) also refunds", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, {
      maxConcurrent: 5,
      maxTotalSessionsPerRequest: 1,
      taskTtlMs: 60_000,
      backgroundStaleTimeoutMs: 5_000,
    } as any);
    const mgr = manager as any;
    const ctx = parentContext({ sessionID: "s4-eval-timeout-parent" });
    try {
      const t1 = await manager.launch(
        { subagent: "helper", prompt: "a", run_in_background: true },
        ctx,
      );
      expect(mgr.getRequestSessions(ctx.sessionID)).toBe(1);

      // Backdate the start so the evaluator's not_ready stale check fires
      // (mock client never reports output → "Never produced output").
      t1.startedAt = new Date(Date.now() - 60_000);
      await manager.evaluateAndComplete(t1.id, "global-sweep");

      expect(t1.status).toBe("timeout");
      expect(mgr.getRequestSessions(ctx.sessionID)).toBe(0);

      const t2 = await manager.launch(
        { subagent: "helper", prompt: "b", run_in_background: true },
        ctx,
      );
      expect(["running", "pending"]).toContain(t2.status);
    } finally {
      await manager.dispose();
    }
  });
});

// ── Guardrails: completed / error / blocked keep counting ──────────────────

describe("S4 guardrails — completed, error, blocked keep counting", () => {
  it("completed and error (escalate) tasks are NOT refunded", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, {
      maxConcurrent: 5,
      maxTotalSessionsPerRequest: 2,
      taskTtlMs: 60_000,
    } as any);
    const mgr = manager as any;
    const ctx = parentContext({ sessionID: "s4-guardrail-parent" });
    try {
      const t1 = await manager.launch(
        { subagent: "helper", prompt: "a", run_in_background: true },
        ctx,
      );
      const t2 = await manager.launch(
        { subagent: "helper", prompt: "b", run_in_background: true },
        ctx,
      );
      expect(mgr.getRequestSessions(ctx.sessionID)).toBe(2);

      // Complete t1 → budget must NOT drop (cumulative semantics preserved).
      mgr.transition(t1.id, ["running"], "completed");
      mgr.leaveRunning(t1.id);
      expect(mgr.getRequestSessions(ctx.sessionID)).toBe(2);

      // Error t2 (the escalate signal path) → budget must NOT drop.
      mgr.transition(t2.id, ["running"], "error", { error: "boom" });
      mgr.leaveRunning(t2.id);
      expect(mgr.getRequestSessions(ctx.sessionID)).toBe(2);

      // Cap still genuinely consumed → 3rd launch rejected.
      const t3 = await manager.launch(
        { subagent: "helper", prompt: "c", run_in_background: true },
        ctx,
      );
      expect(t3.status).toBe("error");
      expect(t3.error).toMatch(/budget/i);
      expect(JSON.parse(t3.error!).spawned).toBe(2);
    } finally {
      await manager.dispose();
    }
  });

  it("blocked (awaiting_approval) tasks are NOT refunded, even after approval", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, {
      maxConcurrent: 5,
      maxTotalSessionsPerRequest: 1,
      taskTtlMs: 60_000,
    } as any);
    const mgr = manager as any;
    const ctx = parentContext({ sessionID: "s4-blocked-parent" });
    try {
      const t1 = await manager.launch(
        { subagent: "helper", prompt: "a", run_in_background: true },
        ctx,
      );
      expect(mgr.getRequestSessions(ctx.sessionID)).toBe(1);

      // Block (HITL) → still counted.
      mgr.transition(t1.id, ["running"], "awaiting_approval");
      expect(mgr.getRequestSessions(ctx.sessionID)).toBe(1);

      // Approve → completed → still counted.
      expect(await manager.approveTask(t1.id)).toBe(true);
      expect(mgr.getRequestSessions(ctx.sessionID)).toBe(1);

      // Cap still consumed → next launch rejected.
      const t2 = await manager.launch(
        { subagent: "helper", prompt: "b", run_in_background: true },
        ctx,
      );
      expect(t2.status).toBe("error");
      expect(t2.error).toMatch(/budget/i);
    } finally {
      await manager.dispose();
    }
  });
});

// ── Graph retry after cascade-cancelled siblings can re-dispatch ────────────

describe("S4 graph retry after cascade-cancelled siblings", () => {
  it("cancelled sibling dispatch tasks refund their slots, so a graph retry re-dispatches instead of hitting budget exhaustion", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "rolebox-s4-refund-graph-"));
    // Held-open mock client: sessions never report completion, so dispatched
    // nodes stay Running until cancelled (same seam as graph-concurrency-e2e).
    const client = createMockClient();
    const manager = new DispatchManager(client, {
      maxConcurrent: 5,
      maxTotalSessionsPerRequest: 2,
      taskTtlMs: 60_000,
    } as any);
    manager.setStoreDirectory(tmpDir);
    const mgr = manager as any;
    try {
      const ts = createGraphToolSet({ manager, directory: "/work/s4-refund-graph" });
      const g = ts.graph_create({ name: "s4-refund-graph" });
      ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });
      ts.graph_add_node({ graph_id: g.graph_id, id: "B", agent: "b", prompt: "pB" });

      // Phase 1: run the graph — both sibling nodes dispatch, budget full (2/2).
      const runResult = await ts.graph_run({ graph_id: g.graph_id });
      expect(runResult.active_nodes).toContain("A");
      expect(runResult.active_nodes).toContain("B");
      await settle();
      expect(mgr.getRequestSessions(g.graph_id)).toBe(2);

      // Phase 2: cascade-cancel the sibling dispatch tasks — the exact seam
      // the join-cascade canceller uses
      // (cascade-canceller.ts: `dispatchPort.cancelTask(upstream.dispatchTaskId)`).
      const siblings = manager.getTasksByParent(g.graph_id);
      expect(siblings.length).toBe(2);
      for (const s of siblings) {
        expect(await manager.cancelTask(s.id)).toBe(true);
      }
      await settle();

      // Both cancelled slots are refunded → budget back to 0.
      expect(mgr.getRequestSessions(g.graph_id)).toBe(0);

      // Phase 3: retry node A. Pre-S4 the two cancelled slots still counted
      // (2/2) so this re-dispatch was rejected with "Session budget exhausted".
      // Post-S4 the refund frees the slots and the retry re-dispatches.
      const retry = await ts.graph_run({
        graph_id: g.graph_id,
        node_id: "A",
        retry: true,
      });
      expect(retry.retry?.node_id).toBe("A");
      expect(retry.retry?.re_dispatched).toBeGreaterThanOrEqual(1);
      await settle();

      // The retry launch consumed one fresh slot.
      expect(mgr.getRequestSessions(g.graph_id)).toBe(1);

      // The retried node is genuinely Running again (retry_count=1) — NOT
      // escalated by a budget-rejection error task.
      const status = ts.graph_status({ graph_id: g.graph_id, node_id: "A" });
      expect(status).toContain("status: running");
      expect(status).toContain("retry_count: 1");

      const tasks = manager.getTasksByParent(g.graph_id);
      const runningTask = tasks.find((t) => t.status === "running");
      expect(runningTask).toBeDefined();
      expect(runningTask!.error).toBeUndefined();
      const budgetRejections = tasks.filter(
        (t) => t.error && /budget/i.test(t.error),
      );
      expect(budgetRejections.length).toBe(0);
    } finally {
      await manager.dispose();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
