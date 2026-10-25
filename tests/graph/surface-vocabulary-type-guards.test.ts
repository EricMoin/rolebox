
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auditGraphStore,
  type DrainAuditBlockerCode,
  type DrainAuditControl,
  type DrainAuditEntry,
  type DrainAuditEntryBlockerCode,
  type DrainAuditReport,
  type DrainAuditStop,
} from "../../src/graph/audit/drain-audit.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { ZERO_BUDGET_USAGE, type BudgetReport } from "../../src/graph/domain/budget.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import type { ControlCommandName } from "../../src/graph/ledger/types.ts";
import { OutcomeGraphRuntime } from "../../src/graph/outcome/runtime.ts";
import type {
  OutcomeGraphPhase,
  OutcomeNodeStatus,
  OutcomeStopReason,
} from "../../src/graph/outcome/state-model.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { engineStateDir } from "../../src/graph/persistence/paths.ts";
import type {
  GraphNodeView,
  GraphQueryResult,
  GraphView,
} from "../../src/graph/query/graph-query.ts";
import { renderGraphQuery, type GraphStatusArgs } from "../../src/graph/query/render.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import {
  buildDeclaredOutcomeGraph,
  persistDeclaredGraph,
} from "../../src/graph/tools/declare-graph.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";
import { removeTempTrees } from "./helpers/temp-dirs.ts";

// ── F-27 / F-15: the closed vocabularies ────────────────────────────────────

describe("surface vocabularies — the closed unions own the report fields", () => {
  it("types the four fields with their union, not a bare string", () => {
    expectTypeOf<DrainAuditStop["reason"]>().toEqualTypeOf<OutcomeStopReason>();
    expectTypeOf<DrainAuditControl["command"]>().toEqualTypeOf<ControlCommandName>();
    expectTypeOf<DrainAuditEntry["phase"]>().toEqualTypeOf<OutcomeGraphPhase | undefined>();
    expectTypeOf<GraphStatusArgs["status"]>().toEqualTypeOf<OutcomeNodeStatus | undefined>();

    // CLOSED, not merely narrow: `string extends the field` is the widening a
    // bare `string` would make true, so this pin fails the day one comes back.
    type StatusIsNotAnyString = string extends NonNullable<GraphStatusArgs["status"]>
      ? never
      : true;
    expectTypeOf<StatusIsNotAnyString>().toEqualTypeOf<true>();
    type StopReasonIsNotAnyString = string extends DrainAuditStop["reason"] ? never : true;
    expectTypeOf<StopReasonIsNotAnyString>().toEqualTypeOf<true>();
    type ControlCommandIsNotAnyString = string extends DrainAuditControl["command"]
      ? never
      : true;
    expectTypeOf<ControlCommandIsNotAnyString>().toEqualTypeOf<true>();
    type PhaseIsNotAnyString = string extends NonNullable<DrainAuditEntry["phase"]>
      ? never
      : true;
    expectTypeOf<PhaseIsNotAnyString>().toEqualTypeOf<true>();
  });

  it("keeps the entry-level blocker vocabulary the per-entry subset", () => {
    expectTypeOf<DrainAuditEntryBlockerCode>().toEqualTypeOf<
      Exclude<
        DrainAuditBlockerCode,
        "state-store-unreadable" | "retired-state-record" | "corrupt-record" | "unsupported-version"
      >
    >();
    // The store-level codes are NOT members of the entry vocabulary, so a
    // per-entry projection cannot place one.
    type StoreLevelInEntryVocabulary = Extract<
      DrainAuditEntryBlockerCode,
      "state-store-unreadable" | "retired-state-record" | "corrupt-record" | "unsupported-version"
    >;
    expectTypeOf<StoreLevelInEntryVocabulary>().toEqualTypeOf<never>();
  });
});

// ── F-15: a damaged entry is classified, never degraded ─────────────────────

const AUDIT_NOW = 1_700_000_000_000;

const AUDIT_DECLARATION: GraphDeclarationV3 = {
  version: 3,
  name: "surface.guard.audit",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
  ],
  edges: [],
};

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  // Release the fixture's stores, then remove each tree ONCE.
  removeTempTrees(tmpDirs);
});

/** Persist one declared graph and start it, leaving its run-state row behind. */
async function startDeclaredGraph(dir: string): Promise<void> {
  const graph = buildDeclaredOutcomeGraph({ declaration: AUDIT_DECLARATION });
  persistDeclaredGraph(graph, engineStateDir(dir));
  const ledger = await SqliteAcceptanceLedger.create(engineStateDir(dir));
  try {
    const runtime = new OutcomeGraphRuntime({
      plan: graph.plan,
      ledger,
      dispatch: () => undefined,
      validators: createValidatorRegistry([]),
      artifactRoot: dir,
      clock: () => AUDIT_NOW,
      credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
    });
    runtime.start(AUDIT_NOW);
  } finally {
    ledger.close();
  }
}

function entryOf(report: DrainAuditReport, graphId: string): DrainAuditEntry {
  const entry = report.entries.find((candidate) => candidate.graphId === graphId);
  if (entry === undefined) throw new Error("fixture: no audit entry for " + graphId);
  return entry;
}

