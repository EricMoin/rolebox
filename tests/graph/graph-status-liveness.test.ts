/**
 * Graph Execution Engine v2 — `graph_status` liveness display (subtask 7).
 *
 * DISPLAY-ONLY: reads whatever is recorded on `NodeRuntimeState.liveness`
 * (the subtask-1 data carrier) and renders it in the text / json / summary
 * views. The liveness feed (subtask 2) and stall monitor (subtask 3) are NOT
 * implemented here — fixtures inject `liveness` directly into the live engine
 * state, exactly like graph-status-views.test.ts injects status / completedAt.
 *
 * Rendering rules under test:
 *   - Nodes WITH recorded liveness: running nodes ALWAYS show it; non-running
 *     nodes only when `include_liveness: true`.
 *   - Nodes with NO recorded liveness → no block / no keys at all
 *     (honest-empty, never fabricated, never a "none recorded" placeholder).
 *   - Existing output for fixtures without recorded liveness stays
 *     byte-identical (backward compat).
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
  createGraphToolSet,
  GraphToolSet,
  type GraphStatusArgs,
} from "../../src/graph/tools/graph-tools";
import { createGraphTools } from "../../src/graph/tools/index";
import { NodeStatus } from "../../src/constants";
import type { EngineState, NodeRuntimeState } from "../../src/types.engine-v2";

// Fixed, clearly-in-the-past timestamp so `Date.now() - lastActivityAt` is a
// stable non-negative value regardless of when the suite runs.
const FIXED_ACTIVITY = new Date("2026-01-01T00:00:00.000Z").getTime();

interface Fixture {
  ts: GraphToolSet;
  graph_id: string;
  state: EngineState;
  runningId: string; // (a) running + liveness (stalled)
  completedId: string; // (b) completed + liveness (healthy)
  noLivenessId: string; // (c) completed, NO liveness
}

/**
 * A 3-node graph:
 *   n1 agent-1 running   — liveness { tool, stalled, lastActivityAt }
 *   n2 agent-2 completed — liveness { dispatch, healthy, lastActivityAt }
 *   n3 agent-3 completed — NO liveness (honest-empty fixture)
 */
function buildFixture(): Fixture {
  const ts = createGraphToolSet();
  const { graph_id } = ts.graph_create({ name: "liveness-fixture" });
  ts.graph_add_node({ graph_id, id: "n1", agent: "agent-1", prompt: "one" });
  ts.graph_add_node({ graph_id, id: "n2", agent: "agent-2", prompt: "two" });
  ts.graph_add_node({ graph_id, id: "n3", agent: "agent-3", prompt: "three" });

  const live = ts["getEntry"](graph_id).runtime as unknown as { state: EngineState };
  const nodes = live.state.nodes;
  setNode(nodes, "n1", {
    status: NodeStatus.Running,
    liveness: {
      lastActivityAt: FIXED_ACTIVITY,
      heartbeatSource: "tool",
      stallStatus: "stalled",
    },
  });
  setNode(nodes, "n2", {
    status: NodeStatus.Completed,
    liveness: {
      lastActivityAt: FIXED_ACTIVITY,
      heartbeatSource: "dispatch",
      stallStatus: "healthy",
    },
  });
  // n3 stays completed with NO liveness.
  setNode(nodes, "n3", { status: NodeStatus.Completed });
  return {
    ts,
    graph_id,
    state: live.state,
    runningId: "n1",
    completedId: "n2",
    noLivenessId: "n3",
  };
}

function setNode(
  map: Map<string, NodeRuntimeState>,
  id: string,
  patch: Partial<NodeRuntimeState>,
): void {
  const node = map.get(id)!;
  Object.assign(node, patch);
}

// ── text node view ──────────────────────────────────────────────────────────

