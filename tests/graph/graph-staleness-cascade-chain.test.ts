/**
 * Graph Execution Engine v2 — staleness → cascade → deadlock → retry chain
 * (①→②→③→④ regression pins for the S2/S3/S4/S5 fixes).
 *
 * PINS the fixed end-to-end failure chain through the public tool surface
 * (`GraphToolSet` + the shared scripted-dispatch harness) plus a direct
 * `NodeStalenessWatcher` unit pin. TEST-ONLY — zero changes under `src/`; the
 * uncommitted working-tree engine modifications (S2–S5) are the behavior under
 * test.
 *
 * ① (a) S2 dispatch-liveness gate — a running node whose dispatch task is
 *        verifiably LIVE (an `isDispatchAlive` probe reading the harness's
 *        `getTask`) SURVIVES past the 15-min wall-clock staleness deadline
 *        (nodeStaleTimeoutMs 900000): the tick refreshes the heartbeat
 *        (heartbeatSource "dispatch") and SKIPS the kill
 *        (NodeStalenessWatcher.tick, engine-recovery.ts). Guardrails: an
 *        absent-task sibling IS wall-clock timed out with "dispatch task
 *        live=false" in the reason; a probe-less watcher is a byte-identical
 *        legacy kill.
 * ② (b) S4 timeout→escalate + cascade-cancel — a GENUINE timeout
 *        (fake.terminate("C", "timeout")) maps to the escalate signal with
 *        "dispatch task timed out" (mapDispatchStatusToSignal,
 *        engine-recovery.ts:246-250), fails the all-join convergence node S
 *        (propagateEscalationForward, signal-propagation.ts), and the cascade
 *        canceller (cascade-canceller.ts cancelPendingUpstreams) retires the
 *        still-running sibling B to `done` with "cancelled by join cascade" +
 *        a recorded cancelTask call. The cancelled + timed-out sessions no
 *        longer consume the per-request budget: the fake's S4 `sessions`
 *        counter runs 2 launches → timeout refund → cascade-cancel refund → 0
 *        (decRequestSessions parity, lifecycle-shared.ts:165-179).
 * ③ (c) S3 deadlock reason carries the upstream cause — the pending downstream
 *        D, fed only by a never-firing on_condition edge from the escalated
 *        convergence node S, is deadlock-escalated with
 *        "S escalate: dispatch task timed out" (buildDeadlockReason,
 *        engine-termination.ts:68-112) and the graph quiesces Complete.
 * ④ (d) S4 retry after the cascade — graph_run({node_id:"B", retry:true})
 *        re-opens B + its downstream (S, D), re-dispatches B (re_dispatched 1,
 *        retry_count 1, fresh dispatch task, one fresh session slot).
 *        Counter-factual: under refundEnabled:false (pre-S4) with the
 *        budgetCap hit, the re-dispatch launch is REJECTED with an
 *        already-terminal `error` task (task-launcher.ts:50-78 model) → B
 *        escalates with "Session budget exhausted" and is NOT running — the
 *        observable starvation symptom.
 *
 * FINDING (d, rejected control): because `_dispatchNode` marks the node
 * Running BEFORE `executeNode` (engine-advance.ts:1356) and the deferred
 * completion drains in `_runCriticalSection`'s finally AFTER `retryNode`
 * computed `reDispatched` (engine-advance.ts:1924-1930, :731), a
 * budget-REJECTED retry still reports re_dispatched === 1 (EMPRICALLY
 * OBSERVED: 1) while the node then escalates with the task's error text. The
 * honest negative-control assertion is the starvation symptom (node escalates,
 * errorReason contains "Session budget exhausted", node NOT running), NOT
 * re_dispatched === 0 — re_dispatched is deliberately NOT asserted in the
 * negative control.
 *
 * Harness: `ChainDispatch` (below) is a test-local extension of the shared
 * `ScriptedDispatch` seam (helpers/scripted-dispatch.ts). Held tasks stay
 * `running`; `terminate(nodeId, status)` flips the node's latest task and
 * fires the engine's registered `onTaskTerminated` callback (tracked by
 * taskId via an overridden onTaskTerminated); `cancelTask` records into
 * `cancelCalls[]`, flips the task to `cancelled`, and refunds a session slot
 * (idempotent per taskId, never negative); the `sessions` counter models S4's
 * per-request budget — +1 per accepted executeNode (incRequestSessions
 * parity), −1 per cancelled/timeout refund (completed/error/awaiting_approval
 * keep counting); `budgetCap` + `refundEnabled` reject launches once
 * `sessions >= budgetCap` with an already-terminal error task (registered so
 * getTask resolves it, NO slot consumed); `refundEnabled:false` simulates
 * pre-S4 (slots held forever).
 *
 * Run: bun test tests/graph/graph-staleness-cascade-chain.test.ts
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { NodeRuntimeState } from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import {
  graphParentContext,
  type DispatchParentContext,
  type TaskTerminatedCallback,
} from "../../src/graph/engine/dispatch-bridge.ts";
import type { NodeDispatchPort } from "../../src/graph/engine/engine-advance.ts";
import { GraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { clearParentQueues } from "../../src/dispatch/notification.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import { markRunning } from "../../src/graph/engine/node-lifecycle.ts";
import { NodeStalenessWatcher } from "../../src/graph/engine/engine-recovery.ts";
import {
  checkGraphTermination,
  type TerminationContext,
} from "../../src/graph/engine/engine-termination.ts";
import { ScriptedDispatch, settle } from "./helpers/scripted-dispatch.ts";

// ── ChainDispatch seam (test-local S4-model dispatch fake) ──────────────────

interface ChainDispatchOptions {
  /** Node ids whose dispatched tasks never auto-complete (stay `running`). */
  hold?: Iterable<string>;
  /**
   * S4 per-request session cap. When `sessions >= budgetCap` at executeNode
   * time, the launch is rejected with an already-terminal `error` task
   * (task-launcher.ts:50-78 model). Absent → unlimited.
   */
  budgetCap?: number;
  /**
   * S4 refund toggle. `true` (default) refunds a net-live session slot when a
   * task terminates cancelled/timeout (decRequestSessions parity). `false`
   * simulates pre-S4 — slots are held forever.
   */
  refundEnabled?: boolean;
}

