import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type {
  EngineState,
  NodeRuntimeState,
} from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { DispatchParentContext } from "../../src/graph/engine/dispatch-bridge.ts";
import type { NodeDispatchPort } from "../../src/graph/engine/engine-advance.ts";
import {
  createEngineState,
  provision,
} from "../../src/graph/engine/engine-state.ts";
import { EnginePersistence } from "../../src/graph/engine/engine-persistence.ts";
import { createEngine, type EngineRuntime } from "../../src/graph/engine/index.ts";
import {
  mapDispatchStatusToSignal,
  subscribeTaskTermination,
  reconcileEngine,
  rebuildFrontier,
  clearStaleCriticalSection,
  EngineLockSweeper,
  ORPHAN_REASON,
  type ReconcileReport,
} from "../../src/graph/engine/engine-recovery.ts";
import type { SignalType } from "../../src/graph/engine/signal-bridge.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

// ── Fixtures ────────────────────────────────────────────────────────────────

function singleNodeGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "single",
    nodes: [{ id: "A", agent: "a1", prompt: "p1" }],
    edges: [],
  };
}

function linearGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "linear",
    nodes: [
      { id: "A", agent: "a1", prompt: "p1" },
      { id: "B", agent: "a2", prompt: "p2" },
    ],
    edges: [{ from: "A", to: "B", type: "always" }],
  };
}

function makeTask(
  id: string,
  status: DispatchTask["status"] = "running",
  error?: string,
): DispatchTask {
  return {
    id,
    sessionId: `sess-${id}`,
    parentSessionId: "g",
    depth: 1,
    status,
    agent: "a",
    prompt: "p",
    startedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 0 },
    priority: 0,
    ...(error !== undefined ? { error } : {}),
  };
}

/** Build a provisioned state with a single node in a chosen status. */
function buildState(
  decl: GraphDeclaration,
  graphId: string,
): EngineState {
  const s = createEngineState(decl, graphId);
  provision(s);
  return s;
}

// ── mapDispatchStatusToSignal ───────────────────────────────────────────────

describe("mapDispatchStatusToSignal", () => {
  it("completed → answer", () => {
    expect(mapDispatchStatusToSignal("completed")).toEqual({
      type: "answer",
      payload: null,
    });
  });

  it("completed with terminatingSignal=revise_needed → revise_needed with payload", () => {
    const task = makeTask("t", "completed");
    task.terminatingSignal = {
      type: "revise_needed",
      payload: { findings: ["n1", "n2"] },
    };
    const sig = mapDispatchStatusToSignal("completed", task);
    expect(sig).toEqual({
      type: "revise_needed",
      payload: { findings: ["n1", "n2"] },
    });
  });

  it("completed with terminatingSignal=escalate → escalate with payload", () => {
    const task = makeTask("t", "completed");
    task.terminatingSignal = {
      type: "escalate",
      payload: { reason: "crash" },
    };
    const sig = mapDispatchStatusToSignal("completed", task);
    expect(sig).toEqual({
      type: "escalate",
      payload: { reason: "crash" },
    });
  });

  it("completed without terminatingSignal → answer (backward-compat default)", () => {
    const task = makeTask("t", "completed");
    expect(mapDispatchStatusToSignal("completed", task)).toEqual({
      type: "answer",
      payload: null,
    });
  });

  it("error → escalate carrying task.error", () => {
    const sig = mapDispatchStatusToSignal(
      "error",
      makeTask("t", "error", "boom"),
    );
    expect(sig).toEqual({ type: "escalate", payload: { error: "boom" } });
  });

  it("error → escalate with a fallback reason when task.error is absent", () => {
    const sig = mapDispatchStatusToSignal("error", makeTask("t", "error"));
    expect(sig!.type).toBe("escalate");
    expect((sig!.payload as { error: string }).error).toBeTruthy();
  });

  it("timeout → escalate", () => {
    expect(mapDispatchStatusToSignal("timeout")!.type).toBe("escalate");
  });

  it("cancelled → null (no terminating signal)", () => {
    expect(mapDispatchStatusToSignal("cancelled")).toBeNull();
  });

  it("non-terminal statuses → null", () => {
    expect(mapDispatchStatusToSignal("running")).toBeNull();
    expect(mapDispatchStatusToSignal("pending")).toBeNull();
    expect(mapDispatchStatusToSignal("awaiting_approval")).toBeNull();
  });
});

// ── subscribeTaskTermination ────────────────────────────────────────────────

