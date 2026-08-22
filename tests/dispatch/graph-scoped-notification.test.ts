/**
 * Graph-scoped dispatch notifications (subtask 4 / bug 2 — double completion
 * reminders).
 *
 * Verifies the graph-scope marker end-to-end through the dispatch layer:
 *   1. `executeNode`/`graphParentContext` set the marker, and `manager.launch`
 *      carries it onto the dispatched `DispatchTask` (real-session dispatches
 *      stay unmarked).
 *   2. `manager.notifyCompletion` / lifecycle `notifyCompletion` emit NO
 *      `[BACKGROUND TASK COMPLETED]` / `[ALL BACKGROUND TASKS COMPLETE]`
 *      reminder for a graph-scoped task (parentSessionId = graphId) — the
 *      dispatch layer stays silent.
 *   3. Real-session tasks still emit both reminder forms exactly as before.
 *   4. Graph-node completion is reported EXCLUSIVELY by the graph notifier:
 *      `createGraphNotifier` / `createGraphTerminalNotifier` still emit
 *      `[GRAPH NODE COMPLETED]` / `[GRAPH COMPLETE]` to the emperor session.
 */

import { describe, it, expect, mock, afterEach } from "bun:test";
import { DispatchManager } from "../../src/dispatch/core/manager";
import type { ISessionClient } from "../../src/platform/ports/session-client";
import type { DispatchTask } from "../../src/dispatch/types";
import { createMockClient, makeTask, parentContext } from "./helpers";
import {
  clearParentQueues,
  clearSentFinalNotifies,
  DISPATCH_COMPLETION_MARKER,
  DISPATCH_ALL_COMPLETE_MARKER,
  GRAPH_COMPLETION_MARKER,
  GRAPH_COMPLETE_MARKER,
} from "../../src/dispatch/notification";
import { graphParentContext } from "../../src/graph/engine/dispatch-bridge";
import {
  createGraphNotifier,
  createGraphTerminalNotifier,
} from "../../src/graph/engine/graph-notify";
import type {
  NodeCompletionEvent,
  GraphTerminalEvent,
} from "../../src/graph/engine/engine-advance";
import { NodeStatus } from "../../src/constants";
import { metrics } from "../../src/dispatch/persistence/metrics";

const fastConfig = {
  staleTimeoutMs: 500,
  taskTtlMs: 100,
};

/** Default `run_in_background` dispatch input for tests. */
function graphInput(overrides: Record<string, unknown> = {}) {
  return {
    subagent: "helper",
    prompt: "execute graph node",
    run_in_background: true,
    graphScoped: true,
    ...overrides,
  };
}

function makeCompletionEvent(
  overrides: Partial<NodeCompletionEvent> = {},
): NodeCompletionEvent {
  return {
    graphId: "g-1",
    nodeId: "A",
    nodeAgent: "emperor--jinyiwei--ui",
    signalType: "answer",
    payload: undefined,
    nodeStatus: NodeStatus.Completed,
    startedAt: 1000,
    completedAt: 3500,
    ...overrides,
  };
}

function makeTerminalEvent(
  overrides: Partial<GraphTerminalEvent> = {},
): GraphTerminalEvent {
  return {
    graphId: "g-1",
    phase: "complete",
    nodeStatusSummaries: {
      completed: 1,
      escalate: 0,
      timeout: 0,
      blocked: 0,
      running: 0,
    },
    isBlocked: false,
    ...overrides,
  };
}

describe("graph-scope marker", () => {
  afterEach(() => {
    mock.restore();
    clearParentQueues();
    clearSentFinalNotifies();
    metrics.reset();
  });

  it("graphParentContext sets graphScoped: true and carries it onto the dispatched task", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const graphCtx = graphParentContext({ graphId: "graph-abc", directory: "/tmp/test" });
    expect(graphCtx.graphScoped).toBe(true);

    const task = await manager.launch(graphInput(), graphCtx);
    expect(task.graphScoped).toBe(true);
    expect(task.parentSessionId).toBe("graph-abc");
    expect(task.id).toMatch(/^bg_/);
  });

  it("real-session dispatches are NOT graph-scoped (marker absent)", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const task = await manager.launch(
      {
        subagent: "helper",
        prompt: "real work",
        run_in_background: true,
      },
      parentContext(),
    );
    expect(task.graphScoped).toBeUndefined();
    expect(task.parentSessionId).toBe("parent-session-1");
  });
});

