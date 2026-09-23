/**
 * P3 item 1 — THE CONTROL TABLES of the ONE authoritative store.
 *
 * WHAT THIS FILE PROVES ABOUT THE SUBSTRATE ITSELF (the application rules are
 * proven through the shipped entry in control-entry.test.ts):
 *
 * - the run identity is minted ONCE per graph and a second mint answers the
 *   identity already recorded (two processes cannot disagree about which run a
 *   graph is executing);
 * - an ATTEMPT carries at most ONE control decision — the primary key enforces
 *   it — so a repeated command replays and a competing command conflicts;
 * - the RUN's control fact is claimed by a conditional update and is never
 *   replaced by a later command;
 * - the closed command vocabulary and the principal shape are CHECK-enforced, so
 *   a foreign row is refused by the DDL rather than read approximately;
 * - the rows survive a CLOSE and a REOPEN of the store (a restart is a read);
 * - the format gate refuses a version-2 store as an older format this build
 *   registers no migration for, so the two new tables can never be answered as
 *   "no control record".
 *
 * STRENGTH: pure/unit over a real store file, one process.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphStore } from "../../src/graph/store/graph-store.ts";
import type { GraphAcceptanceBatch } from "../../src/graph/store/records.ts";
import { GraphStoreFormatError } from "../../src/graph/store/errors.ts";
import { GRAPH_STORE_TABLES } from "../../src/graph/store/schema.ts";
import type {
  ControlDecisionRecord,
  RunControlRecord,
} from "../../src/graph/ledger/types.ts";

const tmpDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "control-store-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

const GRAPH = "control.store";
const RUN = "control.store@1";

function decision(
  overrides: Partial<ControlDecisionRecord> = {},
): ControlDecisionRecord {
  return Object.freeze({
    graphId: GRAPH,
    runId: RUN,
    nodeId: "work",
    attemptId: "work#1",
    command: "failure",
    reason: "the execution ended without its outcome",
    decidedAt: 1_700_000_000_000,
    decidedBy: Object.freeze({ sessionId: "session.declarer", agentId: "agent.declarer" }),
    ...overrides,
  });
}

function runControl(
  overrides: Partial<RunControlRecord> = {},
): RunControlRecord {
  return Object.freeze({
    graphId: GRAPH,
    runId: RUN,
    command: "failure",
    reason: "the execution ended without its outcome",
    decidedAt: 1_700_000_000_000,
    decidedBy: Object.freeze({ sessionId: "session.declarer", agentId: "agent.declarer" }),
    ...overrides,
  });
}

describe("graph store — the run identity table", () => {
  it("mints one run identity per graph and answers it to every later mint", () => {
    const dir = makeDir();
    const store = GraphStore.openFile(dir);
    try {
      const first = store.runs.mintRun({ graphId: GRAPH, runId: "run.one", startedAt: 10 });
      expect(first).toEqual({ graphId: GRAPH, runId: "run.one", startedAt: 10 });
      // A racing second mint proposes ANOTHER id and is answered with the first:
      // two processes cannot disagree about which run the graph is executing.
      const second = store.runs.mintRun({ graphId: GRAPH, runId: "run.two", startedAt: 11 });
      expect(second.runId).toBe("run.one");
      expect(second.startedAt).toBe(10);
      expect(store.runs.readRun(GRAPH)?.runId).toBe("run.one");
      expect(store.runs.readRun("control.other")).toBeUndefined();
      // A substrate that holds no run has no control fact either.
      expect(store.runs.readRunControl(GRAPH)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe("graph store — one control decision per attempt", () => {
  it("records, replays and CONFLICTS on the attempt's primary key", () => {
    const dir = makeDir();
    const store = GraphStore.openFile(dir);
    try {
      store.runs.mintRun({ graphId: GRAPH, runId: RUN, startedAt: 9 });
      const recorded = store.runs.writeControlDecision({
        decision: decision(),
        runControl: runControl(),
      });
      expect(recorded.kind).toBe("recorded");
      if (recorded.kind !== "recorded") throw new Error("fixture: expected a record");
      expect(recorded.runControl).toMatchObject({ command: "failure", reason: "the execution ended without its outcome" });

      // THE SAME COMMAND IS A REPLAY: nothing is written and the PERSISTED
      // decision comes back — a later caller's reason never rewrites it.
      const replayed = store.runs.writeControlDecision({
        decision: decision({ reason: "a LATER reason" }),
        runControl: runControl({ reason: "a LATER reason" }),
      });
      expect(replayed.kind).toBe("replayed");
      if (replayed.kind !== "replayed") throw new Error("fixture: expected a replay");
      expect(replayed.decision.reason).toBe("the execution ended without its outcome");

      // A DIFFERENT COMMAND FOR THE SAME ATTEMPT IS A CONFLICT: one attempt, one
      // control fact.
      const conflict = store.runs.writeControlDecision({
        decision: decision({ command: "timeout", reason: "and it timed out" }),
        runControl: runControl({ command: "timeout" }),
      });
      expect(conflict.kind).toBe("conflict");
      if (conflict.kind !== "conflict") throw new Error("fixture: expected a conflict");
      expect(conflict.existing.command).toBe("failure");

      expect(store.runs.controlDecisions(GRAPH)).toHaveLength(1);
      expect(store.runs.readControlDecision(GRAPH, RUN, "work", "work#1")?.command).toBe(
        "failure",
      );
    } finally {
      store.close();
    }
  });

  it("keeps the FIRST run control fact while later attempts are still recorded", () => {
    const dir = makeDir();
    const store = GraphStore.openFile(dir);
    try {
      store.runs.mintRun({ graphId: GRAPH, runId: RUN, startedAt: 9 });
      store.runs.writeControlDecision({
        decision: decision(),
        runControl: runControl(),
      });
      // A SIBLING attempt's later command is recorded as its own fact...
      const sibling = store.runs.writeControlDecision({
        decision: decision({ nodeId: "beta", attemptId: "beta#2", reason: "beta failed later" }),
        runControl: runControl({ reason: "beta failed later" }),
      });
      expect(sibling.kind).toBe("recorded");
      if (sibling.kind !== "recorded") throw new Error("fixture: expected a record");
      // ...and the RUN keeps the command that stopped it FIRST.
      expect(sibling.runControl.reason).toBe("the execution ended without its outcome");
      expect(store.runs.readRunControl(GRAPH)?.reason).toBe(
        "the execution ended without its outcome",
      );

      // A run-wide claim (no attempt) follows the SAME first-wins rule.
      const claim = store.runs.claimRunControl(
        runControl({ command: "cancel", reason: "cancelled later" }),
      );
      expect(claim?.command).toBe("failure");
      expect(store.runs.readRunControl(GRAPH)?.command).toBe("failure");
    } finally {
      store.close();
    }
  });
});

describe("graph store — the decision write is conditional on the COMMITTED store", () => {
  it("refuses to record a decision for an attempt that already settled", () => {
    const dir = makeDir();
    const store = GraphStore.openFile(dir);
    try {
      store.runs.mintRun({ graphId: GRAPH, runId: RUN, startedAt: 9 });
      // The attempt settles FIRST, through the acceptance core's own commit.
      const committed = store.commitAccepted({
        receipt: {
          graphId: GRAPH,
          attemptId: "work#1",
          submissionId: "submission:one",
          planRevision: "plan.one",
          proposalDigest: "digest.one",
          decision: "accepted",
          committedAt: 4,
        },
        acceptedEvent: {
          graphId: GRAPH,
          attemptId: "work#1",
          submissionId: "submission:one",
          planRevision: "plan.one",
          outcomeId: "done",
          acceptedAt: 4,
        },
      });
      expect(committed.kind).toBe("committed");

      // The control write decides against the COMMITTED store, not against a
      // value read earlier: the INSERT's own WHERE NOT EXISTS sees the accepted
      // event and writes nothing.
      const written = store.runs.writeControlDecision({
        decision: decision(),
        runControl: runControl(),
      });
      expect(written.kind).toBe("settled");
      if (written.kind !== "settled") throw new Error("fixture: expected a settled verdict");
      expect(written.attemptId).toBe("work#1");
      // NOTHING was written, and the run was NOT stopped either.
      expect(store.runs.controlDecisions(GRAPH)).toEqual([]);
      expect(store.runs.readRunControl(GRAPH)).toBeUndefined();
      expect(store.acceptedEvents(GRAPH).map((event) => event.outcomeId)).toEqual(["done"]);
    } finally {
      store.close();
    }
  });

  it("still records when the attempt has NOT settled, and then the acceptance is what the run path refuses", () => {
    const dir = makeDir();
    const store = GraphStore.openFile(dir);
    try {
      store.runs.mintRun({ graphId: GRAPH, runId: RUN, startedAt: 9 });
      const written = store.runs.writeControlDecision({
        decision: decision(),
        runControl: runControl(),
      });
      expect(written.kind).toBe("recorded");
      // The store's acceptance rules know nothing about control: the ONE thing
      // that keeps a settlement from being committed after a stop is the run
      // path's own `control-stopped` refusal, which every settlement ingress
      // goes through (proven in control-entry.test.ts). This case pins that the
      // control fact itself is durable and visible to that gate.
      expect(store.runs.readRunControl(GRAPH)?.command).toBe("failure");
      expect(store.runs.controlDecisions(GRAPH)).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

describe("graph store — the DDL refuses what the record model refuses", () => {
  it("refuses a command outside the closed vocabulary, a missing reason, and an agent with no session", () => {
    const dir = makeDir();
    const store = GraphStore.openFile(dir);
    try {
      store.runs.mintRun({ graphId: GRAPH, runId: RUN, startedAt: 9 });
      const insert =
        "INSERT INTO " +
        GRAPH_STORE_TABLES.controlDecisions +
        " (graph_id, run_id, node_id, attempt_id, command, reason, decided_at, decided_by_session, decided_by_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
      expect(() =>
        store.run(insert, GRAPH, RUN, "work", "work#1", "pause", "not a command", 1, null, null),
      ).toThrow();
      expect(() =>
        store.run(insert, GRAPH, RUN, "work", "work#1", "failure", null, 1, null, null),
      ).toThrow();
      expect(() =>
        store.run(insert, GRAPH, RUN, "work", "work#1", "failure", "r", 1, null, "agent.orphan"),
      ).toThrow();
      // Nothing landed.
      expect(store.runs.controlDecisions(GRAPH)).toEqual([]);
      // The same shape rules hold for the RUN's control fact.
      expect(() =>
        store.run(
          "UPDATE " +
            GRAPH_STORE_TABLES.runs +
            " SET control_command = 'pause' WHERE graph_id = ?",
          GRAPH,
        ),
      ).toThrow();
      expect(store.runs.readRunControl(GRAPH)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

// ── Control and acceptance never both commit (P3 item 1) ────────────────────

/** One acceptance batch for an attempt of GRAPH, as the acceptance core writes it. */
function acceptanceBatch(attemptId: string): GraphAcceptanceBatch {
  const submissionId = "submission:" + attemptId;
  return {
    receipt: {
      graphId: GRAPH,
      attemptId,
      submissionId,
      planRevision: "plan.control-store",
      proposalDigest: "digest:" + attemptId,
      decision: "accepted",
      committedAt: 1_700_000_000_000,
    },
    acceptedEvent: {
      graphId: GRAPH,
      attemptId,
      submissionId,
      planRevision: "plan.control-store",
      outcomeId: "done",
      acceptedAt: 1_700_000_000_000,
    },
  };
}