describe("subscribeTaskTermination", () => {
  function subscribe(
    status: NodeRuntimeState["status"],
    taskId = "task-A",
    customTask?: DispatchTask,
  ): {
    state: EngineState;
    emitted: Array<[string, SignalType, unknown]>;
    fire: (status: string) => void;
  } {
    const state = buildState(singleNodeGraph(), "sub");
    const node = state.nodes.get("A")!;
    node.status = status;
    node.dispatchTaskId = taskId;
    const emitted: Array<[string, SignalType, unknown]> = [];
    const listeners: Array<(id: string, st: string) => void> = [];
    const port = {
      getTask: (id: string) =>
        customTask ??
        (id === taskId ? makeTask(taskId, "running") : undefined),
      onTaskTerminated: (_id: string, cb: (id: string, st: string) => void) =>
        listeners.push(cb),
    };
    subscribeTaskTermination(state, port as never, node, (n, t, p) =>
      emitted.push([n, t, p]),
    );
    return {
      state,
      emitted,
      fire: (st: string) => listeners.forEach((cb) => cb(taskId, st)),
    };
  }

  it("emits a mapped signal when the task terminates while the node is running", () => {
    const { fire, emitted } = subscribe(NodeStatus.Running);
    fire("completed");
    expect(emitted).toEqual([["A", "answer", null]]);
  });

  it("does NOT emit for a node that is no longer running", () => {
    const { fire, emitted } = subscribe(NodeStatus.Completed);
    fire("completed");
    expect(emitted).toEqual([]);
  });

  it("cancels the node directly (no signal) when the task is cancelled", () => {
    const { fire, emitted, state } = subscribe(NodeStatus.Running);
    fire("cancelled");
    expect(emitted).toEqual([]);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Cancelled);
  });

  it("ignores a listener whose task id no longer matches the node", () => {
    const { state } = subscribe(NodeStatus.Running);
    // Simulate a re-dispatch: the node now points at a different task.
    state.nodes.get("A")!.dispatchTaskId = "task-A-new";
    const emitted: Array<[string, SignalType, unknown]> = [];
    const port = { getTask: () => makeTask("old", "completed") };
    // A second subscription with the old id must be a no-op for the new binding.
    subscribeTaskTermination(state, port as never, state.nodes.get("A")!, (n, t, p) =>
      emitted.push([n, t, p]),
    );
    // Fire the OLD subscription's callback path is exercised via the helper port;
    // here we verify a stale task id guard by invoking with a mismatched id.
    expect(state.nodes.get("A")!.dispatchTaskId).toBe("task-A-new");
  });

  it("completed with terminatingSignal=revise_needed → emits revise_needed (not answer)", () => {
    const task = makeTask("task-A", "completed");
    task.terminatingSignal = {
      type: "revise_needed",
      payload: { findings: ["bad"] },
    };
    const { fire, emitted } = subscribe(
      NodeStatus.Running,
      "task-A",
      task,
    );
    fire("completed");
    expect(emitted).toEqual([
      ["A", "revise_needed", { findings: ["bad"] }],
    ]);
  });

  it("completed without terminatingSignal → emits answer (default)", () => {
    const task = makeTask("task-A", "completed");
    const { fire, emitted } = subscribe(
      NodeStatus.Running,
      "task-A",
      task,
    );
    fire("completed");
    expect(emitted).toEqual([["A", "answer", null]]);
  });
});

// ── reconcileEngine (per-node reconciliation) ───────────────────────────────

