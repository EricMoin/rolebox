/**
 * Graph Execution Engine v2 — Retry-cap semantics (pinning round)
 *
 * PINS the CURRENT retry-cap behavior of the graph engine end-to-end through
 * the public tool surface (`GraphToolSet` + the shared scripted-dispatch
 * harness from `tests/graph/helpers/scripted-dispatch.ts`). TEST-ONLY — no
 * production code under `src/` is modified; the two findings below are
 * DOCUMENTED, not fixed.
 *
 * FINDING 1 — `budget.max_retries` is inert.
 *   `graph_add_node({ max_retries: N })` stores `N` on the node's budget
 *   (graph-tools.ts:984 `budget.max_retries = args.max_retries`), but NO
 *   engine module ever reads it. The only retry-count consumers in the engine
 *   are `resetNodeForRetry` (node-retry.ts:206 `target.retryCount += 1` —
 *   unconditional) and the edge-retry gate `findRetryEdge`
 *   (signal-propagation.ts:250-262 — reads `edge.retry`, never `budget`).
 *   Declaring a per-node retry cap has zero effect on any retry path.
 *
 * FINDING 2 — manual retry (`graph_run(node_id, retry:true)`) is UNCAPPED.
 *   The imperative retry surface re-opens a node via `resetNodeForRetry` with
 *   no upper bound: retryCount keeps incrementing for as long as the caller
 *   keeps calling. Nothing (budget, edge policy, declaration) stops it.
 *
 * By contrast, the EDGE retry policy (`graph_add_edge({ retry: { max: N } })`)
 * IS enforced: `propagateEscalate` (signal-propagation.ts:305-313) only
 * re-dispatches an escalating node while `node.retryCount < retry.max`, and
 * `findRetryEdge` requires `retry.max > 0` — so `retry: { max: -1 }` (accepted
 * by the tool schema without validation, tools/index.ts:80-88) behaves exactly
 * like retry-disabled.
 *
 * Cases:
 *  (a) FINDING pin — node declares `budget.max_retries: 2`, the graph runs to
 *      Complete, then `graph_run(node_id, retry:true)` keeps succeeding past
 *      the cap; retryCount grows 0 → 1 → 2 → 3 and every retry re-dispatches.
 *  (b) edge retry enforcement — A→B `retry {max:2}`; A escalates twice then
 *      answers: exactly 3 dispatches of A (initial + 2 automatic retries),
 *      then the answer flows forward and the graph completes. A 3-escalate
 *      script (retry max exhausted) makes the escalation travel DOWNSTREAM
 *      (join-all convergence node escalates) instead of re-dispatching.
 *  (c) M11 retry guard on a running node — retrying a node that is currently
 *      `Running` is REFUSED with an actionable error (`resetNodeForRetry`
 *      state-guards the reset scope); the node keeps running, no re-dispatch,
 *      no abandoned task / leaked session. (Supersedes the pre-fix pin, which
 *      re-opened and re-dispatched a Running node, abandoning its live task.)
 *  (d) `retry: { max: -1 }` accepted by the tool → behaves like disabled
 *      (never retries, escalate propagates on the first dispatch).
 *
 * Harness: `ScriptedDispatch` auto-completes every dispatched task on the next
 * tick through the real `onTaskTerminated` seam; `ScriptedDispatchScript`
 * (below) is a test-local variant that scripts the terminal STATUS per node
 * dispatch ("error" maps to the escalate signal via
 * `mapDispatchStatusToSignal`, engine-recovery.ts:241-245) so edge-retry and
 * escalation behavior can be exercised deterministically.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { NodeRuntimeState } from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type {
  DispatchParentContext,
  TaskTerminatedCallback,
} from "../../src/graph/engine/dispatch-bridge.ts";
import type { NodeDispatchPort } from "../../src/graph/engine/engine-advance.ts";
import { GraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { clearParentQueues } from "../../src/dispatch/notification.ts";
import { ScriptedDispatch, settle } from "./helpers/scripted-dispatch.ts";

// ── Scripted-status dispatch seam ────────────────────────────────────────────

type ScriptedStatus = "completed" | "error";

/**
 * Test-local variation of the shared `ScriptedDispatch` harness: identical
 * auto-complete-on-next-tick delivery seam and per-node dispatch counting, but
 * the terminal status is scripted per dispatch
 * (`(nodeId, ordinal) => status`). Status "error" routes through the real
 * dispatch→signal mapping to the `escalate` signal (engine-recovery.ts
 * `mapDispatchStatusToSignal`); "error" is not in `LIVE_DISPATCH_STATUSES`
 * (engine-recovery.ts:88-92), so the transient-error guard lets it advance.
 */
