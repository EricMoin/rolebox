import { describe, it, expect, mock, afterEach } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { SessionPoller } from "./poller";

// ── helpers ──────────────────────────────────────────────────────

function createMockClient(statusData?: unknown, messagesData?: unknown) {
  return {
    session: {
      status: mock(() =>
        Promise.resolve({
          data: (statusData as Record<string, unknown>) ?? {},
          error: undefined,
        }),
      ),
      messages: mock(() =>
        Promise.resolve({
          data: (messagesData as unknown[]) ?? [],
          error: undefined,
        }),
      ),
    },
  } as unknown as OpencodeClient;
}

const fastConfig = {
  pollIntervalMs: 10,
  minRuntimeMs: 100,
  staleTimeoutMs: 200,
};

const TASK_ID = "bg_test123";
const SESSION_ID = "session-abc";

// ── tests ────────────────────────────────────────────────────────

describe("SessionPoller", () => {
  afterEach(() => {
    mock.restore();
  });

  // ── 1. detects completion ────────────────────────────────────

  it("calls onComplete when session is idle and has assistant output", async () => {
    const messages = [
      {
        info: { role: "assistant" as const },
        parts: [{ type: "text" as const, text: "Task done" }],
      },
    ];
    const statusMap = { [SESSION_ID]: { type: "idle" as const } };

    const client = createMockClient(statusMap, messages);
    const poller = new SessionPoller(client, { ...fastConfig, minRuntimeMs: 0 });

    const onComplete = mock((_id: string) => {});
    const onError = mock((_id: string, _err: string) => {});
    const onTimeout = mock((_id: string) => {});

    // call _poll directly (private method accessed for testing)
    await (poller as any)._poll(
      TASK_ID,
      SESSION_ID,
      onComplete,
      onError,
      onTimeout,
    );

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(TASK_ID);
    expect(onError).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  // ── 2. idle deferral ─────────────────────────────────────────

  it("does not trigger completion within minRuntimeMs even if idle", async () => {
    const messages = [
      {
        info: { role: "assistant" as const },
        parts: [{ type: "text" as const, text: "result" }],
      },
    ];
    const statusMap = { [SESSION_ID]: { type: "idle" as const } };

    const client = createMockClient(statusMap, messages);
    const poller = new SessionPoller(client, {
      ...fastConfig,
      minRuntimeMs: 2000,
    });

    const onComplete = mock((_id: string) => {});
    const onError = mock((_id: string, _err: string) => {});
    const onTimeout = mock((_id: string) => {});

    // start() records start time = now
    poller.start(TASK_ID, SESSION_ID, onComplete, onError, onTimeout);

    // call _poll immediately — within minRuntimeMs → should defer
    await (poller as any)._poll(
      TASK_ID,
      SESSION_ID,
      onComplete,
      onError,
      onTimeout,
    );

    expect(onComplete).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();

    poller.stop(TASK_ID);
  });

  // ── 3. stale detection ───────────────────────────────────────

  it("triggers onTimeout when session is idle but stale (no progress within staleTimeoutMs)", async () => {
    const messages: unknown[] = [];
    const statusMap = { [SESSION_ID]: { type: "idle" as const } };

    const client = createMockClient(statusMap, messages);
    const poller = new SessionPoller(client, {
      ...fastConfig,
      minRuntimeMs: 0,
      staleTimeoutMs: 50,
    });

    const onComplete = mock((_id: string) => {});
    const onError = mock((_id: string, _err: string) => {});
    const onTimeout = mock((_id: string) => {});

    poller.start(TASK_ID, SESSION_ID, onComplete, onError, onTimeout);

    // simulate old last progress timestamp to trigger stale detection
    const oldTime = Date.now() - 10000;
    (poller as unknown as Record<string, Map<string, number>>).lastProgress.set(TASK_ID, oldTime);
    (poller as unknown as Record<string, Map<string, number>>).taskStartTimes.set(TASK_ID, oldTime);

    await (poller as any)._poll(
      TASK_ID,
      SESSION_ID,
      onComplete,
      onError,
      onTimeout,
    );

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith(TASK_ID);
    expect(onComplete).not.toHaveBeenCalled();
  });

  // ── 4. busy/retry resets progress timer ──────────────────────

  it("updates lastProgress when session is busy or retrying", async () => {
    const statusMap = { [SESSION_ID]: { type: "busy" as const } };
    const client = createMockClient(statusMap, []);
    const poller = new SessionPoller(client, fastConfig);

    const onComplete = mock((_id: string) => {});
    const onError = mock((_id: string, _err: string) => {});
    const onTimeout = mock((_id: string) => {});

    poller.start(TASK_ID, SESSION_ID, onComplete, onError, onTimeout);

    const oldTime = Date.now() - 10000;
    (poller as unknown as Record<string, Map<string, number>>).lastProgress.set(TASK_ID, oldTime);

    await (poller as any)._poll(
      TASK_ID,
      SESSION_ID,
      onComplete,
      onError,
      onTimeout,
    );

    // lastProgress should be updated (not triggering timeout)
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();

    poller.stop(TASK_ID);
  });

  // ── 5. stop() and isPolling() ─────────────────────────────────

  it("stop() clears interval and isPolling() returns false after", () => {
    const client = createMockClient();
    const poller = new SessionPoller(client, fastConfig);

    const onComplete = mock((_id: string) => {});
    const onError = mock((_id: string, _err: string) => {});
    const onTimeout = mock((_id: string) => {});

    poller.start(TASK_ID, SESSION_ID, onComplete, onError, onTimeout);
    expect(poller.isPolling(TASK_ID)).toBe(true);

    poller.stop(TASK_ID);
    expect(poller.isPolling(TASK_ID)).toBe(false);
  });

  it("stop() is idempotent — calling twice does not throw", () => {
    const client = createMockClient();
    const poller = new SessionPoller(client, fastConfig);

    const onComplete = mock((_id: string) => {});
    const onError = mock((_id: string, _err: string) => {});
    const onTimeout = mock((_id: string) => {});

    poller.start(TASK_ID, SESSION_ID, onComplete, onError, onTimeout);
    poller.stop(TASK_ID);

    expect(() => poller.stop(TASK_ID)).not.toThrow();
    expect(() => poller.stop("never-started")).not.toThrow();
  });

  // ── 6. start() does not double-register ──────────────────────

  it("start() ignores duplicate calls for the same taskId", () => {
    const client = createMockClient();
    const poller = new SessionPoller(client, fastConfig);

    const c1 = mock((_id: string) => {});
    const e1 = mock((_id: string, _err: string) => {});
    const t1 = mock((_id: string) => {});

    const c2 = mock((_id: string) => {});
    const e2 = mock((_id: string, _err: string) => {});
    const t2 = mock((_id: string) => {});

    poller.start(TASK_ID, SESSION_ID, c1, e1, t1);
    // second start with same taskId should be ignored
    poller.start(TASK_ID, SESSION_ID, c2, e2, t2);

    expect(poller.isPolling(TASK_ID)).toBe(true);

    poller.stop(TASK_ID);
  });

  // ── 7. stopAll() ─────────────────────────────────────────────

  it("stopAll() stops all active polls", () => {
    const client = createMockClient();
    const poller = new SessionPoller(client, fastConfig);

    const cb = mock((_id: string) => {});
    const eb = mock((_id: string, _err: string) => {});
    const tb = mock((_id: string) => {});

    poller.start("task-a", "session-a", cb, eb, tb);
    poller.start("task-b", "session-b", cb, eb, tb);
    poller.start("task-c", "session-c", cb, eb, tb);

    expect(poller.isPolling("task-a")).toBe(true);
    expect(poller.isPolling("task-b")).toBe(true);
    expect(poller.isPolling("task-c")).toBe(true);

    poller.stopAll();

    expect(poller.isPolling("task-a")).toBe(false);
    expect(poller.isPolling("task-b")).toBe(false);
    expect(poller.isPolling("task-c")).toBe(false);
  });
});
