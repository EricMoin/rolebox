import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import { ADVANCING_LOCK_TIMEOUT_MS } from "../../src/loop/constants.ts";
import type { EngineLockSweeper } from "../../src/graph/engine/engine-recovery.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type {
  NodeRuntimeState,
  EngineState,
} from "../../src/types.engine-v2.ts";
import type { DispatchTask, DispatchTaskStatus } from "../../src/dispatch/types.ts";
import type { TaskTerminatedCallback } from "../../src/graph/engine/dispatch-bridge.ts";
import {
  EnginePersistence,
  NON_CRITICAL_DEBOUNCE_MS,
  engineStatePath,
} from "../../src/graph/engine/engine-persistence.ts";
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
 * Dispatch seam whose `executeNode` rejects — simulates a genuine dispatch
 * failure (not the "no dispatch seam" misconfiguration stub). By default
 * EVERY dispatch rejects; when a `rejectNodeIds` set is supplied, only those
 * node ids reject and every other node dispatches successfully (mixed
 * multi-root frontier).
 */
class RejectingDispatch implements NodeDispatchPort {
  calls: { nodeId: string; agent: string; prompt: string }[] = [];

  constructor(private readonly rejectNodeIds?: Set<string>) {}

  executeNode(
    node: NodeRuntimeState,
    _parentContext: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push({ nodeId: node.nodeId, agent: node.agent, prompt: node.prompt });
    const rejects =
      this.rejectNodeIds === undefined || this.rejectNodeIds.has(node.nodeId);
    if (rejects) {
      return Promise.reject(new Error("simulated dispatch failure"));
    }
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

/**
 * Dispatch seam for the M9 listener-ledger test: records every
 * `onTaskTerminated` subscription + removal (like {@link DisposableDispatch})
 * but ALSO answers `getTask` with a verifiably-live task — so a listener fired
 * with a transient `error` re-subscribes instead of escalating, exercising the
 * engine-advance `reSubLedger` wiring end-to-end.
 */
class LiveErrorDispatch implements NodeDispatchPort {
  subs = new Map<string, TaskTerminatedCallback>();
  removals: string[] = [];

  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    return Promise.resolve(makeTask(node.nodeId));
  }

  getTask(taskId: string): DispatchTask {
    return {
      id: taskId,
      sessionId: `sess-${taskId}`,
      parentSessionId: "g-1",
      depth: 1,
      status: "running", // authoritative read: the task is still live
      agent: "a",
      prompt: "p",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
    };
  }

  onTaskTerminated(taskId: string, cb: TaskTerminatedCallback): TaskTerminatedCallback {
    this.subs.set(taskId, cb);
    return cb;
  }

  removeTaskTerminatedListener(taskId: string, _cb: TaskTerminatedCallback): void {
    this.removals.push(taskId);
    this.subs.delete(taskId);
  }

  /** Fire a dispatch termination at the currently-registered listener. */
  fire(taskId: string, status: string): void {
    this.subs.get(taskId)?.(taskId, status);
  }
}

/**
 * Dispatch seam that blocks every dispatch on an explicit `release()` — lets
 * the test observe the on-disk engine state while a node is `running` but its
 * dispatch task has NOT resolved yet (the false-completed window). The
 * `called` promise resolves from inside `executeNode`, which the engine
 * invokes AFTER its dispatch-start persistence seam — so once `called`
 * resolves, the running transition is already durably on disk.
 */
class GatedDispatch implements NodeDispatchPort {
  calls: string[] = [];
  private releaseTask!: (task: DispatchTask) => void;
  private markCalled!: () => void;
  readonly task = new Promise<DispatchTask>((r) => {
    this.releaseTask = r;
  });
  readonly called = new Promise<void>((r) => {
    this.markCalled = r;
  });

  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push(node.nodeId);
    this.markCalled();
    return this.task;
  }

