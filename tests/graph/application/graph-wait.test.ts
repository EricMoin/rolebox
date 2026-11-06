import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphApplication } from "../../../src/graph/application/graph-application.ts";
import { GraphWait } from "../../../src/graph/application/graph-wait.ts";
import { queryGraphs } from "../../../src/graph/query/graph-query.ts";
import type { OutcomeDispatchRequest, OutcomeDispatchEffectKey } from "../../../src/graph/outcome/dispatch-effects.ts";
import type { CanonicalToolContext } from "../../../src/platform/types.ts";

const roots: string[] = [];
const closers: { close(): void }[] = [];
afterEach(() => {
  for (const closer of closers.splice(0).reverse()) closer.close();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "graph-wait-")); roots.push(root);
  const storeRoot = join(root, "store");
  const deliveries: { request: OutcomeDispatchRequest; effect: OutcomeDispatchEffectKey }[] = [];
  const app = GraphApplication.open({ workspaceDir: root, storeRoot, env: {
    ROLEBOX_GRAPH_APPROVAL_POLICY: JSON.stringify({ id: "review-policy", revision: "1", rules: [
      { graphId: "flow", nodeId: "work", approverSessions: ["reviewer"] },
    ] }),
  }, declareInvocationIdentity: false, workerSessionOf: execution => execution.executionId,
  observeExecution: () => ({ kind: "completed" }),
  deliver: (request, effect) => { deliveries.push({ request, effect }); } });
  const waiter = new GraphWait(storeRoot);
  closers.push(app, waiter);
  const tools = app.createTools();
  const call = async (name: string, args: Record<string, unknown>, sessionID = "parent") => {
    const context: CanonicalToolContext = { sessionID, messageID: "message", agent: "orchestrator",
      directory: root, worktree: root, abort: new AbortController().signal, metadata() {}, async ask() {} };
    return JSON.parse(String(await tools[name]!.execute(args, context)));
  };
  await call("graph_declare", { declaration: { version: 3, name: "flow", nodes: ["work", "review"].map(id => ({
    id, agent: "worker", prompt: "Private task instructions", outcomes: [{ id: "done",
      data: { schema: "json-object", version: 1 }, acceptance: [{ validator: "schema", version: 1 }] }],
  })), edges: [{ from: "work", to: "review", outcome: "done" }] } });
  const settle = async (index: number) => {
    const { request, effect } = deliveries[index]!;
    const child = `worker-${index}`;
    app.host.confirmExecution(effect, { executionId: child });
    expect((await call("graph_submit_outcome", { graph_id: "flow", node_id: request.nodeId,
      outcome_id: "done", credential: request.credential, data: { summary: `Result ${index}` } }, child)).decision).toBe("accepted");
  };
  const wait = (args: { run_id?: string; timeout_ms?: number; include_output?: boolean } = {}, signal = new AbortController().signal) =>
    waiter.wait({ graph_id: "flow", ...args }, "parent", signal);
  return { app, waiter, deliveries, storeRoot, call, settle, wait };
}