describe("graph_status liveness — text node view", () => {
  it("node view with include_liveness renders the liveness block fields", () => {
    const { ts, graph_id, runningId } = buildFixture();
    const out = ts.graph_status({
      graph_id,
      node_id: runningId,
      include_liveness: true,
    });
    expect(out).toContain("liveness:");
    expect(out).toContain("last_activity");
    expect(out).toContain(new Date(FIXED_ACTIVITY).toISOString());
    expect(out).toContain("idle_ms:");
    expect(out).toContain("heartbeat_source: tool");
    expect(out).toContain("stall_status: stalled");
  });

  it("running node shows liveness WITHOUT include_liveness (always-on for running)", () => {
    const { ts, graph_id, runningId } = buildFixture();
    const out = ts.graph_status({ graph_id, node_id: runningId });
    expect(out).toContain("liveness:");
    expect(out).toContain("last_activity");
    expect(out).toContain("idle_ms");
    expect(out).toContain("heartbeat_source");
    expect(out).toContain("stall_status");
  });

  it("completed node hides liveness without include_liveness (flag-gated)", () => {
    const { ts, graph_id, completedId } = buildFixture();
    const out = ts.graph_status({ graph_id, node_id: completedId });
    expect(out).not.toContain("liveness:");
    expect(out).not.toContain("last_activity");
  });

  it("completed node shows liveness when include_liveness is set", () => {
    const { ts, graph_id, completedId } = buildFixture();
    const out = ts.graph_status({
      graph_id,
      node_id: completedId,
      include_liveness: true,
    });
    expect(out).toContain("liveness:");
    expect(out).toContain("heartbeat_source: dispatch");
    expect(out).toContain("stall_status: healthy");
  });

  it("node WITHOUT liveness renders no liveness block even with include_liveness", () => {
    const { ts, graph_id, noLivenessId } = buildFixture();
    const out = ts.graph_status({
      graph_id,
      node_id: noLivenessId,
      include_liveness: true,
    });
    expect(out).not.toContain("liveness:");
    expect(out).not.toContain("last_activity");
    expect(out).not.toContain("stall_status");
  });
});

// ── json view ───────────────────────────────────────────────────────────────

describe("graph_status liveness — json view", () => {
  it("include_liveness adds liveness fields to recorded nodes (running + completed)", () => {
    const { ts, graph_id, runningId, completedId } = buildFixture();
    const parsed = JSON.parse(
      ts.graph_status({ graph_id, format: "json", include_liveness: true }),
    ) as { nodes: Array<Record<string, unknown> & { node_id: string }> };
    const byId = new Map(parsed.nodes.map((n) => [n.node_id, n]));

    const running = byId.get(runningId)!;
    expect(running.last_activity_at).toBe(FIXED_ACTIVITY);
    expect(typeof running.idle_ms).toBe("number");
    expect((running.idle_ms as number)).toBeGreaterThanOrEqual(0);
    expect(running.heartbeat_source).toBe("tool");
    expect(running.stall_status).toBe("stalled");

    const completed = byId.get(completedId)!;
    expect(completed.last_activity_at).toBe(FIXED_ACTIVITY);
    expect(typeof completed.idle_ms).toBe("number");
    expect((completed.idle_ms as number)).toBeGreaterThanOrEqual(0);
    expect(completed.heartbeat_source).toBe("dispatch");
    expect(completed.stall_status).toBe("healthy");
  });

  it("running node surfaces liveness in json WITHOUT include_liveness", () => {
    const { ts, graph_id, runningId, completedId } = buildFixture();
    const parsed = JSON.parse(
      ts.graph_status({ graph_id, format: "json" }),
    ) as { nodes: Array<Record<string, unknown> & { node_id: string }> };
    const byId = new Map(parsed.nodes.map((n) => [n.node_id, n]));

    const running = byId.get(runningId)!;
    expect(running.last_activity_at).toBe(FIXED_ACTIVITY);
    expect(running.stall_status).toBe("stalled");

    // Completed node without the flag: liveness keys absent.
    const completed = byId.get(completedId)!;
    expect(completed.last_activity_at).toBeUndefined();
    expect(completed.stall_status).toBeUndefined();
  });

  it("node without liveness has NO liveness keys even with include_liveness (honest-empty)", () => {
    const { ts, graph_id, noLivenessId } = buildFixture();
    const parsed = JSON.parse(
      ts.graph_status({ graph_id, format: "json", include_liveness: true }),
    ) as { nodes: Array<Record<string, unknown> & { node_id: string }> };
    const n3 = parsed.nodes.find((n) => n.node_id === noLivenessId)!;
    expect(n3.last_activity_at).toBeUndefined();
    expect(n3.idle_ms).toBeUndefined();
    expect(n3.heartbeat_source).toBeUndefined();
    expect(n3.stall_status).toBeUndefined();
    expect(n3.stall_warned_at).toBeUndefined();
    expect(n3.stall_reason).toBeUndefined();
  });

  it("stall_warned_at / stall_reason ride along only when present", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "liveness-warned" });
    ts.graph_add_node({ graph_id, id: "w", agent: "agent-w", prompt: "p" });
    const live = ts["getEntry"](graph_id).runtime as unknown as { state: EngineState };
    setNode(live.state.nodes, "w", {
      status: NodeStatus.Running,
      liveness: {
        lastActivityAt: FIXED_ACTIVITY,
        heartbeatSource: "feed",
        stallStatus: "stalling",
        stallWarnedAt: FIXED_ACTIVITY + 1000,
        stallReason: "no tool activity for 60s",
      },
    });
    const parsed = JSON.parse(
      ts.graph_status({ graph_id, format: "json" }),
    ) as { nodes: Array<Record<string, unknown> & { node_id: string }> };
    const w = parsed.nodes[0];
    expect(w.stall_warned_at).toBe(FIXED_ACTIVITY + 1000);
    expect(w.stall_reason).toBe("no tool activity for 60s");
  });
});

