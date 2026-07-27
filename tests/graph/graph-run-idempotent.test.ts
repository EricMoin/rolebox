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

import { describe, it, expect } from "bun:test";
import { NodeStatus } from "../../src/constants.ts";
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

const dispatches = (fake: CompletingDispatch, nodeId: string) =>
  fake.calls.filter((c) => c.nodeId === nodeId).length;

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
