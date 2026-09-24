import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGraphControl, type GraphControlRequest } from "../../../src/graph/control/application.ts";
import type { GraphDeclarationV3 } from "../../../src/graph/compiler/declaration-v3.ts";
import { SqliteAcceptanceLedger } from "../../../src/graph/ledger/sqlite-ledger.ts";
import { OutcomeGraphRuntime, type OutcomeDispatchRequest } from "../../../src/graph/outcome/runtime.ts";
import { GraphStore } from "../../../src/graph/store/graph-store.ts";
import { GRAPH_STORE_TABLES } from "../../../src/graph/store/schema.ts";
import { buildDeclaredOutcomeGraph, persistDeclaredGraph } from "../../../src/graph/tools/declare-graph.ts";
import { approvalPolicyFor } from "../helpers/approval-policy.ts";
import { testHostCredentialIsolation } from "../helpers/credential-isolation.ts";
import { EMPTY_VALIDATORS, NOW, plainDeclaration } from "../helpers/host-graph-fixture.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(declaration: GraphDeclarationV3 = plainDeclaration()) {
  const root = mkdtempSync(join(tmpdir(), "control-quality-"));
  roots.push(root);
  const graph = buildDeclaredOutcomeGraph({ declaration });
  persistDeclaredGraph(graph, root);
  const store = GraphStore.openFile(root);
  const ledger = await SqliteAcceptanceLedger.create(root);
  const credentialIsolation = testHostCredentialIsolation(root);
  const requests: OutcomeDispatchRequest[] = [];
  const runtime = new OutcomeGraphRuntime({
    plan: graph.plan, ledger, validators: EMPTY_VALIDATORS, artifactRoot: root,
    credentialIsolation, dispatch: (request) => { requests.push(request); }, clock: () => NOW,
  });
  store.recordInvocationOrigin(graph.graphId, { sessionId: "declarer" }, NOW);
  expect(runtime.start().kind).toBe("started");
  const base = {
    graphId: graph.graphId, reason: "operator request", principal: { sessionId: "declarer" },
    at: NOW + 1, approvalPolicy: approvalPolicyFor(graph.graphId),
    retry: { credentialIsolation },
  };
  return {
    store, runtime, graphId: graph.graphId, requests,
    control: (request: Pick<GraphControlRequest, "command"> & Partial<GraphControlRequest>) =>
      applyGraphControl(store, { ...base, ...request }),
    close: () => { ledger.close(); store.close(); },
  };
}

