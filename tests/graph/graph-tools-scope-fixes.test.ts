/**
 * Tool-layer scope-fix regression tests (N6 / FIX-PLAN wave 1).
 *
 * One regression per finding that changed observable behavior or a public
 * type boundary:
 *
 *  - Y29 — whole-graph `graph_cancel` reports the engine's authoritative
 *    CancelScopeReport retired set, so a node an earlier scoped cancel already
 *    retired is NOT counted twice (the old `errorReason` prefix filter did).
 *  - Y31 — the construction tools never alias a caller's object / array into
 *    the committed declaration.
 *  - Y28 — a non-Error throw is reported by its real text instead of
 *    `undefined` in every `graph_*` wrapper.
 *  - Y27 — the `graph_status` JSON snapshot is built with conditional spreads,
 *    so an unset flag contributes no key at all.
 *  - Y9  — `checkpointHistory` is authoritative; the derived `checkpoints`
 *    snapshot is only a legacy fallback.
 *  - B25 / B26 — the zod arg schemas reject the malformed values the tool layer
 *    used to accept, and the approval payload is constrained to JSON.
 *  - B21 — `filterNodes` narrows sequentially with unchanged semantics.
 */

import { describe, it, expect } from "bun:test";
import type { ZodType } from "zod";

import { createGraphToolSet, type GraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { createGraphTools } from "../../src/graph/tools/index.ts";
import {
  filterNodes,
  listPendingApprovals,
} from "../../src/graph/tools/status-queries.ts";
import { checkpointEntries } from "../../src/graph/tools/status-render.ts";
import { NodeStatus } from "../../src/constants.ts";
import type { EngineState, NodeRuntimeState } from "../../src/types.engine-v2.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

/** Reach the live EngineState backing a registry graph (test accessor). */
function liveState(ts: GraphToolSet, graphId: string): EngineState {
  return (
    ts as unknown as { getEntry(id: string): { runtime: { state: EngineState } } }
  ).getEntry(graphId).runtime.state;
}

/** Build the review-team-plus topology (mirrors graph-tools.test.ts). */
function buildReviewTeamPlus(ts: GraphToolSet, graphId: string): void {
  ts.graph_add_node({
    graph_id: graphId,
    id: "planner",
    agent: "emperor--chancellor",
    prompt: "Design the implementation plan.",
  });
  ts.graph_add_node({
    graph_id: graphId,
    id: "implementer",
    agent: "emperor--jinyiwei--backend",
    prompt: "Implement the feature.",
  });
  ts.graph_add_node({
    graph_id: graphId,
    id: "reviewer",
    agent: "emperor--validator",
    prompt: "Review the implementation.",
    join: { strategy: "all" },
  });
  ts.graph_add_node({
    graph_id: graphId,
    id: "approval-gate",
    agent: "emperor--jinyiwei",
    prompt: "Approve the final output.",
    needs_approval: true,
    join: { strategy: "all" },
  });
  ts.graph_add_edge({ graph_id: graphId, from: "planner", to: "implementer", type: "always" });
  ts.graph_add_edge({
    graph_id: graphId,
    from: "implementer",
    to: "reviewer",
    type: "on_signal",
    signal_filter: ["answer"],
  });
  ts.graph_add_edge({
    graph_id: graphId,
    from: "reviewer",
    to: "implementer",
    type: "on_signal",
    signal_filter: ["revise_needed"],
  });
  ts.graph_add_edge({
    graph_id: graphId,
    from: "reviewer",
    to: "approval-gate",
    type: "on_signal",
    signal_filter: ["answer"],
  });
  ts.graph_add_loop({
    graph_id: graphId,
    id: "review-cycle",
    nodes: ["implementer", "reviewer"],
    max_traversals: 5,
  });
}

/** Minimal tool execution context (mirrors graph-tools-registration.test.ts). */
function toolContext() {
  return {
    sessionID: "s1",
    messageID: "m1",
    agent: "test-agent",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

// ── Y29: graph_cancel reports the authoritative retired set ─────────────────

describe("graph_cancel whole-graph report (Y29)", () => {
  it("does not re-count a node an earlier scoped cancel already retired", async () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cancel-double-count" });
    buildReviewTeamPlus(ts, graph_id);

    const scoped = await ts.graph_cancel({ graph_id, node_id: "planner" });
    expect(scoped.cancelled).toEqual(["planner"]);

    const whole = await ts.graph_cancel({ graph_id });
    // The old errorReason-prefix filter re-counted "planner" (still Done with a
    // "cancelled" reason); the engine's CancelScopeReport skips it.
    expect(whole.cancelled).toEqual(["approval-gate", "implementer", "reviewer"]);

    // Together the two authoritative reports account for every retired node,
    // with no node counted twice.
    const state = ts["getEntry"](graph_id).runtime.status();
    const done = [...state.nodes.values()]
      .filter((n) => n.status === NodeStatus.Done)
      .map((n) => n.nodeId)
      .sort();
    expect([...scoped.cancelled, ...whole.cancelled].sort()).toEqual(done);
  });

  it("reports every cancellable node for a first-time whole-graph cancel", async () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cancel-whole" });
    buildReviewTeamPlus(ts, graph_id);
    const r = await ts.graph_cancel({ graph_id });
    expect(r.cancelled).toEqual([
      "approval-gate",
      "implementer",
      "planner",
      "reviewer",
    ]);
  });
});

// ── Y31: no aliasing of caller inputs into the declaration ──────────────────

describe("construction tools do not alias caller inputs (Y31)", () => {
  it("graph_create copies the budget object", () => {
    const ts = createGraphToolSet();
    const budget = { max_total_cost_usd: 20 };
    const { graph_id } = ts.graph_create({ name: "alias-budget", budget });
    expect(ts["getEntry"](graph_id).declaration.budget).not.toBe(budget);
    budget.max_total_cost_usd = 999;
    expect(ts["getEntry"](graph_id).declaration.budget).toEqual({
      max_total_cost_usd: 20,
    });
  });

  it("graph_add_node copies join and budget", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "alias-node" });
    const join = { strategy: "all" as const };
    const budget = { max_input_tokens: 100 };
    ts.graph_add_node({
      graph_id,
      id: "n",
      agent: "agent-a",
      prompt: "do work",
      join,
      budget,
    });
    const stored = ts["getEntry"](graph_id).declaration.nodes.find((n) => n.id === "n");
    expect(stored?.join).not.toBe(join);
    expect(stored?.budget).not.toBe(budget);
    budget.max_input_tokens = 500;
    expect(stored?.budget?.max_input_tokens).toBe(100);
  });

  it("graph_add_edge copies signal_filter and the passthrough arrays", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "alias-edge" });
    ts.graph_add_node({ graph_id, id: "a", agent: "x", prompt: "a" });
    ts.graph_add_node({ graph_id, id: "b", agent: "x", prompt: "b" });

    const filter = ["answer"];
    const include = ["result"];
    const exclude = ["budget"];
    ts.graph_add_edge({
      graph_id,
      from: "a",
      to: "b",
      type: "on_signal",
      signal_filter: filter,
      data_passthrough_include: include,
      data_passthrough_exclude: exclude,
    });

    const edge = ts["getEntry"](graph_id).declaration.edges[0];
    expect(edge.signal_filter).not.toBe(filter);
    expect(edge.data_passthrough?.fields).not.toBe(include);
    expect(edge.data_passthrough?.exclude).not.toBe(exclude);

    filter.push("escalate");
    include.push("extra");
    exclude.push("extra");
    expect(edge.signal_filter).toEqual(["answer"]);
    expect(edge.data_passthrough?.fields).toEqual(["result"]);
    expect(edge.data_passthrough?.exclude).toEqual(["budget"]);
  });
});

