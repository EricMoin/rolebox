/**
 * Graph Execution Engine v2 — Escalate-retry backoff (subtask 2)
 *
 * End-to-end pinning of the retry-backoff withholding window through the
 * public `createEngine` surface: when the escalate-retry gate re-marks a node
 * `ready` with `retryBackoffUntil = now + backoff_ms` (signal-propagation.ts,
 * subtask 1), the dispatch pass must SKIP the node — leaving it Ready in the
 * frontier — and the engine must re-dispatch it only after the deadline via
 * the single wake-up timer. Covers the three verify contracts:
 *
 *  (a) Timing — with `retry {max:2, backoff_ms:50}`, each re-dispatch lands
 *      >= 50ms after the prior attempt's escalate.
 *  (b) Phase — the graph stays `executing` (never `complete`) between the
 *      escalate and the delayed re-dispatch: the withheld Ready node is
 *      scheduler-active to `checkGraphTermination`.
 *  (c) Teardown — `dispose()` clears the pending wake-up timer: no dispatch
 *      occurs after teardown, even past the would-be deadline.
 *
 * Plus unit coverage of the two cross-run persistence seams:
 *  (d) `serializeEngineState` → `deserializeEngineState` round-trips
 *      `retryBackoffUntil` (the DTO carries it via `...rest` + the explicit
 *      lines, so a restart never re-dispatches early).
 *  (e) `adoptPriorNodeStates` carries `retryBackoffUntil` across a rebuild so
 *      a rebuilt engine's first dispatch pass withholds the retry.
 *
 * Harness: a scripted dispatch seam identical in shape to
 * `ScriptedDispatchScript` (graph-retry-cap-semantics.test.ts) — terminal
 * status per dispatch, `"error"` routed through the real
 * `mapDispatchStatusToSignal` mapping to the `escalate` signal — plus per-node
 * dispatch timestamps for the timing assertions.
 */

import { describe, it, expect } from "bun:test";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { NodeRuntimeState } from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type {
  DispatchParentContext,
  TaskTerminatedCallback,
} from "../../src/graph/engine/dispatch-bridge.ts";
import type { NodeDispatchPort } from "../../src/graph/engine/engine-advance.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import { createEngine } from "../../src/graph/engine/index.ts";
import {
  createEngineState,
  provision,
} from "../../src/graph/engine/engine-state.ts";
import { adoptPriorNodeStates } from "../../src/graph/engine/engine-recovery.ts";
import {
  deserializeEngineState,
  serializeEngineState,
} from "../../src/graph/engine/engine-persistence.ts";

// ── Scripted dispatch seam with per-dispatch timestamps ─────────────────────

type ScriptedStatus = "completed" | "error";

/**
 * Auto-completes every dispatched task on a `setTimeout(0)` tick with a
 * scripted terminal status (`(nodeId, ordinal) => status`), firing the real
 * `onTaskTerminated` seam — so signal advancement flows through the public
 * engine API exactly as a live dispatch would. Records the wall-clock time of
 * each `executeNode` call for the backoff-interval assertions.
 */
class BackoffDispatch implements NodeDispatchPort {
  private calls: { nodeId: string; at: number }[] = [];
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
    this.calls.push({ nodeId: node.nodeId, at: Date.now() });
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