describe("control transaction outcomes", () => {
  it.each([null, {}, { sessionId: 42 }, { sessionId: "" }])(
    "refuses malformed principal %j before writing", async (principal) => {
      const f = await fixture();
      try {
        expect(f.control({ command: "cancel", principal: principal as GraphControlRequest["principal"] }))
          .toMatchObject({ kind: "refused", refusals: [{ code: "control-principal-absent" }] });
        expect(f.store.runs.readRunControl(f.graphId)).toBeUndefined();
        expect(f.store.runs.controlDecisions(f.graphId)).toEqual([]);
      } finally { f.close(); }
    },
  );

  it.each(["other#2", "work#02"])("refuses a recorded retry with malformed successor %s", async (successor) => {
    const f = await fixture();
    try {
      expect(f.control({ command: "retry", nodeId: "work" }).kind).toBe("applied");
      f.store.run(
        `UPDATE ${GRAPH_STORE_TABLES.controlDecisions} SET successor_attempt_id = ? WHERE graph_id = ? AND command = 'retry'`,
        successor, f.graphId,
      );
      const state = f.runtime.state();
      expect(f.control({ command: "retry", nodeId: "work", attemptId: "work#1" })).toMatchObject({
        kind: "refused", refusals: [{ code: "run-state-unreadable" }],
      });
      expect(f.runtime.state()).toEqual(state);
    } finally { f.close(); }
  });

  it("refuses a reexecution order that points to a missing successor run", async () => {
    const f = await fixture();
    try {
      const request = f.requests[0];
      if (request === undefined) throw new Error("Expected entry dispatch");
      expect(f.runtime.submit({ nodeId: "work", outcomeId: "done", credential: request.credential }).kind).toBe("accepted");
      expect(f.control({ command: "retry" }).kind).toBe("applied");
      f.store.run(
        `UPDATE ${GRAPH_STORE_TABLES.runReexecutions} SET successor_run_id = ?, successor_started_at = ? WHERE graph_id = ?`,
        "missing-run", NOW + 2, f.graphId,
      );
      expect(f.control({ command: "retry" })).toMatchObject({
        kind: "refused", refusals: [{ code: "run-state-unreadable" }],
      });
    } finally { f.close(); }
  });

  it.each([
    { command: "cancel", nodeId: "work" },
    { command: "retry", nodeId: "missing" },
    { command: "approval-request", nodeId: "work" },
  ] as const)("rolls back the deadline sweep when $command is refused", async (request) => {
    const f = await fixture();
    try {
      expect(f.control({ command: "approval-request", nodeId: "work",
        approval: { approverSessionId: "session.approver", expiresAt: NOW + 10 },
      }).kind).toBe("applied");
      const before = f.store.approvals.approvalRequestsOf(f.graphId);
      expect(f.control({ ...request, at: NOW + 20 }).kind).toBe("refused");
      expect(f.store.approvals.approvalRequestsOf(f.graphId)).toEqual(before);
    } finally { f.close(); }
  });

  it("commits only the request expiry when a named approver arrives too late", async () => {
    const f = await fixture();
    try {
      expect(f.control({ command: "approval-request", nodeId: "work",
        approval: { approverSessionId: "session.approver", expiresAt: NOW + 10 },
      }).kind).toBe("applied");
      const result = f.control({ command: "approve", nodeId: "work", at: NOW + 20,
        principal: { sessionId: "session.approver" },
      });
      expect(result).toMatchObject({ kind: "refused", refusals: [{ code: "approval-expired" }] });
      expect(f.store.approvals.readApprovalRequest(f.graphId, "work#1")?.status).toBe("expired");
      expect(f.store.runs.controlDecisions(f.graphId).map((entry) => entry.command)).toEqual(["approval-request"]);
    } finally { f.close(); }
  });

  it("rolls back a retry reservation when the decisive write refuses settlement", async () => {
    const f = await fixture();
    const write = spyOn(f.store, "writeControlDecision").mockReturnValue({
      kind: "settled", attemptId: "work#1", runControl: undefined,
    });
    try {
      const before = f.store.budget.reservationsOf(f.graphId);
      const state = f.runtime.state();
      expect(f.control({ command: "retry", nodeId: "work" })).toMatchObject({
        kind: "refused", refusals: [{ code: "attempt-already-settled" }],
      });
      expect(f.store.budget.reservationsOf(f.graphId)).toEqual(before);
      expect(f.runtime.state()).toEqual(state);
      expect(f.store.runs.controlDecisions(f.graphId)).toEqual([]);
    } finally { write.mockRestore(); f.close(); }
  });

  it("rolls back earlier stop decisions when a later target refuses", async () => {
    const declaration = plainDeclaration();
    const work = declaration.nodes[0]!;
    const f = await fixture({ ...declaration, nodes: [work, { ...work, id: "review" }] });
    const original = f.store.writeControlDecision.bind(f.store);
    let calls = 0;
    const write = spyOn(f.store, "writeControlDecision").mockImplementation((input) =>
      ++calls === 2
        ? { kind: "settled", attemptId: input.decision.attemptId, runControl: undefined }
        : original(input),
    );
    try {
      expect(f.control({ command: "cancel" })).toMatchObject({ kind: "refused" });
      expect(f.store.runs.controlDecisions(f.graphId)).toEqual([]);
      expect(f.store.runs.readRunControl(f.graphId)).toBeUndefined();
    } finally { write.mockRestore(); f.close(); }
  });
});

describe("approval command boundaries", () => {
  it("refuses a null approval specification as a value", async () => {
    const f = await fixture();
    try {
      expect(f.control({ command: "approval-request", nodeId: "work",
        approval: null as unknown as GraphControlRequest["approval"],
      })).toMatchObject({ kind: "refused", refusals: [{ code: "approval-request-malformed" }] });
      expect(f.store.approvals.approvalRequestsOf(f.graphId)).toEqual([]);
    } finally { f.close(); }
  });

  it("refuses a new approval pause after a declared loop limit stopped the run", async () => {
    const f = await fixture({
      version: 3, name: "control.stopped-loop",
      nodes: [
        { id: "work", agent: "worker", prompt: "Work", outcomes: [{ id: "done" }] },
        { id: "review", agent: "reviewer", prompt: "Review", outcomes: [{ id: "revise" }, { id: "approve" }] },
        { id: "alpha", agent: "worker", prompt: "Parallel work", outcomes: [{ id: "done" }] },
      ],
      edges: [{ from: "work", to: "review", outcome: "done" }, { from: "review", to: "work", outcome: "revise" }],
      loop_groups: [{ id: "review-loop", nodes: ["work", "review"], max_traversals: 1,
        continuation_outcome: "revise", exit_outcome: "approve" }],
    });
    try {
      for (let step = 0; step < 8 && f.runtime.state()?.phase !== "stopped"; step += 1) {
        const node = f.runtime.state()?.nodes.find((entry) => entry.status === "dispatched" && entry.nodeId !== "alpha");
        const request = f.requests.find((entry) => entry.attemptId === node?.attemptId);
        if (request === undefined) throw new Error("Expected a loop dispatch");
        expect(f.runtime.submit({ nodeId: request.nodeId, credential: request.credential,
          outcomeId: request.nodeId === "work" ? "done" : "revise",
        }).kind).toBe("accepted");
      }
      expect(f.runtime.state()?.phase).toBe("stopped");
      expect(f.store.runs.readRunControl(f.graphId)).toBeUndefined();
      expect(f.control({ command: "approval-request", nodeId: "alpha",
        approval: { approverSessionId: "session.approver", expiresAt: NOW + 100 },
      })).toMatchObject({ kind: "refused", refusals: [{ code: "run-stopped" }] });
      expect(f.store.approvals.approvalRequestsOf(f.graphId)).toEqual([]);
    } finally { f.close(); }
  });
});
