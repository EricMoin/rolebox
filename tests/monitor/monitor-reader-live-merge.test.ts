/**
 * Live-source merge tests (TUI live-state fix, subtask 6).
 *
 * The TUI refresh cycle (`src/tui/state.tsx` refresh()) reads the disk
 * snapshot via `readMonitorSnapshot`, then overlays the live in-memory graph
 * registry via `readLiveEngineGraphs` + `mergeLiveEngineGraphs` — live wins by
 * graphId, and the disk-only remainder keeps the subtask-2 stale-terminal
 * gate. These tests drive that exact chain against a real `GraphToolSet`
 * (registered as the live source) plus real `engine-*.json` files on disk.
 *
 * The engine is driven with the idle dispatch seam (F2 fixture pattern) so a
 * node stays `running` after `graph_run` — the state a disk scan on the
 * opencode platform can never see, because there the engine never writes
 * `engine-*.json`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  GraphToolSet,
  type GraphToolSetDeps,
} from "../../src/graph/tools/graph-tools.ts";
import {
  registerLiveGraphToolSet,
  clearLiveGraphToolSet,
} from "../../src/graph/tools/live-state.ts";
import {
  readLiveEngineGraphs,
  mergeLiveEngineGraphs,
} from "../../src/cli/commands/monitor/monitor-reader-engine.ts";
import { readMonitorSnapshot } from "../../src/cli/commands/monitor/monitor-reader.ts";
import { stateDirFor } from "../../src/utils/state-paths.ts";
import type { EngineGraphSnapshot } from "../../src/cli/commands/monitor/monitor-reader-types.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type {
  DispatchParentContext,
} from "../../src/graph/engine/dispatch-bridge.ts";
import type { NodeDispatchPort } from "../../src/graph/engine/engine-advance.ts";
import type { NodeRuntimeState } from "../../src/types.engine-v2.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "monitor-live-merge-test-"));
});

afterEach(() => {
  clearLiveGraphToolSet();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Dispatch seam that never completes tasks (F2 fixture — node stays running). */
class IdleDispatch implements NodeDispatchPort {
  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    return Promise.resolve({
      id: `task-${node.nodeId}`,
      sessionId: `sess-${node.nodeId}`,
      parentSessionId: "g",
      depth: 1,
      status: "running",
      agent: node.agent,
      prompt: node.prompt,
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
    });
  }
}

/** Build a toolset whose graph has one node left running after graph_run. */
async function openRunningGraph(
  name: string,
  deps?: GraphToolSetDeps,
): Promise<{ ts: GraphToolSet; graphId: string }> {
  const ts = new GraphToolSet(
    deps ?? {
      dispatch: new IdleDispatch(),
      // Opt out of the staleness watcher / sweeper — no background timers.
      nodeStaleTimeoutMs: 0,
      sweeperIntervalMs: 0,
    },
  );
  const { graph_id } = ts.graph_create({ name });
  ts.graph_add_node({ graph_id, id: "A", agent: "agent-a", prompt: "pA" });
  await ts.graph_run({ graph_id });
  return { ts, graphId: graph_id };
}

/**
 * A valid engine-`2` file describing a completed graph. `updatedAt` defaults
 * to *within* the disk reader's staleness window (surfaced by the disk scan);
 * pass an old timestamp for a stale terminal graph that both the disk reader
 * and the merge must gate out.
 */
function engineFileFor(
  graphId: string,
  updatedAt: number = Date.now() - 5_000,
): Record<string, unknown> {
  return {
    version: 2,
    graphId,
    phase: "complete",
    graphDeclaration: { version: 2, name: graphId, nodes: [], edges: [] },
    nodes: {},
    edges: {},
    loopGroups: {},
    signalLedger: {},
    frontier: [],
    budget: {
      sessionsSpawned: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
    },
    startedAt: updatedAt - 1_000,
    updatedAt,
    advancingLock: false,
    pendingCompletions: [],
  };
}

function writeEngineFile(graphId: string, contents: string): void {
  mkdirSync(stateDirFor(tmpDir), { recursive: true });
  writeFileSync(
    join(stateDirFor(tmpDir), `engine-${graphId}.json`),
    contents,
    "utf-8",
  );
}

