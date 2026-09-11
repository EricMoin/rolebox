/**
 * Graph Execution Engine v2 — graph_run failure atomicity (subtask 3)
 *
 * Regression for the leaked-engine bug: when `runtime.adoptPrior` /
 * `runtime.run()` / `runtime.retryNode()` throws, `graph_run` used to skip the
 * `entry.runtime.dispose?.()` + `registry.set(...)` tail — leaking the
 * partially-dispatched NEW engine (its registered `onTaskTerminated` dispatch
 * listeners and wired completion/terminal notifiers keep firing ghost
 * [GRAPH NODE COMPLETED] / [GRAPH COMPLETE] reminders for the failed run)
 * while the registry kept the stale OLD runtime.
 *
 * The fix wraps the adopt/retry/run block in try/catch (graph-tools.ts
 * `graph_run`): on failure the new runtime is disposed (its dispatch listeners
 * unregistered via the M4 dispose path, engine/index.ts `dispose`), the prior
 * registry entry is left untouched (it remains the consistent runtime for a
 * retry), and the actionable error is rethrown.
 *
 * Invariants under test:
 * - a failed run leaves the registry entry on a consistent (prior) runtime;
 * - the new engine is disposed (its `onTaskTerminated` listeners unregistered);
 * - no node is dispatched twice within a run;
 * - no ghost [GRAPH NODE COMPLETED] / [GRAPH COMPLETE] fires for a failed run;
 * - a retry after a failure rebuilds cleanly and notifies exactly once.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { EnginePhase } from "../../src/constants.ts";
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
  GRAPH_COMPLETION_MARKER,
} from "../../src/dispatch/notification.ts";
import type { ISessionClient } from "../../src/platform/ports/session-client.ts";

// ── Dispatch seam: partial dispatch then run() failure ───────────────────────

/**
 * A dispatch seam that rejects the FIRST `executeNode` call for any node in
 * `failNodes` (subsequent attempts succeed — a retry can pass), and holds every
 * successfully dispatched task `running` until the test releases it via
 * {@link completeNode}.
 *
 * Carries the `isNoDispatchSeamStub` marker so a genuine dispatch rejection
 * propagates OUT of `run()`: engine-advance.ts `_dispatchNode` rethrows only
 * the stub-marked seam's rejection (every genuine dispatch failure is otherwise
 * contained and the graph keeps dispatching). That is the exact precondition
 * for a partial dispatch followed by a run() failure — the failure atomicity
 * path under test.
 *
 * Also records `onTaskTerminated` registrations and
 * `removeTaskTerminatedListener` calls so a test can prove a disposed engine
 * unregistered every listener it wired.
 */
class PartialFailDispatch implements NodeDispatchPort {
  calls: { nodeId: string; prompt: string }[] = [];
  /** Every dispatch task id ever created, in creation order. */
  taskIds: string[] = [];
  private subs = new Map<string, TaskTerminatedCallback>();
  private tasks = new Map<string, DispatchTask>();
  private unregs: string[] = [];
  private failed = new Set<string>();
  private seq = 0;
  /** Marker consumed by engine-advance.ts `isNoDispatchSeamStub`. */
  readonly isNoDispatchSeamStub = true;

  constructor(private readonly failNodes: ReadonlySet<string>) {}

  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push({ nodeId: node.nodeId, prompt: node.prompt });
    if (this.failNodes.has(node.nodeId) && !this.failed.has(node.nodeId)) {
      this.failed.add(node.nodeId);
      return Promise.reject(
        new Error(`dispatch failed for node ${node.nodeId}`),
      );
    }
    const id = `task-${node.nodeId}-${++this.seq}`;
    this.taskIds.push(id);
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
    this.unregs.push(taskId);
    if (this.subs.get(taskId) === cb) this.subs.delete(taskId);
  }

  getTask(taskId: string): DispatchTask | undefined {
    return this.tasks.get(taskId);
  }

  /** Complete every in-flight task for the node, firing its termination. */
  completeNode(nodeId: string): void {
    for (const [taskId, task] of this.tasks) {
      if (taskId.startsWith(`task-${nodeId}-`)) {
        task.status = "completed";
        this.subs.get(taskId)?.(taskId, "completed");
      }
    }
  }

  /** Task ids whose listener was unregistered via dispose. */
  get unregisteredTaskIds(): string[] {
    return [...this.unregs];
  }

  /** How many task-termination listeners remain registered. */
  get liveSubscriptions(): number {
    return this.subs.size;
  }
}

const settle = () => new Promise((r) => setTimeout(r, 25));

const dispatches = (
  fake: { calls: { nodeId: string; prompt: string }[] },
  nodeId: string,
) => fake.calls.filter((c) => c.nodeId === nodeId).length;

// ── Emperor session client recording injected reminders ─────────────────────

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

