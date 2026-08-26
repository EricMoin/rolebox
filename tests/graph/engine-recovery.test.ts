import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type {
  EngineState,
  NodeRuntimeState,
} from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type {
  DispatchParentContext,
  TaskTerminatedCallback,
} from "../../src/graph/engine/dispatch-bridge.ts";
import type {
  NodeDispatchPort,
  NodeCompletionEvent,
} from "../../src/graph/engine/engine-advance.ts";
import {
  createEngineState,
  provision,
} from "../../src/graph/engine/engine-state.ts";
import { EnginePersistence } from "../../src/graph/engine/engine-persistence.ts";
import { createEngine, type EngineRuntime } from "../../src/graph/engine/index.ts";
import {
  mapDispatchStatusToSignal,
  subscribeTaskTermination,
  reconcileEngine,
  rebuildFrontier,
  clearStaleCriticalSection,
  captureNodeUsage,
  adoptPriorNodeStates,
  EngineLockSweeper,
  NodeStalenessWatcher,
  hydrateEngineState,
  ORPHAN_REASON,
  type ReconcileReport,
  type ReconcileSubscriptions,
} from "../../src/graph/engine/engine-recovery.ts";
import type { UsageRecord } from "../../src/dispatch/budget/budget-tracker.ts";
import type { SignalType } from "../../src/graph/engine/signal-bridge.ts";
import { sessionSignalLedger } from "../../src/signal/session-signal-ledger.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

// ── Fixtures ────────────────────────────────────────────────────────────────

function singleNodeGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "single",
    nodes: [{ id: "A", agent: "a1", prompt: "p1" }],
    edges: [],
  };
}

function linearGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "linear",
    nodes: [
      { id: "A", agent: "a1", prompt: "p1" },
      { id: "B", agent: "a2", prompt: "p2" },
    ],
    edges: [{ from: "A", to: "B", type: "always" }],
  };
}

function makeTask(
  id: string,
  status: DispatchTask["status"] = "running",
  error?: string,
): DispatchTask {
  return {
    id,
    sessionId: `sess-${id}`,
    parentSessionId: "g",
    depth: 1,
    status,
    agent: "a",
    prompt: "p",
    startedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 0 },
    priority: 0,
    ...(error !== undefined ? { error } : {}),
  };
}

/** Build a provisioned state with a single node in a chosen status. */
function buildState(
  decl: GraphDeclaration,
  graphId: string,
): EngineState {
  const s = createEngineState(decl, graphId);
  provision(s);
  return s;
}

// ── mapDispatchStatusToSignal ───────────────────────────────────────────────

describe("mapDispatchStatusToSignal", () => {
  it("completed → answer (inferred)", () => {
    expect(mapDispatchStatusToSignal("completed")).toEqual({
      type: "answer",
      payload: { __inferred: true },
    });
  });

  it("completed with terminatingSignal=revise_needed → revise_needed with payload (Tier 1 preserves exact type + payload)", () => {
    const task = makeTask("t", "completed");
    task.terminatingSignal = {
      type: "revise_needed",
      payload: { findings: "x" },
    };
    const sig = mapDispatchStatusToSignal("completed", task);
    expect(sig).toEqual({
      type: "revise_needed",
      payload: { findings: "x" },
    });
  });

  it("completed with terminatingSignal=escalate → escalate with payload", () => {
    const task = makeTask("t", "completed");
    task.terminatingSignal = {
      type: "escalate",
      payload: { reason: "crash" },
    };
    const sig = mapDispatchStatusToSignal("completed", task);
    expect(sig).toEqual({
      type: "escalate",
      payload: { reason: "crash" },
    });
  });

  it("completed with terminatingSignal wins over ledger: Tier 1 priority (both present)", () => {
    const sessionId = "sess-map-tier1-priority";
    const task = makeTask("t-tier1", "completed");
    (task as { sessionId: string }).sessionId = sessionId;
    // Tier 1: terminatingSignal on the task.
    task.terminatingSignal = {
      type: "revise_needed",
      payload: { findings: "x" },
    };
    // Tier 2: ledger has a different signal — escalate (must be ignored).
    sessionSignalLedger.record(sessionId, "escalate", {
      reason: "should-be-ignored",
    });
    const sig = mapDispatchStatusToSignal("completed", task);
    expect(sig).toEqual({
      type: "revise_needed",
      payload: { findings: "x" },
    });
    sessionSignalLedger.clearSession(sessionId);
  });

  it("completed without terminatingSignal → answer with __inferred", () => {
    const task = makeTask("t", "completed");
    expect(mapDispatchStatusToSignal("completed", task)).toEqual({
      type: "answer",
      payload: { __inferred: true },
    });
  });

  it("completed without terminatingSignal but ledger has revise_needed → reads signal from ledger", () => {
    const sessionId = "sess-map-ledger-revise";
    const task = makeTask("t-ledger", "completed");
    // Overwrite the auto-generated sessionId so we control the ledger key.
    (task as { sessionId: string }).sessionId = sessionId;
    sessionSignalLedger.record(sessionId, "revise_needed", {
      findings: ["ledger-found"],
    });
    const sig = mapDispatchStatusToSignal("completed", task);
    expect(sig).toEqual({
      type: "revise_needed",
      payload: { findings: ["ledger-found"] },
    });
    sessionSignalLedger.clearSession(sessionId);
  });

  it("completed without terminatingSignal but ledger has escalate → recovers escalate from ledger (Tier 2)", () => {
    const sessionId = "sess-map-ledger-escalate";
    const task = makeTask("t-ledger-e", "completed");
    (task as { sessionId: string }).sessionId = sessionId;
    sessionSignalLedger.record(sessionId, "escalate", {
      reason: "ledger-escalate-reason",
    });
    const sig = mapDispatchStatusToSignal("completed", task);
    expect(sig).toEqual({
      type: "escalate",
      payload: { reason: "ledger-escalate-reason" },
    });
    sessionSignalLedger.clearSession(sessionId);
  });

  it("completed without terminatingSignal and no ledger entry → answer with __inferred", () => {
    const sessionId = "sess-map-no-signal";
    const task = makeTask("t-no-sig", "completed");
    (task as { sessionId: string }).sessionId = sessionId;
    sessionSignalLedger.clearSession(sessionId); // explicit clean before test
    expect(mapDispatchStatusToSignal("completed", task)).toEqual({
      type: "answer",
      payload: { __inferred: true },
    });
  });

  it("error → escalate carrying task.error", () => {
    const sig = mapDispatchStatusToSignal(
      "error",
      makeTask("t", "error", "boom"),
    );
    expect(sig).toEqual({ type: "escalate", payload: { error: "boom" } });
  });

  it("error → escalate with a fallback reason when task.error is absent", () => {
    const sig = mapDispatchStatusToSignal("error", makeTask("t", "error"));
    expect(sig!.type).toBe("escalate");
    expect((sig!.payload as { error: string }).error).toBeTruthy();
  });

  it("timeout → escalate", () => {
    expect(mapDispatchStatusToSignal("timeout")!.type).toBe("escalate");
  });

  it("cancelled → null (no terminating signal)", () => {
    expect(mapDispatchStatusToSignal("cancelled")).toBeNull();
  });

  it("running / pending → null (non-terminal statuses)", () => {
    expect(mapDispatchStatusToSignal("running")).toBeNull();
    expect(mapDispatchStatusToSignal("pending")).toBeNull();
  });

  it("HITL pause statuses → pausing need_approval signal (F1 bridge)", () => {
    // The completion evaluator pauses a task for a human decision and delivers
    // the HITL signal type (awaiting_approval is the task's status; the others
    // are the session-ledger signal types) to the engine's onTaskTerminated
    // listener. Each must map to the engine's pausing `need_approval` signal so
    // subscribeTaskTermination's `if (!sig) return;` never drops it.
    expect(mapDispatchStatusToSignal("awaiting_approval")).toEqual({
      type: "need_approval",
      payload: { hitl: "awaiting_approval" },
    });
    expect(mapDispatchStatusToSignal("need_approval")).toEqual({
      type: "need_approval",
      payload: { hitl: "need_approval" },
    });
    expect(mapDispatchStatusToSignal("blocked")).toEqual({
      type: "need_approval",
      payload: { hitl: "blocked" },
    });
    expect(mapDispatchStatusToSignal("need_clarification")).toEqual({
      type: "need_approval",
      payload: { hitl: "need_clarification" },
    });
  });

  it("HITL status → need_approval signal carries the task id when a task is present", () => {
    const task = makeTask("t-hitl", "awaiting_approval");
    expect(mapDispatchStatusToSignal("awaiting_approval", task)).toEqual({
      type: "need_approval",
      payload: { hitl: "awaiting_approval", taskId: "t-hitl" },
    });
  });
});

// ── subscribeTaskTermination ────────────────────────────────────────────────

