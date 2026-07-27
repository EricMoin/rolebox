import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readEngineGraphs } from "../../src/cli/commands/monitor/monitor-reader-engine.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "monitor-reader-engine-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function stateDir(): string {
  return join(tmpDir, ".rolebox", "state");
}

/** Write an engine state file directly into the state dir. */
function writeEngineFile(filename: string, contents: string): string {
  const path = join(stateDir(), filename);
  writeFileSync(path, contents, "utf-8");
  return path;
}

/**
 * Build a valid, hand-authored engine-`2` persistence file object. Mirrors the
 * serialized shape produced by `serializeEngineState` (see
 * `src/graph/engine/engine-persistence.ts`) so it round-trips through
 * `loadEngineStateFromJson`. `overrides` let tests mutate specific fields.
 */
function buildEngineFile(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 2,
    graphId: "demo-graph",
    phase: "executing",
    graphDeclaration: {
      version: 2,
      name: "demo",
      nodes: [],
      edges: [],
    },
    nodes: {
      n1: {
        nodeId: "n1",
        agent: "emperor--jinyiwei--backend",
        prompt: "build the thing",
        needsApproval: false,
        status: "running",
        signalsObserved: { answer: {} },
        sessionsSpawned: 1,
        tokensConsumed: { inputTokens: 100, outputTokens: 50, cost: 0.001 },
        upstreamResults: {},
        joinStrategy: "all",
        joinSatisfied: true,
        traversalCount: 0,
        startedAt: 1_700_000_000_000,
        retryCount: 0,
      },
      n2: {
        nodeId: "n2",
        agent: "emperor--jinyiwei--test",
        prompt: "verify it",
        needsApproval: false,
        status: "completed",
        signalsObserved: { answer: {}, revise_needed: {} },
        sessionsSpawned: 2,
        tokensConsumed: { inputTokens: 200, outputTokens: 100, cost: 0.002 },
        upstreamResults: {},
        joinStrategy: "all",
        joinSatisfied: true,
        loopGroupId: "lg1",
        traversalCount: 3,
        startedAt: 1_690_000_000_000,
        completedAt: 1_695_000_000_000,
        retryCount: 1,
      },
    },
    edges: {},
    loopGroups: {
      lg1: {
        id: "lg1",
        maxTraversals: 5,
        traversalCount: 2,
        startTimeMs: 1_690_000_000_000,
        consecutiveStale: 0,
      },
    },
    frontier: ["n3"],
    budget: {
      sessionsSpawned: 3,
      totalInputTokens: 300,
      totalOutputTokens: 150,
      totalCost: 0.003,
    },
    signalLedger: {},
    startedAt: 1_690_000_000_000,
    updatedAt: 1_700_000_000_000,
    advancingLock: false,
    pendingCompletions: [],
    checkpoints: { n1: { nodeId: "n1", status: "running", at: 1_700_000_000_000 } },
    ...overrides,
  };
}

describe("readEngineGraphs", () => {
  it("returns an empty array when no engine files exist", () => {
    mkdirSync(stateDir(), { recursive: true });
    expect(readEngineGraphs(stateDir())).toEqual([]);
  });

  it("returns an empty array when the state dir does not exist", () => {
    expect(readEngineGraphs(join(tmpDir, "missing", ".rolebox", "state"))).toEqual([]);
  });

  it("projects node-level status, signal, budget, phase, and loop data from a v2 file", () => {
    mkdirSync(stateDir(), { recursive: true });
    writeEngineFile("engine-demo-graph.json", JSON.stringify(buildEngineFile()));

    const graphs = readEngineGraphs(stateDir());
    expect(graphs).toHaveLength(1);

    const g = graphs[0];
    // Graph-level identity / phase / timing
    expect(g.graphId).toBe("demo-graph");
    expect(g.phase).toBe("executing");
    expect(g.nodeCount).toBe(2);
    expect(g.startedAt).toBe(new Date(1_690_000_000_000).toISOString());
    expect(g.updatedAt).toBe(new Date(1_700_000_000_000).toISOString());

    // Frontier
    expect(g.frontier).toEqual(["n3"]);

    // Budget
    expect(g.budget).toEqual({
      sessionsSpawned: 3,
      totalInputTokens: 300,
      totalOutputTokens: 150,
      totalCost: 0.003,
    });

    // Status counts
    expect(g.nodeStatusCounts).toEqual({ running: 1, completed: 1 });

    // Checkpoints present
    expect(g.hasCheckpoints).toBe(true);

    // Loop groups
    expect(g.loopGroups).toEqual([
      { id: "lg1", traversalCount: 2, maxTraversals: 5 },
    ]);

    // Nodes
    expect(g.nodes).toHaveLength(2);

    const n1 = g.nodes.find((n) => n.nodeId === "n1")!;
    expect(n1.agent).toBe("emperor--jinyiwei--backend");
    expect(n1.status).toBe("running");
    expect(n1.signalType).toBe("answer");
    expect(n1.startedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(n1.completedAt).toBeUndefined();
    expect(n1.retryCount).toBe(0);
    expect(n1.loopGroupId).toBeUndefined();

    const n2 = g.nodes.find((n) => n.nodeId === "n2")!;
    expect(n2.status).toBe("completed");
    // First observed signal is surfaced (insertion order of signalsObserved)
    expect(n2.signalType).toBe("answer");
    expect(n2.completedAt).toBe(new Date(1_695_000_000_000).toISOString());
    expect(n2.retryCount).toBe(1);
    expect(n2.loopGroupId).toBe("lg1");
  });

  it("flags hasCheckpoints false when the file carries no checkpoints key", () => {
    mkdirSync(stateDir(), { recursive: true });
    const file = buildEngineFile();
    delete file.checkpoints;
    writeEngineFile("engine-nocp.json", JSON.stringify(file));

    const [g] = readEngineGraphs(stateDir());
    expect(g.hasCheckpoints).toBe(false);
  });

  it("skips a corrupt file without throwing and keeps valid siblings", () => {
    mkdirSync(stateDir(), { recursive: true });
    writeEngineFile("engine-good.json", JSON.stringify(buildEngineFile()));
    writeEngineFile("engine-bad.json", "this is not valid json {{{");

    let graphs: ReturnType<typeof readEngineGraphs> = [];
    expect(() => {
      graphs = readEngineGraphs(stateDir());
    }).not.toThrow();

    expect(graphs).toHaveLength(1);
    expect(graphs[0].graphId).toBe("demo-graph");
  });

  it("skips a version-mismatched file without throwing", () => {
    mkdirSync(stateDir(), { recursive: true });
    writeEngineFile("engine-v1.json", JSON.stringify(buildEngineFile({ version: 1 })));

    let graphs: ReturnType<typeof readEngineGraphs> = [];
    expect(() => {
      graphs = readEngineGraphs(stateDir());
    }).not.toThrow();
    expect(graphs).toEqual([]);
  });

  it("projects multiple valid graphs from separate files", () => {
    mkdirSync(stateDir(), { recursive: true });
    writeEngineFile("engine-a.json", JSON.stringify(buildEngineFile({ graphId: "graph-a" })));
    writeEngineFile("engine-b.json", JSON.stringify(buildEngineFile({ graphId: "graph-b" })));

    const graphs = readEngineGraphs(stateDir());
    expect(graphs).toHaveLength(2);
    expect(graphs.map((g) => g.graphId).sort()).toEqual(["graph-a", "graph-b"]);
  });
});
