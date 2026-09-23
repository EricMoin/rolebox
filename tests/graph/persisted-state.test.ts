/**
 * The stored-graph scanner — the cross-session view over the workspace's ONE
 * graph store.
 *
 * REPLACED TEST (P1 item 5). The previous version built `engine-*.json`
 * fixtures through the retired v2 writer and asserted that the scanner hydrated
 * them. That container is no longer written, so the cases below cover the SAME
 * user capability — "a graph another session declared is visible, and a record
 * this build cannot read is skipped honestly rather than fabricated" — against
 * the store: a definition row plus a run-state row.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDeclaredOutcomeGraph, persistDeclaredGraph } from "../../src/graph/tools/declare-graph.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { graphStoreFilePath } from "../../src/graph/store/schema.ts";
import {
  OutcomeGraphRuntime,
} from "../../src/graph/outcome/runtime.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";
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

const GRAPH_ONE = "persisted.one";
const GRAPH_TWO = "persisted.two";

function declaration(name: string): GraphDeclarationV3 {
  return {
    version: 3,
    name,
    nodes: [
      { id: "A", agent: "a1", prompt: "p1", outcomes: [{ id: "done" }] },
      { id: "B", agent: "a2", prompt: "p2", outcomes: [{ id: "done" }] },
    ],
    edges: [{ from: "A", to: "B", outcome: "done" }],
  };
}

/** Declare one graph into `storeDirectory` and return its compiled plan. */
function declareGraph(
  storeDirectory: string,
  name: string,
): ReturnType<typeof buildDeclaredOutcomeGraph> {
  const graph = buildDeclaredOutcomeGraph({ declaration: declaration(name) });
  expect(persistDeclaredGraph(graph, storeDirectory)).toBe(true);
  return graph;
}

/**
 * Run one declared graph to the point the scanner has something to report:
 * `A` settled by its own accepted outcome and `B` dispatched by that
 * acceptance.
 *
 * Driven through the REAL run path over the store the scanner reads, so the
 * fixture can only produce a row the reader accepts — hand-shaping a run-state
 * body would be a second definition of the format this test is not about.
 */
