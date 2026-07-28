/**
 * Graph Execution Engine v2 — `graph_status` flag audit tests.
 *
 * Phase 4, Subtask 3 (C-WIRE). Audits every `graph_status` flag in
 * `.rolebox/design/tool-merge-map.md` §2.2 against the real engine runtime
 * state (`EngineState` / `NodeRuntimeState` / `LoopGroupRuntimeState`):
 *
 *  1. Every **backed** flag must return GENUINE engine data (not a placeholder).
 *  2. Every **unbacked** §2.2 flag must be explicitly documented (present in the
 *     {@link UNSUPPORTED_GRAPH_STATUS_FLAGS} registry in graph-tools.ts) — never
 *     silently returned with an invented value.
 *
 * After the C-WIRE subtask backed the final seven flags, the
 * {@link UNSUPPORTED_GRAPH_STATUS_FLAGS} registry is EMPTY — every original
 * §2.2 flag is now backed. This file pins that end state and asserts real
 * backing for each of the seven:
 *
 *  - `round` / `include_history`  ← `LoopGroupRuntimeState.rounds[]`
 *  - `include_checkpoint`        ← `EngineState.checkpoints[nodeId]`
 *  - `include_artifacts`         ← `NodeRuntimeState.artifacts[]`
 *  - `include_evidence`          ← `NodeRuntimeState.evidence[]`
 *  - `stream` / `since`          ← `SignalLedgerEntry.history[]`
 *
 * Honesty rule: every flag returns REAL recorded data or an explicit
 * honest-empty note ("no events", "no checkpoint recorded", …) — never
 * fabricated rows.
 */

import { describe, it, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGraphToolSet,
  GraphToolSet,
  UNSUPPORTED_GRAPH_STATUS_FLAGS,
} from "../../src/graph/tools/graph-tools";
import type { GraphStatusArgs } from "../../src/graph/tools/graph-tools";
import type { EngineState, RoundHistoryEntry, CheckpointRecord } from "../../src/types.engine-v2";
import { NodeStatus } from "../../src/constants";

// ── helpers ───────────────────────────────────────────────────────────────

/** A minimal two-node chain topology: root "planner" -> leaf "reporter". */
function buildChain(ts: GraphToolSet, graphId: string): void {
  ts.graph_add_node({
    graph_id: graphId,
    id: "planner",
    agent: "emperor--chancellor",
    prompt: "Plan.",
    budget: { max_sessions: 2 },
  });
  ts.graph_add_node({
    graph_id: graphId,
    id: "reporter",
    agent: "emperor--docs",
    prompt: "Report.",
  });
  ts.graph_add_edge({ graph_id: graphId, from: "planner", to: "reporter", type: "always" });
}

/** A 2-node cycle wrapped in a loop group (id "lg", max 4 traversals) with an external entry node. */
function buildLoop(ts: GraphToolSet, graphId: string): void {
  ts.graph_add_node({ graph_id: graphId, id: "entry", agent: "agent-entry", prompt: "seed" });
  ts.graph_add_node({ graph_id: graphId, id: "a", agent: "agent-a", prompt: "p" });
  ts.graph_add_node({ graph_id: graphId, id: "b", agent: "agent-b", prompt: "p" });
  ts.graph_add_edge({ graph_id: graphId, from: "entry", to: "a", type: "always" });
  ts.graph_add_edge({ graph_id: graphId, from: "a", to: "b", type: "always" });
  ts.graph_add_edge({ graph_id: graphId, from: "b", to: "a", type: "always" });
  ts.graph_add_loop({ graph_id: graphId, id: "lg", nodes: ["a", "b"], max_traversals: 4 });
}

/** Direct access into the private registry slot (mirrors graph-tools.test.ts). */
function stateOf(ts: GraphToolSet, graphId: string) {
  return ts["getEntry"](graphId).runtime.status();
}

