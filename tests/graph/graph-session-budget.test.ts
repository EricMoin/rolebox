/**
 * Graph-declared session budget: cap REMOVED, display counter retained.
 *
 * The graph-declared `budget.max_total_sessions` cap was removed upstream.
 * `BudgetBridge.checkGraphBudget` (src/graph/engine/budget-bridge.ts) now
 * delegates SOLELY to the request-level tracker — the graph declaration's
 * session ceiling no longer gates dispatch.
 *
 * `EngineState.budget.sessionsSpawned` remains a NET-LIVE DISPLAY COUNTER:
 *
 *   - incremented per SUCCESSFUL dispatch (`engine-advance.ts::_dispatchNode`,
 *     `applyBudgetDelta(state, { sessions: 1 })` — failed launches never count),
 *   - decremented when a dispatch task terminates `cancelled` / `timeout`
 *     (`engine-recovery.ts::subscribeTaskTermination`, `sessions: -1`; completed /
 *     error / blocked tasks keep counting).
 *
 * The counter is observable (monitor / status / persistence) but no longer
 * gates dispatch — a graph whose live-session counter is high still spawns
 * every ready node.
 *
 * Run: bun test tests/graph/graph-session-budget.test.ts
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
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
function decl(nodeIds: string[]): GraphDeclaration {
  return {
    version: 2,
    name: "session-budget",
    nodes: nodeIds.map((id) => ({ id, agent: "a", prompt: `p-${id}` })),
    edges: [],
  };
}

/** Real tracker with an EMPTY config — the tracker-tier check never rejects. */
const dirs: string[] = [];
function makeTracker(): BudgetTracker {
  const dir = mkdtempSync(join(tmpdir(), "graph-session-budget-"));
  dirs.push(dir);
  // No limits anywhere → `isRequestBudgetExceeded` always returns
  // `{ exceeded: false }`.
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

// ── Unit: bridge delegates to the tracker; sessionsSpawned never gates ──────

describe("BudgetBridge.checkGraphBudget — tracker-only (cap removed)", () => {
  it("never rejects on sessionsSpawned alone, no matter how high", () => {
    const g = decl(["A"]);
    const state = createEngineState(g, "g-x");
    state.budget.sessionsSpawned = 999;
    const bridge = new BudgetBridge(makeTracker(), g);

    const check = bridge.checkGraphBudget(state.graphId, state);
    expect(check).toEqual({ exceeded: false });
  });

  it("passes when the declaration carries no budget at all (tracker-only result)", () => {
    const g = decl(["A"]); // no budget field at all
    const state = createEngineState(g, "g-x");
    state.budget.sessionsSpawned = 99;
    const bridge = new BudgetBridge(makeTracker(), g);

    const check = bridge.checkGraphBudget(state.graphId, state);
    expect(check).toEqual({ exceeded: false });
  });
});

// ── Engine-level: every ready node dispatches regardless of the counter ─────

describe("engine pre-check — sessionsSpawned does not gate dispatch", () => {
  it("dispatches ALL ready roots even when sessionsSpawned is high", async () => {
    const g = decl(["A", "B", "C"]);
    const fake = new ScriptedDispatch();
    const { state, engine } = buildEngine(g, fake, new BudgetBridge(makeTracker(), g));

    // Simulate a high pre-existing live-session count — the display counter
    // must NOT stop the engine from dispatching every ready node.
    state.budget.sessionsSpawned = 50;

    await engine.dispatchReady();
    await new Promise((r) => setTimeout(r, 25)); // let auto-completions drain

    // All three roots dispatched despite the elevated counter.
    expect(fake.dispatches("A")).toBe(1);
    expect(fake.dispatches("B")).toBe(1);
    expect(fake.dispatches("C")).toBe(1);

    // Counter reflects the three successful dispatches on top of the seed.
    expect(state.budget.sessionsSpawned).toBe(53);
  });
});

// ── Display counter: successful dispatch increments; cancel/timeout refunds ─

describe("sessionsSpawned display counter — increment / refund semantics", () => {
  it("increments per successful dispatch and counts completed tasks", async () => {
    const g = decl(["A", "B"]);
    const fake = new ScriptedDispatch();
    const { state, engine } = buildEngine(g, fake, new BudgetBridge(makeTracker(), g));

    await engine.dispatchReady();
    expect(state.budget.sessionsSpawned).toBe(2);
    expect(fake.dispatches("A")).toBe(1);
    expect(fake.dispatches("B")).toBe(1);

    // Auto-completions land as `completed` — completed tasks keep counting.
    await new Promise((r) => setTimeout(r, 25));
    expect(state.budget.sessionsSpawned).toBe(2);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Completed);
  });

  it("a cancelled held dispatch decrements the net-live display counter", async () => {
    const g = decl(["A", "B"]);
    const fake = new ScriptedDispatch(["A"]); // A stays running; B auto-completes
    const { state, engine } = buildEngine(g, fake, new BudgetBridge(makeTracker(), g));

    await engine.dispatchReady();
    expect(state.budget.sessionsSpawned).toBe(2);

    // Cancel A's live dispatch task through the registered onTaskTerminated
    // listener — the -1 refund keeps the display counter accurate.
    fake.fireTermination(fake.taskIds[0], "cancelled");
    expect(state.budget.sessionsSpawned).toBe(1);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Cancelled);

    // B completed in the meantime — its slot keeps counting, so the counter
    // rests at exactly 1 (A refunded, B still counted).
    await new Promise((r) => setTimeout(r, 25));
    expect(state.budget.sessionsSpawned).toBe(1);

    // A later dispatch is permitted unconditionally (no cap): re-open B and
    // run again — the counter climbs, nothing blocks it.
    const bNode = state.nodes.get("B")!;
    markReady(state, bNode);
    addToFrontier(state, "B");
    await engine.dispatchReady();
    expect(fake.dispatches("B")).toBe(2);
    expect(state.budget.sessionsSpawned).toBe(2);
  });
});
