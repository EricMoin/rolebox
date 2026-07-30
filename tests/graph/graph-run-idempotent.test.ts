/**
 * Graph Execution Engine v2 — Idempotent re-run (adoptPrior)
 *
 * Regression for the "completed node re-run" bug: when a model does not batch
 * a whole graph but instead calls `graph_add_node` + `graph_run` once per
 * subtask, every `graph_run` (and every post-run construction commit) rebuilt
 * a FRESH engine from the declaration — resetting completed/running nodes back
 * to `ready`/`pending`, so the next `run()` re-dispatched work that was
 * already done.
 *
 * The fix: `GraphToolSet.graph_run` (and `commit`) adopt the prior runtime's
 * per-node progress into the rebuilt engine (`EngineRuntime.adoptPrior`)
 * before dispatching, so:
 *
 * - a completed node is NEVER re-dispatched by a subsequent `graph_run`;
 * - a still-running node is NOT double-dispatched;
 * - a node newly added after an upstream completed still activates via the
 *   replayed `answer` forward flow.
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
import {
  GraphToolSet,
  type GraphToolSetDeps,
} from "../../src/graph/tools/graph-tools.ts";
import { clearParentQueues, GRAPH_COMPLETE_MARKER } from "../../src/dispatch/notification.ts";
import type { ISessionClient } from "../../src/platform/ports/session-client.ts";

// ── Fake dispatch that completes tasks and answers getTask ─────────────────

class CompletingDispatch implements NodeDispatchPort {
  calls: { nodeId: string; prompt: string }[] = [];
  private subs = new Map<string, TaskTerminatedCallback>();
  private tasks = new Map<string, DispatchTask>();
  private seq = 0;
  /** nodeIds whose tasks stay running (never fire completion). */
  constructor(private stayRunning: Set<string> = new Set()) {}

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
    if (!this.stayRunning.has(node.nodeId)) {
      setTimeout(() => {
        task.status = "completed";
        this.subs.get(id)?.(id, "completed");
      }, 0);
    }
    return Promise.resolve(task);
  }

  onTaskTerminated(taskId: string, cb: TaskTerminatedCallback): TaskTerminatedCallback {
    this.subs.set(taskId, cb);
    return cb;
  }

  getTask(taskId: string): DispatchTask | undefined {
    return this.tasks.get(taskId);
  }
}

const settle = () => new Promise((r) => setTimeout(r, 25));

function makeToolset(stayRunning?: Set<string>) {
  const fake = new CompletingDispatch(stayRunning);
  const deps: GraphToolSetDeps = { dispatch: fake };
  return { ts: new GraphToolSet(deps), fake };
}

const dispatches = (
  fake: { calls: { nodeId: string; prompt: string }[] },
  nodeId: string,
) => fake.calls.filter((c) => c.nodeId === nodeId).length;

// ── Tests ───────────────────────────────────────────────────────────────────

describe("graph_run idempotent re-run (adoptPrior)", () => {
  it("does not re-dispatch a completed node on a second graph_run", async () => {
    const { ts, fake } = makeToolset();
    const g = ts.graph_create({ name: "idem" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });

    await ts.graph_run({ graph_id: g.graph_id });
    await settle();
    expect(dispatches(fake, "A")).toBe(1);

    // The per-subtask usage pattern: call graph_run again on the same graph.
    await ts.graph_run({ graph_id: g.graph_id });
    await settle();
    expect(dispatches(fake, "A")).toBe(1); // NOT re-dispatched
  });

  it("supports incremental node-per-run authoring without re-running done nodes", async () => {
    const { ts, fake } = makeToolset();
    const g = ts.graph_create({ name: "incr" });

    // Subtask 1: add A, run.
    ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });
    await ts.graph_run({ graph_id: g.graph_id });
    await settle();
    expect(dispatches(fake, "A")).toBe(1);

    // Subtask 2: add B (a fresh root, no edge), run again.
    ts.graph_add_node({ graph_id: g.graph_id, id: "B", agent: "b", prompt: "pB" });
    await ts.graph_run({ graph_id: g.graph_id });
    await settle();
    expect(dispatches(fake, "A")).toBe(1); // A stays done
    expect(dispatches(fake, "B")).toBe(1); // B runs once

    // Subtask 3: yet another run — nothing new to do, nothing re-dispatched.
    await ts.graph_run({ graph_id: g.graph_id });
    await settle();
    expect(dispatches(fake, "A")).toBe(1);
    expect(dispatches(fake, "B")).toBe(1);
  });

  it("activates a downstream node added AFTER its upstream completed (answer replay)", async () => {
    const { ts, fake } = makeToolset();
    const g = ts.graph_create({ name: "late-edge" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });
    await ts.graph_run({ graph_id: g.graph_id });
    await settle();
    expect(dispatches(fake, "A")).toBe(1);

    // The emperor appends a validate node depending on the completed A.
    ts.graph_add_node({ graph_id: g.graph_id, id: "V", agent: "v", prompt: "pV" });
    ts.graph_add_edge({ graph_id: g.graph_id, from: "A", to: "V", type: "always" });
    await ts.graph_run({ graph_id: g.graph_id });
    await settle();

    expect(dispatches(fake, "A")).toBe(1); // upstream untouched
    expect(dispatches(fake, "V")).toBe(1); // downstream ran via answer replay
  });

  it("does not double-dispatch a still-running node on re-run", async () => {
    const { ts, fake } = makeToolset(new Set(["S"]));
    const g = ts.graph_create({ name: "still-running" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "S", agent: "s", prompt: "pS" });

    await ts.graph_run({ graph_id: g.graph_id });
    await settle();
    expect(dispatches(fake, "S")).toBe(1);

    await ts.graph_run({ graph_id: g.graph_id });
    await settle();
    expect(dispatches(fake, "S")).toBe(1); // adopted as running, not re-launched
  });

  it("explicit retry still re-dispatches a completed node", async () => {
    const { ts, fake } = makeToolset();
    const g = ts.graph_create({ name: "retry-ok" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });
    await ts.graph_run({ graph_id: g.graph_id });
    await settle();
    expect(dispatches(fake, "A")).toBe(1);

    const r = await ts.graph_run({
      graph_id: g.graph_id,
      node_id: "A",
      retry: true,
      modify_prompt: "REVISION",
    });
    await settle();
    expect(r.retry?.node_id).toBe("A");
    expect(dispatches(fake, "A")).toBe(2);
    expect(fake.calls.at(-1)!.prompt.startsWith("REVISION")).toBe(true);
  });
});

