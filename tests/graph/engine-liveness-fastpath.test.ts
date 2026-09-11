/**
 * Graph Execution Engine v2 — Liveness fast-path (subtask 4 of the
 * node-anomaly-detection feature).
 *
 * Verifies {@link AdvanceEngine.handleFeedSessionEvent} — the immediate-failure
 * fast path for session-level failure observations relayed by the platform
 * liveness feed:
 *   (a) `gone` (session.deleted) is AUTHORITATIVE — a running node escalates
 *       immediately through the standard escalate advance, and the downstream
 *       fan-in join receives the escalate as an upstream result without
 *       blocking graph advancement;
 *   (b) `error` (session.error) with a STILL-LIVE dispatch task is transient —
 *       the node keeps running and only a `session` heartbeat is recorded
 *       (guardedMarkError parity);
 *   (c) `error` with a genuinely NOT-live dispatch task escalates like `gone`;
 *   (d) every guard is a strict no-op — non-running nodes, unattached sessions
 *       (no feed wired / never launched), and unknown node ids are untouched.
 *
 * Also covers the index.ts wiring point: `EngineRuntime.handleFeedSessionEvent`
 * forwards into the advance engine with the same downstream discipline as the
 * staleness-timeout handler.
 */

import { describe, it, expect } from "bun:test";
import { JoinStrategy, NodeStatus } from "../../src/constants.ts";
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
import { createEngine, type EngineRuntime } from "../../src/graph/engine/index.ts";

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

/**
 * Resolves every launch with a fresh running task and tracks the tasks so
 * `getTask` (the transient-error re-check surface) can report a configurable
 * per-task status. Tests mutate the tracked task's status (or delete it) to
 * flip `isDispatchTaskLive` between its live and terminal verdicts.
 */
class FakeDispatch implements NodeDispatchPort {
  readonly tasks = new Map<string, DispatchTask>();

  executeNode(
    _node: NodeRuntimeState,
    _parentContext: DispatchParentContext,
  ): Promise<DispatchTask> {
    const task = makeTask();
    this.tasks.set(task.id, task);
    return Promise.resolve(task);
  }