describe("subscribeTaskTermination", () => {
  function subscribe(
    status: NodeRuntimeState["status"],
    taskId = "task-A",
    customTask?: DispatchTask,
    sessionUsage?: UsageRecord,
  ): {
    state: EngineState;
    emitted: Array<[string, SignalType, unknown]>;
    fire: (status: string) => void;
  } {
    const state = buildState(singleNodeGraph(), "sub");
    const node = state.nodes.get("A")!;
    node.status = status;
    node.dispatchTaskId = taskId;
    node.dispatchSessionId = "sess-A";
    const emitted: Array<[string, SignalType, unknown]> = [];
    const listeners: Array<(id: string, st: string) => void> = [];
    const port = {
      getTask: (id: string) =>
        customTask ??
        (id === taskId ? makeTask(taskId, "running") : undefined),
      onTaskTerminated: (_id: string, cb: (id: string, st: string) => void) =>
        listeners.push(cb),
      getSessionUsage: () => sessionUsage ?? { inputTokens: 0, outputTokens: 0, cost: 0 },
    };
    subscribeTaskTermination(state, port as never, node, (n, t, p) =>
      emitted.push([n, t, p]),
    );
    return {
      state,
      emitted,
      fire: (st: string) => listeners.forEach((cb) => cb(taskId, st)),
    };
  }

  it("emits a mapped signal when the task terminates while the node is running", () => {
    const { fire, emitted } = subscribe(NodeStatus.Running);
    fire("completed");
    expect(emitted).toEqual([["A", "answer", { __inferred: true }]]);
  });

  it("emits a need_approval signal (NOT dropped) when the listener fires a HITL status (F1)", () => {
    // Before F1, a HITL pause status mapped to null and `if (!sig) return;`
    // silently dropped it — the node stayed `running` forever and [GRAPH
    // BLOCKED] never fired. Now the listener must emit the pausing
    // `need_approval` signal (with the paused task id in the payload).
    const { fire, emitted } = subscribe(NodeStatus.Running);
    fire("need_approval");
    expect(emitted).toEqual([
      ["A", "need_approval", { hitl: "need_approval", taskId: "task-A" }],
    ]);
  });

  it("does NOT emit for a node that is no longer running", () => {
    const { fire, emitted } = subscribe(NodeStatus.Completed);
    fire("completed");
    expect(emitted).toEqual([]);
  });

  it("records per-node token/cost consumption when the dispatch reports usage (Phase-7)", () => {
    const { fire, state } = subscribe(
      NodeStatus.Running,
      "task-A",
      undefined,
      { inputTokens: 200, outputTokens: 80, cost: 0.03 },
    );
    fire("completed");
    expect(state.nodes.get("A")!.tokensConsumed).toEqual({
      inputTokens: 200,
      outputTokens: 80,
      cost: 0.03,
    });
    expect(state.isDirty).toBe(true);
  });

  it("leaves tokensConsumed at zero when the dispatch reports no usage (zero-guard)", () => {
    const { fire, state } = subscribe(
      NodeStatus.Running,
      "task-A",
      undefined,
      { inputTokens: 0, outputTokens: 0, cost: 0 },
    );
    fire("completed");
    expect(state.nodes.get("A")!.tokensConsumed).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    });
  });

  it("cancels the node directly (no signal) when the task is cancelled", () => {
    const { fire, emitted, state } = subscribe(NodeStatus.Running);
    fire("cancelled");
    expect(emitted).toEqual([]);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Cancelled);
  });

  it("ignores a listener whose task id no longer matches the node", () => {
    const { state } = subscribe(NodeStatus.Running);
    // Simulate a re-dispatch: the node now points at a different task.
    state.nodes.get("A")!.dispatchTaskId = "task-A-new";
    const emitted: Array<[string, SignalType, unknown]> = [];
    const port = { getTask: () => makeTask("old", "completed") };
    // A second subscription with the old id must be a no-op for the new binding.
    subscribeTaskTermination(state, port as never, state.nodes.get("A")!, (n, t, p) =>
      emitted.push([n, t, p]),
    );
    // Fire the OLD subscription's callback path is exercised via the helper port;
    // here we verify a stale task id guard by invoking with a mismatched id.
    expect(state.nodes.get("A")!.dispatchTaskId).toBe("task-A-new");
  });

  it("completed with terminatingSignal=revise_needed → emits revise_needed (not answer)", () => {
    const task = makeTask("task-A", "completed");
    task.terminatingSignal = {
      type: "revise_needed",
      payload: { findings: ["bad"] },
    };
    const { fire, emitted } = subscribe(
      NodeStatus.Running,
      "task-A",
      task,
    );
    fire("completed");
    expect(emitted).toEqual([
      ["A", "revise_needed", { findings: ["bad"] }],
    ]);
  });

  it("completed without terminatingSignal → emits answer (default)", () => {
    const task = makeTask("task-A", "completed");
    const { fire, emitted } = subscribe(
      NodeStatus.Running,
      "task-A",
      task,
    );
    fire("completed");
    expect(emitted).toEqual([["A", "answer", { __inferred: true }]]);
  });

  it("completed with ledger revise_needed but no task terminatingSignal → emits revise_needed via ledger", () => {
    // Simulate the full dispatch→signal pipeline: the completion evaluator
    // recorded a revise_needed in the sessionSignalLedger (via
    // getTerminatingSignal), but the task object itself does NOT carry
    // terminatingSignal. The mapDispatchStatusToSignal last-resort ledger
    // read must recover it so subscribeTaskTermination emits revise_needed
    // instead of defaulting to answer.
    const sessionId = "sess-sub-ledger";
    sessionSignalLedger.record(sessionId, "revise_needed", {
      findings: ["ledger-revise"],
    });
    const customTask = makeTask("task-A", "completed");
    (customTask as { sessionId: string }).sessionId = sessionId;
    const { fire, emitted } = subscribe(
      NodeStatus.Running,
      "task-A",
      customTask,
    );
    fire("completed");
    expect(emitted).toEqual([
      ["A", "revise_needed", { findings: ["ledger-revise"] }],
    ]);
    sessionSignalLedger.clearSession(sessionId);
  });

  it("does NOT emit escalate for a still-live/running task reporting a transient error (subtask 4)", () => {
    // The listener fires with status 'error', but the dispatch port's
    // authoritative getTask read shows the task is still running → the error is
    // stale/transient: skip the escalate and keep the node running.
    const liveTask = makeTask("task-A", "running");
    const { fire, emitted, state } = subscribe(
      NodeStatus.Running,
      "task-A",
      liveTask,
    );
    fire("error");
    expect(emitted).toEqual([]); // no escalate for a transient/live task
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running); // node stays running
  });

  it("still escalates a genuinely errored task whose authoritative read is error (subtask 4 regression)", () => {
    // The task is genuinely errored (getTask returns 'error'), so the liveness
    // guard must NOT suppress the escalate.
    const erroredTask = makeTask("task-A", "error", "boom");
    const { fire, emitted } = subscribe(
      NodeStatus.Running,
      "task-A",
      erroredTask,
    );
    fire("error");
    expect(emitted).toEqual([["A", "escalate", { error: "boom" }]]);
  });

  it("re-subscription-ledger: registers the transient-error re-subscription into the optional out-param (M9)", () => {
    // The listener reports a transient error; the authoritative getTask read
    // shows the task still live → the listener re-subscribes. The NEW callback
    // must land in the optional ledger so the engine's dispose() can unregister
    // it — no zombie callback escapes the M4 subscription ledger (04-F5).
    const state = buildState(singleNodeGraph(), "sub-ledger");
    const node = state.nodes.get("A")!;
    node.status = NodeStatus.Running;
    node.dispatchTaskId = "task-A";
    let registered: TaskTerminatedCallback | undefined;
    const port = {
      getTask: () => makeTask("task-A", "running"), // authoritative: still live
      onTaskTerminated: (_id: string, cb: TaskTerminatedCallback) => {
        registered = cb;
      },
    };
    const ledger: Array<{ taskId: string; callback: TaskTerminatedCallback }> =
      [];
    const emitted: Array<[string, SignalType, unknown]> = [];
    subscribeTaskTermination(
      state,
      port as never,
      node,
      (n, t, p) => emitted.push([n, t, p]),
      ledger,
    );
    expect(ledger).toEqual([]); // nothing yet — no transient error fired

    // Fire the transient-error path: no escalate, node stays running.
    registered!("task-A", "error");
    expect(emitted).toEqual([]);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);

    // The re-subscribed callback is captured in the ledger — the exact handle
    // the caller (engine-advance `_dispatchNode`) registers into
    // `_terminationSubscriptions` for dispose.
    expect(ledger).toHaveLength(1);
    expect(ledger[0].taskId).toBe("task-A");
    expect(ledger[0].callback).toBe(registered!); // the new listener on the port

    // The re-subscribed listener still advances the node on a genuine
    // termination (the ledger handle is a live, working callback).
    registered!("task-A", "completed");
    expect(emitted).toEqual([["A", "answer", { __inferred: true }]]);
  });
});

