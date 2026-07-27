import { describe, it, expect } from "bun:test";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type {
  NodeRuntimeState,
  EngineState,
} from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import {
  createEngine,
  type EngineRuntime,
  type DispatchParentContext,
  type NodeDispatchPort,
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
