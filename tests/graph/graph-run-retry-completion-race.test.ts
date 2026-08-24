/**
 * Graph Execution Engine v2 — graph_run retry completion race (subtask 6, bug 3b)
 *
 * Regression: `graph_run` (src/graph/tools/graph-tools.ts) ran
 * `adoptPrior(priorState, { replayAnswers: true })` BEFORE `retryNode` on the
 * retry path. adoptPrior's answer replay (src/graph/engine/index.ts) re-emits
 * each adopted Completed node's `answer` through a full advancement critical
 * section ending in `_checkTermination()` (engine-advance.ts) — while the retry
 * target is STILL Completed (resetNodeForRetry has not run yet). When the
 * replayed downstream's dispatch task is already terminal, the engine's
 * post-registration race guard (engine-advance.ts `_dispatchNode`) queues a
 * deferred completion that drains inside the replay's critical section, the
 * adopted graph quiesces, and a premature [GRAPH COMPLETE] fires — the
 * orchestrator sees a stale terminal notification while `graph_status` shows
 * the retried node still running with `retry_count=1`.
 *
 * Fix: on the retry path (`node_id` + `retry`/`modify_prompt`) adoptPrior runs
 * with `replayAnswers: false` — PURE state adoption with no answer-replay
 * advance. `retryNode` remains the SOLE dispatch + termination authority on the
 * retry path. The non-retry path keeps `replayAnswers: true` unchanged.
 *
 * Test seams: the GraphToolSet with an injected dispatch seam (RetryRaceDispatch
 * — a node can be configured to dispatch an ALREADY-terminal task, which is the
 * exact race-guard trigger, while other nodes stay `running` until released)
 * and a graphNotify terminal notifier (TerminalSessionClient) recording
 * [GRAPH COMPLETE] reminders — mirroring graph-run-idempotent.test.ts /
 * graph-run-atomic.test.ts.
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
import {
  clearParentQueues,
  GRAPH_COMPLETE_MARKER,
} from "../../src/dispatch/notification.ts";
import type { ISessionClient } from "../../src/platform/ports/session-client.ts";

// ── Dispatch seam ────────────────────────────────────────────────────────────

/**
 * A dispatch seam that can dispatch an ALREADY-terminal task for a chosen node
 * (`instantComplete`). When the engine dispatches such a node, its
 * post-registration race guard (engine-advance.ts `_dispatchNode`) records the
 * terminal signal and queues a deferred completion that drains inside the
 * current critical section — deterministically reproducing the "replayed
 * downstream finished during the adopt window" race. All other nodes stay
 * `running` until `release(nodeId)` fires their termination.
 */