// ── Y28: non-Error throws keep their reason ─────────────────────────────────

describe("tool wrappers surface non-Error throws (Y28)", () => {
  it("reports a thrown string instead of \"undefined\"", async () => {
    const toolset = createGraphToolSet();
    toolset.graph_create = () => {
      throw "boom";
    };
    const { graph_create } = createGraphTools(undefined, { directory: "/tmp", toolset });
    const out = await graph_create.execute({ name: "x" }, toolContext());
    expect(out).toBe("graph_create failed: boom");
  });

  it("never lets an unprintable thrown value escape the wrapper", async () => {
    const toolset = createGraphToolSet();
    toolset.graph_create = () => {
      throw Object.create(null);
    };
    const { graph_create } = createGraphTools(undefined, { directory: "/tmp", toolset });
    const out = await graph_create.execute({ name: "x" }, toolContext());
    expect(out).toBe("graph_create failed: <unprintable thrown value>");
  });
});

// ── Y27: conditional snapshot keys ──────────────────────────────────────────

describe("graph_status JSON snapshot keys (Y27)", () => {
  it("omits unset flag keys entirely and emits them when requested", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "snapshot-keys" });
    ts.graph_add_node({ graph_id, id: "a", agent: "x", prompt: "a" });

    const plain = JSON.parse(ts.graph_status({ graph_id, format: "json" }));
    for (const key of ["budget", "loops", "metrics", "round_history", "checkpoints", "artifacts_evidence", "signal_stream"]) {
      expect(plain).not.toHaveProperty(key);
    }

    const flagged = JSON.parse(
      ts.graph_status({
        graph_id,
        format: "json",
        include_budget: true,
        include_loops: true,
        include_metrics: true,
      }),
    );
    expect(flagged.budget).toBeDefined();
    expect(flagged.loops).toEqual([]);
    expect(typeof flagged.metrics).toBe("string");
  });

  it("merges C-WIRE flag data onto the node-scoped JSON view", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "snapshot-node" });
    ts.graph_add_node({ graph_id, id: "a", agent: "x", prompt: "a" });
    const node = liveState(ts, graph_id).nodes.get("a")!;
    node.artifacts = ["/work/out.md"];

    const parsed = JSON.parse(
      ts.graph_status({
        graph_id,
        node_id: "a",
        format: "json",
        include_artifacts: true,
      }),
    );
    expect(parsed.artifacts_evidence).toEqual([
      { node_id: "a", artifacts: ["/work/out.md"] },
    ]);
  });
});

