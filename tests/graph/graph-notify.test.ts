/**
 * Graph Engine — Node-Completion Notifier (subtask 2)
 *
 * Verifies the `createGraphNotifier` factory:
 * - reminder text contains the GRAPH marker + graph_id / node_id / status and
 *   targets the emperor session id;
 * - a second send for the same graphId::nodeId::signalType is deduped (the
 *   handler resolves `false` and `client.prompt` is called once);
 * - a loop re-entry (fresh startedAt) legally re-notifies;
 * - `enabled: false` is a no-op;
 * - no emperor session configured is a no-op;
 * - GRAPH_COMPLETION_MARKER is a member of DISPATCH_NOTIFICATION_MARKERS;
 * - the duration field is rendered from startedAt/completedAt.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { NodeStatus } from "../../src/constants.ts";
import type { ISessionClient } from "../../src/platform/ports/session-client.ts";
import type {
  NodeCompletionEvent,
  GraphTerminalEvent,
} from "../../src/graph/engine/engine-advance.ts";
import {
  createGraphNotifier,
  buildGraphCompletionText,
  buildGraphTerminalText,
  createGraphTerminalNotifier,
} from "../../src/graph/engine/graph-notify.ts";
import {
  DISPATCH_NOTIFICATION_MARKERS,
  GRAPH_COMPLETION_MARKER,
  GRAPH_COMPLETE_MARKER,
  GRAPH_BLOCKED_MARKER,
  isDispatchNotification,
  clearParentQueues,
} from "../../src/dispatch/notification.ts";

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

// ── Fixtures ────────────────────────────────────────────────────────────────

const EMPEROR_SESSION = "emperor-42";

function makeEvent(
  overrides: Partial<NodeCompletionEvent> = {},
): NodeCompletionEvent {
  const startedAt = overrides.startedAt ?? 1000;
  return {
    graphId: "g-1",
    nodeId: "A",
    nodeAgent: "emperor--jinyiwei--ui",
    signalType: "answer",
    payload: undefined,
    nodeStatus: NodeStatus.Completed,
    startedAt,
    completedAt: overrides.completedAt ?? startedAt + 2500,
    ...overrides,
  };
}

beforeEach(() => {
  clearParentQueues();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("GRAPH_COMPLETION_MARKER", () => {
  it("is a member of DISPATCH_NOTIFICATION_MARKERS", () => {
    expect(DISPATCH_NOTIFICATION_MARKERS).toContain(GRAPH_COMPLETION_MARKER);
  });

  it("is recognized as a dispatch notification (non-user turn)", () => {
    expect(isDispatchNotification(GRAPH_COMPLETION_MARKER)).toBe(true);
  });
});

describe("buildGraphCompletionText", () => {
  it("renders marker, graph_id, node_id, agent, status, signal and duration", () => {
    const text = buildGraphCompletionText(makeEvent());
    expect(text).toContain(GRAPH_COMPLETION_MARKER);
    expect(text).toContain("<system-reminder>");
    expect(text).toContain("**Graph:** g-1");
    expect(text).toContain("**Node:** A");
    expect(text).toContain("**Agent:** emperor--jinyiwei--ui");
    expect(text).toContain("**Status:** completed");
    expect(text).toContain("**Signal:** answer");
    expect(text).toContain("**Duration:** 2.5s");
  });

  it("falls back to '?' when timestamps are absent", () => {
    const text = buildGraphCompletionText(makeEvent({ startedAt: undefined, completedAt: undefined }));
    expect(text).toContain("**Duration:** ?");
  });
});

describe("createGraphNotifier", () => {
  it("sends a reminder to the emperor session with the GRAPH marker", async () => {
    const client = new FakeSessionClient();
    const handler = createGraphNotifier(client, { emperorSessionId: EMPEROR_SESSION });

    const ok = await handler(makeEvent());
    expect(ok).toBe(true);
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0].id).toBe(EMPEROR_SESSION);
    expect(client.prompts[0].noReply).toBe(true);
    expect(client.prompts[0].text).toContain(GRAPH_COMPLETION_MARKER);
    expect(client.prompts[0].text).toContain("**Graph:** g-1");
    expect(client.prompts[0].text).toContain("**Node:** A");
    expect(client.prompts[0].text).toContain("**Status:** completed");
  });

  it("dedupes a second send with the same graphId::nodeId::signalType", async () => {
    const client = new FakeSessionClient();
    const handler = createGraphNotifier(client, { emperorSessionId: EMPEROR_SESSION });
    const event = makeEvent();

    expect(await handler(event)).toBe(true);
    expect(await handler(event)).toBe(false);
    expect(client.prompts).toHaveLength(1);
  });

  it("legally re-notifies a loop re-entry (fresh startedAt)", async () => {
    const client = new FakeSessionClient();
    const handler = createGraphNotifier(client, { emperorSessionId: EMPEROR_SESSION });

    await handler(makeEvent({ startedAt: 1000, completedAt: 3500 }));
    await handler(makeEvent({ startedAt: 9000, completedAt: 11000 }));
    expect(client.prompts).toHaveLength(2);
  });

  it("is a no-op when enabled: false", async () => {
    const client = new FakeSessionClient();
    const handler = createGraphNotifier(client, { emperorSessionId: EMPEROR_SESSION, enabled: false });

    expect(await handler(makeEvent())).toBe(false);
    expect(client.prompts).toHaveLength(0);
  });

  it("is a no-op when no emperor session is configured", async () => {
    const client = new FakeSessionClient();
    const handler = createGraphNotifier(client, {});

    expect(await handler(makeEvent())).toBe(false);
    expect(client.prompts).toHaveLength(0);
  });

  it("forwards the agent option and a fresh run starts a clean epoch", async () => {
    const client = new FakeSessionClient();
    const handler = createGraphNotifier(client, {
      emperorSessionId: EMPEROR_SESSION,
      agent: "emperor",
    });
    const event = makeEvent();

    await handler(event);
    expect(client.prompts[0].agent).toBe("emperor");

    // A new notifier = new run epoch → same event re-notifies.
    const client2 = new FakeSessionClient();
    const handler2 = createGraphNotifier(client2, { emperorSessionId: EMPEROR_SESSION });
    expect(await handler2(event)).toBe(true);
    expect(client2.prompts).toHaveLength(1);
  });
});

// ── Graph-Terminal Notifier Fixtures ─────────────────────────────────────────

function makeTerminalEvent(
  overrides: Partial<GraphTerminalEvent> = {},
): GraphTerminalEvent {
  return {
    graphId: "g-42",
    phase: overrides.isBlocked ? "executing" : "complete",
    nodeStatusSummaries: {
      completed: 3,
      escalate: 0,
      timeout: 0,
      blocked: overrides.isBlocked ? 1 : 0,
      running: 0,
    },
    isBlocked: false,
    ...overrides,
  };
}

// ── Graph-Terminal Notifier Tests ────────────────────────────────────────────

describe("GRAPH_TERMINAL_MARKERS", () => {
  it("GRAPH_COMPLETE_MARKER is a member of DISPATCH_NOTIFICATION_MARKERS", () => {
    expect(DISPATCH_NOTIFICATION_MARKERS).toContain(GRAPH_COMPLETE_MARKER);
  });

  it("GRAPH_BLOCKED_MARKER is a member of DISPATCH_NOTIFICATION_MARKERS", () => {
    expect(DISPATCH_NOTIFICATION_MARKERS).toContain(GRAPH_BLOCKED_MARKER);
  });

  it("GRAPH_COMPLETE_MARKER is recognized as a dispatch notification (non-user turn)", () => {
    expect(isDispatchNotification(GRAPH_COMPLETE_MARKER)).toBe(true);
  });

  it("GRAPH_BLOCKED_MARKER is recognized as a dispatch notification (non-user turn)", () => {
    expect(isDispatchNotification(GRAPH_BLOCKED_MARKER)).toBe(true);
  });
});

describe("buildGraphTerminalText", () => {
  it("renders COMPLETE marker, graph_id, phase, and status summary", () => {
    const text = buildGraphTerminalText(makeTerminalEvent());
    expect(text).toContain(GRAPH_COMPLETE_MARKER);
    expect(text).toContain("<system-reminder>");
    expect(text).toContain("**Graph:** g-42");
    expect(text).toContain("**Phase:** complete");
    expect(text).toContain("  - Completed: 3");
    expect(text).toContain("  - Escalated: 0");
    expect(text).toContain("  - Timed Out: 0");
    expect(text).toContain("  - Blocked: 0");
    expect(text).toContain("  - Running: 0");
    expect(text).toContain("Read all results via graph_status(graph_id=\"g-42\", include_output=true)");
  });

  it("renders BLOCKED marker, phase, blocked count, and approval instruction", () => {
    const text = buildGraphTerminalText(makeTerminalEvent({
      phase: "executing",
      isBlocked: true,
      nodeStatusSummaries: { completed: 2, escalate: 0, timeout: 0, blocked: 1, running: 0 },
    }));
    expect(text).toContain(GRAPH_BLOCKED_MARKER);
    expect(text).toContain("**Phase:** executing");
    expect(text).toContain("  - Blocked: 1");
    expect(text).toContain("quiescent-blocked");
    expect(text).toContain("graph_approve");
    expect(text).toContain("graph_status(graph_id=\"g-42\", status=\"blocked\", include_output=true)");
  });

  it("uses COMPLETE marker when isBlocked is false regardless of phase", () => {
    const text = buildGraphTerminalText(makeTerminalEvent({ phase: "executing", isBlocked: false }));
    expect(text).toContain(GRAPH_COMPLETE_MARKER);
    expect(text).not.toContain(GRAPH_BLOCKED_MARKER);
    expect(text).not.toContain("quiescent-blocked");
  });
});

describe("createGraphTerminalNotifier", () => {
  it("sends a COMPLETE reminder to the emperor session", async () => {
    const client = new FakeSessionClient();
    const handler = createGraphTerminalNotifier(client, { emperorSessionId: EMPEROR_SESSION });

    const ok = await handler(makeTerminalEvent());
    expect(ok).toBe(true);
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0].id).toBe(EMPEROR_SESSION);
    // Terminal reminders must wake the orchestrator (triggerTurn = !noReply).
    expect(client.prompts[0].noReply).toBe(false);
    expect(client.prompts[0].text).toContain(GRAPH_COMPLETE_MARKER);
    expect(client.prompts[0].text).toContain("**Graph:** g-42");
  });

  it("sends a BLOCKED reminder with the BLOCKED marker", async () => {
    const client = new FakeSessionClient();
    const handler = createGraphTerminalNotifier(client, { emperorSessionId: EMPEROR_SESSION });

    const ok = await handler(makeTerminalEvent({ isBlocked: true, phase: "executing" }));
    expect(ok).toBe(true);
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0].text).toContain(GRAPH_BLOCKED_MARKER);
    expect(client.prompts[0].text).toContain("quiescent-blocked");
  });

  it("dedupes a second send of the same complete event", async () => {
    const client = new FakeSessionClient();
    const handler = createGraphTerminalNotifier(client, { emperorSessionId: EMPEROR_SESSION });
    const event = makeTerminalEvent();

    expect(await handler(event)).toBe(true);
    expect(await handler(event)).toBe(false);
    expect(client.prompts).toHaveLength(1);
  });

  it("dedupes a second send of the same blocked event", async () => {
    const client = new FakeSessionClient();
    const handler = createGraphTerminalNotifier(client, { emperorSessionId: EMPEROR_SESSION });
    const event = makeTerminalEvent({ isBlocked: true, phase: "executing" });

    expect(await handler(event)).toBe(true);
    expect(await handler(event)).toBe(false);
    expect(client.prompts).toHaveLength(1);
  });

  it("legally fires blocked then complete for the same graph (separate terminal types)", async () => {
    const client = new FakeSessionClient();
    const handler = createGraphTerminalNotifier(client, { emperorSessionId: EMPEROR_SESSION });

    await handler(makeTerminalEvent({ isBlocked: true, phase: "executing" }));
    await handler(makeTerminalEvent({ isBlocked: false, phase: "complete" }));
    expect(client.prompts).toHaveLength(2);
    expect(client.prompts[0].text).toContain(GRAPH_BLOCKED_MARKER);
    expect(client.prompts[1].text).toContain(GRAPH_COMPLETE_MARKER);
  });

  it("is a no-op when enabled: false", async () => {
    const client = new FakeSessionClient();
    const handler = createGraphTerminalNotifier(client, {
      emperorSessionId: EMPEROR_SESSION,
      enabled: false,
    });

    expect(await handler(makeTerminalEvent())).toBe(false);
    expect(client.prompts).toHaveLength(0);
  });

  it("is a no-op when no emperor session is configured", async () => {
    const client = new FakeSessionClient();
    const handler = createGraphTerminalNotifier(client, {});

    expect(await handler(makeTerminalEvent())).toBe(false);
    expect(client.prompts).toHaveLength(0);
  });

  it("forwards the agent option and a fresh run starts a clean epoch", async () => {
    const client = new FakeSessionClient();
    const handler = createGraphTerminalNotifier(client, {
      emperorSessionId: EMPEROR_SESSION,
      agent: "emperor",
    });
    const event = makeTerminalEvent();

    await handler(event);
    expect(client.prompts[0].agent).toBe("emperor");

    // A new notifier = new run epoch → same event re-notifies.
    const client2 = new FakeSessionClient();
    const handler2 = createGraphTerminalNotifier(client2, { emperorSessionId: EMPEROR_SESSION });
    expect(await handler2(event)).toBe(true);
    expect(client2.prompts).toHaveLength(1);
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
    const handler = createGraphTerminalNotifier(client, { emperorSessionId: EMPEROR_SESSION });

    // Must resolve and return false, not throw.
    const ok = await handler(makeTerminalEvent());
    expect(ok).toBe(false);
  });
});
