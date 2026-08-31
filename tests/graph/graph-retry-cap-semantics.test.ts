/**
 * Graph Execution Engine v2 — Retry-cap semantics (pinning round)
 *
 * PINS the retry-cap behavior of the graph engine end-to-end through
 * the public tool surface (`GraphToolSet` + the shared scripted-dispatch
 * harness from `tests/graph/helpers/scripted-dispatch.ts`). TEST-ONLY — no
 * production code under `src/` is modified.
 *
 * FINDING 1 — FIXED (this round): `budget.max_retries` is now honored.
 *   `graph_add_node({ max_retries: N })` stores `N` on the node's budget
 *   (graph-tools.ts:975 `budget.max_retries = args.max_retries`), and the
 *   escalate-retry gate now resolves an EFFECTIVE budget per node
 *   (`resolveEscalateRetryPolicy`, signal-propagation.ts) = the max of the
 *   node's declared `budget.max_retries`, the `retry.max` of any OUTBOUND
 *   edge, and the `retry.max` of any INCOMING edge. `propagateEscalate`
 *   re-dispatches an escalating node while `retryCount < effective max`
 *   (automatic retry), and only after exhaustion lets the escalation terminate
 *   the node / travel downstream. A node with no declared retry anywhere
 *   escalates terminally on its first dispatch (retry_count stays 0).
 *
 * FINDING 2 — still OPEN (out of scope for this round): manual retry
 *   (`graph_run(node_id, retry:true)`) is UNCAPPED.
 *   The imperative retry surface re-opens a node via `resetNodeForRetry`
 *   (node-retry.ts `target.retryCount += 1` — unconditional) with no upper
 *   bound: retryCount keeps incrementing for as long as the caller keeps
 *   calling. Nothing (budget, edge policy, declaration) stops it.
 *
 * Cases:
 *  (a) FINDING 1 FIXED — escalate-retry budget semantics: a node declaring
 *      `budget.max_retries: 2` whose scripted dispatch escalates is dispatched
 *      3 times total (initial + 2 automatic retries) then terminates Escalate
 *      with retry_count=2; the reproduction shape — flaky with max_retries: 2
 *      AND an incoming edge `proc->flaky retry {max:3}` — consumes retries up
 *      to the EFFECTIVE max (3) and the graph terminates only after
 *      exhaustion; a no-budget control escalates with no declared retry
 *      anywhere → immediately terminal, retry_count=0 (unchanged behavior).
 *  (a2) FINDING 2 pin (still open) — a node declaring `max_retries: 2` whose
 *      graph runs to Complete keeps being retried PAST the cap via
 *      `graph_run(node_id, retry:true)`; retryCount grows 0 → 1 → 2 → 3 and
 *      every retry re-dispatches.
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
 * (tests/graph/helpers/scripted-dispatch.ts) is the scripted-status variant
 * that scripts the terminal STATUS per node dispatch ("error" maps to the
 * escalate signal via `mapDispatchStatusToSignal`, engine-recovery.ts:241-245)
 * so edge-retry and escalation behavior can be exercised deterministically.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import { GraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { clearParentQueues } from "../../src/dispatch/notification.ts";
import { ScriptedDispatch, ScriptedDispatchScript, settle } from "./helpers/scripted-dispatch.ts";

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

/** Poll a condition every 10ms until it holds or the timeout expires. */
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("graph retry-cap semantics", () => {
  beforeEach(() => {
    clearParentQueues();
  });

  // ── (a) FINDING 1 FIXED: escalate-retry budget (max of node budget + edge retry) ──

  describe("(a) escalate-retry budget semantics (FINDING 1 FIXED)", () => {
    it("a node declaring max_retries: 2 whose scripted dispatch escalates is dispatched 3 times total (initial + 2 automatic retries), then terminates Escalate with retry_count=2", async () => {
      const fake = new ScriptedDispatchScript(() => "error"); // A always escalates
      const ts = new GraphToolSet({ dispatch: fake });
      const g = ts.graph_create({ name: "budget-retry-honored" });
      // Declared cap lands on node.budget.max_retries (graph-tools.ts:975) and
      // now feeds resolveEscalateRetryPolicy (signal-propagation.ts). No edges
      // declared, so the effective budget is exactly the node's own 2.
      ts.graph_add_node({
        graph_id: g.graph_id,
        id: "A",
        agent: "a",
        prompt: "pA",
        max_retries: 2,
      });

      await ts.graph_run({ graph_id: g.graph_id });
      await settle();
      await settle(); // let the automatic retry chain (A×3) drain

      // Effective budget 2: the first two escalates are absorbed as automatic
      // retries; the third (retryCount === max) is terminal.
      expect(fake.dispatches("A")).toBe(3); // initial + 2 automatic retries
      const a = nodeStatus(ts, g.graph_id, "A");
      expect(a.retry_count).toBe(2); // capped at the declared budget
      expect(a.status).toBe(NodeStatus.Escalate);
      // Single-node graph: all nodes terminal → Complete only after exhaustion.
      expect(statusJson(ts, g.graph_id).phase).toBe(EnginePhase.Complete);
    });

    it("reproduction-shaped: flaky with max_retries: 2 AND incoming edge proc->flaky retry {max:3} — retries consumed up to the effective max (3), graph terminates only after exhaustion", async () => {
      // Both retry sources are declared: the node budget (2) and the incoming
      // edge policy (3). The effective budget is the MAX = 3
      // (resolveEscalateRetryPolicy, signal-propagation.ts), so the edge's
      // allowance wins and flaky is auto-retried 3 times (4 dispatches total).
      const fake = new ScriptedDispatchScript((nodeId) =>
        nodeId === "flaky" ? "error" : "completed",
      );
      const ts = new GraphToolSet({ dispatch: fake });
      const g = ts.graph_create({ name: "effective-budget-max" });
      ts.graph_add_node({ graph_id: g.graph_id, id: "proc", agent: "p", prompt: "pP" });
      ts.graph_add_node({
        graph_id: g.graph_id,
        id: "flaky",
        agent: "f",
        prompt: "pF",
        max_retries: 2,
      });
      ts.graph_add_edge({
        graph_id: g.graph_id,
        from: "proc",
        to: "flaky",
        type: "always",
        retry: { max: 3 },
      });

      await ts.graph_run({ graph_id: g.graph_id });
      await settle();
      await settle();
      await settle(); // let the 4-dispatch retry chain drain

      // Effective max = max(2, 3) = 3 → 3 automatic retries consumed, then the
      // 4th escalate is terminal (retryCount === max) — no 5th dispatch.
      expect(fake.dispatches("flaky")).toBe(4); // initial + 3 automatic retries
      const f = nodeStatus(ts, g.graph_id, "flaky");
      expect(f.retry_count).toBe(3); // consumed up to the effective max
      expect(f.status).toBe(NodeStatus.Escalate);
      // Graph terminates only after exhaustion: proc completed, flaky escalated
      // → all nodes terminal → Complete.
      expect(fake.dispatches("proc")).toBe(1);
      expect(statusJson(ts, g.graph_id).phase).toBe(EnginePhase.Complete);
    });

    it("no-budget control: escalate with no declared retry anywhere terminates immediately with retry_count=0 (unchanged behavior)", async () => {
      const fake = new ScriptedDispatchScript(() => "error"); // A always escalates
      const ts = new GraphToolSet({ dispatch: fake });
      const g = ts.graph_create({ name: "no-budget-control" });
      // No max_retries and no retry-bearing edge → effective budget 0.
      ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });

      await ts.graph_run({ graph_id: g.graph_id });
      await settle();
      await settle();

      // Unchanged pre/post-fix behavior: the first escalate is immediately
      // terminal — no automatic retry, retry_count stays 0.
      expect(fake.dispatches("A")).toBe(1);
      const a = nodeStatus(ts, g.graph_id, "A");
      expect(a.retry_count).toBe(0);
      expect(a.status).toBe(NodeStatus.Escalate);
      expect(statusJson(ts, g.graph_id).phase).toBe(EnginePhase.Complete);
    });
  });

  // ── (a2) FINDING 2 pin (still open): manual retry via graph_run(retry:true) is uncapped ──

  describe("(a2) FINDING 2 (open): manual retry via graph_run(node_id, retry:true) is uncapped", () => {
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

  // ── (d) join interaction: a retried escalate must NOT fail the downstream ──
  //     join-all while budget remains; it fails the join only on exhaustion.

  describe("(d) join interaction — retried escalate defers the join failure until the budget is exhausted", () => {
    it("R→B (always) + A→B retry {max:1, backoff_ms:250} with B join:all — B stays Pending through the backoff window (escalate absorbed), then B escalates once A's budget is spent", async () => {
      // A always escalates; the 250ms backoff opens a deterministic
      // observation window between the absorbed first escalate and the
      // withheld re-dispatch — exactly the state a fast drain would skip.
      const fake = new ScriptedDispatchScript((nodeId) =>
        nodeId === "A" ? "error" : "completed",
      );
      const ts = new GraphToolSet({ dispatch: fake });
      const g = ts.graph_create({ name: "join-retry-window" });
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
        retry: { max: 1, backoff_ms: 250 },
      });

      await ts.graph_run({ graph_id: g.graph_id });
      await settle(); // R completes; A's first escalate is absorbed + withheld

      // ── Mid-retry window (budget remains: retry 1/1 pending) ──────────────
      // A's escalate was absorbed into the automatic retry and is withheld by
      // the 250ms backoff — A is Ready, never re-dispatched early. The
      // absorbed escalate must NOT have failed B's join-all: R answered, A is
      // retrying, so B is still Pending (join waiting), never dispatched, and
      // the graph keeps executing.
      expect(fake.dispatches("A")).toBe(1); // withheld — no early re-dispatch
      const aMid = nodeStatus(ts, g.graph_id, "A");
      expect(aMid.status).toBe(NodeStatus.Ready);
      expect(aMid.retry_count).toBe(1);
      const bMid = nodeStatus(ts, g.graph_id, "B");
      expect(bMid.status).toBe(NodeStatus.Pending); // join NOT failed while budget remains
      expect(fake.dispatches("B")).toBe(0); // never dispatched
      expect(statusJson(ts, g.graph_id).phase).toBe(EnginePhase.Executing);

      // ── After exhaustion: the window closes, A re-dispatches and escalates
      // again (retry max 1 spent) → the escalation travels to B, whose join:all
      // now fails → B escalates terminally without ever being dispatched.
      await waitFor(
        () =>
          statusJson(ts, g.graph_id).nodes.some(
            (n) => n.node_id === "B" && n.status === NodeStatus.Escalate,
          ),
        2000,
      );
      const aFin = nodeStatus(ts, g.graph_id, "A");
      expect(aFin.status).toBe(NodeStatus.Escalate);
      expect(aFin.retry_count).toBe(1); // capped at the edge max
      expect(fake.dispatches("A")).toBe(2); // initial + exactly 1 automatic retry
      const bFin = nodeStatus(ts, g.graph_id, "B");
      expect(bFin.status).toBe(NodeStatus.Escalate); // join failed only after exhaustion
      expect(fake.dispatches("B")).toBe(0);
      // R completed, A + B escalated — all terminal → Complete.
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