class ScriptedDispatchScript implements NodeDispatchPort {
  calls: { nodeId: string; prompt: string }[] = [];
  private subs = new Map<string, TaskTerminatedCallback>();
  private tasks = new Map<string, DispatchTask>();
  private seq = 0;

  constructor(
    private readonly script: (nodeId: string, ordinal: number) => ScriptedStatus,
  ) {}

  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    const ordinal = this.calls.filter((c) => c.nodeId === node.nodeId).length;
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
      const status = this.script(node.nodeId, ordinal);
      task.status = status;
      this.subs.get(id)?.(id, status);
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

  get dispatchCount(): number {
    return this.calls.length;
  }
}

// ── graph_status JSON helpers ───────────────────────────────────────────────

interface StatusJson {
  phase: string;
  nodes: Array<{
    node_id: string;
    status: string;
    retry_count: number;
    error?: string | undefined;
  }>;
}

function statusJson(ts: GraphToolSet, graphId: string): StatusJson {
  const out = ts.graph_status({ graph_id: graphId, format: "json" });
  return JSON.parse(out) as StatusJson;
}

function nodeStatus(
  ts: GraphToolSet,
  graphId: string,
  nodeId: string,
): StatusJson["nodes"][number] {
  const node = statusJson(ts, graphId).nodes.find((n) => n.node_id === nodeId);
  if (!node) throw new Error(`graph_status: node "${nodeId}" missing`);
  return node;
}

