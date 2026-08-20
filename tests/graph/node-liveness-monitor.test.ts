/**
 * Graph Execution Engine v2 — Node liveness monitor (subtask 3 of the
 * node-anomaly-detection feature).
 *
 * Pins {@link NodeLivenessMonitor} (heartbeat-based stall detection layered
 * over the wall-clock {@link NodeStalenessWatcher}) with an injected clock:
 *   1. Continuous heartbeats keep a node `healthy` and reset an active
 *      `stalling` classification back to `healthy` — a node that is being
 *      driven is never stalled.
 *   2. Heartbeats stopping past `stallWarnMs` classify the node `stalling`,
 *      stamp `stallWarnedAt`, and fire `onStall` EXACTLY once per episode —
 *      repeated ticks inside the warning window do not re-fire, and a fresh
 *      episode (after a heartbeat returns the node to healthy) warns again.
 *   3. Reaching the grace window (`stallWarnMs + stallGraceMs`, capped by the
 *      per-node effective deadline) hard-stalls the node: the shared
 *      `markTimedOut` (running → timeout) + `onTimeout`.
 *   4. A node WITHOUT a heartbeat feed (no `liveness.lastActivityAt`) is
 *      skipped by the monitor — the unmodified wall-clock
 *      {@link NodeStalenessWatcher} remains the fallback for it.
 *   5. The per-node effective deadline (`min(budget.timeout_ms,
 *      nodeStaleTimeoutMs)`) caps the hard-stall window, and a non-positive
 *      deadline disables liveness staleness entirely.
 */

import { describe, it, expect } from "bun:test";

import { NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { NodeBudgetSpec } from "../../src/types.graph-v2.ts";
import type {
  EngineState,
  NodeLivenessState,
  NodeRuntimeState,
} from "../../src/types.engine-v2.ts";
import {
  createEngineState,
  provision,
} from "../../src/graph/engine/engine-state.ts";
import {
  NodeLivenessMonitor,
  NodeStalenessWatcher,
  type NodeLivenessMonitorOptions,
} from "../../src/graph/engine/engine-recovery.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

function singleNodeGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "single",
    nodes: [{ id: "A", agent: "a1", prompt: "p1" }],
    edges: [],
  };
}

interface Rig {
  state: EngineState;
  node: NodeRuntimeState;
}

/**
 * Provision a single-node graph with node A forced into `running`. The
 * liveness carrier / per-node budget are injected by the caller — absent
 * liveness means "no feed", which exercises the Tier-3 wall-clock fallback.
 */
function buildRunning(opts: {
  liveness?: NodeLivenessState;
  budget?: NodeBudgetSpec;
  startedAt?: number;
} = {}): Rig {
  const state = createEngineState(singleNodeGraph(), "lm");
  provision(state);
  const node = state.nodes.get("A")!;
  node.status = NodeStatus.Running;
  node.startedAt = opts.startedAt ?? 0;
  if (opts.budget) node.budget = opts.budget;
  if (opts.liveness) node.liveness = opts.liveness;
  return { state, node };
}

/** Default monitor over a 60s watcher-wide deadline (warn 30s, grace 30s). */
function defaultMonitor(
  extra: Partial<NodeLivenessMonitorOptions> = {},
): NodeLivenessMonitor {
  return new NodeLivenessMonitor({ nodeStaleTimeoutMs: 60_000, ...extra });
}

// ── Acceptance (a): continuous heartbeats never stall ───────────────────────