describe("graph wait", () => {
  it("waits through intermediate nodes and returns committed output to every waiter", async () => {
    const f = await fixture();
    let returned = false;
    const first = f.wait().then(result => { returned = true; return result; });
    const second = f.wait();
    await f.settle(0);
    expect(returned).toBe(false);
    await f.settle(1);
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe("complete");
    expect(b.run_id).toBe(a.run_id);
    expect(a.graph.attempts?.[0]?.result).toHaveProperty("payload", { kind: "value", value: { summary: "Result 0" } });
    expect(a.graph.nodes.every(node => node.status === "settled")).toBe(true);
    expect(JSON.stringify(a)).not.toContain("Private task instructions");
    expect(JSON.stringify(a)).not.toContain(f.deliveries[0]!.request.credential);
  });

  it("returns an already completed run after reopening, with optional output suppression", async () => {
    const f = await fixture(); await f.settle(0); await f.settle(1);
    const reopened = new GraphWait(f.storeRoot); closers.push(reopened);
    const result = await reopened.wait({ graph_id: "flow", include_output: false }, "parent", new AbortController().signal);
    expect(result.status).toBe("complete");
    expect(result.graph.attempts?.[0]?.result).not.toHaveProperty("payload");
  });

  it.each(["cancel", "timeout"] as const)("returns the %s control fact without waiting for unreachable successors", async command => {
    const f = await fixture();
    const waiting = f.wait();
    await f.call("graph_control", { graph_id: "flow", command, reason: "Stop requested",
      ...(command === "timeout" ? { node_id: "work" } : {}) });
    const result = await waiting;
    expect(result.status).toBe(command === "cancel" ? "stopped" : "attention");
    expect(result.reason).toContain(command);
    expect(result.graph.nodes.find(node => node.node_id === "review")?.status).toBe("pending");
  });

  it("returns an approval pause so the declaring session can take action", async () => {
    const f = await fixture(); const waiting = f.wait();
    await f.call("graph_control", { graph_id: "flow", command: "approval-request", node_id: "work",
      reason: "Review required", approver_session_id: "reviewer", expires_at: Date.now() + 60_000 });
    const result = await waiting;
    expect(result.status).toBe("attention");
    expect(result.notices[0]?.approvalStatus).toBe("pending");
  });

  it("reports a completed execution that never submitted an outcome as attention", async () => {
    const f = await fixture(); vi.useFakeTimers();
    const { request, effect } = f.deliveries[0]!;
    f.app.host.confirmExecution(effect, { executionId: "worker" });
    const waiting = f.wait();
    f.app.host.recordExecutionObservation("flow", request.attemptId);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await waiting;
    expect(result.status).toBe("attention");
    expect(result.reason).toContain("no outcome was settled");
  });

  it("times out only the wait and permits waiting again on the returned run", async () => {
    const f = await fixture(); vi.useFakeTimers();
    const waiting = f.wait({ timeout_ms: 50 });
    await vi.advanceTimersByTimeAsync(50);
    const timeout = await waiting;
    expect(timeout.status).toBe("timeout");
    expect(timeout.graph.decisions).toEqual([]);
    expect(f.deliveries).toHaveLength(1);
    vi.useRealTimers();
    const resumed = f.wait({ run_id: timeout.run_id });
    await f.settle(0); await f.settle(1);
    expect((await resumed).status).toBe("complete");
  });

  it.each(["abort", "already-aborted", "close"])("releases a wait on %s without stopping the graph", async mode => {
    const f = await fixture();
    const controller = new AbortController();
    if (mode === "already-aborted") controller.abort();
    const waiting = f.wait({}, controller.signal);
    if (mode === "abort") controller.abort();
    if (mode === "close") f.waiter.close();
    expect((await waiting).status).toBe("cancelled");
    expect(queryGraphs(f.storeRoot).graphs[0]?.current?.control).toBeUndefined();
    await f.settle(0); await f.settle(1);
  });

  it("isolates graphs by the host session and rejects unknown runs", async () => {
    const f = await fixture();
    await expect(f.waiter.wait({ graph_id: "flow" }, "other", new AbortController().signal)).rejects.toThrow("Unknown graph in this session");
    await expect(f.wait({ run_id: "missing" })).rejects.toThrow("Unknown graph run");
    await expect(f.waiter.wait({ graph_id: "flow" }, "", new AbortController().signal)).rejects.toThrow("host-supplied session");
  });

  it.each([0, -1, 540_001, 1.5, Number.NaN])("rejects invalid timeout %s before starting a wait", async timeout_ms => {
    const f = await fixture();
    await expect(f.wait({ timeout_ms })).rejects.toThrow("timeout_ms must be an integer");
  });

  it("keeps archived and current runs distinct across a retry", async () => {
    const f = await fixture(); await f.settle(0); await f.settle(1);
    const old = await f.wait();
    expect((await f.call("graph_control", { graph_id: "flow", command: "retry", reason: "Repeat" })).kind).toBe("applied");
    expect((await f.wait({ run_id: old.run_id })).run_id).toBe(old.run_id);
    const current = f.wait();
    await f.settle(2); await f.settle(3);
    const result = await current;
    expect(result.status).toBe("complete");
    expect(result.run_id).not.toBe(old.run_id);
  });

  it("observes a control committed by another process", async () => {
    const f = await fixture(); vi.useFakeTimers();
    const waiting = f.wait();
    const script = `import { GraphStore } from ${JSON.stringify(new URL("../../../src/graph/store/graph-store.ts", import.meta.url).href)};
      import { applyGraphControl } from ${JSON.stringify(new URL("../../../src/graph/control/application.ts", import.meta.url).href)};
      const store = GraphStore.openFile(process.argv[1]);
      try {
        const result = applyGraphControl(store, { graphId: "flow", command: "cancel", reason: "External stop",
          principal: { sessionId: "parent", agentId: "orchestrator" }, at: Date.now() });
        if (result.kind !== "applied") process.exitCode = 1;
      } finally { store.close(); }`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, f.storeRoot], { encoding: "utf8", timeout: 10_000 });
    expect(child.status, child.stderr).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await waiting;
    expect(result.status).toBe("stopped");
    expect(result.reason).toContain("External stop");
  });
});
