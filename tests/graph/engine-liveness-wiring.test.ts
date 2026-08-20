/**
 * Graph Execution Engine v2 — Liveness wiring (subtask 6 of the
 * node-anomaly-detection feature).
 *
 * Verifies the runtime-level liveness seam over the PUBLIC engine surface
 * (`createEngine` → EngineRuntime) plus the stall-option wiring:
 *
 *   a. A feed-attached engine records a `dispatch` heartbeat on launch and
 *      `recordLivenessHeartbeat(nodeId, "session")` updates a RUNNING node's
 *      liveness carrier — and is a strict no-op for a completed node (a
 *      terminal node is never revived).
 *   b. `handleFeedSessionEvent(nodeId, "gone")` escalates a running node
 *      (running → escalated, completion seam fired, escalate ledger signal
 *      recorded).
 *   c. `handleFeedSessionEvent(nodeId, "error")` with a STILL-LIVE dispatch
 *      task records a `session` heartbeat and keeps the node running
 *      (transient-error protection).
 *   d. `getNodeIdForSession(sessionId)` resolves an attached session and
 *      returns undefined after the node's terminal transition (detach).
 *   e. The stall options wire: `nodeStallWarnMs` / `nodeStallGraceMs` /
 *      `nodeStaleTimeoutMs` configure the engine's opt-in NodeLivenessMonitor,
 *      the monitor's `onStall` forwards to the `onNodeStall` seam (once per
 *      stall episode), and a hard stall funnels through the SAME timeout
 *      downstream as the wall-clock watcher (node marked `timeout` + escalate
 *      ledger signal).
 *
 * The engine-level monitor is driven by MANUAL ticks with an injected clock
 * (reached via the same cast convention the sibling monitor tests use) so no
 * wall-clock timer is ever relied upon; every engine is disposed in afterEach
 * so no interval leaks.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type {
  EngineState,
  NodeRuntimeState,
} from "../../src/types.engine-v2.ts";
import type { DispatchTask, DispatchTaskStatus } from "../../src/dispatch/types.ts";
import type {
  DispatchParentContext,
  TaskTerminatedCallback,
} from "../../src/graph/engine/dispatch-bridge.ts";
import {
  createEngine,
  type EngineRuntime,
  type NodeDispatchPort,
  type NodeLivenessFeed,
  type NodeCompletionEvent,
  type NodeStallEvent,
} from "../../src/graph/engine/index.ts";
import {
  NodeLivenessMonitor,
  NodeStalenessWatcher,
} from "../../src/graph/engine/engine-recovery.ts";

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
 * Dispatch seam that launches tasks, registers `onTaskTerminated` listeners
 * (so completions drive real signal advancement), and answers `getTask` reads
 * (so the transient-error re-check sees a still-live task).
 */
class FeedDispatch implements NodeDispatchPort {
  private seq = 0;
  private subs = new Map<string, TaskTerminatedCallback>();
  private tasks = new Map<string, DispatchTask>();

  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    const id = `task-${node.nodeId}-${++this.seq}`;
    const task = { ...makeTask(node.nodeId), id, sessionId: `sess-${id}` };
    this.tasks.set(id, task);
    return Promise.resolve(task);
  }

  onTaskTerminated(
    taskId: string,
    callback: TaskTerminatedCallback,
  ): TaskTerminatedCallback {
    this.subs.set(taskId, callback);
    return callback;
  }

  getTask(taskId: string): DispatchTask | undefined {
    return this.tasks.get(taskId);
  }

  /** Simulate the dispatch subsystem terminating a task (status + task state). */
  fire(taskId: string, status: DispatchTaskStatus): void {
    const task = this.tasks.get(taskId);
    if (task) task.status = status;
    this.subs.get(taskId)?.(taskId, status);
  }

  /**
   * Simulate the dispatch task DYING WITHOUT any terminal notification — the
   * status flips non-live but no `onTaskTerminated` listener fires, so the
   * node stays `running`. This is the abnormal state the liveness stall
   * ladder exists for (a dead/orphaned dispatch that never advanced the node).
   */
  markTaskNonLive(taskId: string, status: DispatchTaskStatus = "error"): void {
    const task = this.tasks.get(taskId);
    if (task) task.status = status;
  }
}

