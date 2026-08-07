/**
 * Graph Engine — Node-Stall Notifier (subtask 5 of node-anomaly-detection)
 *
 * Verifies the `createGraphStallNotifier` factory + the end-to-end wiring of
 * the stall notification seam:
 * - GRAPH_STALL_MARKER is a member of DISPATCH_NOTIFICATION_MARKERS and
 *   recognized by isDispatchNotification (non-user turn);
 * - buildGraphStallText renders marker + graph_id / node_id / agent / idle /
 *   stallWarnMs; formatStallIdle formats compact durations;
 * - a fresh stall event sends exactly one `client.prompt(emperorSessionId,
 *   { parts, noReply: true })`; the SAME episode (same graphId::nodeId::
 *   stallWarnedAt) is deduped; a NEW episode after recovery (fresh
 *   stallWarnedAt) re-notifies;
 * - `enabled: false` and a missing emperor session are no-ops; injection
 *   failure returns false without throwing;
 * - the graph-tools wiring reaches the runtime's `onNodeStall` seam: with a
 *   graphNotify config, a manual livenessMonitor tick on a heartbeat-fed
 *   running node injects one stall reminder; WITHOUT config the seam stays
 *   unset and nothing is injected.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import type { ISessionClient } from "../../src/platform/ports/session-client.ts";
import type { NodeStallEvent } from "../../src/graph/engine/engine-recovery.ts";
import type { NodeLivenessMonitor } from "../../src/graph/engine/engine-recovery.ts";
import type { EngineState } from "../../src/types.engine-v2.ts";
import type { NodeDispatchPort } from "../../src/graph/engine/engine-advance.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import {
  createGraphStallNotifier,
  buildGraphStallText,
  formatStallIdle,
} from "../../src/graph/engine/graph-notify.ts";
import {
  DISPATCH_NOTIFICATION_MARKERS,
  GRAPH_STALL_MARKER,
  isDispatchNotification,
  clearParentQueues,
} from "../../src/dispatch/notification.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";

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

// ── Fake dispatch seam (node stays running until completeLatest) ────────────

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
}

/** Flush the microtask chain (monitor tick → onNodeStall → notify queue). */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const EMPEROR_SESSION = "emperor-42";

function makeStallEvent(overrides: Partial<NodeStallEvent> = {}): NodeStallEvent {
  return {
    graphId: "g-1",
    nodeId: "A",
    agent: "emperor--jinyiwei--ui",
    idleMs: 61_000,
    stallWarnMs: 60_000,
    stallWarnedAt: 10_000,
    ...overrides,
  };
}

beforeEach(() => {
  clearParentQueues();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── Marker ───────────────────────────────────────────────────────────────────

describe("GRAPH_STALL_MARKER", () => {
  it("is a member of DISPATCH_NOTIFICATION_MARKERS", () => {
    expect(DISPATCH_NOTIFICATION_MARKERS).toContain(GRAPH_STALL_MARKER);
  });

  it("is recognized as a dispatch notification (non-user turn)", () => {
    expect(isDispatchNotification(GRAPH_STALL_MARKER)).toBe(true);
  });
});

// ── Reminder text / formatter ────────────────────────────────────────────────

describe("formatStallIdle", () => {
  it("renders sub-minute idles as X.Xs", () => {
    expect(formatStallIdle(2_500)).toBe("2.5s");
    expect(formatStallIdle(59_999)).toBe("60.0s");
  });

  it("renders minute-scale idles as Xm Ys", () => {
    expect(formatStallIdle(61_000)).toBe("1m 1s");
    expect(formatStallIdle(60_000)).toBe("1m");
    expect(formatStallIdle(3 * 60_000 + 45_000)).toBe("3m 45s");
  });

  it("renders negative idles (clock skew) as '?'", () => {
    expect(formatStallIdle(-5)).toBe("?");
  });
});

describe("buildGraphStallText", () => {
  it("renders marker, graph_id, node_id, agent, idle and stallWarnMs", () => {
    const text = buildGraphStallText(makeStallEvent());
    expect(text).toContain(GRAPH_STALL_MARKER);
    expect(text).toContain("<system-reminder>");
    expect(text).toContain("graph: g-1");
    expect(text).toContain("node: A");
    expect(text).toContain("agent: emperor--jinyiwei--ui");
    expect(text).toContain("idle: 1m 1s");
    expect(text).toContain("stallWarnMs: 60000");
    expect(text).toContain("graph_status(graph_id=\"g-1\", node_id=\"A\"");
  });

  it("falls back to 'N/A' when the agent is absent", () => {
    const text = buildGraphStallText(makeStallEvent({ agent: "" }));
    expect(text).toContain("agent: N/A");
  });
});

// ── createGraphStallNotifier ────────────────────────────────────────────────

describe("createGraphStallNotifier", () => {
  it("sends a silent reminder to the emperor session for a fresh stall", async () => {
    const client = new FakeSessionClient();
    const handler = createGraphStallNotifier(client, { emperorSessionId: EMPEROR_SESSION });

    const ok = await handler(makeStallEvent());
    expect(ok).toBe(true);
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0].id).toBe(EMPEROR_SESSION);
    // Stall is informational — injected silently, never waking the orchestrator.
    expect(client.prompts[0].noReply).toBe(true);
    expect(client.prompts[0].text).toContain(GRAPH_STALL_MARKER);
    expect(client.prompts[0].text).toContain("graph: g-1");
    expect(client.prompts[0].text).toContain("node: A");
    expect(client.prompts[0].text).toContain("stallWarnMs: 60000");
  });

  it("dedupes a second send of the SAME stall episode", async () => {
    const client = new FakeSessionClient();
    const handler = createGraphStallNotifier(client, { emperorSessionId: EMPEROR_SESSION });
    const event = makeStallEvent();

    expect(await handler(event)).toBe(true);
    expect(await handler(event)).toBe(false);
    expect(client.prompts).toHaveLength(1);
  });

  it("legally re-notifies a NEW stall episode after recovery (fresh stallWarnedAt)", async () => {
    const client = new FakeSessionClient();
    const handler = createGraphStallNotifier(client, { emperorSessionId: EMPEROR_SESSION });

    await handler(makeStallEvent({ stallWarnedAt: 10_000 }));
    await handler(makeStallEvent({ stallWarnedAt: 50_000 }));
    expect(client.prompts).toHaveLength(2);
  });

  it("is a no-op when enabled: false", async () => {
    const client = new FakeSessionClient();
    const handler = createGraphStallNotifier(client, {
      emperorSessionId: EMPEROR_SESSION,
      enabled: false,
    });

    expect(await handler(makeStallEvent())).toBe(false);
    expect(client.prompts).toHaveLength(0);
  });

  it("is a no-op when no emperor session is configured", async () => {
    const client = new FakeSessionClient();
    const handler = createGraphStallNotifier(client, {});

    expect(await handler(makeStallEvent())).toBe(false);
    expect(client.prompts).toHaveLength(0);
  });

  it("forwards the agent option", async () => {
    const client = new FakeSessionClient();
    const handler = createGraphStallNotifier(client, {
      emperorSessionId: EMPEROR_SESSION,
      agent: "emperor",
    });

    await handler(makeStallEvent());
    expect(client.prompts[0].agent).toBe("emperor");
  });

  it("injection failure does not throw (returns false on prompt error)", async () => {
    class ThrowingSessionClient extends FakeSessionClient {
      override async prompt(
        _id: string,
        _options: {
          parts: Array<{ type: string; text: string }>;
          noReply?: boolean;
          agent?: string;
        },
      ): Promise<{ id: string } | null> {
        throw new Error("injection exploded");
      }
    }
    const client = new ThrowingSessionClient();
    const handler = createGraphStallNotifier(client, { emperorSessionId: EMPEROR_SESSION });

    // Must resolve and return false, not throw.
    const ok = await handler(makeStallEvent());
    expect(ok).toBe(false);
  });
});