/**
 * Test-local variation of the shared `ScriptedDispatch` harness: same
 * auto-complete-on-next-tick delivery seam and per-node dispatch counting, plus
 * the S2/S3/S4/S5 pinning surface:
 *
 * - `hold` — held tasks never auto-complete (stay `running`);
 * - `terminate(nodeId, status)` — manual mid-flight termination that flips the
 *   node's LATEST task and fires the engine's registered `onTaskTerminated`
 *   callback (tracked by taskId);
 * - `cancelTask(taskId)` — the cascade-canceller seam: records into
 *   `cancelCalls[]`, flips the task to `cancelled`, refunds the slot;
 * - `sessions` — S4 per-request session-slot counter (decRequestSessions
 *   parity: cancelled/timeout refund idempotently per taskId and never go
 *   negative; completed/error keep counting);
 * - `budgetCap` + `refundEnabled` — S4 budget-rejection model: when the live
 *   counter is at the cap, executeNode returns an already-terminal `error`
 *   task (registered so getTask resolves it) that consumes NO slot.
 */
class ChainDispatch implements NodeDispatchPort {
  /** Every dispatch in creation order (nodeId + prompt), for call-site asserts. */
  calls: { nodeId: string; prompt: string }[] = [];
  /** Every cascade-cancel task id, in call order. */
  cancelCalls: string[] = [];
  /**
   * S4 per-request session-slot counter: +1 per ACCEPTED launch
   * (incRequestSessions parity), −1 per cancelled/timeout refund
   * (decRequestSessions parity). Budget-rejected launches consume no slot.
   */
  sessions = 0;

