import { describe, it, expect } from "bun:test";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type {
  NodeRuntimeState,
  EngineState,
} from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { TaskTerminatedCallback } from "../../src/graph/engine/dispatch-bridge.ts";
import {
  createEngine,
  type EngineRuntime,
  type DispatchParentContext,
  type NodeDispatchPort,
  type NodeCompletionEvent,
} from "../../src/graph/engine/index.ts";

// ── Fake dispatch seam (injectable into createEngine) ───────────────────────

class FakeDispatch implements NodeDispatchPort {
  calls: { nodeId: string; agent: string; prompt: string }[] = [];

  executeNode(
    node: NodeRuntimeState,
    _parentContext: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push({ nodeId: node.nodeId, agent: node.agent, prompt: node.prompt });
    return Promise.resolve(makeTask(node.nodeId));
  }
}

/**
 * Dispatch seam that completes every dispatched task (via a microtask-bound
 * `setTimeout`) and fires its `onTaskTerminated` listener — drives real signal
 * advancement through the public engine API so the per-node signal ledger
 * history and loop-group rounds get populated end-to-end.
 */
class FiringDispatch implements NodeDispatchPort {
  private subs = new Map<string, TaskTerminatedCallback>();
  private tasks = new Map<string, DispatchTask>();
  private seq = 0;

  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    const id = `task-${node.nodeId}-${++this.seq}`;
    const task = { ...makeTask(node.nodeId), id, sessionId: `sess-${id}` };
    this.tasks.set(id, task);
    setTimeout(() => {
      task.status = "completed";
      this.subs.get(id)?.(id, "completed");
    }, 0);
    return Promise.resolve(task);
  }

  onTaskTerminated(taskId: string, cb: TaskTerminatedCallback): TaskTerminatedCallback {
    this.subs.set(taskId, cb);
    return cb;
  }

  getTask(taskId: string): DispatchTask | undefined {
    return this.tasks.get(taskId);
  }
}

/**
 * Dispatch seam that records every `onTaskTerminated` subscription and every
 * `removeTaskTerminatedListener` call — verifies the M4 dispose teardown
 * unregisters the engine's subscriptions from the port.
 */
class DisposableDispatch implements NodeDispatchPort {
  subs = new Map<string, TaskTerminatedCallback>();
  removals: string[] = [];

  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    return Promise.resolve(makeTask(node.nodeId));
  }

  onTaskTerminated(taskId: string, cb: TaskTerminatedCallback): TaskTerminatedCallback {
    this.subs.set(taskId, cb);
    return cb;
  }

  removeTaskTerminatedListener(taskId: string, _cb: TaskTerminatedCallback): void {
    this.removals.push(taskId);
    this.subs.delete(taskId);
  }

  /** Simulate the dispatch subsystem completing a task (only if still registered). */
  fireIfRegistered(taskId: string, status: string): void {
    this.subs.get(taskId)?.(taskId, status);
  }
}

/** Let chained setTimeout-driven task completions drain. */
const settle = () => new Promise((r) => setTimeout(r, 50));

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

/** Single-node graph (a root that fans to nothing downstream). */
function singleNodeGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "single",
    nodes: [{ id: "A", agent: "a1", prompt: "p1" }],
    edges: [],
  };
}

/** 3-node linear graph: A → B → C. */
function linearGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "linear",
    nodes: [
      { id: "A", agent: "a1", prompt: "p1" },
      { id: "B", agent: "a2", prompt: "p2" },
      { id: "C", agent: "a3", prompt: "p3" },
    ],
    edges: [
      { from: "A", to: "B", type: "always" },
      { from: "B", to: "C", type: "always" },
    ],
  };
}

/**
 * Pure always-cycle A ⇄ B inside a bounded loop group. Intra-group always
 * edges are excluded from in-degree, so both nodes provision as roots; each
 * answer-driven re-entry consumes a traversal and records a loop round, and
 * the per-node signal ledger accumulates answer history — populating both
 * monitor surfaces exercised by the snapshot isolation test (M7).
 */
function alwaysCycleGraph(maxTraversals = 3): GraphDeclaration {
  return {
    version: 2,
    name: "always-cycle",
    nodes: [
      { id: "A", agent: "a0", prompt: "node A" },
      { id: "B", agent: "a1", prompt: "node B" },
    ],
    edges: [
      { from: "A", to: "B", type: "always" },
      { from: "B", to: "A", type: "always" },
    ],
    loop_groups: [{ id: "lg", nodes: ["A", "B"], max_traversals: maxTraversals }],
  };
}