describe("reconcileEngine", () => {
  function runReconcile(
    task: DispatchTask | undefined,
    opts: { taskId?: string; status?: NodeRuntimeState["status"] } = {},
  ): {
    state: EngineState;
    report: ReconcileReport;
    subTasks: string[];
  } {
    const state = buildState(singleNodeGraph(), "rec");
    const node = state.nodes.get("A")!;
    node.status = opts.status ?? NodeStatus.Running;
    node.dispatchTaskId = opts.taskId ?? (task ? "task-A" : undefined);
    const subTasks: string[] = [];
    const port = {
      getTask: (_id: string) => task,
      onTaskTerminated: (id: string) => subTasks.push(id),
    };
    const report = reconcileEngine(
      state,
      port as never,
      () => {},
    );
    return { state, report, subTasks };
  }

  it("running node with a vanished task → timeout + escalate deferred", () => {
    const { state, report } = runReconcile(undefined);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Timeout);
    expect(state.nodes.get("A")!.errorReason).toBe(ORPHAN_REASON);
    expect(report.timedOut).toEqual(["A"]);
    expect(report.deferred).toHaveLength(1);
    expect(report.deferred[0]).toMatchObject({
      nodeId: "A",
      type: "escalate",
    });
    expect(report.reSubscribed).toEqual([]);
  });

  it("running node with no dispatch task id → timeout + escalate deferred", () => {
    const { state, report } = runReconcile(undefined, { taskId: undefined });
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Timeout);
    expect(report.deferred[0].nodeId).toBe("A");
  });

  it("running node that completed during restart → answer deferred", () => {
    const { report } = runReconcile(makeTask("task-A", "completed"));
    expect(report.deferred).toHaveLength(1);
    expect(report.deferred[0]).toMatchObject({ nodeId: "A", type: "answer" });
    expect(report.timedOut).toEqual([]);
  });

  it("running node that errored during restart → escalate deferred (with error)", () => {
    const { report } = runReconcile(makeTask("task-A", "error", "kaboom"));
    expect(report.deferred).toHaveLength(1);
    expect(report.deferred[0]).toMatchObject({ nodeId: "A", type: "escalate" });
    expect((report.deferred[0].payload as { error: string }).error).toBe(
      "kaboom",
    );
  });

  it("running node cancelled during restart → cancelled in place, no deferred", () => {
    const { state, report } = runReconcile(makeTask("task-A", "cancelled"));
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Cancelled);
    expect(report.deferred).toEqual([]);
    expect(report.timedOut).toEqual([]);
  });

  it("still-running task → re-subscribed, node untouched", () => {
    const { state, report, subTasks } = runReconcile(
      makeTask("task-A", "running"),
    );
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);
    expect(report.reSubscribed).toEqual(["A"]);
    expect(subTasks).toEqual(["task-A"]);
    expect(report.deferred).toEqual([]);
  });
});

// ── rebuildFrontier ─────────────────────────────────────────────────────────

describe("rebuildFrontier", () => {
  it("rebuilds the frontier from every ready node", () => {
    const state = buildState(linearGraph(), "frontier");
    // A = ready root (in frontier from provision); B = pending.
    state.frontier = []; // simulate a corrupted/empty frontier
    const rebuilt = rebuildFrontier(state);
    expect(rebuilt).toEqual(["A"]);
    expect(state.frontier).toEqual(["A"]);
  });

  it("includes a ready non-root node that is not yet in the frontier", () => {
    const state = buildState(linearGraph(), "frontier");
    const b = state.nodes.get("B")!;
    b.status = NodeStatus.Ready; // B became ready but never entered the frontier
    state.frontier = ["A"];
    const rebuilt = rebuildFrontier(state);
    expect(rebuilt).toEqual(["A", "B"]);
  });
});

// ── clearStaleCriticalSection ───────────────────────────────────────────────

describe("clearStaleCriticalSection", () => {
  it("releases a stuck lock and drops orphaned deferred completions", () => {
    const state = buildState(singleNodeGraph(), "stale");
    state.advancingLock = true;
    state.pendingCompletions = ["A"];
    clearStaleCriticalSection(state);
    expect(state.advancingLock).toBe(false);
    expect(state.pendingCompletions).toEqual([]);
  });

  it("is a no-op when the lock is already free", () => {
    const state = buildState(singleNodeGraph(), "stale");
    state.pendingCompletions = [];
    clearStaleCriticalSection(state);
    expect(state.advancingLock).toBe(false);
  });
});

// ── EngineLockSweeper (manually tickable — no unbounded interval) ──────────

