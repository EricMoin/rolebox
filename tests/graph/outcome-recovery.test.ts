/**
 * Outcome-protocol restart recovery (C3c).
 *
 * Covers the restart half of the vertical path: the startup sweep performs a
 * declared graph's FIRST EXECUTION from its SAVED plan, a restart RESUMES the
 * graph from the state in the ledger (the same plan revision the first
 * execution used), the pending successor dispatch is launched exactly once,
 * every unsettled effect is reported (a `started` effect from a dead process is
 * reported, not re-launched and not dropped), a second sweep is idempotent, a
 * duplicate submission after the restart still replays, a state bound to
 * another plan revision is REFUSED by name (never restarted from scratch), and
 * a legacy v2 graph still recovers and runs exactly as before — through its own
 * file store, with no acceptance ledger created at all.
 *
 * Every case runs in its own mkdtemp directory and removes it in a finally
 * block; nothing here writes outside a temp dir.
 */

import { describe, expect, it, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { DispatchManager } from "../../src/dispatch/core/manager.ts";
import type { EngineState } from "../../src/types.engine-v2.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import {
  EnginePersistence,
  engineStateDir,
  engineStatePath,
} from "../../src/graph/engine/engine-persistence.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import {
  recoverInterruptedGraphs,
  type RecoveryStartupReport,
} from "../../src/graph/engine/engine-startup.ts";
import {
  LEDGER_FILE_NAME,
  SqliteAcceptanceLedger,
} from "../../src/graph/ledger/sqlite-ledger.ts";
import { proposalDigest } from "../../src/graph/outcome/proposal.ts";
import { readPersistedOutcomePlan } from "../../src/graph/outcome/recovery.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/runtime.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

/** work -> ship: one successor edge, one terminal outcome. */
const LINEAR: GraphDeclarationV3 = {
  version: 3,
  name: "recovery.linear",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    { id: "ship", agent: "agent.ship", prompt: "Ship it.", outcomes: [{ id: "delivered" }] },
  ],
  edges: [{ from: "work", to: "ship", outcome: "done" }],
};

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

/** The dispatch surface the sweep consults; only `getTask` is ever called here. */
function managerWith(
  getTask: (taskId: string) => DispatchTask | undefined,
): DispatchManager {
  const surface: Partial<DispatchManager> = {
    getTask,
    getTasksByParent: () => [],
    getEventState: () => new Map(),
    // The legacy recovery path reads the budget tracker while it rebuilds the
    // frontier; an unlimited tracker keeps the run unchanged.
    getBudgetTracker: () => ({
      isRequestBudgetExceeded: () => ({ exceeded: false }),
      getRequestUsage: () => ({ inputTokens: 0, outputTokens: 0, cost: 0 }),
    }),
  };
  return surface as DispatchManager;
}

/** A completed legacy dispatch task, for the legacy-recovery case. */
function completedTask(id: string): DispatchTask {
  return {
    id,
    sessionId: "sess-" + id,
    parentSessionId: "startup",
    depth: 1,
    status: "completed",
    agent: "a1",
    prompt: "p1",
    startedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 0 },
    priority: 0,
  };
}

/** Run the startup sweep over one workspace, recording outcome dispatches. */
function sweep(
  dir: string,
  requests: OutcomeDispatchRequest[],
  manager: DispatchManager = managerWith(() => undefined),
): Promise<RecoveryStartupReport> {
  return recoverInterruptedGraphs({
    directory: dir,
    manager,
    stateDir: dir,
    outcomeNow: NOW,
    outcomeDispatch: (request) => {
      requests.push(request);
    },
  });
}

/** Read the ledger of a workspace; the caller closes it. */
function openLedger(dir: string): Promise<SqliteAcceptanceLedger> {
  return SqliteAcceptanceLedger.create(engineStateDir(dir));
}

// ── The saved plan is the authority ─────────────────────────────────────────