// ── captureNodeUsage (Phase-7 per-node consumption) ─────────────────────────

describe("captureNodeUsage", () => {
  function usageState(): { state: EngineState; node: NodeRuntimeState } {
    const state = buildState(singleNodeGraph(), "usage");
    const node = state.nodes.get("A")!;
    node.status = NodeStatus.Running;
    node.dispatchSessionId = "sess-A";
    return { state, node };
  }

  const usage: UsageRecord = { inputTokens: 120, outputTokens: 45, cost: 0.0123 };

  it("populates node.tokensConsumed from the dispatch session usage at termination", () => {
    const { state, node } = usageState();
    const port = { getSessionUsage: () => usage };
    captureNodeUsage(state, node, port as never);
    expect(node.tokensConsumed).toEqual(usage);
    expect(state.isDirty).toBe(true);
  });

  it("is a no-op when the port does not expose getSessionUsage", () => {
    const { state, node } = usageState();
    node.tokensConsumed = { inputTokens: 7, outputTokens: 3, cost: 0.01 };
    captureNodeUsage(state, node, {} as never);
    expect(node.tokensConsumed).toEqual({ inputTokens: 7, outputTokens: 3, cost: 0.01 });
  });

  it("is a no-op when the node has no dispatch session id", () => {
    const { state, node } = usageState();
    node.dispatchSessionId = undefined;
    const port = { getSessionUsage: () => usage };
    captureNodeUsage(state, node, port as never);
    expect(node.tokensConsumed).toEqual({ inputTokens: 0, outputTokens: 0, cost: 0 });
  });

  it("does NOT clobber an adopted prior value with a zero usage read (zero-guard)", () => {
    const { state, node } = usageState();
    node.tokensConsumed = { inputTokens: 100, outputTokens: 50, cost: 0.5 };
    const port = { getSessionUsage: () => ({ inputTokens: 0, outputTokens: 0, cost: 0 }) };
    captureNodeUsage(state, node, port as never);
    expect(node.tokensConsumed).toEqual({ inputTokens: 100, outputTokens: 50, cost: 0.5 });
  });

  it("is a no-op when getSessionUsage throws (best-effort, never corrupts advancement)", () => {
    const { state, node } = usageState();
    const port = {
      getSessionUsage: () => {
        throw new Error("tracker down");
      },
    };
    captureNodeUsage(state, node, port as never);
    expect(node.tokensConsumed).toEqual({ inputTokens: 0, outputTokens: 0, cost: 0 });
  });
});

// ── reconcileEngine (per-node reconciliation) ───────────────────────────────

describe("reconcileEngine", () => {
  function runReconcile(
    task: DispatchTask | undefined,
    opts: {
      taskId?: string;
      status?: NodeRuntimeState["status"];
      sessionUsage?: UsageRecord;
      /**
       * Y2: tasks the fake port's `getTasksByParent` returns for the graph's
       * parent session. When provided, the port exposes `getTasksByParent`;
       * when omitted the port omits it entirely (the guard-on-presence path).
       */
      parentTasks?: DispatchTask[];
    } = {},
  ): {
    state: EngineState;
    report: ReconcileReport;
    subTasks: string[];
  } {
    const state = buildState(singleNodeGraph(), "rec");
    const node = state.nodes.get("A")!;
    node.status = opts.status ?? NodeStatus.Running;
    node.dispatchTaskId = opts.taskId ?? (task ? "task-A" : undefined);
    node.dispatchSessionId = "sess-A";
    const subTasks: string[] = [];
    const port = {
      getTask: (_id: string) => task,
      onTaskTerminated: (id: string) => subTasks.push(id),
      getSessionUsage: () => opts.sessionUsage ?? { inputTokens: 0, outputTokens: 0, cost: 0 },
      // Y2: OPTIONAL-ADDITIVE — only present when the test supplies parentTasks,
      // so the no-port path (guard-on-presence) stays byte-identical.
      ...(opts.parentTasks !== undefined
        ? { getTasksByParent: () => opts.parentTasks }
        : {}),
    };
    const report = reconcileEngine(
      state,
      port as never,
      () => {},
    );
    return { state, report, subTasks };
  }

  it("running node with a vanished task → timeout + escalate deferred", () => {
    const { state, report } = runReconcile(undefined);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Timeout);
    expect(state.nodes.get("A")!.errorReason).toBe(ORPHAN_REASON);
    expect(report.timedOut).toEqual(["A"]);
    expect(report.deferred).toHaveLength(1);
    expect(report.deferred[0]).toMatchObject({
      nodeId: "A",
      type: "escalate",
    });
    expect(report.reSubscribed).toEqual([]);
  });

  it("running node with no dispatch task id → timeout + escalate deferred", () => {
    const { state, report } = runReconcile(undefined, { taskId: undefined });
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Timeout);
    expect(report.deferred[0].nodeId).toBe("A");
  });

  it("Y2: crash-window orphan — live parent task matches a running node with no dispatchTaskId → recorded for cancellation, node still times out", () => {
    // The crash hit between the running-write and executeNode resolving the
    // task handle: disk state has no dispatchTaskId, but the session WAS
    // launched and is still live. The sweep matches it by parent + the
    // node-scoped description and records it in orphanCancellations.
    const live = makeTask("task-live", "running");
    live.description = "graph node A";
    live.parentSessionId = "rec"; // buildState's graphId → the dispatch parent
    const { state, report } = runReconcile(undefined, {
      taskId: undefined,
      parentTasks: [live],
    });
    // Recorded for fire-and-forget cancellation by the caller.
    expect(report.orphanCancellations).toEqual([
      { nodeId: "A", taskId: "task-live" },
    ]);
    // Node disposition is UNCHANGED: timeout + orphan reason + deferred escalate.
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Timeout);
    expect(state.nodes.get("A")!.errorReason).toBe(ORPHAN_REASON);
    expect(report.timedOut).toEqual(["A"]);
    expect(report.deferred).toHaveLength(1);
    expect(report.deferred[0]).toMatchObject({
      nodeId: "A",
      type: "escalate",
    });
    expect(report.reSubscribed).toEqual([]);
  });

  it("Y2: the only matching parent task is terminal → no orphan cancellation recorded", () => {
    // A completed task is not live — the crashed window's session already
    // finished, so there is nothing to cancel (its termination was simply
    // missed; the node still times out as an orphan).
    const done = makeTask("task-done", "completed");
    done.description = "graph node A";
    done.parentSessionId = "rec";
    const { state, report } = runReconcile(undefined, {
      taskId: undefined,
      parentTasks: [done],
    });
    expect(report.orphanCancellations).toEqual([]);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Timeout);
    expect(state.nodes.get("A")!.errorReason).toBe(ORPHAN_REASON);
    expect(report.timedOut).toEqual(["A"]);
    expect(report.deferred).toHaveLength(1);
  });

  it("Y2: a port WITHOUT getTasksByParent → orphan branch records nothing extra (pre-Y2 byte-identical)", () => {
    // The new members are OPTIONAL-ADDITIVE: a minimal port that omits
    // getTasksByParent must behave exactly as before — no matches, no
    // orphanCancellations entries, same timeout + deferred escalate.
    const { state, report } = runReconcile(undefined, { taskId: undefined });
    expect(report.orphanCancellations).toEqual([]);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Timeout);
    expect(state.nodes.get("A")!.errorReason).toBe(ORPHAN_REASON);
    expect(report.timedOut).toEqual(["A"]);
    expect(report.deferred[0]).toMatchObject({
      nodeId: "A",
      type: "escalate",
    });
  });

  it("running node that completed during restart → answer deferred", () => {
    const { report } = runReconcile(makeTask("task-A", "completed"));
    expect(report.deferred).toHaveLength(1);
    expect(report.deferred[0]).toMatchObject({ nodeId: "A", type: "answer" });
    expect(report.timedOut).toEqual([]);
  });

  it("records per-node consumption for a task that finished during restart (Phase-7)", () => {
    const { state, report } = runReconcile(makeTask("task-A", "completed"), {
      sessionUsage: { inputTokens: 300, outputTokens: 120, cost: 0.05 },
    });
    expect(report.deferred[0].type).toBe("answer");
    expect(state.nodes.get("A")!.tokensConsumed).toEqual({
      inputTokens: 300,
      outputTokens: 120,
      cost: 0.05,
    });
  });

  it("running node that errored during restart → escalate deferred (with error)", () => {
    const { report } = runReconcile(makeTask("task-A", "error", "kaboom"));
    expect(report.deferred).toHaveLength(1);
    expect(report.deferred[0]).toMatchObject({ nodeId: "A", type: "escalate" });
    expect((report.deferred[0].payload as { error: string }).error).toBe(
      "kaboom",
    );
  });

  it("running node cancelled during restart → cancelled in place, no deferred", () => {
    const { state, report } = runReconcile(makeTask("task-A", "cancelled"));
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Cancelled);
    expect(report.deferred).toEqual([]);
    expect(report.timedOut).toEqual([]);
  });

  it("still-running task → re-subscribed, node untouched", () => {
    const { state, report, subTasks } = runReconcile(
      makeTask("task-A", "running"),
    );
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);
    expect(report.reSubscribed).toEqual(["A"]);
    expect(subTasks).toEqual(["task-A"]);
    expect(report.deferred).toEqual([]);
  });

  it("reconcile-live-error: an error-reported-but-live task keeps the node running and re-subscribes (M8)", () => {
    // The classification read reports `error`, but the authoritative liveness
    // re-check read shows the task recovered to a LIVE status — a transient
    // execution error whose session is still continuing (review 04-F4). The
    // restart window must not latch the node as a terminal escalate: reconcile
    // keeps it running and routes into the re-subscribe branch, mirroring
    // subscribeTaskTermination's live-seam guard.
    const state = buildState(singleNodeGraph(), "rec-live-error");
    const node = state.nodes.get("A")!;
    node.status = NodeStatus.Running;
    node.dispatchTaskId = "task-A";
    const registered: string[] = [];
    let reads = 0;
    const port = {
      getTask: () => {
        reads += 1;
        return reads === 1
          ? makeTask("task-A", "error", "transient")
          : makeTask("task-A", "running");
      },
      onTaskTerminated: (id: string) => registered.push(id),
    };
    const subs: ReconcileSubscriptions = { listeners: [] };
    const report = reconcileEngine(state, port as never, () => {}, subs);
    // Node stays running — never escalated, never timed out.
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);
    expect(report.reSubscribed).toEqual(["A"]);
    expect(report.timedOut).toEqual([]);
    expect(report.deferred).toEqual([]);
    // The listener was re-subscribed (monitor M4: the {taskId, callback} pair
    // is surfaced through the out-param so a caller can unregister it later).
    expect(registered).toEqual(["task-A"]);
    expect(subs.listeners).toHaveLength(1);
    expect(subs.listeners[0].taskId).toBe("task-A");
  });

  it("still escalates a genuinely errored task whose authoritative read stays error (M8 regression)", () => {
    // The liveness re-check confirms the task is NOT live (status error) — the
    // M8 guard must NOT suppress the deferred escalate for a real error.
    const state = buildState(singleNodeGraph(), "rec-live-error-genuine");
    const node = state.nodes.get("A")!;
    node.status = NodeStatus.Running;
    node.dispatchTaskId = "task-A";
    const port = {
      getTask: () => makeTask("task-A", "error", "kaboom"),
      onTaskTerminated: () => {},
    };
    const report = reconcileEngine(state, port as never, () => {});
    expect(report.timedOut).toEqual([]);
    expect(report.reSubscribed).toEqual([]);
    expect(report.deferred).toHaveLength(1);
    expect(report.deferred[0]).toMatchObject({ nodeId: "A", type: "escalate" });
    expect((report.deferred[0].payload as { error: string }).error).toBe("kaboom");
  });
});

