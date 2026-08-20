/**
 * Graph Execution Engine v2 — fan-in/fan-out scale + duplicate/contradictory
 * wiring through the public tools.
 *
 * Follow-on to the degenerate-topologies subtask: reuses the scripted-dispatch
 * fake harness (`tests/graph/helpers/scripted-dispatch.ts`) — a `NodeDispatchPort`
 * fake that AUTO-COMPLETES every dispatched task via its `onTaskTerminated`
 * listener and records per-node dispatch counts. The tool set is driven exactly
 * as a model would: `GraphToolSet({ dispatch: <fake> })` → `graph_create` →
 * `graph_add_node` → `graph_add_edge` → `graph_run` → `graph_status`.
 *
 * Cases under test:
 *
 *  (a) MASSIVE FAN-OUT: one root always-edge to 25 leaves. All 25 leaves are
 *      dispatched (25 unique leaf dispatch calls) after the root's single
 *      answer, every node completes, phase Complete.
 *
 *  (b) MASSIVE FAN-IN: 25 independent roots always-edge into one sink with
 *      `join {strategy:"all"}`. The sink's join accumulates upstream results via
 *      `collectUpstreamResults` (join-evaluator.ts:357-365) and only dispatches
 *      once the 25th answer arrives — sink dispatch count === 1 (and its call
 *      is the LAST dispatch, after all 25 roots), phase Complete.
 *
 *  (c) UNSATISFIABLE QUORUM: sink with `join {strategy:"quorum", quorum:3}` fed
 *      by only 2 upstreams. `evaluateJoin` returns `failed` once the quorum
 *      becomes impossible (join-evaluator.ts:249: `answerCount + pendingCount
 *      < n`), so the sink never activates; after both upstreams complete, the
 *      runtime deadlock guard (engine-termination.ts) escalates the sink with
 *      "graph deadlock" and the graph completes. Assert the sink was never
 *      dispatched.
 *
 *  (d) DUPLICATE / CONTRADICTORY EDGES: A→B twice — `always` + `on_signal(answer)`.
 *      Both edges activate on A's answer, but the reEnter guard
 *      (engine-advance.ts:2025-2028, `isPendingActivation = status === Pending`)
 *      keeps B from being re-marked `ready` after the first edge's
 *      `markReady` — B dispatches EXACTLY once, phase Complete (pin: no
 *      duplicate dispatch).
 *
 *  (e) EDGE RETRY no-op: an always edge with `retry {max: 0}` plus a scripted
 *      escalate from A. The retry gate (signal-propagation.ts:256-257,
 *      `findRetryEdge` requires `retry.max > 0`) no-ops, so A is NOT
 *      re-dispatched; the escalate propagates forward into the fan-in
 *      convergence node S, whose `all`-join fails → S escalates with the same
 *      reason → every node is terminal → phase Complete.
 *
 *      NOTE (finding): the strictly minimal single-edge variant (A→B `always`
 *      with `retry {max:0}`, B single-input) does NOT reach Complete — B stays
 *      `pending` (single-input escalate pass-through) and the F3 dead-end
 *      predicate deliberately excludes always-edges (engine-advance.ts:1608,
 *      pinned by engine-terminal.test.ts "does NOT deadlock-terminate a graph
 *      with an escalated node and a pending downstream"), so the graph would
 *      sit in `executing`. The fan-in topology below is the minimal shape in
 *      which the escalation reaches a join that fails — making "escalate
 *      propagates" and "phase Complete" both observable.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import { GraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { clearParentQueues } from "../../src/dispatch/notification.ts";
import { ScriptedDispatch, settle } from "./helpers/scripted-dispatch.ts";
import type { NodeRuntimeState } from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type {
  DispatchParentContext,
  TaskTerminatedCallback,
} from "../../src/graph/engine/dispatch-bridge.ts";
import type { NodeDispatchPort } from "../../src/graph/engine/engine-advance.ts";

const DEADLOCK_REASON = "graph deadlock: no active upstream can satisfy pending node(s)";

/**
 * Scripted-dispatch variant for case (e): tasks for node ids in `fail` are
 * terminated with dispatch status `"error"` instead of `"completed"`, which
 * `mapDispatchStatusToSignal` (engine-recovery.ts:241-245) maps to the
 * `escalate` terminating signal — the engine's public dispatch→signal seam,
 * exactly like a real worker that errored out. The task's status is flipped
 * BEFORE the listener fires so the transient-error guard
 * (`isDispatchTaskLive`, engine-recovery.ts:286-293) sees a non-live task and
 * lets the escalate through.
 */