/**
 * Reach the runtime's LIVE `EngineState` (not the `status()` snapshot clone).
 * `graph_status` reads a fresh `runtime.status()` snapshot per call, so a
 * recorded checkpoint / artifact / evidence / round / signal-history entry must
 * be injected into the live state — exactly where the engine's recorders
 * (`src/graph/engine/recorder.ts`, `signal-bridge.ts:record`) write it.
 */
function liveState(ts: GraphToolSet, graphId: string): EngineState {
  const runtime = ts["getEntry"](graphId).runtime as unknown as { state: EngineState };
  return runtime.state;
}

// ── §2.2 unbacked-flag documentation registry ─────────────────────────────

describe("§2.2 unbacked flag registry", () => {
  it("is now empty — every original §2.2 flag is backed", () => {
    // After C-WIRE backed the final seven flags, the registry must be empty.
    // `group_by` / `limit` / `depth` were backed in subtask 3; `include_concurrency`
    // in subtask 4; `round` / `include_checkpoint` / `include_history` /
    // `include_artifacts` / `include_evidence` / `stream` / `since` in C-WIRE.
    expect(UNSUPPORTED_GRAPH_STATUS_FLAGS).toEqual([]);
  });

  it("gives a non-empty reason per (remaining) unbacked flag", () => {
    for (const entry of UNSUPPORTED_GRAPH_STATUS_FLAGS) {
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("does not collide with backed/exposed flags", () => {
    const flags = new Set(UNSUPPORTED_GRAPH_STATUS_FLAGS.map((f) => f.flag));
    const backed = [
      "graph_id",
      "node_id",
      "loop_id",
      "format",
      "query",
      "status",
      "agent",
      "from_date",
      "to_date",
      "group_by",
      "limit",
      "depth",
      "include_output",
      "include_progress",
      "include_budget",
      "include_metrics",
      "include_loops",
      "include_concurrency",
      // The seven C-WIRE-backed flags.
      "include_checkpoint",
      "include_artifacts",
      "include_evidence",
      "include_history",
      "round",
      "stream",
      "since",
      "max_chars",
      "offset",
      "tail",
      "export_path",
    ];
    for (const b of backed) {
      expect(flags.has(b), `backed flag "${b}" must not be listed as unbacked`).toBe(false);
    }
  });
});

// ── C-WIRE flags are exposed as GraphStatusArgs ───────────────────────────

describe("C-WIRE flags are exposed on GraphStatusArgs", () => {
  it("declares all seven C-WIRE flag keys", () => {
    // Static/compile-time guarantee that the tool-logic interface now advertises
    // the seven backed flags (previously they were deliberately absent because
    // the engine could not answer them).
    const exposed = new Set<keyof GraphStatusArgs>([
      "include_checkpoint",
      "include_artifacts",
      "include_evidence",
      "include_history",
      "round",
      "stream",
      "since",
    ]);
    for (const flag of exposed) {
      expect(flag).toBeTruthy();
    }
  });
});

// ── backed flags return REAL data ─────────────────────────────────────────

describe("graph_status backed flags return genuine engine data", () => {
  function status(ts: GraphToolSet, graphId: string, args: Partial<GraphStatusArgs> = {}) {
    return ts.graph_status({ graph_id: graphId, ...args });
  }

  it("include_history surfaces the loop's recorded round history", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cwire-history" });
    buildLoop(ts, graph_id);
    const rounds: RoundHistoryEntry[] = [
      { round: 1, traversalCount: 1, nodeIds: ["a", "b"], status: NodeStatus.Completed, startedAt: 100, completedAt: 200 },
      { round: 2, traversalCount: 2, nodeIds: ["a", "b"], status: NodeStatus.Completed, startedAt: 300 },
    ];
    const group = liveState(ts, graph_id).loopGroups.get("lg")!;
    group.rounds = rounds;

    const out = ts.graph_status({ graph_id, loop_id: "lg", include_history: true });
    expect(out).toContain("## Loop Round History");
    expect(out).toContain('Loop "lg"');
    expect(out).toContain("round 1");
    expect(out).toContain("[traversal 1]");
    expect(out).toContain("round 2");
    expect(out).toContain("a, b");
  });

  it("round filters history to a specific recorded round (honest when absent)", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cwire-round" });
    buildLoop(ts, graph_id);
    liveState(ts, graph_id).loopGroups.get("lg")!.rounds = [
      { round: 1, traversalCount: 1, nodeIds: ["a", "b"], status: NodeStatus.Completed, startedAt: 100, completedAt: 200 },
      { round: 2, traversalCount: 2, nodeIds: ["a", "b"], status: NodeStatus.Completed, startedAt: 300 },
    ];

    const out = ts.graph_status({ graph_id, loop_id: "lg", round: 2 });
    expect(out).toContain("round 2");
    expect(out).not.toContain("round 1");

    // A round that was never recorded → explicit honest note, not a fabricated row.
    const missing = ts.graph_status({ graph_id, loop_id: "lg", round: 9 });
    expect(missing).toContain("round 9: not recorded");
  });

  it("include_checkpoint surfaces the node's recorded lifecycle checkpoint", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cwire-checkpoint" });
    buildChain(ts, graph_id);
    const checkpoint: CheckpointRecord = {
      nodeId: "reporter",
      status: NodeStatus.Running,
      at: 1234567890,
      note: "ready→running",
    };
    liveState(ts, graph_id).checkpoints = { reporter: checkpoint };

    const out = ts.graph_status({ graph_id, node_id: "reporter", include_checkpoint: true });
    expect(out).toContain("## Checkpoints");
    expect(out).toContain("reporter");
    expect(out).toContain("[running]");
    expect(out).toContain("ready→running");
  });

  it("include_checkpoint surfaces the checkpoint recorded during provision", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cwire-cp" });
    buildChain(ts, graph_id);
    const out = ts.graph_status({ graph_id, include_checkpoint: true });
    // Provision now routes root nodes through markReady, recording a checkpoint.
    expect(out).toContain("ready");
  });

  it("include_artifacts / include_evidence surface the node's recorded arrays", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cwire-arts" });
    buildChain(ts, graph_id);
    const node = liveState(ts, graph_id).nodes.get("reporter")!;
    node.artifacts = ["/work/report.md", "/work/data.json"];
    node.evidence = ["/work/evidence/claim-1.md"];

    const out = ts.graph_status({ graph_id, node_id: "reporter", include_artifacts: true, include_evidence: true });
    expect(out).toContain("## Artifacts / Evidence");
    expect(out).toContain('/work/report.md');
    expect(out).toContain('/work/data.json');
    expect(out).toContain('/work/evidence/claim-1.md');
  });

  it("include_artifacts / include_evidence report an honest-empty note when none", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cwire-no-arts" });
    buildChain(ts, graph_id);
    const out = ts.graph_status({ graph_id, include_artifacts: true, include_evidence: true });
    expect(out).toContain("no artifacts / evidence recorded");
  });

  it("stream surfaces the node's timestamped signal-event history", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cwire-stream" });
    buildChain(ts, graph_id);
    const state = liveState(ts, graph_id);
    state.signalLedger.set("reporter", {
      signals: { progress: { stage: "writing", percentage: 50, message: "halfway" } },
      lastSignalAt: 5000,
      history: [
        { signal: "progress", payload: { percentage: 25, message: "started" }, atMs: 1000, source: "dispatch" },
        { signal: "progress", payload: { percentage: 50, message: "halfway" }, atMs: 5000, source: "dispatch" },
      ],
    });

    const out = ts.graph_status({ graph_id, node_id: "reporter", stream: true });
    expect(out).toContain("## Signal Stream");
    expect(out).toContain("progress");
    expect(out).toContain('"percentage":25');
    expect(out).toContain('"percentage":50');
    expect(out).toContain("halfway");
    // Assert the source discriminator is surfaced in the output.
    expect(out).toContain("[dispatch]");
  });

  it("since filters the signal stream after an ISO timestamp (honest when empty)", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cwire-since" });
    buildChain(ts, graph_id);
    const state = liveState(ts, graph_id);
    state.signalLedger.set("reporter", {
      signals: {},
      lastSignalAt: 5000,
      history: [
        { signal: "progress", payload: { percentage: 25, message: "started" }, atMs: 1000, source: "dispatch" },
        { signal: "answer", payload: { done: true }, atMs: 5000, source: "dispatch" },
      ],
    });

    const since = new Date(4000).toISOString();
    const out = ts.graph_status({ graph_id, node_id: "reporter", stream: true, since });
    // The earlier (atMs 1000) event is filtered out; the atMs 5000 event remains.
    expect(out).not.toContain("percentage");
    expect(out).toContain("answer");
    expect(out).toContain("[dispatch]");

    // A since bound after every event → explicit "no events since" note.
    const late = ts.graph_status({ graph_id, node_id: "reporter", stream: true, since: new Date(9999).toISOString() });
    expect(late).toContain("no events since");
  });

  it("stream reports 'no events recorded' honestly for an empty history", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cwire-no-events" });
    buildChain(ts, graph_id);
    const out = ts.graph_status({ graph_id, node_id: "reporter", stream: true });
    expect(out).toContain("no events recorded");
  });

  it("json format merges C-WIRE flag data into the snapshot", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cwire-json" });
    buildChain(ts, graph_id);
    const node = liveState(ts, graph_id).nodes.get("reporter")!;
    node.artifacts = ["/work/report.md"];
    liveState(ts, graph_id).checkpoints = {
      reporter: { nodeId: "reporter", status: NodeStatus.Completed, at: 1000 },
    };

    const parsed = JSON.parse(
      status(ts, graph_id, { format: "json", include_artifacts: true, include_checkpoint: true }),
    );
    expect(parsed.artifacts_evidence).toEqual([
      { node_id: "reporter", artifacts: ["/work/report.md"] },
    ]);
    expect(parsed.checkpoints).toEqual([
      { node_id: "reporter", checkpoints: [{ nodeId: "reporter", status: NodeStatus.Completed, at: 1000 }] },
    ]);
    // Nodes without the requested arrays are omitted honestly from artifacts_evidence.
    expect(parsed.artifacts_evidence).toHaveLength(1);
  });

  it("json format includes source discriminator in signal_stream entries", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cwire-stream-json" });
    buildChain(ts, graph_id);
    const state = liveState(ts, graph_id);
    state.signalLedger.set("reporter", {
      signals: { answer: { ok: true } },
      lastSignalAt: 2000,
      history: [
        { signal: "progress", payload: { step: 1 }, atMs: 1000, source: "dispatch" },
        { signal: "answer", payload: { ok: true }, atMs: 2000, source: "recovery" },
      ],
    });

    const parsed = JSON.parse(
      status(ts, graph_id, { format: "json", stream: true }),
    );
    expect(parsed.signal_stream).toBeDefined();
    const reporterStream = parsed.signal_stream.find(
      (s: { node_id: string }) => s.node_id === "reporter",
    );
    expect(reporterStream).toBeDefined();
    expect(reporterStream.events).toHaveLength(2);
    expect(reporterStream.events[0].source).toBe("dispatch");
    expect(reporterStream.events[1].source).toBe("recovery");
  });
});

// ── no fabrication: flags never produce invented output ───────────────────

describe("graph_status never fabricates flag data", () => {
  it("a genuinely unknown key is a no-op (args are ignored, not invented)", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "ignore-unk" });
    buildChain(ts, graph_id);
    const plain = ts.graph_status({ graph_id });
    // A key that is not a real GraphStatusArgs field must not alter the output.
    const stray = ts.graph_status({ graph_id, bogus_flag: true } as unknown as GraphStatusArgs);
    expect(stray).toBe(plain);
  });
});
