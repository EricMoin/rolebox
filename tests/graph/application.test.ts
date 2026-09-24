import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphApplication } from "../../src/graph/application/graph-application.ts";
import type { OutcomeDispatchRequest, OutcomeDispatchEffectKey } from "../../src/graph/outcome/dispatch-effects.ts";
import type { CanonicalToolContext } from "../../src/platform/types.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { queryGraphs } from "../../src/graph/query/graph-query.ts";
import { renderGraphQuery } from "../../src/graph/query/render.ts";
import { projectEngineGraph } from "../../src/cli/commands/monitor/monitor-reader-engine.ts";

const roots: string[] = [];
const apps: GraphApplication[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  let failed = false;
  const root = mkdtempSync(join(tmpdir(), "graph-application-")); roots.push(root);
  const sent: { request: OutcomeDispatchRequest; effect: OutcomeDispatchEffectKey }[] = [];
  const app = GraphApplication.open({ workspaceDir: root, storeRoot: join(root, "store"), env: {},
    observeExecution: () => failed ? { kind: "failed", reason: "Host execution failed" } : { kind: "running" },
    declareInvocationIdentity: false, workerSessionOf: (execution) => execution.executionId,
    deliver: (request, effect) => { sent.push({ request, effect }); },
  }); apps.push(app);
  const tools = app.createTools();
  const call = async (name: string, args: Record<string, unknown>, sessionID = "parent") => {
    const context: CanonicalToolContext = { sessionID, messageID: "message", agent: "agent", directory: root, worktree: root,
      abort: new AbortController().signal, metadata() {}, async ask() {} };
    return JSON.parse(String(await tools[name]!.execute(args, context)));
  };
  return { root, sent, app, call, fail: () => { failed = true; } };
}
function chain(name: string) {
  return { version: 3, name, nodes: [
    { id: "work", agent: "worker", prompt: "Produce", outcomes: [{ id: "done" }] },
    { id: "review", agent: "reviewer", prompt: "Consume", inputs: [{ from: "work", outcome: "done" }], outcomes: [{ id: "done" }] },
  ], edges: [{ from: "work", to: "review", outcome: "done" }] };
}

