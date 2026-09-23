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
import { CURRENT_OUTCOME_STATE_BODY } from "../../src/graph/outcome/graph-state.ts";
import { readPersistedOutcomePlan } from "../../src/graph/outcome/recovery.ts";
import type { GraphStateRecord } from "../../src/graph/ledger/types.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/runtime.ts";
import type { GraphSubmitOutcomeResult } from "../../src/graph/tools/submit-outcome.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";

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
    // frontier; an unlimited tracker keeps the run unchanged. Only the two
    // methods the rebuild calls are stubbed (the repo's convention for this
    // surface — see tests/graph-tools-deps.test.ts).
    getBudgetTracker: () =>
      ({
        isRequestBudgetExceeded: () => ({ exceeded: false }),
        getRequestUsage: () => ({ inputTokens: 0, outputTokens: 0, cost: 0 }),
      }) as never,
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
    outcomeCredentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
  });
}

/** Read the ledger of a workspace; the caller closes it. */
function openLedger(dir: string): Promise<SqliteAcceptanceLedger> {
  return SqliteAcceptanceLedger.create(engineStateDir(dir));
}

/** The credential one dispatched attempt carried, failing when it never ran. */
function credentialOf(
  requests: readonly OutcomeDispatchRequest[],
  attemptId: string,
): string {
  const found = requests.find((request) => request.attemptId === attemptId);
  if (found === undefined) {
    throw new Error(
      "fixture: no dispatch request for attempt " +
        attemptId +
        " (dispatched: " +
        requests.map((request) => request.attemptId).join(", ") +
        ")",
    );
  }
  return found.credential;
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
    const toolRequests: OutcomeDispatchRequest[] = [];
    const ts = createGraphToolSet({
      stateDir: dir,
      outcomeNow: NOW,
      // The ingress refuses without a dispatch adapter (D8), so the successor
      // this test's submission arms is created through this recorder.
      outcomeDispatch: (request) => {
        toolRequests.push(request);
      },
      credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
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
    // The entry dispatch is a DURABLE INTENT from the same transaction as the
    // starting state: it is `started` (the create returned) and unsettled
    // (the attempt has no outcome yet), which is exactly what a later recovery
    // reads instead of inferring from the state alone.
    expect(first.outcomeProtocol?.unsettledEffects).toEqual([
      graphId + ":dispatch:work#1@started",
    ]);
    expect(startRequests.map((request) => request.attemptId)).toEqual(["work#1"]);

    // A worker reports its outcome; the accepted successor is armed with a
    // durable dispatch effect and CREATED in the same call. The credential is
    // the one the dispatch request handed it, and the startup report never
    // echoes it.
    const workCredential = credentialOf(startRequests, "work#1");
    expect(JSON.stringify(first)).not.toContain(workCredential);
    const accepted = await ts.graph_submit_outcome({
      graph_id: graphId,
      node_id: "work",
      outcome_id: "done",
      credential: workCredential,
    });
    expect(accepted.decision).toBe("accepted");

    const beforeRestart = await openLedger(dir);
    let stateBefore: GraphStateRecord | undefined;
    try {
      stateBefore = beforeRestart.readGraphState(graphId);
      // The successor's effect is STARTED: the tool set's host created the
      // execution when the outcome was accepted, and the row says so. It is NOT
      // left `pending` — that is what a later recovery would have re-created.
      expect(
        beforeRestart
          .pendingEffects(graphId)
          .map((effect) => effect.effectId + "@" + effect.status),
      ).toEqual(["dispatch:ship#2@started"]);
      // The successor was created exactly once, in-process.
      expect(toolRequests.map((request) => request.attemptId)).toEqual(["ship#2"]);
    } finally {
      beforeRestart.close();
    }

    // RESTART — a fresh process sweeps the same store. The graph is RESUMED
    // from the ledger state and the successor's effect is RECONCILED against
    // the host record: it is already started, so NOTHING is created again.
    const restartRequests: OutcomeDispatchRequest[] = [];
    const restarted = await sweep(dir, restartRequests);
    expect(restarted.outcomeProtocol?.started).toEqual([]);
    expect(restarted.outcomeProtocol?.resumed).toHaveLength(1);
    expect(restarted.outcomeProtocol?.resumed[0]).toContain(declared.plan_revision);
    expect(restarted.outcomeProtocol?.resumed[0]).toContain("phase executing");
    expect(restarted.outcomeProtocol?.resumed[0]).toContain("ship#2");
    expect(restartRequests).toEqual([]);
    expect(restarted.outcomeProtocol?.dispatched).toEqual([]);
    expect(restarted.outcomeProtocol?.armed).toEqual([graphId + ":ship#2"]);
    // The started row is reported, never re-created and never dropped.
    expect(restarted.outcomeProtocol?.unsettledEffects).toEqual([
      graphId + ":dispatch:ship#2@started",
    ]);
    expect(restarted.outcomeProtocol?.reconciled).toEqual([
      graphId + ":dispatch:ship#2:recorded-started",
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
    expect(second.outcomeProtocol?.reconciled).toEqual([
      graphId + ":dispatch:ship#2:recorded-started",
    ]);
    expect(secondRequests).toEqual([]);

    // Nothing about the persisted graph state moved between the two sweeps.
    const after = await openLedger(dir);
    try {
      expect(after.readGraphState(graphId)).toEqual(stateBefore);
    } finally {
      after.close();
    }

    // The recovered worker's credential is the one the attempt's STATE ENTRY
    // records — the launch payload never carried it — so the submission it was
    // handed settles exactly that attempt and nothing else.
    const shipCredential = credentialOf(toolRequests, "ship#2");
    expect(shipCredential.length).toBeGreaterThan(0);
    expect(shipCredential).not.toBe(workCredential);
    const settled = await ts.graph_submit_outcome({
      graph_id: graphId,
      node_id: "ship",
      outcome_id: "delivered",
      credential: shipCredential,
    });
    expect(settled.decision).toBe("accepted");
    expect(settled.attempt_id).toBe("ship#2");
  });

  it("reports a started effect a dead process left behind instead of re-launching it", async () => {
    const dir = makeTmpDir("outcome-recovery-started-");
    const toolRequests: OutcomeDispatchRequest[] = [];
    const ts = createGraphToolSet({
      stateDir: dir,
      outcomeNow: NOW,
      outcomeDispatch: (request) => {
        toolRequests.push(request);
      },
      credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
    });
    const declared = ts.graph_declare({ declaration: LINEAR });
    const graphId = declared.graph_id;
    const startRequests: OutcomeDispatchRequest[] = [];
    await sweep(dir, startRequests);
    await ts.graph_submit_outcome({
      graph_id: graphId,
      node_id: "work",
      outcome_id: "done",
      credential: credentialOf(startRequests, "work#1"),
    });
    // The successor's create RETURNED (D8), so the row is `started` — the
    // exact state a process that began the dispatch and died before the
    // attempt's outcome would leave behind, with no fixture surgery needed.
    expect(toolRequests.map((request) => request.attemptId)).toEqual(["ship#2"]);
    const crashed = await openLedger(dir);
    try {
      expect(
        crashed
          .pendingEffects(graphId)
          .map((effect) => effect.effectId + "@" + effect.status),
      ).toEqual(["dispatch:ship#2@started"]);
      // A second "the process began it" write is idempotent, not a rewind.
      expect(crashed.markEffectStarted(graphId, "dispatch:ship#2").kind).toBe(
        "unchanged",
      );
    } finally {
      crashed.close();
    }

    const requests: OutcomeDispatchRequest[] = [];
    const recovery = await sweep(dir, requests);
    // Not re-created: a started row is reconciled against the host record,
    // never restarted.
    expect(requests).toEqual([]);
    expect(recovery.outcomeProtocol?.dispatched).toEqual([]);
    expect(recovery.outcomeProtocol?.reconciled).toEqual([
      graphId + ":dispatch:ship#2:recorded-started",
    ]);
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
    const ts = createGraphToolSet({
      stateDir: dir,
      outcomeNow: NOW,
      credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
    });
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
    const toolRequests: OutcomeDispatchRequest[] = [];
    const ts = createGraphToolSet({
      stateDir: dir,
      outcomeNow: NOW,
      outcomeDispatch: (request) => {
        toolRequests.push(request);
      },
      credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
    });
    const declared = ts.graph_declare({ declaration: LINEAR });
    const graphId = declared.graph_id;
    const startRequests: OutcomeDispatchRequest[] = [];
    await sweep(dir, startRequests);
    const workCredential = credentialOf(startRequests, "work#1");
    const first = await ts.graph_submit_outcome({
      graph_id: graphId,
      node_id: "work",
      outcome_id: "done",
      credential: workCredential,
    });
    expect(first.verdict).toBe("committed");

    // Restart: a new sweep and a NEW toolset with no in-memory declared entry.
    const restartRequests: OutcomeDispatchRequest[] = [];
    await sweep(dir, restartRequests);
    const restartToolRequests: OutcomeDispatchRequest[] = [];
    const restarted = createGraphToolSet({
      stateDir: dir,
      outcomeNow: NOW,
      // The ingress refuses without a dispatch adapter (D8); a replay settles a
      // recorded attempt and arms nothing, so this recorder stays empty.
      outcomeDispatch: (request) => {
        restartToolRequests.push(request);
      },
      credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
    });
    const replay = await restarted.graph_submit_outcome({
      graph_id: graphId,
      node_id: "work",
      outcome_id: "done",
      credential: workCredential,
    });
    expect(replay.decision).toBe("accepted");
    expect(replay.verdict).toBe("replayed");
    expect(replay.attempt_id).toBe("work#1");
    expect(replay.submission_id).toBe(
      "submission:" +
        proposalDigest({ nodeId: "work", outcomeId: "done", credential: workCredential }),
    );

    // One receipt, one accepted event: the replay returned the PERSISTED one
    // instead of writing a second row.
    const submissionId =
      "submission:" +
      proposalDigest({ nodeId: "work", outcomeId: "done", credential: workCredential });
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

// ── A stopped run across a restart ──────────────────────────────────────────

/** work -> review -> (revise) -> work, with review.approve as the exit. */
function loopDeclaration(maxTraversals: number): GraphDeclarationV3 {
  return {
    version: 3,
    name: "recovery.loop",
    nodes: [
      { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
      {
        id: "review",
        agent: "agent.review",
        prompt: "Review the work.",
        outcomes: [{ id: "revise" }, { id: "approve" }],
      },
    ],
    edges: [
      { from: "work", to: "review", outcome: "done" },
      { from: "review", to: "work", outcome: "revise" },
    ],
    loop_groups: [
      {
        id: "revise-loop",
        nodes: ["work", "review"],
        max_traversals: maxTraversals,
        continuation_outcome: "revise",
        exit_outcome: "approve",
      },
    ],
  };
}

describe("a stopped run across a restart", () => {
  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function storedBody(
    ledger: SqliteAcceptanceLedger,
    graphId: string,
  ): Record<string, unknown> {
    const record = ledger.readGraphState(graphId);
    if (record === undefined) throw new Error("fixture: the state row is missing");
    if (!isRecord(record.body)) throw new Error("fixture: the state body is not a record");
    return record.body;
  }

  it("reports the persisted stop, dispatches nothing and stays stopped on a second sweep", async () => {
    const dir = makeTmpDir("outcome-recovery-stopped-");
    const requests: OutcomeDispatchRequest[] = [];
    const ts = createGraphToolSet({
      stateDir: dir,
      outcomeNow: NOW,
      credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
      outcomeDispatch: (request) => {
        requests.push(request);
      },
    });
    const declared = ts.graph_declare({ declaration: loopDeclaration(1) });
    const graphId = declared.graph_id;
    const submit = (
      nodeId: string,
      outcomeId: string,
      attemptId: string,
    ): Promise<GraphSubmitOutcomeResult> =>
      ts.graph_submit_outcome({
        graph_id: graphId,
        node_id: nodeId,
        outcome_id: outcomeId,
        credential: credentialOf(requests, attemptId),
      });

    // FIRST EXECUTION, then the loop is driven to its cap: one revision round,
    // and the continuation that would be the second.
    const first = await sweep(dir, requests);
    expect(first.outcomeProtocol?.started).toHaveLength(1);
    expect(requests.map((request) => request.attemptId)).toEqual(["work#1"]);
    expect((await submit("work", "done", "work#1")).decision).toBe("accepted");
    expect((await submit("review", "revise", "review#2")).decision).toBe("accepted");
    expect((await submit("work", "done", "work#3")).decision).toBe("accepted");

    const stopping = await submit("review", "revise", "review#4");
    // The outcome is accepted; the round past the cap is not taken, and the stop
    // travels back through the model-facing ingress with its reason and round.
    expect(stopping.decision).toBe("accepted");
    expect(stopping.phase).toBe("stopped");
    expect(stopping.stop).toEqual({
      reason: "loop-exhausted",
      loop_group_id: "revise-loop",
      node_id: "review",
      outcome_id: "revise",
      attempt_id: "review#4",
      traversals: 1,
      max_traversals: 1,
      stopped_at: NOW,
    });
    expect(stopping.settled_nodes?.slice().sort()).toEqual(["review", "work"]);

    // THE PERSISTED ROW is where a later process reads it from.
    const writer = await openLedger(dir);
    let stoppedRow: GraphStateRecord | undefined;
    try {
      stoppedRow = writer.readGraphState(graphId);
      const body = storedBody(writer, graphId);
      expect(body.bodyVersion).toBe(CURRENT_OUTCOME_STATE_BODY);
      expect(body.phase).toBe("stopped");
      expect(body.stop).toEqual({
        reason: "loop-exhausted",
        loopGroupId: "revise-loop",
        nodeId: "review",
        outcomeId: "revise",
        attemptId: "review#4",
        traversals: 1,
        maxTraversals: 1,
        stoppedAt: NOW,
      });
      expect(body.loopTraversals).toEqual({ "revise-loop": 1 });
    } finally {
      writer.close();
    }

    // RESTART — a fresh process sweeps the same store. The stop is READ and
    // REPORTED, and the run is continued in no other sense: nothing is launched.
    const restartRequests: OutcomeDispatchRequest[] = [];
    const restarted = await sweep(dir, restartRequests);
    expect(restarted.outcomeProtocol?.started).toEqual([]);
    expect(restarted.outcomeProtocol?.resumed).toHaveLength(1);
    expect(restarted.outcomeProtocol?.resumed[0]).toContain("phase stopped");
    expect(restarted.outcomeProtocol?.resumed[0]).toContain("STOPPED by loop-exhausted");
    expect(restarted.outcomeProtocol?.resumed[0]).toContain("round 1/1");
    expect(restarted.outcomeProtocol?.stopped).toHaveLength(1);
    expect(restarted.outcomeProtocol?.stopped[0]).toContain("[loop-exhausted]");
    expect(restarted.outcomeProtocol?.stopped[0]).toContain("revise-loop");
    expect(restarted.outcomeProtocol?.stopped[0]).toContain("round 1/1");
    expect(restarted.outcomeProtocol?.dispatched).toEqual([]);
    // NOTHING is offered as awaiting an outcome: no submission can settle an
    // attempt of a run that has ended.
    expect(restarted.outcomeProtocol?.armed).toEqual([]);
    expect(restarted.outcomeProtocol?.refused).toEqual([]);
    // THE EVIDENCE FOR "ZERO RE-DISPATCH" is now stronger than "the rows are
    // still pending": every dispatch effect this run committed was CREATED when
    // its attempt was armed (D8) and marked DONE when that attempt settled, so
    // the stopped run leaves NOTHING unsettled for a recovery to resolve — and
    // the only seam this sweep could have called received nothing.
    expect(restarted.outcomeProtocol?.unsettledEffects).toEqual([]);
    expect(restarted.outcomeProtocol?.reconciled).toEqual([]);
    expect(restartRequests).toEqual([]);
    const stoppedLedger = await openLedger(dir);
    try {
      // No row is left `pending` either: a pending row would be a dispatch
      // intent the run never carried out, which is exactly what this proves
      // does not exist.
      expect(stoppedLedger.pendingEffects(graphId)).toEqual([]);
    } finally {
      stoppedLedger.close();
    }

    // A SECOND resume is idempotent: same report, same row, still nothing to do.
    const secondRequests: OutcomeDispatchRequest[] = [];
    const second = await sweep(dir, secondRequests);
    expect(second.outcomeProtocol?.resumed).toEqual(restarted.outcomeProtocol?.resumed);
    expect(second.outcomeProtocol?.stopped).toEqual(restarted.outcomeProtocol?.stopped);
    expect(second.outcomeProtocol?.dispatched).toEqual([]);
    expect(second.outcomeProtocol?.armed).toEqual([]);
    expect(secondRequests).toEqual([]);
    const after = await openLedger(dir);
    try {
      expect(after.readGraphState(graphId)).toEqual(stoppedRow);
    } finally {
      after.close();
    }
  });
});

// ── A state body this build cannot read blocks recovery ────────────────────

describe("outcome state body — a shape this build cannot read blocks recovery", () => {
  function storedRecord(
    ledger: SqliteAcceptanceLedger,
    graphId: string,
  ): GraphStateRecord {
    const record = ledger.readGraphState(graphId);
    if (record === undefined) throw new Error("fixture: the state row is missing");
    return record;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function bodyOf(record: GraphStateRecord): Record<string, unknown> {
    if (!isRecord(record.body)) {
      throw new Error("fixture: the state body is not a record");
    }
    return record.body;
  }

  /**
   * Declare LINEAR, run its first execution through the sweep, and hand back
   * the state row that first execution left for a later process to read.
   */
  async function startLinear(prefix: string): Promise<{
    readonly dir: string;
    readonly graphId: string;
    readonly started: GraphStateRecord;
  }> {
    const dir = makeTmpDir(prefix);
    const ts = createGraphToolSet({
      stateDir: dir,
      outcomeNow: NOW,
      credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
    });
    const declared = ts.graph_declare({ declaration: LINEAR });
    const graphId = declared.graph_id;
    await sweep(dir, []);
    const ledger = await openLedger(dir);
    try {
      const started = storedRecord(ledger, graphId);
      expect(bodyOf(started).bodyVersion).toBe(CURRENT_OUTCOME_STATE_BODY);
      return { dir, graphId, started };
    } finally {
      ledger.close();
    }
  }

  it("resumes a same-version body another process wrote, unmoved", async () => {
    const { dir, graphId, started } = await startLinear("outcome-recovery-body-ok-");
    const requests: OutcomeDispatchRequest[] = [];
    const report = await sweep(dir, requests);

    expect(report.outcomeProtocol?.started).toEqual([]);
    expect(report.outcomeProtocol?.resumed).toHaveLength(1);
    expect(report.outcomeProtocol?.refused).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(requests).toEqual([]);

    const after = await openLedger(dir);
    try {
      // The same-version round trip loses nothing: the recovery read and write
      // nothing, and the state row still carries every field it carried.
      expect(storedRecord(after, graphId)).toEqual(started);
    } finally {
      after.close();
    }
  });

  it("refuses a version-1 body's in-flight attempt instead of arming it", async () => {
    const dir = makeTmpDir("outcome-recovery-body-v1-");
    const ts = createGraphToolSet({
      stateDir: dir,
      outcomeNow: NOW,
      credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
    });
    const declared = ts.graph_declare({ declaration: LINEAR });
    const graphId = declared.graph_id;
    const startRequests: OutcomeDispatchRequest[] = [];
    await sweep(dir, startRequests);

    // A body exactly as the build BEFORE credentials wrote it: version 1, no
    // credential on the in-flight attempt and no arrival list either.
    const writer = await openLedger(dir);
    let rewritten: GraphStateRecord;
    try {
      const current = storedRecord(writer, graphId);
      const body = bodyOf(current);
      const rawNodes = body.nodes;
      if (!Array.isArray(rawNodes)) throw new Error("fixture: the body carries no nodes");
      const v1Nodes = rawNodes.map((node) => {
        if (!isRecord(node)) throw new Error("fixture: a node entry is not a record");
        const { attemptCredential: _credential, arrivals: _arrivals, ...rest } = node;
        return rest;
      });
      // Version 1 defines no progress record either, so it is stripped with the
      // credential and the arrival list.
      const { loopProgress: _progress, ...v1Body } = body;
      rewritten = {
        ...current,
        body: { ...v1Body, bodyVersion: 1, nodes: v1Nodes },
        updatedAt: NOW + 1,
      };
      writer.writeGraphState(rewritten);
    } finally {
      writer.close();
    }

    const requests: OutcomeDispatchRequest[] = [];
    const report = await sweep(dir, requests);
    // The attempt is REFUSED by name — not armed, not launched — because no
    // submission could ever settle it and recovery never grants a credential
    // the attempt was not issued.
    expect(report.outcomeProtocol?.resumed).toHaveLength(1);
    expect(report.outcomeProtocol?.armed).toEqual([]);
    expect(report.outcomeProtocol?.dispatched).toEqual([]);
    // TWO records name the missing credential: the node entry (which cannot be
    // armed) and the dispatch effect committed for that same attempt (which
    // cannot be resolved). Both are durable objects, so both are reported.
    expect(report.outcomeProtocol?.refused).toHaveLength(2);
    for (const line of report.outcomeProtocol?.refused ?? []) {
      expect(line).toContain("[credential-missing]");
      expect(line).toContain("no attempt credential");
    }
    expect(requests).toEqual([]);

    // The version-1 row was neither rewritten nor downgraded nor advanced.
    const after = await openLedger(dir);
    try {
      expect(storedRecord(after, graphId)).toEqual(rewritten);
    } finally {
      after.close();
    }
  });

  it("refuses an unknown body field, leaves it byte-identical and never starts fresh", async () => {
    const { dir, graphId, started } = await startLinear(
      "outcome-recovery-body-field-",
    );

    // PROCESS A: another build writes the same body plus a field this build
    // does not know.
    const writer = await openLedger(dir);
    let extended: GraphStateRecord;
    try {
      extended = {
        ...started,
        body: {
          ...bodyOf(started),
          progressBaselines: { work: { digest: "abc", round: 2 } },
        },
        updatedAt: NOW + 1,
      };
      writer.writeGraphState(extended);
    } finally {
      writer.close();
    }

    // PROCESS B: the sweep refuses instead of reading it partially.
    const requests: OutcomeDispatchRequest[] = [];
    const report = await sweep(dir, requests);
    expect(report.outcomeProtocol?.refused).toHaveLength(1);
    expect(report.outcomeProtocol?.refused[0]).toContain("[unreadable-state]");
    expect(report.outcomeProtocol?.refused[0]).toContain("progressBaselines");
    expect(report.outcomeProtocol?.started).toEqual([]);
    expect(report.outcomeProtocol?.resumed).toEqual([]);
    expect(report.outcomeProtocol?.dispatched).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.recovered).toBe(0);
    expect(requests).toEqual([]);

    // NOT trimmed and NOT rewritten: every field the refusing process was
    // handed is still in the row.
    const after = await openLedger(dir);
    try {
      expect(storedRecord(after, graphId)).toEqual(extended);
      expect("progressBaselines" in bodyOf(storedRecord(after, graphId))).toBe(true);
    } finally {
      after.close();
    }
  });

  it("refuses a newer body version by name and never starts from scratch", async () => {
    const { dir, graphId, started } = await startLinear(
      "outcome-recovery-body-version-",
    );

    const future = CURRENT_OUTCOME_STATE_BODY + 1;
    const writer = await openLedger(dir);
    let written: GraphStateRecord;
    try {
      written = {
        ...started,
        body: { ...bodyOf(started), bodyVersion: future },
        updatedAt: NOW + 1,
      };
      writer.writeGraphState(written);
    } finally {
      writer.close();
    }

    const statePath = engineStatePath(dir, graphId);
    const before = readFileSync(statePath, "utf-8");
    const requests: OutcomeDispatchRequest[] = [];
    const report = await sweep(dir, requests);

    expect(report.outcomeProtocol?.refused).toHaveLength(1);
    expect(report.outcomeProtocol?.refused[0]).toContain(
      "[unsupported-state-version]",
    );
    expect(report.outcomeProtocol?.refused[0]).toContain(String(future));
    expect(report.outcomeProtocol?.started).toEqual([]);
    expect(report.outcomeProtocol?.resumed).toEqual([]);
    expect(report.outcomeProtocol?.dispatched).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(requests).toEqual([]);

    // The declared record is untouched and the state body is NOT downgraded.
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    const after = await openLedger(dir);
    try {
      expect(storedRecord(after, graphId)).toEqual(written);
      expect(bodyOf(storedRecord(after, graphId)).bodyVersion).toBe(future);
    } finally {
      after.close();
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
