/**
 * Escalate-retry backoff — dispatch withholding + wake-up timer (subtask 2 of
 * the escalate-retry-bypass fix).
 *
 * The escalate retry gate (signal-propagation.ts) re-marks an escalated node
 * `ready` and stamps `retryBackoffUntil = now + backoff_ms` when the
 * qualifying retry edge declares `backoff_ms`. These tests pin the DISPATCH
 * half of that contract (engine-advance.ts):
 *
 * 1. A Ready node whose `retryBackoffUntil` has not passed is NEVER dispatched
 *    on a dispatch pass — it stays Ready in the frontier (so `_checkTermination`
 *    keeps the graph phase `executing`, never `complete`, through the window).
 * 2. After each dispatch pass the engine arms ONE setTimeout for the earliest
 *    pending backoff deadline; the timer re-enters the advancement lock and
 *    re-runs the dispatch pass, so the withheld node re-dispatches >= backoff_ms
 *    after its prior escalate. Later deadlines re-arm the timer in order.
 * 3. The timer is cleared on re-schedule, on teardown (S7 dispose), and when
 *    the graph reaches its terminal phase — a disposed / completed engine
 *    never fires a dispatch pass.
 *
 * Also pins the persistence half: `retryBackoffUntil` round-trips through
 * serialize/deserialize and is carried across `adoptPriorNodeStates` rebuilds,
 * so a restart / rebuild never re-dispatches a withheld retry early.
 */

import { describe, it, expect } from "bun:test";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type {
  NodeRuntimeState,
  EngineState,
} from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { DispatchParentContext } from "../../src/graph/engine/dispatch-bridge.ts";
import type { TaskTerminatedCallback } from "../../src/graph/engine/dispatch-bridge.ts";
import {
  createEngineState,
  provision,
  isInFrontier,
} from "../../src/graph/engine/engine-state.ts";
import { SignalBridge } from "../../src/graph/engine/signal-bridge.ts";
import {
  AdvanceEngine,
  type NodeDispatchPort,
} from "../../src/graph/engine/engine-advance.ts";
import { adoptPriorNodeStates } from "../../src/graph/engine/engine-recovery.ts";
import {
  serializeEngineState,
  deserializeEngineState,
} from "../../src/graph/engine/engine-persistence.ts";
import { createEngine } from "../../src/graph/engine/index.ts";

// ── Controllable fake dispatch port ─────────────────────────────────────────

/** Records per-node launches with wall-clock timestamps. */
class FakeDispatch implements NodeDispatchPort {
  launches: { nodeId: string; at: number }[] = [];

  executeNode(
    node: NodeRuntimeState,
    _parentContext: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.launches.push({ nodeId: node.nodeId, at: Date.now() });
    return Promise.resolve(makeTask(node.nodeId));
  }

  callsFor(nodeId: string): number {
    return this.launches.filter((l) => l.nodeId === nodeId).length;
  }

  /** Wall-clock time (epoch ms) of each launch of `nodeId`, in order. */
  times(nodeId: string): number[] {
    return this.launches.filter((l) => l.nodeId === nodeId).map((l) => l.at);
  }
}

