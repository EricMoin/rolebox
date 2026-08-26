/**
 * Graph-declared budget ceilings: enforcement + display counter (Y4).
 *
 * `BudgetBridge.checkGraphBudget` (src/graph/engine/budget-bridge.ts) is a
 * two-layer check: it delegates to the request-level tracker, THEN compares the
 * cumulative `EngineState.budget` counters against the graph declaration's own
 * `budget.max_total_*` ceilings (fed by `engine-recovery.ts::captureNodeUsage`
 * via `applyBudgetDelta` at task termination). `checkNodeBudget` compares each
 * node's declared per-node ceilings against its `tokensConsumed`.
 *
 * `EngineState.budget.sessionsSpawned` remains a NET-LIVE DISPLAY COUNTER:
 *
 *   - incremented per SUCCESSFUL dispatch (`engine-advance.ts::_dispatchNode`,
 *     `applyBudgetDelta(state, { sessions: 1 })` — failed launches never count),
 *   - decremented when a dispatch task terminates `cancelled` / `timeout`
 *     (`engine-recovery.ts::subscribeTaskTermination`, `sessions: -1`; completed /
 *     error / blocked tasks keep counting).
 *
 * The counter is observable (monitor / status / persistence) but never gates
 * dispatch — a graph whose live-session counter is high still spawns every
 * ready node.
 *
 * Run: bun test tests/graph/graph-session-budget.test.ts
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NodeStatus, EnginePhase } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { EngineState } from "../../src/types.engine-v2.ts";
import type { DispatchManagerConfig } from "../../src/dispatch/config.ts";
import type { UsageRecord } from "../../src/dispatch/budget/budget-tracker.ts";
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
  type NodeCompletionEvent,
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

/**
 * ScriptedDispatch variant that reports a fixed per-session usage record via
 * `getSessionUsage` — the seam `captureNodeUsage` reads at task termination
 * to feed the graph-level budget counters.
 */
class UsageDispatch extends ScriptedDispatch {
  constructor(private readonly usage: UsageRecord) {
    super();
  }
  getSessionUsage(_sessionId: string): UsageRecord {
    return this.usage;
  }
}

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

// ── Unit: bridge delegates to the tracker AND enforces declaration ceilings ──