// ── createEngine() returns a valid EngineRuntime ─────────────────────────────

describe("createEngine()", () => {
  it("returns a valid EngineRuntime with the full method surface", () => {
    const engine = createEngine(singleNodeGraph());
    expect(engine).toBeDefined();
    // The runtime exposes the documented lifecycle surface.
    expect(typeof engine.provision).toBe("function");
    expect(typeof engine.run).toBe("function");
    expect(typeof engine.recover).toBe("function");
    expect(typeof engine.status).toBe("function");
    expect(typeof engine.cancel).toBe("function");
  });

  it("provisions an EngineState: registers nodes and readies roots", () => {
    const engine = createEngine(singleNodeGraph());
    const state = engine.provision();
    expect(state.phase).toBe(EnginePhase.Idle);
    expect(state.nodes.has("A")).toBe(true);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Ready); // root
    expect(state.frontier).toEqual(["A"]);
    expect(state.graphDeclaration).toEqual(singleNodeGraph());
  });

  it("is idempotent: provisioning twice does not re-register nodes", () => {
    const engine = createEngine(singleNodeGraph());
    engine.provision();
    const second = engine.provision(); // must not throw on duplicate node id
    expect(second.nodes.size).toBe(1);
    expect(second.frontier).toEqual(["A"]);
  });

  it("is constructible without a dispatch seam (provision/status work)", () => {
    const engine = createEngine(linearGraph());
    const state = engine.provision();
    expect(state.nodes.size).toBe(3);
    expect(engine.status().phase).toBe(EnginePhase.Idle); // status() usable pre-run
  });

  it("rejects run() with a clear error when no dispatch seam is injected", async () => {
    const engine = createEngine(singleNodeGraph());
    await expect(engine.run()).rejects.toThrow(/no dispatch seam/i);
  });
});

// ── run(): phase → executing and dispatch roots ─────────────────────────────

describe("engine.run()", () => {
  it("transitions the phase to executing and dispatches root nodes", async () => {
    const fake = new FakeDispatch();
    const engine = createEngine(linearGraph(), { dispatch: fake });

    engine.provision();
    expect(engine.status().phase).toBe(EnginePhase.Idle);

    await engine.run();

    const snap = engine.status();
    expect(snap.phase).toBe(EnginePhase.Executing);
    // Only the root A is dispatched initially; B/C stay pending.
    expect(fake.calls.map((c) => c.nodeId)).toEqual(["A"]);
    expect(snap.nodes.get("A")!.status).toBe(NodeStatus.Running);
    expect(snap.nodes.get("B")!.status).toBe(NodeStatus.Pending);
    expect(snap.nodes.get("C")!.status).toBe(NodeStatus.Pending);
  });

  it("dispatches every root of a multi-root graph", async () => {
    const fake = new FakeDispatch();
    const graph: GraphDeclaration = {
      version: 2,
      name: "two-roots",
      nodes: [
        { id: "R1", agent: "a1", prompt: "r1" },
        { id: "R2", agent: "a2", prompt: "r2" },
        { id: "S", agent: "a3", prompt: "s" },
      ],
      edges: [
        { from: "R1", to: "S", type: "always" },
        { from: "R2", to: "S", type: "always" },
      ],
    };
    const engine = createEngine(graph, { dispatch: fake });
    await engine.run(); // run auto-provisions first

    expect(fake.calls.map((c) => c.nodeId).sort()).toEqual(["R1", "R2"]);
    expect(engine.status().phase).toBe(EnginePhase.Executing);
    expect(engine.status().nodes.get("S")!.status).toBe(NodeStatus.Pending);
  });

  it("auto-provisions when run() is called without an explicit provision()", async () => {
    const fake = new FakeDispatch();
    const engine = createEngine(singleNodeGraph(), { dispatch: fake });
    await engine.run(); // no prior provision() call
    expect(fake.calls.map((c) => c.nodeId)).toEqual(["A"]);
    expect(engine.status().phase).toBe(EnginePhase.Executing);
  });
});

// ── status(): EngineState snapshot ──────────────────────────────────────────