// ── Y9: checkpointHistory is authoritative, checkpoints is derived ──────────

describe("checkpoint read contract (Y9)", () => {
  it("prefers the ordered checkpointHistory when both fields exist", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cp-history" });
    ts.graph_add_node({ graph_id, id: "n", agent: "x", prompt: "n" });
    const state = liveState(ts, graph_id);
    state.checkpoints = {
      n: { nodeId: "n", status: NodeStatus.Completed, at: 20 },
    };
    state.checkpointHistory = {
      n: [
        { nodeId: "n", status: NodeStatus.Ready, at: 10 },
        { nodeId: "n", status: NodeStatus.Completed, at: 20 },
      ],
    };
    expect(checkpointEntries(state, "n")).toEqual([
      {
        node_id: "n",
        checkpoints: [
          { nodeId: "n", status: NodeStatus.Ready, at: 10 },
          { nodeId: "n", status: NodeStatus.Completed, at: 20 },
        ],
      },
    ]);
  });

  it("falls back to the derived latest snapshot for a pre-history state", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cp-legacy" });
    ts.graph_add_node({ graph_id, id: "n", agent: "x", prompt: "n" });
    const state = liveState(ts, graph_id);
    state.checkpointHistory = {};
    state.checkpoints = {
      n: { nodeId: "n", status: NodeStatus.Running, at: 5, note: "legacy" },
    };
    // The fallback is explicit (warning logged) but still surfaces the data.
    expect(checkpointEntries(state, "n")).toEqual([
      {
        node_id: "n",
        checkpoints: [{ nodeId: "n", status: NodeStatus.Running, at: 5, note: "legacy" }],
      },
    ]);
  });
});

// ── B25 / B26: zod boundary constraints ─────────────────────────────────────