  private subs = new Map<string, TaskTerminatedCallback>();
  private tasks = new Map<string, DispatchTask>();
  private nodeTasks = new Map<string, string[]>(); // per-node task ids, creation order
  private counted = new Set<string>(); // task ids holding a slot (budgetCountedTasks parity)
  private readonly hold = new Set<string>();
  private readonly budgetCap?: number;
  private readonly refundEnabled: boolean;
  private seq = 0;

  constructor(opts: ChainDispatchOptions = {}) {
    if (opts.hold) for (const id of opts.hold) this.hold.add(id);
    this.budgetCap = opts.budgetCap;
    this.refundEnabled = opts.refundEnabled ?? true;
  }

  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push({ nodeId: node.nodeId, prompt: node.prompt });
    const id = `task-${node.nodeId}-${++this.seq}`;
    this.nodeTasks.set(node.nodeId, [
      ...(this.nodeTasks.get(node.nodeId) ?? []),
      id,
    ]);

    // S4 per-request budget rejection (task-launcher.ts:50-78 model): while the
    // live-session counter is at the cap the launch is refused. The
    // already-terminal `error` task IS registered (getTask resolves it) but
    // consumes NO session slot.
    if (this.budgetCap !== undefined && this.sessions >= this.budgetCap) {
      const rejected: DispatchTask = {
        id,
        sessionId: "",
        parentSessionId: "g",
        depth: 1,
        status: "error",
        agent: node.agent,
        prompt: node.prompt,
        startedAt: new Date(),
        completedAt: new Date(),
        progress: { lastUpdate: new Date(), toolCalls: 0 },
        priority: 0,
        error: JSON.stringify({
          error: "Session budget exhausted",
          limit: this.budgetCap,
          spawned: this.sessions,
        }),
      };
      this.tasks.set(id, rejected);
      return Promise.resolve(rejected);
    }

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
    // incRequestSessions parity: one net-live session slot per accepted launch.
    this.sessions += 1;
    this.counted.add(id);
    if (!this.hold.has(node.nodeId)) {
      // Auto-complete on the next tick — same shape as the shared harness.
      setTimeout(() => {
        task.status = "completed";
        this.subs.get(id)?.(id, "completed"); // completed keeps counting (S4)
      }, 0);
    }
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

  /**
   * Cascade-cancel seam (fire-and-forget — the engine never awaits it): record
   * the call, flip the task to `cancelled`, and refund its session slot (S4 —
   * idempotent per taskId, never negative).
   */
  async cancelTask(taskId: string): Promise<boolean> {
    this.cancelCalls.push(taskId);
    const task = this.tasks.get(taskId);
    if (task && task.status === "running") {
      task.status = "cancelled";
      this.refund(taskId);
    }
    return true;
  }