describe("NodeLivenessMonitor — continuous heartbeats (a)", () => {
  it("keeps a heartbeating node healthy and never fires onStall/onTimeout", () => {
    const stalls: string[] = [];
    const timeouts: string[] = [];
    const monitor = defaultMonitor({
      onStall: (id) => stalls.push(id),
      onTimeout: (id) => timeouts.push(id),
    });
    const { state, node } = buildRunning({
      liveness: { lastActivityAt: 1_000, heartbeatSource: "feed" },
    });

    // Heartbeats keep the idle time under stallWarnMs (30s).
    monitor.tick(state, 2_000); // idle 1s
    monitor.tick(state, 20_000); // idle 19s
    monitor.tick(state, 30_999); // idle 29_999 < 30_000

    expect(node.status).toBe(NodeStatus.Running);
    expect(node.liveness!.stallStatus).toBe("healthy");
    expect(node.liveness!.stallWarnedAt).toBeUndefined();
    expect(stalls).toEqual([]);
    expect(timeouts).toEqual([]);
  });

  it("resets a stalling classification back to healthy once heartbeats resume", () => {
    const stalls: string[] = [];
    const monitor = defaultMonitor({
      onStall: (id, reason) => stalls.push(`${id}:${reason}`),
    });
    const { state, node } = buildRunning({
      liveness: { lastActivityAt: 1_000, heartbeatSource: "feed" },
    });

    // Heartbeats stop — first soft stall fires the warning.
    monitor.tick(state, 31_000); // idle 30_000 ≥ warn
    expect(node.liveness!.stallStatus).toBe("stalling");
    expect(node.liveness!.stallWarnedAt).toBe(31_000);
    expect(stalls).toHaveLength(1);

    // A heartbeat arrives; the next tick classifies the node healthy again.
    node.liveness = { lastActivityAt: 35_000, heartbeatSource: "message" };
    monitor.tick(state, 36_000);
    expect(node.liveness!.stallStatus).toBe("healthy");
    expect(node.liveness!.stallWarnedAt).toBeUndefined();
    expect(node.liveness!.stallReason).toBeUndefined();
    expect(node.status).toBe(NodeStatus.Running); // never timed out

    // Heartbeats stop again — a FRESH episode warns once more.
    monitor.tick(state, 36_000 + 30_000); // idle 31_000 ≥ warn again
    expect(node.liveness!.stallStatus).toBe("stalling");
    expect(stalls).toHaveLength(2);
  });
});

// ── Acceptance (b): soft stall — single-fire warning ─────────────────────────

describe("NodeLivenessMonitor — soft stall (b)", () => {
  it("fires onStall exactly once and classifies stalling when idle ≥ stallWarnMs", () => {
    const stallIds: string[] = [];
    const monitor = defaultMonitor({ onStall: (id) => stallIds.push(id) });
    const { state, node } = buildRunning({
      liveness: { lastActivityAt: 1_000 },
    });

    monitor.tick(state, 31_000); // idle 30_000 → warn once
    expect(stallIds).toEqual(["A"]);
    expect(node.liveness!.stallStatus).toBe("stalling");
    expect(node.liveness!.stallWarnedAt).toBe(31_000);
    expect(node.status).toBe(NodeStatus.Running); // soft stall only

    // Repeated ticks inside the warn window do NOT re-fire the warning.
    monitor.tick(state, 40_000); // idle 39_000
    monitor.tick(state, 59_000); // idle 58_000 — just under warn+grace (60_000)
    expect(stallIds).toEqual(["A"]);
    expect(node.liveness!.stallStatus).toBe("stalling");
    expect(node.liveness!.stallWarnedAt).toBe(31_000); // stamped once
    expect(node.status).toBe(NodeStatus.Running);
  });

  it("defaults stallWarnMs to min(60_000, nodeStaleTimeoutMs / 2)", () => {
    // nodeStaleTimeoutMs 100_000 → default warn = min(60_000, 50_000) = 50_000.
    const r1 = buildRunning({ liveness: { lastActivityAt: 1_000 } });
    const stalls1: string[] = [];
    const m1 = new NodeLivenessMonitor({
      nodeStaleTimeoutMs: 100_000,
      onStall: (id) => stalls1.push(id),
    });
    m1.tick(r1.state, 50_999); // idle 49_999 < 50_000 → healthy
    expect(stalls1).toEqual([]);
    expect(r1.node.liveness!.stallStatus).toBe("healthy");
    m1.tick(r1.state, 51_000); // idle 50_000 → stalling
    expect(stalls1).toEqual(["A"]);
    expect(r1.node.liveness!.stallStatus).toBe("stalling");

    // nodeStaleTimeoutMs 200_000 → default warn = min(60_000, 100_000) = 60_000.
    const r2 = buildRunning({ liveness: { lastActivityAt: 1_000 } });
    const stalls2: string[] = [];
    const m2 = new NodeLivenessMonitor({
      nodeStaleTimeoutMs: 200_000,
      onStall: (id) => stalls2.push(id),
    });
    m2.tick(r2.state, 60_999); // idle 59_999 < 60_000 → healthy
    expect(stalls2).toEqual([]);
    m2.tick(r2.state, 61_000); // idle 60_000 → stalling
    expect(stalls2).toEqual(["A"]);
  });
});