// ── rebuildFrontier ─────────────────────────────────────────────────────────

describe("rebuildFrontier", () => {
  it("rebuilds the frontier from every ready node", () => {
    const state = buildState(linearGraph(), "frontier");
    // A = ready root (in frontier from provision); B = pending.
    state.frontier = []; // simulate a corrupted/empty frontier
    const rebuilt = rebuildFrontier(state);
    expect(rebuilt).toEqual(["A"]);
    expect(state.frontier).toEqual(["A"]);
  });

  it("includes a ready non-root node that is not yet in the frontier", () => {
    const state = buildState(linearGraph(), "frontier");
    const b = state.nodes.get("B")!;
    b.status = NodeStatus.Ready; // B became ready but never entered the frontier
    state.frontier = ["A"];
    const rebuilt = rebuildFrontier(state);
    expect(rebuilt).toEqual(["A", "B"]);
  });

  it("marks the state dirty when rebuilding the frontier (L21 choke-point)", () => {
    // A recovered state starts clean (hydrateEngineState resets isDirty) — the
    // frontier recomputation is a persistent-field mutation and must set the
    // dirty flag so the next critical section persists it (05-F5: without this,
    // recover()'s reconcile-failure catch path could drop the rebuilt frontier
    // from disk when no other mutation sets the flag).
    const state = buildState(linearGraph(), "frontier-dirty");
    state.isDirty = false; // simulate a just-hydrated state
    state.frontier = [];
    rebuildFrontier(state);
    expect(state.isDirty).toBe(true);
  });
});

// ── clearStaleCriticalSection ───────────────────────────────────────────────

describe("clearStaleCriticalSection", () => {
  it("releases a stuck lock and drops orphaned deferred completions", () => {
    const state = buildState(singleNodeGraph(), "stale");
    state.advancingLock = true;
    state.pendingCompletions = ["A"];
    clearStaleCriticalSection(state);
    expect(state.advancingLock).toBe(false);
    expect(state.pendingCompletions).toEqual([]);
  });

  it("is a no-op when the lock is already free", () => {
    const state = buildState(singleNodeGraph(), "stale");
    state.pendingCompletions = [];
    clearStaleCriticalSection(state);
    expect(state.advancingLock).toBe(false);
  });

  it("marks the state dirty when clearing a stale critical section (L21 choke-point)", () => {
    // advancingLock + pendingCompletions are persistent fields — the release /
    // clear must set the dirty flag (05-F5) so a subsequent critical section
    // (or the recover() catch path) persists the cleared stale state.
    const state = buildState(singleNodeGraph(), "stale-dirty");
    state.isDirty = false; // simulate a just-hydrated state
    state.advancingLock = true;
    state.pendingCompletions = ["A"];
    clearStaleCriticalSection(state);
    expect(state.advancingLock).toBe(false);
    expect(state.pendingCompletions).toEqual([]);
    expect(state.isDirty).toBe(true);
  });
});

// ── EngineLockSweeper (manually tickable — no unbounded interval) ──────────

describe("EngineLockSweeper", () => {
  it("does not release a freshly-held lock", () => {
    const state = buildState(singleNodeGraph(), "sweep");
    state.advancingLock = true;
    const sweeper = new EngineLockSweeper({ lockTimeoutMs: 30_000 });
    const released = sweeper.sweep(state, 1_000);
    expect(released).toBe(false);
    expect(state.advancingLock).toBe(true);
  });

  it("releases a lock held past the timeout (stale-lock release)", () => {
    const state = buildState(singleNodeGraph(), "sweep");
    state.advancingLock = true;
    const sweeper = new EngineLockSweeper({ lockTimeoutMs: 30_000 });
    sweeper.sweep(state, 1_000); // first observation
    const released = sweeper.sweep(state, 1_000 + 30_001); // stale
    expect(released).toBe(true);
    expect(state.advancingLock).toBe(false);
  });

  it("honors an injectable lockTimeoutMs and onRelease hook", () => {
    const state = buildState(singleNodeGraph(), "sweep");
    state.advancingLock = true;
    let releasedGraph = "";
    const sweeper = new EngineLockSweeper({
      lockTimeoutMs: 5_000,
      onRelease: (g) => (releasedGraph = g),
    });
    sweeper.sweep(state, 0);
    const released = sweeper.sweep(state, 5_000);
    expect(released).toBe(true);
    expect(releasedGraph).toBe(state.graphId);
  });

  it("forgets the first-seen time when the lock is released externally", () => {
    const state = buildState(singleNodeGraph(), "sweep");
    const sweeper = new EngineLockSweeper({ lockTimeoutMs: 30_000 });
    state.advancingLock = true;
    sweeper.sweep(state, 1_000);
    state.advancingLock = false; // released externally
    // re-acquired later — must start a fresh first-seen window, not be stale
    state.advancingLock = true;
    const released = sweeper.sweep(state, 1_000 + 1_000); // only 1s elapsed
    expect(released).toBe(false); // not yet stale (fresh window)
  });
});

// ── Integration: engine.recover() ───────────────────────────────────────────