// ── Controllable dispatch (holds nodes running until released) ──────────────

/**
 * A dispatch seam whose tasks stay `running` until `release(nodeId)` fires their
 * termination. Also counts `onTaskTerminated` registrations per taskId so tests
 * can detect an ORPHANED runtime — a second engine building over a mid-flight
 * graph re-subscribes the same taskId (regCount > 1); the in-flight guard must
 * leave exactly one subscription.
 */
class ControllableDispatch implements NodeDispatchPort {
  calls: { nodeId: string; prompt: string }[] = [];
  private subs = new Map<string, TaskTerminatedCallback>();
  private tasks = new Map<string, DispatchTask>();
  /** per taskId: how many onTaskTerminated registrations occurred. */
  regCount = new Map<string, number>();
  /** nodeIds whose tasks wait for release() before completing. */
  private held = new Set<string>();
  private seq = 0;

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
    if (!this.held.has(node.nodeId)) {
      setTimeout(() => {
        task.status = "completed";
        this.subs.get(id)?.(id, "completed");
      }, 0);
    }
    return Promise.resolve(task);
  }

  onTaskTerminated(taskId: string, cb: TaskTerminatedCallback): TaskTerminatedCallback {
    this.subs.set(taskId, cb);
    this.regCount.set(taskId, (this.regCount.get(taskId) ?? 0) + 1);
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

// ── graph_run concurrent in-flight guard ────────────────────────────────────

describe("graph_run concurrent in-flight guard", () => {
  it("reuses the live runtime on a redundant graph_run mid-flight (no duplicate dispatch, no orphaned runtime)", async () => {
    const fake = new ControllableDispatch();
    fake.hold("S");
    const ts = new GraphToolSet({ dispatch: fake });
    const g = ts.graph_create({ name: "in-flight" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "S", agent: "s", prompt: "pS" });

    await ts.graph_run({ graph_id: g.graph_id });
    await settle();
    // S is held running → the graph is mid-flight (phase executing).
    expect(dispatches(fake, "S")).toBe(1);

    // Redundant graph_run while still executing → the in-flight guard reuses the
    // live runtime and returns its CURRENT status WITHOUT re-dispatching.
    const r2 = await ts.graph_run({ graph_id: g.graph_id });
    expect(r2.phase).toBe(EnginePhase.Executing);
    expect(r2.active_nodes).toContain("S");
    expect(r2.pending_nodes).toEqual([]);
    expect(dispatches(fake, "S")).toBe(1); // NOT re-dispatched

    // No orphaned runtime: exactly ONE termination subscription for S's task.
    // A fresh engine rebuild would re-subscribe the same taskId → regCount 2.
    const totalRegs = [...fake.regCount.values()].reduce((a, b) => a + b, 0);
    expect(totalRegs).toBe(1);

    // The REUSED live runtime is still functional: releasing the held task lets
    // it advance to completion (no lost dispatch listener / EngineState).
    fake.release("S");
    await settle();
    const r3 = await ts.graph_run({ graph_id: g.graph_id });
    expect(r3.phase).toBe(EnginePhase.Complete);
    expect(dispatches(fake, "S")).toBe(1);
  });

  it("does not short-circuit a targeted node retry mid-flight", async () => {
    const fake = new ControllableDispatch();
    const ts = new GraphToolSet({ dispatch: fake });
    const g = ts.graph_create({ name: "retry-inflight" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });

    await ts.graph_run({ graph_id: g.graph_id });
    await settle();
    expect(dispatches(fake, "A")).toBe(1);

    // Targeted retry must continue to work even though the graph is running.
    const r = await ts.graph_run({
      graph_id: g.graph_id,
      node_id: "A",
      retry: true,
      modify_prompt: "REVISION",
    });
    await settle();
    expect(r.retry?.node_id).toBe("A");
    expect(dispatches(fake, "A")).toBe(2);
    expect(fake.calls.at(-1)!.prompt.startsWith("REVISION")).toBe(true);
  });
});

// ── Completed-graph re-run → terminal-notification regression ───────────────
//
// Regression for the "completed graph duplicate graph_run" bug: a redundant
// `graph_run` (no node_id) on an already-COMPLETE graph used to rebuild a fresh
// engine (graph-tools.ts `graph_run`), which creates a new per-instance
// `_terminationCtx` (engine-advance.ts) and a fresh graph-terminal notifier with
// a clean dedupe epoch (graph-notify.ts `notified` Set). Every such re-run
// therefore re-fired `[GRAPH COMPLETE]`. The fix short-circuits a completed-idle
// graph so the terminal notifier fires exactly once.

class NotifyingDispatch implements NodeDispatchPort {
  calls: { nodeId: string; prompt: string }[] = [];
  private subs = new Map<string, TaskTerminatedCallback>();
  private tasks = new Map<string, DispatchTask>();
  private seq = 0;

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
    return Promise.resolve(task);
  }

  onTaskTerminated(taskId: string, cb: TaskTerminatedCallback): TaskTerminatedCallback {
    this.subs.set(taskId, cb);
    return cb;
  }

  getTask(taskId: string): DispatchTask | undefined {
    return this.tasks.get(taskId);
  }

  /** Complete the most recently dispatched task, firing its termination. */
  completeLatest(): void {
    let latestId: string | undefined;
    for (const id of this.tasks.keys()) latestId = id;
    if (!latestId) throw new Error("no dispatched task to complete");
    const task = this.tasks.get(latestId)!;
    task.status = "completed";
    this.subs.get(latestId)?.(latestId, "completed");
  }
}