describe("tool arg schemas reject malformed values (B25 / B26)", () => {
  const tools = createGraphTools(undefined, { directory: "/tmp" });

  // `createGraphTools` is typed `Record<string, CanonicalToolDef>`, whose default
  // `z.ZodRawShape` arg type erases every tool schema to zod's base `$ZodType`
  // (no `safeParse`) although the runtime values are concrete schemas. This
  // narrows the view for the boundary assertions below without changing them.
  // Contract drift in the tool layer's return type — see fixes/N7-gates.md.
  const schema = (entry: unknown): ZodType => entry as ZodType;

  it("graph_create.name rejects empty and whitespace-only names", () => {
    expect(schema(tools.graph_create.args.name).safeParse("").success).toBe(false);
    expect(schema(tools.graph_create.args.name).safeParse("   ").success).toBe(false);
    expect(schema(tools.graph_create.args.name).safeParse("ok").success).toBe(true);
  });

  it("graph_add_node rejects an empty id / prompt and a blank agent", () => {
    expect(schema(tools.graph_add_node.args.id).safeParse("").success).toBe(false);
    expect(schema(tools.graph_add_node.args.prompt).safeParse("").success).toBe(false);
    expect(schema(tools.graph_add_node.args.agent).safeParse("").success).toBe(false);
    expect(schema(tools.graph_add_node.args.agent).safeParse("   ").success).toBe(false);
    expect(schema(tools.graph_add_node.args.id).safeParse("node-1").success).toBe(true);
  });

  it("join requires the quorum count for strategy=quorum (C1)", () => {
    const join = schema(tools.graph_add_node.args.join);
    expect(join.safeParse({ strategy: "all" }).success).toBe(true);
    expect(join.safeParse({ strategy: "any" }).success).toBe(true);
    expect(join.safeParse({ strategy: "quorum" }).success).toBe(false);
    expect(join.safeParse({ strategy: "quorum", quorum: 2 }).success).toBe(true);
    expect(join.safeParse({ strategy: "quorum", quorum: 0 }).success).toBe(false);
  });

  it("edge retry rejects negative and fractional counts", () => {
    const retry = schema(tools.graph_add_edge.args.retry);
    expect(retry.safeParse(2).success).toBe(true);
    expect(retry.safeParse(-1).success).toBe(false);
    expect(retry.safeParse(1.5).success).toBe(false);
    expect(retry.safeParse({ max: 2 }).success).toBe(true);
    expect(retry.safeParse({ max: -1 }).success).toBe(false);
    expect(retry.safeParse({ max: 2, backoff_ms: -5 }).success).toBe(false);
  });

  it("graph_approve.payload accepts JSON values only", () => {
    const payload = schema(tools.graph_approve.args.payload);
    expect(payload.safeParse({ a: [1, "x", true, null] }).success).toBe(true);
    expect(payload.safeParse("plain").success).toBe(true);
    expect(payload.safeParse(() => {}).success).toBe(false);
    expect(payload.safeParse({ a: 1n }).success).toBe(false);
  });

  it("summarizePayload contains a cyclic approval payload instead of throwing", () => {
    const ts = createGraphToolSet();
    ts.graph_create({ name: "cyclic-payload" });
    ts.graph_add_node({
      graph_id: "cyclic-payload",
      id: "gate",
      agent: "agent-a",
      prompt: "decide",
      needs_approval: true,
    });
    const state = liveState(ts, "cyclic-payload");
    const node = state.nodes.get("gate")!;
    node.status = NodeStatus.Blocked;
    const cyclic: Record<string, unknown> = { timestamp: "2026-07-24T10:00:00.000Z" };
    cyclic["self"] = cyclic;
    node.signalsObserved["approval_payload"] = cyclic;

    const [entry] = listPendingApprovals([state]);
    expect(entry?.approvalPayloadSummary).toBe("[unserializable payload]");
    // The real timestamp field is still honored by the blocked-since read.
    expect(entry?.blockedSince).toBe(new Date("2026-07-24T10:00:00.000Z").getTime());
  });
});

// ── B21: sequential filter narrowing ────────────────────────────────────────

describe("filterNodes sequential narrowing (B21)", () => {
  /** Two nodes with distinct status / agent / timing for intersection tests. */
  function fixture(): ReadonlyMap<string, NodeRuntimeState> {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "filters" });
    ts.graph_add_node({ graph_id, id: "alpha", agent: "a1", prompt: "build alpha" });
    ts.graph_add_node({ graph_id, id: "beta", agent: "a2", prompt: "build beta" });
    const state = liveState(ts, graph_id);
    const alpha = state.nodes.get("alpha")!;
    alpha.status = NodeStatus.Completed;
    alpha.startedAt = 100;
    alpha.completedAt = 200;
    const beta = state.nodes.get("beta")!;
    beta.status = NodeStatus.Running;
    beta.startedAt = 150;
    return state.nodes;
  }

  it("AND-combines every supplied filter", () => {
    const nodes = fixture();
    expect(
      filterNodes(nodes, {
        query: "alpha",
        status: NodeStatus.Completed,
        agent: "a1",
      }).map((n) => n.nodeId),
    ).toEqual(["alpha"]);
    // A conflicting combination is an honest empty set, never a fabricated row.
    expect(filterNodes(nodes, { query: "alpha", status: NodeStatus.Running })).toEqual([]);
  });

  it("keeps the exported single-filter helpers equivalent", () => {
    const nodes = fixture();
    expect(filterNodes(nodes, { agent: "a2" }).map((n) => n.nodeId)).toEqual(["beta"]);
    expect(
      filterNodes(nodes, { from_date: new Date(120).toISOString() }).map((n) => n.nodeId),
    ).toEqual(["beta"]);
  });

  it("still throws on an invalid ISO bound even when nothing can match", () => {
    expect(() => filterNodes(new Map(), { from_date: "garbage" })).toThrow(/invalid date/);
  });
});