let taskSeq = 0;
function makeTask(nodeId: string): DispatchTask {
  taskSeq += 1;
  return {
    id: `task-${nodeId}-${taskSeq}`,
    sessionId: `sess-${nodeId}-${taskSeq}`,
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

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Single-node graph (root, no downstream). */
function singleNodeGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "single",
    nodes: [{ id: "A", agent: "a1", prompt: "p1" }],
    edges: [],
  };
}

/** Let chained setTimeout-driven task completions drain. */
const settle = () => new Promise((r) => setTimeout(r, 30));

interface Rig {
  engine: EngineRuntime;
  feed: RecordingFeed;
  dispatch: FeedDispatch;
  completions: NodeCompletionEvent[];
  stalls: NodeStallEvent[];
}

interface RigOptions {
  onNodeCompletion?: (e: NodeCompletionEvent) => void;
  onNodeStall?: (e: NodeStallEvent) => void;
  /** When set, configure the opt-in liveness monitor (stale + stall windows). */
  stall?: { stale: number; warn: number; grace: number };
  /** When false, build the engine WITHOUT a liveness feed (no-feed path). */
  withFeed?: boolean;
}

/** Build a real engine over a single-node graph with a feed + fake dispatch. */
function buildRig(opts: RigOptions = {}): Rig {
  const feed = new RecordingFeed();
  const dispatch = new FeedDispatch();
  const completions: NodeCompletionEvent[] = [];
  const stalls: NodeStallEvent[] = [];
  const engine = createEngine(singleNodeGraph(), {
    dispatch,
    ...(opts.withFeed === false ? {} : { livenessFeed: feed }),
    onNodeCompletion: opts.onNodeCompletion ?? ((e) => completions.push(e)),
    ...(opts.stall
      ? {
          nodeStaleTimeoutMs: opts.stall.stale,
          nodeStallWarnMs: opts.stall.warn,
          nodeStallGraceMs: opts.stall.grace,
          onNodeStall: opts.onNodeStall ?? ((e) => stalls.push(e)),
        }
      : {}),
  });
  rigs.push(engine);
  return { engine, feed, dispatch, completions, stalls };
}

const rigs: EngineRuntime[] = [];
afterEach(() => {
  for (const engine of rigs.splice(0)) {
    engine.dispose();
  }
});

// ── (a) dispatch heartbeat + recordLivenessHeartbeat ─────────────────────────

describe("liveness wiring — dispatch heartbeat + recordLivenessHeartbeat", () => {
  it("records a dispatch heartbeat on launch; a session heartbeat updates a running node and no-ops on completion", async () => {
    const { engine, dispatch } = buildRig();
    await engine.run();

    let node = engine.status().nodes.get("A")!;
    expect(node.status).toBe(NodeStatus.Running);
    expect(node.liveness?.heartbeatSource).toBe("dispatch");
    expect(typeof node.liveness?.lastActivityAt).toBe("number");

    const before = node.liveness!.lastActivityAt!;
    engine.recordLivenessHeartbeat("A", "session");
    node = engine.status().nodes.get("A")!;
    expect(node.liveness!.lastActivityAt!).toBeGreaterThanOrEqual(before);
    expect(node.liveness!.heartbeatSource).toBe("session");

    // Complete the node through the dispatch seam (real signal advancement).
    dispatch.fire("task-A-1", "completed");
    await settle();
    node = engine.status().nodes.get("A")!;
    expect(node.status).toBe(NodeStatus.Completed);

    const frozen = node.liveness!.lastActivityAt;
    engine.recordLivenessHeartbeat("A", "session"); // no-op — never revived
    node = engine.status().nodes.get("A")!;
    expect(node.liveness!.lastActivityAt).toBe(frozen);
  });

  it("recordLivenessHeartbeat is a no-op for an unknown node id (never throws)", async () => {
    const { engine } = buildRig();
    await engine.run();
    expect(() => engine.recordLivenessHeartbeat("NOPE", "session")).not.toThrow();
  });
});

// ── (b) session.deleted / gone → authoritative escalate ──────────────────────

