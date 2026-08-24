/**
 * Graph Execution Engine v2 — loop-group bound pathologies (tool layer)
 *
 * Complements the engine-level loop-group suite (`loop-group.test.ts`) by
 * driving every bound pathology through the PUBLIC `GraphToolSet` API exactly
 * as a model would — `graph_create` → `graph_add_node` → `graph_add_edge` →
 * `graph_add_loop` → `graph_run` → `graph_status` — with the scripted-dispatch
 * fake harness established by graph-run-degenerate-topologies.test.ts (subtask
 * 3) as the dispatch seam.
 *
 * Harness extension: `ScriptedSignalDispatch` subclasses the shared
 * `ScriptedDispatch` and scripts each node's TERMINATING SIGNAL per dispatch by
 * attaching `task.terminatingSignal` before the auto-completion tick fires. The
 * engine's dispatch→signal reconcile (engine-recovery.ts
 * `mapDispatchStatusToSignal`) honors a recorded terminating signal on a
 * `completed` task, so a review node can emit `revise_needed`/`answer` through
 * the real tool path — no engine internals are touched.
 *
 * Topology: the review-loop pattern from loop-group.test.ts:60-80
 * (entry → impl → review with a `revise_needed` back-edge and an `answer`
 * forward edge to sink; loop group over [impl, review]; impl joins on `any`).
 *
 * ⚠ Tool-layer reality pinned by this file: the tool layer now matches the
 * engine layer's SINGLE-ADVANCE semantics. The production double-advance
 * defect (H1) is fixed — engine-advance.ts `_advance` gates the loop-member
 * escalate/revise propagation and convergence steps on `migrated` status, so
 * a replayed/duplicate signal (the double-dispatch seam) is no longer
 * processed a second time: it neither re-counts a traversal nor trips the
 * stuck detector. Cases (a) and (b) below pin the FIXED behavior.
 *
 *  1. DUPLICATE LOOP MEMBERS ARE REJECTED: validator rule 5c
 *     (validator-v2.ts:196-212) treats a duplicated member id as multi-group
 *     membership, so `graph_add_loop` with nodes ["a","a","b"] throws
 *     "appears in multiple loop groups" — dedupe is NOT performed, but the
 *     tool does NOT accept the declaration either (the task brief expected
 *     acceptance; current behavior rejects).
 *
 * Cases (each pins the CURRENT production behavior and asserts it via
 * graph_status — TEST-ONLY, no production code changed):
 *
 *  (a) max_traversals: 1 — the first dispatched revise consumes the ONLY
 *      traversal (impl re-enters, traversalCount → 1); the reviewer's second
 *      round IS dispatched and the second revise is consumed, hitting the cap,
 *      so the reviewer retires `done` with reason "max_traversals exhausted".
 *      The graph completes. Asserts the traversal counter and the reviewer's
 *      escalate-equivalent status via graph_status, plus the dispatch ledger.
 *
 *  (b) max_traversals: 1_000_000_000 (absurdly large — the tool only enforces
 *      >= 1, so the declaration is ACCEPTED) — the loop STILL terminates:
 *      review is dispatched twice and the two GENUINELY identical revise
 *      records trip the designed stuck early-exit (consecutiveStale hits
 *      CONSECUTIVE_STALE_THRESHOLD = 2, engine-state.ts:636-657) with no
 *      further traversal consumed, and the loop does NOT spin toward the cap
 *      (dispatch count stays at 5). Phase Complete.
 *
 *  (c) same huge cap but the FIRST review converges with `answer` — the loop
 *      exits on the happy path (no traversal consumed, each signal processed
 *      exactly once under single-advance semantics), sink activates exactly
 *      once, phase Complete.
 *
 *  (d) graph_add_loop nodes list with a duplicate member (["impl","impl",
 *      "review"]) — PINNED: the tool REJECTS the declaration with the rule-5c
 *      error "appears in multiple loop groups"; dedupe is NOT performed and
 *      the induced-cycle check is never reached (membership-disjointness
 *      rejects first).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import { GraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import type { NodeRuntimeState } from "../../src/types.engine-v2.ts";
import type { DispatchParentContext } from "../../src/graph/engine/dispatch-bridge.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import { clearParentQueues } from "../../src/dispatch/notification.ts";
import { ScriptedDispatch, settle } from "./helpers/scripted-dispatch.ts";

// ── Scripted-signal dispatch seam ────────────────────────────────────────────

/** One scripted terminating signal for a single dispatch of a node. */
interface ScriptedSignal {
  type: string;
  payload?: unknown;
}