describe("refresh-path live-source merge (subtask 6)", () => {
  it("merged snapshot contains the live running node and excludes the stale complete graph", async () => {
    const { ts, graphId: gid } = await openRunningGraph("live-merge-e2e");
    registerLiveGraphToolSet(ts);

    // A stale completed graph from an abandoned prior run sits on disk. Its
    // last update predates TERMINAL_GRAPH_STALE_MS (60s), so it must NOT
    // survive the merge — a dead persisted graph is never live activity.
    writeEngineFile("stale-graph", JSON.stringify(engineFileFor("stale-graph", Date.now() - 120_000)));

    // ── The exact refresh() chain from src/tui/state.tsx ──
    const snap = readMonitorSnapshot(tmpDir);
    const merged = mergeLiveEngineGraphs(
      snap.engineGraphs,
      readLiveEngineGraphs(stateDirFor(tmpDir)),
    );

    expect(merged).toHaveLength(1);
    const live = merged[0];
    expect(live.graphId).toBe(gid);
    expect(live.phase).toBe("executing");
    expect(live.nodeStatusCounts.running).toBe(1);
    const node = live.nodes.find((n) => n.nodeId === "A")!;
    expect(node.status).toBe("running");
    // The stale complete graph must be absent from the merged snapshot.
    expect(merged.some((g) => g.graphId === "stale-graph")).toBe(false);
  });

  it("keeps a fresh complete disk graph that the live registry does not hold", async () => {
    // No live toolset registered → live source falls back to the disk scan,
    // which merges idempotently and keeps the fresh disk graph.
    writeEngineFile("fresh-graph", JSON.stringify(engineFileFor("fresh-graph")));

    const snap = readMonitorSnapshot(tmpDir);
    const merged = mergeLiveEngineGraphs(
      snap.engineGraphs,
      readLiveEngineGraphs(stateDirFor(tmpDir)),
    );

    expect(merged.map((g) => g.graphId)).toEqual(["fresh-graph"]);
    expect(merged[0].phase).toBe("complete");
  });
});

describe("mergeLiveEngineGraphs — pure merge semantics", () => {
  function snapshot(graphId: string, phase: string, updatedAtMs: number): EngineGraphSnapshot {
    return {
      graphId,
      phase: phase as EngineGraphSnapshot["phase"],
      nodeCount: 0,
      nodeStatusCounts: {},
      nodes: [],
      budget: { sessionsSpawned: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 },
      frontier: [],
      loopGroups: [],
      startedAt: new Date(updatedAtMs - 1_000).toISOString(),
      updatedAt: new Date(updatedAtMs).toISOString(),
      updatedAtMs,
      hasCheckpoints: false,
    };
  }

  it("live wins by graphId when the same graph exists on disk", () => {
    const now = Date.now();
    const disk = snapshot("g1", "complete", now - 5_000);
    const live = {
      ...snapshot("g1", "executing", now),
      nodeStatusCounts: { running: 1 },
    };

    const merged = mergeLiveEngineGraphs([disk], [live]);

    expect(merged).toHaveLength(1);
    expect(merged[0].phase).toBe("executing");
    expect(merged[0].nodeStatusCounts.running).toBe(1);
  });

  it("gates a stale complete disk-only remainder", () => {
    const now = Date.now();
    // 120s old — beyond TERMINAL_GRAPH_STALE_MS (60s).
    const stale = snapshot("stale", "complete", now - 120_000);
    const fresh = snapshot("fresh", "complete", now - 5_000);

    const merged = mergeLiveEngineGraphs([stale, fresh], []);

    expect(merged.map((g) => g.graphId)).toEqual(["fresh"]);
  });

  it("orders live graphs first so active work is never below the fold", () => {
    const now = Date.now();
    const diskA = snapshot("disk-a", "complete", now - 5_000);
    const liveB = snapshot("live-b", "executing", now);

    const merged = mergeLiveEngineGraphs([diskA], [liveB]);

    expect(merged.map((g) => g.graphId)).toEqual(["live-b", "disk-a"]);
  });
});