describe("engine.status()", () => {
  it("returns a snapshot decoupled from the live engine state", async () => {
    const fake = new FakeDispatch();
    const engine = createEngine(linearGraph(), { dispatch: fake });
    engine.provision();

    const snap = engine.status();
    expect(snap).toBeDefined();
    // Mutating the snapshot's collections must not affect the live state.
    snap.nodes.clear();
    snap.frontier.push("GHOST");

    await engine.run();
    const live = engine.status();
    expect(live.nodes.size).toBe(3); // live nodes untouched
    expect(live.frontier).not.toContain("GHOST");
    expect(live.nodes.get("A")!.status).toBe(NodeStatus.Running);
  });

  it("reflects the live phase and lifecycle as it changes", async () => {
    const fake = new FakeDispatch();
    const engine = createEngine(singleNodeGraph(), { dispatch: fake });

    expect(engine.status().phase).toBe(EnginePhase.Idle);
    await engine.run();
    expect(engine.status().phase).toBe(EnginePhase.Executing);
    expect(engine.status().nodes.get("A")!.status).toBe(NodeStatus.Running);
  });

  it("deep-clones signalLedger history and loop-group rounds (in-place push does not affect an earlier snapshot) [M7]", async () => {
    const fake = new FiringDispatch();
    const engine = createEngine(alwaysCycleGraph(), { dispatch: fake });

    // Drive the always-cycle to completion through the public API: answer
    // signals accumulate per-node ledger history and each re-entry records a
    // loop round.
    await engine.run();
    await settle();
    await settle();
    expect(engine.status().phase).toBe(EnginePhase.Complete);

    const s1 = engine.status();
    const histA = s1.signalLedger.get("A")!.history!;
    const rounds = s1.loopGroups.get("lg")!.rounds!;
    const histLen = histA.length;
    const roundsLen = rounds.length;
    expect(histLen).toBeGreaterThan(0);
    expect(roundsLen).toBeGreaterThan(0);

    // In-place mutation of the snapshot must never leak into the live engine:
    // a shallow clone would share the same array and a fresh snapshot (s2)
    // taken after the push would observe the tampered entries.
    histA.push({ signal: "answer", payload: "tampered", atMs: 1, source: "dispatch" });
    rounds.push({
      round: 99,
      traversalCount: 99,
      nodeIds: [],
      status: NodeStatus.Completed,
      startedAt: 1,
    });

    const s2 = engine.status();
    expect(s2.signalLedger.get("A")!.history).toHaveLength(histLen);
    expect(s2.loopGroups.get("lg")!.rounds).toHaveLength(roundsLen);
    expect(s2.signalLedger.get("A")!.history).not.toBe(s1.signalLedger.get("A")!.history);
    expect(s2.loopGroups.get("lg")!.rounds).not.toBe(s1.loopGroups.get("lg")!.rounds);
  });
});

// ── Phase-3 stubs: recover() / cancel() resolve without throwing ───────────

describe("Phase-3 stubs", () => {
  it("recover() and cancel() resolve (no-op stubs)", async () => {
    const engine = createEngine(singleNodeGraph());
    engine.provision();
    await expect(engine.recover()).resolves.toBeUndefined();
    await expect(engine.cancel()).resolves.toBeUndefined();
  });
});

// ── Phase-3 cancel(): teardown of an in-progress graph ──────────────────────

