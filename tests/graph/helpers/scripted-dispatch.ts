/**
 * Shared scripted-dispatch seam for graph tool tests.
 *
 * Established by the degenerate-topologies subtask and reused by the follow-on
 * graph-run subtasks (4, 5, 6): a `NodeDispatchPort` fake that AUTO-COMPLETES
 * every dispatched task via its registered `onTaskTerminated` listener (on a
 * `setTimeout(0)` tick), so real signal advancement flows through the public
 * `GraphToolSet` / engine API exactly as a model driving `graph_create` →
 * `graph_add_node` → `graph_add_edge` → `graph_run` would experience it.
 *
 * Modeled on `FiringDispatch` (tests/graph/engine-index.test.ts) and the
 * auto-completing seams of graph-run-atomic.test.ts / graph-run-idempotent.test.ts,
 * with the addition of per-node dispatch counting so a test can assert "node X
 * was dispatched exactly N times".
 *
 * Optional `hold` node ids keep their tasks `running` forever (never auto-fired),
 * for tests that need to observe mid-flight state before releasing manually.
 *
 * Usage:
 *   const fake = new ScriptedDispatch();
 *   const ts = new GraphToolSet({ dispatch: fake });
 *   const g = ts.graph_create({ name: "g" });
 *   ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });
 *   await ts.graph_run({ graph_id: g.graph_id });
 *   await settle();                       // let auto-completions drain
 *   expect(fake.dispatches("A")).toBe(1); // dispatched exactly once
 */

import type { NodeRuntimeState } from "../../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../../src/dispatch/types.ts";
import type {
  DispatchParentContext,
  TaskTerminatedCallback,
} from "../../../src/graph/engine/dispatch-bridge.ts";
import type { NodeDispatchPort } from "../../../src/graph/engine/engine-advance.ts";

export class ScriptedDispatch implements NodeDispatchPort {
  /** Every dispatch in creation order (nodeId + prompt), for call-site asserts. */
  calls: { nodeId: string; prompt: string }[] = [];
  private subs = new Map<string, TaskTerminatedCallback>();
  private tasks = new Map<string, DispatchTask>();
  private readonly hold = new Set<string>();
  private seq = 0;

  constructor(hold?: Iterable<string>) {
    if (hold) for (const id of hold) this.hold.add(id);
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
    if (!this.hold.has(node.nodeId)) {
      // Auto-complete on the next tick — same shape as the real dispatch
      // subsystem delivering a terminal transition.
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

  /** Every task id created, in creation order. */
  get taskIds(): string[] {
    return [...this.tasks.keys()];
  }

  /**
   * Fire the registered `onTaskTerminated` listener for a task — test-only
   * trigger for mid-flight terminations (cancelled / timeout refund paths,
   * e.g. graph-session-budget.test.ts). The subscription map is private, so
   * this is the seam tests use to inject a termination the engine observes.
   */
  fireTermination(taskId: string, status: string): void {
    const cb = this.subs.get(taskId);
    if (!cb) throw new Error(`no termination subscription for task "${taskId}"`);
    const task = this.tasks.get(taskId);
    if (task) task.status = status as DispatchTask["status"];
    cb(taskId, status);
  }
}

// ── Scripted-status variant ─────────────────────────────────────────────────

export type ScriptedStatus = "completed" | "error";

/**
 * Scripted-status variation of the shared `ScriptedDispatch` harness: identical
 * auto-complete-on-next-tick delivery seam and per-node dispatch counting, but
 * the terminal status is scripted per dispatch
 * (`(nodeId, ordinal) => status`). Status "error" routes through the real
 * dispatch→signal mapping to the `escalate` signal (engine-recovery.ts
 * `mapDispatchStatusToSignal`); "error" is not in `LIVE_DISPATCH_STATUSES`
 * (engine-recovery.ts:88-92), so the transient-error guard lets it advance.
 *
 * Established by graph-retry-cap-semantics.test.ts (where it originated) and
 * moved here so the escalate-retry regression suite shares one definition.
 */
export class ScriptedDispatchScript implements NodeDispatchPort {
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

/** Let chained `setTimeout`-driven task completions drain. */
export const settle = () => new Promise((r) => setTimeout(r, 25));
