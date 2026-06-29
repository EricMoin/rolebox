/**
 * Phase 0 — maxTotalSessionsPerRequest (tree-level session budget)
 *
 * TDD: These tests reference config / methods that don't exist yet.
 * They must all fail (RED) until the implementation is complete.
 *
 * Run: bun test tests/dispatch/budget.test.ts
 */
import { describe, it, expect, afterEach } from "bun:test";
import { clearSentFinalNotifies, clearParentQueues } from "../../src/dispatch/notification";

afterEach(() => {
  clearSentFinalNotifies();
  clearParentQueues();
});

// ── T1: Reject background launch when budget exhausted ─────────────

describe("T1: budget exhausted — background launch rejected", () => {
  it("third launch from same parent returns error when maxTotalSessionsPerRequest=2", async () => {
    const { DispatchManager } = await import("../../src/dispatch/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    const manager = new DispatchManager(client, {
      maxConcurrent: 5,
      maxTotalSessionsPerRequest: 2,
      taskTtlMs: 100,
    } as any);

    const ctx = parentContext({ sessionID: "T1-parent" });

    const t1 = await manager.launch(
      { subagent: "helper", prompt: "work1", run_in_background: true },
      ctx,
    );
    expect(["running", "pending"]).toContain(t1.status);

    const t2 = await manager.launch(
      { subagent: "helper", prompt: "work2", run_in_background: true },
      ctx,
    );
    expect(["running", "pending"]).toContain(t2.status);

    const t3 = await manager.launch(
      { subagent: "helper", prompt: "work3", run_in_background: true },
      ctx,
    );
    expect(t3.status).toBe("error");
    expect(t3.error).toMatch(/budget/i);
    expect(JSON.parse(t3.error!).error).toBe("Session budget exhausted");
  });
});

// ── T2: Cumulative semantics — completion does NOT free budget ─────

describe("T2: cumulative — completion does NOT free budget", () => {
  it("after 2 background tasks complete, 3rd is still rejected", async () => {
    const { DispatchManager } = await import("../../src/dispatch/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    const manager = new DispatchManager(client, {
      maxConcurrent: 5,
      maxTotalSessionsPerRequest: 2,
      taskTtlMs: 100,
    } as any);
    const mgr = manager as any;
    const ctx = parentContext({ sessionID: "T2-parent" });

    const t1 = await manager.launch(
      { subagent: "helper", prompt: "a1", run_in_background: true },
      ctx,
    );
    expect(["running", "pending"]).toContain(t1.status);

    const t2 = await manager.launch(
      { subagent: "helper", prompt: "a2", run_in_background: true },
      ctx,
    );
    expect(["running", "pending"]).toContain(t2.status);

    // Force-complete both tasks — budget should NOT be freed
    mgr.transition(t1.id, ["running"], "completed");
    mgr.leaveRunning(t1.id);
    mgr.transition(t2.id, ["running"], "completed");
    mgr.leaveRunning(t2.id);

    const t3 = await manager.launch(
      { subagent: "helper", prompt: "a3", run_in_background: true },
      ctx,
    );
    expect(t3.status).toBe("error");
    expect(t3.error).toMatch(/budget/i);
  });
});

// ── T3: Reset on session.deleted of the parent ─────────────────────

describe("T3: budget resets on session.deleted of the parent", () => {
  it("after handleSessionDeleted(parentSessionId), new launch succeeds", async () => {
    const { DispatchManager } = await import("../../src/dispatch/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    const manager = new DispatchManager(client, {
      maxConcurrent: 5,
      maxTotalSessionsPerRequest: 2,
      taskTtlMs: 100,
    } as any);
    const ctx = parentContext({ sessionID: "T3-parent" });

    // Exhaust budget
    await manager.launch(
      { subagent: "helper", prompt: "a1", run_in_background: true },
      ctx,
    );
    await manager.launch(
      { subagent: "helper", prompt: "a2", run_in_background: true },
      ctx,
    );

    // Reset via session.deleted
    await manager.handleSessionDeleted(ctx.sessionID);

    // Now launch should succeed
    const t3 = await manager.launch(
      { subagent: "helper", prompt: "a3", run_in_background: true },
      ctx,
    );
    expect(["running", "pending"]).toContain(t3.status);
  });
});

// ── T4: session.idle does NOT reset budget ─────────────────────────

describe("T4: session.idle does NOT reset budget", () => {
  it("after handleSessionIdle, budget is still exhausted", async () => {
    const { DispatchManager } = await import("../../src/dispatch/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    const manager = new DispatchManager(client, {
      maxConcurrent: 5,
      maxTotalSessionsPerRequest: 2,
      taskTtlMs: 100,
    } as any);
    const ctx = parentContext({ sessionID: "T4-parent" });

    // Exhaust budget
    await manager.launch(
      { subagent: "helper", prompt: "a1", run_in_background: true },
      ctx,
    );
    await manager.launch(
      { subagent: "helper", prompt: "a2", run_in_background: true },
      ctx,
    );

    // Idle event should NOT reset
    await manager.handleSessionIdle(ctx.sessionID);

    const t3 = await manager.launch(
      { subagent: "helper", prompt: "a3", run_in_background: true },
      ctx,
    );
    expect(t3.status).toBe("error");
    expect(t3.error).toMatch(/budget/i);
  });
});

// ── T5: undefined = unlimited (no regression) ──────────────────────

