/**
 * S5 — graph-declared session budget enforcement (`budget.max_total_sessions`).
 *
 * `BudgetBridge.checkGraphBudget` (src/graph/engine/budget-bridge.ts) enforces
 * the declaration's `max_total_sessions` cap against `EngineState.budget
 * .sessionsSpawned` — a NET-LIVE counter:
 *
 *   - incremented per SUCCESSFUL dispatch (`engine-advance.ts::_dispatchNode`,
 *     `applyBudgetDelta(state, { sessions: 1 })` — failed launches never count),
 *   - decremented when a dispatch task terminates `cancelled` / `timeout`
 *     (`engine-recovery.ts::subscribeTaskTermination`, `sessions: -1` — the
 *     graph-level mirror of S4's `decRequestSessions` refunds; completed /
 *     error / blocked tasks keep counting).
 *
 * The engine's pre-dispatch check (engine-advance.ts, `_dispatchNode`) escalates
 * a ready node with the bridge's reason, so a graph whose live-session counter
 * reached the cap never spawns another dispatch.
 *
 * Run: bun test tests/graph/graph-session-budget.test.ts
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration, GraphBudgetSpec } from "../../src/types.graph-v2.ts";
import type { EngineState } from "../../src/types.engine-v2.ts";
import type { DispatchManagerConfig } from "../../src/dispatch/config.ts";
import { BudgetTracker } from "../../src/dispatch/budget/budget-tracker.ts";
import { BudgetBridge } from "../../src/graph/engine/budget-bridge.ts";
import {
  addToFrontier,
  createEngineState,
  provision,
} from "../../src/graph/engine/engine-state.ts";
import { markReady } from "../../src/graph/engine/node-lifecycle.ts";
import { SignalBridge } from "../../src/graph/engine/signal-bridge.ts";
import {
  AdvanceEngine,
  type NodeDispatchPort,
  type GraphBudgetPort,
} from "../../src/graph/engine/engine-advance.ts";
import { ScriptedDispatch } from "./helpers/scripted-dispatch.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** N root nodes (no edges) with an optional graph-level budget spec. */
function decl(nodeIds: string[], budget?: GraphBudgetSpec): GraphDeclaration {
  return {
    version: 2,
    name: "session-budget",
    nodes: nodeIds.map((id) => ({ id, agent: "a", prompt: `p-${id}` })),
    edges: [],
    ...(budget ? { budget } : {}),
  };
}

/** Real tracker with an EMPTY config — the tracker-tier check never rejects. */
const dirs: string[] = [];
function makeTracker(): BudgetTracker {
  const dir = mkdtempSync(join(tmpdir(), "graph-session-budget-"));
  dirs.push(dir);
  // No limits anywhere → `isRequestBudgetExceeded` always returns
  // `{ exceeded: false }`; only the graph-declared session cap can reject.
  return new BudgetTracker({} as DispatchManagerConfig, dir);
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

interface Rig {
  state: EngineState;
  engine: AdvanceEngine;
}

/** Direct AdvanceEngine construction (same pattern as engine-monitor-s5). */
function buildEngine(
  g: GraphDeclaration,
  dispatch: NodeDispatchPort,
  budget: GraphBudgetPort,
): Rig {
  const state = createEngineState(g, "g-sb");
  provision(state);
  const engine = new AdvanceEngine({
    state,
    signalBridge: new SignalBridge(),
    dispatch,
    budget,
    onNodeCompletion: () => {},
  });
  return { state, engine };
}

// ── Unit: bridge enforces the declaration's session cap ────────────────────

describe("BudgetBridge.checkGraphBudget — graph-declared session cap", () => {
  it("rejects when sessionsSpawned reaches max_total_sessions (exact reason)", () => {
    const g = decl(["A"], { max_total_sessions: 2 });
    const state = createEngineState(g, "g-x");
    state.budget.sessionsSpawned = 2;
    const bridge = new BudgetBridge(makeTracker(), g);

    const check = bridge.checkGraphBudget(state.graphId, state);
    expect(check.exceeded).toBe(true);
    expect(check.reason).toBe("graph session budget exhausted: 2 >= 2");
  });

  it("passes while sessionsSpawned is below the cap", () => {
    const g = decl(["A"], { max_total_sessions: 2 });
    const state = createEngineState(g, "g-x");
    state.budget.sessionsSpawned = 1;
    const bridge = new BudgetBridge(makeTracker(), g);

    expect(bridge.checkGraphBudget(state.graphId, state).exceeded).toBe(false);
  });

  it("adds no rejection when max_total_sessions is undefined (tracker-only result)", () => {
    const g = decl(["A"]); // no budget field at all
    const state = createEngineState(g, "g-x");
    state.budget.sessionsSpawned = 99;
    const bridge = new BudgetBridge(makeTracker(), g);

    const check = bridge.checkGraphBudget(state.graphId, state);
    expect(check).toEqual({ exceeded: false });
  });
});

// ── Engine-level: pre-check escalates the ready node past the cap ──────────

describe("engine pre-check — per-graph session cap escalation", () => {
  it("dispatches 2 of 3 roots and escalates the 3rd with the session-cap reason", async () => {
    const g = decl(["A", "B", "C"], { max_total_sessions: 2 });
    const fake = new ScriptedDispatch();
    const { state, engine } = buildEngine(g, fake, new BudgetBridge(makeTracker(), g));

    await engine.dispatchReady();
    await new Promise((r) => setTimeout(r, 25)); // let A/B auto-completions drain

    // A and B launched (one net-live session each); C was never dispatched.
    expect(fake.dispatches("A")).toBe(1);
    expect(fake.dispatches("B")).toBe(1);
    expect(fake.dispatches("C")).toBe(0);

    // C escalated in place with the bridge's exact reason — the engine's
    // pre-check escalation path (markEscalated + removeFromFrontier + notify).
    const c = state.nodes.get("C")!;
    expect(c.status).toBe(NodeStatus.Escalate);
    expect(c.errorReason).toBe("graph session budget exhausted: 2 >= 2");

    // Completed tasks keep counting (S4 semantics) — the counter stays at 2.
    expect(state.budget.sessionsSpawned).toBe(2);
  });
});

// ── Refund: cancelled dispatch frees the slot (S4 consistency) ─────────────

describe("S4-consistency — cancelled dispatch refunds its net-live slot", () => {
  it("a cancelled held dispatch frees the slot so a later dispatch is permitted", async () => {
    const g = decl(["A", "B"], { max_total_sessions: 1 });
    const fake = new ScriptedDispatch(["A"]); // A stays running; B escalates at the cap
    const { state, engine } = buildEngine(g, fake, new BudgetBridge(makeTracker(), g));

    await engine.dispatchReady();
    expect(state.budget.sessionsSpawned).toBe(1);
    expect(fake.dispatches("A")).toBe(1);
    expect(fake.dispatches("B")).toBe(0);
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Escalate);

    // Cancel A's live dispatch task through the registered onTaskTerminated
    // listener — the graph-level mirror of S4's decRequestSessions refund.
    fake.fireTermination(fake.taskIds[0], "cancelled");
    expect(state.budget.sessionsSpawned).toBe(0);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Cancelled);

    // The freed slot permits a subsequent dispatch: re-open B and run again.
    const bNode = state.nodes.get("B")!;
    markReady(state, bNode);
    addToFrontier(state, "B");
    await engine.dispatchReady();
    expect(fake.dispatches("B")).toBe(1);
    expect(state.budget.sessionsSpawned).toBe(1);
  });
});
