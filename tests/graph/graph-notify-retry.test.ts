/**
 * Graph Engine — Notifier Retry Discipline (subtask S8 / H5)
 *
 * Verifies that `createGraphNotifier` and `createGraphTerminalNotifier` give
 * their `client.prompt` sends the same bounded-retry discipline as
 * `notifyParent` (src/dispatch/notification.ts:205-227):
 * - a transient failure (1st reject, 2nd success) is retried and the handler
 *   ultimately resolves `true` — exactly one reminder reaches the session;
 * - a persistent failure is retried up to `maxAttempts` (default 3) total
 *   attempts and only THEN falls through to the failure path (metric + log,
 *   resolves `false`);
 * - each retry increments the `graph_notify_retry_total` metric;
 * - dedupe semantics are unchanged: the dedupe key is claimed before the first
 *   attempt, so retries of the same event stay inside one dedupe slot and a
 *   replayed event is never sent twice — including after a permanent failure.
 *
 * Backoff is injected (tiny `baseDelayMs`/`maxDelayMs`) so the suite does not
 * sleep on the real 500ms/1000ms schedule.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from "bun:test";
import { NodeStatus } from "../../src/constants.ts";
import type { ISessionClient } from "../../src/platform/ports/session-client.ts";
import type {
  NodeCompletionEvent,
  GraphTerminalEvent,
} from "../../src/graph/engine/engine-advance.ts";
import {
  createGraphNotifier,
  createGraphTerminalNotifier,
} from "../../src/graph/engine/graph-notify.ts";
import {
  GRAPH_COMPLETION_MARKER,
  GRAPH_COMPLETE_MARKER,
  clearParentQueues,
} from "../../src/dispatch/notification.ts";
import { metrics } from "../../src/dispatch/persistence/metrics.ts";

// ── Fake ISessionClient (records prompts; optional failure injection) ────────

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

/**
 * A FakeSessionClient that rejects the first `failuresRemaining` prompt calls
 * and then behaves normally. `calls` counts every prompt invocation (including
 * failed attempts) so tests can assert the retry loop's attempt count.
 */
class FlakySessionClient extends FakeSessionClient {
  failuresRemaining: number;
  calls = 0;

  constructor(failuresRemaining = 0) {
    super();
    this.failuresRemaining = failuresRemaining;
  }

  override async prompt(
    id: string,
    options: {
      parts: Array<{ type: string; text: string }>;
      noReply?: boolean;
      agent?: string;
    },
  ): Promise<{ id: string } | null> {
    this.calls += 1;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("transient injection failure");
    }
    return super.prompt(id, options);
  }
}

/** Injected retry options — tiny delays so the suite never sleeps on backoff. */
const FAST_RETRY = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 } as const;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const EMPEROR_SESSION = "emperor-retry-42";