  getTask(taskId: string): DispatchTask | undefined {
    return this.tasks.get(taskId);
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

/**
 * A → J ← B: a fan-in convergence join with the "any" strategy. J absorbs a
 * single upstream failure (waiting for the other branch) instead of being
 * blocked by it — the shape that proves the abnormal node does not stall the
 * graph.
 */
function fanInAny(): GraphDeclaration {
  return {
    version: 2,
    name: "fanin-any",
    nodes: [
      { id: "A", agent: "a1", prompt: "p1" },
      { id: "B", agent: "a2", prompt: "p2" },
      { id: "J", agent: "j1", prompt: "join", join: { strategy: JoinStrategy.Any } },
    ],
    edges: [
      { type: "always", from: "A", to: "J" },
      { type: "always", from: "B", to: "J" },
    ],
  };
}

interface Rig {
  state: EngineState;
  engine: AdvanceEngine;
  feed: RecordingFeed;
  dispatch: FakeDispatch;
}

/**
 * Build an advance engine over the given graph. `feed` is the recording
 * `NodeLivenessFeed` the assertions read; pass `withFeed: false` to exercise
 * the no-feed path (the fast path must be a no-op — nothing was attached).
 */
function buildEngine(
  decl: GraphDeclaration,
  opts: { withFeed?: boolean } = {},
): Rig {
  const state = createEngineState(decl, "g-1");
  provision(state);
  const bridge = new SignalBridge();
  const feed = new RecordingFeed();
  const dispatch = new FakeDispatch();
  const engine = new AdvanceEngine({
    state,
    signalBridge: bridge,
    dispatch,
    ...(opts.withFeed === false ? {} : { livenessFeed: feed }),
  });
  return { state, engine, feed, dispatch };
}

// ── (a) gone — authoritative immediate escalate ─────────────────────────────

describe("handleFeedSessionEvent — gone (session.deleted is authoritative)", () => {
  it("escalates a running node immediately and the downstream join receives the escalate without blocking", async () => {
    const { state, engine, feed } = buildEngine(fanInAny());
    await engine.dispatchReady();
    const a = state.nodes.get("A")!;
    expect(a.status).toBe(NodeStatus.Running);

    await engine.handleFeedSessionEvent("A", "gone", "session deleted");

    // The node escalated immediately (no dispatch re-check for `gone`).
    expect(a.status).toBe(NodeStatus.Escalate);
    expect(a.errorReason).toBe("session deleted");
    // The session was detached from the feed + the reverse index dropped.
    expect(feed.detached).toContain("A");
    expect(engine.getNodeIdForSession(a.dispatchSessionId!)).toBeUndefined();

    // The downstream fan-in join RECEIVED the escalate as an upstream result
    // and is NOT blocked: the "any" join absorbed the partial failure and keeps
    // waiting for the still-live B branch.
    const j = state.nodes.get("J")!;
    expect(j.upstreamResults.get("A")?.fromSignal).toBe("escalate");
    expect(j.status).toBe(NodeStatus.Pending);

    // Graph advancement is not blocked by the abnormal node: B still answers,
    // the join activates, and J runs.
    await engine.onNodeSignalEmitted("B", "answer", "result-B");
    expect(j.status).toBe(NodeStatus.Running);
  });

  it("does not require a dispatch re-check — a vanished task with no getTask port still escalates", async () => {
    // A bare dispatch port WITHOUT `getTask` (like the subtask-2 fake): the
    // authoritative `gone` signal must not depend on the re-check surface.
    const state = createEngineState(singleNode("A"), "g-1");
    provision(state);
    const engine = new AdvanceEngine({
      state,
      signalBridge: new SignalBridge(),
      dispatch: {
        executeNode(): Promise<DispatchTask> {
          return Promise.resolve(makeTask());
        },
      },
      livenessFeed: new RecordingFeed(),
    });
    await engine.dispatchReady();
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);

    await engine.handleFeedSessionEvent("A", "gone", "vanished");

    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("A")!.errorReason).toBe("vanished");
  });
});

// ── (b) error + still-live task — transient-error protection ────────────────

describe("handleFeedSessionEvent — error with a still-live task (transient)", () => {
  it("keeps the node running and records a session heartbeat when the dispatch task is still live", async () => {
    const { state, engine } = buildEngine(singleNode("A"));
    await engine.dispatchReady();
    const a = state.nodes.get("A")!;
    expect(a.status).toBe(NodeStatus.Running);
    // The fake's task status is "running" → isDispatchTaskLive is true.

    // Deterministic baseline: stale heartbeat, then prove the observation
    // writes a fresh `session` heartbeat through.
    a.liveness = { lastActivityAt: 1, heartbeatSource: "dispatch" };

    await engine.handleFeedSessionEvent("A", "error", "transient blip");

    // The node stays running — the transient error must never latch it.
    expect(a.status).toBe(NodeStatus.Running);
    expect(a.liveness!.lastActivityAt).toBeGreaterThan(1);
    expect(a.liveness!.heartbeatSource).toBe("session");
    // No escalate signal was recorded and nothing was detached.
    expect(a.signalsObserved["escalate"]).toBeUndefined();
    expect(a.errorReason).toBeUndefined();
  });
});

// ── (c) error + not-live task — escalate like gone ──────────────────────────