// ── Acceptance (c): hard stall — markTimedOut + onTimeout ───────────────────

describe("NodeLivenessMonitor — hard stall (c)", () => {
  it("marks the node timeout and fires onTimeout once idle ≥ warn + grace", () => {
    const timeouts: Array<[string, string]> = [];
    const monitor = defaultMonitor({
      onTimeout: (id, reason) => timeouts.push([id, reason]),
    });
    const { state, node } = buildRunning({
      liveness: { lastActivityAt: 1_000 },
    });

    monitor.tick(state, 31_000); // stalling (warn)
    expect(node.status).toBe(NodeStatus.Running);

    const timedOut = monitor.tick(state, 61_000); // idle 60_000 ≥ warn+grace
    expect(timedOut).toEqual(["A"]);
    expect(node.status).toBe(NodeStatus.Timeout);
    expect(node.errorReason).toContain("liveness");
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0][0]).toBe("A");
    expect(timeouts[0][1]).toContain("liveness");
    expect(node.liveness!.stallStatus).toBe("stalled");
    expect(node.liveness!.stallReason).toContain("liveness");
  });

  it("caps the hard-stall window at the per-node effective deadline (budget wins)", () => {
    const stalls: string[] = [];
    const timeouts: string[] = [];
    const monitor = defaultMonitor({
      onStall: (id) => stalls.push(id),
      onTimeout: (id) => timeouts.push(id),
    });
    const { state, node } = buildRunning({
      liveness: { lastActivityAt: 1_000 },
      budget: { timeout_ms: 5_000 },
    });

    // effectiveDeadline = min(5_000, 60_000) = 5_000 < warn (30_000) — the
    // node hard-stalls at its declared budget without ever soft-stalling.
    expect(monitor.tick(state, 1_000 + 5_000)).toEqual(["A"]);
    expect(node.status).toBe(NodeStatus.Timeout);
    expect(node.errorReason).toContain("deadline 5000ms");
    expect(timeouts).toEqual(["A"]);
    expect(stalls).toEqual([]);
  });
});

// ── Acceptance (d): no-feed nodes keep the wall-clock fallback ───────────────

describe("NodeLivenessMonitor — no-feed fallback (d)", () => {
  it("skips a node without lastActivityAt; the wall-clock watcher still times it out", () => {
    const { state, node } = buildRunning({ startedAt: 1_000 }); // NO liveness
    const monitor = defaultMonitor({
      onStall: () => {
        throw new Error("must not warn a feed-less node");
      },
      onTimeout: () => {
        throw new Error("must not hard-stall a feed-less node");
      },
    });

    // Massive idle — the liveness monitor must not touch a node without a feed.
    expect(monitor.tick(state, 1_000 + 1_000_000)).toEqual([]);
    expect(node.status).toBe(NodeStatus.Running);
    expect(node.liveness).toBeUndefined(); // never fabricated

    // The unmodified wall-clock watcher remains the fallback (from startedAt).
    const watcher = new NodeStalenessWatcher({ nodeStaleTimeoutMs: 30_000 });
    expect(watcher.tick(state, 1_000 + 30_000)).toEqual(["A"]);
    expect(node.status).toBe(NodeStatus.Timeout);
  });
});

// ── Dispatch-liveness channel (quiet-but-alive) ──────────────────────────────