describe("readPersistedOutcomePlan — the saved plan and its binding", () => {
  it("refuses a record with no persisted plan and one whose binding names another revision", () => {
    const graph = buildDeclaredOutcomeGraph({ declaration: LINEAR });

    const { compiledPlan: _plan, ...withoutPlan } = graph.state;
    const noPlan: EngineState = withoutPlan;
    const noPlanReading = readPersistedOutcomePlan(noPlan);
    expect(noPlanReading.kind).toBe("refused");
    if (noPlanReading.kind === "refused") {
      expect(noPlanReading.refusals.map((entry) => entry.code)).toEqual([
        "missing-persisted-plan",
      ]);
    }

    const binding = graph.state.planBinding;
    if (binding === undefined) throw new Error("fixture carries no plan binding");
    const mismatched: EngineState = {
      ...graph.state,
      planBinding: { ...binding, planRevision: "revision-from-another-plan" },
    };
    const mismatchReading = readPersistedOutcomePlan(mismatched);
    expect(mismatchReading.kind).toBe("refused");
    if (mismatchReading.kind === "refused") {
      expect(mismatchReading.refusals.map((entry) => entry.code)).toEqual([
        "plan-revision-mismatch",
      ]);
      expect(mismatchReading.refusals[0]?.message).toContain(
        "revision-from-another-plan",
      );
    }

    // The matching case reads.
    expect(readPersistedOutcomePlan(graph.state).kind).toBe("ok");
  });
});

// ── First execution and restart share one saved plan ────────────────────────

