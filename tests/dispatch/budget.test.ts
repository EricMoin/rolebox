/**
 * Session budget removal — dispatch launches are UNBOUNDED.
 *
 * The `maxTotalSessionsPerRequest` tree-level session cap was removed from
 * src/. Dispatch no longer counts sessions per parent and never rejects with
 * "Session budget exhausted". These tests lock in the new unbounded behavior:
 * many background launches from one parent all reach pending/running, no
 * `/budget/` error appears anywhere, and executeSync does not throw on
 * repeated launches.
 *
 * Run: bun test tests/dispatch/budget.test.ts
 */
import { describe, it, expect, afterEach } from "bun:test";
import { clearSentFinalNotifies, clearParentQueues } from "../../src/dispatch/notification";

afterEach(() => {
  clearSentFinalNotifies();
  clearParentQueues();
});

// ── T1: Unbounded background launches from one parent ──────────────

describe("T1: budget cap removed — many background launches from one parent all succeed", () => {
  it("10 launches from the same parent all reach running/pending (no budget rejection)", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    const manager = new DispatchManager(client, {
      taskTtlMs: 100,
    } as any);

    const ctx = parentContext({ sessionID: "T1-parent" });

    for (let i = 0; i < 10; i++) {
      const t = await manager.launch(
        { subagent: "helper", prompt: `work${i}`, run_in_background: true },
        ctx,
      );
      expect(["running", "pending"]).toContain(t.status);
      // No budget error of any kind
      if (t.error) {
        expect(t.error).not.toMatch(/budget/i);
      }
    }
  });
});

// ── T2: Completion does not gate subsequent launches ───────────────

describe("T2: completing tasks does NOT gate further launches", () => {
  it("after 2 background tasks complete, more launches still succeed", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    const manager = new DispatchManager(client, {
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

    // Force-complete both tasks
    mgr.transition(t1.id, ["running"], "completed");
    mgr.leaveRunning(t1.id);
    mgr.transition(t2.id, ["running"], "completed");
    mgr.leaveRunning(t2.id);

    // More launches must still succeed — completion never gates a session cap
    const t3 = await manager.launch(
      { subagent: "helper", prompt: "a3", run_in_background: true },
      ctx,
    );
    expect(["running", "pending"]).toContain(t3.status);

    const t4 = await manager.launch(
      { subagent: "helper", prompt: "a4", run_in_background: true },
      ctx,
    );
    expect(["running", "pending"]).toContain(t4.status);
  });
});

// ── T3: session.deleted of the parent does not break launches ──────

describe("T3: launches succeed after session.deleted of the parent", () => {
  it("handleSessionDeleted(parentSessionId) is a no-op for launch gating", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    const manager = new DispatchManager(client, {
      taskTtlMs: 100,
    } as any);
    const ctx = parentContext({ sessionID: "T3-parent" });

    await manager.launch(
      { subagent: "helper", prompt: "a1", run_in_background: true },
      ctx,
    );
    await manager.launch(
      { subagent: "helper", prompt: "a2", run_in_background: true },
      ctx,
    );

    // session.deleted must not throw and must not gate anything
    await manager.handleSessionDeleted(ctx.sessionID);

    const t3 = await manager.launch(
      { subagent: "helper", prompt: "a3", run_in_background: true },
      ctx,
    );
    expect(["running", "pending"]).toContain(t3.status);
  });
});

// ── T4: session.idle does not gate launches ────────────────────────

describe("T4: launches succeed after session.idle", () => {
  it("after handleSessionIdle, further launches still succeed", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    const manager = new DispatchManager(client, {
      taskTtlMs: 100,
    } as any);
    const ctx = parentContext({ sessionID: "T4-parent" });

    await manager.launch(
      { subagent: "helper", prompt: "a1", run_in_background: true },
      ctx,
    );
    await manager.launch(
      { subagent: "helper", prompt: "a2", run_in_background: true },
      ctx,
    );

    // Idle event must not reset or gate a session budget
    await manager.handleSessionIdle(ctx.sessionID);

    const t3 = await manager.launch(
      { subagent: "helper", prompt: "a3", run_in_background: true },
      ctx,
    );
    expect(["running", "pending"]).toContain(t3.status);
  });
});

// ── T5: No session cap — arbitrary launch counts succeed ───────────

