/**
 * Graph Execution Engine v2 — Monitor fix subtask S9 (graph-tools observability)
 *
 * Verifies the four monitor fixes landed in `src/graph/tools/graph-tools.ts`:
 *
 *   M8/M9 — `renderNode` gains a `format="json"` branch returning a parseable
 *           node summary; `nodeSummary` (and therefore the graph JSON) gains an
 *           `output` field carrying the node's materialized result text, only
 *           when `include_output` is set. All JSON outputs flow through
 *           `paginate`, so max_chars/offset/tail apply with a truncation marker.
 *   L1    — the JSON progress field is named `last_signal_at` (the node's last
 *           signal time of ANY type), not `progress_last_signal_at`.
 *   L2    — an invalid `since` THROWS (aligned with from_date/to_date) instead
 *           of silently broadening the stream.
 *   L3    — `paginate` appends a "…[truncated: N more chars]" marker whenever
 *           truncation drops content.
 *   M4    — `commit` and the `graph_run` rebuild path dispose the PRIOR runtime
 *           before replacing the registry entry, so orphaned onTaskTerminated
 *           dispatch listeners are unregistered.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createGraphToolSet,
  GraphToolSet,
} from "../../src/graph/tools/graph-tools.ts";
import type { EngineState, NodeRuntimeState } from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type {
  DispatchParentContext,
  TaskTerminatedCallback,
} from "../../src/graph/engine/dispatch-bridge.ts";
import type { NodeDispatchPort } from "../../src/graph/engine/engine-advance.ts";
import type { GraphToolSetDeps } from "../../src/graph/tools/graph-tools.ts";

// ── Fake dispatch that auto-completes dispatched tasks ──────────────────────

class CompletingDispatch implements NodeDispatchPort {
  calls: string[] = [];
  private subs = new Map<string, TaskTerminatedCallback>();
  private tasks = new Map<string, DispatchTask>();
  private seq = 0;

  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push(node.nodeId);
    const id = `task-${node.nodeId}-${++this.seq}`;
    const task: DispatchTask = {
      id,
      sessionId: `sess-${id}`,
      parentSessionId: "g",
      depth: 1,
      status: "running",
      agent: node.agent,
      prompt: node.prompt,
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
    };
    this.tasks.set(id, task);
    setTimeout(() => {
      task.status = "completed";
      this.subs.get(id)?.(id, "completed");
    }, 0);
    return Promise.resolve(task);
  }

  onTaskTerminated(taskId: string, cb: TaskTerminatedCallback): TaskTerminatedCallback {
    this.subs.set(taskId, cb);
    return cb;
  }

  getTask(taskId: string): DispatchTask | undefined {
    return this.tasks.get(taskId);
  }
}

const settle = () => new Promise((r) => setTimeout(r, 25));

function makeToolset(): { ts: GraphToolSet; fake: CompletingDispatch } {
  const fake = new CompletingDispatch();
  const deps: GraphToolSetDeps = { dispatch: fake };
  return { ts: new GraphToolSet(deps), fake };
}

/** Live EngineState of a graph's current registry runtime. */
function liveState(ts: GraphToolSet, graphId: string): EngineState {
  const entry = ts["getEntry"](graphId);
  return (entry.runtime as unknown as { state: EngineState }).state;
}

/** Stamp a materialized result (real sidecar file) onto a node. */
function stampResult(state: EngineState, nodeId: string, text: string): void {
  const dir = mkdtempSync(join(tmpdir(), "graph-tools-s9-"));
  const sidecar = join(dir, `${nodeId}-result.txt`);
  writeFileSync(sidecar, text, "utf8");
  const node = state.nodes.get(nodeId)!;
  node.result = {
    sidecarPath: sidecar,
    totalChars: text.length,
    hadFence: false,
    materializedAt: Date.now(),
  };
}

// ── M8/M9: renderNode json + include_output ─────────────────────────────────

