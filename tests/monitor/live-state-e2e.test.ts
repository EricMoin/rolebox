/**
 * End-to-end regression test — TUI live-state fix, subtask 7.
 *
 * Drives a REAL 2-node graph through the **opencode-path toolset** (a
 * `GraphToolSet` constructed WITHOUT `stateDir` — exactly the assembly in
 * `src/core/services/tool-service.ts`, where engine state is never persisted
 * to `.rolebox/state/engine-*.json` and no durable `graph-events-*.ndjson`
 * log is written) and asserts both live-state surfaces:
 *
 * 1. **TUI-side merged snapshot (subtask 6)** — the exact `refresh()` chain
 *    from `src/tui/state.tsx`: `readMonitorSnapshot(dir)` →
 *    `mergeLiveEngineGraphs(snap.engineGraphs, readLiveEngineGraphs(...))` —
 *    shows node A `running` while in-flight and `completed` after
 *    termination, with the graph phase flipping `executing` → `complete`.
 *
 * 2. **Live status overlay (subtask 5)** — the node-scoped live-status map
 *    (`${graphId}::${nodeId}` → status) folded from drained graph events via
 *    `foldGraphSignals` and rendered through the real
 *    `renderEngineGraphActivity` component — updates BETWEEN snapshot ticks:
 *    after node A terminates, the overlay already reads `completed` (and the
 *    rendered frame shows the done glyph) even when rendered against the
 *    still-stale snapshot held from the previous tick.
 *
 * The graph is driven with a scripted dispatch seam that holds each node
 * `running` until the test explicitly completes it (the F2 fixture pattern
 * from `tests/graph/graph-tools.test.ts`). The seam feeds a real
 * `EventBuffer` with the same event vocabulary the platform's durable
 * recorder would have written (`node_dispatched` → `graph_node_start`,
 * `node_completed` → `graph_node_end`), pushed at the same lifecycle points
 * the engine's `GraphEventRecorder` uses (`engine-advance.ts`:
 * `nodeDispatched` at launch, `nodeCompleted` at terminal transition) — the
 * events are therefore derived from the real graph's dispatch lifecycle, not
 * fabricated fixtures.
 */