  release(task: DispatchTask): void {
    this.releaseTask(task);
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
    // D3: the dead `edges` map was removed — snapshots carry no such member.
    expect("edges" in state).toBe(false);
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
    // D3: the `status()` snapshot (snapshotEngineState) carries no dead `edges`.
    expect("edges" in engine.status()).toBe(false);
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

  it("contains a dispatch failure: the affected node is terminal, never running without a dispatchTaskId", async () => {
    const rejecting = new RejectingDispatch();
    const engine = createEngine(singleNodeGraph(), { dispatch: rejecting });

    // The failure must be contained — run() resolves instead of throwing.
    await engine.run();

    const node = engine.status().nodes.get("A")!;
    expect([NodeStatus.Timeout, NodeStatus.Escalate]).toContain(node.status);
    expect(node.status).not.toBe(NodeStatus.Running);
    expect(node.dispatchTaskId).toBeUndefined();
    expect(node.errorReason).toMatch(/dispatch failed/);
  });

  it("keeps dispatching the remaining ready nodes after one node's dispatch failure", async () => {
    const rejecting = new RejectingDispatch(new Set(["R1"]));
    const graph: GraphDeclaration = {
      version: 2,
      name: "two-roots-no-downstream",
      nodes: [
        { id: "R1", agent: "a1", prompt: "r1" },
        { id: "R2", agent: "a2", prompt: "r2" },
      ],
      edges: [],
    };
    const engine = createEngine(graph, { dispatch: rejecting });

    await engine.run(); // resolves — R1's failure does not abort the pass

    // Both roots were dispatched, in frontier (declaration) order.
    expect(rejecting.calls.map((c) => c.nodeId)).toEqual(["R1", "R2"]);

    const r1 = engine.status().nodes.get("R1")!;
    const r2 = engine.status().nodes.get("R2")!;
    expect([NodeStatus.Timeout, NodeStatus.Escalate]).toContain(r1.status);
    expect(r1.dispatchTaskId).toBeUndefined();
    expect(r2.status).toBe(NodeStatus.Running);
    expect(r2.dispatchTaskId).toBeDefined();
  });

  it("auto-provisions when run() is called without an explicit provision()", async () => {
    const fake = new FakeDispatch();
    const engine = createEngine(singleNodeGraph(), { dispatch: fake });
    await engine.run(); // no prior provision() call
    expect(fake.calls.map((c) => c.nodeId)).toEqual(["A"]);
    expect(engine.status().phase).toBe(EnginePhase.Executing);
  });
});

// ── Dispatch-start write-through: disk never lags a node's running status ────