describe("T5: unbounded — 20 launches across parents all succeed", () => {
  it("can launch 20 tasks across 2 parents without any budget rejection", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    const manager = new DispatchManager(client, {
      taskTtlMs: 100,
    } as any);
    const ctxA = parentContext({ sessionID: "T5-parent-A" });
    const ctxB = parentContext({ sessionID: "T5-parent-B" });

    for (let i = 0; i < 10; i++) {
      const ta = await manager.launch(
        { subagent: "helper", prompt: `a${i}`, run_in_background: true },
        ctxA,
      );
      const tb = await manager.launch(
        { subagent: "helper", prompt: `b${i}`, run_in_background: true },
        ctxB,
      );
      // Neither parent may be rejected for a session budget
      expect(ta.status).not.toBe("error");
      expect(tb.status).not.toBe("error");
      if (ta.error) {
        expect(JSON.parse(ta.error!).error).not.toBe("Session budget exhausted");
      }
      if (tb.error) {
        expect(JSON.parse(tb.error!).error).not.toBe("Session budget exhausted");
      }
    }
  });
});

// ── T6: executeSync does not throw on repeated launches ────────────

describe("T6: executeSync does not throw on repeated launches", () => {
  it("after background launches, executeSync runs repeatedly without budget errors", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    const manager = new DispatchManager(client, {
      taskTtlMs: 100,
    } as any);
    const ctx = parentContext({ sessionID: "T6-parent" });

    // Launch background tasks first
    for (let i = 0; i < 5; i++) {
      await manager.launch(
        { subagent: "helper", prompt: `fill${i}`, run_in_background: true },
        ctx,
      );
    }

    // executeSync must succeed repeatedly — no session budget gate
    for (let i = 0; i < 5; i++) {
      const result = await manager.executeSync(
        { subagent: "helper", prompt: `sync${i}`, run_in_background: false },
        ctx,
      );
      expect(result).toBe("Hello from subagent");
    }
  });
});

// ── T7: Continuation (session_id) works unbounded ──────────────────

describe("T7: reopenForContinuation works with unbounded launches", () => {
  it("reopening a completed task as a continuation succeeds", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    const manager = new DispatchManager(client, {
      taskTtlMs: 100,
    } as any);
    const mgr = manager as any;
    const ctx = parentContext({ sessionID: "T7-parent" });

    const t1 = await manager.launch(
      { subagent: "helper", prompt: "a1", run_in_background: true },
      ctx,
    );

    // Force t1 to completed so we can reopen it
    mgr.transition(t1.id, ["running"], "completed");

    // Reopen t1 as a continuation — must succeed, no budget counting involved
    const reopened = await manager.reopenForContinuation(
      t1.id,
      { subagent: "helper", prompt: "continue", run_in_background: true },
      ctx,
    );
    expect(reopened.id).toBe(t1.id);
    expect(reopened.status).toBe("running");
  });
});

// ── T8: Independent parents launch unbounded ───────────────────────

describe("T8: independent parents both launch unbounded", () => {
  it("parent-A and parent-B each launch many tasks without rejection", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    const manager = new DispatchManager(client, {
      taskTtlMs: 100,
    } as any);

    const ctxA = parentContext({ sessionID: "T8-parent-A" });
    const ctxB = parentContext({ sessionID: "T8-parent-B" });

    // Parent-A launches 5, parent-B launches 5 — all succeed
    for (let i = 0; i < 5; i++) {
      const ta = await manager.launch(
        { subagent: "helper", prompt: `a${i}`, run_in_background: true },
        ctxA,
      );
      expect(["running", "pending"]).toContain(ta.status);

      const tb = await manager.launch(
        { subagent: "helper", prompt: `b${i}`, run_in_background: true },
        ctxB,
      );
      expect(["running", "pending"]).toContain(tb.status);
    }
  });
});

// ── T9: Deep tree launches unbounded ───────────────────────────────

describe("T9: deep (depth-2) tree launches unbounded", () => {
  it("a depth-2 tree of 10+ sessions all launch successfully", async () => {
    const { DispatchManager } = await import("../../src/dispatch/core/manager");
    const { createMockClient, parentContext } = await import("./helpers");

    const client = createMockClient();
    const manager = new DispatchManager(client, {
      taskTtlMs: 100,
    } as any);
    const ctx = parentContext({ sessionID: "T9-root" });

    // 10 launches from the root — no budget gate anywhere
    for (let i = 0; i < 10; i++) {
      const t = await manager.launch(
        { subagent: "helper", prompt: `d${i}`, run_in_background: true },
        ctx,
      );
      expect(["running", "pending"]).toContain(t.status);
      if (t.error) {
        expect(t.error).not.toMatch(/budget/i);
      }
    }
  });
});