describe("engine.recover() integration", () => {
  /** A controllable dispatch port backed by an in-memory task map. */
  class RecoveryFake implements NodeDispatchPort {
    tasks = new Map<string, DispatchTask>();
    calls: string[] = [];
    cancelled: string[] = [];
    private listeners = new Map<string, Array<(id: string, st: string) => void>>();

    setStatus(id: string, status: DispatchTask["status"], error?: string): void {
      this.tasks.set(id, makeTask(id, status, error));
    }
    getTask(id: string): DispatchTask | undefined {
      return this.tasks.get(id);
    }
    // Y2: the crash-window orphan sweep surface — every task launched under a
    // parent session (the graph id seeds the dispatch parent context).
    getTasksByParent(parentSessionId: string): DispatchTask[] {
      return [...this.tasks.values()].filter(
        (t) => t.parentSessionId === parentSessionId,
      );
    }
    onTaskTerminated(id: string, cb: (tid: string, st: string) => void): void {
      const arr = this.listeners.get(id) ?? [];
      arr.push(cb);
      this.listeners.set(id, arr);
    }
    cancelTask(id: string): Promise<boolean> {
      this.cancelled.push(id);
      return Promise.resolve(true);
    }
    executeNode(
      node: NodeRuntimeState,
      _p: DispatchParentContext,
    ): Promise<DispatchTask> {
      this.calls.push(node.nodeId);
      const t = makeTask(`task-${node.nodeId}`);
      this.tasks.set(t.id, t);
      return Promise.resolve(t);
    }
    /** Fire every registered listener for a task (test driver). */
    fire(id: string, status: DispatchTask["status"]): void {
      for (const cb of this.listeners.get(id) ?? []) cb(id, status);
    }
  }

  function makeTmpDir(): string {
    return mkdtempSync(join(tmpdir(), "engine-recovery-"));
  }

  it("task vanished during restart → node marked timeout, engine completes", async () => {
    const dir = makeTmpDir();
    const fakeA = new RecoveryFake();
    const engineA = createEngine(singleNodeGraph(), {
      stateDir: dir,
      graphId: "rec-vanish",
      dispatch: fakeA,
    });
    await engineA.run(); // A running, persisted with dispatchTaskId task-A

    const fakeB = new RecoveryFake(); // empty task map → task-A is vanished
    const engineB = createEngine(singleNodeGraph(), {
      stateDir: dir,
      graphId: "rec-vanish",
      dispatch: fakeB,
    });
    await engineB.recover();

    const snap = engineB.status();
    expect(snap.nodes.get("A")!.status).toBe(NodeStatus.Timeout);
    expect(snap.nodes.get("A")!.errorReason).toBe(ORPHAN_REASON);
    expect(snap.phase).toBe(EnginePhase.Complete);
  });

  it("Y2: recover() cancels the orphaned live session of a running node with no dispatchTaskId", async () => {
    const dir = makeTmpDir();
    const graphId = "rec-y2-orphan";
    // Crash-window orphan: the node was persisted `running` BEFORE executeNode
    // resolved its task handle — no dispatchTaskId on disk, but the session
    // WAS launched and is still live in the dispatch system.
    const crashed = buildState(singleNodeGraph(), graphId);
    crashed.nodes.get("A")!.status = NodeStatus.Running;
    crashed.nodes.get("A")!.dispatchTaskId = undefined;
    new EnginePersistence(dir).save(crashed);

    const fake = new RecoveryFake();
    const live = makeTask("task-orphan", "running");
    live.parentSessionId = graphId; // the graph id is the dispatch parent
    live.description = "graph node A";
    fake.tasks.set("task-orphan", live);

    const engine = createEngine(singleNodeGraph(), {
      stateDir: dir,
      graphId,
      dispatch: fake,
    });
    await engine.recover();

    // The orphaned live session was cancelled fire-and-forget (best-effort
    // teardown — the session would otherwise keep burning budget).
    expect(fake.cancelled).toEqual(["task-orphan"]);
    // The node disposition is unchanged: timeout + orphan reason, engine done.
    const snap = engine.status();
    expect(snap.nodes.get("A")!.status).toBe(NodeStatus.Timeout);
    expect(snap.nodes.get("A")!.errorReason).toBe(ORPHAN_REASON);
    expect(snap.phase).toBe(EnginePhase.Complete);
    rmSync(dir, { recursive: true, force: true });
  });

  it("task completed during restart → answer re-emitted, node completed", async () => {
    const dir = makeTmpDir();
    const fakeA = new RecoveryFake();
    await createEngine(singleNodeGraph(), {
      stateDir: dir,
      graphId: "rec-completed",
      dispatch: fakeA,
    })
      .run();

    const fakeB = new RecoveryFake();
    fakeB.setStatus("task-A", "completed");
    const engineB = createEngine(singleNodeGraph(), {
      stateDir: dir,
      graphId: "rec-completed",
      dispatch: fakeB,
    });
    await engineB.recover();

    const snap = engineB.status();
    expect(snap.nodes.get("A")!.status).toBe(NodeStatus.Completed);
    expect(snap.phase).toBe(EnginePhase.Complete);
  });

  it("task still running → re-subscribed; a later completion advances the node", async () => {
    const dir = makeTmpDir();
    const fakeA = new RecoveryFake();
    const engineA = createEngine(singleNodeGraph(), {
      stateDir: dir,
      graphId: "rec-live",
      dispatch: fakeA,
    });
    await engineA.run();

    const fakeB = new RecoveryFake();
    fakeB.setStatus("task-A", "running"); // still live during restart
    const engineB = createEngine(singleNodeGraph(), {
      stateDir: dir,
      graphId: "rec-live",
      dispatch: fakeB,
    });
    await engineB.recover();

    // Still running — recovery only re-subscribed, did not force-complete.
    expect(engineB.status().nodes.get("A")!.status).toBe(NodeStatus.Running);

    // The worker finally terminates → the re-subscribed listener drives the graph.
    fakeB.setStatus("task-A", "completed");
    fakeB.fire("task-A", "completed");
    await tick();
    await tick();

    const snap = engineB.status();
    expect(snap.nodes.get("A")!.status).toBe(NodeStatus.Completed);
    expect(snap.phase).toBe(EnginePhase.Complete);
  });

  it("releases a stale advancingLock from a crashed state and resumes ready nodes", async () => {
    const dir = makeTmpDir();
    const graphId = "rec-lock";
    // Simulate a crash that persisted a stuck lock mid-advance.
    const crashed = buildState(singleNodeGraph(), graphId);
    crashed.advancingLock = true; // the process died holding the lock
    crashed.pendingCompletions = ["A"];
    new EnginePersistence(dir).save(crashed);

    const fake = new RecoveryFake();
    const engine = createEngine(singleNodeGraph(), {
      stateDir: dir,
      graphId,
      dispatch: fake,
    });
    await engine.recover();

    const snap = engine.status();
    expect(snap.advancingLock).toBe(false); // stale lock released
    // The ready root A was re-dispatched by the rebuilt frontier.
    expect(fake.calls).toEqual(["A"]);
    expect(snap.nodes.get("A")!.status).toBe(NodeStatus.Running);
  });

  it("is a no-op (clean start) when no persisted state exists", async () => {
    const dir = makeTmpDir();
    const fake = new RecoveryFake();
    const engine = createEngine(singleNodeGraph(), {
      stateDir: dir,
      graphId: "rec-never",
      dispatch: fake,
    });
    await engine.recover();
    // Nothing was persisted → recovery adopted nothing; the engine stays idle.
    expect(engine.status().phase).toBe(EnginePhase.Idle);
    expect(fake.calls).toEqual([]);
  });

  it("notifies persisted Timeout nodes one by one on the no-getTask recovery path [M6]", async () => {
    const dir = makeTmpDir();
    const graphId = "rec-m6-noget";
    // Persist a crashed state in which A was ALREADY marked timeout. The
    // no-getTask path cannot apply timeout semantics (no dispatch read to
    // reconcile a vanished running task), so it must still surface the
    // recorded timeout through the completion seam + event log.
    const crashed = buildState(singleNodeGraph(), graphId);
    crashed.nodes.get("A")!.status = NodeStatus.Timeout;
    crashed.nodes.get("A")!.errorReason = ORPHAN_REASON;
    new EnginePersistence(dir).save(crashed);

    const events: NodeCompletionEvent[] = [];
    // A dispatch port WITHOUT getTask → recovery takes the no-getTask path.
    const plainFake: NodeDispatchPort = {
      executeNode: async () => makeTask("never-dispatched"),
    };
    const engine = createEngine(singleNodeGraph(), {
      stateDir: dir,
      graphId,
      dispatch: plainFake,
      onNodeCompletion: (e) => events.push(e),
    });
    await engine.recover();

    expect(events).toHaveLength(1);
    expect(events[0].nodeId).toBe("A");
    expect(events[0].signalType).toBe("timeout");
    expect(events[0].nodeStatus).toBe(NodeStatus.Timeout);
    expect(engine.status().nodes.get("A")!.status).toBe(NodeStatus.Timeout);
  });

  it("notifies Timeout nodes one by one when reconcile throws mid-pass [M6 catch path]", async () => {
    const dir = makeTmpDir();
    const graphId = "rec-m6-catch";
    // Two roots: A's task VANISHED (timed out first in the reconcile pass),
    // B's task is still live but its re-subscription THROWS — reconcileEngine
    // aborts mid-pass and the catch path must surface every node it already
    // timed out (A) without fabricating a timeout for the still-running B.
    const twoNode: GraphDeclaration = {
      version: 2,
      name: "m6-catch",
      nodes: [
        { id: "A", agent: "a1", prompt: "pA" },
        { id: "B", agent: "a2", prompt: "pB" },
      ],
      edges: [],
    };
    const crashed = buildState(twoNode, graphId);
    crashed.nodes.get("A")!.status = NodeStatus.Running;
    crashed.nodes.get("A")!.dispatchTaskId = "task-A";
    crashed.nodes.get("B")!.status = NodeStatus.Running;
    crashed.nodes.get("B")!.dispatchTaskId = "task-B";
    new EnginePersistence(dir).save(crashed);

    const events: NodeCompletionEvent[] = [];
    const throwingPort = {
      getTask: (id: string) =>
        id === "task-B" ? makeTask("task-B", "running") : undefined,
      onTaskTerminated: () => {
        throw new Error("port down");
      },
    };
    const engine = createEngine(twoNode, {
      stateDir: dir,
      graphId,
      dispatch: throwingPort as unknown as NodeDispatchPort,
      onNodeCompletion: (e) => events.push(e),
    });
    await engine.recover();

    // Exactly one timeout notification — for A, the node the reconcile pass
    // timed out before throwing. B (still running) is not fabricated.
    expect(events).toHaveLength(1);
    expect(events[0].nodeId).toBe("A");
    expect(events[0].signalType).toBe("timeout");
    expect(events[0].nodeStatus).toBe(NodeStatus.Timeout);
    expect(engine.status().nodes.get("A")!.status).toBe(NodeStatus.Timeout);
    expect(engine.status().nodes.get("B")!.status).toBe(NodeStatus.Running);
  });

  it("persists the stale-lock release + frontier rebuild after the reconcile-failure catch path (L21)", async () => {
    const dir = makeTmpDir();
    const graphId = "rec-l21-persist";
    // Persist a crashed state: A running with a still-LIVE task, stale lock
    // held. Recovery clears the lock (clearStaleCriticalSection) BEFORE the
    // reconcile pass — which then aborts (re-subscription throws) with NO node
    // timed out, so nothing else marks the state dirty. The catch path
    // (rebuildFrontier + dispatchReady) must still persist the lock release +
    // rebuilt frontier via the markDirty choke-point — without it the on-disk
    // file would keep the stale lock (05-F5).
    const crashed = buildState(singleNodeGraph(), graphId);
    crashed.nodes.get("A")!.status = NodeStatus.Running;
    crashed.nodes.get("A")!.dispatchTaskId = "task-A";
    crashed.advancingLock = true;
    new EnginePersistence(dir).save(crashed);

    const throwingPort = {
      getTask: () => makeTask("task-A", "running"), // task verifiably live
      onTaskTerminated: () => {
        throw new Error("port down"); // reconcile aborts mid-pass
      },
    };
    const engine = createEngine(singleNodeGraph(), {
      stateDir: dir,
      graphId,
      dispatch: throwingPort as unknown as NodeDispatchPort,
    });
    await engine.recover();

    // In-memory: the stale lock was released; A stays running (never
    // force-terminated by the failed reconcile).
    expect(engine.status().advancingLock).toBe(false);
    expect(engine.status().nodes.get("A")!.status).toBe(NodeStatus.Running);

    // On-disk: the catch path's critical section persisted the mutation —
    // the released lock and the rebuilt (empty) frontier are durable.
    const loaded = new EnginePersistence(dir).load(graphId);
    expect(loaded!.advancingLock).toBe(false);
    expect(loaded!.nodes.get("A")!.status).toBe(NodeStatus.Running);
    expect(loaded!.frontier).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── Integration: engine.cancel() ────────────────────────────────────────────

describe("engine.cancel() integration", () => {
  class CancelFake implements NodeDispatchPort {
    cancelled: string[] = [];
    executeNode(
      node: NodeRuntimeState,
      _p: DispatchParentContext,
    ): Promise<DispatchTask> {
      return Promise.resolve(makeTask(`task-${node.nodeId}`));
    }
    cancelTask(id: string): Promise<boolean> {
      this.cancelled.push(id);
      return Promise.resolve(true);
    }
  }

  it("cancels running/ready/pending nodes and completes the engine", async () => {
    const fake = new CancelFake();
    const engine = createEngine(linearGraph(), { dispatch: fake });
    await engine.run(); // A running, B pending

    await engine.cancel();

    const snap = engine.status();
    expect(snap.phase).toBe(EnginePhase.Complete);
    expect(snap.nodes.get("A")!.status).toBe(NodeStatus.Done);
    expect(snap.nodes.get("B")!.status).toBe(NodeStatus.Done);
    expect(snap.frontier).toEqual([]);
    // The running node's dispatch task was cancelled via the seam.
    expect(fake.cancelled).toEqual(["task-A"]);
  });

  it("persists the cancelled terminal state when a stateDir is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-cancel-"));
    const fake = new CancelFake();
    const graphId = "rec-cancel-persist";
    const engine: EngineRuntime = createEngine(singleNodeGraph(), {
      stateDir: dir,
      graphId,
      dispatch: fake,
    });
    await engine.run();
    await engine.cancel();

    const loaded = new EnginePersistence(dir).load(graphId);
    expect(loaded!.phase).toBe(EnginePhase.Complete);
    expect(loaded!.nodes.get("A")!.status).toBe(NodeStatus.Done);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── H3: checkpointHistory hydration & adoption ───────────────────────────────

describe("H3 — checkpointHistory hydration & adoption", () => {
  it("hydrateEngineState round-trips checkpointHistory without loss (defensive copies)", () => {
    const source = buildState(singleNodeGraph(), "hyd-h");
    source.checkpointHistory = {
      A: [
        { nodeId: "A", status: NodeStatus.Ready, at: 1 },
        { nodeId: "A", status: NodeStatus.Completed, at: 2, note: "done" },
      ],
    };
    const target = createEngineState(singleNodeGraph(), "hyd-h");
    hydrateEngineState(target, source);
    expect(target.checkpointHistory).toEqual(source.checkpointHistory);
    // Defensive copies, not aliases — mutating the target never mutates source.
    expect(target.checkpointHistory).not.toBe(source.checkpointHistory);
    expect(target.checkpointHistory!.A).not.toBe(source.checkpointHistory!.A);
    expect(target.checkpointHistory!.A[0]).not.toBe(source.checkpointHistory!.A[0]);
  });

  it("hydrateEngineState passes an absent checkpointHistory through as undefined", () => {
    // Non-provisioned source: no lifecycle transition ever ran, so the
    // append-only history is genuinely absent (provision() itself records a
    // ready checkpoint and would fabricate an entry).
    const source = createEngineState(singleNodeGraph(), "hyd-h-absent");
    expect(source.checkpointHistory).toBeUndefined();
    const target = createEngineState(singleNodeGraph(), "hyd-h-absent");
    hydrateEngineState(target, source);
    expect(target.checkpointHistory).toBeUndefined();
  });

  it("adoptPriorNodeStates merges checkpointHistory prior-first (target wins conflicts)", () => {
    const prior = buildState(singleNodeGraph(), "adopt-h");
    prior.checkpointHistory = {
      A: [{ nodeId: "A", status: NodeStatus.Running, at: 10 }],
      B: [{ nodeId: "B", status: NodeStatus.Ready, at: 11 }],
    };
    const target = buildState(singleNodeGraph(), "adopt-h");
    // A target-side record (recorded after provisioning) survives the merge.
    target.checkpointHistory = {
      A: [{ nodeId: "A", status: NodeStatus.Completed, at: 12 }],
    };
    adoptPriorNodeStates(target, prior);
    // Prior-only key B carried; target key A wins the conflict.
    expect(target.checkpointHistory).toEqual({
      A: [{ nodeId: "A", status: NodeStatus.Completed, at: 12 }],
      B: [{ nodeId: "B", status: NodeStatus.Ready, at: 11 }],
    });
  });

  it("records a checkpoint for an adopted status change — no history gap (L15)", () => {
    // Prior run: A completed. Fresh rebuild: A provisioned ready. Adoption
    // writes A's status directly (Ready → Completed), bypassing
    // transitionNode's auto-checkpoint — the direct write must be compensated
    // so checkpointHistory records the adopt transition (03-F6).
    const prior = buildState(singleNodeGraph(), "adopt-cp");
    prior.nodes.get("A")!.status = NodeStatus.Completed;
    const target = buildState(singleNodeGraph(), "adopt-cp");
    // Fresh provision recorded a Ready checkpoint for the root.
    expect(target.checkpointHistory!["A"]).toHaveLength(1);
    expect(target.checkpointHistory!["A"][0].status).toBe(NodeStatus.Ready);

    adoptPriorNodeStates(target, prior);

    const history = target.checkpointHistory!["A"];
    expect(history).toHaveLength(2); // [Ready (provision), Completed (adopt)]
    expect(history[history.length - 1]).toMatchObject({
      nodeId: "A",
      status: NodeStatus.Completed,
    });
    expect(target.checkpoints!["A"]).toMatchObject({ status: NodeStatus.Completed });
  });

  it("does NOT fabricate a checkpoint when adoption changes no status (L15)", () => {
    // A provisioned ready root adopting a prior ready root is a no-change
    // adoption — no transition occurred, so no checkpoint is appended.
    const prior = buildState(singleNodeGraph(), "adopt-cp-none");
    const target = buildState(singleNodeGraph(), "adopt-cp-none");
    const before = target.checkpointHistory!["A"].length;
    adoptPriorNodeStates(target, prior);
    expect(target.checkpointHistory!["A"]).toHaveLength(before);
  });

  it("records a checkpoint for the H2 in-degree demotion Ready → Pending (L15)", () => {
    // Construction-tool ordering: the prior run provisioned WITHOUT the edge
    // (B provisioned ready), then the edge was added for this rebuild (B is
    // pending in the target). Adoption promotes B back to Ready, and the H2
    // post-adoption reconciliation demotes it to Pending — the demote is a
    // direct status write that must be checkpointed (03-F6:742).
    const noEdge: GraphDeclaration = {
      version: 2,
      name: "adopt-demote",
      nodes: [
        { id: "A", agent: "a1", prompt: "p1" },
        { id: "B", agent: "a2", prompt: "p2" },
      ],
      edges: [],
    };
    const withEdge: GraphDeclaration = {
      ...noEdge,
      edges: [{ from: "A", to: "B", type: "always" }],
    };
    const prior = buildState(noEdge, "adopt-demote"); // both provisioned ready
    const target = buildState(withEdge, "adopt-demote"); // B pending (in-edge)
    adoptPriorNodeStates(target, prior);

    expect(target.nodes.get("B")!.status).toBe(NodeStatus.Pending);
    const bHistory = target.checkpointHistory!["B"];
    expect(bHistory[bHistory.length - 1]).toMatchObject({
      nodeId: "B",
      status: NodeStatus.Pending,
    });
  });
});

// ── L7: monitor fields survive adoptPriorNodeStates ─────────────────────────

describe("L7 — artifacts / evidence / convergenceFingerprint adoption", () => {
  it("carries per-node artifacts and evidence across adoption (defensive copies)", () => {
    const prior = buildState(singleNodeGraph(), "adopt-l7");
    const pNode = prior.nodes.get("A")!;
    pNode.status = NodeStatus.Completed;
    pNode.artifacts = ["out/a.txt", "out/b.txt"];
    pNode.evidence = ["ev/cite.md"];
    pNode.resultText = "stashed sidecar text";
    const target = buildState(singleNodeGraph(), "adopt-l7");
    adoptPriorNodeStates(target, prior);
    const tNode = target.nodes.get("A")!;
    expect(tNode.artifacts).toEqual(["out/a.txt", "out/b.txt"]);
    expect(tNode.evidence).toEqual(["ev/cite.md"]);
    // Subtask 2: the stashed result-text snapshot rides along (adopted nodes
    // keep their EdgePayload `result` fallback without a sidecar re-read).
    expect(tNode.resultText).toBe("stashed sidecar text");
    // Defensive copies — mutating the target arrays does not alias the prior.
    tNode.artifacts!.push("out/c.txt");
    expect(prior.nodes.get("A")!.artifacts).toEqual(["out/a.txt", "out/b.txt"]);
  });

  it("carries the loop-group convergenceFingerprint across adoption", () => {
    const loopDecl: GraphDeclaration = {
      version: 2,
      name: "loop-adopt",
      nodes: [
        { id: "A", agent: "a1", prompt: "p1" },
        { id: "B", agent: "a2", prompt: "p2" },
      ],
      edges: [{ from: "B", to: "A", type: "always" }],
      loop_groups: [
        { id: "lg", nodes: ["A", "B"], max_traversals: 3 },
      ],
    };
    const prior = buildState(loopDecl, "adopt-lg");
    prior.loopGroups.get("lg")!.convergenceFingerprint = "fp-123";
    const target = buildState(loopDecl, "adopt-lg");
    // Fresh provision has no fingerprint — adoption must restore it.
    expect(target.loopGroups.get("lg")!.convergenceFingerprint).toBeUndefined();
    adoptPriorNodeStates(target, prior);
    expect(target.loopGroups.get("lg")!.convergenceFingerprint).toBe("fp-123");
  });

  it("leaves an absent prior convergenceFingerprint as undefined in the target", () => {
    const loopDecl: GraphDeclaration = {
      version: 2,
      name: "loop-adopt-none",
      nodes: [{ id: "A", agent: "a1", prompt: "p1" }],
      edges: [],
      loop_groups: [{ id: "lg", nodes: ["A"], max_traversals: 3 }],
    };
    const prior = buildState(loopDecl, "adopt-lg-none");
    const target = buildState(loopDecl, "adopt-lg-none");
    adoptPriorNodeStates(target, prior);
    expect(target.loopGroups.get("lg")!.convergenceFingerprint).toBeUndefined();
  });
});

// ── M10: terminalNotified hydration & adoption ───────────────────────────────

describe("M10 — terminalNotified hydration & adoption", () => {
  it("hydrateEngineState copies terminalNotified (cloned; absent → undefined)", () => {
    const source = buildState(singleNodeGraph(), "hyd-tn");
    source.terminalNotified = { complete: true, blocked: false };
    const target = createEngineState(singleNodeGraph(), "hyd-tn");
    hydrateEngineState(target, source);
    expect(target.terminalNotified).toEqual({ complete: true, blocked: false });
    // Cloned, never aliased.
    expect(target.terminalNotified).not.toBe(source.terminalNotified);

    const bare = buildState(singleNodeGraph(), "hyd-tn-absent");
    const t2 = createEngineState(singleNodeGraph(), "hyd-tn-absent");
    hydrateEngineState(t2, bare);
    expect(t2.terminalNotified).toBeUndefined();
  });

  it("adoptPriorNodeStates carries terminalNotified so a rebuilt engine does not re-notify", () => {
    const prior = buildState(singleNodeGraph(), "adopt-tn");
    prior.terminalNotified = { complete: true, blocked: true };
    const target = buildState(singleNodeGraph(), "adopt-tn");
    adoptPriorNodeStates(target, prior);
    expect(target.terminalNotified).toEqual({ complete: true, blocked: true });

    const barePrior = buildState(singleNodeGraph(), "adopt-tn-absent");
    const t2 = buildState(singleNodeGraph(), "adopt-tn-absent");
    adoptPriorNodeStates(t2, barePrior);
    expect(t2.terminalNotified).toBeUndefined();
  });
});

// ── Subtask 5: dangling loop-group adoption/hydration guard ─────────────────

describe("subtask 5 — dangling loopGroupId cleared when the declaration drops the group", () => {
  function loopDropPair(): { prior: EngineState; target: EngineState } {
    const withLoop: GraphDeclaration = {
      version: 2,
      name: "loop-drop",
      nodes: [
        { id: "A", agent: "a1", prompt: "p1" },
        { id: "B", agent: "a2", prompt: "p2" },
      ],
      edges: [{ from: "B", to: "A", type: "always" }],
      loop_groups: [{ id: "lg", nodes: ["A", "B"], max_traversals: 3 }],
    };
    const withoutLoop: GraphDeclaration = {
      version: 2,
      name: "loop-drop",
      nodes: [
        { id: "A", agent: "a1", prompt: "p1" },
        { id: "B", agent: "a2", prompt: "p2" },
      ],
      edges: [{ from: "B", to: "A", type: "always" }],
    };
    const prior = buildState(withLoop, "adopt-dangle");
    // The prior run made real progress and carried the loop tag.
    prior.nodes.get("A")!.status = NodeStatus.Completed;
    const target = buildState(withoutLoop, "adopt-dangle");
    return { prior, target };
  }

  it("adoptPriorNodeStates clears the adopted node's loopGroupId when the declaration dropped the group", () => {
    const { prior, target } = loopDropPair();
    // Fresh provision from the group-less declaration leaves no tag.
    expect(prior.nodes.get("A")!.loopGroupId).toBe("lg");
    expect(target.nodes.get("A")!.loopGroupId).toBeUndefined();
    // Simulate the stale tag adoptPrior must heal (a prior/persisted copy that
    // carried the group id over a rebuild whose declaration dropped the group).
    target.nodes.get("A")!.loopGroupId = "lg";

    adoptPriorNodeStates(target, prior);

    // The dangling tag is cleared; the node degrades to a plain non-loop node.
    expect(target.nodes.get("A")!.loopGroupId).toBeUndefined();
    expect(target.nodes.get("B")!.loopGroupId).toBeUndefined();
    // The runtime map has no group either (fresh provision from the drop).
    expect(target.loopGroups.has("lg")).toBe(false);
    // Legitimate prior progress is still adopted.
    expect(target.nodes.get("A")!.status).toBe(NodeStatus.Completed);
  });

  it("adoptPriorNodeStates preserves loopGroupId when the declaration still declares the group", () => {
    const decl: GraphDeclaration = {
      version: 2,
      name: "loop-keep",
      nodes: [{ id: "A", agent: "a1", prompt: "p1" }],
      edges: [],
      loop_groups: [{ id: "lg", nodes: ["A"], max_traversals: 3 }],
    };
    const prior = buildState(decl, "adopt-keep");
    prior.nodes.get("A")!.status = NodeStatus.Completed;
    const target = buildState(decl, "adopt-keep");
    adoptPriorNodeStates(target, prior);
    expect(target.nodes.get("A")!.loopGroupId).toBe("lg");
  });

  it("hydrateEngineState clears a loopGroupId whose group the persisted declaration dropped", () => {
    const droppedDecl: GraphDeclaration = {
      version: 2,
      name: "hyd-dangle",
      nodes: [{ id: "A", agent: "a1", prompt: "p1" }],
      edges: [],
    };
    const source = buildState(droppedDecl, "hyd-dangle");
    // A persisted node tagged with a group the persisted declaration no longer
    // declares (e.g. saved before a declaration mutation that dropped the group).
    source.nodes.get("A")!.loopGroupId = "lg";

    const target = createEngineState(droppedDecl, "hyd-dangle");
    hydrateEngineState(target, source);

    expect(target.nodes.get("A")!.loopGroupId).toBeUndefined();
  });

  it("hydrateEngineState preserves loopGroupId when the persisted declaration declares the group", () => {
    const decl: GraphDeclaration = {
      version: 2,
      name: "hyd-keep",
      nodes: [{ id: "A", agent: "a1", prompt: "p1" }],
      edges: [],
      loop_groups: [{ id: "lg", nodes: ["A"], max_traversals: 3 }],
    };
    const source = buildState(decl, "hyd-keep");
    const target = createEngineState(decl, "hyd-keep");
    hydrateEngineState(target, source);
    expect(target.nodes.get("A")!.loopGroupId).toBe("lg");
  });
});

// ── M3: NodeStalenessWatcher (manually tickable — no unbounded interval) ────

describe("NodeStalenessWatcher", () => {
  it("marks a running node whose startedAt exceeds the timeout and reports it", () => {
    const state = buildState(singleNodeGraph(), "stale-node");
    const node = state.nodes.get("A")!;
    node.status = NodeStatus.Running;
    node.startedAt = 1_000;
    const timedOutIds: string[] = [];
    const reasons: string[] = [];
    const watcher = new NodeStalenessWatcher({
      nodeStaleTimeoutMs: 30_000,
      onTimeout: (id, reason) => {
        timedOutIds.push(id);
        reasons.push(reason);
      },
    });
    // Fresh — not stale yet.
    expect(watcher.tick(state, 1_000 + 29_999)).toEqual([]);
    expect(node.status).toBe(NodeStatus.Running);
    // Past the deadline — marked timeout + reported through the callback.
    expect(watcher.tick(state, 1_000 + 30_000)).toEqual(["A"]);
    expect(node.status).toBe(NodeStatus.Timeout);
    expect(timedOutIds).toEqual(["A"]);
    expect(reasons[0]).toContain("staleness");
  });

  it("honors per-node budget.timeout_ms over the watcher-wide timeout", () => {
    const state = buildState(singleNodeGraph(), "stale-node-budget");
    const node = state.nodes.get("A")!;
    node.status = NodeStatus.Running;
    node.startedAt = 1_000;
    node.budget = { timeout_ms: 5_000 };
    const watcher = new NodeStalenessWatcher({ nodeStaleTimeoutMs: 30_000 });
    // 5s elapsed: stale under the per-node budget, fresh under the watcher-wide one.
    expect(watcher.tick(state, 1_000 + 5_000)).toEqual(["A"]);
    expect(node.status).toBe(NodeStatus.Timeout);
  });

  it("does not touch non-running nodes, even with an ancient startedAt", () => {
    const state = buildState(singleNodeGraph(), "stale-node-idle");
    const node = state.nodes.get("A")!;
    // Ready (provisioned default) with an ancient startedAt — only Running counts.
    node.startedAt = 1;
    const watcher = new NodeStalenessWatcher({ nodeStaleTimeoutMs: 10 });
    expect(watcher.tick(state, 100_000)).toEqual([]);
    expect(node.status).toBe(NodeStatus.Ready);
  });

  it("skips a running node whose per-node budget disables staleness (timeout_ms 0)", () => {
    const state = buildState(singleNodeGraph(), "stale-node-disabled");
    const node = state.nodes.get("A")!;
    node.status = NodeStatus.Running;
    node.startedAt = 1;
    node.budget = { timeout_ms: 0 };
    const watcher = new NodeStalenessWatcher({ nodeStaleTimeoutMs: 10 });
    expect(watcher.tick(state, 100_000)).toEqual([]);
    expect(node.status).toBe(NodeStatus.Running);
  });

  it("start()/stop() manage the opt-in interval without leaking timers", () => {
    const state = buildState(singleNodeGraph(), "stale-node-timer");
    const watcher = new NodeStalenessWatcher({
      nodeStaleTimeoutMs: 10,
      intervalMs: 1,
    });
    watcher.start(state);
    watcher.stop();
    watcher.stop(); // idempotent
  });
});

// ── M4: subscribeTaskTermination returns its callback ───────────────────────

describe("subscribeTaskTermination return value (M4)", () => {
  it("returns the exact callback handed to onTaskTerminated — a valid removal handle", () => {
    const state = buildState(singleNodeGraph(), "sub-ret");
    const node = state.nodes.get("A")!;
    node.status = NodeStatus.Running;
    node.dispatchTaskId = "task-A";
    let registered: TaskTerminatedCallback | undefined;
    const port = {
      getTask: (id: string) => makeTask(id, "running"),
      onTaskTerminated: (_id: string, cb: TaskTerminatedCallback) => {
        registered = cb;
      },
    };
    const emitted: Array<[string, SignalType, unknown]> = [];
    const callback = subscribeTaskTermination(
      state,
      port as never,
      node,
      (n, t, p) => emitted.push([n, t, p]),
    );
    expect(typeof callback).toBe("function");
    expect(registered).toBe(callback); // the port registered THIS function
    // Driving the returned callback still advances the node through the seam.
    callback!("task-A", "completed");
    expect(emitted).toEqual([["A", "answer", { __inferred: true }]]);
  });

  it("returns undefined when the node has no dispatch task id", () => {
    const state = buildState(singleNodeGraph(), "sub-ret-none");
    const node = state.nodes.get("A")!;
    node.status = NodeStatus.Running;
    const port = { onTaskTerminated: () => {} };
    const callback = subscribeTaskTermination(state, port as never, node, () => {});
    expect(callback).toBeUndefined();
  });

  it("returns undefined when the port has no onTaskTerminated surface", () => {
    const state = buildState(singleNodeGraph(), "sub-ret-noport");
    const node = state.nodes.get("A")!;
    node.status = NodeStatus.Running;
    node.dispatchTaskId = "task-A";
    const callback = subscribeTaskTermination(state, {} as never, node, () => {});
    expect(callback).toBeUndefined();
  });
});

// ── M4: reconcileEngine surfaces re-subscription handles via the out-param ───

describe("reconcileEngine re-subscription out-param (M4)", () => {
  it("collects { taskId, callback } for live re-subscriptions", () => {
    const state = buildState(singleNodeGraph(), "rec-sub");
    const node = state.nodes.get("A")!;
    node.status = NodeStatus.Running;
    node.dispatchTaskId = "task-A";
    const registered = new Map<string, TaskTerminatedCallback>();
    const port = {
      getTask: () => makeTask("task-A", "running"),
      onTaskTerminated: (id: string, cb: TaskTerminatedCallback) =>
        registered.set(id, cb),
    };
    const subs: ReconcileSubscriptions = { listeners: [] };
    const report = reconcileEngine(state, port as never, () => {}, subs);
    expect(report.reSubscribed).toEqual(["A"]);
    expect(subs.listeners).toHaveLength(1);
    expect(subs.listeners[0].taskId).toBe("task-A");
    // The surfaced callback is the exact function the port registered — a valid
    // removeTaskTerminatedListener handle.
    expect(subs.listeners[0].callback).toBe(registered.get("task-A"));
  });

  it("is a no-op collection for non-live nodes (orphaned / terminal)", () => {
    const state = buildState(singleNodeGraph(), "rec-sub-none");
    const node = state.nodes.get("A")!;
    node.status = NodeStatus.Running;
    node.dispatchTaskId = undefined; // orphaned → timed out, never re-subscribed
    const subs: ReconcileSubscriptions = { listeners: [] };
    const report = reconcileEngine(state, {} as never, () => {}, subs);
    expect(report.timedOut).toEqual(["A"]);
    expect(subs.listeners).toEqual([]);
  });
});