// ── graph-tools wiring (buildEngine + graph_run → onNodeStall) ──────────────

describe("graph-tools stall wiring (subtask 5)", () => {
  it("injects one stall reminder from a livenessMonitor tick when a notifier is wired", async () => {
    const client = new FakeSessionClient();
    const ts = createGraphToolSet({
      dispatch: new FakeDispatchSeam(),
      graphNotify: {
        sessionClient: client,
        emperorSessionId: EMPEROR_SESSION,
      },
    });

    const { graph_id: graphId } = ts.graph_create({ name: "stall-wired" });
    ts.graph_add_node({
      graph_id: graphId,
      id: "A",
      agent: "emperor--jinyiwei--backend",
      prompt: "do the thing",
    });
    await ts.graph_run({ graph_id: graphId });

    // Reach the runtime internals (matches the existing graph-tools test
    // pattern for touching the staleWatcher / state).
    const runtime = ts["getEntry"](graphId).runtime;
    const internals = runtime as unknown as {
      state: EngineState;
      livenessMonitor: NodeLivenessMonitor;
    };
    expect(internals.livenessMonitor).toBeDefined();

    // Node A is running (the fake keeps it alive until completeLatest).
    const node = internals.state.nodes.get("A")!;
    expect(node.status).toBe("running");
    // Stamp a deterministic heartbeat, then idle it past the default warn
    // threshold (min(60_000, 900_000/2) = 60_000 with the toolset 15-min default).
    node.liveness = { lastActivityAt: 1_000, heartbeatSource: "feed" };
    internals.livenessMonitor.tick(internals.state, 1_000 + 60_000 + 1);
    await flush();

    // The stall notifier injected exactly one silent reminder.
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0].id).toBe(EMPEROR_SESSION);
    expect(client.prompts[0].noReply).toBe(true);
    expect(client.prompts[0].text).toContain(GRAPH_STALL_MARKER);
    expect(client.prompts[0].text).toContain("node: A");
    expect(client.prompts[0].text).toContain("graph: stall-wired");
    // Soft stall only — the node is still running, never timed out.
    expect(node.status).toBe("running");
    expect(node.liveness!.stallStatus).toBe("stalling");

    runtime.dispose(); // stop the started monitor/sweeper intervals (no leak)
  });

  it("keeps the default no-op seam (0 reminders) without a graphNotify config", async () => {
    const client = new FakeSessionClient();
    const ts = createGraphToolSet({ dispatch: new FakeDispatchSeam() });

    const { graph_id: graphId } = ts.graph_create({ name: "stall-noop" });
    ts.graph_add_node({
      graph_id: graphId,
      id: "A",
      agent: "emperor--jinyiwei--backend",
      prompt: "do the thing",
    });
    await ts.graph_run({ graph_id: graphId });

    const runtime = ts["getEntry"](graphId).runtime;
    const internals = runtime as unknown as {
      state: EngineState;
      livenessMonitor: NodeLivenessMonitor;
      onNodeStall?: unknown;
    };
    // Without config the `onNodeStall` seam stays unset (no notifier).
    expect(internals.onNodeStall).toBeUndefined();

    // The monitor still classifies the node — only the notification is absent.
    const node = internals.state.nodes.get("A")!;
    node.liveness = { lastActivityAt: 1_000, heartbeatSource: "feed" };
    internals.livenessMonitor.tick(internals.state, 1_000 + 60_000 + 1);
    await flush();

    expect(node.liveness!.stallStatus).toBe("stalling");
    expect(client.prompts).toHaveLength(0);

    runtime.dispose();
  });
});