class TerminalSessionClient implements ISessionClient {
  prompts: Array<{ id: string; text: string; noReply?: boolean }> = [];

  async prompt(
    id: string,
    options: { parts: Array<{ type: string; text: string }>; noReply?: boolean; agent?: string },
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

const EMPEROR = "emperor-complete-rerun";

function countTerminalCompletes(client: TerminalSessionClient): number {
  return client.prompts.filter((p) => p.text.includes(GRAPH_COMPLETE_MARKER)).length;
}

describe("graph_run redundant re-run of a completed graph (terminal notification)", () => {
  beforeEach(() => {
    clearParentQueues();
  });

  it("fires [GRAPH COMPLETE] exactly once; a redundant graph_run adds none", async () => {
    const client = new TerminalSessionClient();
    const dispatch = new NotifyingDispatch();
    const ts = new GraphToolSet({
      dispatch,
      graphNotify: { sessionClient: client, emperorSessionId: EMPEROR },
    });

    const g = ts.graph_create({ name: "completed-rerun" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });

    await ts.graph_run({ graph_id: g.graph_id });
    dispatch.completeLatest();
    await settle();
    expect(countTerminalCompletes(client)).toBe(1);
    expect(dispatches(dispatch, "A")).toBe(1);

    // Redundant re-run of the now-completed graph (no node_id).
    const r = await ts.graph_run({ graph_id: g.graph_id });
    await settle();

    // No new terminal notification, no re-dispatch, phase stays Complete.
    expect(countTerminalCompletes(client)).toBe(1);
    expect(dispatches(dispatch, "A")).toBe(1);
    expect(r.phase).toBe(EnginePhase.Complete);
    expect(r.active_nodes).toEqual([]);
    expect(r.pending_nodes).toEqual([]);
  });

  it("retry of a completed node still fires exactly one new COMPLETE", async () => {
    const client = new TerminalSessionClient();
    const dispatch = new NotifyingDispatch();
    const ts = new GraphToolSet({
      dispatch,
      graphNotify: { sessionClient: client, emperorSessionId: EMPEROR },
    });

    const g = ts.graph_create({ name: "retry-notify" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });

    await ts.graph_run({ graph_id: g.graph_id });
    dispatch.completeLatest();
    await settle();
    expect(countTerminalCompletes(client)).toBe(1);
    expect(dispatches(dispatch, "A")).toBe(1);

    // Targeted retry must still re-dispatch and fire exactly one more COMPLETE.
    const r = await ts.graph_run({
      graph_id: g.graph_id,
      node_id: "A",
      retry: true,
      modify_prompt: "REVISION",
    });
    dispatch.completeLatest();
    await settle();

    expect(r.retry?.node_id).toBe("A");
    expect(dispatches(dispatch, "A")).toBe(2);
    expect(countTerminalCompletes(client)).toBe(2);
    expect(dispatch.calls.at(-1)!.prompt.startsWith("REVISION")).toBe(true);
  });
});