// ── summary view ────────────────────────────────────────────────────────────

describe("graph_status liveness — summary stall marker", () => {
  it("running node with stallStatus gets a [stall: …] marker; non-running nodes do not", () => {
    const { ts, graph_id } = buildFixture();
    const out = ts.graph_status({ graph_id });
    expect(out).toContain("[stall: stalled]");
    // Exactly one stall marker — n1 (running, stalled) only. n2 (completed,
    // healthy) and n3 (no liveness) get no marker.
    expect(out.match(/\[stall:/g)).toHaveLength(1);
  });

  it("running node WITHOUT stallStatus gets no marker", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "liveness-nostall" });
    ts.graph_add_node({ graph_id, id: "r", agent: "agent-r", prompt: "p" });
    const live = ts["getEntry"](graph_id).runtime as unknown as { state: EngineState };
    setNode(live.state.nodes, "r", {
      status: NodeStatus.Running,
      liveness: { lastActivityAt: FIXED_ACTIVITY, heartbeatSource: "tool" },
    });
    const out = ts.graph_status({ graph_id });
    expect(out).not.toContain("[stall:");
  });
});

// ── backward compat ─────────────────────────────────────────────────────────

describe("graph_status liveness — backward compat", () => {
  it("liveness-free graph json is byte-identical with include_liveness unset/undefined/false/true", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "liveness-compat" });
    ts.graph_add_node({ graph_id, id: "x", agent: "agent-x", prompt: "p" });
    const plain = ts.graph_status({ graph_id, format: "json" });
    const explicitUndef = ts.graph_status({
      graph_id,
      format: "json",
      include_liveness: undefined,
    });
    const explicitFalse = ts.graph_status({
      graph_id,
      format: "json",
      include_liveness: false,
    });
    const explicitTrue = ts.graph_status({
      graph_id,
      format: "json",
      include_liveness: true,
    });
    expect(explicitUndef).toBe(plain);
    expect(explicitFalse).toBe(plain);
    // No recorded liveness anywhere → include_liveness adds nothing, never a
    // fabricated block (honest-empty).
    expect(explicitTrue).toBe(plain);
    const parsed = JSON.parse(plain) as {
      nodes: Array<Record<string, unknown>>;
    };
    expect(parsed.nodes[0].last_activity_at).toBeUndefined();
  });

  it("summary row is byte-identical for nodes without recorded liveness", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "liveness-summary-compat" });
    ts.graph_add_node({ graph_id, id: "y", agent: "agent-y", prompt: "p" });
    const plain = ts.graph_status({ graph_id });
    const flagged = ts.graph_status({ graph_id, include_liveness: true });
    expect(flagged).toBe(plain);
  });
});

// ── zod schema acceptance ───────────────────────────────────────────────────

describe("graph_status include_liveness zod schema", () => {
  it("include_liveness is an optional boolean and parses through the args schema", () => {
    const { graph_status } = createGraphTools(undefined, { directory: "/tmp" });
    expect(graph_status.args.include_liveness).toBeInstanceOf(z.ZodOptional);
    // The tool def's args field is typed as a ZodRawShape — wrap it in a real
    // ZodObject to exercise full-object parsing.
    const schema = z.object(graph_status.args as z.ZodRawShape);
    // The full args object parses without throwing.
    const parsed = schema.parse({
      graph_id: "g1",
      include_liveness: true,
    });
    expect(parsed.include_liveness).toBe(true);
    // And the flag is genuinely optional.
    const plain = schema.parse({ graph_id: "g1" });
    expect(plain.include_liveness).toBeUndefined();
  });
});

// ── type-level: GraphStatusArgs carries the new flag ────────────────────────

describe("GraphStatusArgs type surface", () => {
  it("accepts include_liveness in the args type", () => {
    const args: GraphStatusArgs = { graph_id: "g1", include_liveness: true };
    expect(args.include_liveness).toBe(true);
    // Default stays undefined (byte-compat render path).
    const def: GraphStatusArgs = { graph_id: "g1" };
    expect(def.include_liveness).toBeUndefined();
  });
});
