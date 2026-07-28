/**
 * Graph Execution Engine v2 — Terminal-Notification Reopen Regression
 *
 * Covers defect B (B1 ordering + B2 stale dedupe guard) from the
 * `graph_run` retry path, where a terminal COMPLETE notification was
 * either prematurely emitted (B1) or permanently suppressed (B2) after
 * the retried chain legitimately quiesced.
 *
 * B1 (ordering): `graph_run()` used to call `runtime.run()` BEFORE
 * `runtime.retryNode()`. After `adoptPrior` loaded previously-terminal
 * nodes into a fresh engine, `run()` saw a quiescent graph and fired
 * COMPLETE — only then did `retryNode()` re-open the phase. Result: a
 * `[GRAPH COMPLETE]` arrived while nodes were still running/pending.
 *
 * B2 (stale dedupe guard): `_firedTerminalComplete` /
 * `_firedTerminalBlocked` are one-shot guards set by `_fireGraphTerminal`.
 * `retryNode()` re-opened the phase but never reset them — so after the
 * retried chain legitimately completed, the notification was permanently
 * suppressed (fired zero times).
 *
 * Test seams: uses AdvanceEngine with an injected `onGraphTerminal`
 * callback (a spy recording events with wall-clock timestamps). This is
 * the exact seam used by `engine-terminal.test.ts`. The engine-level seam
 * fires synchronously during `_checkTermination` inside the critical
 * section, so a post-call assertion is valid. A `settle()` is still
 * employed to flush any microtask-queued deferred completions, guarding
 * against async re-entrancy (the `_drainDeferred` finally block).
 */

import { describe, it, expect } from "bun:test";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type {
  EngineState,
  NodeRuntimeState,
} from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { DispatchParentContext } from "../../src/graph/engine/dispatch-bridge.ts";
import {
  createEngineState,
  provision,
  registerNode,
  addToFrontier,
} from "../../src/graph/engine/engine-state.ts";
import { markReady } from "../../src/graph/engine/node-lifecycle.ts";
import { SignalBridge } from "../../src/graph/engine/signal-bridge.ts";
import {
  AdvanceEngine,
  type NodeDispatchPort,
  type GraphTerminalEvent,
} from "../../src/graph/engine/engine-advance.ts";

// ── Fake dispatch seam (injectable into AdvanceEngine) ──────────────────────

class FakeDispatch implements NodeDispatchPort {
  calls: { nodeId: string; agent: string; prompt: string }[] = [];
  private seq = 0;

  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push({
      nodeId: node.nodeId,
      agent: node.agent,
      prompt: node.prompt,
    });
    this.seq += 1;
    return Promise.resolve({
      id: `task-${node.nodeId}-${this.seq}`,
      sessionId: `sess-${node.nodeId}-${this.seq}`,
      parentSessionId: "g-1",
      depth: 1,
      status: "running",
      agent: node.agent,
      prompt: node.prompt,
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
    });
  }
}

/** Let async microtask-queued work (deferred completions) settle. */
const settle = () => new Promise((r) => setTimeout(r, 20));

// ── Timed event spy ─────────────────────────────────────────────────────────

interface TimedEvent {
  event: GraphTerminalEvent;
  at: number;
}

/** Count timed events where `isBlocked` matches the given value. */
function countByBlocked(events: TimedEvent[], isBlocked: boolean): number {
  return events.filter((e) => e.event.isBlocked === isBlocked).length;
}