describe("renderNode format=json (monitor M8/M9)", () => {
  it("returns a parseable JSON node summary; include_output adds the result text", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "s9-node-json" });
    ts.graph_add_node({ graph_id, id: "A", agent: "agent-a", prompt: "pA" });
    stampResult(liveState(ts, graph_id), "A", "materialized result of A");

    // Default: parseable JSON node summary WITHOUT an output field.
    const parsed = JSON.parse(
      ts.graph_status({ graph_id, node_id: "A", format: "json" }),
    ) as Record<string, unknown>;
    expect(parsed.node_id).toBe("A");
    expect(parsed.agent).toBe("agent-a");
    expect(parsed.output).toBeUndefined();

    // include_output → the node's materialized result text rides as `output`.
    const withOut = JSON.parse(
      ts.graph_status({ graph_id, node_id: "A", format: "json", include_output: true }),
    ) as Record<string, unknown>;
    expect(withOut.output).toBe("materialized result of A");
  });

  it("graph JSON adds an output field per node only when include_output is set", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "s9-graph-json" });
    ts.graph_add_node({ graph_id, id: "A", agent: "agent-a", prompt: "pA" });
    ts.graph_add_node({ graph_id, id: "B", agent: "agent-b", prompt: "pB" });
    // Only A has a materialized result — B must stay output-less.
    stampResult(liveState(ts, graph_id), "A", "result-A");

    const plain = JSON.parse(
      ts.graph_status({ graph_id, format: "json" }),
    ) as { nodes: Array<Record<string, unknown>> };
    expect(plain.nodes.find((n) => n.node_id === "A")).not.toHaveProperty("output");

    const withOut = JSON.parse(
      ts.graph_status({ graph_id, format: "json", include_output: true }),
    ) as { nodes: Array<Record<string, unknown>> };
    expect(withOut.nodes.find((n) => n.node_id === "A")!.output).toBe("result-A");
    expect(withOut.nodes.find((n) => n.node_id === "B")).not.toHaveProperty("output");
  });

  it("include_progress surfaces last_signal_at (L1 rename, not progress_last_signal_at)", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "s9-progress-rename" });
    ts.graph_add_node({ graph_id, id: "A", agent: "agent-a", prompt: "pA" });
    const state = liveState(ts, graph_id);
    state.nodes.get("A")!.signalsObserved["progress"] = { stage: "writing" };
    state.signalLedger.set("A", {
      signals: { progress: { stage: "writing" } },
      lastSignalAt: 5000,
      history: [],
    });

    const parsed = JSON.parse(
      ts.graph_status({ graph_id, node_id: "A", format: "json", include_progress: true }),
    ) as Record<string, unknown>;
    expect(parsed.progress).toEqual({ stage: "writing" });
    expect(parsed.last_signal_at).toBe(5000);
    expect(parsed).not.toHaveProperty("progress_last_signal_at");
  });
});

// ── L2: invalid since throws ─────────────────────────────────────────────────

describe("graph_status since bound (monitor L2)", () => {
  function open(): { ts: GraphToolSet; graph_id: string } {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "s9-since" });
    ts.graph_add_node({ graph_id, id: "A", agent: "agent-a", prompt: "pA" });
    return { ts, graph_id };
  }

  it("an invalid since throws (text path), aligned with from_date/to_date", () => {
    const { ts, graph_id } = open();
    expect(() =>
      ts.graph_status({ graph_id, node_id: "A", stream: true, since: "not-a-date" }),
    ).toThrow(/invalid date "not-a-date"/);
  });

  it("an invalid since throws in the JSON stream path too", () => {
    const { ts, graph_id } = open();
    expect(() =>
      ts.graph_status({ graph_id, format: "json", stream: true, since: "garbage" }),
    ).toThrow(/invalid date "garbage"/);
  });

  it("a valid since still filters (no throw)", () => {
    const { ts, graph_id } = open();
    const out = ts.graph_status({
      graph_id,
      node_id: "A",
      stream: true,
      since: new Date(0).toISOString(),
    });
    expect(out).toContain("Signal Stream");
  });
});

// ── L3: paginate truncation marker ──────────────────────────────────────────

describe("paginate truncation marker (monitor L3)", () => {
  it("summary text truncation appends the marker with the exact dropped count", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "s9-page" });
    for (let i = 0; i < 8; i++) {
      ts.graph_add_node({ graph_id, id: `n${i}`, agent: "agent-a", prompt: `p${i}` });
    }
    const full = ts.graph_status({ graph_id });
    const out = ts.graph_status({ graph_id, max_chars: 25 });
    const m = out.match(/…\[truncated: (\d+) more chars\]$/);
    expect(m).not.toBeNull();
    const dropped = Number(m![1]);
    // The untruncated body is exactly max_chars; dropped = full length − body.
    expect(out.replace(/\n…\[truncated: \d+ more chars\]$/, "").length).toBe(25);
    expect(dropped).toBe(full.length - 25);
    expect(full).not.toContain("…[truncated:");
  });

  it("JSON output is paginated too (max_chars applies, marker present when cut)", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "s9-page-json" });
    for (let i = 0; i < 8; i++) {
      ts.graph_add_node({ graph_id, id: `n${i}`, agent: "agent-a", prompt: `p${i}` });
    }
    const jsonOut = ts.graph_status({ graph_id, format: "json", max_chars: 40 });
    expect(jsonOut).toMatch(/…\[truncated: \d+ more chars\]$/);
  });

  it("tail truncation keeps the last max_chars and marks the dropped head", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "s9-tail" });
    for (let i = 0; i < 8; i++) {
      ts.graph_add_node({ graph_id, id: `n${i}`, agent: "agent-a", prompt: `p${i}` });
    }
    const out = ts.graph_status({ graph_id, max_chars: 25, tail: true });
    expect(out).toMatch(/…\[truncated: \d+ more chars\]$/);
    expect(out.replace(/\n…\[truncated: \d+ more chars\]$/, "").length).toBe(25);
  });
});

