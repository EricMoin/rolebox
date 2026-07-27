/**
 * Graph Execution Engine v2 — graph-notify engine wiring (subtask 3)
 *
 * Verifies that the graph-notify config threaded through
 * `createGraphTools` → `GraphToolSetDeps` reaches the engine's `onNodeCompletion`
 * seam, so a node completing during `graph_run` routes a `<system-reminder>` to
 * the owner emperor session (via graph-notify's dispatch-notification pipeline).
 *
 * Scenarios:
 * - With a graphNotify config present, `graph_run` drives a node to `completed`
 *   and the fake ISessionClient receives the reminder targeting the emperor
 *   session (asserted via the GRAPH marker + graph_id/node_id).
 * - The emperor session is resolved from the invoking session id forwarded by
 *   `graph_run` (the tool-context session), so the resolver targets the runtime
 *   orchestrator session.
 * - A prebuilt notifier fn is used as-is (routing to graph-notify unchanged).
 * - Absent graphNotify config → the engine runs with its default no-op
 *   completion seam: node completion does NOT produce any reminder.
 *
 * `graphParentContext` budget scoping (sessionID: graphId) is untouched by this
 * wiring — verified separately in graph-tools tests (grep on dispatch-bridge).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import type { NodeDispatchPort } from "../../src/graph/engine/engine-advance.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { ISessionClient } from "../../src/platform/ports/session-client.ts";
import {
  GRAPH_COMPLETION_MARKER,
  clearParentQueues,
} from "../../src/dispatch/notification.ts";
import type { NodeCompletionEvent } from "../../src/graph/engine/engine-advance.ts";

// ── Fake ISessionClient ─────────────────────────────────────────────────────

class FakeSessionClient implements ISessionClient {
  prompts: Array<{ id: string; text: string; noReply?: boolean; agent?: string }> = [];

  async prompt(
    id: string,
    options: {
      parts: Array<{ type: string; text: string }>;
      noReply?: boolean;
      agent?: string;
    },
  ): Promise<{ id: string } | null> {
    this.prompts.push({
      id,
      text: options.parts.map((p) => p.text).join("\n"),
      noReply: options.noReply,
      agent: options.agent,
    });
    return { id };
  }

  async list(): Promise<never> {
    throw new Error("not implemented");
  }
  async get(): Promise<never> {
    throw new Error("not implemented");
  }
  async messages(): Promise<never> {
    throw new Error("not implemented");
  }
  async children(): Promise<never> {
    throw new Error("not implemented");
  }
  async todo(): Promise<never> {
    throw new Error("not implemented");
  }
  async diff(): Promise<never> {
    throw new Error("not implemented");
  }
  async fork(): Promise<never> {
    throw new Error("not implemented");
  }
  async status(): Promise<never> {
    throw new Error("not implemented");
  }
  async promptSync(): Promise<never> {
    throw new Error("not implemented");
  }
  async create(): Promise<never> {
    throw new Error("not implemented");
  }
  async abort(): Promise<never> {
    throw new Error("not implemented");
  }
}

// ── Fake dispatch seam with task-termination → signal delivery ──────────────

/**
 * A dispatch seam that returns a running task and exposes `onTaskTerminated` +
 * `getTask`, so `subscribeTaskTermination` (engine-advance `_dispatchNode`)
 * maps a terminal dispatch status to a terminating engine signal — driving a
 * node to `completed` end-to-end through the graph tools, exactly like a live
 * worker's dispatch completion.
 */
class FakeDispatchSeam implements NodeDispatchPort {
  tasks = new Map<string, DispatchTask>();
  private listeners = new Map<string, (taskId: string, status: string) => void>();
  private seq = 0;

  executeNode(): Promise<DispatchTask> {
    this.seq += 1;
    const task: DispatchTask = {
      id: `task-${this.seq}`,
      sessionId: `sess-${this.seq}`,
      parentSessionId: "graph-budget-scope",
      depth: 1,
      status: "running",
      agent: "a",
      prompt: "p",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
    };
    this.tasks.set(task.id, task);
    return Promise.resolve(task);
  }

  onTaskTerminated(
    taskId: string,
    cb: (taskId: string, status: string) => void,
  ): (taskId: string, status: string) => void {
    this.listeners.set(taskId, cb);
    return cb;
  }

  getTask(taskId: string): DispatchTask | undefined {
    return this.tasks.get(taskId);
  }