describe("liveness wiring — handleFeedSessionEvent 'gone'", () => {
  it("escalates a running node: completion seam fired + escalate ledger signal", async () => {
    const { engine, completions } = buildRig();
    await engine.run();
    expect(engine.status().nodes.get("A")!.status).toBe(NodeStatus.Running);

    await engine.handleFeedSessionEvent("A", "gone");

    const state = engine.status();
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Escalate);
    // Completion seam: exactly one escalate event for the node.
    const escalateEvents = completions.filter(
      (e) => e.nodeId === "A" && e.signalType === "escalate",
    );
    expect(escalateEvents).toHaveLength(1);
    // The escalate advance recorded the ledger signal (propagation downstream).
    expect(state.signalLedger.get("A")?.signals.escalate).toBeDefined();
  });
});

// ── (c) session.error with a still-live task → transient-error protection ────

describe("liveness wiring — handleFeedSessionEvent 'error' (transient)", () => {
  it("records a session heartbeat and keeps a running node running when the dispatch task is still live", async () => {
    const { engine, dispatch } = buildRig();
    await engine.run();
    const taskId = engine.status().nodes.get("A")!.dispatchTaskId!;
    // The authoritative read shows the task still live (running).
    expect(dispatch.getTask(taskId)?.status).toBe("running");

    const before = engine.status().nodes.get("A")!.liveness!.lastActivityAt!;
    await engine.handleFeedSessionEvent("A", "error", "session errored");

    const node = engine.status().nodes.get("A")!;
    expect(node.status).toBe(NodeStatus.Running); // transient-error protection
    expect(node.liveness!.heartbeatSource).toBe("session");
    expect(node.liveness!.lastActivityAt!).toBeGreaterThanOrEqual(before);
  });
});

// ── (d) sessionId → nodeId reverse index ─────────────────────────────────────

describe("liveness wiring — getNodeIdForSession reverse index", () => {
  it("resolves an attached session and returns undefined after the node's terminal transition", async () => {
    const { engine, feed, dispatch } = buildRig();
    await engine.run();

    const sessionId = engine.status().nodes.get("A")!.dispatchSessionId!;
    expect(engine.getNodeIdForSession(sessionId)).toBe("A");
    expect(feed.attached).toContainEqual({ nodeId: "A", sessionId });
    expect(feed.detached).toEqual([]);

    // Terminal transition via the dispatch seam → detach drops the index.
    dispatch.fire("task-A-1", "completed");
    await settle();

    expect(engine.status().nodes.get("A")!.status).toBe(NodeStatus.Completed);
    expect(feed.detached).toContain("A");
    expect(engine.getNodeIdForSession(sessionId)).toBeUndefined();
    expect(engine.getNodeIdForSession("sess-unknown")).toBeUndefined();
  });
});

// ── (e) stall options wire the monitor → onNodeStall seam + timeout path ─────