describe("graph store — control and acceptance never both commit for one attempt", () => {
  it("refuses an acceptance whose run is already controlled, and writes NOTHING", () => {
    const dir = makeDir();
    const store = GraphStore.openFile(dir);
    try {
      store.runs.mintRun({ graphId: GRAPH, runId: RUN, startedAt: 9 });
      const recorded = store.runs.writeControlDecision({
        decision: decision(),
        runControl: runControl(),
      });
      expect(recorded.kind).toBe("recorded");

      // The run is controlled, so the acceptance is refused BY THE STORE — the
      // check runs inside the committing transaction — and nothing is written:
      // no receipt, no accepted event, no effect. This is the structural half of
      // the rule the run path applies by name (`control-stopped`).
      const refused = store.commitAccepted(acceptanceBatch("work#1"));
      expect(refused.kind).toBe("controlled");
      if (refused.kind !== "controlled") throw new Error("fixture: expected controlled");
      expect(refused.control).toMatchObject({
        graphId: GRAPH,
        runId: RUN,
        command: "failure",
        reason: "the execution ended without its outcome",
      });
      expect(refused.reason).toContain("controlled run");
      expect(
        store.lookupReceipt({
          graphId: GRAPH,
          attemptId: "work#1",
          submissionId: "submission:work#1",
        }),
      ).toBeUndefined();
      expect(store.acceptedEvents(GRAPH)).toEqual([]);
      expect(store.pendingEffects(GRAPH)).toEqual([]);
      // The control fact stands, unopposed.
      expect(store.runs.controlDecisions(GRAPH)).toHaveLength(1);
      expect(store.runs.readRunControl(GRAPH)?.command).toBe("failure");
    } finally {
      store.close();
    }
  });

  it("refuses a control decision for an attempt that already settled, and writes nothing", () => {
    const dir = makeDir();
    const store = GraphStore.openFile(dir);
    try {
      store.runs.mintRun({ graphId: GRAPH, runId: RUN, startedAt: 9 });
      expect(store.commitAccepted(acceptanceBatch("work#1")).kind).toBe("committed");

      // The inverse direction: the acceptance committed FIRST, so the attempt
      // carries an accepted event and a control command must not re-label it.
      const refused = store.runs.writeControlDecision({
        decision: decision(),
        runControl: runControl(),
      });
      expect(refused.kind).toBe("settled");
      expect(store.runs.readControlDecision(GRAPH, RUN, "work", "work#1")).toBeUndefined();
      expect(store.runs.readRunControl(GRAPH)).toBeUndefined();
      expect(store.runs.controlDecisions(GRAPH)).toEqual([]);
      expect(store.acceptedEvents(GRAPH).map((event) => event.attemptId)).toEqual(["work#1"]);
    } finally {
      store.close();
    }
  });
});

