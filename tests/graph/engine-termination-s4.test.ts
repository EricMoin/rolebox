/**
 * Graph Execution Engine v2 — S4: M1 synthetic-escalation seam + M10
 * two-layer terminal-notification dedupe
 *
 * Covers the monitor-observation fixes landed in engine-termination.ts:
 *
 * M1 (synthetic escalation observability): the runtime deadlock guard
 * synthetically escalates every pending node. `checkGraphTermination` now
 * accepts an optional `onSyntheticEscalate(nodeId, reason)` callback invoked
 * once per escalated node, so the caller (monitor / notification layer) can
 * surface the synthetic escalation instead of it being silent.
 *
 * M10 / F15 (cross-restart exact-once): terminal notifications are deduped at
 * TWO layers — the per-instance {@link TerminationContext} AND the persisted
 * `EngineState.terminalNotified` flag. A fire requires both unclaimed; a fire
 * claims both and marks the state dirty. A preset `terminalNotified` flag
 * (simulating a persisted state loaded by a fresh engine instance after a
 * restart) suppresses re-delivery even with a fresh context. When the graph is
 * re-opened (active nodes present), the stale cross-restart guard is cleared
 * so the retried/extended chain's next terminal event still fires.
 *
 * These are direct unit tests of the module — no dispatch seam required.
 */

import { describe, it, expect } from "bun:test";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { EngineState } from "../../src/types.engine-v2.ts";
import {
  createEngineState,
  provision,
} from "../../src/graph/engine/engine-state.ts";
import {
  checkGraphTermination,
  type GraphTerminalEvent,
  type TerminationContext,
} from "../../src/graph/engine/engine-termination.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Single-root node graph (A is a root → provision leaves it `ready`). */
function singleNode(
  id = "A",
  agent = "a1",
  extra: Partial<GraphDeclaration["nodes"][number]> = {},
): GraphDeclaration {
  return {
    version: 2,
    name: "single",
    nodes: [{ id, agent, prompt: "p1", ...extra }],
    edges: [],
  };
}

/**
 * Unrooted always-cycle: a ⇄ b with NO loop group. Every node has in-degree
 * ≥1 and there is no `always`-edge exclusion, so provision leaves both nodes
 * `pending` and the frontier empty — a runtime deadlock.
 */
function unrootedCycleGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "unrooted-cycle",
    nodes: [
      { id: "a", agent: "a1", prompt: "p1" },
      { id: "b", agent: "a2", prompt: "p2" },
    ],
    edges: [
      { from: "a", to: "b", type: "always" },
      { from: "b", to: "a", type: "always" },
    ],
  };
}

/** Fresh per-instance dedupe context. */
function freshCtx(): TerminationContext {
  return { terminalComplete: false, terminalBlocked: false };
}

/** Recording onGraphTerminal spy. */
function spy(): { events: GraphTerminalEvent[]; cb: (e: GraphTerminalEvent) => void } {
  const events: GraphTerminalEvent[] = [];
  return { events, cb: (e) => events.push(e) };
}

/** Quiesce a single-node graph: complete the root and empty the frontier. */
function quiesce(state: EngineState, nodeId = "A"): void {
  const node = state.nodes.get(nodeId);
  if (!node) throw new Error(`node ${nodeId} not found`);
  node.status = NodeStatus.Completed;
  state.frontier = [];
}

// ── M1: synthetic-escalation observer seam ───────────────────────────────────