// ── M4: prior runtime dispose before rebuild ────────────────────────────────

describe("prior runtime dispose on rebuild (monitor M4)", () => {
  it("commit (construction tool) disposes the prior runtime before replacing it", async () => {
    const { ts } = makeToolset();
    const g = ts.graph_create({ name: "s9-dispose-commit" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });
    await ts.graph_run({ graph_id: g.graph_id });
    await settle();

    // Instrument the live runtime's dispose: it must run WHILE the registry
    // still points at the old runtime (i.e. before the replacement).
    const entry = ts["getEntry"](g.graph_id);
    const oldRuntime = entry.runtime;
    let disposed = 0;
    let disposedBeforeReplace = false;
    const original = oldRuntime.dispose.bind(oldRuntime);
    oldRuntime.dispose = () => {
      disposed++;
      disposedBeforeReplace = ts["getEntry"](g.graph_id).runtime === oldRuntime;
      original();
    };

    // A post-run construction tool triggers commit → rebuild → prior dispose.
    ts.graph_add_node({ graph_id: g.graph_id, id: "B", agent: "b", prompt: "pB" });

    expect(disposed).toBe(1);
    expect(disposedBeforeReplace).toBe(true);
    // The registry now holds the rebuilt engine, not the disposed one.
    expect(ts["getEntry"](g.graph_id).runtime).not.toBe(oldRuntime);
  });

  it("graph_run rebuild path disposes the prior runtime before replacing it", async () => {
    const { ts, fake } = makeToolset();
    const g = ts.graph_create({ name: "s9-dispose-rerun" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });
    await ts.graph_run({ graph_id: g.graph_id });
    await settle();
    expect(fake.calls).toContain("A");

    const entry = ts["getEntry"](g.graph_id);
    const oldRuntime = entry.runtime;
    let disposed = 0;
    let disposedBeforeReplace = false;
    const original = oldRuntime.dispose.bind(oldRuntime);
    oldRuntime.dispose = () => {
      disposed++;
      disposedBeforeReplace = ts["getEntry"](g.graph_id).runtime === oldRuntime;
      original();
    };

    // Targeted retry is exempt from the in-flight guard + completed short-circuit,
    // so it exercises the rebuild path in graph_run.
    await ts.graph_run({
      graph_id: g.graph_id,
      node_id: "A",
      retry: true,
      modify_prompt: "REVISION",
    });
    await settle();

    expect(disposed).toBe(1);
    expect(disposedBeforeReplace).toBe(true);
    expect(ts["getEntry"](g.graph_id).runtime).not.toBe(oldRuntime);
    expect(fake.calls.filter((c) => c === "A").length).toBe(2); // re-dispatched
  });

  it("dispose is idempotent — a repeated rebuild still only disposes the live runtime", async () => {
    const { ts } = makeToolset();
    const g = ts.graph_create({ name: "s9-dispose-once" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });
    await ts.graph_run({ graph_id: g.graph_id });
    await settle();

    // Two consecutive rebuilds each dispose the runtime that was live at that
    // moment — the second rebuild disposes the FIRST rebuilt engine (which the
    // first rebuild left in the registry), never a stale/disposed one twice.
    let disposedOf: unknown[] = [];
    const entry1 = ts["getEntry"](g.graph_id);
    const original1 = entry1.runtime.dispose.bind(entry1.runtime);
    entry1.runtime.dispose = () => {
      disposedOf.push(entry1.runtime);
      original1();
    };
    ts.graph_add_node({ graph_id: g.graph_id, id: "B", agent: "b", prompt: "pB" });

    const entry2 = ts["getEntry"](g.graph_id);
    const original2 = entry2.runtime.dispose.bind(entry2.runtime);
    entry2.runtime.dispose = () => {
      disposedOf.push(entry2.runtime);
      original2();
    };
    ts.graph_add_node({ graph_id: g.graph_id, id: "C", agent: "c", prompt: "pC" });

    expect(disposedOf).toHaveLength(2);
    expect(disposedOf[0]).toBe(entry1.runtime);
    expect(disposedOf[1]).toBe(entry2.runtime);
  });
});
