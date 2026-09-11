/**
 * Live engine-graph reader tests (TUI live-state fix, subtask 1).
 *
 * Covers `readLiveEngineGraphs` (monitor-reader-engine.ts): the live in-memory
 * registry path (projecting each `GraphToolSet` registry runtime via
 * `EngineRuntime.status()` through the same `projectEngineGraph` snapshot
 * surface the disk reader uses) plus the disk-scan fallback when no live
 * toolset is registered.
 *
 * The engine is driven with an idle dispatch seam (mirroring the F2 fixture in
 * `tests/graph/graph-tools.test.ts`) so a node stays `running` after
 * `graph_run` — exactly the state a disk scan on the opencode platform can
 * never see, because there the engine never writes `engine-*.json`.
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
  getLiveGraphToolSet,
} from "../../src/graph/tools/live-state.ts";
import { readLiveEngineGraphs } from "../../src/cli/commands/monitor/monitor-reader-engine.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type {
  DispatchParentContext,
} from "../../src/graph/engine/dispatch-bridge.ts";
import type { NodeDispatchPort } from "../../src/graph/engine/engine-advance.ts";
import type { NodeRuntimeState } from "../../src/types.engine-v2.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "monitor-reader-live-engine-test-"));
});

afterEach(() => {
  clearLiveGraphToolSet();
  rmSync(tmpDir, { recursive: true, force: true });
});

function stateDir(): string {
  return join(tmpDir, ".rolebox", "state");
}

/**
 * Dispatch seam that never completes tasks — the engine stays in phase
 * `executing` with its node `running` (the F2 fixture pattern from
 * `tests/graph/graph-tools.test.ts`).
 */
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
 * A minimal, valid engine-`2` file describing a completed graph updated
 * *within* the disk reader's staleness window (see the `TERMINAL_GRAPH_STALE_MS`
 * gate in monitor-reader-engine.ts) — so via the disk path it WOULD be
 * surfaced, and only the live-registry preference can hide it.
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

function writeEngineFile(filename: string, contents: string): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(join(stateDir(), filename), contents, "utf-8");
}

describe("readLiveEngineGraphs — live registry path", () => {
  it("projects a live registry runtime with its node running when the disk store is absent", async () => {
    const { ts, graphId } = await openRunningGraph("live-absent");
    registerLiveGraphToolSet(ts);

    // Disk store intentionally never created — a platform where the engine
    // runs fully in-memory and never writes engine-*.json.
    const graphs = readLiveEngineGraphs(stateDir());

    expect(graphs).toHaveLength(1);
    const g = graphs[0];
    expect(g.graphId).toBe(graphId);
    expect(g.phase).toBe("executing");
    expect(g.nodeCount).toBe(1);
    expect(g.nodeStatusCounts.running).toBe(1);

    const node = g.nodes.find((n) => n.nodeId === "A")!;
    expect(node).toBeDefined();
    expect(node.status).toBe("running");
    expect(node.agent).toBe("agent-a");
    // A dispatched node has a real launch timestamp — surfaced as ISO.
    expect(node.startedAt).toBeDefined();
  });

  it("prefers the live registry over a stale disk engine file", async () => {
    const { ts, graphId } = await openRunningGraph("live-stale");
    registerLiveGraphToolSet(ts);

    // A stale persisted file from a previous (abandoned) run exists on disk —
    // the live registry must win, disk state is ignored. The disk file is
    // fresh enough to pass the disk reader's own staleness gate, so this is
    // purely the live-registry preference at work.
    writeEngineFile("engine-other-graph.json", JSON.stringify(engineFileFor("other-graph")));

    const graphs = readLiveEngineGraphs(stateDir());

    expect(graphs).toHaveLength(1);
    expect(graphs[0].graphId).toBe(graphId);
    expect(graphs[0].nodeStatusCounts.running).toBe(1);
    const node = graphs[0].nodes.find((n) => n.nodeId === "A")!;
    expect(node.status).toBe("running");
  });

  it("projects every registry graph (multiple live graphs)", async () => {
    const { ts, graphId: g1 } = await openRunningGraph("live-multi-a");
    const { graph_id: g2 } = ts.graph_create({ name: "live-multi-b" });
    ts.graph_add_node({ graph_id: g2, id: "B", agent: "agent-b", prompt: "pB" });
    await ts.graph_run({ graph_id: g2 });
    registerLiveGraphToolSet(ts);

    const graphs = readLiveEngineGraphs(stateDir());

    expect(graphs.map((g) => g.graphId).sort()).toEqual([g1, g2].sort());
    expect(graphs.every((g) => g.nodeStatusCounts.running === 1)).toBe(true);
  });

  it("returns an empty array when the registered toolset holds no graphs", async () => {
    registerLiveGraphToolSet(new GraphToolSet());

    const graphs = readLiveEngineGraphs(stateDir());
    expect(graphs).toEqual([]);
  });
});

describe("readLiveEngineGraphs — disk fallback", () => {
  it("delegates to the disk scan when no live toolset is registered", () => {
    expect(getLiveGraphToolSet()).toBeUndefined();
    writeEngineFile("engine-stale-graph.json", JSON.stringify(engineFileFor("stale-graph")));

    const graphs = readLiveEngineGraphs(stateDir());

    expect(graphs).toHaveLength(1);
    expect(graphs[0].graphId).toBe("stale-graph");
    expect(graphs[0].phase).toBe("complete");
  });

  it("returns an empty array on a state dir with no engine files", () => {
    mkdirSync(stateDir(), { recursive: true });
    expect(readLiveEngineGraphs(stateDir())).toEqual([]);
  });
});