class EscalatingDispatch implements NodeDispatchPort {
  calls: { nodeId: string; prompt: string }[] = [];
  private subs = new Map<string, TaskTerminatedCallback>();
  private tasks = new Map<string, DispatchTask>();
  private readonly fail = new Set<string>();
  private seq = 0;

  constructor(fail?: Iterable<string>) {
    if (fail) for (const id of fail) this.fail.add(id);
  }

  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push({ nodeId: node.nodeId, prompt: node.prompt });
    const id = `task-${node.nodeId}-${++this.seq}`;
    const task: DispatchTask = {
      id,
      sessionId: `sess-${id}`,
      parentSessionId: "g",
      depth: 1,
      status: "running",
      agent: node.agent,
      prompt: node.prompt,
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
    };
    this.tasks.set(id, task);
    setTimeout(() => {
      if (this.fail.has(node.nodeId)) {
        task.status = "error";
        task.error = "scripted boom";
        this.subs.get(id)?.(id, "error");
      } else {
        task.status = "completed";
        this.subs.get(id)?.(id, "completed");
      }
    }, 0);
    return Promise.resolve(task);
  }

  onTaskTerminated(
    taskId: string,
    cb: TaskTerminatedCallback,
  ): TaskTerminatedCallback {
    this.subs.set(taskId, cb);
    return cb;
  }

  removeTaskTerminatedListener(
    taskId: string,
    cb: TaskTerminatedCallback,
  ): void {
    if (this.subs.get(taskId) === cb) this.subs.delete(taskId);
  }

  getTask(taskId: string): DispatchTask | undefined {
    return this.tasks.get(taskId);
  }

  /** How many times `nodeId` was dispatched. */
  dispatches(nodeId: string): number {
    return this.calls.filter((c) => c.nodeId === nodeId).length;
  }

  /** Total dispatch count across every node. */
  get dispatchCount(): number {
    return this.calls.length;
  }
}

/** Parse `graph_status({ format: "json" })` into a typed shape. */
function statusJson(ts: GraphToolSet, graphId: string) {
  const out = ts.graph_status({ graph_id: graphId, format: "json" });
  return JSON.parse(out) as {
    phase: string;
    nodes: { node_id: string; status: string; error?: string }[];
  };
}

const byId = (
  json: ReturnType<typeof statusJson>,
) => new Map(json.nodes.map((n) => [n.node_id, n]));