import { describe, it, expect, afterEach, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import type { TestRendererSetup } from "@opentui/core/testing";
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";

import { GraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import {
  registerLiveGraphToolSet,
  clearLiveGraphToolSet,
} from "../../src/graph/tools/live-state.ts";
import {
  readLiveEngineGraphs,
  mergeLiveEngineGraphs,
} from "../../src/cli/commands/monitor/monitor-reader-engine.ts";
import { readMonitorSnapshot } from "../../src/cli/commands/monitor/monitor-reader.ts";
import { stateDirFor } from "../../src/utils/state-paths.ts";
import type { EngineGraphSnapshot } from "../../src/cli/commands/monitor/monitor-reader-types.ts";
import { EventBuffer, foldGraphSignals } from "../../src/tui/events.ts";
import type { ThemeColors } from "../../src/tui/helpers.ts";
import { G_RUNNING, G_DONE } from "../../src/tui/helpers.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type {
  DispatchParentContext,
} from "../../src/graph/engine/dispatch-bridge.ts";
import type { NodeDispatchPort } from "../../src/graph/engine/engine-advance.ts";
import type { NodeRuntimeState } from "../../src/types.engine-v2.ts";
import type { TaskTerminatedCallback } from "../../src/graph/engine/dispatch-bridge.ts";

// Same transform the TUI build applies (`scripts/build-tui.ts`). Must be
// registered before the `.tsx` Activity module loads — hence the dynamic
// import in `beforeAll`.
Bun.plugin(createSolidTransformPlugin({ moduleName: "@opentui/solid" }));

let renderEngineGraphActivity: (props: {
  c: ThemeColors;
  graph: EngineGraphSnapshot;
  nodeSignals?: ReadonlyMap<string, string>;
}) => unknown;

beforeAll(async () => {
  const mod = await import("../../src/tui/components/Activity");
  renderEngineGraphActivity = mod.renderEngineGraphActivity;
});

// ── Scripted dispatch seam ────────────────────────────────────────────────

/**
 * Dispatch seam that holds every node `running` until the test explicitly
 * calls {@link complete}. Mirrors the F2 fixture (`tests/graph/
 * graph-tools.test.ts`): `executeNode` resolves immediately with a
 * `running` task, so the engine stays in phase `executing` with the node
 * `running` while the task is genuinely unresolved.
 *
 * On each dispatch the seam pushes a `graph_node_start` (running) event into
 * the shared {@link EventBuffer}; on {@link complete} it fires the engine's
 * `onTaskTerminated` listener (which advances the graph), waits for the live
 * projection to confirm the node actually transitioned, then pushes the
 * `graph_node_end` event — the same ordering the durable recorder chain
 * (`GraphEventRecorder` → `GraphEventPoll`) produces on stateDir platforms.
 */
class ScriptedDispatch implements NodeDispatchPort {
  /** Node ids dispatched, in order — the test's dispatch-sequence oracle. */
  readonly calls: string[] = [];
  private readonly tasks = new Map<string, DispatchTask>();
  private readonly subs = new Map<string, TaskTerminatedCallback>();
  private seq = 0;

  constructor(private readonly buffer: EventBuffer) {}

  executeNode(
    node: NodeRuntimeState,
    ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push(node.nodeId);
    const id = `task-${node.nodeId}-${++this.seq}`;
    const task: DispatchTask = {
      id,
      sessionId: `sess-${id}`,
      parentSessionId: ctx.sessionID,
      depth: 1,
      status: "running",
      agent: node.agent,
      prompt: node.prompt,
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
    };
    this.tasks.set(id, task);
    // graphParentContext sets sessionID = graphId — the graph scope marker.
    this.buffer.push({
      type: "graph_node_start",
      graphId: ctx.sessionID,
      nodeId: node.nodeId,
      agent: node.agent,
      status: "running",
      ts: new Date().toISOString(),
    });
    return Promise.resolve(task);
  }

  onTaskTerminated(
    taskId: string,
    cb: TaskTerminatedCallback,
  ): TaskTerminatedCallback {
    this.subs.set(taskId, cb);
    return cb;
  }

  getTask(taskId: string): DispatchTask | undefined {
    return this.tasks.get(taskId);
  }

  /** The task id for a node (last dispatch wins — one dispatch per node here). */
  private taskIdFor(nodeId: string): string | undefined {
    let found: string | undefined;
    for (const id of this.tasks.keys()) {
      if (id.startsWith(`task-${nodeId}-`)) found = id;
    }
    return found;
  }

  /**
   * Terminate the node's task: fire the engine's `onTaskTerminated` listener
   * (driving the graph advance), await the engine transition, then emit the
   * terminal graph event into the buffer.
   */
  async complete(
    nodeId: string,
    graphId: string,
    waitForNode: (nodeId: string, status: string) => Promise<void>,
  ): Promise<void> {
    const id = this.taskIdFor(nodeId);
    if (!id) throw new Error(`complete(): no dispatched task for node ${nodeId}`);
    const task = this.tasks.get(id)!;
    task.status = "completed";
    this.subs.get(id)?.(id, "completed");
    // The engine processes the termination asynchronously (fire-and-forget
    // signal advance). Wait for the authoritative transition before emitting
    // the terminal event, mirroring when the durable recorder writes its
    // `node_completed` line.
    await waitForNode(nodeId, "completed");
    this.buffer.push({
      type: "graph_node_end",
      graphId,
      nodeId,
      agent: task.agent,
      status: "completed",
      signalType: "answer",
      ts: new Date().toISOString(),
    });
  }
}

// ── Polling helpers ───────────────────────────────────────────────────────

async function waitFor(
  cond: () => boolean,
  what: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── Render harness (same headless renderer as tests/tui/activity-live-status) ──

const c: ThemeColors = {
  info:      RGBA.fromValues(80, 160, 255, 1),
  success:   RGBA.fromValues(80, 200, 120, 1),
  warning:   RGBA.fromValues(255, 200, 80, 1),
  error:     RGBA.fromValues(255, 80, 80, 1),
  secondary: RGBA.fromValues(180, 180, 200, 1),
  textMuted: RGBA.fromValues(140, 140, 160, 1),
  text:      RGBA.fromValues(220, 220, 230, 1),
};

let setup: TestRendererSetup | undefined;

async function renderWith(
  graph: EngineGraphSnapshot,
  nodeSignals?: ReadonlyMap<string, string>,
): Promise<string> {
  setup = await testRender(
    () => renderEngineGraphActivity({ c, graph, nodeSignals }),
    { width: 60, height: 12 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

// ── The end-to-end scenario ───────────────────────────────────────────────

describe("TUI live-state end-to-end (subtask 7)", () => {
  let wsDir: string;
  let buffer: EventBuffer;
  let dispatch: ScriptedDispatch;
  let ts: GraphToolSet;
  let graphId: string;

  afterEach(async () => {
    clearLiveGraphToolSet();
    if (setup) {
      // Detach the headless renderer so later tests start from a clean frame.
      (setup.renderer as unknown as { destroy?: () => void }).destroy?.();
      setup = undefined;
    }
    if (wsDir) rmSync(wsDir, { recursive: true, force: true });
  });

  /**
   * The exact refresh() merge chain from `src/tui/state.tsx` (subtask 6):
   * disk snapshot overlaid with the live in-memory graph registry.
   */
  function refreshChain(): EngineGraphSnapshot[] {
    const snap = readMonitorSnapshot(wsDir);
    return mergeLiveEngineGraphs(
      snap.engineGraphs,
      readLiveEngineGraphs(stateDirFor(wsDir)),
    );
  }

  /** Status of a node in the live registry projection (authoritative engine view). */
  function liveNodeStatus(nodeId: string): string | undefined {
    const graphs = readLiveEngineGraphs(stateDirFor(wsDir));
    const g = graphs.find((x) => x.graphId === graphId);
    return g?.nodes.find((n) => n.nodeId === nodeId)?.status;
  }

  async function openAndRun(): Promise<void> {
    wsDir = mkdtempSync(join(tmpdir(), "tui-live-e2e-"));
    buffer = new EventBuffer();
    dispatch = new ScriptedDispatch(buffer);
    // The opencode-path toolset: NO stateDir — engine state is fully
    // in-memory, exactly like `src/core/services/tool-service.ts`.
    ts = new GraphToolSet({
      dispatch,
      // Opt out of the staleness watcher / sweeper — no background timers.
      nodeStaleTimeoutMs: 0,
      sweeperIntervalMs: 0,
    });
    // Monitor S10: the platform assembly registers the single toolset as the
    // process's live graph-registry source.
    registerLiveGraphToolSet(ts);

    // A 2-node chain: B only dispatches after A emits its answer signal.
    const created = ts.graph_create({ name: "e2e-live" });
    graphId = created.graph_id;
    ts.graph_add_node({ graph_id: graphId, id: "A", agent: "agent-a", prompt: "pA" });
    ts.graph_add_node({ graph_id: graphId, id: "B", agent: "agent-b", prompt: "pB" });
    ts.graph_add_edge({
      graph_id: graphId,
      from: "A",
      to: "B",
      type: "on_signal",
      signal_filter: ["answer"],
    });

    const run = await ts.graph_run({ graph_id: graphId });
    expect(run.phase).toBe("executing");
    expect(run.active_nodes).toContain("A");
    // B is downstream — pending until A terminates.
    expect(run.pending_nodes).toContain("B");
    // The initial dispatch pass is synchronous through executeNode.
    expect(dispatch.calls).toEqual(["A"]);
  }

  it("merged snapshot flips running → completed while the overlay updates between ticks", async () => {
    await openAndRun();

    // ── Snapshot tick 1: node A in-flight ────────────────────────────────
    const merged1 = refreshChain();
    expect(merged1).toHaveLength(1);
    expect(merged1[0].graphId).toBe(graphId);
    expect(merged1[0].phase).toBe("executing");
    expect(merged1[0].nodeStatusCounts.running).toBe(1);
    const a1 = merged1[0].nodes.find((n) => n.nodeId === "A")!;
    expect(a1.status).toBe("running");
    expect(a1.startedAt).toBeDefined();
    const b1 = merged1[0].nodes.find((n) => n.nodeId === "B")!;
    expect(b1.status).toBe("pending");

    // Overlay at tick 1: the drained graph_node_start folds A → running.
    let folded = foldGraphSignals(buffer.drain(), new Map(), new Map());
    expect(folded.nodeSignals.get(`${graphId}::A`)).toBe("running");

    // Rendered frame at tick 1: the running glyph, no done glyph.
    const frame1 = await renderWith(merged1[0], folded.nodeSignals);
    expect(frame1).toContain(G_RUNNING + " agent-a");
    expect(frame1).not.toContain(G_DONE + " agent-a");

    // ── Between ticks: A terminates, B dispatches ─────────────────────────
    // The 250ms event feed already knows A is done while the TUI still holds
    // tick-1's merged snapshot (the 1s disk/live poll has not run again).
    await dispatch.complete("A", graphId, async (nodeId, status) => {
      await waitFor(
        () => liveNodeStatus(nodeId) === status,
        `node ${nodeId} to reach ${status}`,
      );
    });
    // A's completion advanced the graph — B is now dispatched and running.
    await waitFor(() => dispatch.calls.includes("B"), "B to be dispatched");
    await waitFor(
      () => liveNodeStatus("B") === "running",
      "node B to reach running",
    );

    // The live registry confirms the in-between state.
    const mergedMid = refreshChain();
    expect(mergedMid[0].nodes.find((n) => n.nodeId === "A")!.status).toBe(
      "completed",
    );
    expect(mergedMid[0].nodes.find((n) => n.nodeId === "B")!.status).toBe(
      "running",
    );

    // ── Overlay updates between snapshot ticks ────────────────────────────
    // Fold the new events (A ended, B started) over tick-1's held snapshot:
    // the overlay must already read completed for A — even though the merged
    // snapshot passed to the renderer is still the stale tick-1 projection.
    folded = foldGraphSignals(
      buffer.drain(),
      folded.graphSignals,
      folded.nodeSignals,
    );
    expect(folded.nodeSignals.get(`${graphId}::A`)).toBe("completed");
    expect(folded.nodeSignals.get(`${graphId}::B`)).toBe("running");

    const frameMid = await renderWith(merged1[0], folded.nodeSignals);
    // The overlay beats the stale snapshot: A shows the done glyph even
    // though merged1 still projected A as running.
    expect(frameMid).toContain(G_DONE + " agent-a");
    expect(frameMid).not.toContain(G_RUNNING + " agent-a");
    // B's freshly-started node shows the running glyph from the overlay.
    expect(frameMid).toContain(G_RUNNING + " agent-b");

    // ── Snapshot tick 2: full termination ─────────────────────────────────
    await dispatch.complete("B", graphId, async (nodeId, status) => {
      await waitFor(
        () => liveNodeStatus(nodeId) === status,
        `node ${nodeId} to reach ${status}`,
      );
    });
    await waitFor(
      () => refreshChain()[0]?.phase === "complete",
      "graph phase to reach complete",
    );

    const merged2 = refreshChain();
    expect(merged2[0].phase).toBe("complete");
    expect(merged2[0].nodeStatusCounts.completed).toBe(2);
    expect(
      merged2[0].nodes.every((n) => n.status === "completed"),
    ).toBe(true);

    // Overlay at tick 2: both nodes terminal.
    folded = foldGraphSignals(
      buffer.drain(),
      folded.graphSignals,
      folded.nodeSignals,
    );
    expect(folded.nodeSignals.get(`${graphId}::A`)).toBe("completed");
    expect(folded.nodeSignals.get(`${graphId}::B`)).toBe("completed");

    const frame2 = await renderWith(merged2[0], folded.nodeSignals);
    expect(frame2).toContain(G_DONE + " agent-a");
    expect(frame2).toContain(G_DONE + " agent-b");
    expect(frame2).not.toContain(G_RUNNING + " agent-");
  });
});