/** Count COMPLETE events (isBlocked === false). */
function completeCount(events: TimedEvent[]): number {
  return countByBlocked(events, false);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function singleNode(
  id = "A",
  agent = "a1",
): GraphDeclaration {
  return {
    version: 2,
    name: "single",
    nodes: [{ id, agent, prompt: `p-${id}` }],
    edges: [],
  };
}

/** A → B (linear chain, `always` edge). */
function linearAB(): GraphDeclaration {
  return {
    version: 2,
    name: "ab",
    nodes: [
      { id: "A", agent: "a1", prompt: "pA" },
      { id: "B", agent: "a2", prompt: "pB" },
    ],
    edges: [{ from: "A", to: "B", type: "always" }],
  };
}

/** A → B → C (linear chain, three nodes). */
function linearABC(): GraphDeclaration {
  return {
    version: 2,
    name: "abc",
    nodes: [
      { id: "A", agent: "a1", prompt: "pA" },
      { id: "B", agent: "a2", prompt: "pB" },
      { id: "C", agent: "a3", prompt: "pC" },
    ],
    edges: [
      { from: "A", to: "B", type: "always" },
      { from: "B", to: "C", type: "always" },
    ],
  };
}

interface AdvanceRig {
  state: EngineState;
  engine: AdvanceEngine;
  events: TimedEvent[];
  fake: FakeDispatch;
}

/**
 * Build an AdvanceEngine over a graph declaration with a recording
 * `onGraphTerminal` seam that timestamps every event. The fake dispatch
 * puts dispatched nodes in `Running` state; the caller completes them
 * via `onNodeSignalEmitted`.
 */
function buildEngine(
  decl: GraphDeclaration,
  graphId = "g-1",
): AdvanceRig {
  const fake = new FakeDispatch();
  const state = createEngineState(decl, graphId);
  provision(state);
  const bridge = new SignalBridge();
  const events: TimedEvent[] = [];
  const engine = new AdvanceEngine({
    state,
    signalBridge: bridge,
    dispatch: fake,
    onGraphTerminal: (event) => {
      events.push({ event, at: Date.now() });
    },
  });
  return { state, engine, events, fake };
}

/**
 * Add a new node configuration to the graph declaration and register it
 * as a root node (ready + frontier). Used by extend-after-complete tests.
 * Returns the registered NodeRuntimeState.
 */
function addRootNode(state: EngineState, id: string, agent: string): NodeRuntimeState {
  state.graphDeclaration.nodes.push({
    id,
    agent,
    prompt: `p-${id}`,
  });
  const node = registerNode(state, { id, agent, prompt: `p-${id}` });
  markReady(state, node);
  addToFrontier(state, id);
  return node;
}

// ── Test (a): B1 ordering — no premature COMPLETE on retry ───────────────────
//
// Pre-fix: `graph_run()` called `run()` before `retryNode()`. On a fresh
// engine after adoptPrior, `run()` saw all nodes terminal (adopted as
// completed), fired a COMPLETE with a stale count, and only THEN did
// `retryNode` re-open the phase. Result: COMPLETE arrived while the
// retried node was still running.
//
// Fix: `graph_run` skips `run()` on the retry path and calls
// `retryNode()` directly. This test verifies that `retryNode()` alone
// fires NO premature COMPLETE — the observable phase is `executing` with
// the retried node active.
//
// Revert-would-fail: if B1 were reverted and `run()` were called before
// `retryNode()`, the `run()` on a fresh engine with adopted complete
// nodes would transition idle→executing→complete, firing a second
// COMPLETE (with stale count) before `retryNode` re-opens. The assertion
// `expect(events).toHaveLength(1)` would see 2 — one legitimate, one
// premature — and fail.

describe("terminal notification on retry reopen (defect B)", () => {
  describe("(a) B1 ordering — no premature COMPLETE on retry", () => {
    it("retryNode on a completed single-node graph does not fire a second COMPLETE", async () => {
      const { state, engine, events } = buildEngine(singleNode("A"));

      // Drive to complete.
      await engine.dispatchReady();
      await engine.onNodeSignalEmitted("A", "answer", "done");

      expect(state.phase).toBe(EnginePhase.Complete);
      expect(events).toHaveLength(1);
      expect(events[0].event.isBlocked).toBe(false);
      expect(events[0].event.nodeStatusSummaries.completed).toBe(1);

      // Retry A (the fixed path — retryNode directly, no preceding run()).
      await engine.retryNode("A");
      // Flush any deferred completions queued by the critical-section drain.
      await settle();

      // B1 assertion: no premature COMPLETE fired during/intro after retry.
      expect(events).toHaveLength(1);
      expect(state.phase).toBe(EnginePhase.Executing);
      expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);
      // Stale count was NOT emitted — the single event captured the
      // original completion only.
      expect(events[0].event.nodeStatusSummaries.completed).toBe(1);
    });

    it("retryNode on a multi-node chain does not fire a premature COMPLETE", async () => {
      const { state, engine, events } = buildEngine(linearABC());

      // Complete the full chain A → B → C.
      await engine.dispatchReady();
      await engine.onNodeSignalEmitted("A", "answer", "ra");
      await engine.onNodeSignalEmitted("B", "answer", "rb");
      await engine.onNodeSignalEmitted("C", "answer", "rc");

      expect(state.phase).toBe(EnginePhase.Complete);
      expect(completeCount(events)).toBe(1);
      expect(events[0].event.nodeStatusSummaries.completed).toBe(3);

      // Retry the middle node B.
      await engine.retryNode("B");
      await settle();

      // Still exactly 1 COMPLETE — no premature fire.
      expect(completeCount(events)).toBe(1);
      expect(state.phase).toBe(EnginePhase.Executing);
      expect(state.nodes.get("B")!.status).toBe(NodeStatus.Running);
      // Downstream C reset to pending.
      expect(state.nodes.get("C")!.status).toBe(NodeStatus.Pending);
    });

    it("demonstrates that a fresh-engine run() after adoption fires a premature COMPLETE (the pre-fix B1 bug)", async () => {
      // This test explicitly demonstrates the pre-fix B1 behavior:
      // after adopting a completed graph into a fresh engine, calling
      // `run()` fires a premature COMPLETE. The fix avoids this by
      // skipping `run()` and calling `retryNode()` directly.
      //
      // Build engine 1: complete the graph.
      const rig1 = buildEngine(singleNode("A"), "g-demo");
      await rig1.engine.dispatchReady();
      await rig1.engine.onNodeSignalEmitted("A", "answer", "ok");
      expect(rig1.state.phase).toBe(EnginePhase.Complete);
      expect(rig1.events).toHaveLength(1);

      // Simulate the old B1 path: create a fresh engine, manually adopt
      // the prior state, then call run() — this fires a premature
      // COMPLETE because the fresh engine sees a quiescent graph.
      const rig2 = buildEngine(singleNode("A"), "g-demo-fresh");
      // Manually set every node to Completed and set the frontier empty
      // (mimicking what adoptPrior does to a fresh engine — copy node
      // states but leave the engine's own phase at Idle).
      for (const n of rig2.state.nodes.values()) {
        n.status = NodeStatus.Completed;
        n.startedAt = Date.now();
        n.sessionsSpawned = 1;
        n.signalsObserved["answer"] = "ok";
      }
      rig2.state.frontier = [];

      // OLD B1 PATH: run() before retryNode().
      await rig2.engine.dispatchReady(); // this fires COMPLETE prematurely
      expect(rig2.state.phase).toBe(EnginePhase.Complete);
      // The premature COMPLETE fired — this is the bug.
      expect(rig2.events).toHaveLength(1);
      expect(rig2.events[0].event.isBlocked).toBe(false);
      expect(rig2.events[0].event.nodeStatusSummaries.completed).toBe(1);

      // Then retryNode — the old code would call this AFTER run().
      await rig2.engine.retryNode("A");
      // No additional COMPLETE during retry (but B2 would suppress later
      // legitimate completions — tested in (b)).
      expect(rig2.state.phase).toBe(EnginePhase.Executing);

      // Summary: the old B1 path fired a premature COMPLETE (1 event).
      // The fix (tested in the preceding cases) skips `run()` entirely,
      // so no premature event fires — `completeCount(events)` stays at
      // the original count rather than incremented by a stale fire.
    });
  });

  // ── Test (b): B2 stale dedupe guard — exactly-once fire after retry ────────
  //
  // Pre-fix: `retryNode` re-opened the phase via `resetNodeForRetry` but
  // never reset `_firedTerminalComplete` / `_firedTerminalBlocked` (the
  // one-shot dedupe guards set by `_fireGraphTerminal`). After the retried
  // chain legitimately completed, the notification was permanently
  // suppressed — zero fires, not one.
  //
  // Fix: both guards are reset in `retryNode()` after the phase re-open
  // (`engine-advance.ts:1245-1246`).
  //
  // Revert-would-fail: if the guard-reset lines were removed, the second
  // `_checkTermination()` after the retried chain completes would hit the
  // still-true `_firedTerminalComplete` guard and skip the callback. The
  // total COMPLETE count would be 1 (only the original), but it should
  // be 2.

  describe("(b) B2 stale dedupe guard — exactly-once on retry completion", () => {
    it("fires COMPLETE exactly once after the retried single node completes", async () => {
      const { state, engine, events } = buildEngine(singleNode("A"));

      // First completion: COMPLETE #1.
      await engine.dispatchReady();
      await engine.onNodeSignalEmitted("A", "answer", "run-1");
      expect(completeCount(events)).toBe(1);
      expect(state.phase).toBe(EnginePhase.Complete);

      // Retry A — the dedupe guards are reset inside retryNode (B2 fix).
      await engine.retryNode("A");
      await settle();
      expect(state.phase).toBe(EnginePhase.Executing);
      expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);
      // No COMPLETE fired during retry.
      expect(completeCount(events)).toBe(1);

      // Complete the retried node → COMPLETE #2 MUST fire.
      await engine.onNodeSignalEmitted("A", "answer", "run-2");
      await settle();

      // B2 assertion: exactly twice, not once (pre-fix zero-suppression).
      expect(completeCount(events)).toBe(2);
      expect(state.phase).toBe(EnginePhase.Complete);
      expect(events[1].event.isBlocked).toBe(false);
      expect(events[1].event.nodeStatusSummaries.completed).toBe(1);
    });

    it("fires COMPLETE exactly once after the retried chain (A→B) completes", async () => {
      const { state, engine, events } = buildEngine(linearAB());

      // Complete both nodes.
      await engine.dispatchReady();
      await engine.onNodeSignalEmitted("A", "answer", "ra1");
      await engine.onNodeSignalEmitted("B", "answer", "rb1");
      expect(completeCount(events)).toBe(1);
      expect(events[0].event.nodeStatusSummaries.completed).toBe(2);
      expect(state.phase).toBe(EnginePhase.Complete);

      // Retry B (downstream of A).
      await engine.retryNode("B");
      await settle();
      expect(state.phase).toBe(EnginePhase.Executing);
      // A is still completed (untouched by retry of B).
      expect(state.nodes.get("A")!.status).toBe(NodeStatus.Completed);
      // B re-dispatched.
      expect(state.nodes.get("B")!.status).toBe(NodeStatus.Running);
      expect(completeCount(events)).toBe(1); // no premature fire

      // Complete the retried B → COMPLETE #2 MUST fire.
      await engine.onNodeSignalEmitted("B", "answer", "rb2");
      await settle();

      // B2 assertion: exactly 2 COMPLETE events total.
      expect(completeCount(events)).toBe(2);
      expect(state.phase).toBe(EnginePhase.Complete);
      expect(events[1].event.nodeStatusSummaries.completed).toBe(2);
      // A is still counted as completed in the second event.
    });

    it("fires COMPLETE exactly once per retry — two retries → three completions", async () => {
      const { state, engine, events } = buildEngine(singleNode("A"));

      // First completion: COMPLETE #1.
      await engine.dispatchReady();
      await engine.onNodeSignalEmitted("A", "answer", "run-1");
      expect(completeCount(events)).toBe(1);

      // First retry → complete → COMPLETE #2.
      await engine.retryNode("A");
      await engine.onNodeSignalEmitted("A", "answer", "run-2");
      await settle();
      expect(completeCount(events)).toBe(2);

      // Second retry → complete → COMPLETE #3.
      await engine.retryNode("A", { modifyPrompt: "third try" });
      await engine.onNodeSignalEmitted("A", "answer", "run-3");
      await settle();

      // B2 assertion: each retry produces its own legitimate COMPLETE.
      expect(completeCount(events)).toBe(3);
      expect(state.phase).toBe(EnginePhase.Complete);
    });

    it("does NOT double-fire for the same retry completion (dedupe guard resets cleanly)", async () => {
      const { state, engine, events } = buildEngine(singleNode("A"));

      // First completion.
      await engine.dispatchReady();
      await engine.onNodeSignalEmitted("A", "answer", "r1");
      expect(completeCount(events)).toBe(1);

      // Retry.
      await engine.retryNode("A");
      // Complete the retry.
      await engine.onNodeSignalEmitted("A", "answer", "r2");
      await settle();
      expect(completeCount(events)).toBe(2);

      // Re-emit the same signal (idempotent replay) — no third COMPLETE.
      await engine.onNodeSignalEmitted("A", "answer", "r2");
      await settle();

      // Exactly 2 — dedupe guard for the second completion is set and
      // prevents a double-fire.
      expect(completeCount(events)).toBe(2);
    });
  });

  // ── Test (c): extend-after-complete — no COMPLETE while nodes active ───────
  //
  // Take a graph that reached `phase: complete`, add a new node, run
  // (non-retry path), let everything finish. Assert:
  // 1. COMPLETE fires exactly once for the new completion.
  // 2. No COMPLETE is emitted while any node is still `running` or
  //    `pending`.
  //
  // Pre-fix (B1-type concern): the earlier `graph_run` call on a quiescent
  // graph could fire a stale COMPLETE before the newly-added node was
  // dispatched. In the fix, `run()` dispatches the new ready node and
  // `_checkTermination` sees it as active → no premature COMPLETE.
  //
  // Async concern: the `onGraphTerminal` callback fires synchronously
  // inside `_checkTermination` within the critical section. The post-call
  // `events.length` check is valid. A `settle()` flush guards against
  // deferred-completion re-entrancy (`_drainDeferred` in finally).
  //
  // Revert-would-fail: if the early-B1 `run()` firing were re-introduced,
  // the second `run()` (after the extend) would fire a COMPLETE with just
  // the original completed node count, THEN the new node would complete,
  // producing two COMPLETEs — one stale, one legitimate — instead of
  // exactly one.

  describe("(c) extend-after-complete", () => {
    it("fires exactly one additional COMPLETE after adding and completing a new node", async () => {
      const { state, engine, events } = buildEngine(singleNode("A"));

      // Phase 1: complete the single-node graph.
      await engine.dispatchReady();
      await engine.onNodeSignalEmitted("A", "answer", "done");
      expect(completeCount(events)).toBe(1);
      expect(state.phase).toBe(EnginePhase.Complete);
      expect(state.nodes.get("A")!.status).toBe(NodeStatus.Completed);

      // Extend: add a new root node "B" (simulating `graph_add_node`
      // after the graph reached complete).
      addRootNode(state, "B", "b1");

      // Re-open the terminal phase to Executing before dispatching.
      // In the real `graph_run` flow, the engine is rebuilt fresh
      // (phase Idle) and run() transitions Idle→Executing. Here we
      // reuse the same engine instance, so we must manually re-open
      // the phase and reset the terminal dedupe guard — exactly as
      // `retryNode` does for retries (engine-advance.ts:1245-1246).
      state.phase = EnginePhase.Executing;
      // eslint-disable-next-line dot-notation, @typescript-eslint/dot-notation
      (engine as unknown as Record<string, boolean>)["_firedTerminalComplete"] = false;
      (engine as unknown as Record<string, boolean>)["_firedTerminalBlocked"] = false;

      // Now call dispatchReady (the non-retry path, like a plain
      // `graph_run`). This dispatches B and checks termination. Since
      // B is running, no COMPLETE should fire yet.
      await engine.dispatchReady();
      await settle();

      // Assert no COMPLETE while B is still running.
      expect(state.nodes.get("B")!.status).toBe(NodeStatus.Running);
      expect(completeCount(events)).toBe(1); // NO premature COMPLETE

      // Complete B.
      await engine.onNodeSignalEmitted("B", "answer", "B-done");
      await settle();

      // Exactly 2 COMPLETEs total: the original + the new one.
      expect(completeCount(events)).toBe(2);
      expect(state.phase).toBe(EnginePhase.Complete);
      expect(events[1].event.nodeStatusSummaries.completed).toBe(2);
    });

    it("does NOT fire COMPLETE while any node is running or pending during extend", async () => {
      const { state, engine, events } = buildEngine(linearAB());

      // Complete A and B first.
      await engine.dispatchReady();
      await engine.onNodeSignalEmitted("A", "answer", "ra");
      await engine.onNodeSignalEmitted("B", "answer", "rb");
      expect(completeCount(events)).toBe(1);
      expect(state.phase).toBe(EnginePhase.Complete);

      // Extend: add a new root node C (no edges, root).
      addRootNode(state, "C", "c1");

      // Re-open terminal phase and reset dedupe guards for the extend.
      state.phase = EnginePhase.Executing;
      (engine as unknown as Record<string, boolean>)["_firedTerminalComplete"] = false;
      (engine as unknown as Record<string, boolean>)["_firedTerminalBlocked"] = false;

      // Dispatch C — it becomes Running.
      await engine.dispatchReady();

      // CRITICAL: while C is Running, COMPLETE must NOT fire.
      expect(state.nodes.get("C")!.status).toBe(NodeStatus.Running);
      expect(completeCount(events)).toBe(1);

      // Now complete C.
      await engine.onNodeSignalEmitted("C", "answer", "rc");
      await settle();

      // COMPLETE fires exactly once more.
      expect(completeCount(events)).toBe(2);
      expect(state.phase).toBe(EnginePhase.Complete);
      // The second event counts all 3 nodes as completed.
      expect(events[1].event.nodeStatusSummaries.completed).toBe(3);
    });

    it("extend then retry: no COMPLETE during retry, exactly one after completion", async () => {
      // Hybrid: first complete, then extend + retry a different node.
      const { state, engine, events } = buildEngine(linearAB());

      // Complete.
      await engine.dispatchReady();
      await engine.onNodeSignalEmitted("A", "answer", "ra1");
      await engine.onNodeSignalEmitted("B", "answer", "rb1");
      expect(completeCount(events)).toBe(1);

      // Extend: add node C.
      addRootNode(state, "C", "c1");

      // Re-open terminal phase and reset dedupe guards.
      state.phase = EnginePhase.Executing;
      (engine as unknown as Record<string, boolean>)["_firedTerminalComplete"] = false;
      (engine as unknown as Record<string, boolean>)["_firedTerminalBlocked"] = false;

      // Dispatch C to running, then complete it.
      await engine.dispatchReady();
      expect(state.nodes.get("C")!.status).toBe(NodeStatus.Running);
      await engine.onNodeSignalEmitted("C", "answer", "rc1");
      await settle();
      expect(completeCount(events)).toBe(2);

      // Now retry B while C is done.
      await engine.retryNode("B");
      await settle();
      // No premature COMPLETE during retry.
      expect(completeCount(events)).toBe(2);
      expect(state.phase).toBe(EnginePhase.Executing);

      // Complete retried B → COMPLETE #3.
      await engine.onNodeSignalEmitted("B", "answer", "rb2");
      await settle();

      expect(completeCount(events)).toBe(3);
      expect(state.phase).toBe(EnginePhase.Complete);
    });
  });

  // ── BLOCKED dedupe guard reset ─────────────────────────────────────────────
  //
  // Verify that `retryNode` also resets `_firedTerminalBlocked` (the
  // blocked dedupe guard), so that after a blocked-then-retry-then-complete
  // cycle, the graph can enter a legitimate blocked state again from the
  // retried branch. This is the symmetric half of the B2 fix.

  describe("B2 blocked guard reset", () => {
    it("allows a blocked event to fire after a retry that follows a prior blocked state", async () => {
      // Build a graph with one approval-gated node G.
      const decl: GraphDeclaration = {
        version: 2,
        name: "blocked-retry",
        nodes: [{ id: "G", agent: "g1", prompt: "pG", needs_approval: true }],
        edges: [],
      };
      const { state, engine, events } = buildEngine(decl);

      // Dispatch → G becomes blocked → BLOCKED fires.
      await engine.dispatchReady();
      await engine.onNodeSignalEmitted("G", "need_approval", "please review");
      expect(events).toHaveLength(1);
      expect(events[0].event.isBlocked).toBe(true);

      // Approve G → COMPLETE fires.
      await engine.approveNode("G", "approved");
      expect(state.phase).toBe(EnginePhase.Complete);
      expect(events).toHaveLength(2);
      expect(events[1].event.isBlocked).toBe(false);

      // Retry G.
      await engine.retryNode("G", { modifyPrompt: "retry approved" });
      await settle();
      expect(state.phase).toBe(EnginePhase.Executing);

      // G is running again → emit need_approval → BLOCKED MUST fire again.
      await engine.onNodeSignalEmitted("G", "need_approval", "review again");
      await settle();

      // BLOCKED guard was reset by retryNode → blocked event fires.
      const blockedCount = countByBlocked(events, true);
      expect(blockedCount).toBe(2);
    });
  });

  // ── Async non-vacuous guard ─────────────────────────────────────────────────
  //
  // The `onGraphTerminal` callback fires synchronously inside
  // `_checkTermination` within the advancement critical section. Deferred
  // completions (drained in `_runCriticalSection`'s `finally`) are also
  // flushed before the method returns (they are `await`ed). Therefore a
  // post-call `events.length` check is deterministic — no async gap.
  //
  // To make the non-fire assertion robust against any theoretical deferred
  // re-entrancy, every test case above calls `await settle()` after the
  // retry/dispatch operation before checking `events.length`. The settle
  // flushes any microtask-queued work (e.g., a deferred completion that
  // fires a COMPLETE after `retryNode` resolves). A test that fails to
  // settle could miss a stray notification; this guard eliminates that
  // risk.
  //
  // Additionally, every event records a wall-clock timestamp (`Date.now()`)
  // so events are ordered. The `completeCount` helper filters by
  // `isBlocked: false` for precise assertion targets.

  describe("async non-vacuous guard for no-fire assertions", () => {
    it("settle-based flush prevents false-negative 'no fire' checks", async () => {
      const { state, engine, events } = buildEngine(singleNode("A"));

      await engine.dispatchReady();
      await engine.onNodeSignalEmitted("A", "answer", "done");
      expect(completeCount(events)).toBe(1);
      expect(state.phase).toBe(EnginePhase.Complete);

      // Without the settle, a microtask-queued deferred completion could
      // fire a COMPLETE after retryNode returns. The settle ensures the
      // queue drains before our assertion.
      await engine.retryNode("A");
      await settle(); // <-- the critical flush

      // Verified: no extra COMPLETE after flush.
      expect(completeCount(events)).toBe(1);
      expect(state.phase).toBe(EnginePhase.Executing);
      // Timestamps confirm ordering: the single event preceded retryNode.
      expect(events[0].at).toBeLessThanOrEqual(Date.now());
    });
  });
});