describe("outcome-protocol restart recovery", () => {
  it("starts the first execution from the saved plan and resumes the restart from the same revision", async () => {
    const dir = makeTmpDir("outcome-recovery-");
    const ts = createGraphToolSet({
      stateDir: dir,
      outcomeNow: NOW,
    });
    const declared = ts.graph_declare({ declaration: LINEAR });
    const graphId = declared.graph_id;

    // FIRST EXECUTION — no ledger state exists, so the sweep starts the graph
    // from the SAVED plan. This is the same plan a later recovery continues.
    const startRequests: OutcomeDispatchRequest[] = [];
    const first = await sweep(dir, startRequests);
    expect(first.failed).toEqual([]);
    expect(first.recovered).toBe(0);
    expect(first.outcomeProtocol?.started).toHaveLength(1);
    expect(first.outcomeProtocol?.started[0]).toContain(declared.plan_revision);
    expect(first.outcomeProtocol?.resumed).toEqual([]);
    expect(first.outcomeProtocol?.dispatched).toEqual([graphId + ":work#1"]);
    expect(first.outcomeProtocol?.armed).toEqual([graphId + ":work#1"]);
    expect(first.outcomeProtocol?.unsettledEffects).toEqual([]);
    expect(startRequests.map((request) => request.attemptId)).toEqual(["work#1"]);

    // A worker reports its outcome; the accepted successor is armed with a
    // durable PENDING dispatch effect.
    const accepted = await ts.graph_submit_outcome({
      graph_id: graphId,
      node_id: "work",
      outcome_id: "done",
    });
    expect(accepted.decision).toBe("accepted");

    const beforeRestart = await openLedger(dir);
    let stateBefore: unknown;
    try {
      stateBefore = beforeRestart.readGraphState(graphId);
      expect(beforeRestart.pendingEffects(graphId).map((effect) => effect.status)).toEqual([
        "pending",
      ]);
    } finally {
      beforeRestart.close();
    }

    // RESTART — a fresh process sweeps the same store. The graph is RESUMED
    // from the ledger state, and the pending successor dispatch is launched.
    const restartRequests: OutcomeDispatchRequest[] = [];
    const restarted = await sweep(dir, restartRequests);
    expect(restarted.outcomeProtocol?.started).toEqual([]);
    expect(restarted.outcomeProtocol?.resumed).toHaveLength(1);
    expect(restarted.outcomeProtocol?.resumed[0]).toContain(declared.plan_revision);
    expect(restarted.outcomeProtocol?.resumed[0]).toContain("phase executing");
    expect(restarted.outcomeProtocol?.resumed[0]).toContain("ship#2");
    expect(restartRequests.map((request) => request.attemptId)).toEqual(["ship#2"]);
    expect(restarted.outcomeProtocol?.dispatched).toEqual([graphId + ":ship#2"]);
    expect(restarted.outcomeProtocol?.armed).toEqual([graphId + ":ship#2"]);
    // The launched effect is STARTED and still unsettled — reported verbatim.
    expect(restarted.outcomeProtocol?.unsettledEffects).toEqual([
      graphId + ":dispatch:ship#2@started",
    ]);
    expect(restarted.outcomeProtocol?.refused).toEqual([]);

    // IDEMPOTENT — a second sweep launches nothing and reports the same rows.
    const secondRequests: OutcomeDispatchRequest[] = [];
    const second = await sweep(dir, secondRequests);
    expect(second.outcomeProtocol?.resumed).toHaveLength(1);
    expect(second.outcomeProtocol?.dispatched).toEqual([]);
    expect(second.outcomeProtocol?.unsettledEffects).toEqual([
      graphId + ":dispatch:ship#2@started",
    ]);
    expect(secondRequests).toEqual([]);

    // Nothing about the persisted graph state moved between the two sweeps.
    const after = await openLedger(dir);
    try {
      expect(after.readGraphState(graphId)).toEqual(stateBefore);
    } finally {
      after.close();
    }
  });

  it("reports a started effect a dead process left behind instead of re-launching it", async () => {
    const dir = makeTmpDir("outcome-recovery-started-");
    const ts = createGraphToolSet({ stateDir: dir, outcomeNow: NOW });
    const declared = ts.graph_declare({ declaration: LINEAR });
    const graphId = declared.graph_id;
    await sweep(dir, []);
    await ts.graph_submit_outcome({
      graph_id: graphId,
      node_id: "work",
      outcome_id: "done",
    });

    // A process began the successor dispatch and died before settling it.
    const crashed = await openLedger(dir);
    try {
      expect(crashed.markEffectStarted(graphId, "dispatch:ship#2").kind).toBe(
        "transitioned",
      );
    } finally {
      crashed.close();
    }

    const requests: OutcomeDispatchRequest[] = [];
    const recovery = await sweep(dir, requests);
    // Not re-launched: a started row is reconciled, never restarted.
    expect(requests).toEqual([]);
    expect(recovery.outcomeProtocol?.dispatched).toEqual([]);
    // Never dropped: the row is the report.
    expect(recovery.outcomeProtocol?.unsettledEffects).toEqual([
      graphId + ":dispatch:ship#2@started",
    ]);
    expect(recovery.outcomeProtocol?.armed).toEqual([graphId + ":ship#2"]);
    expect(recovery.outcomeProtocol?.refused).toEqual([]);
    // And it stays started — no rewind happened on this path.
    const after = await openLedger(dir);
    try {
      expect(after.pendingEffects(graphId).map((effect) => effect.status)).toEqual([
        "started",
      ]);
    } finally {
      after.close();
    }
  });

  it("refuses a state bound to another plan revision and never starts from scratch", async () => {
    const dir = makeTmpDir("outcome-recovery-mismatch-");
    const ts = createGraphToolSet({ stateDir: dir, outcomeNow: NOW });
    const declared = ts.graph_declare({ declaration: LINEAR });
    const graphId = declared.graph_id;

    // A state row written under a DIFFERENT plan revision — exactly what a
    // stale or foreign writer would leave behind.
    const foreign = "revision-from-another-plan";
    const ledger = await openLedger(dir);
    try {
      ledger.writeGraphState({
        graphId,
        planRevision: foreign,
        body: {},
        updatedAt: NOW,
      });
    } finally {
      ledger.close();
    }

    const statePath = engineStatePath(dir, graphId);
    const before = readFileSync(statePath, "utf-8");
    const requests: OutcomeDispatchRequest[] = [];
    const report = await sweep(dir, requests);

    // Reported explicitly, in its own bucket — not as corrupt data, not as a
    // clean resume, and not as a fresh start.
    expect(report.outcomeProtocol?.refused).toHaveLength(1);
    expect(report.outcomeProtocol?.refused[0]).toContain("plan-revision-mismatch");
    expect(report.outcomeProtocol?.refused[0]).toContain(foreign);
    expect(report.outcomeProtocol?.started).toEqual([]);
    expect(report.outcomeProtocol?.resumed).toEqual([]);
    expect(report.outcomeProtocol?.dispatched).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.recovered).toBe(0);
    expect(requests).toEqual([]);

    // Neither the declared record nor the foreign state row was rewritten.
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    const after = await openLedger(dir);
    try {
      expect(after.readGraphState(graphId)?.planRevision).toBe(foreign);
    } finally {
      after.close();
    }
  });

  it("replays a duplicate submission after the restart and writes no second record", async () => {
    const dir = makeTmpDir("outcome-recovery-replay-");
    const ts = createGraphToolSet({ stateDir: dir, outcomeNow: NOW });
    const declared = ts.graph_declare({ declaration: LINEAR });
    const graphId = declared.graph_id;
    await sweep(dir, []);
    const first = await ts.graph_submit_outcome({
      graph_id: graphId,
      node_id: "work",
      outcome_id: "done",
    });
    expect(first.verdict).toBe("committed");

    // Restart: a new sweep and a NEW toolset with no in-memory declared entry.
    await sweep(dir, []);
    const restarted = createGraphToolSet({ stateDir: dir, outcomeNow: NOW });
    const replay = await restarted.graph_submit_outcome({
      graph_id: graphId,
      node_id: "work",
      outcome_id: "done",
    });
    expect(replay.decision).toBe("accepted");
    expect(replay.verdict).toBe("replayed");
    expect(replay.attempt_id).toBe("work#1");
    expect(replay.submission_id).toBe(
      "submission:" + proposalDigest({ nodeId: "work", outcomeId: "done" }),
    );

    // One receipt, one accepted event: the replay returned the PERSISTED one
    // instead of writing a second row.
    const submissionId =
      "submission:" + proposalDigest({ nodeId: "work", outcomeId: "done" });
    const ledger = await openLedger(dir);
    try {
      expect(ledger.acceptedEvents(graphId)).toHaveLength(1);
      const receipt = ledger.lookupReceipt({
        graphId,
        attemptId: "work#1",
        submissionId,
      });
      expect(receipt?.decision).toBe("accepted");
      expect(receipt?.submissionId).toBe(submissionId);
    } finally {
      ledger.close();
    }
  });
});

