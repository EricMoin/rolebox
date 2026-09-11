/**
 * Pending-approvals view tests — subtask 1.
 *
 * Covers the pure `listPendingApprovals` helper (isolated unit tests) and the
 * `graph_status({ pending_approvals: true })` view wired through graph-tools:
 * registry-only (session), persisted-only (persisted), merged (all), honest
 * empty state, approval_payload truncation, and the paste-ready graph_approve
 * call. All data is REAL recorded state — never fabricated rows.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools";
import {
  listPendingApprovals,
  type PendingApprovalEntry,
} from "../../src/graph/tools/status-queries";
import { NodeStatus } from "../../src/constants";
import type { EngineState } from "../../src/types.engine-v2";
import { EnginePersistence } from "../../src/graph/engine/engine-persistence";

const T0 = 1_700_000_000_000;

/** Reach the live EngineState backing a registry graph (test accessor). */
function liveState(ts: ReturnType<typeof createGraphToolSet>, graphId: string): EngineState {
  return (ts as unknown as { getEntry(id: string): { runtime: { state: EngineState } } })
    .getEntry(graphId).runtime.state;
}

/**
 * Build a registry graph with one `needs_approval` node in the `blocked` state.
 * Mirrors graph_create + graph_add_node + direct state mutation (the engine
 * does not run — the node is provisioned then driven blocked by hand).
 */
function buildBlockedGraph(opts: {
  graphId: string;
  nodeId: string;
  agent: string;
  approvalTimestamp?: string;
}): EngineState {
  const ts = createGraphToolSet();
  ts.graph_create({ name: opts.graphId });
  ts.graph_add_node({
    graph_id: opts.graphId,
    id: opts.nodeId,
    agent: opts.agent,
    prompt: "decide",
    needs_approval: true,
  });
  const state = liveState(ts, opts.graphId);
  const node = state.nodes.get(opts.nodeId)!;
  node.status = NodeStatus.Blocked;
  node.startedAt = T0;
  if (opts.approvalTimestamp !== undefined) {
    node.signalsObserved["approval_payload"] = {
      node_id: opts.nodeId,
      node_prompt: "decide",
      timestamp: opts.approvalTimestamp,
      graph_name: opts.graphId,
      phase: "executing",
      total_nodes_completed: 0,
      total_cost_usd: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      upstream_results: [],
    };
  }
  return state;
}

describe("listPendingApprovals (pure helper)", () => {
  it("returns only blocked + needs_approval nodes", () => {
    const state = buildBlockedGraph({
      graphId: "g1",
      nodeId: "gate",
      agent: "agent-p",
      approvalTimestamp: "2026-07-24T10:00:00.000Z",
    });
    // A second graph with a node that is blocked but NOT needs_approval, and one
    // that needs_approval but is not blocked — neither qualifies.
    const blocking = buildBlockedGraph({ graphId: "g2", nodeId: "g2-gate", agent: "a2" });
    blocking.nodes.get("g2-gate")!.needsApproval = false; // blocked, not a gate
    const state3 = buildBlockedGraph({ graphId: "g3", nodeId: "g3-gate", agent: "a3" });
    state3.nodes.get("g3-gate")!.status = NodeStatus.Running; // gate, not blocked

    const entries = listPendingApprovals([state, blocking, state3]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ graphId: "g1", nodeId: "gate", agent: "agent-p" });
  });

  it("derives blocked-since from approval_payload.timestamp when present", () => {
    const state = buildBlockedGraph({
      graphId: "g1",
      nodeId: "gate",
      agent: "agent-p",
      approvalTimestamp: "2026-07-24T10:00:00.000Z",
    });
    const [entry] = listPendingApprovals([state]);
    expect(entry!.blockedSince).toBe(new Date("2026-07-24T10:00:00.000Z").getTime());
  });

  it("falls back to startedAt when no approval_payload stash exists", () => {
    const state = buildBlockedGraph({ graphId: "g1", nodeId: "gate", agent: "agent-p" });
    const [entry] = listPendingApprovals([state]);
    expect(entry!.blockedSince).toBe(T0);
    expect(entry!.approvalPayloadSummary).toBeUndefined();
  });

  it("truncates the approval_payload summary to summaryLimit chars", () => {
    const state = buildBlockedGraph({
      graphId: "g1",
      nodeId: "gate",
      agent: "agent-p",
      approvalTimestamp: "2026-07-24T10:00:00.000Z",
    });
    const [entry] = listPendingApprovals([state], { summaryLimit: 40 });
    expect(entry!.approvalPayloadSummary).toMatch(/…$/);
    expect(entry!.approvalPayloadSummary!.length).toBe(41); // 40 + ellipsis
  });

  it("emits a paste-ready graph_approve call", () => {
    const state = buildBlockedGraph({ graphId: "gx", nodeId: "gy", agent: "a" });
    const [entry] = listPendingApprovals([state]);
    expect(entry!.approveCall).toBe(
      `graph_approve(graph_id="gx", node_id="gy", action="approve")`,
    );
  });

  it("returns an honest empty list for empty input", () => {
    expect(listPendingApprovals([])).toEqual([]);
  });
});