describe("M1 onSyntheticEscalate (deadlock guard)", () => {
  it("invokes the callback once per escalated pending node, in order", () => {
    const state = createEngineState(unrootedCycleGraph(), "g-1");
    provision(state); // both a and b pending, frontier empty
    state.phase = EnginePhase.Executing;

    const escalated: { nodeId: string; reason: string }[] = [];
    checkGraphTermination(
      state,
      undefined,
      freshCtx(),
      (nodeId, reason) => escalated.push({ nodeId, reason }),
    );

    // One call per pending node, in node-iteration (declaration) order.
    expect(escalated).toHaveLength(2);
    expect(escalated.map((e) => e.nodeId)).toEqual(["a", "b"]);
    expect(escalated[0].reason).toContain("graph deadlock");
    expect(escalated[1].reason).toBe(escalated[0].reason);
    // The guard still quiesces the graph exactly as before.
    expect(state.nodes.get("a")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("b")!.status).toBe(NodeStatus.Escalate);
    expect(state.phase).toBe(EnginePhase.Complete);
  });

  it("does not invoke the callback for non-pending nodes (only the deadlocked ones)", () => {
    // root → A ⇄ B unprotected cycle: root is the sole root and completes;
    // only the pending cycle members A and B are synthetically escalated.
    const decl: GraphDeclaration = {
      version: 2,
      name: "root-cycle",
      nodes: [
        { id: "root", agent: "r", prompt: "pr" },
        { id: "A", agent: "a1", prompt: "p1" },
        { id: "B", agent: "a2", prompt: "p2" },
      ],
      edges: [
        { from: "root", to: "A", type: "always" },
        { from: "A", to: "B", type: "always" },
        { from: "B", to: "A", type: "always" },
      ],
    };
    const state = createEngineState(decl, "g-2");
    provision(state);
    state.phase = EnginePhase.Executing;
    quiesce(state, "root"); // root completed; A + B pending → deadlock

    const escalated: string[] = [];
    checkGraphTermination(state, undefined, freshCtx(), (nodeId) => escalated.push(nodeId));

    expect(escalated).toEqual(["A", "B"]);
    expect(escalated).not.toContain("root");
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("root")!.status).toBe(NodeStatus.Completed);
  });

  it("is a strict no-op when the callback is not supplied (behavior unchanged)", () => {
    const state = createEngineState(unrootedCycleGraph(), "g-3");
    provision(state);
    state.phase = EnginePhase.Executing;

    checkGraphTermination(state, undefined, freshCtx());

    expect(state.nodes.get("a")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("b")!.status).toBe(NodeStatus.Escalate);
    expect(state.phase).toBe(EnginePhase.Complete);
  });

  it("a throwing observer does not break the deadlock quiescence", () => {
    const state = createEngineState(unrootedCycleGraph(), "g-4");
    provision(state);
    state.phase = EnginePhase.Executing;

    expect(() =>
      checkGraphTermination(
        state,
        undefined,
        freshCtx(),
        () => {
          throw new Error("observer exploded");
        },
      ),
    ).not.toThrow();

    expect(state.nodes.get("a")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("b")!.status).toBe(NodeStatus.Escalate);
    expect(state.phase).toBe(EnginePhase.Complete);
  });
});

// ── M10: two-layer terminal-notification dedupe ──────────────────────────────