const EMPEROR = "emperor-failure-atomic";

function countTerminalCompletes(client: TerminalSessionClient): number {
  return client.prompts.filter((p) => p.text.includes(GRAPH_COMPLETE_MARKER)).length;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("graph_run failure atomicity", () => {
  beforeEach(() => {
    clearParentQueues();
  });

  it("a run() throw after partial dispatch keeps the prior runtime, disposes the new engine, and never double-dispatches", async () => {
    const fake = new PartialFailDispatch(new Set(["B"]));
    const ts = new GraphToolSet({ dispatch: fake });
    const g = ts.graph_create({ name: "atomic" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "B", agent: "b", prompt: "pB" });

    // run() dispatches A (task created + onTaskTerminated listener registered),
    // then B's executeNode rejects — a stub-marked rejection, so it propagates
    // out of run() and graph_run fails AFTER a partial dispatch.
    await expect(ts.graph_run({ graph_id: g.graph_id })).rejects.toThrow(
      /dispatch failed for node B/,
    );

    // Registry entry still points at the PRIOR runtime: it never dispatched
    // anything (phase idle, A/B ready). The partially-dispatched new engine was
    // NOT registered in its place.
    const out = ts.graph_status({ graph_id: g.graph_id });
    expect(out).toMatch(/phase: idle/);
    expect(out).toMatch(/A\s+ready/);
    expect(out).toMatch(/B\s+ready/);

    // The new engine was disposed: every dispatch listener it registered was
    // unregistered from the seam — nothing remains subscribed.
    expect(fake.unregisteredTaskIds).toEqual(fake.taskIds);
    expect(fake.liveSubscriptions).toBe(0);

    // No duplicate dispatch task id: A was dispatched exactly once and its
    // task id is unique; firing A's termination after the failure advances
    // NOTHING (the disposed engine's listener is gone) — no re-dispatch, no
    // new task.
    expect(dispatches(fake, "A")).toBe(1);
    expect(new Set(fake.taskIds).size).toBe(fake.taskIds.length);
    fake.completeNode("A");
    await settle();
    expect(dispatches(fake, "A")).toBe(1);
    expect(new Set(fake.taskIds).size).toBe(fake.taskIds.length);
  });

  it("fires NO ghost [GRAPH NODE COMPLETED] / [GRAPH COMPLETE] for a failed run", async () => {
    const client = new TerminalSessionClient();
    const fake = new PartialFailDispatch(new Set(["B"]));
    const ts = new GraphToolSet({
      dispatch: fake,
      graphNotify: { sessionClient: client, emperorSessionId: EMPEROR },
    });
    const g = ts.graph_create({ name: "ghost" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "B", agent: "b", prompt: "pB" });

    await expect(ts.graph_run({ graph_id: g.graph_id })).rejects.toThrow(
      /dispatch failed for node B/,
    );

    // Drive the partially-dispatched task to completion exactly as a real
    // dispatch would. The failed run's new engine was disposed, so its
    // listeners are unregistered — nothing advances and no reminder can fire.
    // (Without the fix, the leaked engine would advance A → dispatch B →
    // complete → fire ghost node-completion + terminal reminders.)
    fake.completeNode("A");
    await settle();
    fake.completeNode("B");
    await settle();

    expect(client.prompts).toEqual([]);
  });

  it("a retry after a failed run rebuilds cleanly — single dispatch, single COMPLETE", async () => {
    const client = new TerminalSessionClient();
    const fake = new PartialFailDispatch(new Set(["B"]));
    const ts = new GraphToolSet({
      dispatch: fake,
      graphNotify: { sessionClient: client, emperorSessionId: EMPEROR },
    });
    const g = ts.graph_create({ name: "retry-after-fail" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "B", agent: "b", prompt: "pB" });

    await expect(ts.graph_run({ graph_id: g.graph_id })).rejects.toThrow(
      /dispatch failed for node B/,
    );
    expect(client.prompts).toEqual([]);

    // Retry: B's executeNode succeeds now (fail-once), and the registry entry
    // still holds the consistent prior (idle) runtime, so the rebuild
    // re-dispatches A and B exactly once each and the graph completes.
    const r = await ts.graph_run({ graph_id: g.graph_id });
    expect(r.phase).toBe(EnginePhase.Executing);
    fake.completeNode("A");
    fake.completeNode("B");
    await settle();

    expect(dispatches(fake, "A")).toBe(2); // failed attempt + clean retry
    expect(dispatches(fake, "B")).toBe(2);
    expect(countTerminalCompletes(client)).toBe(1);
    // Node-completion reminders for A and B, exactly once each.
    const nodeCompletions = client.prompts.filter((p) =>
      p.text.includes(GRAPH_COMPLETION_MARKER),
    );
    expect(nodeCompletions.length).toBe(2);
  });
});