describe("engine.cancel()", () => {
  it("cancels running/ready/pending nodes and completes the engine", async () => {
    const fake = new FakeDispatch();
    const engine = createEngine(linearGraph(), { dispatch: fake });
    await engine.run(); // A running, B/C pending

    await engine.cancel();

    const snap = engine.status();
    expect(snap.phase).toBe(EnginePhase.Complete);
    expect(snap.nodes.get("A")!.status).toBe(NodeStatus.Done);
    expect(snap.nodes.get("B")!.status).toBe(NodeStatus.Done);
    expect(snap.nodes.get("C")!.status).toBe(NodeStatus.Done);
    expect(snap.frontier).toEqual([]);
  });

  it("re-emits a per-node cancelled completion event and fires [GRAPH COMPLETE] once [H4]", async () => {
    const fake = new FakeDispatch();
    const completions: NodeCompletionEvent[] = [];
    let terminalFires = 0;
    const engine = createEngine(linearGraph(), {
      dispatch: fake,
      onNodeCompletion: (e) => completions.push(e),
      onGraphTerminal: () => {
        terminalFires += 1;
      },
    });
    await engine.run(); // A running, B/C pending

    await engine.cancel();

    const snap = engine.status();
    expect(snap.phase).toBe(EnginePhase.Complete);
    // Every retired node (A running, B/C pending) got exactly one `cancelled`
    // completion event through the normal completion seam — a cancel is never
    // invisible to the monitor.
    const cancelled = completions.filter((e) => e.signalType === "cancelled");
    expect(cancelled.map((e) => e.nodeId).sort()).toEqual(["A", "B", "C"]);
    expect(cancelled.every((e) => e.nodeStatus === NodeStatus.Done)).toBe(true);
    // The graph-terminal seam fired exactly once — checkTermination drove the
    // quiescent graph to complete through the standard terminal path.
    expect(terminalFires).toBe(1);
  });

  it("recover() is a no-op without a persistence store (clean first run)", async () => {
    // No stateDir → recover() loads nothing and leaves the engine untouched.
    const fake = new FakeDispatch();
    const engine = createEngine(singleNodeGraph(), { dispatch: fake });
    engine.provision();
    await engine.recover();
    const snap = engine.status();
    expect(snap.phase).toBe(EnginePhase.Idle);
    expect(snap.nodes.get("A")!.status).toBe(NodeStatus.Ready); // untouched
    expect(fake.calls).toEqual([]); // recover never dispatched
  });
});

// ── engine.dispose(): M4 subscription teardown ───────────────────────────────

describe("engine.dispose()", () => {
  it("unregisters every task-terminated subscription; the old callback no longer fires [M4]", async () => {
    const fake = new DisposableDispatch();
    const completions: NodeCompletionEvent[] = [];
    const engine = createEngine(singleNodeGraph(), {
      dispatch: fake,
      onNodeCompletion: (e) => completions.push(e),
    });
    await engine.run(); // A dispatched → exactly one onTaskTerminated subscription

    expect(fake.subs.size).toBe(1);

    engine.dispose();
    // The engine unregistered its subscription from the port...
    expect(fake.subs.size).toBe(0);
    expect(fake.removals).toEqual(["task-A"]);

    // ...so a rogue dispatch completion after dispose is never delivered: no
    // completion event fires and the node stays running.
    fake.fireIfRegistered("task-A", "completed");
    await settle();
    expect(completions).toHaveLength(0);
    expect(engine.status().nodes.get("A")!.status).toBe(NodeStatus.Running);
  });

  it("is idempotent: a second dispose is a no-op [M4]", async () => {
    const fake = new DisposableDispatch();
    const engine = createEngine(singleNodeGraph(), { dispatch: fake });
    await engine.run();
    engine.dispose();
    const removalsAfterFirst = fake.removals.length;
    expect(removalsAfterFirst).toBe(1);

    engine.dispose();
    // The engine's subscription ledger was cleared — no further unregister
    // calls are issued.
    expect(fake.removals.length).toBe(removalsAfterFirst);
  });

  it("degrades gracefully when the dispatch port lacks removeTaskTerminatedListener", async () => {
    const fake = new FakeDispatch(); // no onTaskTerminated surface at all
    const engine = createEngine(singleNodeGraph(), { dispatch: fake });
    await engine.run();
    expect(() => engine.dispose()).not.toThrow();
  });
});

// ── Public exports are reachable from the barrel ────────────────────────────

describe("public exports from 'src/graph/engine/index.ts'", () => {
  it("exposes createEngine and the EngineRuntime / EngineState types", async () => {
    // Dynamic re-import asserts the barrel loads with no circular-dependency
    // errors and that every public export resolves.
    const mod = await import("../../src/graph/engine/index.ts");
    expect(typeof mod.createEngine).toBe("function");

    const engine: EngineRuntime = createEngine(singleNodeGraph());
    const state: EngineState = engine.provision();

    // Structural reach: both type exports are usable at runtime via the factory.
    expect(state.phase).toBe(EnginePhase.Idle);
    expect(state.graphId).toBeTruthy();
  });

  it("assigns a unique graph id per instance", () => {
    const a = createEngine(singleNodeGraph());
    const b = createEngine(singleNodeGraph());
    const idA = a.provision().graphId;
    const idB = b.provision().graphId;
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);
  });
});