function makeTask(nodeId: string): DispatchTask {
  return {
    id: `task-${nodeId}`,
    sessionId: `sess-${nodeId}`,
    parentSessionId: "g-1",
    depth: 1,
    status: "running",
    agent: nodeId,
    prompt: nodeId,
    startedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 0 },
    priority: 0,
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A → B with an escalate-retry policy declared on the outbound edge. */
function linearRetryGraph(retryMax: number, backoffMs: number): GraphDeclaration {
  return {
    version: 2,
    name: "linear-backoff",
    nodes: [
      { id: "A", agent: "a1", prompt: "p1" },
      { id: "B", agent: "a2", prompt: "p2" },
    ],
    edges: [
      {
        from: "A",
        to: "B",
        type: "always",
        retry: { max: retryMax, backoff_ms: backoffMs },
      },
    ],
  };
}

/** Two independent roots, each with its own retry edge (different backoffs). */
function twoRootRetryGraph(backoffA: number, backoffB: number): GraphDeclaration {
  return {
    version: 2,
    name: "two-root-backoff",
    nodes: [
      { id: "A", agent: "a1", prompt: "p1" },
      { id: "B", agent: "a2", prompt: "p2" },
      { id: "C", agent: "a3", prompt: "p3" },
      { id: "D", agent: "a4", prompt: "p4" },
    ],
    edges: [
      { from: "A", to: "C", type: "always", retry: { max: 1, backoff_ms: backoffA } },
      { from: "B", to: "D", type: "always", retry: { max: 1, backoff_ms: backoffB } },
    ],
  };
}

interface TestRig {
  state: EngineState;
  engine: AdvanceEngine;
  fake: FakeDispatch;
}

function buildEngine(decl: GraphDeclaration, fake = new FakeDispatch()): TestRig {
  const state = createEngineState(decl, "g-1");
  provision(state);
  const bridge = new SignalBridge();
  const engine = new AdvanceEngine({ state, signalBridge: bridge, dispatch: fake });
  return { state, engine, fake };
}

/** One macrotask boundary — lets fire-and-forget advance chains settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Poll a condition every 5ms until it holds or the timeout expires. */
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Dispatch withholding + wake-up timer
// ═══════════════════════════════════════════════════════════════════════════

describe("escalate-retry backoff: dispatch withholding + wake-up timer", () => {
  it(
    "withholds each re-dispatch >= backoff_ms after the prior escalate; phase stays executing",
    async () => {
      const { state, engine, fake } = buildEngine(linearRetryGraph(2, 10));
      await engine.dispatchReady();
      expect(fake.callsFor("A")).toBe(1);

      // Attempt 1 escalates → the retry gate re-marks A ready with a backoff
      // deadline (retryBackoffUntil = now + 10). The dispatch pass right after
      // must SKIP it: still Ready, still in the frontier, never markRunning.
      const escalate1At = Date.now();
      await engine.onNodeSignalEmitted("A", "escalate", { reason: "boom-1" });
      const a = state.nodes.get("A")!;
      expect(a.status).toBe(NodeStatus.Ready);
      expect(isInFrontier(state, "A")).toBe(true);
      // `escalate1At` is the pre-escalate snapshot: the deadline is stamped at
      // escalate-processing time (>= escalate1At) plus the 10ms backoff. A
      // fresh `Date.now()` after the await would race that 10ms window on a
      // loaded CI runner — the dispatch-spacing assertions below already pin
      // the withholding behavior.
      expect(a.retryBackoffUntil).toBeGreaterThanOrEqual(escalate1At + 10);
      expect(a.retryBackoffUntil).toBeLessThanOrEqual(Date.now() + 10);
      expect(a.retryCount).toBe(1);
      expect(fake.callsFor("A")).toBe(1); // no early re-dispatch
      expect(state.phase).toBe(EnginePhase.Executing);

      // During the backoff window the graph must NEVER reach `complete` — the
      // withheld Ready node is scheduler-active to the termination check.
      const windowEnd = Date.now() + 30;
      while (Date.now() < windowEnd) {
        expect(state.phase).toBe(EnginePhase.Executing);
        await new Promise((r) => setTimeout(r, 5));
      }

      // The wake-up timer re-dispatched A once the window closed, and only
      // then — >= 10ms after the escalate that armed it.
      expect(fake.callsFor("A")).toBe(2);
      expect(fake.launches[1].at - escalate1At).toBeGreaterThanOrEqual(10);
      expect(a.status).toBe(NodeStatus.Running);

      // Attempt 2 escalates → retry #2 withheld the same way (retryCount 2).
      const escalate2At = Date.now();
      await engine.onNodeSignalEmitted("A", "escalate", { reason: "boom-2" });
      expect(a.status).toBe(NodeStatus.Ready);
      expect(a.retryCount).toBe(2);
      expect(fake.callsFor("A")).toBe(2);
      await new Promise((r) => setTimeout(r, 40));
      expect(fake.callsFor("A")).toBe(3);
      expect(fake.launches[2].at - escalate2At).toBeGreaterThanOrEqual(10);
      expect(a.status).toBe(NodeStatus.Running);

      // Attempt 3: the retry budget (max 2) is exhausted → the escalation is
      // no longer absorbed. A stays Escalate, B stays Pending (always edge),
      // and the graph stays executing awaiting orchestrator attention — no
      // further dispatch and no spurious completion.
      await engine.onNodeSignalEmitted("A", "escalate", { reason: "boom-3" });
      expect(a.status).toBe(NodeStatus.Escalate);
      expect(a.retryCount).toBe(2);
      expect(fake.callsFor("A")).toBe(3);
      expect(state.phase).toBe(EnginePhase.Executing);
    },
  );

  it(
    "arms ONE timer for the earliest deadline; later deadlines re-arm and fire in order",
    async () => {
      // A's backoff (60ms) is much shorter than B's (200ms): the ~140ms gap
      // between the two deadlines makes the "A fires first, B still withheld"
      // observation robust under parallel-load scheduling jitter. A tight
      // window with fixed sleeps would race it (as a fresh `Date.now()`
      // would).
      const { state, engine, fake } = buildEngine(twoRootRetryGraph(60, 200));
      await engine.dispatchReady();
      expect(fake.callsFor("A")).toBe(1);
      expect(fake.callsFor("B")).toBe(1);

      // Both roots escalate → both re-marked ready, A's deadline earlier.
      const before = Date.now();
      await engine.onNodeSignalEmitted("A", "escalate", { reason: "boom-a" });
      await new Promise((r) => setTimeout(r, 5));
      await engine.onNodeSignalEmitted("B", "escalate", { reason: "boom-b" });
      const a = state.nodes.get("A")!;
      const b = state.nodes.get("B")!;
      // Both withheld at this instant; each deadline is stamp-time + its
      // backoff, and the stamps are >= `before` — no fresh `Date.now()` race.
      expect(a.status).toBe(NodeStatus.Ready);
      expect(b.status).toBe(NodeStatus.Ready);
      expect(a.retryBackoffUntil).toBeGreaterThanOrEqual(before + 60);
      expect(b.retryBackoffUntil).toBeGreaterThanOrEqual(before + 5 + 200);
      expect(fake.callsFor("A")).toBe(1); // no early re-dispatch
      expect(fake.callsFor("B")).toBe(1);

      // A's window closes first → the single timer dispatches ONLY A; B is
      // still withheld (its deadline is ~140ms later) and the phase never
      // completes. Poll on A's own timer rather than sleeping past it.
      await waitFor(() => fake.callsFor("A") === 2, 1000);
      expect(fake.callsFor("B")).toBe(1);
      expect(b.status).toBe(NodeStatus.Ready);
      expect(isInFrontier(state, "B")).toBe(true);
      expect(state.phase).toBe(EnginePhase.Executing);

      // The re-armed timer dispatches B once ITS window closes — and only
      // then: A (now running, never re-terminated by this fake) is not
      // dispatched a second time.
      await waitFor(() => fake.callsFor("B") === 2, 1000);
      expect(fake.callsFor("A")).toBe(2);
      expect(b.status).toBe(NodeStatus.Running);
      expect(state.phase).toBe(EnginePhase.Executing);

      // Ordering + spacing pinned by recorded launch timestamps (immune to
      // observation delay): A re-dispatched first, each >= its own backoff
      // after the prior launch.
      const tA = fake.times("A");
      const tB = fake.times("B");
      expect(tB[1]).toBeGreaterThanOrEqual(tA[1]); // A's re-dispatch came first
      expect(tA[1] - tA[0]).toBeGreaterThanOrEqual(60); // A waited its backoff
      expect(tB[1] - tB[0]).toBeGreaterThanOrEqual(200); // B waited its backoff
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Timer teardown — no dispatch after clear / dispose / terminal phase
// ═══════════════════════════════════════════════════════════════════════════

describe("escalate-retry backoff: timer teardown", () => {
  it("clearing the backoff timer (the S7 dispose mechanism) prevents any later dispatch", async () => {
    const { state, engine, fake } = buildEngine(linearRetryGraph(2, 10));
    await engine.dispatchReady();
    const escalateAt = Date.now();
    await engine.onNodeSignalEmitted("A", "escalate", { reason: "boom" });
    const a = state.nodes.get("A")!;
    expect(a.status).toBe(NodeStatus.Ready);
    // Pre-escalate snapshot: the deadline is stamp-time + 10ms, which is
    // >= escalateAt + 10 regardless of how long the await takes — no fresh
    // `Date.now()` race under parallel load.
    expect(a.retryBackoffUntil).toBeGreaterThanOrEqual(escalateAt + 10);
    expect(a.retryBackoffUntil).toBeLessThanOrEqual(Date.now() + 10);
    expect(fake.callsFor("A")).toBe(1);

    // Mirrors `EngineRuntime.dispose()` → `advance.clearBackoffTimer()`.
    engine.clearBackoffTimer();
    await new Promise((r) => setTimeout(r, 40));
    expect(fake.callsFor("A")).toBe(1); // no dispatch after teardown
    expect(a.status).toBe(NodeStatus.Ready); // still withheld
    expect(state.phase).toBe(EnginePhase.Executing);
  });

  it("EngineRuntime.dispose() clears the wake-up timer — no dispatch after teardown", async () => {
    // Backoff 50ms (not 10ms): the two macrotask `flush()` boundaries between
    // the error fire and the dispose must stay well inside the backoff window
    // under parallel-load stretch, so the timer is still pending when we tear
    // down.
    const fake = new ErrorFiringDispatch();
    const engine = createEngine(linearRetryGraph(2, 50), { dispatch: fake });
    await engine.run(); // A dispatched
    expect(fake.launches.filter((n) => n === "A").length).toBe(1);

    // The dispatch layer reports a terminal `error` for task-A → the engine
    // escalates A → the retry gate re-marks it ready with a 50ms backoff →
    // the wake-up timer is armed. Wait only macrotask boundaries (NOT the
    // backoff window) so the timer is still pending when we dispose.
    fake.fireError("task-A");
    await flush();
    await flush();
    expect(engine.status().nodes.get("A")!.status).toBe(NodeStatus.Ready);
    expect(fake.launches.filter((n) => n === "A").length).toBe(1);

    engine.dispose(); // S7 teardown — must cancel the pending wake-up timer
    await new Promise((r) => setTimeout(r, 100)); // well past the 50ms window
    expect(fake.launches.filter((n) => n === "A").length).toBe(1);
    expect(engine.status().nodes.get("A")!.status).toBe(NodeStatus.Ready);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Persistence — serialize / deserialize + adoptPriorNodeStates
// ═══════════════════════════════════════════════════════════════════════════

describe("escalate-retry backoff: persistence", () => {
  it("round-trips retryBackoffUntil through serializeEngineState / deserializeEngineState", () => {
    const { state } = buildEngine(linearRetryGraph(2, 10));
    state.nodes.get("A")!.retryBackoffUntil = 9876543210;

    const dto = serializeEngineState(state);
    expect(dto.nodes["A"].retryBackoffUntil).toBe(9876543210);

    const restored = deserializeEngineState(dto);
    expect(restored.nodes.get("A")!.retryBackoffUntil).toBe(9876543210);
  });

  it("leaves retryBackoffUntil undefined when absent (old files / no backoff)", () => {
    const { state } = buildEngine(linearRetryGraph(2, 10));
    const dto = serializeEngineState(state); // A never escalated — field absent
    expect(dto.nodes["A"].retryBackoffUntil).toBeUndefined();
    const restored = deserializeEngineState(dto);
    expect(restored.nodes.get("A")!.retryBackoffUntil).toBeUndefined();
  });

  it("carries retryBackoffUntil across adoptPriorNodeStates rebuilds", () => {
    const prior = buildEngine(linearRetryGraph(2, 10)).state;
    // A is a provisioned root (Ready) — adoption applies; stamp a withheld
    // deadline so the rebuilt engine must not re-dispatch early.
    prior.nodes.get("A")!.retryBackoffUntil = 1234567890;

    const target = createEngineState(linearRetryGraph(2, 10), "g-1");
    provision(target);
    adoptPriorNodeStates(target, prior);

    expect(target.nodes.get("A")!.retryBackoffUntil).toBe(1234567890);
    // And the absent case stays absent (no fabricated value).
    expect(target.nodes.get("B")!.retryBackoffUntil).toBeUndefined();
  });
});

// ── Full-runtime dispatch seam that reports terminal `error`s ───────────────

/**
 * Dispatch seam for the `EngineRuntime.dispose()` test: dispatches succeed,
 * subscriptions are tracked, and `getTask` reports the task `error` after
 * `fireError` — so a fired `error` termination is authoritative (not live) and
 * the engine escalates the node through the normal dispatch→signal seam.
 */
class ErrorFiringDispatch implements NodeDispatchPort {
  private subs = new Map<string, TaskTerminatedCallback>();
  private tasks = new Map<string, DispatchTask>();
  launches: string[] = [];

  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    const id = `task-${node.nodeId}`;
    const task = { ...makeTask(node.nodeId), id };
    this.tasks.set(id, task);
    this.launches.push(node.nodeId);
    return Promise.resolve(task);
  }

  onTaskTerminated(taskId: string, cb: TaskTerminatedCallback): TaskTerminatedCallback {
    this.subs.set(taskId, cb);
    return cb;
  }

  removeTaskTerminatedListener(taskId: string, _cb: TaskTerminatedCallback): void {
    this.subs.delete(taskId);
  }

  getTask(taskId: string): DispatchTask | undefined {
    return this.tasks.get(taskId);
  }

  /** Fire a terminal `error` — the task is marked error (NOT live), so the
   *  transient-error guard lets the escalate through. */
  fireError(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) task.status = "error";
    this.subs.get(taskId)?.(taskId, "error");
  }
}