async function runToSecondNode(
  storeDirectory: string,
  graph: ReturnType<typeof buildDeclaredOutcomeGraph>,
  now: number,
): Promise<void> {
  const ledger = await SqliteAcceptanceLedger.create(storeDirectory);
  try {
    const credentials = new Map<string, string>();
    const runtime = new OutcomeGraphRuntime({
      plan: graph.plan,
      ledger,
      dispatch: (request) => {
        credentials.set(request.attemptId, request.credential);
      },
      validators: createValidatorRegistry([]),
      artifactRoot: storeDirectory,
      clock: () => now,
      credentialIsolation: testHostCredentialIsolation(storeDirectory),
    });
    runtime.start(now);
    const credential = credentials.get("A#1");
    if (credential === undefined) throw new Error("fixture: no attempt for A");
    expect(
      runtime.submit({ nodeId: "A", outcomeId: "done", credential }, now + 30).kind,
    ).toBe("accepted");
  } finally {
    ledger.close();
  }
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe("stored-graph scanner", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "persisted-state-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty result for a missing store (never throws)", () => {
    const scan = scanPersistedStates(dir);
    expect(scan.count).toBe(0);
    expect(scan.loaded).toEqual([]);
    expect(scan.skipped).toBe(0);
    expect(scan.skippedGraphs).toEqual([]);
    expect(scan.blocked).toBeUndefined();
  });

  it("scans every declared graph across sessions, most recently updated first", async () => {
    const first = declareGraph(dir, GRAPH_ONE);
    await runToSecondNode(dir, first, 100);
    const second = declareGraph(dir, GRAPH_TWO);
    await runToSecondNode(dir, second, 300);

    const scan = scanPersistedStates(dir);
    expect(scan.count).toBe(2);
    expect(scan.loaded).toHaveLength(2);
    expect(scan.skipped).toBe(0);

    const summaries = scanPersistedSummaries(dir);
    expect(summaries.map((s) => s.graphId)).toEqual([GRAPH_TWO, GRAPH_ONE]);
    expect(summaries[0]!.updatedAt).toBeGreaterThan(summaries[1]!.updatedAt);
    expect(summaries.every((s) => s.nodeCount === 2)).toBe(true);
  });

  it("projects the plan's own node fields and the run's recorded position", async () => {
    const graph = declareGraph(dir, GRAPH_ONE);
    await runToSecondNode(dir, graph, 100);

    const state = scanPersistedStates(dir).loaded[0]!;
    expect(state.graphId).toBe(GRAPH_ONE);
    expect(state.phase).toBe("executing");
    // The declared per-node fields come from the STORED PLAN, not from a
    // fabricated carrier declaration.
    expect(state.nodes.get("A")?.agent).toBe("a1");
    expect(state.nodes.get("A")?.prompt).toBe("p1");
    expect(state.nodes.get("A")?.status).toBe("completed");
    expect(state.nodes.get("A")?.completedAt).toBe(130);
    expect(state.nodes.get("B")?.status).toBe("running");
  });

  it("reports a declared-but-never-started graph as idle with every node pending", () => {
    declareGraph(dir, GRAPH_ONE);
    const state = scanPersistedStates(dir).loaded[0]!;
    expect(state.phase).toBe("idle");
    expect([...state.nodes.values()].map((n) => n.status)).toEqual([
      "pending",
      "pending",
    ]);
  });

  it("names a stored definition it cannot decode instead of fabricating a graph", () => {
    // A definition row a writer OTHER than this build could have produced: the
    // row is keyed by one graph id and its declaration names another. The
    // store's shape gate accepts it (every column is well-formed); the READER
    // is what refuses it, by name.
    const graph = buildDeclaredOutcomeGraph({
      declaration: declaration(GRAPH_TWO),
    });
    const store = GraphStore.openFile(dir);
    try {
      store.writeDefinition({
        graphId: GRAPH_ONE,
        declarationDigest: graph.declarationDigest,
        planRevision: graph.plan.planRevision,
        declaration: graph.declaration,
        plan: graph.record,
        recordedAt: 1,
      });
    } finally {
      store.close();
    }

    const scan = scanPersistedStates(dir);
    expect(scan.count).toBe(1);
    expect(scan.loaded).toEqual([]);
    expect(scan.skipped).toBe(1);
    expect(scan.skippedGraphs).toEqual([GRAPH_ONE]);
  });

  it("reports an unreadable store by its verdict, never as an empty one", () => {
    // A zero-byte authoritative file is a damaged store.
    mkdirSync(dir, { recursive: true });
    writeFileSync(graphStoreFilePath(dir), "");
    const scan = scanPersistedStates(dir);
    expect(scan.count).toBe(0);
    expect(scan.loaded).toEqual([]);
    expect(scan.blocked).toBeDefined();
    expect(scan.blocked).toContain("corrupt");
  });

  it("buildPersistedSummary exposes graphId, phase, node counts and timestamps", async () => {
    const graph = declareGraph(dir, GRAPH_ONE);
    await runToSecondNode(dir, graph, 100);
    const state = scanPersistedStates(dir).loaded[0]!;
    const summary = buildPersistedSummary(state);

    expect(summary.graphId).toBe(GRAPH_ONE);
    expect(summary.phase).toBe("executing");
    expect(summary.nodeCount).toBe(2);
    expect(summary.nodeStatusCounts).toEqual({ completed: 1, running: 1 });
    expect(summary.updatedAt).toBe(130);

    const a = summary.nodes.find((n) => n.nodeId === "A")!;
    expect(a.agent).toBe("a1");
    expect(a.completedAt).toBe(130);
    const b = summary.nodes.find((n) => n.nodeId === "B")!;
    expect(b.agent).toBe("a2");
    expect(b.completedAt).toBeUndefined();
  });

  it("node / loop / budget accessors read without Map unwrapping", async () => {
    const graph = declareGraph(dir, GRAPH_ONE);
    await runToSecondNode(dir, graph, 100);
    const state = scanPersistedStates(dir).loaded[0]!;

    expect(getNode(state, "A")!.agent).toBe("a1");
    expect(getNode(state, "missing")).toBeUndefined();

    const nodes = listNodes(state);
    expect(nodes.map((n) => n.nodeId).sort()).toEqual(["A", "B"]);

    expect(getLoopGroup(state, "lg1")).toBeUndefined();
    expect(listLoopGroups(state)).toEqual([]);

    expect(getBudget(state)).toEqual({
      sessionsSpawned: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
    });
  });
});