describe("M10 terminalNotified two-layer dedupe", () => {
  it("does NOT fire when state.terminalNotified.complete is preset and the ctx is fresh (cross-restart)", () => {
    const state = createEngineState(singleNode("A"), "g-10");
    provision(state);
    state.phase = EnginePhase.Executing;
    quiesce(state); // all nodes terminal → quiescent-complete path
    state.terminalNotified = { complete: true, blocked: false }; // persisted by a prior instance

    const { events, cb } = spy();
    const ctx = freshCtx();
    checkGraphTermination(state, cb, ctx);

    // Fresh engine instance over a persisted terminal state: NO re-fire, even
    // though the graph itself correctly advances to the complete phase.
    expect(events).toHaveLength(0);
    expect(ctx.terminalComplete).toBe(false);
    expect(state.terminalNotified).toEqual({ complete: true, blocked: false });
    expect(state.phase).toBe(EnginePhase.Complete); // advancement is unaffected
  });

  it("does NOT fire BLOCKED when state.terminalNotified.blocked is preset", () => {
    const state = createEngineState(
      singleNode("G", "g1", { needs_approval: true }),
      "g-11",
    );
    provision(state);
    state.phase = EnginePhase.Executing;
    state.nodes.get("G")!.status = NodeStatus.Blocked;
    state.frontier = [];
    state.terminalNotified = { complete: false, blocked: true };

    const { events, cb } = spy();
    checkGraphTermination(state, cb, freshCtx());

    expect(events).toHaveLength(0);
    expect(state.phase).toBe(EnginePhase.Executing); // blocked path: no phase transition
  });

  it("fires exactly once on a quiescent graph, claims BOTH layers and marks dirty", () => {
    const state = createEngineState(singleNode("A"), "g-12");
    provision(state);
    state.phase = EnginePhase.Executing;
    quiesce(state);
    state.isDirty = false; // isolate fireGraphTerminal's dirty write

    const { events, cb } = spy();
    const ctx = freshCtx();
    checkGraphTermination(state, cb, ctx);

    expect(events).toHaveLength(1);
    expect(events[0].isBlocked).toBe(false);
    expect(events[0].phase).toBe(EnginePhase.Complete);
    // Both layers claimed after the fire.
    expect(ctx.terminalComplete).toBe(true);
    expect(state.terminalNotified).toEqual({ complete: true, blocked: false });
    // The cross-restart claim is a critical mutation → dirty flag set.
    expect(state.isDirty).toBe(true);
  });

  it("does NOT double-fire on a repeated check (both layers stay claimed)", () => {
    const state = createEngineState(singleNode("A"), "g-13");
    provision(state);
    state.phase = EnginePhase.Executing;
    quiesce(state);

    const { events, cb } = spy();
    const ctx = freshCtx();
    checkGraphTermination(state, cb, ctx);
    expect(events).toHaveLength(1);

    // Simulate another _checkTermination call on the same instance/state.
    state.isDirty = false;
    checkGraphTermination(state, cb, ctx);
    expect(events).toHaveLength(1); // no second fire

    // And a fresh context (new engine instance) still cannot re-fire: the
    // persisted layer alone suppresses the quiescent re-fire.
    checkGraphTermination(state, cb, freshCtx());
    expect(events).toHaveLength(1);
  });

  it("clears the stale cross-restart guard when the graph is re-opened (active nodes present)", () => {
    // Models retry/extend-after-complete on a reused engine: the re-open path
    // resets only the per-instance ctx; the stale persisted flag must be
    // reconciled so the retried chain's terminal event still fires.
    const state = createEngineState(singleNode("A"), "g-14");
    provision(state);
    state.phase = EnginePhase.Executing;
    state.terminalNotified = { complete: true, blocked: false }; // prior terminal

    // A is still `ready` (frontier ["A"]) — an ACTIVE node exists → the graph
    // is demonstrably re-opened → the stale cross-restart guard is cleared.
    const { events, cb } = spy();
    checkGraphTermination(state, cb, freshCtx());
    expect(state.terminalNotified).toBeUndefined();
    expect(state.isDirty).toBe(true); // the reconciliation persists
    expect(events).toHaveLength(0); // nothing to fire yet — A is active

    // The re-opened chain now quiesces → the NEW terminal event fires.
    quiesce(state);
    const ctx = freshCtx();
    checkGraphTermination(state, cb, ctx);
    expect(events).toHaveLength(1);
    expect(events[0].isBlocked).toBe(false);
    expect(ctx.terminalComplete).toBe(true);
    expect(state.terminalNotified).toEqual({ complete: true, blocked: false });
  });

  it("keeps complete and blocked dedupe independent across both layers", () => {
    // A blocked fire claims only the blocked layer; an approval-resume then
    // completes the graph and the complete event still fires (both layers).
    const state = createEngineState(
      singleNode("G", "g1", { needs_approval: true }),
      "g-15",
    );
    provision(state);
    state.phase = EnginePhase.Executing;
    state.nodes.get("G")!.status = NodeStatus.Blocked;
    state.frontier = [];

    const { events, cb } = spy();
    const ctx = freshCtx();
    checkGraphTermination(state, cb, ctx); // blocked quiescence
    expect(events).toHaveLength(1);
    expect(events[0].isBlocked).toBe(true);
    expect(state.terminalNotified).toEqual({ complete: false, blocked: true });
    expect(ctx.terminalBlocked).toBe(true);

    // Approval-resume → node completes → graph quiescent-complete.
    state.nodes.get("G")!.status = NodeStatus.Completed;
    state.terminalNotified = { complete: false, blocked: true }; // persisted layer keeps blocked claim
    checkGraphTermination(state, cb, ctx);
    expect(events).toHaveLength(2);
    expect(events[1].isBlocked).toBe(false);
    expect(state.terminalNotified).toEqual({ complete: true, blocked: true });
    expect(ctx.terminalComplete).toBe(true);
  });
});