describe("NodeLivenessMonitor — dispatch-liveness channel (isDispatchAlive)", () => {
  it("keeps a silent-but-alive node healthy past the deadline and never fires onStall/onTimeout", () => {
    const stalls: string[] = [];
    const timeouts: string[] = [];
    const monitor = defaultMonitor({
      // The dispatch layer verifiably considers the task in-flight (e.g. the
      // opencode background task status "running", or the Pi child process
      // alive between JSON events).
      isDispatchAlive: () => true,
      onStall: (id) => stalls.push(id),
      onTimeout: (id) => timeouts.push(id),
    });
    const { state, node } = buildRunning({
      liveness: { lastActivityAt: 1_000, heartbeatSource: "dispatch" },
    });

    // Zero activity events: each tick past the 30s warn refreshes the
    // heartbeat via the dispatch channel instead of classifying a stall.
    monitor.tick(state, 31_000); // idle 30_000 ≥ warn → refreshed
    expect(node.status).toBe(NodeStatus.Running);
    expect(node.liveness!.stallStatus).toBe("healthy");
    expect(node.liveness!.stallWarnedAt).toBeUndefined();
    expect(node.liveness!.heartbeatSource).toBe("dispatch");

    const refreshedAt = node.liveness!.lastActivityAt!;
    monitor.tick(state, refreshedAt + 31_000); // idle 30_000 again → refreshed
    expect(node.status).toBe(NodeStatus.Running);
    expect(node.liveness!.stallStatus).toBe("healthy");
    expect(stalls).toEqual([]);
    expect(timeouts).toEqual([]);
  });

  it("does not consult the probe while heartbeats are fresh (idle < warn) — activity keeps its own source", () => {
    const probeCalls: string[] = [];
    const monitor = defaultMonitor({
      isDispatchAlive: () => {
        probeCalls.push("probe");
        return true;
      },
    });
    const { state, node } = buildRunning({
      liveness: { lastActivityAt: 1_000, heartbeatSource: "session" },
    });

    monitor.tick(state, 20_000); // idle 19s < warn 30s → healthy, no probe
    expect(node.liveness!.heartbeatSource).toBe("session");
    expect(probeCalls).toEqual([]);
  });

  it("stalls normally when the dispatch is NOT verifiably alive — the ladder still fires", () => {
    const stalls: string[] = [];
    const timeouts: string[] = [];
    const monitor = defaultMonitor({
      isDispatchAlive: () => false, // dispatch died / task orphaned
      onStall: (id) => stalls.push(id),
      onTimeout: (id) => timeouts.push(id),
    });
    const { state, node } = buildRunning({
      liveness: { lastActivityAt: 1_000 },
    });

    monitor.tick(state, 31_000); // idle 30_000 ≥ warn → stalling
    expect(node.liveness!.stallStatus).toBe("stalling");
    expect(stalls).toEqual(["A"]);
    monitor.tick(state, 61_000); // idle 60_000 ≥ warn+grace → hard stall
    expect(node.status).toBe(NodeStatus.Timeout);
    expect(node.liveness!.stallStatus).toBe("stalled");
    expect(timeouts).toEqual(["A"]);
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────────

describe("NodeLivenessMonitor — edge cases", () => {
  it("never classifies non-running nodes, even with an ancient heartbeat", () => {
    const { state, node } = buildRunning({
      liveness: { lastActivityAt: 1_000 },
    });
    node.status = NodeStatus.Ready; // provisioned default — not running
    const monitor = defaultMonitor({
      onStall: () => {
        throw new Error("must not stall a non-running node");
      },
      onTimeout: () => {
        throw new Error("must not time out a non-running node");
      },
    });
    expect(monitor.tick(state, 1_000 + 1_000_000)).toEqual([]);
    expect(node.status).toBe(NodeStatus.Ready);
  });

  it("treats a non-positive per-node deadline as liveness staleness disabled", () => {
    const { state, node } = buildRunning({
      liveness: { lastActivityAt: 1_000 },
      budget: { timeout_ms: 0 },
    });
    const monitor = defaultMonitor({
      onTimeout: () => {
        throw new Error("must not time out a disabled node");
      },
    });
    expect(monitor.tick(state, 1_000 + 1_000_000)).toEqual([]);
    expect(node.status).toBe(NodeStatus.Running);
  });

  it("treats a non-positive watcher-wide deadline as liveness staleness disabled", () => {
    const { state, node } = buildRunning({
      liveness: { lastActivityAt: 1_000 },
    });
    const monitor = new NodeLivenessMonitor({ nodeStaleTimeoutMs: 0 });
    expect(monitor.tick(state, 1_000 + 1_000_000)).toEqual([]);
    expect(node.status).toBe(NodeStatus.Running);
  });

  it("start()/stop() manage the opt-in interval without leaking timers", () => {
    const { state } = buildRunning({ liveness: { lastActivityAt: 1 } });
    const monitor = defaultMonitor({ intervalMs: 1 });
    monitor.start(state);
    monitor.stop();
    monitor.stop(); // idempotent
  });
});

// ── Enriched staleness timeout reasons (S1 — reason string only) ─────────────

describe("NodeStalenessWatcher — enriched timeout reasons (S1)", () => {
  it("appends liveness-carrier facts to the timeout reason when present", () => {
    const reasons: string[] = [];
    const watcher = new NodeStalenessWatcher({
      nodeStaleTimeoutMs: 30_000,
      onTimeout: (_id, reason) => reasons.push(reason),
    });
    const { state, node } = buildRunning({
      startedAt: 1_000,
      liveness: {
        lastActivityAt: 11_000, // idle at tick = 20_000 → "20s"
        heartbeatSource: "session",
        stallStatus: "stalling",
      },
    });

    expect(watcher.tick(state, 1_000 + 30_000)).toEqual(["A"]);
    expect(node.status).toBe(NodeStatus.Timeout);
    expect(node.errorReason).toBe(
      "node ran past its staleness timeout (30000ms); " +
        "last heartbeat 20s ago, heartbeat source=session, stall status=stalling",
    );
    // The same enriched reason is reported through the onTimeout callback.
    expect(reasons).toEqual([node.errorReason]);
  });

  it("folds the probe result into the timeout reason when it reports the task dead", () => {
    // (S2 note: a probe returning TRUE now gates the timeout away — see the
    // dispatch-liveness gate describe below — so a reason string can only
    // ever carry `dispatch task live=false`.)
    const watcher = new NodeStalenessWatcher({
      nodeStaleTimeoutMs: 900_000,
      isDispatchAlive: () => false,
    });
    const { state, node } = buildRunning({
      startedAt: 1_000,
      liveness: { lastActivityAt: 1_000 + 180_000 }, // idle at tick = 720_000 → "12m"
    });

    watcher.tick(state, 1_000 + 900_000);
    expect(node.errorReason).toBe(
      "node ran past its staleness timeout (900000ms); " +
        "dispatch task live=false, last heartbeat 12m ago",
    );
  });

  it("renders dispatch task live=false when the probe reports the task dead", () => {
    const watcher = new NodeStalenessWatcher({
      nodeStaleTimeoutMs: 30_000,
      isDispatchAlive: () => false,
    });
    const { state, node } = buildRunning({ startedAt: 1_000 });

    watcher.tick(state, 1_000 + 30_000);
    expect(node.errorReason).toContain("dispatch task live=false");
  });

  it("keeps the legacy reason byte-identical when no liveness facts or probe exist", () => {
    const watcher = new NodeStalenessWatcher({ nodeStaleTimeoutMs: 30_000 });
    const { state, node } = buildRunning({ startedAt: 1_000 }); // no liveness

    watcher.tick(state, 1_000 + 30_000);
    expect(node.errorReason).toBe("node ran past its staleness timeout (30000ms)");
  });

  it("S2 guardrail — probe absent or false keeps the wall-clock kill identical; only probe=true skips it", () => {
    const run = (isDispatchAlive?: (node: NodeRuntimeState) => boolean) => {
      const watcher = new NodeStalenessWatcher({
        nodeStaleTimeoutMs: 30_000,
        ...(isDispatchAlive ? { isDispatchAlive } : {}),
      });
      const { state, node } = buildRunning({
        startedAt: 1_000,
        liveness: { lastActivityAt: 500 },
      });
      return { timedOut: watcher.tick(state, 1_000 + 30_000), status: node.status };
    };
    const withoutProbe = run();
    const withFalseProbe = run(() => false);
    const withTrueProbe = run(() => true);
    // No-feed fallback contract: absent and false probes kill identically —
    // the wall-clock decision is byte-identical.
    expect(withFalseProbe.timedOut).toEqual(withoutProbe.timedOut);
    expect(withFalseProbe.timedOut).toEqual(["A"]);
    expect(withFalseProbe.status).toBe(withoutProbe.status);
    // Only a verifiably-live dispatch suspends the wall-clock kill (S2).
    expect(withTrueProbe.timedOut).toEqual([]);
    expect(withTrueProbe.status).toBe(NodeStatus.Running);
  });

  it("never lets a throwing probe break a tick or alter the reason base", () => {
    const watcher = new NodeStalenessWatcher({
      nodeStaleTimeoutMs: 30_000,
      isDispatchAlive: () => {
        throw new Error("probe exploded");
      },
    });
    const { state, node } = buildRunning({ startedAt: 1_000 });

    expect(() => watcher.tick(state, 1_000 + 30_000)).not.toThrow();
    expect(node.status).toBe(NodeStatus.Timeout);
    expect(node.errorReason).toBe("node ran past its staleness timeout (30000ms)");
  });
});

// ── Dispatch-liveness gate on the wall-clock watcher (S2) ────────────────────

describe("NodeStalenessWatcher — dispatch-liveness gate (S2)", () => {
  it("probe=true keeps a node alive past the 15-min deadline — liveness refreshed via the dispatch channel", () => {
    const timeouts: string[] = [];
    const watcher = new NodeStalenessWatcher({
      nodeStaleTimeoutMs: 900_000, // the 15-minute wall-clock deadline
      isDispatchAlive: () => true, // dispatch verifiably in-flight
      onTimeout: (id) => timeouts.push(id),
    });
    const { state, node } = buildRunning({
      startedAt: 1_000,
      liveness: { lastActivityAt: 1_000, heartbeatSource: "session" },
    });

    // Past the deadline — the probe gates the kill: the node stays running
    // and the heartbeat is refreshed through the dispatch channel (mirroring
    // the NodeLivenessMonitor quiet-but-alive refresh).
    const t1 = 1_000 + 900_000;
    expect(watcher.tick(state, t1)).toEqual([]);
    expect(node.status).toBe(NodeStatus.Running);
    expect(timeouts).toEqual([]);
    expect(node.liveness!.lastActivityAt).toBe(t1);
    expect(node.liveness!.heartbeatSource).toBe("dispatch");
    expect(node.liveness!.stallStatus).toBe("healthy");

    // A second tick far beyond the deadline: still alive while the probe
    // keeps verifying the task in-flight.
    const t2 = t1 + 900_000;
    expect(watcher.tick(state, t2)).toEqual([]);
    expect(node.status).toBe(NodeStatus.Running);
    expect(timeouts).toEqual([]);
    expect(node.liveness!.lastActivityAt).toBe(t2);
    expect(node.liveness!.heartbeatSource).toBe("dispatch");
  });

  it("probe=false still times the node out at the wall-clock deadline", () => {
    const timeouts: string[] = [];
    const watcher = new NodeStalenessWatcher({
      nodeStaleTimeoutMs: 30_000,
      isDispatchAlive: () => false, // dispatch died / task orphaned
      onTimeout: (id) => timeouts.push(id),
    });
    const { state, node } = buildRunning({ startedAt: 1_000 });

    expect(watcher.tick(state, 1_000 + 30_000)).toEqual(["A"]);
    expect(node.status).toBe(NodeStatus.Timeout);
    expect(timeouts).toEqual(["A"]);
    expect(node.errorReason).toContain("dispatch task live=false");
  });

  it("no-probe path is unchanged — the pure wall-clock kill still fires", () => {
    const watcher = new NodeStalenessWatcher({ nodeStaleTimeoutMs: 30_000 });
    const { state, node } = buildRunning({ startedAt: 1_000 });

    expect(watcher.tick(state, 1_000 + 30_000)).toEqual(["A"]);
    expect(node.status).toBe(NodeStatus.Timeout);
    expect(node.errorReason).toBe("node ran past its staleness timeout (30000ms)");
  });

  it("the probe-gated skip ends the moment the probe turns false — the node then times out", () => {
    let live = true;
    const watcher = new NodeStalenessWatcher({
      nodeStaleTimeoutMs: 30_000,
      isDispatchAlive: () => live,
    });
    const { state, node } = buildRunning({
      startedAt: 1_000,
      liveness: { lastActivityAt: 1_000, heartbeatSource: "dispatch" },
    });

    watcher.tick(state, 1_000 + 30_000); // probe=true → skip
    expect(node.status).toBe(NodeStatus.Running);
    expect(node.liveness!.heartbeatSource).toBe("dispatch");

    live = false; // dispatch died / task orphaned mid-flight
    expect(watcher.tick(state, 1_000 + 60_000)).toEqual(["A"]);
    expect(node.status).toBe(NodeStatus.Timeout);
    expect(node.errorReason).toContain("dispatch task live=false");
  });
});