describe("liveness wiring — stall options + onNodeStall seam", () => {
  it("classifies a soft stall through the onNodeStall seam once per episode and hard-stalls via the timeout downstream", async () => {
    const stalls: NodeStallEvent[] = [];
    const completions: NodeCompletionEvent[] = [];
    const { engine, dispatch } = buildRig({
      stall: { stale: 60_000, warn: 30_000, grace: 10_000 },
      onNodeStall: (e) => stalls.push(e),
      onNodeCompletion: (e) => completions.push(e),
    });
    await engine.run();

    // Reach the engine's live state + opt-in monitor (same cast convention as
    // the sibling monitor tests) so ticks mutate the live nodes.
    const liveState = (engine as unknown as { state: EngineState }).state;
    const monitor = (
      engine as unknown as { livenessMonitor?: NodeLivenessMonitor }
    ).livenessMonitor;
    expect(monitor).toBeDefined();

    const node = liveState.nodes.get("A")!;
    expect(node.status).toBe(NodeStatus.Running);
    const lastActivityAt = node.liveness!.lastActivityAt!;

    // The dispatch-liveness channel keeps a quiet-but-alive node healthy: the
    // task is still verifiably "running", so a tick past the warn threshold
    // refreshes the heartbeat instead of classifying a stall.
    monitor!.tick(liveState, lastActivityAt + 35_000);
    expect(node.status).toBe(NodeStatus.Running);
    expect(node.liveness!.stallStatus).toBe("healthy");
    expect(stalls).toHaveLength(0);

    // The dispatch DIES with no terminal notification (the abnormal state the
    // stall ladder exists for) — the probe turns false, so idle now accrues.
    dispatch.markTaskNonLive("task-A-1");

    // Soft stall: idle >= stallWarnMs (30s) → stalling + seam fires once.
    const t1 = liveState.nodes.get("A")!.liveness!.lastActivityAt!;
    monitor!.tick(liveState, t1 + 30_000);
    expect(node.liveness!.stallStatus).toBe("stalling");
    expect(node.liveness!.stallWarnedAt).toBe(t1 + 30_000);
    expect(stalls).toHaveLength(1);
    expect(stalls[0].nodeId).toBe("A");
    expect(stalls[0].stallWarnMs).toBe(30_000);
    expect(stalls[0].idleMs).toBe(30_000);

    // Single-fire per episode: a repeat tick inside the grace window does not
    // re-fire, and the node is not yet hard-stalled.
    monitor!.tick(liveState, t1 + 35_000);
    expect(stalls).toHaveLength(1);
    expect(node.status).toBe(NodeStatus.Running);

    // Hard stall: idle >= min(60s, warn+grace = 40s) → timeout through the
    // SAME onStaleNodeTimeout downstream (completion seam + escalate ledger).
    monitor!.tick(liveState, t1 + 40_000);
    await settle();
    expect(node.status).toBe(NodeStatus.Timeout);
    expect(node.liveness!.stallStatus).toBe("stalled");
    expect(node.liveness!.stallReason).toContain("liveness deadline");
    // The timeout downstream surfaced the completion seam exactly once...
    const timeoutEvents = completions.filter(
      (e) => e.nodeId === "A" && e.signalType === "timeout",
    );
    expect(timeoutEvents).toHaveLength(1);
    // ...and propagated via an escalate ledger signal (a timed-out upstream
    // must not silently stall a downstream join).
    expect(liveState.signalLedger.get("A")?.signals.escalate).toBeDefined();
  });
});

// ── (f) dispatchTaskId change → old-session heartbeats are ignored ───────────

describe("liveness wiring — dispatchTaskId change drops the old session", () => {
  it("a retry re-dispatch (new dispatchTaskId) makes the OLD session unresolvable; only the current session heartbeats", async () => {
    const { engine, feed, dispatch } = buildRig();
    await engine.run();

    // First launch: session-1 is attached and resolves to node A.
    const session1 = engine.status().nodes.get("A")!.dispatchSessionId!;
    expect(engine.getNodeIdForSession(session1)).toBe("A");
    expect(feed.attached).toContainEqual({ nodeId: "A", sessionId: session1 });

    // Complete the node: the old session is detached and drops from the index.
    dispatch.fire("task-A-1", "completed");
    await settle();
    expect(engine.status().nodes.get("A")!.status).toBe(NodeStatus.Completed);
    expect(feed.detached).toEqual(["A"]);
    expect(engine.getNodeIdForSession(session1)).toBeUndefined();

    // Retry → re-dispatch under a NEW task/session (dispatchTaskId changed).
    const report = await engine.retryNode("A");
    expect(report.reDispatched).toBe(1);
    expect(engine.status().nodes.get("A")!.status).toBe(NodeStatus.Running);
    const session2 = engine.status().nodes.get("A")!.dispatchSessionId!;
    expect(session2).not.toBe(session1);

    // The OLD session no longer resolves through the reverse index — a
    // heartbeat relayed for it finds no owning node and is dropped. Only the
    // CURRENT session resolves (so its heartbeats land).
    expect(engine.getNodeIdForSession(session1)).toBeUndefined();
    expect(engine.getNodeIdForSession(session2)).toBe("A");
    // The feed was re-attached to the new session on launch.
    expect(feed.attached).toContainEqual({ nodeId: "A", sessionId: session2 });
  });
});

// ── (g) no-feed engine: behavior byte-identical to the pre-feature engine ────