describe("handleFeedSessionEvent — error with a dead task (genuine failure)", () => {
  it("escalates when the dispatch task reached a terminal status", async () => {
    const { state, engine, dispatch } = buildEngine(singleNode("A"));
    await engine.dispatchReady();
    const a = state.nodes.get("A")!;
    // The dispatch task terminated (error) — the session error is genuine.
    dispatch.tasks.get(a.dispatchTaskId!)!.status = "error";

    await engine.handleFeedSessionEvent("A", "error", "genuine failure");

    expect(a.status).toBe(NodeStatus.Escalate);
    expect(a.errorReason).toBe("genuine failure");
  });

  it("escalates when the dispatch task vanished entirely (conservative not-live default)", async () => {
    const { state, engine, dispatch } = buildEngine(singleNode("A"));
    await engine.dispatchReady();
    const a = state.nodes.get("A")!;
    // The task is gone from the dispatch system — getTask returns undefined,
    // which isDispatchTaskLive resolves to NOT live.
    dispatch.tasks.delete(a.dispatchTaskId!);

    await engine.handleFeedSessionEvent("A", "error", "task vanished");

    expect(a.status).toBe(NodeStatus.Escalate);
    expect(a.errorReason).toBe("task vanished");
  });
});

// ── (d) guards — strict no-ops ───────────────────────────────────────────────

describe("handleFeedSessionEvent — guards (strict no-ops)", () => {
  it("is a no-op for a completed node — a terminal node is never revived or re-advanced", async () => {
    const { state, engine } = buildEngine(singleNode("A"));
    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("A", "answer", "result-A");
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Completed);

    await engine.handleFeedSessionEvent("A", "gone", "late deletion");

    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Completed);
    expect(state.nodes.get("A")!.errorReason).toBeUndefined();
  });

  it("is a no-op for a node that was never launched (no attached session)", async () => {
    const { state, engine } = buildEngine(singleNode("A"));
    const a = state.nodes.get("A")!;
    // Ready, never dispatched — no dispatchSessionId, nothing attached.
    expect(a.status).toBe(NodeStatus.Ready);

    await engine.handleFeedSessionEvent("A", "gone", "gone");

    expect(a.status).toBe(NodeStatus.Ready);
    expect(a.errorReason).toBeUndefined();
  });

  it("is a no-op when no liveness feed is wired (nothing was attached)", async () => {
    const { state, engine } = buildEngine(singleNode("A"), { withFeed: false });
    await engine.dispatchReady();
    const a = state.nodes.get("A")!;
    expect(a.status).toBe(NodeStatus.Running);

    await engine.handleFeedSessionEvent("A", "gone", "gone");

    // Untouched — the engine without a feed never attaches, so the fast path
    // cannot act on the observation.
    expect(a.status).toBe(NodeStatus.Running);
    expect(a.errorReason).toBeUndefined();
  });

  it("is a no-op for an unknown node id (never throws)", async () => {
    const { engine } = buildEngine(singleNode("A"));
    await expect(
      engine.handleFeedSessionEvent("NOPE", "gone", "x"),
    ).resolves.toBeUndefined();
  });
});

// ── index.ts wiring point ────────────────────────────────────────────────────

describe("EngineRuntime wiring — handleFeedSessionEvent (index.ts)", () => {
  it("forwards feed session observations to the advance engine fast path", async () => {
    const feed = new RecordingFeed();
    const engine: EngineRuntime = createEngine(singleNode("A"), {
      dispatch: new FakeDispatch(),
      graphId: "g-fp",
      livenessFeed: feed,
    });
    await engine.run();

    const before = engine.status().nodes.get("A")!;
    expect(before.status).toBe(NodeStatus.Running);
    // The feed seam was wired through createEngine: attach happened on launch.
    expect(feed.attached.length).toBe(1);

    await engine.handleFeedSessionEvent("A", "gone", "session deleted");

    const after = engine.status().nodes.get("A")!;
    expect(after.status).toBe(NodeStatus.Escalate);
    expect(after.errorReason).toBe("session deleted");
    // The runtime relay never rejects — the contained advance resolves.
    await expect(
      engine.handleFeedSessionEvent("NOPE", "gone", "x"),
    ).resolves.toBeUndefined();
  });
});