describe("graph_status pending_approvals view (registry scope)", () => {
  it("lists a blocked needs_approval node from the in-memory registry", () => {
    const ts = createGraphToolSet();
    buildBlockedGraphVia(ts, {
      graphId: "wf",
      nodeId: "gate",
      agent: "agent-p",
      approvalTimestamp: "2026-07-24T10:00:00.000Z",
    });

    const out = ts.graph_status({ pending_approvals: true });
    expect(out).toContain("Pending approvals (1)");
    expect(out).toContain("gate  (graph: wf)");
    expect(out).toContain("blocked-since: 2026-07-24T10:00:00.000Z");
    expect(out).toContain(`graph_approve(graph_id="wf", node_id="gate", action="approve")`);
    expect(out).toContain("payload:");
  });

  it("renders an honest empty note when no approvals exist", () => {
    const ts = createGraphToolSet();
    ts.graph_create({ name: "no-gates" });
    ts.graph_add_node({ graph_id: "no-gates", id: "n1", agent: "a", prompt: "p" });
    const out = ts.graph_status({ pending_approvals: true });
    expect(out).toContain("Pending approvals (0)");
    expect(out).toContain("no pending approvals");
  });

  it("narrows to a single graph with graph_id", () => {
    const ts = createGraphToolSet();
    buildBlockedGraphVia(ts, { graphId: "wf-1", nodeId: "g1", agent: "a1" });
    buildBlockedGraphVia(ts, { graphId: "wf-2", nodeId: "g2", agent: "a2" });

    const out = ts.graph_status({ pending_approvals: true, graph_id: "wf-2" });
    expect(out).toContain("Pending approvals (1)");
    expect(out).toContain("g2  (graph: wf-2)");
    expect(out).not.toContain("wf-1");
  });
});

describe("graph_status pending_approvals view (persisted / merged scope)", () => {
  it("lists a blocked node persisted by another session (scope=persisted)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pending-persisted-"));
    try {
      const state = buildBlockedGraph({ graphId: "old-session", nodeId: "gate", agent: "a" });
      new EnginePersistence(dir).save(state);

      const ts = createGraphToolSet({ stateDir: dir });
      const out = ts.graph_status({ pending_approvals: true, scope: "persisted" });
      expect(out).toContain("Pending approvals (1)");
      expect(out).toContain("gate  (graph: old-session)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges registry + persisted with registry-wins dedup (scope=all)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pending-merged-"));
    try {
      const store = new EnginePersistence(dir);
      // Two persisted graphs each with a blocked gate.
      store.save(buildBlockedGraph({ graphId: "persisted-1", nodeId: "pg1", agent: "a1" }));
      store.save(buildBlockedGraph({ graphId: "persisted-2", nodeId: "pg2", agent: "a2" }));

      const ts = createGraphToolSet({ stateDir: dir });
      buildBlockedGraphVia(ts, { graphId: "registry-1", nodeId: "rg1", agent: "a3" });

      const out = ts.graph_status({ pending_approvals: true, scope: "all" });
      expect(out).toContain("Pending approvals (3)");
      expect(out).toContain("rg1  (graph: registry-1)");
      expect(out).toContain("pg1  (graph: persisted-1)");
      expect(out).toContain("pg2  (graph: persisted-2)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits an honest note for an empty persisted store", () => {
    const dir = mkdtempSync(join(tmpdir(), "pending-empty-"));
    try {
      const ts = createGraphToolSet({ stateDir: dir });
      const out = ts.graph_status({ pending_approvals: true, scope: "persisted" });
      expect(out).toContain("No pending approvals");
      expect(out).toContain("No persisted graphs found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders machine-readable JSON with the count and approve call", () => {
    const dir = mkdtempSync(join(tmpdir(), "pending-json-"));
    try {
      const store = new EnginePersistence(dir);
      store.save(
        buildBlockedGraph({
          graphId: "wf",
          nodeId: "gate",
          agent: "agent-p",
          approvalTimestamp: "2026-07-24T10:00:00.000Z",
        }),
      );
      const ts = createGraphToolSet({ stateDir: dir });
      const out = ts.graph_status({
        pending_approvals: true,
        scope: "persisted",
        format: "json",
      });
      const parsed = JSON.parse(out);
      expect(parsed.count).toBe(1);
      expect(parsed.pending_approvals[0]).toMatchObject({
        graph_id: "wf",
        node_id: "gate",
        agent: "agent-p",
        blocked_since: new Date("2026-07-24T10:00:00.000Z").getTime(),
        approve_call: `graph_approve(graph_id="wf", node_id="gate", action="approve")`,
      });
      expect(parsed.pending_approvals[0].approval_payload_summary).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Build a blocked needs_approval node in an EXISTING toolset registry graph
 * (so scope=all sees it alongside persisted graphs).
 */
function buildBlockedGraphVia(
  ts: ReturnType<typeof createGraphToolSet>,
  opts: { graphId: string; nodeId: string; agent: string; approvalTimestamp?: string },
): void {
  ts.graph_create({ name: opts.graphId });
  ts.graph_add_node({
    graph_id: opts.graphId,
    id: opts.nodeId,
    agent: opts.agent,
    prompt: "decide",
    needs_approval: true,
  });
  const state = liveState(ts, opts.graphId);
  const node = state.nodes.get(opts.nodeId)!;
  node.status = NodeStatus.Blocked;
  node.startedAt = T0;
  if (opts.approvalTimestamp !== undefined) {
    node.signalsObserved["approval_payload"] = {
      node_id: opts.nodeId,
      timestamp: opts.approvalTimestamp,
    };
  }
}
