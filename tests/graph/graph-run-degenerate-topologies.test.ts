/**
 * Graph Execution Engine v2 — graph_run degenerate topologies
 *
 * ESTABLISHES the scripted-dispatch harness convention for the follow-on
 * graph-run subtasks (4, 5, 6): a local scripted dispatch fake
 * (`tests/graph/helpers/scripted-dispatch.ts`, modeled on `FiringDispatch` in
 * engine-index.test.ts and the auto-completing seams of graph-run-atomic.test.ts
 * / graph-run-idempotent.test.ts) that AUTO-COMPLETES every task via its
 * `onTaskTerminated` listener and records dispatch counts per nodeId. The tool
 * set is driven through the public API exactly as a model would:
 * `GraphToolSet({ dispatch: <fake> })` → `graph_create` → `graph_add_node` →
 * `graph_add_edge` → `graph_add_loop` → `graph_run` → `graph_status`.
 *
 * Cases under test — topologies that exercise the engine's degenerate-shape
 * handling WITHOUT a real dispatch subsystem:
 *
 *  (a) EMPTY graph (create + run, no nodes): `graph_run` resolves with phase
 *      Complete and empty active/pending — the quiescent-complete path with no
 *      nodes (engine-termination.ts `checkGraphTermination`, `!hasAnyActive`).
 *      Nothing is ever dispatched.
 *
 *  (b) Pure always-cycle A<->B with NO loop group: the uncontained
 *      revise-free cycle is construct-valid (WARNING) but fails execution-mode
 *      validation, so graph_run REJECTS before any engine is built — nothing
 *      is ever dispatched. (Engine-level deadlock-guard coverage for this
 *      topology lives in engine-terminal.test.ts / engine-termination-s4.test.ts,
 *      which drive createEngine directly and bypass this validation gate.)
 *
 *  (c) Single-node self-loop A->A inside loop group {A}: the self-loop edge is
 *      excluded from in-degree root discovery (intra-loop-group always edge),
 *      so A is a root and dispatches once; forward activation SKIPS self-loop
 *      edges (engine-advance.ts `_forwardActivation`, "Skip self-loop edges"),
 *      so A never re-dispatches and the graph completes.
 *
 *  (d) ORPHAN node (no edges): root and leaf in one — dispatched once,
 *      completes, graph terminates Complete.
 *
 *  (e) `graph_run({ node_id: "ghost", retry: true })` on a COMPLETED graph:
 *      `retryNode` → `getNode` throws "Unknown node id" (node-retry.ts →
 *      engine-state.ts `getNode`), `graph_run` rejects, and the failure
 *      atomicity path keeps the registry entry on the consistent prior runtime
 *      — `graph_status` still works and still reports phase Complete.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { EnginePhase } from "../../src/constants.ts";
import { GraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { clearParentQueues } from "../../src/dispatch/notification.ts";
import { ScriptedDispatch, settle } from "./helpers/scripted-dispatch.ts";

describe("graph_run degenerate topologies", () => {
  beforeEach(() => {
    clearParentQueues();
  });

  it("(a) graph_run on an EMPTY graph resolves Complete with no active/pending and zero dispatches", async () => {
    const fake = new ScriptedDispatch();
    const ts = new GraphToolSet({ dispatch: fake });
    const g = ts.graph_create({ name: "empty" });

    const r = await ts.graph_run({ graph_id: g.graph_id });

    expect(r.phase).toBe(EnginePhase.Complete);
    expect(r.active_nodes).toEqual([]);
    expect(r.pending_nodes).toEqual([]);
    expect(fake.dispatchCount).toBe(0);
  });

  it("(b) a pure always-cycle A<->B with NO loop group is rejected by the execution-validation gate before any dispatch", async () => {
    const fake = new ScriptedDispatch();
    const ts = new GraphToolSet({ dispatch: fake });
    const g = ts.graph_create({ name: "always-cycle" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "B", agent: "b", prompt: "pB" });
    ts.graph_add_edge({ graph_id: g.graph_id, from: "A", to: "B", type: "always" });
    ts.graph_add_edge({ graph_id: g.graph_id, from: "B", to: "A", type: "always" });

    // Execution-mode validation (graph-tools.ts:1227-1235) promotes the
    // uncontained revise-free always-cycle to a fatal error BEFORE an engine
    // is built — graph_run rejects and zero nodes are ever dispatched.
    await expect(ts.graph_run({ graph_id: g.graph_id })).rejects.toThrow(
      /cycle detected/,
    );
    await expect(ts.graph_run({ graph_id: g.graph_id })).rejects.toThrow(
      /not contained in any declared loop group/,
    );
    expect(fake.dispatchCount).toBe(0);
  });

  it("(c) a single-node self-loop A->A in loop group {A} dispatches exactly once and completes", async () => {
    const fake = new ScriptedDispatch();
    const ts = new GraphToolSet({ dispatch: fake });
    const g = ts.graph_create({ name: "self-loop" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });
    // Self-loop inside the loop group: excluded from in-degree root discovery,
    // so A is a root and gets dispatched once.
    ts.graph_add_edge({ graph_id: g.graph_id, from: "A", to: "A", type: "always" });
    ts.graph_add_loop({
      graph_id: g.graph_id,
      id: "L",
      nodes: ["A"],
      max_traversals: 5,
    });

    await ts.graph_run({ graph_id: g.graph_id });
    await settle();

    // Forward activation skips the self-loop edge — no re-entry, no
    // re-dispatch; the graph reaches quiescence and completes.
    expect(fake.dispatches("A")).toBe(1);
    expect(ts.graph_status({ graph_id: g.graph_id })).toMatch(
      /phase: complete/,
    );
  });

  it("(d) an orphan node (no edges) dispatches once, completes, and the graph completes", async () => {
    const fake = new ScriptedDispatch();
    const ts = new GraphToolSet({ dispatch: fake });
    const g = ts.graph_create({ name: "orphan" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });

    await ts.graph_run({ graph_id: g.graph_id });
    await settle();

    expect(fake.dispatches("A")).toBe(1);
    expect(ts.graph_status({ graph_id: g.graph_id })).toMatch(
      /phase: complete/,
    );
  });

  it("(e) graph_run(node_id=ghost, retry) on a completed graph rejects /Unknown node id/ and leaves the registry consistent", async () => {
    const fake = new ScriptedDispatch();
    const ts = new GraphToolSet({ dispatch: fake });
    const g = ts.graph_create({ name: "ghost-retry" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });

    // Complete the graph first.
    await ts.graph_run({ graph_id: g.graph_id });
    await settle();
    expect(ts.graph_status({ graph_id: g.graph_id })).toMatch(/phase: complete/);

    // Retry an unknown node: retryNode → getNode throws, graph_run rejects.
    await expect(
      ts.graph_run({ graph_id: g.graph_id, node_id: "ghost", retry: true }),
    ).rejects.toThrow(/Unknown node id/);

    // Failure atomicity: the registry entry stays on the consistent prior
    // runtime — graph_status still works and still reports phase Complete.
    expect(ts.graph_status({ graph_id: g.graph_id })).toMatch(/phase: complete/);
    expect(fake.dispatches("A")).toBe(1); // no extra dispatch happened
  });
});
