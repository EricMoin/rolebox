import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { EngineState } from "../../src/types.engine-v2.ts";
import { createEngineState } from "../../src/graph/engine/engine-state.ts";
import { EnginePersistence } from "../../src/graph/engine/engine-persistence.ts";
import {
  scanPersistedStates,
  scanPersistedSummaries,
  buildPersistedSummary,
  getNode,
  listNodes,
  getLoopGroup,
  listLoopGroups,
  getBudget,
} from "../../src/graph/tools/persisted-state.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

function declaration(name: string): GraphDeclaration {
  return {
    version: 2,
    name,
    nodes: [
      { id: "A", agent: "a1", prompt: "p1" },
      { id: "B", agent: "a2", prompt: "p2" },
    ],
    edges: [{ from: "A", to: "B", type: "always" }],
    loop_groups: [
      { id: "lg1", nodes: ["A", "B"], max_traversals: 3 },
    ],
  };
}

/** Build a runnable state and return it (caller mutates + persists). */
function buildState(graphId: string, name: string, startedAt: number): EngineState {
  const state = createEngineState(declaration(name), graphId);
  state.phase = EnginePhase.Executing;
  state.startedAt = startedAt;
  state.updatedAt = startedAt + 50;

  state.nodes.set("A", {
    nodeId: "A",
    agent: "a1",
    prompt: "p1",
    needsApproval: false,
    status: NodeStatus.Completed,
    signalsObserved: { answer: "done" },
    sessionsSpawned: 1,
    tokensConsumed: { inputTokens: 1, outputTokens: 1, cost: 0.01 },
    upstreamResults: new Map(),
    joinStrategy: "all",
    joinSatisfied: true,
    traversalCount: 0,
    startedAt,
    completedAt: startedAt + 30,
    retryCount: 0,
  });

  state.nodes.set("B", {
    nodeId: "B",
    agent: "a2",
    prompt: "p2",
    needsApproval: true,
    status: NodeStatus.Ready,
    signalsObserved: {},
    sessionsSpawned: 0,
    tokensConsumed: { inputTokens: 0, outputTokens: 0, cost: 0 },
    upstreamResults: new Map(),
    joinStrategy: "all",
    joinSatisfied: false,
    traversalCount: 0,
    startedAt,
    retryCount: 1,
  });

  state.loopGroups.set("lg1", {
    id: "lg1",
    maxTraversals: 3,
    traversalCount: 1,
    startTimeMs: startedAt,
    consecutiveStale: 0,
  });

  state.budget = {
    sessionsSpawned: 1,
    totalInputTokens: 1,
    totalOutputTokens: 1,
    totalCost: 0.01,
  };

  state.frontier = ["B"];

  return state;
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe("persisted-state scanner", () => {
  let dir: string;
  let store: EnginePersistence;

  /** Absolute path to the state directory under the temp workspace. */
  const stateDirFor = () => join(dir, ".rolebox", "state");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "persisted-state-"));
    store = new EnginePersistence(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty result for a missing store (never throws)", () => {
    const scan = scanPersistedStates(dir);
    expect(scan.count).toBe(0);
    expect(scan.loaded).toEqual([]);
    expect(scan.skipped).toBe(0);
    expect(scan.skippedFiles).toEqual([]);
  });

  it("scans all persisted graphs across multiple engine-*.json files", () => {
    store.save(buildState("graph-1", "g1", 100));
    store.save(buildState("graph-2", "g2", 200));
    store.save(buildState("graph-3", "g3", 300));

    const scan = scanPersistedStates(dir);
    expect(scan.count).toBe(3);
    expect(scan.loaded).toHaveLength(3);
    expect(scan.skipped).toBe(0);

    const ids = scan.loaded.map((s) => s.graphId).sort();
    expect(ids).toEqual(["graph-1", "graph-2", "graph-3"]);
  });

  it("skips corrupt-JSON and wrong-version files (not thrown, not fabricated)", () => {
    store.save(buildState("graph-ok", "gok", 100));

    // A valid read that fails hydration: corrupt JSON.
    const corrupt = join(stateDirFor(), "engine-corrupt.json");
    mkdirSync(stateDirFor(), { recursive: true });
    writeFileSync(corrupt, "{ not valid json !!");

    // A valid JSON that fails the schema-version gate.
    const oldVersion = join(stateDirFor(), "engine-old.json");
    writeFileSync(
      oldVersion,
      JSON.stringify({ version: 1, graphId: "old", phase: "idle" }),
    );

    // A valid v2 file whose filename is NOT engine-*.json must be ignored.
    const unrelated = join(stateDirFor(), "dispatch-foo.json");
    writeFileSync(unrelated, JSON.stringify({ kind: "dispatch" }));

    // An engine-*.json path that is actually a directory → read error path.
    const dirAsFile = join(stateDirFor(), "engine-not-a-file.json");
    mkdirSync(dirAsFile);

    const scan = scanPersistedStates(dir);
    // Only the valid file loads; the other three engine-*.json entries are skipped.
    expect(scan.count).toBe(4); // corrupt, old, dir-as-file, graph-ok
    expect(scan.loaded).toHaveLength(1);
    expect(scan.loaded[0]!.graphId).toBe("graph-ok");
    expect(scan.skipped).toBe(3);
    expect(scan.skippedFiles.sort()).toEqual([
      "engine-corrupt.json",
      "engine-not-a-file.json",
      "engine-old.json",
    ]);
  });

  it("buildPersistedSummary exposes graphId, phase, node counts, and timestamps", () => {
    const state = buildState("graph-1", "g1", 100);
    state.checkpoints = { A: { nodeId: "A", status: NodeStatus.Completed, at: 130 } };
    const summary = buildPersistedSummary(state);

    expect(summary.graphId).toBe("graph-1");
    expect(summary.phase).toBe(EnginePhase.Executing);
    expect(summary.nodeCount).toBe(2);
    expect(summary.nodeStatusCounts).toEqual({
      [NodeStatus.Completed]: 1,
      [NodeStatus.Ready]: 1,
    });
    expect(summary.startedAt).toBe(100);
    expect(summary.updatedAt).toBe(150);
    expect(summary.hasCheckpoints).toBe(true);
    expect(summary.frontier).toEqual(["B"]);

    // Per-node projection carries agent + status + timing.
    const a = summary.nodes.find((n) => n.nodeId === "A")!;
    expect(a.agent).toBe("a1");
    expect(a.status).toBe(NodeStatus.Completed);
    expect(a.startedAt).toBe(100);
    expect(a.completedAt).toBe(130);
    const b = summary.nodes.find((n) => n.nodeId === "B")!;
    expect(b.agent).toBe("a2");
    expect(b.status).toBe(NodeStatus.Ready);
    expect(b.retryCount).toBe(1);
    expect(b.completedAt).toBeUndefined();
  });

  it("scanPersistedSummaries returns a per-graph summary, most-recently-updated first", () => {
    store.save(buildState("graph-1", "g1", 100)); // updatedAt 150
    store.save(buildState("graph-2", "g2", 300)); // updatedAt 350

    const summaries = scanPersistedSummaries(dir);
    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.graphId)).toEqual(["graph-2", "graph-1"]);
    expect(summaries[0]!.updatedAt).toBeGreaterThan(summaries[1]!.updatedAt);
    expect(summaries.every((s) => s.nodeCount === 2)).toBe(true);
  });

  it("node / loop / budget accessors read across sessions without Map unwrapping", () => {
    store.save(buildState("graph-1", "g1", 100));
    const state = scanPersistedStates(dir).loaded[0]!;

    expect(getNode(state, "A")!.agent).toBe("a1");
    expect(getNode(state, "missing")).toBeUndefined();

    const nodes = listNodes(state);
    expect(nodes.map((n) => n.nodeId).sort()).toEqual(["A", "B"]);

    expect(getLoopGroup(state, "lg1")!.maxTraversals).toBe(3);
    expect(getLoopGroup(state, "missing")).toBeUndefined();
    expect(listLoopGroups(state).map((g) => g.id)).toEqual(["lg1"]);

    expect(getBudget(state)).toEqual({
      sessionsSpawned: 1,
      totalInputTokens: 1,
      totalOutputTokens: 1,
      totalCost: 0.01,
    });
  });

  it("never throws when the store contains an unreadable state directory", () => {
    // Point at a path that exists as a plain file, not a directory.
    const fileAsDir = join(dir, ".rolebox", "state");
    mkdirSync(join(dir, ".rolebox"), { recursive: true });
    writeFileSync(fileAsDir, "i am a file, not a directory");

    let result: ReturnType<typeof scanPersistedStates>;
    expect(() => {
      result = scanPersistedStates(dir);
    }).not.toThrow();
    // readdirSync on a file throws → clean empty result.
    expect(result!.count).toBe(0);
    expect(result!.loaded).toEqual([]);
  });
});