describe("BudgetBridge.checkGraphBudget — tracker + declaration ceilings", () => {
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

  it("rejects when cumulative input tokens hit the declared max_total_input_tokens ceiling (>=)", () => {
    const g: GraphDeclaration = {
      version: 2,
      name: "decl-ceiling",
      budget: { max_total_input_tokens: 1000 },
      nodes: [{ id: "A", agent: "a", prompt: "pA" }],
      edges: [],
    };
    const state = createEngineState(g, "g-x");
    state.budget.totalInputTokens = 1000; // at the ceiling → breach
    const bridge = new BudgetBridge(makeTracker(), g);

    const check = bridge.checkGraphBudget(state.graphId, state);
    expect(check).toEqual({
      exceeded: true,
      reason: "graph budget exhausted: inputTokens 1000/1000",
    });
  });

  it("rejects on output-token and cost ceilings with field-specific reasons", () => {
    const g: GraphDeclaration = {
      version: 2,
      name: "decl-ceiling",
      budget: { max_total_output_tokens: 500, max_total_cost_usd: 2.5 },
      nodes: [{ id: "A", agent: "a", prompt: "pA" }],
      edges: [],
    };
    const state = createEngineState(g, "g-x");
    const bridge = new BudgetBridge(makeTracker(), g);

    state.budget.totalOutputTokens = 500;
    expect(bridge.checkGraphBudget(state.graphId, state)).toEqual({
      exceeded: true,
      reason: "graph budget exhausted: outputTokens 500/500",
    });

    state.budget.totalOutputTokens = 0;
    state.budget.totalCost = 3;
    expect(bridge.checkGraphBudget(state.graphId, state)).toEqual({
      exceeded: true,
      reason: "graph budget exhausted: cost 3/2.5",
    });
  });

  it("accepts below the declared ceilings", () => {
    const g: GraphDeclaration = {
      version: 2,
      name: "decl-ceiling",
      budget: { max_total_input_tokens: 1000 },
      nodes: [{ id: "A", agent: "a", prompt: "pA" }],
      edges: [],
    };
    const state = createEngineState(g, "g-x");
    state.budget.totalInputTokens = 999; // under the ceiling → accept
    const bridge = new BudgetBridge(makeTracker(), g);

    expect(bridge.checkGraphBudget(state.graphId, state)).toEqual({
      exceeded: false,
    });
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

// ── Contract: checkNodeBudget — declared per-node ceilings, not a stub ──────

describe("BudgetBridge.checkNodeBudget — declared per-node ceilings", () => {
  it("never rejects when the node declares no per-node budget, no matter how much it consumed", () => {
    const g = decl(["A"]);
    const bridge = new BudgetBridge(makeTracker(), g);
    const state = createEngineState(g, "g-x");
    provision(state);
    const node = state.nodes.get("A")!;
    // No declared per-node limits → the node is never rejected, even with a
    // huge cumulative consumption. The old always-accept semantics hold for
    // budget-less nodes.
    node.tokensConsumed = { inputTokens: 999_999, outputTokens: 999_999, cost: 999.99 };

    expect(bridge.checkNodeBudget(node)).toEqual({ exceeded: false });
  });

  it("rejects when cumulative input tokens hit the declared max_input_tokens ceiling (>=)", () => {
    const g: GraphDeclaration = {
      version: 2,
      name: "node-ceiling",
      nodes: [
        { id: "A", agent: "a", prompt: "pA", budget: { max_input_tokens: 100 } },
      ],
      edges: [],
    };
    const bridge = new BudgetBridge(makeTracker(), g);
    const state = createEngineState(g, "g-x");
    provision(state);
    const node = state.nodes.get("A")!;
    node.tokensConsumed = { inputTokens: 100, outputTokens: 0, cost: 0 };

    expect(bridge.checkNodeBudget(node)).toEqual({
      exceeded: true,
      reason: "node budget exhausted: inputTokens 100/100",
    });
  });

  it("rejects on output-token and cost ceilings with field-specific reasons", () => {
    const g: GraphDeclaration = {
      version: 2,
      name: "node-ceiling",
      nodes: [
        {
          id: "A",
          agent: "a",
          prompt: "pA",
          budget: { max_output_tokens: 200, max_cost_usd: 1.5 },
        },
      ],
      edges: [],
    };
    const bridge = new BudgetBridge(makeTracker(), g);
    const state = createEngineState(g, "g-x");
    provision(state);
    const node = state.nodes.get("A")!;

    node.tokensConsumed = { inputTokens: 0, outputTokens: 200, cost: 0 };
    expect(bridge.checkNodeBudget(node)).toEqual({
      exceeded: true,
      reason: "node budget exhausted: outputTokens 200/200",
    });

    node.tokensConsumed = { inputTokens: 0, outputTokens: 0, cost: 2 };
    expect(bridge.checkNodeBudget(node)).toEqual({
      exceeded: true,
      reason: "node budget exhausted: cost 2/1.5",
    });
  });

  it("accepts below the declared per-node ceilings", () => {
    const g: GraphDeclaration = {
      version: 2,
      name: "node-ceiling",
      nodes: [
        { id: "A", agent: "a", prompt: "pA", budget: { max_input_tokens: 100 } },
      ],
      edges: [],
    };
    const bridge = new BudgetBridge(makeTracker(), g);
    const state = createEngineState(g, "g-x");
    provision(state);
    const node = state.nodes.get("A")!;
    node.tokensConsumed = { inputTokens: 99, outputTokens: 0, cost: 0 };

    expect(bridge.checkNodeBudget(node)).toEqual({ exceeded: false });
  });
});

// ── Contract: engine invokes checkNodeBudget through the port pre-dispatch ──

describe("engine pre-check — checkNodeBudget is a live typed port call", () => {
  it("invokes checkNodeBudget for every dispatched node and never gates (stub)", async () => {
    const g = decl(["A", "B"]);
    const fake = new ScriptedDispatch();
    const checked: string[] = [];
    const budget: GraphBudgetPort = {
      checkGraphBudget: () => ({ exceeded: false }),
      checkNodeBudget: (node) => {
        checked.push(node.nodeId);
        return { exceeded: false };
      },
    };
    const { state, engine } = buildEngine(g, fake, budget);

    await engine.dispatchReady();
    await new Promise((r) => setTimeout(r, 25)); // let auto-completions drain

    // The per-node check is a real, typed call through the port — once per
    // dispatched node — and its always-accept result never blocks dispatch.
    expect(checked.sort()).toEqual(["A", "B"]);
    expect(fake.dispatches("A")).toBe(1);
    expect(fake.dispatches("B")).toBe(1);
  });

  it("a rejecting per-node check escalates the ready node without dispatching it", async () => {
    const g = decl(["A"]);
    const fake = new ScriptedDispatch();
    const budget: GraphBudgetPort = {
      checkGraphBudget: () => ({ exceeded: false }),
      checkNodeBudget: () => ({ exceeded: true, reason: "node budget exhausted" }),
    };
    const { state, engine } = buildEngine(g, fake, budget);

    await engine.dispatchReady();

    const node = state.nodes.get("A")!;
    expect(node.status).toBe(NodeStatus.Escalate);
    expect(node.errorReason).toBe("node budget exhausted");
    // Dropped from the frontier — no lingering ready entry.
    expect(state.frontier.includes("A")).toBe(false);
    // No dispatch was attempted for the escalated node.
    expect(fake.dispatches("A")).toBe(0);
    // Single-node graph with its only node escalated → terminal complete phase.
    expect(state.phase).toBe(EnginePhase.Complete);
  });
});

// ── Accumulation: terminated task usage feeds the graph-level budget totals ──

describe("graph-budget accumulation — captureNodeUsage feeds state.budget via termination", () => {
  it("reflects a terminated task's session usage in the graph-level budget totals", async () => {
    const g = decl(["A"]);
    const usage: UsageRecord = { inputTokens: 300, outputTokens: 120, cost: 0.05 };
    const fake = new UsageDispatch(usage);
    const { state, engine } = buildEngine(g, fake, new BudgetBridge(makeTracker(), g));

    await engine.dispatchReady();
    await new Promise((r) => setTimeout(r, 25)); // let the auto-completion drain

    // The terminated task's usage is accumulated into the graph-level budget.
    expect(state.budget.totalInputTokens).toBe(300);
    expect(state.budget.totalOutputTokens).toBe(120);
    expect(state.budget.totalCost).toBeCloseTo(0.05, 5);
    // And mirrored onto the node's per-node counter.
    expect(state.nodes.get("A")!.tokensConsumed).toEqual(usage);
  });
});

// ── Engine-level graph-budget breach: escalate root, cancel pending, complete ─

describe("engine-level graph-budget breach — escalate root, cancel pending downstream, complete", () => {
  it("escalates the ready node, cancels the pending downstream, and reaches Complete (no hang)", async () => {
    const g: GraphDeclaration = {
      version: 2,
      name: "graph-breach",
      budget: { max_total_input_tokens: 1000 },
      nodes: [
        { id: "A", agent: "a", prompt: "pA" },
        { id: "B", agent: "a", prompt: "pB" },
      ],
      edges: [{ from: "A", to: "B", type: "always" }],
    };
    const fake = new ScriptedDispatch();
    const events: NodeCompletionEvent[] = [];
    const state = createEngineState(g, "g-breach");
    provision(state);
    const engine = new AdvanceEngine({
      state,
      signalBridge: new SignalBridge(),
      dispatch: fake,
      budget: new BudgetBridge(makeTracker(), g),
      onNodeCompletion: (e) => events.push(e),
    });

    // A is ready (root); B is pending downstream via an always edge.
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Ready);
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Pending);

    // Pre-seed the graph-level consumption AT the declared ceiling.
    state.budget.totalInputTokens = 1000;

    await engine.dispatchReady();

    // A escalated, never dispatched, dropped from the frontier.
    const a = state.nodes.get("A")!;
    expect(a.status).toBe(NodeStatus.Escalate);
    expect(a.errorReason).toBe("graph budget exhausted: inputTokens 1000/1000");
    expect(state.frontier.includes("A")).toBe(false);
    expect(fake.dispatches("A")).toBe(0);

    // B swept to cancelled with the same reason — no hang in `executing`.
    const b = state.nodes.get("B")!;
    expect(b.status).toBe(NodeStatus.Cancelled);
    expect(b.errorReason).toBe("graph budget exhausted: inputTokens 1000/1000");

    // The standard termination path fires: {escalate: 1, cancelled: 1} → Complete.
    expect(state.phase).toBe(EnginePhase.Complete);

    // Completion events carry the breach reason for both nodes.
    const escalateEvent = events.find((e) => e.nodeId === "A");
    expect(escalateEvent?.signalType).toBe("escalate");
    expect(escalateEvent?.payload).toBe("graph budget exhausted: inputTokens 1000/1000");
    const cancelEvent = events.find((e) => e.nodeId === "B");
    expect(cancelEvent?.signalType).toBe("cancelled");
    expect(cancelEvent?.payload).toBe("graph budget exhausted: inputTokens 1000/1000");
  });
});

// ── Engine-level per-node breach: escalate without dispatch (real bridge) ────

describe("engine-level per-node budget breach — escalate without dispatch (real bridge)", () => {
  it("escalates a ready node whose tokensConsumed hit its declared ceiling", async () => {
    const g: GraphDeclaration = {
      version: 2,
      name: "node-breach",
      nodes: [
        { id: "A", agent: "a", prompt: "pA", budget: { max_input_tokens: 100 } },
      ],
      edges: [],
    };
    const fake = new ScriptedDispatch();
    const { state, engine } = buildEngine(g, fake, new BudgetBridge(makeTracker(), g));

    // The node's runtime budget carrier is seeded from the declaration, and its
    // cumulative consumption is at the declared ceiling.
    const a = state.nodes.get("A")!;
    expect(a.budget).toEqual({ max_input_tokens: 100 });
    a.tokensConsumed = { inputTokens: 100, outputTokens: 0, cost: 0 };

    await engine.dispatchReady();

    expect(a.status).toBe(NodeStatus.Escalate);
    expect(a.errorReason).toBe("node budget exhausted: inputTokens 100/100");
    // Dropped from the frontier — no lingering ready entry, no dispatch.
    expect(state.frontier.includes("A")).toBe(false);
    expect(fake.dispatches("A")).toBe(0);
    // Single-node graph → terminal complete phase.
    expect(state.phase).toBe(EnginePhase.Complete);
  });
});

// ── Contract: getGraphUsage stays a consumer-facing query, not a port member ─

describe("BudgetBridge.getGraphUsage — read-only consumer query (not on the port)", () => {
  it("delegates to the tracker's request usage and returns a zeroed record when absent", () => {
    const g = decl(["A"]);
    const bridge = new BudgetBridge(makeTracker(), g);

    // No usage recorded under this graph id → the tracker returns a zeroed
    // record. The method is deliberately NOT part of GraphBudgetPort — the
    // engine never reads it; it exists for status / monitor consumers.
    expect(bridge.getGraphUsage("g-x")).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    });
  });
});