describe("graph scale + duplicate/contradictory wiring", () => {
  beforeEach(() => {
    clearParentQueues();
  });

  it("(a) massive fan-out: 1 root always-edge to 25 leaves — 25 unique leaf dispatches, all complete, phase Complete", async () => {
    const fake = new ScriptedDispatch();
    const ts = new GraphToolSet({ dispatch: fake });
    const g = ts.graph_create({ name: "fanout-25" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "root", agent: "a", prompt: "p-root" });
    for (let i = 0; i < 25; i++) {
      ts.graph_add_node({ graph_id: g.graph_id, id: `L${i}`, agent: "a", prompt: `p-L${i}` });
      ts.graph_add_edge({ graph_id: g.graph_id, from: "root", to: `L${i}`, type: "always" });
    }

    await ts.graph_run({ graph_id: g.graph_id });
    await settle();

    // Exactly one root dispatch + exactly one dispatch per leaf (no dupes):
    // 25 unique leaf dispatch calls out of 26 total.
    expect(fake.dispatches("root")).toBe(1);
    const leafCalls = fake.calls.filter((c) => c.nodeId !== "root");
    expect(leafCalls).toHaveLength(25);
    expect(new Set(leafCalls.map((c) => c.nodeId)).size).toBe(25);
    expect(fake.dispatchCount).toBe(26);

    const json = statusJson(ts, g.graph_id);
    expect(json.phase).toBe(EnginePhase.Complete);
    expect(json.nodes).toHaveLength(26);
    expect(json.nodes.every((n) => n.status === NodeStatus.Completed)).toBe(true);
  });

  it("(b) massive fan-in: 25 independent roots always-edge into 1 sink (join all) — sink dispatches exactly once, after the 25th answer", async () => {
    const fake = new ScriptedDispatch();
    const ts = new GraphToolSet({ dispatch: fake });
    const g = ts.graph_create({ name: "fanin-25" });
    for (let i = 0; i < 25; i++) {
      ts.graph_add_node({ graph_id: g.graph_id, id: `R${i}`, agent: "a", prompt: `p-R${i}` });
    }
    ts.graph_add_node({
      graph_id: g.graph_id,
      id: "sink",
      agent: "s",
      prompt: "p-sink",
      join: { strategy: "all" },
    });
    for (let i = 0; i < 25; i++) {
      ts.graph_add_edge({ graph_id: g.graph_id, from: `R${i}`, to: "sink", type: "always" });
    }

    await ts.graph_run({ graph_id: g.graph_id });
    await settle();

    // The all-join accumulates one upstream result per answer
    // (collectUpstreamResults, join-evaluator.ts:357-365) and activates the
    // sink only on the 25th — sink dispatched EXACTLY once, and its dispatch
    // is the LAST call (after all 25 roots were dispatched).
    expect(fake.dispatches("sink")).toBe(1);
    expect(fake.calls.at(-1)!.nodeId).toBe("sink");
    const rootCalls = fake.calls.slice(0, -1);
    expect(rootCalls).toHaveLength(25);
    expect(new Set(rootCalls.map((c) => c.nodeId)).size).toBe(25);
    expect(fake.dispatchCount).toBe(26);

    const json = statusJson(ts, g.graph_id);
    expect(json.phase).toBe(EnginePhase.Complete);
    expect(json.nodes.every((n) => n.status === NodeStatus.Completed)).toBe(true);
  });

  it("(c) unsatisfiable quorum: sink quorum:3 fed by only 2 upstreams never activates; deadlock guard escalates it, phase Complete", async () => {
    const fake = new ScriptedDispatch();
    const ts = new GraphToolSet({ dispatch: fake });
    const g = ts.graph_create({ name: "quorum-impossible" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "U1", agent: "a", prompt: "p-U1" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "U2", agent: "a", prompt: "p-U2" });
    ts.graph_add_node({
      graph_id: g.graph_id,
      id: "sink",
      agent: "s",
      prompt: "p-sink",
      join: { strategy: "quorum", quorum: 3 },
    });
    ts.graph_add_edge({ graph_id: g.graph_id, from: "U1", to: "sink", type: "always" });
    ts.graph_add_edge({ graph_id: g.graph_id, from: "U2", to: "sink", type: "always" });

    await ts.graph_run({ graph_id: g.graph_id });
    await settle();

    // evaluateJoin turns `failed` once the quorum is unreachable
    // (join-evaluator.ts:249: answerCount + pendingCount < 3) — the sink never
    // becomes ready, so it is never dispatched. After both upstreams complete,
    // the runtime deadlock guard escalates the pending sink with the guard's
    // reason and the graph completes.
    expect(fake.dispatches("sink")).toBe(0);
    expect(fake.dispatchCount).toBe(2); // only the two upstreams ever ran

    const json = statusJson(ts, g.graph_id);
    expect(json.phase).toBe(EnginePhase.Complete);
    const nodes = byId(json);
    expect(nodes.get("U1")!.status).toBe(NodeStatus.Completed);
    expect(nodes.get("U2")!.status).toBe(NodeStatus.Completed);
    expect(nodes.get("sink")!.status).toBe(NodeStatus.Escalate);
    expect(nodes.get("sink")!.error).toContain(DEADLOCK_REASON);
  });

  it("(d) duplicate/contradictory edges A->B (always + on_signal answer) — B activates exactly once, no duplicate dispatch", async () => {
    const fake = new ScriptedDispatch();
    const ts = new GraphToolSet({ dispatch: fake });
    const g = ts.graph_create({ name: "duplicate-edges" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "p-A" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "B", agent: "b", prompt: "p-B" });
    ts.graph_add_edge({ graph_id: g.graph_id, from: "A", to: "B", type: "always" });
    ts.graph_add_edge({
      graph_id: g.graph_id,
      from: "A",
      to: "B",
      type: "on_signal",
      signal_filter: ["answer"],
    });

    await ts.graph_run({ graph_id: g.graph_id });
    await settle();

    // Both edges fire on A's answer, but the reEnter guard
    // (engine-advance.ts:2025-2028) only re-marks B ready while B is Pending:
    // the first edge's markReady moves B to Ready, so the second edge's
    // `isPendingActivation` is false and B is never re-added to the frontier.
    expect(fake.dispatches("A")).toBe(1);
    expect(fake.dispatches("B")).toBe(1); // pin: no duplicate dispatch
    expect(fake.dispatchCount).toBe(2);

    const json = statusJson(ts, g.graph_id);
    expect(json.phase).toBe(EnginePhase.Complete);
    const nodes = byId(json);
    expect(nodes.get("A")!.status).toBe(NodeStatus.Completed);
    expect(nodes.get("B")!.status).toBe(NodeStatus.Completed);
  });

  it("(e) edge retry {max:0} no-ops the retry gate on a scripted escalate; the escalation propagates through the fan-in and the graph completes", async () => {
    // A is scripted to error (→ escalate). R answers normally. S is the fan-in
    // convergence: A→S carries `retry {max:0}`, so findRetryEdge
    // (signal-propagation.ts:256-257) finds no retryable edge → A is NOT
    // re-dispatched; instead the escalate propagates into S's all-join, which
    // fails → S escalates with the same reason → all nodes terminal.
    const fake = new EscalatingDispatch(["A"]);
    const ts = new GraphToolSet({ dispatch: fake });
    const g = ts.graph_create({ name: "retry-max0" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "R", agent: "r", prompt: "p-R" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "p-A" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "S", agent: "s", prompt: "p-S" });
    ts.graph_add_edge({ graph_id: g.graph_id, from: "R", to: "S", type: "always" });
    ts.graph_add_edge({
      graph_id: g.graph_id,
      from: "A",
      to: "S",
      type: "always",
      retry: { max: 0 },
    });

    await ts.graph_run({ graph_id: g.graph_id });
    await settle();

    // Retry gate no-op: A was dispatched once and NOT re-dispatched despite
    // the escalate (retry.max = 0 fails the `retry.max > 0` requirement).
    expect(fake.dispatches("A")).toBe(1);
    // S was escalated by propagation — never activated, never dispatched.
    expect(fake.dispatches("S")).toBe(0);
    expect(fake.dispatches("R")).toBe(1);

    const json = statusJson(ts, g.graph_id);
    expect(json.phase).toBe(EnginePhase.Complete);
    const nodes = byId(json);
    expect(nodes.get("R")!.status).toBe(NodeStatus.Completed);
    expect(nodes.get("A")!.status).toBe(NodeStatus.Escalate);
    expect(nodes.get("A")!.error).toContain("scripted boom");
    // The escalate PROPAGATED: S's all-join failed with the same reason.
    expect(nodes.get("S")!.status).toBe(NodeStatus.Escalate);
    expect(nodes.get("S")!.error).toContain("scripted boom");
  });
});