class RetryRaceDispatch implements NodeDispatchPort {
  calls: { nodeId: string; prompt: string }[] = [];
  private subs = new Map<string, TaskTerminatedCallback>();
  private tasks = new Map<string, DispatchTask>();
  private held = new Set<string>();
  private seq = 0;
  /** nodeIds whose NEXT dispatch creates an already-completed task. */
  instantComplete = new Set<string>();

  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push({ nodeId: node.nodeId, prompt: node.prompt });
    const id = `task-${node.nodeId}-${++this.seq}`;
    const done = this.instantComplete.has(node.nodeId);
    const task: DispatchTask = {
      id,
      sessionId: `sess-${id}`,
      parentSessionId: "g",
      depth: 1,
      status: done ? "completed" : "running",
      agent: node.agent,
      prompt: node.prompt,
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
    };
    this.tasks.set(id, task);
    if (!done && !this.held.has(node.nodeId)) {
      setTimeout(() => {
        task.status = "completed";
        this.subs.get(id)?.(id, "completed");
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

  getTask(taskId: string): DispatchTask | undefined {
    return this.tasks.get(taskId);
  }

  /** Keep a node's task running (never self-completes). */
  hold(nodeId: string): void {
    this.held.add(nodeId);
  }

  /** Complete every in-flight task for the node, firing its termination. */
  release(nodeId: string): void {
    for (const [taskId, task] of this.tasks) {
      if (taskId.startsWith(`task-${nodeId}-`)) {
        task.status = "completed";
        this.subs.get(taskId)?.(taskId, "completed");
      }
    }
  }
}

const settle = () => new Promise((r) => setTimeout(r, 25));

// ── Terminal notification recorder ───────────────────────────────────────────

class TerminalSessionClient implements ISessionClient {
  prompts: Array<{ id: string; text: string; noReply?: boolean }> = [];

  async prompt(
    id: string,
    options: {
      parts: Array<{ type: string; text: string }>;
      noReply?: boolean;
      agent?: string;
    },
  ): Promise<{ id: string } | null> {
    this.prompts.push({
      id,
      text: options.parts.map((p) => p.text).join("\n"),
      noReply: options.noReply,
    });
    return { id };
  }

  async list(): Promise<never> { throw new Error("not implemented"); }
  async get(): Promise<never> { throw new Error("not implemented"); }
  async messages(): Promise<never> { throw new Error("not implemented"); }
  async children(): Promise<never> { throw new Error("not implemented"); }
  async todo(): Promise<never> { throw new Error("not implemented"); }
  async diff(): Promise<never> { throw new Error("not implemented"); }
  async fork(): Promise<never> { throw new Error("not implemented"); }
  async status(): Promise<never> { throw new Error("not implemented"); }
  async promptSync(): Promise<never> { throw new Error("not implemented"); }
  async create(): Promise<never> { throw new Error("not implemented"); }
  async abort(): Promise<never> { throw new Error("not implemented"); }
}

const EMPEROR = "emperor-retry-race";

function countTerminalCompletes(client: TerminalSessionClient): number {
  return client.prompts.filter((p) => p.text.includes(GRAPH_COMPLETE_MARKER)).length;
}

function makeRig(name: string) {
  const client = new TerminalSessionClient();
  const fake = new RetryRaceDispatch();
  const ts = new GraphToolSet({
    dispatch: fake,
    graphNotify: { sessionClient: client, emperorSessionId: EMPEROR },
  });
  const g = ts.graph_create({ name });
  return { graph_id: g.graph_id, ts, fake, client };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("graph_run retry completion race (bug 3, part b)", () => {
  beforeEach(() => {
    clearParentQueues();
  });

  it("single-node completed graph: NO [GRAPH COMPLETE] fires while the retried node is running (retry_count=1)", async () => {
    const { graph_id, ts, fake, client } = makeRig("retry-race-single");
    ts.graph_add_node({ graph_id, id: "A", agent: "a", prompt: "pA" });

    // Phase 1: complete the single-node graph — exactly 1 COMPLETE.
    await ts.graph_run({ graph_id });
    fake.release("A");
    await settle();
    expect(countTerminalCompletes(client)).toBe(1);

    // Phase 2: hold the retried node running, then retry.
    fake.hold("A");
    const r = await ts.graph_run({
      graph_id,
      node_id: "A",
      retry: true,
      modify_prompt: "REVISION",
    });
    await settle();

    // The retried node IS genuinely running with retry_count=1...
    expect(r.retry?.node_id).toBe("A");
    const status = ts.graph_status({ graph_id, node_id: "A" });
    expect(status).toContain("status: running");
    expect(status).toContain("retry_count: 1");

    // ...and NO premature [GRAPH COMPLETE] fired while it is running.
    // Pre-fix: adoptPrior(replayAnswers:true) re-advanced the adopted
    // completed graph and fired a stale COMPLETE here.
    expect(countTerminalCompletes(client)).toBe(1);

    // Completing the retried node fires exactly ONE new COMPLETE (the
    // legitimate one — no stale-dedupe suppression, no duplicate).
    fake.release("A");
    await settle();
    expect(countTerminalCompletes(client)).toBe(2);
    expect(ts.graph_status({ graph_id, node_id: "A" })).toContain("status: completed");
  });

  it("single-node completed graph + added pending downstream: answer replay must NOT fire a premature COMPLETE before retryNode re-dispatches (deterministic race)", async () => {
    const { graph_id, ts, fake, client } = makeRig("retry-race-extend-single");
    ts.graph_add_node({ graph_id, id: "A", agent: "a", prompt: "pA" });

    // Phase 1: complete A — COMPLETE #1 (completed=1).
    await ts.graph_run({ graph_id });
    fake.release("A");
    await settle();
    expect(countTerminalCompletes(client)).toBe(1);
    expect(ts.graph_status({ graph_id, node_id: "A" })).toContain("status: completed");

    // Extend: add a downstream B (A→B always) — the declaration now has a
    // Pending downstream of the completed A. This is the field shape where
    // adoptPrior's answer replay (replayAnswers:true) would re-emit A's answer
    // and dispatch B BEFORE retryNode runs.
    ts.graph_add_node({ graph_id, id: "B", agent: "b", prompt: "pB" });
    ts.graph_add_edge({ graph_id, from: "A", to: "B", type: "always" });

    // B's dispatch task arrives ALREADY terminal — the engine's
    // post-registration race guard (engine-advance.ts `_dispatchNode`) treats
    // it as "finished during the adopt window", queues the deferred completion,
    // and drains it inside the replay's critical section: B completes, the
    // adopted graph quiesces, and a premature COMPLETE fires — all BEFORE
    // retryNode resets + re-dispatches A.
    fake.instantComplete.add("B");
    fake.hold("A");

    const r = await ts.graph_run({
      graph_id,
      node_id: "A",
      retry: true,
      modify_prompt: "REVISION",
    });
    await settle();

    // The retried node is genuinely running with retry_count=1...
    expect(r.retry?.node_id).toBe("A");
    const status = ts.graph_status({ graph_id, node_id: "A" });
    expect(status).toContain("status: running");
    expect(status).toContain("retry_count: 1");
    // B was reset to pending by retryNode (re-executes after A re-completes).
    expect(ts.graph_status({ graph_id, node_id: "B" })).toContain("status: pending");

    // ...and NO premature COMPLETE fired during the retry call. Pre-fix this
    // is 2 (the original + the adoptPrior-replay fire) — the stale
    // notification the orchestrator observed in the field.
    expect(countTerminalCompletes(client)).toBe(1);

    // The retried chain finishes: A re-completes → B re-activates (dispatch
    // already-terminal → race guard) → B completes → exactly ONE new COMPLETE.
    fake.release("A");
    await settle();
    expect(countTerminalCompletes(client)).toBe(2);
    expect(ts.graph_status({ graph_id })).toContain("phase: complete");
  });

  it("multi-node completed graph (A→B→C): NO [GRAPH COMPLETE] fires while the retried node is running (retry_count=1)", async () => {
    const { graph_id, ts, fake, client } = makeRig("retry-race-abc");
    ts.graph_add_node({ graph_id, id: "A", agent: "a", prompt: "pA" });
    ts.graph_add_node({ graph_id, id: "B", agent: "b", prompt: "pB" });
    ts.graph_add_node({ graph_id, id: "C", agent: "c", prompt: "pC" });
    ts.graph_add_edge({ graph_id, from: "A", to: "B", type: "always" });
    ts.graph_add_edge({ graph_id, from: "B", to: "C", type: "always" });

    // Phase 1: complete the full chain — exactly 1 COMPLETE.
    await ts.graph_run({ graph_id });
    fake.release("A");
    await settle();
    fake.release("B");
    await settle();
    fake.release("C");
    await settle();
    expect(countTerminalCompletes(client)).toBe(1);
    expect(ts.graph_status({ graph_id })).toContain("phase: complete");

    // Phase 2: hold the retried node running, then retry the middle node.
    fake.hold("B");
    const r = await ts.graph_run({
      graph_id,
      node_id: "B",
      retry: true,
      modify_prompt: "REVISION",
    });
    await settle();

    // The retried node IS genuinely running with retry_count=1...
    expect(r.retry?.node_id).toBe("B");
    const status = ts.graph_status({ graph_id, node_id: "B" });
    expect(status).toContain("status: running");
    expect(status).toContain("retry_count: 1");
    // Downstream C was reset to pending (fresh re-execution of the chain tail).
    expect(ts.graph_status({ graph_id, node_id: "C" })).toContain("status: pending");

    // ...and NO premature [GRAPH COMPLETE] fired while it is running.
    expect(countTerminalCompletes(client)).toBe(1);

    // The retried chain finishes: B re-completes, C re-activates and
    // completes — exactly ONE new COMPLETE.
    fake.release("B");
    await settle();
    fake.release("C");
    await settle();
    expect(countTerminalCompletes(client)).toBe(2);
    expect(ts.graph_status({ graph_id })).toContain("phase: complete");
  });

  it("multi-node completed graph + added pending downstream: retrying the ROOT fires no premature COMPLETE either (deterministic race)", async () => {
    const { graph_id, ts, fake, client } = makeRig("retry-race-extend-abc");
    ts.graph_add_node({ graph_id, id: "A", agent: "a", prompt: "pA" });
    ts.graph_add_node({ graph_id, id: "B", agent: "b", prompt: "pB" });
    ts.graph_add_edge({ graph_id, from: "A", to: "B", type: "always" });

    // Phase 1: complete A → B — COMPLETE #1 (completed=2).
    await ts.graph_run({ graph_id });
    fake.release("A");
    await settle();
    fake.release("B");
    await settle();
    expect(countTerminalCompletes(client)).toBe(1);
    expect(ts.graph_status({ graph_id })).toContain("phase: complete");

    // Extend: add a downstream C (B→C always) — a Pending node downstream of
    // the completed chain. Retrying the root A with replayAnswers:true would
    // re-emit B's answer (downstream C is Pending) and dispatch C before
    // retryNode runs.
    ts.graph_add_node({ graph_id, id: "C", agent: "c", prompt: "pC" });
    ts.graph_add_edge({ graph_id, from: "B", to: "C", type: "always" });

    fake.instantComplete.add("C");
    fake.hold("A");

    const r = await ts.graph_run({
      graph_id,
      node_id: "A",
      retry: true,
      modify_prompt: "REVISION",
    });
    await settle();

    expect(r.retry?.node_id).toBe("A");
    const status = ts.graph_status({ graph_id, node_id: "A" });
    expect(status).toContain("status: running");
    expect(status).toContain("retry_count: 1");
    // B and C were reset to pending by retryNode (re-execute after A re-completes).
    expect(ts.graph_status({ graph_id, node_id: "B" })).toContain("status: pending");
    expect(ts.graph_status({ graph_id, node_id: "C" })).toContain("status: pending");

    // No premature COMPLETE while the retried root is running.
    expect(countTerminalCompletes(client)).toBe(1);

    // Chain re-runs to completion: A, then B, then C (C dispatch already
    // terminal → race guard) → exactly one new COMPLETE.
    fake.release("A");
    await settle();
    fake.release("B");
    await settle();
    expect(countTerminalCompletes(client)).toBe(2);
    expect(ts.graph_status({ graph_id })).toContain("phase: complete");
  });

  it("non-retry path is preserved: extend-after-complete still activates a new downstream via answer replay", async () => {
    // Must NOT regression: the non-retry graph_run path keeps replayAnswers:true,
    // so a node added after its upstream completed still activates (the answer
    // replay forward-flow is load-bearing for incremental authoring).
    const { graph_id, ts, fake, client } = makeRig("retry-race-nonretry");
    ts.graph_add_node({ graph_id, id: "A", agent: "a", prompt: "pA" });

    // Complete A.
    await ts.graph_run({ graph_id });
    fake.release("A");
    await settle();
    expect(countTerminalCompletes(client)).toBe(1);
    expect(ts.graph_status({ graph_id, node_id: "A" })).toContain("status: completed");

    // Add downstream V with an always edge from the completed A, then a plain
    // (non-retry) graph_run — V must be dispatched via the replayed answer.
    ts.graph_add_node({ graph_id, id: "V", agent: "v", prompt: "pV" });
    ts.graph_add_edge({ graph_id, from: "A", to: "V", type: "always" });
    const r = await ts.graph_run({ graph_id });
    await settle();
    expect(r.phase).toBe(EnginePhase.Executing);
    expect(fake.calls.some((c) => c.nodeId === "V")).toBe(true);

    fake.release("V");
    await settle();
    expect(countTerminalCompletes(client)).toBe(2);
    expect(ts.graph_status({ graph_id })).toContain("phase: complete");
  });

  it("redundant retry-less graph_run on a completed graph still fires no extra COMPLETE (sanity)", async () => {
    // Guard the completed-idle short-circuit: a redundant graph_run (no node_id)
    // on a completed graph must not rebuild or re-fire.
    const { graph_id, ts, fake, client } = makeRig("retry-race-idle");
    ts.graph_add_node({ graph_id, id: "A", agent: "a", prompt: "pA" });

    await ts.graph_run({ graph_id });
    fake.release("A");
    await settle();
    expect(countTerminalCompletes(client)).toBe(1);

    const r = await ts.graph_run({ graph_id });
    await settle();
    expect(r.phase).toBe(EnginePhase.Complete);
    expect(countTerminalCompletes(client)).toBe(1);
  });
});