  /** Wall-clock time (epoch ms) of each dispatch of `nodeId`, in order. */
  times(nodeId: string): number[] {
    return this.calls.filter((c) => c.nodeId === nodeId).map((c) => c.at);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Linear A → B with the given retry policy on the outbound edge. */
function linearDecl(
  name: string,
  retry: { max: number; backoff_ms: number },
): GraphDeclaration {
  return {
    version: 2,
    name,
    nodes: [
      { id: "A", agent: "a", prompt: "pA" },
      { id: "B", agent: "b", prompt: "pB" },
    ],
    edges: [{ from: "A", to: "B", type: "always", retry }],
  };
}

/** Poll a condition every 5ms until it holds or the timeout expires. */
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════

describe("engine escalate-retry backoff", () => {
  // ── (a) + (b): timing + phase ─────────────────────────────────────────────

  it("with edge retry {max:2, backoff_ms:50}, each re-dispatch is withheld >=50ms and the phase stays Executing during the backoff window", async () => {
    const fake = new BackoffDispatch((nodeId, ordinal) =>
      nodeId === "A" && ordinal < 2 ? "error" : "completed",
    );
    const engine = createEngine(
      linearDecl("backoff-timing", { max: 2, backoff_ms: 50 }),
      { dispatch: fake },
    );
    await engine.run();

    // ── First escalate lands → A re-marked ready, withheld in the frontier ──
    // Snapshot the clock before the (unbounded) waitFor: the deadline is
    // stamped at escalate-processing time — strictly after `before` (the
    // scripted error tick is a macrotask; this continuation is a microtask) —
    // so the future-window assertions hold under any scheduling jitter. A
    // fresh `Date.now()` after the poll would race the 50ms window on a loaded
    // CI runner.
    const before = Date.now();
    await waitFor(() => {
      const s = engine.status();
      const a = s.nodes.get("A");
      return (
        a !== undefined &&
        a.status === NodeStatus.Ready &&
        a.retryCount === 1
      );
    }, 200);
    let s = engine.status();
    expect(fake.dispatches("A")).toBe(1); // never re-dispatched early
    expect(s.nodes.get("A")!.retryBackoffUntil).toBeGreaterThanOrEqual(before + 50);
    expect(s.nodes.get("A")!.retryBackoffUntil).toBeLessThanOrEqual(Date.now() + 50);
    // The graph must NOT complete while the retry is backed off — the withheld
    // Ready node is scheduler-active to checkGraphTermination.
    expect(s.phase).toBe(EnginePhase.Executing);

    // ── First re-dispatch lands only after the 50ms backoff window ─────────
    await waitFor(() => fake.dispatches("A") === 2, 500);
    const t = fake.times("A");
    expect(t[1] - t[0]).toBeGreaterThanOrEqual(50);
    // The second retry is itself backed off right after landing (the task
    // error tick follows within ~1ms) — the graph is still executing, never
    // complete, between the escalate and the delayed re-dispatch.
    expect(engine.status().phase).toBe(EnginePhase.Executing);

    // ── Second re-dispatch lands with an answer → B → graph completes ──────
    await waitFor(() => engine.status().phase === EnginePhase.Complete, 500);
    const tFinal = fake.times("A");
    expect(tFinal[2] - tFinal[1]).toBeGreaterThanOrEqual(50);
    expect(fake.dispatches("A")).toBe(3); // initial + 2 backoff-withheld retries
    expect(fake.dispatches("B")).toBe(1); // answer flowed forward on A's 3rd attempt
    const fin = engine.status();
    expect(fin.nodes.get("A")!.retryCount).toBe(2); // capped by the edge policy
    expect(fin.nodes.get("A")!.status).toBe(NodeStatus.Completed);
    engine.dispose();
  });

  // ── (c): dispose clears the wake-up timer ────────────────────────────────

  it("disposing the engine clears the backoff timer — no dispatch after teardown", async () => {
    const fake = new BackoffDispatch(() => "error"); // A always escalates
    const engine = createEngine(
      linearDecl("backoff-dispose", { max: 2, backoff_ms: 40 }),
      { dispatch: fake },
    );
    await engine.run();

    // First escalate lands → A withheld Ready, wake-up timer armed for ~40ms.
    await waitFor(() => {
      const s = engine.status();
      const a = s.nodes.get("A");
      return (
        a !== undefined &&
        a.status === NodeStatus.Ready &&
        a.retryCount === 1
      );
    }, 200);
    expect(fake.dispatches("A")).toBe(1);
    expect(engine.status().phase).toBe(EnginePhase.Executing);

    // Teardown: dispose the runtime → the pending wake-up timer is cleared
    // (S7 dispose path, beside clearTerminationSubscriptions).
    engine.dispose();

    // Wait well past the would-be backoff deadline — no re-dispatch may occur.
    await settle(150);
    expect(fake.dispatches("A")).toBe(1);
  });

  // ── (d): persistence round-trip ──────────────────────────────────────────

  it("serializeEngineState → deserializeEngineState round-trips retryBackoffUntil", () => {
    const state = createEngineState(
      linearDecl("backoff-persist", { max: 2, backoff_ms: 10 }),
      "g-backoff-persist",
    );
    provision(state);
    const a = state.nodes.get("A")!;
    a.status = NodeStatus.Ready;
    a.retryCount = 1;
    a.retryBackoffUntil = Date.now() + 5_000;

    // DTO carries the deadline (via `...rest` + the explicit serialize line).
    const dto = serializeEngineState(state);
    expect(dto.nodes["A"].retryBackoffUntil).toBe(a.retryBackoffUntil);

    // Hydration restores it, so a recovered Ready node keeps withholding.
    const restored = deserializeEngineState(dto);
    expect(restored.nodes.get("A")!.retryBackoffUntil).toBe(a.retryBackoffUntil);
    expect(restored.nodes.get("A")!.retryCount).toBe(1);
    expect(restored.nodes.get("A")!.status).toBe(NodeStatus.Ready);
  });

  // ── (e): adoption across a rebuild ───────────────────────────────────────

  it("adoptPriorNodeStates carries retryBackoffUntil across a rebuild", () => {
    const decl = linearDecl("backoff-adopt", { max: 2, backoff_ms: 10 });
    const prior = createEngineState(decl, "g-backoff-adopt");
    provision(prior);
    const priorA = prior.nodes.get("A")!;
    priorA.status = NodeStatus.Ready;
    priorA.retryCount = 1;
    priorA.retryBackoffUntil = Date.now() + 5_000;

    const target = createEngineState(decl, "g-backoff-adopt");
    provision(target);

    adoptPriorNodeStates(target, prior);

    const adopted = target.nodes.get("A")!;
    // A is a root (no incoming edges) — the post-adoption in-degree
    // reconciliation keeps it Ready and in the frontier.
    expect(adopted.status).toBe(NodeStatus.Ready);
    expect(target.frontier).toContain("A");
    expect(adopted.retryCount).toBe(1);
    expect(adopted.retryBackoffUntil).toBe(priorA.retryBackoffUntil);
  });
});