describe("engine.run() — dispatch-start write-through persistence (running window)", () => {
  it("persists status=running to engine-*.json before the dispatch task resolves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-runwin-"));
    try {
      const gate = new GatedDispatch();
      const engine = createEngine(singleNodeGraph(), {
        graphId: "g-runwin-1",
        dispatch: gate,
        stateDir: dir,
      });

      // Do NOT await run(): the dispatch blocks on the gate. `called` fires
      // from inside executeNode, which the engine invokes AFTER the
      // dispatch-start persistence seam — so once it resolves, disk already
      // holds the `running` transition while the task is still unresolved.
      const runPromise = engine.run();
      await gate.called;
      expect(gate.calls).toEqual(["A"]);

      const loaded = new EnginePersistence(dir).load("g-runwin-1");
      expect(loaded).not.toBeNull();
      // The running transition hit durable storage before task resolution —
      // the false-completed window (disk at `completed` during the dispatch
      // await) is closed.
      expect(loaded!.nodes.get("A")!.status).toBe(NodeStatus.Running);
      expect(loaded!.phase).toBe(EnginePhase.Executing);

      // Release the gate so the dispatch pass (and the engine) finish cleanly.
      gate.release(makeTask("A"));
      await runPromise;
      expect(engine.status().nodes.get("A")!.status).toBe(NodeStatus.Running);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── F2: run() starts the stale-lock sweeper on the primary path ─────────────

describe("engine.run() — stale-lock sweeper (F2)", () => {
  /** Reach into the runtime's private sweeper to read its interval state. */
  function runtimeSweeper(engine: EngineRuntime): EngineLockSweeper {
    return (engine as unknown as { sweeper: EngineLockSweeper }).sweeper;
  }

  function sweeperTimer(sweeper: EngineLockSweeper): ReturnType<typeof setInterval> | undefined {
    return (sweeper as unknown as { timer?: ReturnType<typeof setInterval> }).timer;
  }

  it("starts the lock sweeper when sweeperIntervalMs > 0; a stale lock is released", async () => {
    const fake = new FakeDispatch(); // tasks never complete → graph stays executing
    const engine = createEngine(singleNodeGraph(), {
      dispatch: fake,
      sweeperIntervalMs: 60_000,
    });
    await engine.run();

    // run() started the periodic sweep: the runtime's sweeper holds a live
    // interval bound to this engine's state.
    const sweeper = runtimeSweeper(engine);
    expect(sweeperTimer(sweeper)).toBeDefined();

    // The started sweeper actually releases a lock held past the timeout —
    // drive the same sweep() the periodic interval calls, with an injected
    // clock (first observation records; a later tick past the timeout frees).
    const state = (engine as unknown as { state: EngineState }).state;
    state.advancingLock = true;
    expect(sweeper.sweep(state, 1_000)).toBe(false); // freshly-held — not stale
    expect(sweeper.sweep(state, 1_000 + ADVANCING_LOCK_TIMEOUT_MS + 1)).toBe(true);
    expect(state.advancingLock).toBe(false);

    engine.dispose(); // stop the interval — no leaked timer
  });

  it("starts no sweeper timer when sweeperIntervalMs is absent (opt-in)", async () => {
    const fake = new FakeDispatch();
    const engine = createEngine(singleNodeGraph(), { dispatch: fake });
    await engine.run();

    // Without the option, run() never starts the periodic sweep — no interval
    // is created, so nothing can leak.
    expect(sweeperTimer(runtimeSweeper(engine))).toBeUndefined();

    engine.dispose();
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

  it("deep-clones graphDeclaration (in-place node/edge mutation does not affect the live engine) [Y4]", async () => {
    const fake = new FakeDispatch();
    const engine = createEngine(linearGraph(), { dispatch: fake });
    engine.provision();

    const s1 = engine.status();
    // The snapshot must carry its own declaration object — never the live
    // reference: identity differs between snapshots (and from the live
    // state), which a reference-shared `graphDeclaration: state.graphDeclaration`
    // would violate.
    expect(s1.graphDeclaration).not.toBe(engine.status().graphDeclaration);

    // Tamper with the snapshot's declaration in place: change a node's agent
    // and push a bogus edge. Pre-fix these would alias the live declaration.
    const origAgent = s1.graphDeclaration.nodes[0].agent;
    const origEdgeCount = s1.graphDeclaration.edges.length;
    s1.graphDeclaration.nodes[0].agent = "tampered-agent";
    s1.graphDeclaration.edges.push({ from: "GHOST", to: "C", type: "always" });

    // A fresh snapshot reads the live declaration — a shared reference would
    // observe the tampered values, so the assertions prove the live engine's
    // graphDeclaration is unchanged.
    const s2 = engine.status();
    expect(s2.graphDeclaration).not.toBe(s1.graphDeclaration);
    expect(s2.graphDeclaration.nodes[0].agent).toBe(origAgent);
    expect(s2.graphDeclaration.edges).toHaveLength(origEdgeCount);
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

  it("dispose unregisters a transient-error re-subscription — no zombie callback [M9]", async () => {
    const fake = new LiveErrorDispatch();
    const completions: NodeCompletionEvent[] = [];
    const engine = createEngine(singleNodeGraph(), {
      dispatch: fake,
      onNodeCompletion: (e) => completions.push(e),
    });
    await engine.run(); // A dispatched → one onTaskTerminated subscription
    expect(fake.subs.size).toBe(1);

    // The listener fires a transient `error`; the authoritative getTask read
    // shows the task still live → the listener re-subscribes instead of
    // escalating. The new callback must be registered in the engine's
    // subscription ledger (engine-advance `_dispatchNode` reSubLedger wiring) —
    // NOT escape it (review 04-F5).
    fake.fire("task-A", "error");
    expect(fake.subs.size).toBe(1); // replaced by the re-subscription
    expect(fake.removals).toEqual([]); // nothing removed yet
    expect(completions).toHaveLength(0); // no escalate surfaced
    expect(engine.status().nodes.get("A")!.status).toBe(NodeStatus.Running);

    // dispose unregisters BOTH the original and the re-subscribed listener.
    engine.dispose();
    expect(fake.subs.size).toBe(0);
    expect(fake.removals.length).toBe(2); // original + re-subscription
    expect(fake.removals.every((id) => id === "task-A")).toBe(true);

    // A rogue dispatch termination after dispose is never delivered — no
    // zombie callback carries a disposed engine's closures.
    fake.fire("task-A", "completed");
    await settle();
    expect(completions).toHaveLength(0);
    expect(engine.status().nodes.get("A")!.status).toBe(NodeStatus.Running);
  });
});

// ── engine.dispose() + persistence: stale-write cancellation (review 05-F1/M14) ──

describe("engine.dispose() cancels the pending debounced persistence write (M14)", () => {
  /**
   * Drive an engine into "pending debounced write armed" state: dispatch the
   * root, record a non-critical liveness heartbeat, then run an idle section
   * that routes the churn into the debounced write tier.
   */
  async function armPendingWrite(
    dir: string,
    graphId: string,
  ): Promise<EngineRuntime> {
    const engine = createEngine(singleNodeGraph(), {
      graphId,
      dispatch: new FakeDispatch(),
      stateDir: dir,
    });
    await engine.run(); // dispatch A → critical write-through lands
    engine.recordLivenessHeartbeat("A", "tool"); // isNonCriticalDirty
    await engine.run(); // idle section → schedulePersistState → debounce armed
    return engine;
  }

  it("control: WITHOUT dispose the debounced heartbeat write lands on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-dispose-persist-ctl-"));
    try {
      const engine = await armPendingWrite(dir, "g-m14-ctl");
      // Wait past the debounce window — the pending write fires on its own.
      await new Promise((r) => setTimeout(r, NON_CRITICAL_DEBOUNCE_MS + 50));
      const loaded = new EnginePersistence(dir).load("g-m14-ctl");
      expect(loaded).not.toBeNull();
      // The heartbeat liveness record landed — proving the arming path works.
      expect(loaded!.nodes.get("A")!.liveness?.heartbeatSource).toBe("tool");
      engine.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a disposed runtime's scheduled non-critical write never lands on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-dispose-persist-"));
    try {
      const engine = await armPendingWrite(dir, "g-m14-dispose");
      const path = engineStatePath(dir, "g-m14-dispose");
      expect(existsSync(path)).toBe(true); // critical write is on disk

      // Dispose the runtime — the pending debounced write must be cancelled
      // and DROPPED (never flushed over the state file).
      engine.dispose();

      // Wait past the debounce window: the heartbeat state must never land.
      await new Promise((r) => setTimeout(r, NON_CRITICAL_DEBOUNCE_MS + 50));
      const loaded = new EnginePersistence(dir).load("g-m14-dispose");
      expect(loaded).not.toBeNull();
      // The critical write is intact (node running)…
      expect(loaded!.nodes.get("A")!.status).toBe(NodeStatus.Running);
      // …but the heartbeat liveness record is NOT present — the stale
      // debounced write was cancelled by dispose (contrast with the control
      // test above, where it landed).
      expect(loaded!.nodes.get("A")!.liveness).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── recover(): non-ENOENT load failures surface explicitly (review 05-F6/L22) ──

describe("engine.recover() surfaces non-ENOENT load failures", () => {
  it("rejects with the underlying error for an unreadable (EISDIR) state path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-recover-eisdir-"));
    try {
      // A DIRECTORY at the state-file path → readFileSync fails with EISDIR
      // (the file "exists" but is unreadable). recover() must NOT silently
      // clean-start (re-provisioning completed nodes) — the non-ENOENT error
      // propagates out of recover() so the caller surfaces it explicitly.
      const path = engineStatePath(dir, "g-eisdir");
      mkdirSync(path, { recursive: true });

      const engine = createEngine(singleNodeGraph(), {
        graphId: "g-eisdir",
        dispatch: new FakeDispatch(),
        stateDir: dir,
      });
      await expect(engine.recover()).rejects.toMatchObject({ code: "EISDIR" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing state file still resolves as a clean start (ENOENT → null)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-recover-missing-"));
    try {
      // No state file at all → load() returns null (ENOENT) and recovery is a
      // clean no-op. The engine stays fresh — no state adopted, nothing
      // dispatched.
      const engine = createEngine(singleNodeGraph(), {
        graphId: "g-missing",
        dispatch: new FakeDispatch(),
        stateDir: dir,
      });
      await expect(engine.recover()).resolves.toBeUndefined();
      expect(engine.status().phase).toBe(EnginePhase.Idle);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

// ── adoptPrior: HITL dispatch termination bridges into blocked (F1 seam) ────

/**
 * Fake dispatch port that surfaces the `onTaskTerminated` seam (like the real
 * DispatchBridge) and answers `getTask` with a LIVE task — so `adoptPrior`'s
 * reconcile pass re-subscribes an adopted `running` node's task, and a later
 * dispatch termination with a HITL status is delivered through the recovery
 * emitSignal. Mirrors the HITLDispatchFake pattern from engine-advance.test.ts.
 */
class AdoptHITLDispatch implements NodeDispatchPort {
  private listeners = new Map<string, TaskTerminatedCallback>();
  executeCount = 0;
  status: DispatchTaskStatus = "running";

  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.executeCount += 1;
    return Promise.resolve({
      id: `task-${node.nodeId}`,
      sessionId: `sess-${node.nodeId}`,
      parentSessionId: "g-1",
      depth: 1,
      status: this.status,
      agent: node.agent,
      prompt: node.prompt,
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
    });
  }
  onTaskTerminated(taskId: string, callback: TaskTerminatedCallback): TaskTerminatedCallback {
    this.listeners.set(taskId, callback);
    return callback;
  }
  getTask(taskId: string): DispatchTask | undefined {
    return {
      id: taskId,
      sessionId: `sess-${taskId}`,
      parentSessionId: "g-1",
      depth: 1,
      status: this.status,
      agent: "fake",
      prompt: "fake",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
    };
  }
  /** Deliver a dispatch termination to the engine's (re-)subscribed listener. */
  fire(taskId: string, status: string): void {
    this.listeners.get(taskId)?.(taskId, status);
  }
}

/** Single declared needs_approval gate node (no downstream). */
function gateGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "gate",
    nodes: [{ id: "P", agent: "a1", prompt: "p1", needs_approval: true }],
    edges: [],
  };
}

describe("adoptPrior HITL dispatch termination (F1 bridge)", () => {
  it("transitions an adopted declared needs_approval node running → blocked when a HITL status arrives after adoption", async () => {
    const fake = new AdoptHITLDispatch();

    // Prior run: P is dispatched and still running — its task lives in the
    // SHARED dispatch seam, which survives the engine rebuild (the realistic
    // toolset flow: construction tool → adoptPrior(prior.runtime.status())).
    const priorEngine = createEngine(gateGraph(), { dispatch: fake });
    await priorEngine.run();
    expect(priorEngine.status().nodes.get("P")!.status).toBe(NodeStatus.Running);
    const prior = priorEngine.status();

    // Rebuilt engine adopts the prior progress; the reconcile pass re-subscribes
    // P's still-live task with the recovery emitSignal. run() afterwards mirrors
    // graph_run's adoptPrior → dispatchReady sequence (idle → executing).
    let terminalFires = 0;
    const engine = createEngine(gateGraph(), {
      dispatch: fake,
      onGraphTerminal: () => {
        terminalFires += 1;
      },
    });
    await engine.adoptPrior(prior);
    await engine.run();

    // Adoption preserved the running node — it was NOT re-dispatched.
    expect(engine.status().nodes.get("P")!.status).toBe(NodeStatus.Running);
    expect(fake.executeCount).toBe(1); // only the prior run dispatched
    priorEngine.dispose();

    // A HITL status (need_approval) arriving AFTER adoption must drive the
    // adopted node running → blocked via the F1 bridge — not be
    // recorded-and-dropped by signalBridge.record (a pausing signal fires no
    // terminating-signal listeners).
    fake.fire("task-P", "need_approval");
    await settle();

    const snap = engine.status();
    expect(snap.nodes.get("P")!.status).toBe(NodeStatus.Blocked);
    expect(snap.nodes.get("P")!.signalsObserved["need_approval"]).toEqual({
      hitl: "need_approval",
      taskId: "task-P",
    });
    // Quiescent-blocked (no running/ready nodes, one blocked gate) → the
    // blocked terminal event fires; the graph keeps executing, waiting on the
    // human's approve/reject.
    expect(terminalFires).toBe(1);
    expect(snap.phase).toBe(EnginePhase.Executing);
  });
});