describe("graph-scoped notification suppression", () => {
  afterEach(() => {
    mock.restore();
    clearParentQueues();
    clearSentFinalNotifies();
    metrics.reset();
  });

  it("emits NO [BACKGROUND TASK COMPLETED] / [ALL BACKGROUND TASKS COMPLETE] for a graph-scoped task", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const graphTask: DispatchTask = makeTask({
      id: "bg_graph_node",
      parentSessionId: "graph-abc",
      status: "completed",
      graphScoped: true,
    });

    // remaining=2 would render [BACKGROUND TASK COMPLETED]; remaining=0 would
    // render [ALL BACKGROUND TASKS COMPLETE]. Both must be suppressed.
    await manager.notifyCompletion(graphTask, 2);
    await manager.notifyCompletion(graphTask, 0);
    await new Promise((r) => setTimeout(r, 10));

    expect(client.prompt).not.toHaveBeenCalled();
  });

  it("still emits [BACKGROUND TASK COMPLETED] for a real-session task (intermediate)", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const realTask: DispatchTask = makeTask({
      id: "bg_real",
      parentSessionId: "parent-session-1",
      status: "completed",
    });

    await manager.notifyCompletion(realTask, 2);
    await new Promise((r) => setTimeout(r, 10));

    const calls = (client.prompt as ReturnType<typeof mock>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("parent-session-1");
    expect(calls[0][1].parts[0].text).toContain(DISPATCH_COMPLETION_MARKER);
    expect(calls[0][1].parts[0].text).not.toContain(DISPATCH_ALL_COMPLETE_MARKER);
    expect(calls[0][1].noReply).toBe(true);
  });

  it("still emits [ALL BACKGROUND TASKS COMPLETE] for a real-session task (final)", async () => {
    const client = createMockClient();
    const manager = new DispatchManager(client, fastConfig);

    const realTask: DispatchTask = makeTask({
      id: "bg_real_final",
      parentSessionId: "parent-session-1",
      status: "completed",
    });

    await manager.notifyCompletion(realTask, 0);
    await new Promise((r) => setTimeout(r, 10));

    const calls = (client.prompt as ReturnType<typeof mock>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("parent-session-1");
    expect(calls[0][1].parts[0].text).toContain(DISPATCH_ALL_COMPLETE_MARKER);
    expect(calls[0][1].parts[0].text).not.toContain(DISPATCH_COMPLETION_MARKER);
    expect(calls[0][1].noReply).toBe(false);
  });
});

describe("graph notifier remains the exclusive completion reporter", () => {
  afterEach(() => {
    mock.restore();
    clearParentQueues();
    clearSentFinalNotifies();
    metrics.reset();
  });

  it("createGraphNotifier still emits [GRAPH NODE COMPLETED] to the emperor session", async () => {
    const client = createMockClient();
    const handler = createGraphNotifier(client, { emperorSessionId: "emperor-42" });

    const ok = await handler(makeCompletionEvent());
    expect(ok).toBe(true);

    const calls = (client.prompt as ReturnType<typeof mock>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("emperor-42");
    expect(calls[0][1].parts[0].text).toContain(GRAPH_COMPLETION_MARKER);
    expect(calls[0][1].parts[0].text).toContain("graph: g-1");
    expect(calls[0][1].parts[0].text).toContain("node: A");
    expect(calls[0][1].parts[0].text).not.toContain(DISPATCH_COMPLETION_MARKER);
    expect(calls[0][1].parts[0].text).not.toContain(DISPATCH_ALL_COMPLETE_MARKER);
  });

  it("createGraphTerminalNotifier still emits [GRAPH COMPLETE] to the emperor session", async () => {
    const client = createMockClient();
    const handler = createGraphTerminalNotifier(client, { emperorSessionId: "emperor-42" });

    const ok = await handler(makeTerminalEvent());
    expect(ok).toBe(true);

    const calls = (client.prompt as ReturnType<typeof mock>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("emperor-42");
    expect(calls[0][1].parts[0].text).toContain(GRAPH_COMPLETE_MARKER);
    expect(calls[0][1].parts[0].text).toContain("graph: g-1");
    expect(calls[0][1].noReply).toBe(false);
  });
});