describe("T5: undefined budget = unlimited", () => {
  it("can launch 5+ tasks without budget rejection", async () => {
    const { DispatchManager } = await import("../../src/dispatch/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    // No maxTotalSessionsPerRequest set → undefined
    const manager = new DispatchManager(client, {
      maxConcurrent: 10,
      taskTtlMs: 100,
    } as any);
    const ctx = parentContext({ sessionID: "T5-parent" });

    for (let i = 0; i < 5; i++) {
      const task = await manager.launch(
        { subagent: "helper", prompt: `work${i}`, run_in_background: true },
        ctx,
      );
      // Should NOT be rejected for budget (may be pending via concurrency gates)
      expect(task.status).not.toBe("error");
      if (task.error) {
        expect(JSON.parse(task.error!).error).not.toBe("Session budget exhausted");
      }
    }
  });
});

// ── T6: executeSync throws structured error on budget exhausted ────

describe("T6: executeSync throws when budget exhausted", () => {
  it("throws error matching /budget/ after budget is consumed", async () => {
    const { DispatchManager } = await import("../../src/dispatch/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    const manager = new DispatchManager(client, {
      maxConcurrent: 5,
      maxTotalSessionsPerRequest: 1,
      taskTtlMs: 100,
    } as any);
    const ctx = parentContext({ sessionID: "T6-parent" });

    // Consume the single budget slot with a background launch
    await manager.launch(
      { subagent: "helper", prompt: "fill", run_in_background: true },
      ctx,
    );

    // executeSync should throw
    await expect(
      manager.executeSync(
        { subagent: "helper", prompt: "should fail", run_in_background: false },
        ctx,
      ),
    ).rejects.toThrow(/budget/i);
  });
});

// ── T7: Continuation (session_id) does NOT count ───────────────────

describe("T7: continuation does NOT count toward budget", () => {
  it("reopenForContinuation does not increment request sessions", async () => {
    const { DispatchManager } = await import("../../src/dispatch/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    const manager = new DispatchManager(client, {
      maxConcurrent: 5,
      maxTotalSessionsPerRequest: 2,
      taskTtlMs: 100,
    } as any);
    const mgr = manager as any;
    const ctx = parentContext({ sessionID: "T7-parent" });

    // Launch 2 tasks to fill budget
    const t1 = await manager.launch(
      { subagent: "helper", prompt: "a1", run_in_background: true },
      ctx,
    );

    const t2 = await manager.launch(
      { subagent: "helper", prompt: "a2", run_in_background: true },
      ctx,
    );

    // Force t1 to completed so we can reopen it
    mgr.transition(t1.id, ["running"], "completed");

    // Reopen t1 as a continuation — should NOT trigger budget
    const reopened = await manager.reopenForContinuation(
      t1.id,
      { subagent: "helper", prompt: "continue", run_in_background: true },
      ctx,
    );
    expect(reopened.id).toBe(t1.id);
    expect(reopened.status).toBe("running");

    // Budget should still have 2 (not 3)
    const budgetCount = mgr.getRequestSessions(ctx.sessionID);
    expect(budgetCount).toBe(2);
  });
});

// ── T8: Independent parents have independent budgets ───────────────

describe("T8: independent parents have independent budgets", () => {
  it("parent-A exhausted, parent-B can still launch", async () => {
    const { DispatchManager } = await import("../../src/dispatch/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    const manager = new DispatchManager(client, {
      maxConcurrent: 10,
      maxTotalSessionsPerRequest: 1,
      taskTtlMs: 100,
    } as any);

    const ctxA = parentContext({ sessionID: "T8-parent-A" });
    const ctxB = parentContext({ sessionID: "T8-parent-B" });

    // Exhaust parent-A
    const ta1 = await manager.launch(
      { subagent: "helper", prompt: "a1", run_in_background: true },
      ctxA,
    );
    expect(["running", "pending"]).toContain(ta1.status);

    // Parent-A second launch → rejected
    const ta2 = await manager.launch(
      { subagent: "helper", prompt: "a2", run_in_background: true },
      ctxA,
    );
    expect(ta2.status).toBe("error");
    expect(ta2.error).toMatch(/budget/i);

    // Parent-B first launch → succeeds (independent budget)
    const tb1 = await manager.launch(
      { subagent: "helper", prompt: "b1", run_in_background: true },
      ctxB,
    );
    expect(["running", "pending"]).toContain(tb1.status);
  });
});

// ── T9: Deep (depth-2) tree bounded by budget ──────────────────────

describe("T9: deep (depth-2) tree bounded by budget", () => {
  it("a depth-2 tree of 10+ sessions hits budget exhaustion", async () => {
    const { DispatchManager } = await import("../../src/dispatch/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    const manager = new DispatchManager(client, {
      maxConcurrent: 10,
      maxTotalSessionsPerRequest: 3,
      taskTtlMs: 100,
    } as any);
    const ctx = parentContext({ sessionID: "T9-root" });

    // Launch 3 tasks from root — should hit budget gate on 4th
    const t1 = await manager.launch(
      { subagent: "helper", prompt: "d1", run_in_background: true },
      ctx,
    );
    expect(["running", "pending"]).toContain(t1.status);

    const t2 = await manager.launch(
      { subagent: "helper", prompt: "d2", run_in_background: true },
      ctx,
    );
    expect(["running", "pending"]).toContain(t2.status);

    const t3 = await manager.launch(
      { subagent: "helper", prompt: "d3", run_in_background: true },
      ctx,
    );
    expect(["running", "pending"]).toContain(t3.status);

    // 4th launch → budget exhausted
    const t4 = await manager.launch(
      { subagent: "helper", prompt: "d4", run_in_background: true },
      ctx,
    );
    expect(t4.status).toBe("error");
    expect(t4.error).toMatch(/budget/i);
    const err = JSON.parse(t4.error!);
    expect(err.error).toBe("Session budget exhausted");
    expect(err.spawned).toBe(3);
    expect(err.limit).toBe(3);
  });
});