describe("auditGraphStore — an entry-level blocker is classified, not degraded", () => {
  it("names the code, its axis and the contained reason of an unreadable run state", async () => {
    const dir = makeTmpDir("surface-guard-audit-");
    await startDeclaredGraph(dir);
    // Bind the run-state ROW to a foreign plan revision — a condition the strict
    // reader refuses, so the entry's own classification is a blocker.
    const store = GraphStore.openFile(engineStateDir(dir));
    try {
      const recorded = store.readGraphState(AUDIT_DECLARATION.name);
      if (recorded === undefined) throw new Error("fixture: no run-state row");
      store.writeGraphState({ ...recorded, planRevision: "foreign-plan-revision" });
    } finally {
      store.close();
    }

    const report = await auditGraphStore({ directory: dir, now: () => AUDIT_NOW });

    const entry = entryOf(report, AUDIT_DECLARATION.name);
    expect(entry.classification).toBe("blocked");
    expect(entry.blockerCodes).toContain("state-malformed");
    expect(entry.phase).toBeUndefined();

    const blocker = report.blockers.find(
      (candidate) =>
        candidate.code === "state-malformed" && candidate.graphId === AUDIT_DECLARATION.name,
    );
    expect(blocker).toBeDefined();
    // CLASSIFIED: the code carries the axis that owns it ...
    expect(blocker?.dimension).toBe("outcome-state");
    // ... and the contained reason, never the raw fall-through rendering.
    expect(blocker?.detail.length).toBeGreaterThan(0);
    expect(blocker?.detail).not.toBe(
      "graph " + JSON.stringify(AUDIT_DECLARATION.name) + ": state-malformed",
    );
  });
});

// ── F-30: the multi-graph render keeps each graph with its own snapshot ─────

const RENDER_NOW = 1_700_000_000_000;

type GraphRunView = GraphView["runs"][number];

function nodeView(nodeId: string, status: OutcomeNodeStatus, agent: string): GraphNodeView {
  return {
    nodeId,
    agent,
    prompt: nodeId + " prompt",
    status,
    attemptId: undefined,
    outcomeId: undefined,
    dispatchedAt: undefined,
    settledAt: undefined,
    inputs: undefined,
    inputRefusals: undefined,
    arrivals: undefined,
  };
}

/**
 * One `GraphView` carrying exactly the faces the compact and tree renders read.
 * The faces no case here enables (attempts, approvals, loops, unsettled effects,
 * the budget rows) are empty: the render only reaches them through `include_*`
 * flags, which this file never sets.
 */
function graphView(spec: {
  graphId: string;
  phase: OutcomeGraphPhase;
  nodes: GraphNodeView[];
  edges: GraphDeclarationV3["edges"];
}): GraphView {
  const planRevision = "plan." + spec.graphId;
  const declaration: GraphDeclarationV3 = {
    version: 3,
    name: spec.graphId,
    nodes: spec.nodes.map((node) => ({
      id: node.nodeId,
      agent: node.agent,
      prompt: node.prompt,
      outcomes: [{ id: "done" }],
    })),
    edges: spec.edges,
  };
  const runId = spec.graphId + "#1";
  const budget: BudgetReport = {
    graphId: spec.graphId,
    runId,
    planRevision,
    nodes: [],
    totals: ZERO_BUDGET_USAGE,
    reservedTotals: ZERO_BUDGET_USAGE,
    unknownUsageAttempts: 0,
    overruns: [],
  };
  const run: GraphRunView = {
    graphId: spec.graphId,
    runId,
    planRevision,
    runSeq: 1,
    startedAt: RENDER_NOW - 1_000,
    phase: spec.phase,
    updatedAt: RENDER_NOW,
    control: undefined,
    stop: undefined,
    attempts: [],
    nodes: spec.nodes,
    loops: [],
    approvals: [],
    decisions: [],
    unsettledEffects: [],
    budget,
  };
  return {
    graphId: spec.graphId,
    planRevision,
    declaration,
    recordedAt: run.startedAt,
    phase: run.phase,
    updatedAt: run.updatedAt,
    nodes: spec.nodes,
    current: run,
    runs: [run],
  };
}

/**
 * Two graphs whose DECLARATIONS differ: the chain has an edge, the solo graph
 * has none. A view rendered against the wrong graph produces the other block's
 * rows, so the exact-text assertion below cannot pass by accident.
 */
function multiGraphQuery(): GraphQueryResult {
  const chain = graphView({
    graphId: "surface.guard.chain",
    phase: "executing",
    nodes: [nodeView("work", "pending", "worker"), nodeView("review", "settled", "reviewer")],
    edges: [{ from: "work", to: "review", outcome: "done" }],
  });
  const solo = graphView({
    graphId: "surface.guard.solo",
    phase: "ready",
    nodes: [nodeView("solo", "dispatched", "soloist")],
    edges: [],
  });
  return { graphs: [chain, solo], refused: [] };
}

describe("renderGraphQuery — the multi-graph association (F-30)", () => {
  it("renders each graph's own declaration tree, byte for byte", () => {
    const text = renderGraphQuery(
      multiGraphQuery(),
      { scope: "all", format: "tree" },
      new Set(),
    );

    expect(text).toBe(
      "Graph surface.guard.chain [phase: executing]\n" +
        "work [pending]\n  review [settled]\n" +
        "{}\n\n" +
        "Graph surface.guard.solo [phase: ready]\n" +
        "solo [dispatched]\n" +
        "{}",
    );
  });

  it("keeps every graph in the JSON envelope, in query order", () => {
    const text = renderGraphQuery(
      multiGraphQuery(),
      { scope: "all", format: "json" },
      new Set(),
    );
    const parsed = JSON.parse(text) as {
      graphs: readonly { graph_id: string; phase: string }[];
      refused: readonly unknown[];
    };

    expect(parsed.graphs.map((graph) => graph.graph_id)).toEqual([
      "surface.guard.chain",
      "surface.guard.solo",
    ]);
    expect(parsed.graphs.map((graph) => graph.phase)).toEqual(["executing", "ready"]);
    expect(parsed.refused).toEqual([]);
  });
});
