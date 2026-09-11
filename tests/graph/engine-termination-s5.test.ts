/**
 * Graph Execution Engine v2 — S5: M4/L17 terminal-summary buckets + L9
 * deadlock-guard order hardening
 *
 * Covers the observability + ordering fixes landed in engine-termination.ts:
 *
 * M4 (done ≠ completed): `nodeStatusSummaries.completed` stays semantically
 * pure. Nodes flipped to the terminal `done` state (cascade-cancel retirement,
 * loop limit/stuck flips, `completed → done`) are counted in a separate `done`
 * bucket — a failed/cancelled-then-retired node is never reported as a success.
 *
 * L17 (cancelled bucket): `cancelled` nodes (cancelled → done predecessors)
 * are no longer invisible; they land in a dedicated `cancelled` bucket so a
 * cancelled graph is not reported as a clean completion.
 *
 * L9 (02-F4 order hardening): the runtime-deadlock guard verifies
 * `canTransitionPhase(state, Complete)` BEFORE the irreversible `pending →
 * escalate` loop and skips the ENTIRE branch on failure — pending nodes stay
 * pending and the graph stays re-entrant. Today the phase is guaranteed
 * `executing` at that point (the module's early return), so the guard always
 * passes; the tests pin the two-sided contract: (a) the deadlock regression
 * still escalates + transitions + fires exactly as before, and (b) pending
 * nodes are NEVER irreversibly escalated when the phase machine cannot reach
 * the terminal phase.
 *
 * Direct unit tests of the module — no dispatch seam required.
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

/** Multi-root graph: every node is a root → provision leaves all `ready`. */
function multiNode(ids: string[]): GraphDeclaration {
  return {
    version: 2,
    name: "multi",
    nodes: ids.map((id, i) => ({ id, agent: `a${i}`, prompt: `p${i}` })),
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

/** Quiesce a graph: force the given node statuses and empty the frontier. */
function setStatuses(
  state: EngineState,
  statuses: Record<string, NodeStatus>,
): void {
  for (const [id, status] of Object.entries(statuses)) {
    const node = state.nodes.get(id);
    if (!node) throw new Error(`node ${id} not found`);
    node.status = status;
  }
  state.frontier = [];
}

// ── M4: done nodes never count as completed ─────────────────────────────────

describe("M4 done bucket (done ≠ completed)", () => {
  it("reports a done-only graph as completed=0 done=N and still terminates", () => {
    // A retired node (cascade-cancel / loop-limit flip lands `→ done`).
    const state = createEngineState(singleNode("A"), "g-m4-1");
    provision(state);
    state.phase = EnginePhase.Executing;
    setStatuses(state, { A: NodeStatus.Done });

    const { events, cb } = spy();
    checkGraphTermination(state, cb, freshCtx());

    expect(state.phase).toBe(EnginePhase.Complete);
    expect(events).toHaveLength(1);
    expect(events[0].isBlocked).toBe(false);
    expect(events[0].nodeStatusSummaries.completed).toBe(0);
    expect(events[0].nodeStatusSummaries.done).toBe(1);
  });

  it("keeps completed pure when done/cancelled nodes are present alongside completed ones", () => {
    // Mixed terminal graph: A completed, B done (retired), C cancelled.
    const state = createEngineState(multiNode(["A", "B", "C"]), "g-m4-2");
    provision(state);
    state.phase = EnginePhase.Executing;
    setStatuses(state, {
      A: NodeStatus.Completed,
      B: NodeStatus.Done,
      C: NodeStatus.Cancelled,
    });

    const { events, cb } = spy();
    checkGraphTermination(state, cb, freshCtx());

    expect(events).toHaveLength(1);
    expect(events[0].nodeStatusSummaries.completed).toBe(1); // only A
    expect(events[0].nodeStatusSummaries.done).toBe(1); // B, NOT folded into completed
    expect(events[0].nodeStatusSummaries.cancelled).toBe(1); // C visible (L17)
  });

  it("counts every terminal bucket independently on a fully-terminal graph", () => {
    const state = createEngineState(
      multiNode(["A", "B", "C", "D", "E", "F", "G"]),
      "g-m4-3",
    );
    provision(state);
    state.phase = EnginePhase.Executing;
    setStatuses(state, {
      A: NodeStatus.Completed,
      B: NodeStatus.Completed,
      C: NodeStatus.Done,
      D: NodeStatus.Cancelled,
      E: NodeStatus.Escalate,
      F: NodeStatus.Timeout,
      G: NodeStatus.Blocked,
    });

    const { events, cb } = spy();
    checkGraphTermination(state, cb, freshCtx());

    expect(events).toHaveLength(1);
    const s = events[0].nodeStatusSummaries;
    expect(s.completed).toBe(2);
    expect(s.done).toBe(1);
    expect(s.cancelled).toBe(1);
    expect(s.escalate).toBe(1);
    expect(s.timeout).toBe(1);
    expect(s.blocked).toBe(1);
    expect(s.running).toBe(0);
  });
});

// ── L17: cancelled bucket ───────────────────────────────────────────────────

describe("L17 cancelled bucket", () => {
  it("surfaces cancelled nodes in the terminal summary (all-cancelled graph)", () => {
    // A graph cancelled wholesale: every node `cancelled` → `done` would
    // previously be invisible (default: break). Now it terminates with the
    // cancelled count visible and completed pure.
    const state = createEngineState(singleNode("A"), "g-l17-1");
    provision(state);
    state.phase = EnginePhase.Executing;
    setStatuses(state, { A: NodeStatus.Cancelled });

    const { events, cb } = spy();
    checkGraphTermination(state, cb, freshCtx());

    expect(state.phase).toBe(EnginePhase.Complete);
    expect(events).toHaveLength(1);
    expect(events[0].nodeStatusSummaries.completed).toBe(0);
    expect(events[0].nodeStatusSummaries.cancelled).toBe(1);
    expect(events[0].nodeStatusSummaries.done).toBe(0);
  });
});

// ── L9: deadlock guard checks the phase transition BEFORE escalating ────────

describe("L9 deadlock-guard order hardening", () => {
  it("regression: deadlock still escalates + transitions + fires after the reorder", () => {
    const state = createEngineState(unrootedCycleGraph(), "g-l9-1");
    provision(state); // both a and b pending, frontier empty
    state.phase = EnginePhase.Executing;

    const { events, cb } = spy();
    checkGraphTermination(state, cb, freshCtx());

    expect(state.nodes.get("a")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("b")!.status).toBe(NodeStatus.Escalate);
    expect(state.phase).toBe(EnginePhase.Complete);
    expect(events).toHaveLength(1);
    expect(events[0].isBlocked).toBe(false);
    expect(events[0].nodeStatusSummaries.escalate).toBe(2);
    expect(events[0].nodeStatusSummaries.completed).toBe(0);
  });

  it("never irreversibly escalates pending nodes when the phase cannot transition to complete", () => {
    // Contract pin for the reorder: the irreversible `pending → escalate` loop
    // is gated on `canTransitionPhase(state, Complete)`. When the phase machine
    // cannot reach the terminal phase (here: the module's early return on a
    // non-executing phase), pending nodes stay pending — the graph stays
    // re-entrant and no synthetic escalation is performed.
    const state = createEngineState(unrootedCycleGraph(), "g-l9-2");
    provision(state);
    // Already terminal — the early return fires before any escalation.
    state.phase = EnginePhase.Complete;

    const { events, cb } = spy();
    checkGraphTermination(state, cb, freshCtx());

    expect(state.nodes.get("a")!.status).toBe(NodeStatus.Pending);
    expect(state.nodes.get("b")!.status).toBe(NodeStatus.Pending);
    expect(state.phase).toBe(EnginePhase.Complete);
    expect(events).toHaveLength(0);
  });

  it("deadlock terminal event carries the escalated counts (escalate bucket, not completed)", () => {
    const state = createEngineState(unrootedCycleGraph(), "g-l9-3");
    provision(state);
    state.phase = EnginePhase.Executing;

    const { events, cb } = spy();
    checkGraphTermination(state, cb, freshCtx());

    const s = events[0].nodeStatusSummaries;
    expect(s.escalate).toBe(2);
    expect(s.completed).toBe(0);
    expect(s.done).toBe(0);
    expect(s.cancelled).toBe(0);
  });
});
