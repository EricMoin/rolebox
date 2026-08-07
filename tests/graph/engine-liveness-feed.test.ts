/**
 * Graph Execution Engine v2 — Node liveness feed (subtask 2 of the
 * node-anomaly-detection feature).
 *
 * Verifies the `NodeLivenessFeed` DI seam on {@link AdvanceEngine}:
 *   1. A successfully dispatched node records an initial `dispatch` heartbeat
 *      (`node.liveness.lastActivityAt` present, `heartbeatSource: "dispatch"`).
 *   2. `recordLivenessHeartbeat(nodeId, source)` updates a RUNNING,
 *      actually-dispatched node (lastActivityAt + heartbeatSource, non-critical
 *      dirty) and is a strict no-op for completed nodes and for nodes without
 *      a matching dispatchTaskId — a terminal node is never revived.
 *   3. `attach` / `detach` maintain the engine's `sessionId → nodeId` reverse
 *      index: attach on launch registers the session (reverse-lookupable via
 *      `getNodeIdForSession`), detach on the node's terminal transition drops
 *      it and unregisters the session from the feed.
 */

import { describe, it, expect } from "bun:test";
import { NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { NodeRuntimeState, EngineState } from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { DispatchParentContext } from "../../src/graph/engine/dispatch-bridge.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import { SignalBridge } from "../../src/graph/engine/signal-bridge.ts";
import {
  AdvanceEngine,
  type NodeDispatchPort,
  type NodeLivenessFeed,
} from "../../src/graph/engine/engine-advance.ts";

// ── Fakes ────────────────────────────────────────────────────────────────────

/** Records every attach / detach the engine hands to the feed. */
class RecordingFeed implements NodeLivenessFeed {
  attached: Array<{ nodeId: string; sessionId: string }> = [];
  detached: string[] = [];

  attach(nodeId: string, sessionId: string): void {
    this.attached.push({ nodeId, sessionId });
  }

  detach(nodeId: string): void {
    this.detached.push(nodeId);
  }
}

/** Resolves every launch with a fresh running task (sessionId known). */
class FakeDispatch implements NodeDispatchPort {
  executeNode(
    _node: NodeRuntimeState,
    _parentContext: DispatchParentContext,
  ): Promise<DispatchTask> {
    return Promise.resolve(makeTask());
  }
}

let taskSeq = 0;
function makeTask(): DispatchTask {
  taskSeq += 1;
  return {
    id: `task-${taskSeq}`,
    sessionId: `sess-${taskSeq}`,
    parentSessionId: "g-1",
    depth: 1,
    status: "running",
    agent: "a",
    prompt: "p",
    startedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 0 },
    priority: 0,
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Single-node graph (root, no downstream). */
function singleNode(id = "A", agent = "a1"): GraphDeclaration {
  return {
    version: 2,
    name: "single",
    nodes: [{ id, agent, prompt: "p1" }],
    edges: [],
  };
}

interface Rig {
  state: EngineState;
  engine: AdvanceEngine;
  feed: RecordingFeed;
}

/**
 * Build an advance engine over a single-node graph. `feed` is the recording
 * `NodeLivenessFeed` the assertions read; pass `withFeed: false` to exercise
 * the no-feed path (engine behavior unchanged).
 */
function buildEngine(
  decl: GraphDeclaration,
  opts: { withFeed?: boolean } = {},
): Rig {
  const state = createEngineState(decl, "g-1");
  provision(state);
  const bridge = new SignalBridge();
  const feed = new RecordingFeed();
  const engine = new AdvanceEngine({
    state,
    signalBridge: bridge,
    dispatch: new FakeDispatch(),
    ...(opts.withFeed === false ? {} : { livenessFeed: feed }),
  });
  return { state, engine, feed };
}

// ── Initial dispatch heartbeat ───────────────────────────────────────────────

describe("NodeLivenessFeed — initial dispatch heartbeat", () => {
  it("records liveness.lastActivityAt with heartbeatSource 'dispatch' on successful launch", async () => {
    const { state, engine } = buildEngine(singleNode("A", "a1"));

    const before = Date.now();
    await engine.dispatchReady();

    const node = state.nodes.get("A")!;
    expect(node.status).toBe(NodeStatus.Running);
    expect(node.liveness).toBeDefined();
    expect(typeof node.liveness!.lastActivityAt).toBe("number");
    expect(node.liveness!.lastActivityAt).toBeGreaterThanOrEqual(before);
    expect(node.liveness!.heartbeatSource).toBe("dispatch");
  });

  it("records the dispatch heartbeat even when no feed is wired (liveness is unconditional)", async () => {
    const { state, engine } = buildEngine(singleNode("A"), { withFeed: false });

    await engine.dispatchReady();

    const node = state.nodes.get("A")!;
    expect(node.liveness?.heartbeatSource).toBe("dispatch");
    expect(typeof node.liveness?.lastActivityAt).toBe("number");
  });
});

// ── recordLivenessHeartbeat guards ───────────────────────────────────────────

describe("recordLivenessHeartbeat", () => {
  it("updates lastActivityAt + heartbeatSource for a running, dispatched node", async () => {
    const { state, engine } = buildEngine(singleNode("A"));
    await engine.dispatchReady();

    const node = state.nodes.get("A")!;
    // Deterministic baseline: stamp a stale heartbeat, then prove the method
    // writes through (lastActivityAt strictly advances, source replaced).
    node.liveness = { lastActivityAt: 1, heartbeatSource: "dispatch" };

    engine.recordLivenessHeartbeat("A", "tool");

    expect(node.liveness!.lastActivityAt).toBeGreaterThan(1);
    expect(node.liveness!.heartbeatSource).toBe("tool");
  });

  it("is a no-op for a completed node — a terminal node is never revived", async () => {
    const { state, engine } = buildEngine(singleNode("A"));
    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("A", "answer", "result-A");

    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Completed);

    const node = state.nodes.get("A")!;
    node.liveness = { lastActivityAt: 12345, heartbeatSource: "dispatch" };
    engine.recordLivenessHeartbeat("A", "message");

    // Frozen — exactly the stale record, untouched by the heartbeat.
    expect(node.liveness).toEqual({
      lastActivityAt: 12345,
      heartbeatSource: "dispatch",
    });
  });

  it("is a no-op for a running node that was never dispatched (no dispatchTaskId)", () => {
    const { state, engine } = buildEngine(singleNode("A"));
    const node = state.nodes.get("A")!;
    // Simulate a Running status without a matching launch (dispatchTaskId
    // absent) — the guard must reject the heartbeat.
    node.status = NodeStatus.Running;
    node.liveness = { lastActivityAt: 1, heartbeatSource: "dispatch" };

    engine.recordLivenessHeartbeat("A", "session");

    expect(node.liveness).toEqual({ lastActivityAt: 1, heartbeatSource: "dispatch" });
  });

  it("is a no-op for an unknown node id (never throws)", () => {
    const { engine } = buildEngine(singleNode("A"));
    expect(() => engine.recordLivenessHeartbeat("NOPE", "tool")).not.toThrow();
  });
});

// ── attach / detach maintain the sessionId → nodeId reverse index ────────────

describe("NodeLivenessFeed — attach/detach session index", () => {
  it("attach registers the session on launch; getNodeIdForSession resolves it", async () => {
    const { state, engine, feed } = buildEngine(singleNode("A"));

    await engine.dispatchReady();

    const sessionId = state.nodes.get("A")!.dispatchSessionId!;
    // The engine handed the feed the (nodeId, sessionId) pair...
    expect(feed.attached).toEqual([{ nodeId: "A", sessionId }]);
    expect(feed.detached).toEqual([]);
    // ...and maintains its own reverse index for the feed's lookup.
    expect(engine.getNodeIdForSession(sessionId)).toBe("A");
    expect(engine.getNodeIdForSession("sess-unknown")).toBeUndefined();
  });

  it("detach on answer → completed drops the index entry and unregisters the session", async () => {
    const { state, engine, feed } = buildEngine(singleNode("A"));
    await engine.dispatchReady();
    const sessionId = state.nodes.get("A")!.dispatchSessionId!;
    expect(engine.getNodeIdForSession(sessionId)).toBe("A");

    await engine.onNodeSignalEmitted("A", "answer", "result-A");

    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Completed);
    expect(feed.detached).toEqual(["A"]);
    expect(engine.getNodeIdForSession(sessionId)).toBeUndefined();
  });

  it("detach on escalate drops the index entry too", async () => {
    const { state, engine, feed } = buildEngine(singleNode("A"));
    await engine.dispatchReady();
    const sessionId = state.nodes.get("A")!.dispatchSessionId!;
    expect(engine.getNodeIdForSession(sessionId)).toBe("A");

    await engine.onNodeSignalEmitted("A", "escalate", { reason: "boom" });

    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Escalate);
    expect(feed.detached).toEqual(["A"]);
    expect(engine.getNodeIdForSession(sessionId)).toBeUndefined();
  });

  it("maintains the index only when a feed is wired (no feed → no attach, no index)", async () => {
    const { engine, feed } = buildEngine(singleNode("A"), { withFeed: false });

    await engine.dispatchReady();

    expect(feed.attached).toEqual([]);
    expect(engine.getNodeIdForSession("sess-1")).toBeUndefined();
  });
});