  /**
   * Manual termination seam: flip the node's LATEST task to the given status
   * and fire the engine's registered `onTaskTerminated` callback. A
   * cancelled/timeout termination refunds the slot (decRequestSessions parity);
   * completed/error keep counting.
   */
  terminate(nodeId: string, status: DispatchTask["status"]): void {
    const taskIds = this.nodeTasks.get(nodeId);
    const taskId = taskIds?.[taskIds.length - 1];
    if (!taskId) throw new Error(`ChainDispatch: no task for node "${nodeId}"`);
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`ChainDispatch: unknown task "${taskId}"`);
    task.status = status;
    if (status === "cancelled" || status === "timeout") {
      this.refund(taskId);
    }
    const cb = this.subs.get(taskId);
    if (!cb) {
      throw new Error(
        `ChainDispatch: no termination subscription for task "${taskId}"`,
      );
    }
    cb(taskId, status);
  }

  /** S4 refund — decRequestSessions parity: idempotent, never negative. */
  private refund(taskId: string): void {
    if (!this.refundEnabled) return; // pre-S4: slots held forever
    if (!this.counted.has(taskId)) return; // one refund per taskId max
    this.counted.delete(taskId);
    if (this.sessions > 0) this.sessions -= 1; // clamped, never negative
  }

  /** How many times `nodeId` was dispatched. */
  dispatches(nodeId: string): number {
    return this.calls.filter((c) => c.nodeId === nodeId).length;
  }

  /** Total dispatch count across every node. */
  get dispatchCount(): number {
    return this.calls.length;
  }

  /** Every task id created, in creation order. */
  get taskIds(): string[] {
    return [...this.tasks.keys()];
  }

  /** The most recent task id created for `nodeId` (undefined if never dispatched). */
  latestTaskId(nodeId: string): string | undefined {
    const ids = this.nodeTasks.get(nodeId);
    return ids?.[ids.length - 1];
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

// ── Fixtures / topology ─────────────────────────────────────────────────────

/** 15-min wall-clock staleness deadline (the toolset production default). */
const STALE_MS = 900_000;

/** Two isolated roots (no edges) — the (a) staleness-watcher fixture. */
function twoRoots(): GraphDeclaration {
  return {
    version: 2,
    name: "two-roots",
    nodes: [
      { id: "B", agent: "b", prompt: "pB" },
      { id: "C", agent: "c", prompt: "pC" },
    ],
    edges: [],
  };
}

/** Parent context for direct harness dispatches (the (a) fixture). */
function parentCtx(graphId: string): DispatchParentContext {
  return graphParentContext({ graphId, directory: process.cwd() });
}

/**
 * The ①→②→③→④ chain topology (no fan-out beyond the join): B, C roots;
 * S join-all fed by B and C; D fed by S via a never-firing `on_condition`
 * edge (condition "signal_observed(never)" — no node ever records a signal
 * of type "never", so the default resolver always returns false). The
 * registered-name spelling keeps the fixture compatible with the validator's
 * condition-vocabulary rule (unknown names now fail at commit).
 */
function buildChain(fake: ChainDispatch): { ts: GraphToolSet; graphId: string } {
  const ts = new GraphToolSet({ dispatch: fake });
  const g = ts.graph_create({ name: "staleness-cascade-chain" });
  ts.graph_add_node({ graph_id: g.graph_id, id: "B", agent: "b", prompt: "pB" });
  ts.graph_add_node({ graph_id: g.graph_id, id: "C", agent: "c", prompt: "pC" });
  ts.graph_add_node({
    graph_id: g.graph_id,
    id: "S",
    agent: "s",
    prompt: "pS",
    join: { strategy: "all" },
  });
  ts.graph_add_node({ graph_id: g.graph_id, id: "D", agent: "d", prompt: "pD" });
  ts.graph_add_edge({ graph_id: g.graph_id, from: "B", to: "S", type: "always" });
  ts.graph_add_edge({ graph_id: g.graph_id, from: "C", to: "S", type: "always" });
  ts.graph_add_edge({
    graph_id: g.graph_id,
    from: "S",
    to: "D",
    type: "on_condition",
    condition: "signal_observed(never)",
  });
  return { ts, graphId: g.graph_id };
}

/**
 * Run the chain up to the post-cascade quiescent state: dispatch both roots,
 * then drive C's genuine timeout through the engine, then drain.
 */
async function runChainToCascade(
  fake: ChainDispatch,
  ts: GraphToolSet,
  graphId: string,
): Promise<void> {
  await ts.graph_run({ graph_id: graphId });
  await settle();
  fake.terminate("C", "timeout");
  await settle();
}

// ── The chain ───────────────────────────────────────────────────────────────

describe("graph staleness → cascade → deadlock → retry chain (①→②→③→④)", () => {
  beforeEach(() => {
    clearParentQueues();
  });

  // ── ① (a) S2 dispatch-liveness gate (NodeStalenessWatcher) ────────────────

  describe("(a) S2 dispatch-liveness gate", () => {
    it("a verifiably-live dispatch task survives past the 15-min staleness deadline; an absent-task sibling is wall-clock killed with 'dispatch task live=false'", async () => {
      const fake = new ScriptedDispatch(["B"]); // hold B → its task stays running
      const state = createEngineState(twoRoots(), "g-a1");
      provision(state);
      const b = state.nodes.get("B")!;
      const c = state.nodes.get("C")!;
      // Create the task through the harness FIRST (held) so fake.getTask
      // resolves it; then mark the node running on that task.
      const bTask = await fake.executeNode(b, parentCtx(state.graphId));
      markRunning(state, b, {
        dispatchTaskId: bTask.id,
        dispatchSessionId: bTask.sessionId,
      });
      // C's task is ABSENT from the dispatch layer (never registered) — the
      // probe cannot verify it in-flight → the wall-clock deadline is
      // authoritative for the sibling.
      markRunning(state, c, {
        dispatchTaskId: "task-C-absent",
        dispatchSessionId: "sess-C-absent",
      });

      const watcher = new NodeStalenessWatcher({
        nodeStaleTimeoutMs: STALE_MS,
        isDispatchAlive: (n) =>
          fake.getTask(n.dispatchTaskId ?? "")?.status === "running",
      });

      // Tick with a clock PAST the deadline: B's probe verifies the task
      // in-flight → quiet-but-alive → the wall-clock kill is skipped. C's
      // probe resolves not-live → wall-clock timeout, reason enriched.
      const timedOut = watcher.tick(state, b.startedAt + STALE_MS);
      expect(timedOut).toEqual(["C"]);
      expect(b.status).toBe(NodeStatus.Running); // survived
      expect(b.liveness?.heartbeatSource).toBe("dispatch"); // probe-refreshed heartbeat
      expect(c.status).toBe(NodeStatus.Timeout);
      expect(c.errorReason).toContain("dispatch task live=false");
    });

    it("probe absent → byte-identical legacy wall-clock kill", () => {
      const state = createEngineState(twoRoots(), "g-a2");
      provision(state);
      const b = state.nodes.get("B")!;
      markRunning(state, b, {
        dispatchTaskId: "task-B",
        dispatchSessionId: "sess-B",
      });

      // No isDispatchAlive probe at all → the wall-clock deadline is
      // authoritative, and the legacy reason is byte-identical (no liveness
      // facts, no probe segment).
      const watcher = new NodeStalenessWatcher({ nodeStaleTimeoutMs: STALE_MS });
      const timedOut = watcher.tick(state, b.startedAt + STALE_MS);
      expect(timedOut).toEqual(["B"]);
      expect(b.status).toBe(NodeStatus.Timeout);
      expect(b.errorReason).toBe(
        `node ran past its staleness timeout (${STALE_MS}ms)`,
      );
    });
  });

  // ── ② + ③ (b)(c) end-to-end: timeout → join-fail cascade → deadlock ───────

  describe("(b)+(c) timeout cascades through the join and deadlocks the downstream", () => {
    it("a GENUINE timeout fails the all-join, retires the running sibling with refunds, and deadlock-escalates the pending downstream with the upstream reason", async () => {
      const fake = new ChainDispatch({ hold: ["B", "C"] });
      const { ts, graphId } = buildChain(fake);

      const run = await ts.graph_run({ graph_id: graphId });
      expect(run.phase).toBe(EnginePhase.Executing);
      expect(run.active_nodes).toEqual(expect.arrayContaining(["B", "C"]));
      await settle();

      // Both roots launched and held: the per-request counter holds 2 slots.
      expect(fake.dispatches("B")).toBe(1);
      expect(fake.dispatches("C")).toBe(1);
      expect(fake.sessions).toBe(2);
      expect(nodeStatus(ts, graphId, "B").status).toBe(NodeStatus.Running);
      expect(nodeStatus(ts, graphId, "C").status).toBe(NodeStatus.Running);
      expect(nodeStatus(ts, graphId, "S").status).toBe(NodeStatus.Pending);
      expect(nodeStatus(ts, graphId, "D").status).toBe(NodeStatus.Pending);

      // ② GENUINE timeout: C's dispatch task terminates `timeout` → mapped to
      // the escalate signal with "dispatch task timed out"
      // (mapDispatchStatusToSignal, engine-recovery.ts:246-250). Both session
      // refunds land SYNCHRONOUSLY inside this call — the terminate refund
      // first, then the cascade-cancel refund, because the whole join-cascade
      // (propagateEscalationForward → cancelPendingUpstreams → cancelTask)
      // runs before `_advance`'s first await: 2 launches → timeout refund →
      // cascade-cancel refund → 0.
      const bTaskId = fake.latestTaskId("B")!;
      fake.terminate("C", "timeout");
      expect(fake.cancelCalls).toEqual([bTaskId]); // cascade cancelled B's task
      expect(fake.sessions).toBe(0); // timeout + cascade-cancel refunds (S4)
      await settle();

      // C escalated; its session slot is refunded (S4 decRequestSessions).
      const c = nodeStatus(ts, graphId, "C");
      expect(c.status).toBe(NodeStatus.Escalate);
      expect(c.error).toContain("dispatch task timed out");

      // S's all-join failed (C recorded escalate, B still outstanding) → S
      // escalated with the same reason (propagateEscalationForward).
      const s = nodeStatus(ts, graphId, "S");
      expect(s.status).toBe(NodeStatus.Escalate);
      expect(s.error).toBe("dispatch task timed out");

      // The still-running sibling B was retired by the join cascade
      // (cancelPendingUpstreams): done with the cascade reason.
      const b = nodeStatus(ts, graphId, "B");
      expect(b.status).toBe(NodeStatus.Done);
      expect(b.error).toContain("cancelled by join cascade");

      // ③ The pending downstream D (fed ONLY by the never-firing on_condition
      // edge from the escalated convergence node S) is deadlock-escalated with
      // the UPSTREAM causal chain folded in (buildDeadlockReason) — the F3
      // relaxed activation fires because D is provably dead-ended.
      const d = nodeStatus(ts, graphId, "D");
      expect(d.status).toBe(NodeStatus.Escalate);
      expect(d.error).toContain("graph deadlock");
      expect(d.error).toContain("S escalate: dispatch task timed out");
      expect(statusJson(ts, graphId).phase).toBe(EnginePhase.Complete);
    });
  });

  // ── ③ (c) focused unit pin: Timeout upstream → deadlock reason ────────────

  describe("(c) deadlock escalation carries the upstream reason (focused)", () => {
    it("a Timeout-status upstream with errorReason feeds a dead-ended pending downstream → checkGraphTermination escalates it with `${upstreamId} timeout: ${errorReason}`", () => {
      // Mirrors engine-termination-s4.test.ts's S3 describe (Timeout flavor):
      // `up` is Timeout with a recorded reason; `down` is pending and
      // dead-ended (the `() => true` F3 predicate) — the guard escalates it
      // with the enriched reason.
      const decl: GraphDeclaration = {
        version: 2,
        name: "deadlock-timeout-upstream",
        nodes: [
          { id: "root", agent: "r", prompt: "pr" },
          { id: "up", agent: "u", prompt: "pu" },
          { id: "down", agent: "d", prompt: "pd", join: { strategy: "any" } },
        ],
        edges: [
          { from: "root", to: "up", type: "always" },
          { from: "up", to: "down", type: "on_condition", condition: "cond" },
          { from: "root", to: "down", type: "on_condition", condition: "cond" },
        ],
      };
      const state = createEngineState(decl, "g-timeout");
      provision(state);
      state.phase = EnginePhase.Executing;
      state.nodes.get("root")!.status = NodeStatus.Completed;
      state.nodes.get("up")!.status = NodeStatus.Timeout;
      state.nodes.get("up")!.errorReason = "dispatch task timed out";
      state.nodes.get("down")!.status = NodeStatus.Pending;
      state.frontier = [];

      const ctx: TerminationContext = {
        terminalComplete: false,
        terminalBlocked: false,
      };
      checkGraphTermination(state, undefined, ctx, undefined, () => true);

      expect(state.nodes.get("down")!.status).toBe(NodeStatus.Escalate);
      expect(state.phase).toBe(EnginePhase.Complete);
      // NodeStatus string values are lowercase: "timeout", not "Timeout".
      expect(state.nodes.get("down")!.errorReason).toBe(
        "graph deadlock: no active upstream can satisfy pending node(s) " +
          "(up timeout: dispatch task timed out)",
      );
    });
  });

  // ── ④ (d) S4 retry after the cascade ──────────────────────────────────────

  describe("(d) retry after the cascade", () => {
    it("graph_run(node_id, retry:true) AFTER the cascade re-dispatches successfully (positive path)", async () => {
      const fake = new ChainDispatch({ hold: ["B", "C"] });
      const { ts, graphId } = buildChain(fake);
      await runChainToCascade(fake, ts, graphId);

      // Post-cascade baseline: B retired, all slots refunded.
      const bTaskBefore = fake.latestTaskId("B")!;
      expect(nodeStatus(ts, graphId, "B").status).toBe(NodeStatus.Done);
      expect(nodeStatus(ts, graphId, "D").status).toBe(NodeStatus.Escalate);
      expect(fake.sessions).toBe(0);

      // ④ Retry B: resetNodeForRetry re-opens B + its transitive downstream
      // (S, D) to pending, re-readies B, and the retry critical section
      // re-dispatches it — one fresh session slot consumed.
      const r = await ts.graph_run({
        graph_id: graphId,
        node_id: "B",
        retry: true,
      });
      expect(r.retry!.node_id).toBe("B");
      expect(r.retry!.re_dispatched).toBe(1);
      expect(r.retry!.reset).toEqual(["B", "S", "D"]);

      const b = nodeStatus(ts, graphId, "B");
      expect(b.status).toBe(NodeStatus.Running); // genuinely re-dispatched
      expect(b.retry_count).toBe(1);
      expect(fake.latestTaskId("B")).not.toBe(bTaskBefore); // fresh dispatch task
      expect(fake.sessions).toBe(1); // one fresh slot consumed
      // Downstream re-opened for a clean re-run; the graph is live again.
      expect(nodeStatus(ts, graphId, "S").status).toBe(NodeStatus.Pending);
      expect(nodeStatus(ts, graphId, "D").status).toBe(NodeStatus.Pending);
      expect(statusJson(ts, graphId).phase).toBe(EnginePhase.Executing);
    });

    it("negative control — a budget-rejected retry (refundEnabled:false, budgetCap hit) starves: node escalates with 'Session budget exhausted' and is NOT running", async () => {
      const fake = new ChainDispatch({
        hold: ["B", "C"],
        budgetCap: 2,
        refundEnabled: false,
      });
      const { ts, graphId } = buildChain(fake);
      await runChainToCascade(fake, ts, graphId);

      // Pre-S4: the timeout + cascade-cancel slots are held FOREVER — the
      // per-request counter stays at the cap after the cascade.
      expect(fake.sessions).toBe(2);
      expect(fake.cancelCalls).toHaveLength(1);
      expect(nodeStatus(ts, graphId, "B").status).toBe(NodeStatus.Done);
      expect(nodeStatus(ts, graphId, "D").status).toBe(NodeStatus.Escalate);
      expect(statusJson(ts, graphId).phase).toBe(EnginePhase.Complete);

      // Retry B: the re-dispatch launch is REJECTED at the per-request cap
      // (sessions 2 >= budgetCap 2) with an already-terminal error task.
      const r = await ts.graph_run({
        graph_id: graphId,
        node_id: "B",
        retry: true,
      });
      expect(r.retry!.node_id).toBe("B");

      // Observable starvation symptom (see FINDING in the header): the node
      // escalates with the task's error text and is NOT running. The
      // re_dispatched counter is intentionally NOT asserted — the rejected
      // launch reports the pre-drain Running state under the current engine;
      // the empirically observed value is reported in the execution result.
      const b = nodeStatus(ts, graphId, "B");
      expect(b.status).toBe(NodeStatus.Escalate);
      expect(b.error).toContain("Session budget exhausted");
      // The rejected launch consumed NO slot.
      expect(fake.sessions).toBe(2);
    });
  });
});