describe("liveness wiring — no feed (behavior unchanged)", () => {
  it("a feed-less engine runs the full lifecycle with no attach/detach, no reverse index, and a no-op fast path", async () => {
    const { engine, feed, dispatch } = buildRig({ withFeed: false });
    await engine.run();

    // Dispatch heartbeat is feed-gated (false-positive regression): without a
    // feed there is no observer that can ever refresh lastActivityAt, so the
    // engine records NO liveness carrier — the monitor's Tier-3 wall-clock
    // fallback (not the heartbeat path) owns feed-less staleness. Nothing was
    // handed to a feed and no session resolves through the (empty) reverse
    // index.
    let node = engine.status().nodes.get("A")!;
    expect(node.status).toBe(NodeStatus.Running);
    expect(node.liveness).toBeUndefined();
    expect(feed.attached).toEqual([]);
    expect(engine.getNodeIdForSession(node.dispatchSessionId!)).toBeUndefined();

    // The fast path is a no-op: with nothing attached, a session-gone
    // observation cannot act on the node.
    await engine.handleFeedSessionEvent("A", "gone", "late deletion");
    node = engine.status().nodes.get("A")!;
    expect(node.status).toBe(NodeStatus.Running);
    expect(node.errorReason).toBeUndefined();

    // The lifecycle still completes normally through the dispatch seam.
    dispatch.fire("task-A-1", "completed");
    await settle();
    node = engine.status().nodes.get("A")!;
    expect(node.status).toBe(NodeStatus.Completed);
    expect(feed.detached).toEqual([]);
  });

  it("with a feed the lifecycle records a dispatch heartbeat; without a feed the liveness carrier is absent", async () => {
    const runOnce = async (withFeed: boolean) => {
      const { engine, dispatch } = buildRig({ withFeed });
      await engine.run();
      dispatch.fire("task-A-1", "completed");
      await settle();
      const snap = engine.status();
      engine.dispose();
      return snap;
    };
    const withFeedSnap = await runOnce(true);
    const withoutFeedSnap = await runOnce(false);
    // Same phase and node statuses — the feed adds no lifecycle state.
    expect(withoutFeedSnap.phase).toBe(withFeedSnap.phase);
    const a = withFeedSnap.nodes.get("A")!;
    const b = withoutFeedSnap.nodes.get("A")!;
    expect(b.status).toBe(a.status);
    // The deliberate divergence (false-positive regression): a feed-wired
    // engine records the launch `dispatch` heartbeat (the liveness monitor
    // classifies its nodes); a feed-less engine records NO liveness carrier,
    // so its nodes keep the pure wall-clock staleness fallback.
    expect(a.liveness?.heartbeatSource).toBe("dispatch");
    expect(typeof a.liveness?.lastActivityAt).toBe("number");
    expect(b.liveness).toBeUndefined();
  });
});

// ── (h) False-positive regression: real session activity must keep a node ────
// alive past the stall deadline (confirmed live bug — a healthy dispatched
// subagent whose activity was never relayed as heartbeats was hard-stalled at
// ~90s and killed with escalate/timeout). The dispatch-liveness channel now
// ALSO keeps a quiet-but-alive node healthy — only a node whose dispatch is
// dead or hung is a stall candidate.