function makeEvent(overrides: Partial<NodeCompletionEvent> = {}): NodeCompletionEvent {
  const startedAt = overrides.startedAt ?? 1000;
  return {
    graphId: "g-retry",
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

function makeTerminalEvent(overrides: Partial<GraphTerminalEvent> = {}): GraphTerminalEvent {
  return {
    graphId: "g-term-retry",
    phase: overrides.isBlocked ? "executing" : "complete",
    nodeStatusSummaries: {
      completed: 1,
      escalate: 0,
      timeout: 0,
      blocked: overrides.isBlocked ? 1 : 0,
      running: 0,
    },
    isBlocked: false,
    ...overrides,
  };
}

// ── Metrics harness (mirrors tests/dispatch/notification.test.ts) ────────────

let prevMetricsEnv: string | undefined;
let metricsActive = false;

beforeAll(() => {
  prevMetricsEnv = process.env.ROLEBOX_METRICS;
  process.env.ROLEBOX_METRICS = "1";
  const probe = metrics.counter("_probe");
  probe.inc();
  metricsActive = metrics.counter("_probe").peek() > 0;
  metrics.reset();
});

afterAll(() => {
  if (prevMetricsEnv === undefined) {
    delete process.env.ROLEBOX_METRICS;
  } else {
    process.env.ROLEBOX_METRICS = prevMetricsEnv;
  }
});

afterEach(() => {
  metrics.reset();
  clearParentQueues();
});

// ── createGraphNotifier retry ────────────────────────────────────────────────

describe("createGraphNotifier retry discipline", () => {
  it("retries a transient client.prompt failure (1st reject, 2nd success) and succeeds", async () => {
    const client = new FlakySessionClient(1);
    const handler = createGraphNotifier(client, {
      emperorSessionId: EMPEROR_SESSION,
      ...FAST_RETRY,
    });

    const ok = await handler(makeEvent());

    // First attempt rejected, second succeeded → handler resolves true.
    expect(ok).toBe(true);
    expect(client.calls).toBe(2);
    // Exactly one reminder reached the session (retries are the same event).
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0].text).toContain(GRAPH_COMPLETION_MARKER);
    if (metricsActive) {
      expect(metrics.counter("graph_notify_retry_total").peek()).toBe(1);
      expect(metrics.counter("graph_notify_sent_total").peek()).toBe(1);
      expect(metrics.counter("graph_notify_failed_total").peek()).toBe(0);
    }
  });

  it("resolves false after 3 attempts are exhausted on persistent failure", async () => {
    const client = new FlakySessionClient(100); // always rejects
    const handler = createGraphNotifier(client, {
      emperorSessionId: EMPEROR_SESSION,
      ...FAST_RETRY,
    });

    const ok = await handler(makeEvent());

    expect(ok).toBe(false);
    expect(client.calls).toBe(3); // 1 initial + 2 retries, then give up
    expect(client.prompts).toHaveLength(0);
    if (metricsActive) {
      // 2 retries counted; failure path counted once at exhaustion.
      expect(metrics.counter("graph_notify_retry_total").peek()).toBe(2);
      expect(metrics.counter("graph_notify_failed_total").peek()).toBe(1);
      expect(metrics.counter("graph_notify_sent_total").peek()).toBe(0);
    }
  });

  it("keeps dedupe semantics: a retried event sends exactly once", async () => {
    const client = new FlakySessionClient(1);
    const handler = createGraphNotifier(client, {
      emperorSessionId: EMPEROR_SESSION,
      ...FAST_RETRY,
    });
    const event = makeEvent();

    // First call retries internally (2 prompt attempts) and succeeds.
    expect(await handler(event)).toBe(true);
    // Second call with the same key is deduped — no new send, no new retries.
    expect(await handler(event)).toBe(false);
    expect(client.calls).toBe(2);
    expect(client.prompts).toHaveLength(1);
  });

  it("keeps dedupe semantics: a permanently failed event still occupies its dedupe slot", async () => {
    const client = new FlakySessionClient(100);
    const handler = createGraphNotifier(client, {
      emperorSessionId: EMPEROR_SESSION,
      ...FAST_RETRY,
    });
    const event = makeEvent();

    // Exhausts 3 attempts → false.
    expect(await handler(event)).toBe(false);
    // Replay is deduped: no second 3-attempt retry storm for the same event.
    expect(await handler(event)).toBe(false);
    expect(client.calls).toBe(3);
    expect(client.prompts).toHaveLength(0);
  });
});

// ── createGraphTerminalNotifier retry ────────────────────────────────────────

describe("createGraphTerminalNotifier retry discipline", () => {
  it("retries a transient client.prompt failure (1st reject, 2nd success) and succeeds", async () => {
    const client = new FlakySessionClient(1);
    const handler = createGraphTerminalNotifier(client, {
      emperorSessionId: EMPEROR_SESSION,
      ...FAST_RETRY,
    });

    const ok = await handler(makeTerminalEvent());

    expect(ok).toBe(true);
    expect(client.calls).toBe(2);
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0].text).toContain(GRAPH_COMPLETE_MARKER);
    // Terminal reminders still wake the orchestrator.
    expect(client.prompts[0].noReply).toBe(false);
    if (metricsActive) {
      expect(metrics.counter("graph_notify_retry_total").peek()).toBe(1);
      expect(metrics.counter("graph_notify_sent_total").peek()).toBe(1);
      expect(metrics.counter("graph_notify_failed_total").peek()).toBe(0);
    }
  });

  it("resolves false after 3 attempts are exhausted on persistent failure", async () => {
    const client = new FlakySessionClient(100);
    const handler = createGraphTerminalNotifier(client, {
      emperorSessionId: EMPEROR_SESSION,
      ...FAST_RETRY,
    });

    const ok = await handler(makeTerminalEvent());

    expect(ok).toBe(false);
    expect(client.calls).toBe(3);
    expect(client.prompts).toHaveLength(0);
    if (metricsActive) {
      expect(metrics.counter("graph_notify_retry_total").peek()).toBe(2);
      expect(metrics.counter("graph_notify_failed_total").peek()).toBe(1);
      expect(metrics.counter("graph_notify_sent_total").peek()).toBe(0);
    }
  });

  it("keeps dedupe semantics: blocked then complete still fire separately, replays are dropped", async () => {
    const client = new FlakySessionClient(0); // never fails — pure dedupe check
    const handler = createGraphTerminalNotifier(client, {
      emperorSessionId: EMPEROR_SESSION,
      ...FAST_RETRY,
    });

    const blocked = makeTerminalEvent({ isBlocked: true, phase: "executing" });
    const complete = makeTerminalEvent();

    expect(await handler(blocked)).toBe(true);
    expect(await handler(blocked)).toBe(false); // deduped
    expect(await handler(complete)).toBe(true); // distinct terminal type
    expect(await handler(complete)).toBe(false); // deduped
    expect(client.prompts).toHaveLength(2);
    expect(client.calls).toBe(2);
  });
});