  /** Mark the latest task completed → fires the onTaskTerminated listener. */
  completeLatest(): void {
    let latestTaskId: string | undefined;
    for (const id of this.tasks.keys()) latestTaskId = id;
    if (!latestTaskId) throw new Error("no dispatched task to complete");
    const task = this.tasks.get(latestTaskId)!;
    task.status = "completed";
    const cb = this.listeners.get(latestTaskId);
    if (cb) cb(latestTaskId, "completed");
  }
}

/** Flush the microtask chain (engine advance → onNodeCompletion → notify queue). */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const EMPEROR_SESSION = "emperor-session-42";

beforeEach(() => {
  clearParentQueues();
});

/** Build a single-root-node graph through the toolset. */
function buildSingleNodeGraph(ts: ReturnType<typeof createGraphToolSet>): string {
  const { graph_id } = ts.graph_create({ name: "notify-single" });
  ts.graph_add_node({
    graph_id,
    id: "A",
    agent: "emperor--jinyiwei--ui",
    prompt: "do the thing",
  });
  return graph_id;
}

// ── graph_run → graph-notify wiring ────────────────────────────────────────

describe("graph_run → graph-notify engine wiring (subtask 3)", () => {
  it("routes a completing node's reminder to the configured emperor session", async () => {
    const client = new FakeSessionClient();
    const dispatch = new FakeDispatchSeam();
    const ts = createGraphToolSet({
      dispatch,
      graphNotify: {
        sessionClient: client,
        emperorSessionId: EMPEROR_SESSION,
      },
    });

    const graphId = buildSingleNodeGraph(ts);
    await ts.graph_run({ graph_id: graphId }, "invoking-session-7");
    dispatch.completeLatest();
    await flush();

    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0].id).toBe(EMPEROR_SESSION);
    expect(client.prompts[0].noReply).toBe(true);
    expect(client.prompts[0].text).toContain(GRAPH_COMPLETION_MARKER);
    expect(client.prompts[0].text).toContain("**Graph:** notify-single");
    expect(client.prompts[0].text).toContain("**Node:** A");
    expect(client.prompts[0].text).toContain("**Agent:** emperor--jinyiwei--ui");
    expect(client.prompts[0].text).toContain("**Status:** completed");
  });

  it("resolves the emperor session from the invoking session when a resolver is used", async () => {
    const client = new FakeSessionClient();
    const dispatch = new FakeDispatchSeam();
    const ts = createGraphToolSet({
      dispatch,
      graphNotify: {
        sessionClient: client,
        // The call sites (tool-service / pi service-stack) pass a resolver that
        // reads the orchestrator session from the graph tool's execution context.
        emperorSessionId: (invokingSessionId) => invokingSessionId,
      },
    });

    const graphId = buildSingleNodeGraph(ts);
    await ts.graph_run({ graph_id: graphId }, "emperor-live-session");
    dispatch.completeLatest();
    await flush();

    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0].id).toBe("emperor-live-session");
    expect(client.prompts[0].text).toContain(GRAPH_COMPLETION_MARKER);
  });

  it("uses a prebuilt notifier fn as-is", async () => {
    const client = new FakeSessionClient();
    const dispatch = new FakeDispatchSeam();
    const seen: string[] = [];
    const handler = (event: NodeCompletionEvent): Promise<boolean> => {
      seen.push(event.nodeId);
      return Promise.resolve(true);
    };
    const ts = createGraphToolSet({
      dispatch,
      graphNotify: handler,
    });

    const graphId = buildSingleNodeGraph(ts);
    await ts.graph_run({ graph_id: graphId });
    dispatch.completeLatest();
    await flush();

    expect(seen).toEqual(["A"]);
    expect(client.prompts).toHaveLength(0);
  });

  it("does not notify when no graphNotify config is present (no-op seam)", async () => {
    const dispatch = new FakeDispatchSeam();
    const ts = createGraphToolSet({ dispatch });

    const graphId = buildSingleNodeGraph(ts);
    await ts.graph_run({ graph_id: graphId });
    dispatch.completeLatest();
    await flush();

    // No notifier wired → nothing to assert against a client; completion still
    // advanced the node normally.
    const state = ts["getEntry"](graphId).runtime.status();
    expect(state.nodes.get("A")!.status).toBe("completed");
  });

  it("is a no-op when the resolved emperor session is absent", async () => {
    const client = new FakeSessionClient();
    const dispatch = new FakeDispatchSeam();
    const ts = createGraphToolSet({
      dispatch,
      graphNotify: {
        sessionClient: client,
        emperorSessionId: () => undefined,
      },
    });

    const graphId = buildSingleNodeGraph(ts);
    await ts.graph_run({ graph_id: graphId });
    dispatch.completeLatest();
    await flush();

    expect(client.prompts).toHaveLength(0);
  });
});