describe("liveness wiring — session activity past the stall deadline (false-positive regression)", () => {
  it("a node whose session keeps producing activity is NOT escalated or timed out; a genuinely idle node IS flagged", async () => {
    const stalls: NodeStallEvent[] = [];
    const completions: NodeCompletionEvent[] = [];
    const { engine, dispatch } = buildRig({
      // warn at 30s, hard stall at min(90s, 30+20=50s) — short enough to prove
      // activity keeps the node alive well past the deadline.
      stall: { stale: 90_000, warn: 30_000, grace: 20_000 },
      onNodeStall: (e) => stalls.push(e),
      onNodeCompletion: (e) => completions.push(e),
    });
    await engine.run();

    const liveState = (engine as unknown as { state: EngineState }).state;
    const monitor = (
      engine as unknown as { livenessMonitor?: NodeLivenessMonitor }
    ).livenessMonitor;
    expect(monitor).toBeDefined();

    const node = liveState.nodes.get("A")!;
    expect(node.status).toBe(NodeStatus.Running);

    // ── Phase 1 — the subagent works for 120s of virtual time: a session
    //    heartbeat lands every 20s (the Pi child-process activity relay fires
    //    at most once per second in production; 20s is a coarse stand-in),
    //    ticked 19s after each heartbeat (just under the 30s warn). The node
    //    must NEVER be classified stalled or timed out — this is the
    //    false-positive being fixed.
    for (let i = 0; i < 6; i++) {
      engine.recordLivenessHeartbeat("A", "session");
      const last = liveState.nodes.get("A")!.liveness!.lastActivityAt!;
      monitor!.tick(liveState, last + 19_000);
      expect(node.status).toBe(NodeStatus.Running);
      expect(node.liveness!.stallStatus).not.toBe("stalled");
    }
    expect(stalls).toHaveLength(0);
    expect(completions).toHaveLength(0);

    // ── Phase 2 — the child goes silent AND the dispatch dies without a
    //    terminal notification (the abnormal state the stall ladder exists
    //    for; a merely-quiet node would be kept healthy by the dispatch
    //    channel). Past the 30s warn the monitor warns once (stallWarnedAt
    //    stamped); past the 50s hard-stall deadline it is marked timeout and
    //    propagated via the escalate ledger.
    dispatch.markTaskNonLive("task-A-1");
    const last = liveState.nodes.get("A")!.liveness!.lastActivityAt!;
    monitor!.tick(liveState, last + 30_000);
    expect(node.liveness!.stallStatus).toBe("stalling");
    expect(node.liveness!.stallWarnedAt).toBe(last + 30_000);
    expect(stalls).toHaveLength(1);

    monitor!.tick(liveState, last + 50_000);
    await settle();
    expect(node.status).toBe(NodeStatus.Timeout);
    expect(node.liveness!.stallStatus).toBe("stalled");
    expect(node.liveness!.stallReason).toContain("liveness deadline");
    expect(liveState.signalLedger.get("A")?.signals.escalate).toBeDefined();
  });

  // ── (h2) Quiet-but-alive (dispatch channel): ZERO session activity events,
  // but the dispatch task stays verifiably in-flight for well past the
  // deadline. The node must NOT be escalated or timed out by the heartbeat
  // monitor — it is alive, just silent (a long non-streaming model call).

  it("a node with ZERO session activity but a verifiably alive dispatch is NOT escalated past the deadline and completes normally", async () => {
    const stalls: NodeStallEvent[] = [];
    const { engine, dispatch } = buildRig({
      stall: { stale: 90_000, warn: 30_000, grace: 20_000 }, // hard stall at 50s
      onNodeStall: (e) => stalls.push(e),
    });
    await engine.run();

    const liveState = (engine as unknown as { state: EngineState }).state;
    const monitor = (
      engine as unknown as { livenessMonitor?: NodeLivenessMonitor }
    ).livenessMonitor;
    const node = liveState.nodes.get("A")!;
    expect(node.status).toBe(NodeStatus.Running);

    // NO recordLivenessHeartbeat — the subagent emits zero activity events.
    // Only the dispatch-liveness channel keeps the node alive: each tick past
    // the 30s warn refreshes the heartbeat (heartbeatSource "dispatch")
    // because the task is verifiably "running". 6 ticks × 31s = 186s of
    // virtual time — far past the 50s hard-stall deadline.
    let last = node.liveness!.lastActivityAt!;
    for (let i = 0; i < 6; i++) {
      monitor!.tick(liveState, last + 31_000);
      last = liveState.nodes.get("A")!.liveness!.lastActivityAt!;
      expect(node.status).toBe(NodeStatus.Running);
      expect(node.liveness!.stallStatus).not.toBe("stalled");
      expect(node.liveness!.stallStatus).not.toBe("stalling");
    }
    expect(stalls).toHaveLength(0);
    // The dispatch channel stamped its own heartbeat source.
    expect(node.liveness!.heartbeatSource).toBe("dispatch");

    // The node completes normally through the dispatch seam once the work
    // finally finishes — never escalated.
    dispatch.fire("task-A-1", "completed");
    await settle();
    expect(node.status).toBe(NodeStatus.Completed);
  });

  // ── (h3) Dead / hung dispatch backstop: a node whose dispatch DIES with no
  // completion IS caught by the heartbeat stall ladder; a node whose dispatch
  // HANGS (stays verifiably alive but never completes) is left running by
  // BOTH monitors (S2 — the wall-clock watcher applies the same dispatch
  // probe gate as the heartbeat monitor), with the authoritative hung-kill
  // living in the dispatch watchdog. The wall-clock kill is preserved for
  // the no-feed fallback: once the dispatch task dies (probe → false), the
  // watcher times the node out.

  it("a node whose dispatch dies with no completion IS still caught; a hung-but-alive dispatch stays running past the deadline and is wall-clock timed out once its task dies", async () => {
    // Part 1 — dispatch dies silently (no terminal notification): the probe
    // turns false, so idle accrues → warn then hard-stall.
    const stalls: NodeStallEvent[] = [];
    const { engine, dispatch } = buildRig({
      stall: { stale: 90_000, warn: 30_000, grace: 20_000 },
      onNodeStall: (e) => stalls.push(e),
    });
    await engine.run();
    const liveState = (engine as unknown as { state: EngineState }).state;
    const monitor = (
      engine as unknown as { livenessMonitor?: NodeLivenessMonitor }
    ).livenessMonitor;
    const node = liveState.nodes.get("A")!;
    expect(node.status).toBe(NodeStatus.Running);

    dispatch.markTaskNonLive("task-A-1"); // died with no completion
    const t0 = node.liveness!.lastActivityAt!;
    monitor!.tick(liveState, t0 + 30_000);
    expect(node.liveness!.stallStatus).toBe("stalling");
    expect(stalls).toHaveLength(1);
    monitor!.tick(liveState, t0 + 50_000);
    await settle();
    expect(node.status).toBe(NodeStatus.Timeout);
    expect(node.liveness!.stallReason).toContain("liveness deadline");

    // Part 2 — hung-but-alive: the dispatch task stays verifiably "running"
    // forever (never completes). The heartbeat monitor must NOT stall it
    // (quiet-but-alive), and — since S2 wires the SAME dispatch-liveness
    // probe into the wall-clock watcher — the watcher must NOT time it out
    // either while the probe verifies the task in-flight: the authoritative
    // hung-kill for a verifiably-live-but-stuck task lives in the dispatch
    // watchdog (`completion-evaluator.ts` not_ready branch), not the engine's
    // watchers. The wall-clock kill is preserved for the no-feed fallback
    // (probe absent / false).
    const rig2 = buildRig({
      stall: { stale: 60_000, warn: 30_000, grace: 20_000 },
    });
    await rig2.engine.run();
    const liveState2 = (rig2.engine as unknown as { state: EngineState }).state;
    const monitor2 = (
      rig2.engine as unknown as { livenessMonitor?: NodeLivenessMonitor }
    ).livenessMonitor;
    const staleWatcher = (
      rig2.engine as unknown as { staleWatcher?: NodeStalenessWatcher }
    ).staleWatcher;
    expect(staleWatcher).toBeDefined();
    const node2 = liveState2.nodes.get("A")!;
    expect(node2.status).toBe(NodeStatus.Running);

    // Ticks well past warn (30s) — the dispatch channel keeps refreshing.
    let last2 = node2.liveness!.lastActivityAt!;
    monitor2!.tick(liveState2, last2 + 45_000);
    last2 = liveState2.nodes.get("A")!.liveness!.lastActivityAt!;
    expect(node2.status).toBe(NodeStatus.Running);
    expect(node2.liveness!.stallStatus).not.toBe("stalled");
    monitor2!.tick(liveState2, last2 + 45_000);
    expect(node2.status).toBe(NodeStatus.Running);
    expect(node2.liveness!.stallStatus).not.toBe("stalled");

    // S2: the wall-clock watcher consults the SAME dispatch probe — at its
    // staleness deadline (60s from startedAt) the task is still verifiably
    // in-flight, so the watcher SKIPS the kill (quiet-but-alive) and the
    // node stays running past its deadline instead of being timed out.
    staleWatcher!.tick(liveState2, node2.startedAt + 60_000);
    await settle();
    expect(node2.status).toBe(NodeStatus.Running);
    expect(node2.liveness!.heartbeatSource).toBe("dispatch");

    // No-feed fallback: the moment the dispatch task dies (probe → false),
    // the wall-clock watcher times the node out at its staleness deadline.
    rig2.dispatch.markTaskNonLive(node2.dispatchTaskId ?? "task-A-1");
    staleWatcher!.tick(liveState2, node2.startedAt + 60_000);
    await settle();
    expect(node2.status).toBe(NodeStatus.Timeout);
    // The wall-clock path surfaces the reason through the node's errorReason
    // (markTimedOut) — with the dead-probe fact folded in for diagnosis.
    expect(node2.errorReason).toContain("staleness timeout");
    expect(node2.errorReason).toContain("dispatch task live=false");
  });
});