describe("GraphApplication registered tools", () => {
  it("awaits start, hides credentials, authenticates workers and exposes one query across tool/audit/monitor", async () => {
    const { root, sent, app, call } = setup();
    const declared = await call("graph_declare", { declaration: chain("app.chain") });
    expect(declared.persisted).toBe(true);
    expect(declared.start.kind).toBe("started");
    expect(sent).toHaveLength(1);
    const first = sent[0]!;
    expect(JSON.stringify(declared)).not.toContain(first.request.credential);
    app.host.confirmExecution(first.effect, { executionId: "child-1" });
    const args = { graph_id: "app.chain", node_id: "work", outcome_id: "done", credential: first.request.credential };
    expect((await call("graph_submit_outcome", args, "intruder")).refusals[0]?.code).toBe("host-worker-session-mismatch");
    const accepted = await call("graph_submit_outcome", args, "child-1");
    expect(accepted.refusals.map((item: {code: string}) => item.code)).toEqual([]);
    expect(accepted.decision).toBe("accepted");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.request.inputs).toHaveLength(1);
    app.host.confirmExecution(sent[1]!.effect, { executionId: "child-2" });
    expect((await call("graph_submit_outcome", { ...args, node_id: "review", credential: sent[1]!.request.credential }, "child-2")).decision).toBe("accepted");
    const query = queryGraphs(join(root, "store")).graphs[0]!;
    const status = await call("graph_status", { graph_id: "app.chain", format: "json", include_history: true });
    const audit = await call("graph_audit", {});
    expect(status.phase).toBe("complete");
    expect(status.runs).toEqual(query.runs);
    expect(audit.entries[0].graph).toEqual(query);
    expect(projectEngineGraph(query).graph).toEqual(query);
    expect(status.budget.totals.executions).toBe(2);
    expect(JSON.stringify(status)).not.toContain(first.request.credential);
    expect(JSON.stringify(audit)).not.toContain(first.request.credential);
  });

  it("renders a selected historical run consistently and limits its attempts with its nodes", async () => {
    const { root, sent, app, call } = setup();
    await call("graph_declare", { declaration: chain("history") });
    for (let i = 0; i < 2; i++) {
      const item = sent[i]!;
      const session = `history-worker-${i}`;
      app.host.confirmExecution(item.effect, { executionId: session });
      expect((await call("graph_submit_outcome", {
        graph_id: "history", node_id: item.request.nodeId, outcome_id: "done", credential: item.request.credential,
      }, session)).decision).toBe("accepted");
    }
    const oldRun = queryGraphs(join(root, "store")).graphs[0]!.current!.runId;
    expect((await call("graph_control", { graph_id: "history", command: "retry", reason: "Run again" })).kind).toBe("applied");
    const query = queryGraphs(join(root, "store"));
    expect(query.graphs[0]!.phase).toBe("executing");
    const args = { graph_id: "history", run_id: oldRun, scope: "all" as const };
    const render = (extra: Parameters<typeof renderGraphQuery>[1]) => renderGraphQuery(query, { ...args, ...extra }, new Set());
    const tree = render({ format: "tree" });
    expect(tree).toContain("phase: stopped");
    expect(tree).toContain("work [settled]");
    expect(tree).toContain("review [settled]");
    const roots = render({ format: "tree", depth: 0 });
    expect(roots).toContain("work [settled]");
    expect(roots).not.toContain("review [settled]");
    expect(JSON.parse(render({ group_by: "agent" })).groups).toEqual([
      { key: "reviewer", count: 1 }, { key: "worker", count: 1 },
    ]);
    const limited = JSON.parse(render({ format: "json", limit: 1 }));
    expect(limited.nodes.map((node: { node_id: string }) => node.node_id)).toEqual(["review"]);
    expect(limited.attempts.map((attempt: { nodeId: string }) => attempt.nodeId)).toEqual(["review"]);
    expect(() => render({ run_id: "missing" })).toThrow("Unknown run");
  });

  it("persists host failure with effect settlement and recovers its observation without the original adapter", async () => {
    const { root, sent, app, call, fail } = setup();
    await call("graph_declare", { declaration: chain("failed") });
    app.host.confirmExecution(sent[0]!.effect, { executionId: "failed-worker" });
    fail();
    expect((await app.host.failObservedExecution("failed", "work", sent[0]!.request.attemptId))?.kind).toBe("applied");
    const graph = queryGraphs(join(root, "store")).graphs[0]!;
    expect(graph.phase).toBe("stopped");
    expect(graph.current?.unsettledEffects).toEqual([]);
    expect(graph.current?.attempts[0]?.accepted).toBeUndefined();
    expect(graph.current?.budget.unknownUsageAttempts).toBe(1);
    app.close();
    const reopened = GraphApplication.open({ workspaceDir: root, storeRoot: join(root, "store"), env: {}, deliver() {} });
    apps.push(reopened);
    expect(reopened.host.recordExecutionObservation("failed", sent[0]!.request.attemptId)).toEqual({ kind: "failed", reason: "Host execution failed" });
  });

  it("reports a durable declaration when its asynchronous start fails", async () => {
    const { root } = setup();
    const tools = createGraphToolSet({ stateDir: root, onGraphDeclared: async () => { throw new Error("platform unavailable"); } });
    const declared = await tools.graph_declare_and_start({ declaration: chain("blocked") }, "parent");
    expect(declared.persisted).toBe(true);
    expect(declared.start).toEqual({ kind: "blocked", reason: "platform unavailable" });
    expect(queryGraphs(join(root, ".rolebox", "state")).graphs[0]?.phase).toBe("ready");
  });

  it("reports start refusal without losing the saved declaration", async () => {
    const { app, call } = setup();
    const declaration = { ...chain("limited"), budget: { max_executions: 0 } };
    const declared = await call("graph_declare", { declaration });
    expect(declared.persisted).toBe(true);
    expect(declared.start.kind).toBe("refused");
    expect(declared.start.refusals.length).toBeGreaterThan(0);
    expect(JSON.parse(app.tools.graph_status({ graph_id: "limited", format: "json" })).phase).toBe("ready");
  });

  it("keeps concurrent graph attempts and origins separate", async () => {
    const { sent, call } = setup();
    await Promise.all([call("graph_declare", { declaration: chain("one") }, "parent-1"), call("graph_declare", { declaration: chain("two") }, "parent-2")]);
    expect(sent.map((item) => item.request.graphId).sort()).toEqual(["one", "two"]);
    expect((await call("graph_status", { scope: "all", format: "json" })).graphs).toHaveLength(2);
    expect((await call("graph_control", { graph_id: "one", command: "cancel", reason: "test" }, "parent-2")).kind).toBe("refused");
  });
});