// ── The legacy path is untouched ────────────────────────────────────────────

describe("legacy v2 recovery is unchanged", () => {
  it("recovers a legacy graph through its file store and creates no ledger", async () => {
    const dir = makeTmpDir("outcome-recovery-legacy-");
    const graphId = "legacy.graph";
    const declaration: GraphDeclaration = {
      version: 2,
      name: graphId,
      nodes: [{ id: "A", agent: "a1", prompt: "p1" }],
      edges: [],
    };
    const state = createEngineState(declaration, graphId);
    provision(state);
    state.phase = EnginePhase.Executing;
    const node = state.nodes.get("A");
    if (node === undefined) throw new Error("fixture node missing");
    node.status = NodeStatus.Running;
    node.dispatchTaskId = "task-A";
    new EnginePersistence(dir).save(state);

    const report = await sweep(
      dir,
      [],
      managerWith((taskId) => (taskId === "task-A" ? completedTask("task-A") : undefined)),
    );

    // Exactly the legacy behavior: one clean recovery, no outcome bucket at all.
    expect(report.recovered).toBe(1);
    expect(report.failed).toEqual([]);
    expect(report.degraded).toEqual([]);
    expect(report.outcomeProtocol).toBeUndefined();
    // The outcome protocol's store was never created for a legacy run.
    expect(existsSync(join(engineStateDir(dir), LEDGER_FILE_NAME))).toBe(false);
    const persisted = new EnginePersistence(dir).load(graphId);
    expect(persisted?.phase).toBe(EnginePhase.Complete);
    expect(persisted?.nodes.get("A")?.status).toBe(NodeStatus.Completed);
  });
});