/**
 * Extends the subtask-3 harness (helpers/scripted-dispatch.ts) so each dispatch
 * of a node carries a scripted TERMINATING SIGNAL on the task. The base class
 * schedules its auto-completion on a `setTimeout(0)` tick; this subclass
 * attaches the signal in the (microtask) resolution of the returned promise,
 * which always runs before that macrotask fires. `mapDispatchStatusToSignal`
 * (engine-recovery.ts:207) then surfaces the scripted signal type/payload to
 * the engine — e.g. `revise_needed`, then `answer`.
 */
class ScriptedSignalDispatch extends ScriptedDispatch {
  private scripts = new Map<string, ScriptedSignal[]>();

  /** Queue the terminating signals a node emits, consumed per dispatch. */
  script(nodeId: string, signals: ScriptedSignal[]): void {
    this.scripts.set(nodeId, [...signals]);
  }

  override executeNode(
    node: NodeRuntimeState,
    ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    return super.executeNode(node, ctx).then((task) => {
      const next = this.scripts.get(node.nodeId)?.shift();
      if (next) {
        task.terminatingSignal = { type: next.type, payload: next.payload };
      }
      return task;
    });
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Build the review-loop topology (loop-group.test.ts:60-80) through the tool
 * layer: entry seeds impl; impl feeds review on `answer`; review either
 * revises back to impl (`revise_needed` back-edge) or converges forward to
 * sink (`answer`). `impl` joins on `any` so it boots after entry without
 * waiting on the review back-edge. Returns the graph_add_loop result so tests
 * can pin the accepted member list verbatim.
 */
function reviewLoop(
  ts: GraphToolSet,
  graphId: string,
  maxTraversals: number,
  members?: string[],
) {
  ts.graph_add_node({ graph_id: graphId, id: "entry", agent: "a0", prompt: "seed" });
  ts.graph_add_node({
    graph_id: graphId,
    id: "impl",
    agent: "a1",
    prompt: "implement",
    join: { strategy: "any" },
  });
  ts.graph_add_node({ graph_id: graphId, id: "review", agent: "a2", prompt: "review" });
  ts.graph_add_node({ graph_id: graphId, id: "sink", agent: "a3", prompt: "sink" });
  ts.graph_add_edge({ graph_id: graphId, from: "entry", to: "impl", type: "always" });
  ts.graph_add_edge({
    graph_id: graphId,
    from: "impl",
    to: "review",
    type: "on_signal",
    signal_filter: ["answer"],
  });
  ts.graph_add_edge({
    graph_id: graphId,
    from: "review",
    to: "impl",
    type: "on_signal",
    signal_filter: ["revise_needed"],
  });
  ts.graph_add_edge({
    graph_id: graphId,
    from: "review",
    to: "sink",
    type: "on_signal",
    signal_filter: ["answer"],
  });
  return ts.graph_add_loop({
    graph_id: graphId,
    id: "lg",
    nodes: members ?? ["impl", "review"],
    max_traversals: maxTraversals,
  });
}

// ── graph_status JSON shape (subset asserted by these tests) ─────────────────

interface NodeJson {
  node_id: string;
  status: string;
  error?: string;
  traversal_count: number;
  loop_group?: string;
}

interface LoopJson {
  loop_id: string;
  traversals: string;
  nodes: string[];
  consecutive_stale?: number;
}

interface GraphJson {
  graph_id: string;
  phase: string;
  nodes: NodeJson[];
  loops?: LoopJson[];
}

function graphJson(ts: GraphToolSet, graphId: string): GraphJson {
  return JSON.parse(
    ts.graph_status({ graph_id: graphId, format: "json", include_loops: true }),
  ) as GraphJson;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("graph loop-group bound pathologies (tool layer)", () => {
  beforeEach(() => {
    clearParentQueues();
  });

  it("(a) max_traversals: 1 — the first revise consumes the only traversal (impl re-enters, traversal 1); the second revise is consumed and hits the cap → reviewer retires done 'max_traversals exhausted'; graph completes", async () => {
    const fake = new ScriptedSignalDispatch();
    const ts = new GraphToolSet({ dispatch: fake });
    const g = ts.graph_create({ name: "loop-cap-1" });
    reviewLoop(ts, g.graph_id, 1);

    // Script two revises with DIFFERENT payloads: under single-advance
    // semantics the second dispatch IS consumed — it re-enters impl (traversal
    // 1) and exhausts the cap on the reviewer's second round.
    fake.script("impl", [
      { type: "answer", payload: "v1" },
      { type: "answer", payload: "v2" },
    ]);
    fake.script("review", [
      { type: "revise_needed", payload: { findings: ["issue 1"] } },
      { type: "revise_needed", payload: { findings: ["issue 2"] } },
    ]);

    await ts.graph_run({ graph_id: g.graph_id });
    await settle();

    // Dispatch ledger: entry once; impl initial + one revise re-entry; review
    // dispatched TWICE — the second scripted revise is consumed (the cap is
    // reached, so no third round can start).
    expect(fake.dispatches("entry")).toBe(1);
    expect(fake.dispatches("impl")).toBe(2);
    expect(fake.dispatches("review")).toBe(2);
    expect(fake.dispatches("sink")).toBe(0);

    const json = graphJson(ts, g.graph_id);
    expect(json.phase).toBe(EnginePhase.Complete);

    const byId = new Map(json.nodes.map((n) => [n.node_id, n]));
    // The first revise DID re-enter impl: per-node traversal counter is 1 and
    // the loop group counter is pinned at the cap (1/1).
    expect(byId.get("impl")!.traversal_count).toBe(1);
    expect(byId.get("impl")!.status).toBe(NodeStatus.Completed);
    expect(json.loops![0].traversals).toBe("1/1");
    // Escalate-equivalent status via graph_status: the reviewer retired
    // `completed → done`. The two scripted revises carry DIFFERENT payloads,
    // so no identical-record stuck detection fires — the reviewer hits the
    // cap and retires with the designed reason "max_traversals exhausted"
    // (reachable again under single-advance semantics).
    expect(byId.get("review")!.status).toBe(NodeStatus.Done);
    expect(byId.get("review")!.error).toBe("max_traversals exhausted");
    // Different payloads → only one stale record was ever registered.
    expect(json.loops![0].consecutive_stale).toBe(1);
    // The loop never converged — sink was never activated (the runtime
    // deadlock guard retired the still-pending sink after the reviewer stopped).
    expect(byId.get("sink")!.status).toBe(NodeStatus.Escalate);
  });

  it("(b) max_traversals: 1e9 — two genuinely identical revise rounds trip the designed stuck early-exit (consecutiveStale=2); the loop does NOT spin to the cap", async () => {
    const fake = new ScriptedSignalDispatch();
    const ts = new GraphToolSet({ dispatch: fake });
    const g = ts.graph_create({ name: "loop-huge-cap-stuck" });

    // The tool accepts an absurdly large cap — graph_add_loop only enforces
    // max_traversals >= 1.
    const loop = reviewLoop(ts, g.graph_id, 1_000_000_000);
    expect(loop.max_traversals).toBe(1_000_000_000);

    fake.script("impl", [
      { type: "answer", payload: "v1" },
      { type: "answer", payload: "v2" },
    ]);
    fake.script("review", [
      { type: "revise_needed", payload: { findings: ["no progress"] } },
      // IDENTICAL payload — same trimmed-text fingerprint.
      { type: "revise_needed", payload: { findings: ["no progress"] } },
    ]);

    await ts.graph_run({ graph_id: g.graph_id });
    await settle();

    // Under single-advance semantics review is dispatched TWICE; the two REAL
    // identical revise records push consecutiveStale to
    // CONSECUTIVE_STALE_THRESHOLD (2) and retire the reviewer `done` with the
    // DESIGNED "stuck" reason. This is a genuine stuck early-exit — NOT the
    // old double-advance artifact (same error string, different cause: two
    // real identical traversals, not one signal processed twice).
    // Total ledger: entry(1) + impl(2) + review(2) = 5 — the loop did NOT spin
    // anywhere near the 1e9 cap.
    expect(fake.dispatchCount).toBe(5);
    expect(fake.dispatches("review")).toBe(2);

    const json = graphJson(ts, g.graph_id);
    expect(json.phase).toBe(EnginePhase.Complete);

    const byId = new Map(json.nodes.map((n) => [n.node_id, n]));
    expect(byId.get("review")!.status).toBe(NodeStatus.Done);
    expect(byId.get("review")!.error).toBe("stuck");
    // The stuck exit consumes NO additional traversal — counter sits at 1.
    expect(json.loops![0].traversals).toBe("1/1000000000");
    expect(json.loops![0].consecutive_stale).toBe(2);
    expect(byId.get("impl")!.status).toBe(NodeStatus.Completed);
  });

  it("(c) max_traversals: 1e9 — converged answer on the first review exits the happy path; sink activates exactly once", async () => {
    const fake = new ScriptedSignalDispatch();
    const ts = new GraphToolSet({ dispatch: fake });
    const g = ts.graph_create({ name: "loop-huge-cap-converged" });
    reviewLoop(ts, g.graph_id, 1_000_000_000);

    fake.script("impl", [{ type: "answer", payload: "v1" }]);
    fake.script("review", [{ type: "answer", payload: "accepted" }]);

    await ts.graph_run({ graph_id: g.graph_id });
    await settle();

    // Happy path: one dispatch per node, sink activated exactly once (under
    // single-advance semantics a converged answer never re-activates an
    // already-running sink).
    expect(fake.dispatches("entry")).toBe(1);
    expect(fake.dispatches("impl")).toBe(1);
    expect(fake.dispatches("review")).toBe(1);
    expect(fake.dispatches("sink")).toBe(1);

    const json = graphJson(ts, g.graph_id);
    expect(json.phase).toBe(EnginePhase.Complete);

    const byId = new Map(json.nodes.map((n) => [n.node_id, n]));
    expect(byId.get("review")!.status).toBe(NodeStatus.Completed);
    expect(byId.get("sink")!.status).toBe(NodeStatus.Completed);
    // A converged exit consumes NO traversal — 0/1e9, not 1/1e9.
    expect(json.loops![0].traversals).toBe("0/1000000000");
  });

  it("(d) duplicate loop member — PINNED: graph_add_loop REJECTS it (rule 5c, no dedupe); the induced-cycle check is never reached", async () => {
    const fake = new ScriptedSignalDispatch();
    const ts = new GraphToolSet({ dispatch: fake });
    const g = ts.graph_create({ name: "loop-dup-member" });

    // PINNED current behavior: a duplicated member id is treated as multi-group
    // membership by validator rule 5c (validator-v2.ts:196-212) — the tool
    // throws at commit (graph_add_loop → validateGraphDeclaration), so dedupe
    // is NOT performed AND the declaration is NOT accepted (the task brief
    // expected acceptance — a FINDING; see file header).
    expect(() => reviewLoop(ts, g.graph_id, 5, ["impl", "impl", "review"])).toThrow(
      /appears in multiple loop groups/,
    );

    // The graph is still runnable at the last CONSISTENT declaration (no loop
    // group was committed — the failed add left the registry untouched), so
    // the engine can still run the happy path once.
    fake.script("impl", [{ type: "answer", payload: "v1" }]);
    fake.script("review", [{ type: "answer", payload: "accepted" }]);

    await ts.graph_run({ graph_id: g.graph_id });
    await settle();

    // No loop group was ever registered — the engine ran the plain chain once.
    expect(fake.dispatches("impl")).toBe(1);
    expect(fake.dispatches("review")).toBe(1);
    expect(fake.dispatches("sink")).toBe(1);
    const json = graphJson(ts, g.graph_id);
    expect(json.phase).toBe(EnginePhase.Complete);
    // No loop group was committed (include_loops renders an empty list).
    expect(json.loops).toEqual([]);
  });
});
