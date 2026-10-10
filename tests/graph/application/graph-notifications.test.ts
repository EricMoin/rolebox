import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphApplication } from "../../../src/graph/application/graph-application.ts";
import { GraphNotifications, type GraphNotification } from "../../../src/graph/application/graph-notifications.ts";
import { GraphStore } from "../../../src/graph/store/graph-store.ts";
import { GRAPH_STORE_TABLES } from "../../../src/graph/store/schema.ts";
import { queryGraphs } from "../../../src/graph/query/graph-query.ts";
import type { OutcomeDispatchRequest, OutcomeDispatchEffectKey } from "../../../src/graph/outcome/dispatch-effects.ts";
import type { CanonicalToolContext } from "../../../src/platform/types.ts";
import { naturalDeclaration, POLICY_BODY, POLICY_ID } from "../helpers/host-graph-fixture.ts";

const roots: string[] = [];
const closers: { close(): void }[] = [];
afterEach(() => {
  for (const closer of closers.splice(0).reverse()) closer.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(send?: (notification: GraphNotification) => Promise<boolean>) {
  const root = mkdtempSync(join(tmpdir(), "graph-notifications-")); roots.push(root);
  const storeRoot = join(root, "store");
  let now = Date.now();
  let failure = false;
  const received: GraphNotification[] = [];
  const requests: { request: OutcomeDispatchRequest; effect: OutcomeDispatchEffectKey }[] = [];
  const app = GraphApplication.open({ workspaceDir: root, storeRoot, env: {
    ROLEBOX_GRAPH_COMPLETION_POLICIES: JSON.stringify({ declare: [{ id: POLICY_ID, revision: "1", body: POLICY_BODY }], authorize: [POLICY_ID + "@1"] }),
    ROLEBOX_GRAPH_APPROVAL_POLICY: JSON.stringify({ id: "review-policy", revision: "1", rules: [
      { graphId: "flow", nodeId: "work", approverSessions: ["reviewer"] },
    ] }),
  }, declareInvocationIdentity: false, workerSessionOf: execution => execution.executionId,
  observeExecution: () => failure ? { kind: "failed", reason: "Worker failed" } : { kind: "completed" },
  deliver: (request, effect) => { requests.push({ request, effect }); },
  notifications: { clock: () => now, send: send ?? (async notification => {
    const graph = queryGraphs(storeRoot).graphs[0]!;
    expect(graph.runs.find(run => run.runId === notification.runId)).toBeDefined();
    received.push(notification); return true;
  }) } });
  closers.push(app);
  const tools = app.createTools();
  const call = async (name: string, args: Record<string, unknown>, sessionID = "parent") => {
    const context: CanonicalToolContext = { sessionID, messageID: "message", agent: "orchestrator",
      directory: root, worktree: root, abort: new AbortController().signal, metadata() {}, async ask() {} };
    return JSON.parse(String(await tools[name]!.execute(args, context)));
  };
  const declare = () => call("graph_declare", { declaration: { version: 3, name: "flow", nodes: [
    { id: "work", agent: "worker", prompt: "Work", outcomes: [{ id: "done" }] },
    { id: "review", agent: "reviewer", prompt: "Review", outcomes: [{ id: "done" }] },
  ], edges: [{ from: "work", to: "review", outcome: "done" }] } });
  const settle = async (index: number) => {
    const { request, effect } = requests[index]!;
    const child = `worker-${index}`;
    app.host.confirmExecution(effect, { executionId: child });
    const args = { graph_id: "flow", node_id: request.nodeId, outcome_id: "done", credential: request.credential };
    expect((await call("graph_submit_outcome", args, child)).decision).toBe("accepted");
    return { args, child };
  };
  return { app, received, requests, storeRoot, call, declare, settle,
    advance: () => { now += 65_000; }, clock: () => now, fail: () => { failure = true; } };
}

describe("durable graph notifications", () => {
  it("notifies once after the whole graph commits, remains quiet between nodes, and survives reopen", async () => {
    const f = fixture();
    await f.declare();
    await f.settle(0);
    await f.app.notifications!.flush();
    expect(f.received).toEqual([]);
    const final = await f.settle(1);
    await f.app.notifications!.flush();
    expect(f.received).toHaveLength(1);
    expect(f.received[0]).toMatchObject({ kind: "complete", graphId: "flow", sessionId: "parent", agent: "orchestrator" });
    expect(JSON.stringify(f.received)).not.toContain(f.requests[0]!.request.credential);
    await f.call("graph_submit_outcome", final.args, final.child);
    await f.app.notifications!.flush();
    f.app.close();
    const reopened = new GraphNotifications(f.storeRoot, { send: async n => { f.received.push(n); return true; } });
    closers.push(reopened);
    await reopened.flush();
    expect(f.received).toHaveLength(1);
  });

  it("gives a retried run a new completion notification", async () => {
    const f = fixture(); await f.declare(); await f.settle(0); await f.settle(1);
    await f.app.notifications!.flush();
    expect((await f.call("graph_control", { graph_id: "flow", command: "retry", reason: "Repeat" })).kind).toBe("applied");
    await f.settle(2); await f.settle(3); await f.app.notifications!.flush();
    expect(f.received.map(n => n.kind)).toEqual(["complete", "complete"]);
    expect(new Set(f.received.map(n => n.runId)).size).toBe(2);
  });

  it("reports a host-confirmed failure without an accepted outcome", async () => {
    const f = fixture(); await f.declare();
    const { request, effect } = f.requests[0]!;
    f.app.host.confirmExecution(effect, { executionId: "failed-worker" }); f.fail();
    await f.app.host.failObservedExecution("flow", "work", request.attemptId);
    await f.app.notifications!.flush();
    expect(f.received).toHaveLength(1);
    // ATTENTION, not `stopped`: the failure ended the ATTEMPT, claimed no run
    // control fact, and the run is still executing — so the notice names the
    // node and attempt it ended instead of announcing a stopped run.
    expect(f.received[0]).toMatchObject({ kind: "attention", nodeId: "work", attemptId: request.attemptId });
    expect(f.received[0]!.reason).toContain("failure");
    expect(f.received[0]!.reason).toContain("The run continues");
    // ONE notification with a stable id: a second flush and a fresh host add none.
    const id = f.received[0]!.id;
    await f.app.notifications!.flush();
    expect(f.received.map(notification => notification.id)).toEqual([id]);
    f.app.close();
    const reopened = new GraphNotifications(f.storeRoot, {
      clock: f.clock, send: async notification => { f.received.push(notification); return true; } });
    closers.push(reopened);
    await reopened.flush();
    expect(f.received.map(notification => notification.id)).toEqual([id]);
  });

  it("discards a stopped attempt's pending reminder once a retry mints a successor", async () => {
    const failed: GraphNotification[] = [];
    const f = fixture(async notification => { failed.push(notification); return false; });
    await f.declare();
    const { request, effect } = f.requests[0]!;
    f.app.host.confirmExecution(effect, { executionId: "failed-worker" }); f.fail();
    await f.app.host.failObservedExecution("flow", "work", request.attemptId);
    await f.app.notifications!.flush();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ kind: "attention", attemptId: request.attemptId });
    // The node is carried forward: the successor attempt makes the reminder
    // OBSOLETE, so it is discarded rather than retried against a live node.
    expect((await f.call("graph_control", { graph_id: "flow", command: "retry", node_id: "work", reason: "Try again" })).kind).toBe("applied");
    f.advance();
    await f.app.notifications!.flush(); await f.app.notifications!.flush();
    expect(failed).toHaveLength(1);
  });

  it("reports an attempt-scoped timeout the same way as a failure", async () => {
    const f = fixture(); await f.declare();
    const { request } = f.requests[0]!;
    // The SAME predicate classifies the sibling stop: `timeout` ends one
    // attempt and claims no run control fact either.
    expect((await f.call("graph_control", { graph_id: "flow", command: "timeout", node_id: "work", reason: "Stop requested" })).kind).toBe("applied");
    await f.app.notifications!.flush(); await f.app.notifications!.flush();
    expect(f.received).toHaveLength(1);
    expect(f.received[0]).toMatchObject({ kind: "attention", nodeId: "work", attemptId: request.attemptId });
    expect(f.received[0]!.reason).toContain("timeout");
  });

  it("reports a completed execution whose attempt was never settled", async () => {
    const f = fixture(); await f.declare();
    const { request, effect } = f.requests[0]!;
    f.app.host.confirmExecution(effect, { executionId: "finished-worker" });
    // A dispatched attempt is not yet a reportable one: nothing has ended.
    await f.app.notifications!.flush();
    expect(f.received).toEqual([]);
    expect(f.app.host.recordExecutionObservation("flow", request.attemptId).kind).toBe("completed");
    await f.app.notifications!.flush();
    expect(f.received).toHaveLength(1);
    expect(f.received[0]).toMatchObject({ kind: "attention", nodeId: "work", attemptId: request.attemptId });
    expect(f.received[0]!.reason).toContain("no outcome was settled");
    expect(f.received[0]!.reason).toContain("the attempt stays open");
    await f.app.notifications!.flush();
    expect(f.received).toHaveLength(1);
  });

  it("notifies natural completion through the host callback without a worker submission", async () => {
    const f = fixture();
    const declaration = naturalDeclaration();
    expect((await f.call("graph_declare", { declaration })).start.kind).toBe("started");
    for (let index = 0; index < 2; index++) {
      const { request, effect } = f.requests[index]!;
      f.app.host.confirmExecution(effect, { executionId: `natural-${index}` });
      await f.app.host.complete(declaration.name, request.attemptId);
      await f.app.notifications!.flush();
      expect(f.received).toHaveLength(index);
    }
    expect(f.received[0]!.kind).toBe("complete");
  });

  it.each(["cancel", "budget-stop"])("notifies a %s stop once", async command => {
    const f = fixture(); await f.declare();
    expect((await f.call("graph_control", { graph_id: "flow", command, reason: "Stop requested" })).kind).toBe("applied");
    await f.app.notifications!.flush(); await f.app.notifications!.flush();
    expect(f.received).toHaveLength(1);
    expect(f.received[0]).toMatchObject({ kind: "stopped", reason: `${command}: Stop requested` });
  });

  it("reports an asynchronous launch failure that leaves execution ownership unresolved", async () => {
    const f = fixture(); await f.declare();
    f.app.host.reportDeliveryFailure(f.requests[0]!.effect, "platform unavailable");
    await f.app.notifications!.flush();
    expect(f.received).toHaveLength(1);
    expect(f.received[0]).toMatchObject({ kind: "attention", nodeId: "work" });
  });

  it("retries unavailable delivery after reopening and keeps the stable notification id", async () => {
    const failed: GraphNotification[] = [];
    const f = fixture(async n => { failed.push(n); return false; });
    await f.declare(); await f.settle(0); await f.settle(1); await f.app.notifications!.flush();
    expect(failed).toHaveLength(1); f.app.close();
    const delivered: GraphNotification[] = [];
    const reopened = new GraphNotifications(f.storeRoot, { clock: f.clock, send: async n => { delivered.push(n); return true; } });
    closers.push(reopened);
    await reopened.flush(); expect(delivered).toEqual([]);
    f.advance(); await reopened.flush(); await reopened.flush();
    expect(delivered.map(n => n.id)).toEqual([failed[0]!.id]);
  });

  it("a throwing notification transport cannot prevent a terminal graph from being retried", async () => {
    const f = fixture(async () => { throw new Error("transport unavailable"); });
    await f.declare(); await f.settle(0); await f.settle(1); await f.app.notifications!.flush();
    expect(queryGraphs(f.storeRoot).graphs[0]!.phase).toBe("complete");
    expect((await f.call("graph_control", { graph_id: "flow", command: "retry", reason: "Repeat despite notification failure" })).kind).toBe("applied");
    expect(queryGraphs(f.storeRoot).graphs[0]!.current!.runSeq).toBe(2);
  });

  it("rolls back notification intent with the state and never sends an uncommitted completion", async () => {
    const f = fixture(); await f.declare();
    const store = GraphStore.openFile(f.storeRoot); closers.push(store);
    const state = store.readGraphState("flow")!;
    const unsubscribe = store.observeTransactions({ beforeCommit() { throw new Error("commit refused"); }, afterCommit() {} });
    try {
      expect(() => store.transaction(() => store.writeGraphState({ ...state,
        body: { ...state.body as object, phase: "complete" },
      }))).toThrow("commit refused");
    } finally { unsubscribe(); }
    await f.app.notifications!.flush();
    expect(f.received).toEqual([]);
    expect(store.all(`SELECT * FROM ${GRAPH_STORE_TABLES.pendingEffects} WHERE kind = 'graph-notification'`)).toEqual([]);
  });

  it("an unreadable unrelated graph does not stop a healthy graph's state commit or notification", async () => {
    const f = fixture(); await f.declare();
    await f.call("graph_declare", { declaration: { version: 3, name: "unreadable", nodes: [
      { id: "work", agent: "worker", prompt: "Work", outcomes: [{ id: "done" }] },
    ], edges: [] } });
    const store = GraphStore.openFile(f.storeRoot); closers.push(store);
    store.run(`UPDATE ${GRAPH_STORE_TABLES.definitions} SET plan = '{}' WHERE graph_id = 'unreadable'`);
    await f.settle(0); await f.settle(2); await f.app.notifications!.flush();
    expect(f.received).toHaveLength(1);
    expect(f.received[0]).toMatchObject({ graphId: "flow", kind: "complete" });
  });

  it("notifies approval attention and discards an obsolete pending reminder on retry", async () => {
    const failed: GraphNotification[] = [];
    const f = fixture(async n => { failed.push(n); return false; }); await f.declare();
    const raised = await f.call("graph_control", { graph_id: "flow", command: "approval-request", node_id: "work",
      reason: "Review required", approver_session_id: "reviewer", expires_at: Date.now() + 300_000 });
    expect(raised.kind).toBe("applied"); await f.app.notifications!.flush();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ kind: "attention", approvalStatus: "pending", sessionId: "parent" });
    expect((await f.call("graph_control", { graph_id: "flow", command: "approve", node_id: "work", reason: "Reviewed" }, "reviewer")).kind).toBe("applied");
    f.advance(); await f.app.notifications!.flush();
    expect(failed).toHaveLength(1);
  });

  it("leases delivery across two hosts so a concurrent sender cannot duplicate an in-flight notification", async () => {
    let finish: ((value: boolean) => void) | undefined;
    const sent: GraphNotification[] = [];
    const f = fixture(async n => { sent.push(n); return new Promise<boolean>(resolve => { finish = resolve; }); });
    await f.declare(); await f.settle(0); await f.settle(1);
    expect(sent).toHaveLength(1);
    const other: GraphNotification[] = [];
    const competing = new GraphNotifications(f.storeRoot, { clock: f.clock, send: async n => { other.push(n); return true; } });
    closers.push(competing);
    await competing.flush(); expect(other).toEqual([]);
    finish!(true); await f.app.notifications!.flush(); await competing.flush();
    expect(other).toEqual([]); expect(sent).toHaveLength(1);
  });

  it("a fresh process recovers an abandoned delivery lease and persists its acknowledgement", async () => {
    const f = fixture(async () => false);
    await f.declare(); await f.settle(0); await f.settle(1); await f.app.notifications!.flush(); f.app.close();
    const store = GraphStore.openFile(f.storeRoot);
    const row = store.all(`SELECT effect_id, payload FROM ${GRAPH_STORE_TABLES.pendingEffects} WHERE kind = 'graph-notification'`)[0]!;
    store.run(`UPDATE ${GRAPH_STORE_TABLES.pendingEffects} SET status = 'started', payload = ? WHERE effect_id = ?`,
      JSON.stringify({ ...JSON.parse(String(row.payload)), retryAt: 0, owner: "previous-process", leaseUntil: f.clock() + 60_000 }), row.effect_id);
    store.close();
    const script = `import { GraphNotifications } from ${JSON.stringify(new URL("../../../src/graph/application/graph-notifications.ts", import.meta.url).href)};
      const sent = [];
      const notifier = new GraphNotifications(process.argv[1], { clock: () => Number(process.argv[2]), send: async n => { sent.push(n.id); return true; } });
      await notifier.flush(); notifier.close(); console.log(JSON.stringify(sent));`;
    const check = async () => {
      // The probe names its module and store by absolute path, so its working
      // directory is irrelevant to what it proves — and running it from the
      // store directory instead of the checkout keeps an environment-level
      // `bun` startup notice about an unreadable ancestor directory out of the
      // stderr this assertion reads. What the child must produce is unchanged.
      // `env` is explicit: a bare `Bun.spawn` under `bun test --isolate` gets
      // the start-time OS environ, not this process's `process.env` — the
      // preload's ROLEBOX_LOG_DIR (tests/helpers/log-dir-preload.ts) included,
      // so the child would resolve and append to the workspace's `.rolebox/logs`.
      const child = Bun.spawn([process.execPath, "--eval", script, f.storeRoot, String(f.clock())],
        { env: { ...process.env }, cwd: f.storeRoot, stdout: "pipe", stderr: "pipe" });
      const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, error }).toEqual({ code: 0, error: "" });
      return JSON.parse(output);
    };
    expect(await check()).toEqual([]);
    f.advance(); expect(await check()).toEqual([row.effect_id]);
    expect(await check()).toEqual([]);
  });
});