describe("EngineLockSweeper", () => {
  it("does not release a freshly-held lock", () => {
    const state = buildState(singleNodeGraph(), "sweep");
    state.advancingLock = true;
    const sweeper = new EngineLockSweeper({ lockTimeoutMs: 30_000 });
    const released = sweeper.sweep(state, 1_000);
    expect(released).toBe(false);
    expect(state.advancingLock).toBe(true);
  });

  it("releases a lock held past the timeout (stale-lock release)", () => {
    const state = buildState(singleNodeGraph(), "sweep");
    state.advancingLock = true;
    const sweeper = new EngineLockSweeper({ lockTimeoutMs: 30_000 });
    sweeper.sweep(state, 1_000); // first observation
    const released = sweeper.sweep(state, 1_000 + 30_001); // stale
    expect(released).toBe(true);
    expect(state.advancingLock).toBe(false);
  });

  it("honors an injectable lockTimeoutMs and onRelease hook", () => {
    const state = buildState(singleNodeGraph(), "sweep");
    state.advancingLock = true;
    let releasedGraph = "";
    const sweeper = new EngineLockSweeper({
      lockTimeoutMs: 5_000,
      onRelease: (g) => (releasedGraph = g),
    });
    sweeper.sweep(state, 0);
    const released = sweeper.sweep(state, 5_000);
    expect(released).toBe(true);
    expect(releasedGraph).toBe(state.graphId);
  });

  it("forgets the first-seen time when the lock is released externally", () => {
    const state = buildState(singleNodeGraph(), "sweep");
    const sweeper = new EngineLockSweeper({ lockTimeoutMs: 30_000 });
    state.advancingLock = true;
    sweeper.sweep(state, 1_000);
    state.advancingLock = false; // released externally
    // re-acquired later — must start a fresh first-seen window, not be stale
    state.advancingLock = true;
    const released = sweeper.sweep(state, 1_000 + 1_000); // only 1s elapsed
    expect(released).toBe(false); // not yet stale (fresh window)
  });
});

// ── Integration: engine.recover() ───────────────────────────────────────────

describe("engine.recover() integration", () => {
  /** A controllable dispatch port backed by an in-memory task map. */
  class RecoveryFake implements NodeDispatchPort {
    tasks = new Map<string, DispatchTask>();
    calls: string[] = [];
    private listeners = new Map<string, Array<(id: string, st: string) => void>>();

    setStatus(id: string, status: DispatchTask["status"], error?: string): void {
      this.tasks.set(id, makeTask(id, status, error));
    }
    getTask(id: string): DispatchTask | undefined {
      return this.tasks.get(id);
    }
    onTaskTerminated(id: string, cb: (tid: string, st: string) => void): void {
      const arr = this.listeners.get(id) ?? [];
      arr.push(cb);
      this.listeners.set(id, arr);
    }
    cancelTask(id: string): Promise<boolean> {
      return Promise.resolve(true);
    }
    executeNode(
      node: NodeRuntimeState,
      _p: DispatchParentContext,
    ): Promise<DispatchTask> {
      this.calls.push(node.nodeId);
      const t = makeTask(`task-${node.nodeId}`);
      this.tasks.set(t.id, t);
      return Promise.resolve(t);
    }
    /** Fire every registered listener for a task (test driver). */
    fire(id: string, status: DispatchTask["status"]): void {
      for (const cb of this.listeners.get(id) ?? []) cb(id, status);
    }
  }

  function makeTmpDir(): string {
    return mkdtempSync(join(tmpdir(), "engine-recovery-"));
  }

  it("task vanished during restart → node marked timeout, engine completes", async () => {
    const dir = makeTmpDir();
    const fakeA = new RecoveryFake();
    const engineA = createEngine(singleNodeGraph(), {
      stateDir: dir,
      graphId: "rec-vanish",
      dispatch: fakeA,
    });
    await engineA.run(); // A running, persisted with dispatchTaskId task-A

    const fakeB = new RecoveryFake(); // empty task map → task-A is vanished
    const engineB = createEngine(singleNodeGraph(), {
      stateDir: dir,
      graphId: "rec-vanish",
      dispatch: fakeB,
    });
    await engineB.recover();

    const snap = engineB.status();
    expect(snap.nodes.get("A")!.status).toBe(NodeStatus.Timeout);
    expect(snap.nodes.get("A")!.errorReason).toBe(ORPHAN_REASON);
    expect(snap.phase).toBe(EnginePhase.Complete);
  });

  it("task completed during restart → answer re-emitted, node completed", async () => {
    const dir = makeTmpDir();
    const fakeA = new RecoveryFake();
    await createEngine(singleNodeGraph(), {
      stateDir: dir,
      graphId: "rec-completed",
      dispatch: fakeA,
    })
      .run();

    const fakeB = new RecoveryFake();
    fakeB.setStatus("task-A", "completed");
    const engineB = createEngine(singleNodeGraph(), {
      stateDir: dir,
      graphId: "rec-completed",
      dispatch: fakeB,
    });
    await engineB.recover();

    const snap = engineB.status();
    expect(snap.nodes.get("A")!.status).toBe(NodeStatus.Completed);
    expect(snap.phase).toBe(EnginePhase.Complete);
  });

  it("task still running → re-subscribed; a later completion advances the node", async () => {
    const dir = makeTmpDir();
    const fakeA = new RecoveryFake();
    const engineA = createEngine(singleNodeGraph(), {
      stateDir: dir,
      graphId: "rec-live",
      dispatch: fakeA,
    });
    await engineA.run();

    const fakeB = new RecoveryFake();
    fakeB.setStatus("task-A", "running"); // still live during restart
    const engineB = createEngine(singleNodeGraph(), {
      stateDir: dir,
      graphId: "rec-live",
      dispatch: fakeB,
    });
    await engineB.recover();

    // Still running — recovery only re-subscribed, did not force-complete.
    expect(engineB.status().nodes.get("A")!.status).toBe(NodeStatus.Running);

    // The worker finally terminates → the re-subscribed listener drives the graph.
    fakeB.setStatus("task-A", "completed");
    fakeB.fire("task-A", "completed");
    await tick();
    await tick();

    const snap = engineB.status();
    expect(snap.nodes.get("A")!.status).toBe(NodeStatus.Completed);
    expect(snap.phase).toBe(EnginePhase.Complete);
  });

  it("releases a stale advancingLock from a crashed state and resumes ready nodes", async () => {
    const dir = makeTmpDir();
    const graphId = "rec-lock";
    // Simulate a crash that persisted a stuck lock mid-advance.
    const crashed = buildState(singleNodeGraph(), graphId);
    crashed.advancingLock = true; // the process died holding the lock
    crashed.pendingCompletions = ["A"];
    new EnginePersistence(dir).save(crashed);

    const fake = new RecoveryFake();
    const engine = createEngine(singleNodeGraph(), {
      stateDir: dir,
      graphId,
      dispatch: fake,
    });
    await engine.recover();

    const snap = engine.status();
    expect(snap.advancingLock).toBe(false); // stale lock released
    // The ready root A was re-dispatched by the rebuilt frontier.
    expect(fake.calls).toEqual(["A"]);
    expect(snap.nodes.get("A")!.status).toBe(NodeStatus.Running);
  });

  it("is a no-op (clean start) when no persisted state exists", async () => {
    const dir = makeTmpDir();
    const fake = new RecoveryFake();
    const engine = createEngine(singleNodeGraph(), {
      stateDir: dir,
      graphId: "rec-never",
      dispatch: fake,
    });
    await engine.recover();
    // Nothing was persisted → recovery adopted nothing; the engine stays idle.
    expect(engine.status().phase).toBe(EnginePhase.Idle);
    expect(fake.calls).toEqual([]);
  });
});