describe("graph retry-cap semantics", () => {
  beforeEach(() => {
    clearParentQueues();
  });

  // ── (a) FINDING pin: budget.max_retries is inert — manual retry is uncapped ──

  describe("(a) budget.max_retries is inert; manual retry uncapped", () => {
    it("a node declaring max_retries: 2 keeps retrying past the cap via graph_run(node_id, retry:true)", async () => {
      const fake = new ScriptedDispatch();
      const ts = new GraphToolSet({ dispatch: fake });
      const g = ts.graph_create({ name: "cap-inert" });
      // Declared cap lands on node.budget.max_retries (graph-tools.ts:984).
      ts.graph_add_node({
        graph_id: g.graph_id,
        id: "A",
        agent: "a",
        prompt: "pA",
        max_retries: 2,
      });

      // Initial run → A dispatched once, auto-completes → graph Complete.
      await ts.graph_run({ graph_id: g.graph_id });
      await settle();
      expect(fake.dispatches("A")).toBe(1);
      expect(nodeStatus(ts, g.graph_id, "A").retry_count).toBe(0);

      // Manual retry #1: succeeds (retryCount 0 → 1), re-dispatches A.
      const r1 = await ts.graph_run({ graph_id: g.graph_id, node_id: "A", retry: true });
      await settle();
      expect(r1.retry!.node_id).toBe("A");
      expect(r1.retry!.re_dispatched).toBeGreaterThanOrEqual(1);
      expect(fake.dispatches("A")).toBe(2);
      expect(nodeStatus(ts, g.graph_id, "A").retry_count).toBe(1);

      // Manual retry #2: still inside the declared cap (retryCount 1 → 2).
      const r2 = await ts.graph_run({ graph_id: g.graph_id, node_id: "A", retry: true });
      await settle();
      expect(r2.retry!.re_dispatched).toBeGreaterThanOrEqual(1);
      expect(fake.dispatches("A")).toBe(3);
      expect(nodeStatus(ts, g.graph_id, "A").retry_count).toBe(2);

      // Manual retry #3 — PAST the declared max_retries of 2 (retryCount 2 → 3):
      // no engine module consults budget.max_retries; resetNodeForRetry
      // increments retryCount unconditionally (node-retry.ts:206). FINDING 2.
      const r3 = await ts.graph_run({ graph_id: g.graph_id, node_id: "A", retry: true });
      await settle();
      expect(r3.retry!.re_dispatched).toBeGreaterThanOrEqual(1);
      expect(nodeStatus(ts, g.graph_id, "A").retry_count).toBe(3);
      // Every retry re-dispatched the node: 1 initial + 3 manual = 4 dispatches.
      expect(fake.dispatches("A")).toBe(4);
    });
  });

  // ── (b) edge retry enforcement (signal-propagation.ts:305-313) ─────────────

  describe("(b) edge retry policy is enforced", () => {
    it("A→B retry {max:2}: A escalates twice then answers — exactly 3 dispatches, then the answer flows forward and the graph completes", async () => {
      const fake = new ScriptedDispatchScript((nodeId, ordinal) =>
        nodeId === "A" && ordinal < 2 ? "error" : "completed",
      );
      const ts = new GraphToolSet({ dispatch: fake });
      const g = ts.graph_create({ name: "edge-retry-bounded" });
      ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });
      ts.graph_add_node({ graph_id: g.graph_id, id: "B", agent: "b", prompt: "pB" });
      ts.graph_add_edge({
        graph_id: g.graph_id,
        from: "A",
        to: "B",
        type: "always",
        retry: { max: 2 },
      });

      const r = await ts.graph_run({ graph_id: g.graph_id });
      expect(r.active_nodes).toContain("A");
      await settle();
      await settle(); // let the retry chain (A×3 → B) drain

      // A re-dispatched exactly 3 times total: initial + 2 automatic retries
      // (propagateEscalate retry gate, signal-propagation.ts:305-308).
      expect(fake.dispatches("A")).toBe(3);
      expect(fake.dispatches("B")).toBe(1); // answer flowed forward on A's 3rd dispatch
      const a = nodeStatus(ts, g.graph_id, "A");
      expect(a.retry_count).toBe(2); // edge gate incremented exactly twice, capped at max
      expect(a.status).toBe(NodeStatus.Completed);
      expect(statusJson(ts, g.graph_id).phase).toBe(EnginePhase.Complete);
    });

    it("A→B retry {max:2} with a 3-escalate script: after the max, the escalation travels downstream instead of re-dispatching", async () => {
      // R feeds B too, so B is a multi-input fan-in convergence node: once A's
      // retry budget is exhausted, the escalate visibly reaches B and fails its
      // join-all (R answered, A escalated) — B escalates, no 4th A dispatch.
      const fake = new ScriptedDispatchScript((nodeId) =>
        nodeId === "A" ? "error" : "completed",
      );
      const ts = new GraphToolSet({ dispatch: fake });
      const g = ts.graph_create({ name: "edge-retry-exhausted" });
      ts.graph_add_node({ graph_id: g.graph_id, id: "R", agent: "r", prompt: "pR" });
      ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });
      ts.graph_add_node({
        graph_id: g.graph_id,
        id: "B",
        agent: "b",
        prompt: "pB",
        join: { strategy: "all" },
      });
      ts.graph_add_edge({ graph_id: g.graph_id, from: "R", to: "B", type: "always" });
      ts.graph_add_edge({
        graph_id: g.graph_id,
        from: "A",
        to: "B",
        type: "always",
        retry: { max: 2 },
      });

      await ts.graph_run({ graph_id: g.graph_id });
      await settle();
      await settle();

      // A escalated on every dispatch: the 2 automatic retries consumed the
      // max; the 3rd escalate was NOT re-absorbed — no 4th re-dispatch.
      expect(fake.dispatches("A")).toBe(3);
      const a = nodeStatus(ts, g.graph_id, "A");
      expect(a.retry_count).toBe(2); // capped by the edge policy
      expect(a.status).toBe(NodeStatus.Escalate);
      // The escalation traveled downstream: B's join-all failed → B escalated
      // (recordEscalate + evaluateJoin in propagateEscalationForward) and the
      // graph quiesced Complete (R completed, A + B escalated).
      expect(fake.dispatches("B")).toBe(0); // B escalated via join failure, never dispatched
      const b = nodeStatus(ts, g.graph_id, "B");
      expect(b.status).toBe(NodeStatus.Escalate);
      expect(statusJson(ts, g.graph_id).phase).toBe(EnginePhase.Complete);
    });
  });

  // ── (c) M11 guard: retrying a currently-Running node is refused ────────────

  describe("(c) retryNode on a currently-Running node is refused (M11 state guard)", () => {
    it("graph_run(node_id, retry:true) on a held (Running) node rejects, leaves the node running, and does not re-dispatch (no session leak)", async () => {
      const fake = new ScriptedDispatch(["A"]); // hold A → stays Running
      const ts = new GraphToolSet({ dispatch: fake });
      const g = ts.graph_create({ name: "retry-running-guard" });
      ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });

      const r1 = await ts.graph_run({ graph_id: g.graph_id });
      expect(r1.active_nodes).toContain("A");
      expect(r1.phase).toBe(EnginePhase.Executing);
      expect(fake.dispatches("A")).toBe(1);
      expect(fake.taskIds.length).toBe(1);
      const firstTaskId = fake.taskIds[0];
      expect(nodeStatus(ts, g.graph_id, "A").status).toBe(NodeStatus.Running);

      // M11 guard (supersedes the pre-fix pin): retrying a LIVE node is refused
      // with an actionable error. The old behavior re-opened the node and
      // simply abandoned the old held task — leaking the running dispatch
      // session (tokens/cost keep flowing, the net-live sessions slot never
      // refunded) and leaving a zombie onTaskTerminated listener behind.
      await expect(
        ts.graph_run({ graph_id: g.graph_id, node_id: "A", retry: true }),
      ).rejects.toThrow(/running/);
      expect(fake.dispatches("A")).toBe(1); // never re-dispatched
      expect(fake.taskIds.length).toBe(1); // the old task is still the only one
      expect(fake.taskIds[0]).toBe(firstTaskId);
      const a = nodeStatus(ts, g.graph_id, "A");
      expect(a.status).toBe(NodeStatus.Running); // still running untouched
      expect(a.retry_count).toBe(0); // the reset never ran
      expect(statusJson(ts, g.graph_id).phase).toBe(EnginePhase.Executing);
    });
  });

  // ── (d) retry: {max: -1} accepted → behaves like disabled ──────────────────

  describe("(d) retry: {max: -1} is accepted and behaves like disabled", () => {
    it("graph_add_edge retry: {max: -1} never re-dispatches an escalating source", async () => {
      const fake = new ScriptedDispatchScript(() => "error"); // A always escalates
      const ts = new GraphToolSet({ dispatch: fake });
      const g = ts.graph_create({ name: "retry-negative" });
      ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });
      ts.graph_add_node({ graph_id: g.graph_id, id: "B", agent: "b", prompt: "pB" });
      // Accepted without validation (tools/index.ts retrySchema is a bare
      // z.number() / {max: number} — no positivity constraint) → lands as-is.
      const added = ts.graph_add_edge({
        graph_id: g.graph_id,
        from: "A",
        to: "B",
        type: "always",
        retry: { max: -1 },
      });
      expect(added.edge_id).toBe("A->B");

      await ts.graph_run({ graph_id: g.graph_id });
      await settle();

      // findRetryEdge requires retry.max > 0 (signal-propagation.ts:257), so
      // max:-1 never qualifies → the escalate propagates immediately, no retry.
      expect(fake.dispatches("A")).toBe(1); // never re-dispatched
      const a = nodeStatus(ts, g.graph_id, "A");
      expect(a.retry_count).toBe(0);
      expect(a.status).toBe(NodeStatus.Escalate);
      // Downstream B (single-input pass-through) stays pending and the graph
      // stays executing — the escalate is NOT absorbed by any retry.
      expect(nodeStatus(ts, g.graph_id, "B").status).toBe(NodeStatus.Pending);
      expect(statusJson(ts, g.graph_id).phase).toBe(EnginePhase.Executing);
    });
  });
});