// ── A RECORDED `complete` OVER PENDING NODES IS NOT A COMPLETION ────────────
//
// A version-9 body stays readable and one of those can say `complete` while the
// run still holds PENDING nodes — the shape that used to be announced as "All
// activated graph work completed.". The notice now names the nodes with kind
// `stopped`, and it is a NEW effect (`pending:<nodes>`), so a store where the
// old build already recorded (and sent) its `terminal` completion still
// surfaces it: `obsolete()` discards an `attention` notice for a run the view
// already calls `complete`, and this notice is deliberately not one.

const LEGACY_GRAPH_ID = "legacy-complete-over-pending";

/**
 * The shape a previous build wrote a version-9 `complete` body for: `entry`
 * settles its declared TERMINAL `failed`, which binds no edge, so `verify` and
 * `ship` are still pending when the run ends.
 */
function legacyCompleteOverPendingDeclaration() {
  return {
    version: 3,
    name: LEGACY_GRAPH_ID,
    nodes: [
      { id: "entry", agent: "worker", prompt: "Entry", outcomes: [{ id: "done" }, { id: "failed" }], completion: { mode: "explicit" } },
      { id: "verify", agent: "verifier", prompt: "Verify", outcomes: [{ id: "pass" }], completion: { mode: "explicit" }, inputs: [{ from: "entry", outcome: "done" }] },
      { id: "ship", agent: "shipper", prompt: "Ship", outcomes: [{ id: "shipped" }], completion: { mode: "explicit" }, inputs: [{ from: "verify", outcome: "pass" }] },
    ],
    edges: [
      { from: "entry", to: "verify", outcome: "done" },
      { from: "verify", to: "ship", outcome: "pass" },
    ],
  };
}

