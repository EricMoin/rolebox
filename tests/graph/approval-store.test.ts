import { approvalGrantFor } from "./helpers/approval-policy.ts";
/**
 * P3 item 3 — THE APPROVAL TABLE of the ONE authoritative store.
 *
 * WHAT THIS FILE PROVES ABOUT THE SUBSTRATE ITSELF (the application rules are
 * proven through the shipped entry in approval-lifecycle.test.ts):
 *
 * - the request row is the PAUSE: raising it twice replays, and its primary key
 *   (one row per attempt) makes a second request for one attempt
 *   unrepresentable;
 * - the decision is ONE conditional update of a `pending` row: a repeat replays, a
 *   competing decision conflicts, and a deadline that has passed is materialized
 *   as `expired` by the very call that tried to decide it;
 * - the ACCEPTANCE GATE is structural: `commitAccepted` refuses a batch for a
 *   gated attempt (verdict `approval-blocked`, nothing written) and accepts it
 *   once the request is approved — the same shape the run's control fact uses, so
 *   a raising command and an acceptance can never both land for one attempt;
 * - the rows survive a close and a reopen (a restart is a read), and a version-4
 *   store — which holds no approval table at all — is refused as an older format
 *   this build registers no migration for, so the gate can never answer "no
 *   request" for a pause a previous process recorded.
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
  ApprovalDecideResult,
  ApprovalRaiseResult,
  ApprovalRequestRecord,
} from "../../src/graph/ledger/types.ts";

/** The request one raise recorded or replayed — narrowing the verdict to its row. */
function raisedRequest(result: ApprovalRaiseResult): ApprovalRequestRecord {
  if (result.kind !== "raised" && result.kind !== "replayed") {
    throw new Error("fixture: the raise recorded no request (" + result.kind + ")");
  }
  return result.request;
}

/** The request one decision left behind — narrowing the verdict to its row. */
function decidedRequest(result: ApprovalDecideResult): ApprovalRequestRecord {
  if (result.kind === "absent") {
    throw new Error("fixture: there was no request to decide");
  }
  return result.request;
}

const tmpDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "approval-store-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

const GRAPH = "approval.store";
const RUN = "approval.store@1";
const PLAN = "plan.approval-store";
const AT = 1_700_000_000_000;
const DEADLINE = AT + 60_000;
const APPROVER = "session.approver";
const DECLARER = "session.declarer";