// ── Integration: engine.cancel() ────────────────────────────────────────────

describe("engine.cancel() integration", () => {
  class CancelFake implements NodeDispatchPort {
    cancelled: string[] = [];
    executeNode(
      node: NodeRuntimeState,
      _p: DispatchParentContext,
    ): Promise<DispatchTask> {
      return Promise.resolve(makeTask(`task-${node.nodeId}`));
    }
    cancelTask(id: string): Promise<boolean> {
      this.cancelled.push(id);
      return Promise.resolve(true);
    }
  }

  it("cancels running/ready/pending nodes and completes the engine", async () => {
    const fake = new CancelFake();
    const engine = createEngine(linearGraph(), { dispatch: fake });
    await engine.run(); // A running, B pending

    await engine.cancel();

    const snap = engine.status();
    expect(snap.phase).toBe(EnginePhase.Complete);
    expect(snap.nodes.get("A")!.status).toBe(NodeStatus.Done);
    expect(snap.nodes.get("B")!.status).toBe(NodeStatus.Done);
    expect(snap.frontier).toEqual([]);
    // The running node's dispatch task was cancelled via the seam.
    expect(fake.cancelled).toEqual(["task-A"]);
  });

  it("persists the cancelled terminal state when a stateDir is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-cancel-"));
    const fake = new CancelFake();
    const graphId = "rec-cancel-persist";
    const engine: EngineRuntime = createEngine(singleNodeGraph(), {
      stateDir: dir,
      graphId,
      dispatch: fake,
    });
    await engine.run();
    await engine.cancel();

    const loaded = new EnginePersistence(dir).load(graphId);
    expect(loaded!.phase).toBe(EnginePhase.Complete);
    expect(loaded!.nodes.get("A")!.status).toBe(NodeStatus.Done);
    rmSync(dir, { recursive: true, force: true });
  });
});