describe("a body that says complete while nodes are still pending", () => {
  it("announces it as a stopped run naming the pending nodes instead of a completion", async () => {
    const f = fixture();
    await f.call("graph_declare", { declaration: legacyCompleteOverPendingDeclaration() });
    const { request, effect } = f.requests[0]!;
    f.app.host.confirmExecution(effect, { executionId: "entry-worker" });
    const settled = await f.call("graph_submit_outcome", {
      graph_id: LEGACY_GRAPH_ID, node_id: "entry", outcome_id: "failed", credential: request.credential,
    }, "entry-worker");
    expect(settled.decision).toBe("accepted");
    // This build already reports that shape honestly; this case is about the
    // body the PREVIOUS build persisted, so start from the notices it produced.
    await f.app.notifications!.flush();
    const before = f.received.map(notification => notification.id);

    // REWRITE the persisted run state into the version-9 body the previous
    // build wrote: phase `complete`, no stop record, nodes still pending.
    const store = GraphStore.openFile(f.storeRoot); closers.push(store);
    const record = store.readGraphState(LEGACY_GRAPH_ID)!;
    const body = record.body as { phase: string; nodes: { nodeId: string; status: string }[] };
    expect(body.phase).toBe("stopped");
    // Plan order is by node id, so the stranded nodes read `ship`, `verify`.
    expect(body.nodes.filter(node => node.status === "pending").map(node => node.nodeId).sort())
      .toEqual(["ship", "verify"]);
    // The previous build's body carried no stop record at all: the key is
    // DROPPED rather than written as `undefined`, which the ledger refuses.
    const legacyBody: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key !== "stop") legacyBody[key] = value;
    }
    legacyBody.bodyVersion = 9;
    legacyBody.phase = "complete";
    store.writeGraphState({ ...record, body: legacyBody });
    await f.app.notifications!.flush();

    const legacy = f.received.filter(notification => !before.includes(notification.id));
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({ kind: "stopped", graphId: LEGACY_GRAPH_ID, sessionId: "parent" });
    expect(legacy[0]!.reason).toContain("recorded as complete");
    expect(legacy[0]!.reason).toContain("verify");
    expect(legacy[0]!.reason).toContain("ship");
    // NOT re-announced as finished work, on this flush or a later one.
    expect(f.received.filter(notification => notification.kind === "complete")).toEqual([]);
    await f.app.notifications!.flush();
    expect(f.received.filter(notification => notification.kind === "complete")).toEqual([]);
    expect(f.received.map(notification => notification.id)).toEqual([...before, legacy[0]!.id]);
  });

  it("still announces genuine completion when no node is pending", async () => {
    const f = fixture();
    await f.declare();
    await f.settle(0);
    await f.settle(1);
    await f.app.notifications!.flush();
    expect(f.received.map(notification => notification.kind)).toEqual(["complete"]);
    expect(f.received[0]!.reason).toBe("All activated graph work completed.");
  });
});