describe("graph store — control facts are read back by a reopened store", () => {
  it("reads the same run, decision and run-control fact from a second connection", () => {
    const dir = makeDir();
    const first = GraphStore.openFile(dir);
    try {
      first.runs.mintRun({ graphId: GRAPH, runId: RUN, startedAt: 9 });
      first.runs.writeControlDecision({
        decision: decision(),
        runControl: runControl(),
      });
    } finally {
      first.close();
    }
    const second = GraphStore.openFile(dir);
    try {
      expect(second.runs.readRun(GRAPH)?.runId).toBe(RUN);
      expect(second.runs.readRunControl(GRAPH)).toMatchObject({
        command: "failure",
        reason: "the execution ended without its outcome",
        decidedAt: 1_700_000_000_000,
        decidedBy: { sessionId: "session.declarer", agentId: "agent.declarer" },
      });
      expect(second.runs.controlDecisions(GRAPH)).toHaveLength(1);
      expect(second.runs.controlDecisions(GRAPH)[0]?.attemptId).toBe("work#1");
    } finally {
      second.close();
    }
  });

  it("refuses a version-2 store as an older format with no migration", () => {
    const dir = makeDir();
    const store = GraphStore.openFile(dir);
    try {
      store.run(
        "UPDATE " + GRAPH_STORE_TABLES.meta + " SET format_version = 2 WHERE id = 1",
      );
    } finally {
      store.close();
    }
    let refusal: unknown;
    try {
      GraphStore.openFile(dir).close();
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(GraphStoreFormatError);
    expect((refusal as GraphStoreFormatError).problem).toBe("older-format");
  });
});