function request(overrides: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord {
  return Object.freeze({
    graphId: GRAPH,
    authority: approvalGrantFor(GRAPH, APPROVER),
    runId: RUN,
    nodeId: "work",
    attemptId: "work#1",
    status: "pending" as const,
    reason: "hold the work for sign-off",
    requestedAt: AT,
    requestedBy: Object.freeze({ sessionId: DECLARER, agentId: "agent.declarer" }),
    approverSessionId: APPROVER,
    expiresAt: DEADLINE,
    ...overrides,
  });
}

/** One acceptance batch for an attempt of GRAPH, as the acceptance core writes it. */
function acceptanceBatch(attemptId: string): GraphAcceptanceBatch {
  const submissionId = "submission:" + attemptId;
  return {
    receipt: {
      graphId: GRAPH,
      attemptId,
      submissionId,
      planRevision: PLAN,
      proposalDigest: "digest:" + attemptId,
      decision: "accepted",
      committedAt: AT,
    },
    acceptedEvent: {
      graphId: GRAPH,
      attemptId,
      submissionId,
      planRevision: PLAN,
      outcomeId: "done",
      acceptedAt: AT,
    },
  };
}

/** A store with the run identity the approval row is filed under. */
function openStore(dir: string): GraphStore {
  const store = GraphStore.openFile(dir);
  store.runs.mintRun({ graphId: GRAPH, runId: RUN, startedAt: AT, planRevision: PLAN });
  return store;
}

describe("graph store — the approval request row", () => {
  it("raises once, replays a repeated raise, and refuses a request for a settled attempt", () => {
    const dir = makeDir();
    const store = openStore(dir);
    try {
      const raiseVerdict = store.approvals.raiseApprovalRequest(request());
      expect(raiseVerdict.kind).toBe("raised");
      const raised = raisedRequest(raiseVerdict);
      expect(raised.status).toBe("pending");
      expect(raised.approverSessionId).toBe(APPROVER);
      expect(raised.requestedBy?.sessionId).toBe(DECLARER);

      // ONE ROW PER ATTEMPT: the primary key makes a second request
      // unrepresentable, so the repeat REPLAYS the persisted row.
      const againVerdict = store.approvals.raiseApprovalRequest(
        request({ reason: "a different reason", expiresAt: DEADLINE + 5_000 }),
      );
      expect(againVerdict.kind).toBe("replayed");
      const again = raisedRequest(againVerdict);
      expect(again.reason).toBe("hold the work for sign-off");
      expect(again.expiresAt).toBe(DEADLINE);
      expect(store.approvals.approvalRequestsOf(GRAPH)).toHaveLength(1);

      // THE GATE: a pending request blocks, an approved one does not, and an
      // attempt with no request is not gated at all.
      expect(store.approvals.blockingApproval(GRAPH, "work#1")?.status).toBe("pending");
      expect(store.approvals.blockingApproval(GRAPH, "work#2")).toBeUndefined();

      // A SETTLED ATTEMPT CANNOT BE PAUSED: the raising INSERT carries its own
      // accepted-event guard, so the refusal is decided against the committed
      // store rather than a value read earlier.
      expect(store.commitAccepted(acceptanceBatch("work#2")).kind).toBe("committed");
      const settled = store.approvals.raiseApprovalRequest(
        request({ attemptId: "work#2" }),
      );
      expect(settled.kind).toBe("settled");
      expect(store.approvals.readApprovalRequest(GRAPH, "work#2")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("decides one pending row, replays the same decision and conflicts with the opposite", () => {
    const dir = makeDir();
    const store = openStore(dir);
    try {
      // NOTHING TO DECIDE YET: an absent request is a verdict, not a throw.
      expect(
        store.approvals.decideApprovalRequest({
          graphId: GRAPH,
          runId: RUN,
          nodeId: "work",
          attemptId: "work#1",
          command: "approve",
          reason: "sign off",
          decidedAt: AT + 1,
          decidedBy: { sessionId: APPROVER },
        }).kind,
      ).toBe("absent");

      store.approvals.raiseApprovalRequest(request());
      const decidedVerdict = store.approvals.decideApprovalRequest({
        graphId: GRAPH,
        runId: RUN,
        nodeId: "work",
        attemptId: "work#1",
        command: "approve",
        reason: "reviewed",
        decidedAt: AT + 1,
        decidedBy: { sessionId: APPROVER, agentId: "agent.approver" },
      });
      expect(decidedVerdict.kind).toBe("decided");
      const decided = decidedRequest(decidedVerdict);
      expect(decided.status).toBe("approved");
      expect(decided.decidedAt).toBe(AT + 1);
      expect(decided.decidedBy?.sessionId).toBe(APPROVER);
      expect(decided.decisionReason).toBe("reviewed");
      // THE GATE IS OPEN — and only for an approved row.
      expect(store.approvals.blockingApproval(GRAPH, "work#1")).toBeUndefined();

      const repeatedVerdict = store.approvals.decideApprovalRequest({
        graphId: GRAPH,
        runId: RUN,
        nodeId: "work",
        attemptId: "work#1",
        command: "approve",
        reason: "sign off again",
        decidedAt: AT + 2,
        decidedBy: { sessionId: APPROVER },
      });
      expect(repeatedVerdict.kind).toBe("replayed");
      const repeated = decidedRequest(repeatedVerdict);
      expect(repeated.decidedAt).toBe(AT + 1);
      expect(repeated.decisionReason).toBe("reviewed");

      const oppositeVerdict = store.approvals.decideApprovalRequest({
        graphId: GRAPH,
        runId: RUN,
        nodeId: "work",
        attemptId: "work#1",
        command: "reject",
        reason: "changed my mind",
        decidedAt: AT + 3,
        decidedBy: { sessionId: APPROVER },
      });
      expect(oppositeVerdict.kind).toBe("conflict");
      expect(decidedRequest(oppositeVerdict).status).toBe("approved");
      expect(store.approvals.readApprovalRequest(GRAPH, "work#1")?.status).toBe("approved");
    } finally {
      store.close();
    }
  });

  it("expires a due request exactly once, and never rewrites a decided one", () => {
    const dir = makeDir();
    const store = openStore(dir);
    try {
      store.approvals.raiseApprovalRequest(request());
      store.approvals.raiseApprovalRequest(
        request({ attemptId: "work#2", expiresAt: DEADLINE + 10_000 }),
      );

      // NOT DUE YET: the sweep touches nothing.
      expect(store.approvals.expireDueApprovals(GRAPH, DEADLINE - 1, "reason")).toEqual([]);
      expect(store.approvals.readApprovalRequest(GRAPH, "work#1")?.status).toBe("pending");

      // DUE: exactly the row whose deadline passed.
      const expired = store.approvals.expireDueApprovals(GRAPH, DEADLINE, "reason");
      expect(expired.map((entry) => entry.attemptId)).toEqual(["work#1"]);
      expect(expired[0]?.status).toBe("expired");
      expect(expired[0]?.decidedAt).toBe(DEADLINE);
      // IDEMPOTENT AND TERMINAL: a second sweep at a later instant changes nothing.
      expect(store.approvals.expireDueApprovals(GRAPH, DEADLINE + 1_000, "reason")).toEqual([]);
      expect(store.approvals.readApprovalRequest(GRAPH, "work#1")?.status).toBe("expired");

      // AN EXPIRED REQUEST IS NEVER APPROVED: the decision materializes nothing
      // new and reports the status that stands.
      const lateVerdict = store.approvals.decideApprovalRequest({
        graphId: GRAPH,
        runId: RUN,
        nodeId: "work",
        attemptId: "work#1",
        command: "approve",
        reason: "too late",
        decidedAt: DEADLINE + 5_000,
        decidedBy: { sessionId: APPROVER },
      });
      expect(lateVerdict.kind).toBe("conflict");
      const late = decidedRequest(lateVerdict);
      expect(late.status).toBe("expired");
      expect(late.decidedAt).toBe(DEADLINE);

      // THE DECIDE-TIME EXPIRY: a decision stamped past the deadline expires the
      // row DURABLY even though the decision itself is refused.
      const expiredVerdict = store.approvals.decideApprovalRequest({
        graphId: GRAPH,
        runId: RUN,
        nodeId: "work",
        attemptId: "work#2",
        command: "approve",
        reason: "arrived after the deadline",
        decidedAt: DEADLINE + 10_000,
        decidedBy: { sessionId: APPROVER },
      });
      expect(expiredVerdict.kind).toBe("expired");
      const decided = decidedRequest(expiredVerdict);
      expect(decided.status).toBe("expired");
      expect(decided.decidedAt).toBe(DEADLINE + 10_000);
      expect(decided.decisionReason).toContain("approval deadline");
      expect(decided.decidedBy).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("expires every pending request of a stopped run, whatever its deadline", () => {
    const dir = makeDir();
    const store = openStore(dir);
    try {
      store.approvals.raiseApprovalRequest(request());
      store.approvals.raiseApprovalRequest(
        request({ attemptId: "work#2", expiresAt: DEADLINE + 10_000 }),
      );
      const expired = store.approvals.expireRunApprovals(GRAPH, RUN, AT + 5, "the run stopped");
      expect(expired.map((entry) => entry.attemptId).sort()).toEqual(["work#1", "work#2"]);
      expect(expired.every((entry) => entry.status === "expired")).toBe(true);
      expect(expired[0]?.decisionReason).toBe("the run stopped");
      // A DECIDED ROW IS NOT TOUCHED BY A LATER STOP.
      store.approvals.raiseApprovalRequest(request({ attemptId: "work#3" }));
      store.approvals.decideApprovalRequest({
        graphId: GRAPH,
        runId: RUN,
        nodeId: "work",
        attemptId: "work#3",
        command: "approve",
        reason: "signed off first",
        decidedAt: AT + 6,
        decidedBy: { sessionId: APPROVER },
      });
      expect(store.approvals.expireRunApprovals(GRAPH, RUN, AT + 7, "the run stopped")).toEqual([]);
      expect(store.approvals.readApprovalRequest(GRAPH, "work#3")?.status).toBe("approved");
    } finally {
      store.close();
    }
  });
});

describe("graph store — the acceptance gate is structural", () => {
  it("refuses a batch for a gated attempt and accepts it once the request is approved", () => {
    const dir = makeDir();
    const store = openStore(dir);
    try {
      store.approvals.raiseApprovalRequest(request());

      const blocked = store.commitAccepted(acceptanceBatch("work#1"));
      expect(blocked.kind).toBe("approval-blocked");
      if (blocked.kind !== "approval-blocked") throw new Error("fixture: expected blocked");
      expect(blocked.request.status).toBe("pending");
      expect(blocked.reason).toContain(APPROVER);
      expect(blocked.reason).toContain("CONTROL");
      // NOTHING WAS WRITTEN: no receipt, no accepted event.
      expect(
        store.lookupReceipt({
          graphId: GRAPH,
          attemptId: "work#1",
          submissionId: "submission:work#1",
        }),
      ).toBeUndefined();
      expect(store.acceptedEvents(GRAPH)).toEqual([]);

      store.approvals.decideApprovalRequest({
        graphId: GRAPH,
        runId: RUN,
        nodeId: "work",
        attemptId: "work#1",
        command: "approve",
        reason: "signed off",
        decidedAt: AT + 1,
        decidedBy: { sessionId: APPROVER },
      });
      // THE APPROVED GATE IS OPEN: the same batch now commits.
      expect(store.commitAccepted(acceptanceBatch("work#1")).kind).toBe("committed");
      expect(store.acceptedEvents(GRAPH).map((event) => event.attemptId)).toEqual(["work#1"]);
    } finally {
      store.close();
    }
  });

  it("refuses a batch for a rejected or expired attempt by the same rule", () => {
    const dir = makeDir();
    const store = openStore(dir);
    try {
      store.approvals.raiseApprovalRequest(request());
      store.approvals.decideApprovalRequest({
        graphId: GRAPH,
        runId: RUN,
        nodeId: "work",
        attemptId: "work#1",
        command: "reject",
        reason: "not acceptable",
        decidedAt: AT + 1,
        decidedBy: { sessionId: APPROVER },
      });
      const rejected = store.commitAccepted(acceptanceBatch("work#1"));
      expect(rejected.kind).toBe("approval-blocked");
      if (rejected.kind !== "approval-blocked") throw new Error("fixture: expected blocked");
      expect(rejected.request.status).toBe("rejected");

      store.approvals.raiseApprovalRequest(request({ attemptId: "work#2" }));
      store.approvals.expireDueApprovals(GRAPH, DEADLINE, "the deadline passed");
      const expired = store.commitAccepted(acceptanceBatch("work#2"));
      expect(expired.kind).toBe("approval-blocked");
      if (expired.kind !== "approval-blocked") throw new Error("fixture: expected blocked");
      expect(expired.request.status).toBe("expired");
      expect(store.acceptedEvents(GRAPH)).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("graph store — approval rows survive a restart, and the format gate knows them", () => {
  it("reads the same request and decision from a second connection", () => {
    const dir = makeDir();
    const first = openStore(dir);
    try {
      first.approvals.raiseApprovalRequest(request());
    } finally {
      first.close();
    }
    const second = GraphStore.openFile(dir);
    try {
      expect(second.approvals.readApprovalRequest(GRAPH, "work#1")).toMatchObject({
        status: "pending",
        approverSessionId: APPROVER,
        expiresAt: DEADLINE,
        requestedAt: AT,
      });
      second.approvals.decideApprovalRequest({
        graphId: GRAPH,
        runId: RUN,
        nodeId: "work",
        attemptId: "work#1",
        command: "approve",
        reason: "signed off after the restart",
        decidedAt: AT + 9,
        decidedBy: { sessionId: APPROVER },
      });
    } finally {
      second.close();
    }
    const third = GraphStore.openFile(dir);
    try {
      expect(third.approvals.readApprovalRequest(GRAPH, "work#1")).toMatchObject({
        status: "approved",
        decidedAt: AT + 9,
        decisionReason: "signed off after the restart",
      });
      // AN ALREADY-DECIDED REQUEST IS NOT RE-DECIDED by a fresh process.
      const repeatedVerdict = third.approvals.decideApprovalRequest({
        graphId: GRAPH,
        runId: RUN,
        nodeId: "work",
        attemptId: "work#1",
        command: "approve",
        reason: "again",
        decidedAt: AT + 10,
        decidedBy: { sessionId: APPROVER },
      });
      expect(repeatedVerdict.kind).toBe("replayed");
      expect(decidedRequest(repeatedVerdict).decidedAt).toBe(AT + 9);
    } finally {
      third.close();
    }
  });

  it("refuses a version-4 store as an older format: it holds no approval table", () => {
    const dir = makeDir();
    const store = openStore(dir);
    try {
      store.run(
        "UPDATE " + GRAPH_STORE_TABLES.meta + " SET format_version = 4 WHERE id = 1",
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

  it("refuses a decision row whose DDL shape the record model forbids", () => {
    const dir = makeDir();
    const store = openStore(dir);
    try {
      const insert =
        "INSERT INTO " +
        GRAPH_STORE_TABLES.approvalRequests +
        " (graph_id, run_id, node_id, attempt_id, status, reason, requested_at, requested_by_session, requested_by_agent, approver_session_id, expires_at, decided_by_session, decided_by_agent, decided_at, decision_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
      // A status outside the closed vocabulary.
      expect(() =>
        store.run(insert, GRAPH, RUN, "work", "work#1", "maybe", "r", AT, null, null, APPROVER, DEADLINE, null, null, null, null),
      ).toThrow();
      // A decided row with no decision time.
      expect(() =>
        store.run(insert, GRAPH, RUN, "work", "work#1", "approved", "r", AT, null, null, APPROVER, DEADLINE, APPROVER, null, null, "r"),
      ).toThrow();
      // An APPROVED row with no deciding session.
      expect(() =>
        store.run(insert, GRAPH, RUN, "work", "work#1", "approved", "r", AT, null, null, APPROVER, DEADLINE, null, null, AT, "r"),
      ).toThrow();
      // A blank approver session.
      expect(() =>
        store.run(insert, GRAPH, RUN, "work", "work#1", "pending", "r", AT, null, null, "", DEADLINE, null, null, null, null),
      ).toThrow();
      expect(store.approvals.approvalRequestsOf(GRAPH)).toEqual([]);
    } finally {
      store.close();
    }
  });
});
