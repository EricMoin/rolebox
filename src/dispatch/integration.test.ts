import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { GlobalPoller } from "./global-poller";
import { SessionMonitor } from "./session-monitor";
import { detectCompletion } from "./completion-detector";
import type { CompletionSignal, SessionMessageSnapshot, TaskPollState } from "./types";
import {
  MIN_SESSION_GONE_POLLS,
  MIN_STABILITY_POLLS,
  TASK_TTL_MS,
  MESSAGE_STALENESS_TIMEOUT_MS,
  MIN_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  DEFAULT_MAX_CONCURRENT,
} from "./config";

// ── Helpers ──────────────────────────────────────────────────────────────

function noop(): void {}

function sdkResult<T>(data: T) {
  return Promise.resolve({ data, error: undefined });
}

function sdk404() {
  return Promise.resolve({ data: undefined, error: { status: 404, message: "Not found" } });
}

interface PollerMocks {
  statusFn: ReturnType<typeof mock>;
  messagesFn: ReturnType<typeof mock>;
  getFn: ReturnType<typeof mock>;
  completionDetector: ReturnType<typeof mock<(_a: unknown, _b: unknown, _c: unknown) => CompletionSignal>>;
  onCompleted: ReturnType<typeof mock<(id: string) => void>>;
  onError: ReturnType<typeof mock<(id: string, msg: string) => void>>;
  onTimeout: ReturnType<typeof mock<(id: string, reason: string) => void>>;
  client: OpencodeClient;
  sessionMonitor: SessionMonitor;
  capturedTimeoutMs: number;
  origSetTimeout: typeof globalThis.setTimeout;
}

function setupPollerMocks(): PollerMocks {
  const statusFn = mock((_opts?: unknown) => sdkResult({}));
  const messagesFn = mock((_opts?: unknown) => sdkResult([idleMsg()]));
  const getFn = mock((_opts?: unknown) => sdkResult({ id: "s" }));
  const completionDetector = mock<(_a: unknown, _b: unknown, _c: unknown) => CompletionSignal>(
    () => ({ type: "not_ready" }),
  );
  const onCompleted = mock<(id: string) => void>(noop);
  const onError = mock<(id: string, msg: string) => void>(noop);
  const onTimeout = mock<(id: string, reason: string) => void>(noop);

  const client = {
    session: { status: statusFn, messages: messagesFn, get: getFn },
  } as unknown as OpencodeClient;

  let capturedTimeoutMs = 0;
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    capturedTimeoutMs = ms ?? 0;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  return {
    statusFn, messagesFn, getFn, completionDetector, onCompleted, onError, onTimeout,
    client, sessionMonitor: new SessionMonitor(), origSetTimeout,
    get capturedTimeoutMs() { return capturedTimeoutMs; },
  };
}

function restoreTimers(m: PollerMocks): void {
  globalThis.setTimeout = m.origSetTimeout;
}

function makePoller(m: PollerMocks, maxConcurrent = DEFAULT_MAX_CONCURRENT): GlobalPoller {
  return new GlobalPoller(m.client, {
    pollIntervalMs: 3000,
    staleTimeoutMs: 2700000,
    minRuntimeMs: 5000,
    maxConcurrent,
    taskTtlMs: TASK_TTL_MS,
  }, {
    completionDetector: m.completionDetector as unknown as typeof detectCompletion,
    sessionMonitor: m.sessionMonitor,
    onTaskCompleted: m.onCompleted,
    onTaskError: m.onError,
    onTaskTimeout: m.onTimeout,
  });
}

async function runCycle(poller: GlobalPoller): Promise<void> {
  await poller.pollCycle();
}

function idleMsg(finish?: string): SessionMessageSnapshot {
  return {
    info: { role: "assistant", id: "m1", finish: finish ?? "end_turn" },
    parts: [],
  };
}

// ── BUG-1: Session vanishes → task gets error status (not stuck) ─────────

describe("BUG-1: session vanishes", () => {
  let m: PollerMocks;

  beforeEach(() => { m = setupPollerMocks(); });
  afterEach(() => { restoreTimers(m); });

  it("BUG-1: session gone → verify 404 → onTaskError + unregistered", async () => {
    m.statusFn.mockImplementation(() => sdkResult({}));
    m.getFn.mockImplementation(() => sdk404());

    const poller = makePoller(m);
    poller.registerTask("t1", "s1");

    // MIN_SESSION_GONE_POLLS = 3 cycles with empty statusMap
    for (let i = 0; i < MIN_SESSION_GONE_POLLS; i++) {
      await runCycle(poller);
    }
    // Next cycle: gone detected → verify → 404 → error
    await runCycle(poller);

    expect(m.onError).toHaveBeenCalledWith("t1", "Session disappeared");
    expect(poller.getTaskCount()).toBe(0);
  });
});

// ── BUG-2: Completion requires info.finish (not just "has text") ─────────

describe("BUG-2: finish is required", () => {
  it("BUG-2: no finish field → not_ready (old bug: text-only detection)", () => {
    const msgs: SessionMessageSnapshot[] = [
      { info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "hello" }] },
      { info: { role: "assistant", id: "a1" }, parts: [{ type: "text", text: "I have produced text output" }] },
    ];
    const status = { type: "idle" };
    const ps: TaskPollState = {
      consecutiveMissedPolls: 0, stableIdlePolls: MIN_STABILITY_POLLS,
      lastMessageCount: 0, lastProgressUpdate: Date.now(), hasProducedOutput: true,
    };

    // No finish field → should return not_ready
    const result = detectCompletion(msgs, status, ps);
    expect(result.type).toBe("not_ready");
  });

  it("BUG-2: finish=end_turn → completed (proves text-only bug is fixed)", () => {
    const msgs: SessionMessageSnapshot[] = [
      { info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "hello" }] },
      { info: { role: "assistant", id: "a1", finish: "end_turn" }, parts: [{ type: "text", text: "Done." }] },
    ];
    const status = { type: "idle" };
    const ps: TaskPollState = {
      consecutiveMissedPolls: 0, stableIdlePolls: MIN_STABILITY_POLLS,
      lastMessageCount: 0, lastProgressUpdate: Date.now(), hasProducedOutput: true,
    };

    // Has finish=end_turn + enough stability → should complete
    const result = detectCompletion(msgs, status, ps);
    expect(result.type).toBe("completed");
  });

  it("BUG-2: finish=stop (non-terminal) still returns not_ready", () => {
    const msgs: SessionMessageSnapshot[] = [
      { info: { role: "assistant", id: "a1", finish: "stop" }, parts: [{ type: "text", text: "Output" }] },
    ];
    const status = { type: "idle" };
    const ps: TaskPollState = {
      consecutiveMissedPolls: 0, stableIdlePolls: MIN_STABILITY_POLLS,
      lastMessageCount: 0, lastProgressUpdate: Date.now(), hasProducedOutput: true,
    };

    const result = detectCompletion(msgs, status, ps);
    expect(result.type).toBe("not_ready");
  });
});

// ── BUG-3: Stability — single idle poll does NOT trigger completion ──────

describe("BUG-3: stability gating", () => {
  let m: PollerMocks;

  beforeEach(() => { m = setupPollerMocks(); });
  afterEach(() => { restoreTimers(m); });

  it("BUG-3: 1 stabilizing cycle → NOT completed", async () => {
    m.statusFn.mockImplementation(() => sdkResult({ s1: { type: "idle" } }));
    m.completionDetector.mockImplementation(() => ({ type: "stabilizing" }));

    const poller = makePoller(m);
    poller.registerTask("t1", "s1");

    await runCycle(poller);
    expect(m.onCompleted).toHaveBeenCalledTimes(0);
  });

  it("BUG-3: 2 stabilizing cycles → still NOT completed", async () => {
    m.statusFn.mockImplementation(() => sdkResult({ s1: { type: "idle" } }));
    m.completionDetector.mockImplementation(() => ({ type: "stabilizing" }));

    const poller = makePoller(m);
    poller.registerTask("t1", "s1");

    await runCycle(poller);
    await runCycle(poller);
    expect(m.onCompleted).toHaveBeenCalledTimes(0);
  });

  it("BUG-3: 3 stabilizing cycles → completed (MIN_STABILITY_POLLS=3)", async () => {
    m.statusFn.mockImplementation(() => sdkResult({ s1: { type: "idle" } }));
    m.completionDetector.mockImplementation(() => ({ type: "stabilizing" }));

    const poller = makePoller(m);
    poller.registerTask("t1", "s1");

    // Cycle 1: needsFetch=true → detector returns "stabilizing" → stableIdlePolls=1
    await runCycle(poller);
    // Cycle 2: needsFetch=false → stableIdlePolls > 0 && < 3 → stableIdlePolls=2
    await runCycle(poller);
    // Cycle 3: stableIdlePolls ≥ 3 → completed
    await runCycle(poller);

    expect(m.onCompleted).toHaveBeenCalledWith("t1");
    expect(poller.getTaskCount()).toBe(0);
  });
});

// ── BUG-4: N tasks = 1 status() call per cycle ──────────────────────────

describe("BUG-4: single status() call", () => {
  let m: PollerMocks;

  beforeEach(() => { m = setupPollerMocks(); });
  afterEach(() => { restoreTimers(m); });

  it("BUG-4: 5 registered tasks → exactly 1 status() call per cycle", async () => {
    m.statusFn.mockImplementation(() => sdkResult({
      "s1": { type: "busy" }, "s2": { type: "busy" },
      "s3": { type: "busy" }, "s4": { type: "busy" }, "s5": { type: "busy" },
    }));

    const poller = makePoller(m);
    for (let i = 1; i <= 5; i++) {
      poller.registerTask(`t${i}`, `s${i}`);
    }

    await runCycle(poller);
    expect(m.statusFn).toHaveBeenCalledTimes(1);
  });
});

// ── BUG-5: Layered timeouts — different thresholds ──────────────────────

describe("BUG-5: layered timeouts", () => {
  let m: PollerMocks;

  beforeEach(() => { m = setupPollerMocks(); });
  afterEach(() => { restoreTimers(m); });

  it("BUG-5a: never-produced output → 'Never produced output' timeout", async () => {
    m.statusFn.mockImplementation(() => sdkResult({ s1: { type: "idle" } }));
    m.completionDetector.mockImplementation(() => ({ type: "not_ready" }));

    const poller = makePoller(m);
    poller.registerTask("t1", "s1");

    poller.setTaskTiming("t1", {
      registeredAt: Date.now() - MESSAGE_STALENESS_TIMEOUT_MS - 1000,
      hasProducedOutput: false,
    });

    await runCycle(poller);

    expect(m.onTimeout).toHaveBeenCalledWith("t1", "Never produced output");
    expect(poller.getTaskCount()).toBe(0);
  });

  it("BUG-5b: stale task → 'Task stalled' timeout", async () => {
    m.statusFn.mockImplementation(() => sdkResult({ s1: { type: "idle" } }));
    m.completionDetector.mockImplementation(() => ({ type: "not_ready" }));

    const poller = makePoller(m);
    poller.registerTask("t1", "s1");

    poller.setTaskTiming("t1", {
      hasProducedOutput: true,
      lastProgressUpdate: Date.now() - 3_000_000,
    });

    await runCycle(poller);

    expect(m.onTimeout).toHaveBeenCalledWith("t1", "Task stalled");
    expect(poller.getTaskCount()).toBe(0);
  });

  it("BUG-5c: timeout uses different thresholds for each layer", async () => {
    m.statusFn.mockImplementation(() => sdkResult({ s1: { type: "idle" } }));
    m.completionDetector.mockImplementation(() => ({ type: "not_ready" }));

    const poller = makePoller(m);
    poller.registerTask("t1", "s1");

    poller.setTaskTiming("t1", {
      hasProducedOutput: true,
      lastProgressUpdate: Date.now() - 1000,
    });

    await runCycle(poller);

    expect(m.onTimeout).toHaveBeenCalledTimes(0);
  });
});

// ── BUG-6: TTL at 30 min (was 10 min) ──────────────────────────────────

describe("BUG-6: TTL=30 min", () => {
  it("BUG-6: TASK_TTL_MS equals 1_800_000 (30 min, up from old 600_000)", () => {
    expect(TASK_TTL_MS).toBe(1_800_000);
  });

  it("BUG-6: TTL is NOT the old 600_000 (10 min)", () => {
    expect(TASK_TTL_MS).not.toBe(600_000);
  });
});

// ── BUG-7: Concurrent completions ───────────────────────────────────────

describe("BUG-7: concurrent completions", () => {
  let m: PollerMocks;

  beforeEach(() => { m = setupPollerMocks(); });
  afterEach(() => { restoreTimers(m); });

  it("BUG-7: 3 tasks complete simultaneously in one cycle", async () => {
    m.statusFn.mockImplementation(() => sdkResult({
      s1: { type: "idle" }, s2: { type: "idle" }, s3: { type: "idle" },
    }));
    m.completionDetector.mockImplementation(() => ({ type: "completed" }));

    const poller = makePoller(m);
    poller.registerTask("t1", "s1");
    poller.registerTask("t2", "s2");
    poller.registerTask("t3", "s3");

    await runCycle(poller);

    expect(m.onCompleted).toHaveBeenCalledTimes(3);
    expect(m.onCompleted).toHaveBeenCalledWith("t1");
    expect(m.onCompleted).toHaveBeenCalledWith("t2");
    expect(m.onCompleted).toHaveBeenCalledWith("t3");
    expect(poller.getTaskCount()).toBe(0);
  });
});

// ── Integration: Full completion flow ──────────────────────────────────

describe("integration: full completion flow", () => {
  let m: PollerMocks;

  beforeEach(() => { m = setupPollerMocks(); });
  afterEach(() => { restoreTimers(m); });

  it("8. register → idle+completed signal → onTaskCompleted → unregistered", async () => {
    m.statusFn.mockImplementation(() => sdkResult({ s1: { type: "idle" } }));
    m.completionDetector.mockImplementation(() => ({ type: "completed" }));

    const poller = makePoller(m);
    poller.registerTask("t1", "s1");
    expect(poller.getTaskCount()).toBe(1);

    await runCycle(poller);

    expect(m.onCompleted).toHaveBeenCalledWith("t1");
    expect(poller.getTaskCount()).toBe(0);
  });
});

// ── Integration: Busy then idle then complete ──────────────────────────

describe("integration: busy → idle → complete", () => {
  let m: PollerMocks;

  beforeEach(() => { m = setupPollerMocks(); });
  afterEach(() => { restoreTimers(m); });

  it("9. busy → idle/stabilizing → idle/completed progression", async () => {
    // Cycle 1: busy
    m.statusFn.mockImplementation(() => sdkResult({ s1: { type: "busy" } }));
    const poller = makePoller(m);
    poller.registerTask("t1", "s1");
    await runCycle(poller);
    expect(m.onCompleted).toHaveBeenCalledTimes(0);

    // Cycle 2: idle, detector returns stabilizing
    m.statusFn.mockImplementation(() => sdkResult({ s1: { type: "idle" } }));
    m.completionDetector.mockImplementation(() => ({ type: "stabilizing" }));
    await runCycle(poller);
    expect(m.onCompleted).toHaveBeenCalledTimes(0);

    // Cycle 3: idle, still stabilizing
    await runCycle(poller);
    expect(m.onCompleted).toHaveBeenCalledTimes(0);

    // Cycle 4: idle, stability reached
    m.completionDetector.mockImplementation(() => ({ type: "completed" }));
    await runCycle(poller);

    expect(m.onCompleted).toHaveBeenCalledWith("t1");
    expect(poller.getTaskCount()).toBe(0);
  });
});

// ── Integration: Cancel during stabilization ───────────────────────────

describe("integration: cancel during stabilization", () => {
  let m: PollerMocks;

  beforeEach(() => { m = setupPollerMocks(); });
  afterEach(() => { restoreTimers(m); });

  it("10. cancel during stabilization → no more callbacks, task removed", async () => {
    m.statusFn.mockImplementation(() => sdkResult({ s1: { type: "idle" } }));
    m.completionDetector.mockImplementation(() => ({ type: "stabilizing" }));

    const poller = makePoller(m);
    poller.registerTask("t1", "s1");

    // One stabilizing cycle
    await runCycle(poller);
    expect(m.onCompleted).toHaveBeenCalledTimes(0);

    // Cancel: unregister mid-way
    poller.unregisterTask("t1");
    expect(poller.getTaskCount()).toBe(0);

    // Poller stops (no tasks), so no more cycles/callbacks
    expect(poller.isRunning()).toBe(false);

    // Run cycle anyway to verify no callbacks for removed task
    m.statusFn.mockImplementation(() => sdkResult({ s1: { type: "idle" } }));
    await runCycle(poller);
    expect(m.onCompleted).toHaveBeenCalledTimes(0);
    expect(m.onError).toHaveBeenCalledTimes(0);
    expect(m.onTimeout).toHaveBeenCalledTimes(0);
  });
});

// ── Integration: Session flapping ──────────────────────────────────────

describe("integration: session flapping", () => {
  let m: PollerMocks;

  beforeEach(() => { m = setupPollerMocks(); });
  afterEach(() => { restoreTimers(m); });

  it("11. busy → idle → busy → idle → stable idle → complete", async () => {
    const poller = makePoller(m);

    // Cycle 1: busy — task starts working
    m.statusFn.mockImplementation(() => sdkResult({ s1: { type: "busy" } }));
    poller.registerTask("t1", "s1");
    await runCycle(poller);

    // Cycle 2: idle with stabilizing signal → stableIdlePolls=1
    m.statusFn.mockImplementation(() => sdkResult({ s1: { type: "idle" } }));
    m.completionDetector.mockImplementation(() => ({ type: "stabilizing" }));
    await runCycle(poller);

    // Cycle 3: flap back to busy — resets stableIdlePolls to 0
    m.statusFn.mockImplementation(() => sdkResult({ s1: { type: "busy" } }));
    await runCycle(poller);
    expect(m.onCompleted).toHaveBeenCalledTimes(0);

    poller.resetMessageCount("t1");

    // Cycle 4: idle again, triggers re-fetch → stabilizing → stableIdlePolls=1
    m.statusFn.mockImplementation(() => sdkResult({ s1: { type: "idle" } }));
    m.completionDetector.mockImplementation(() => ({ type: "stabilizing" }));
    await runCycle(poller);

    // Cycle 5: cached → else-if → stableIdlePolls=2
    await runCycle(poller);

    // Cycle 6: cached → else-if → stableIdlePolls=3 → completed
    await runCycle(poller);

    expect(m.onCompleted).toHaveBeenCalledWith("t1");
    expect(poller.getTaskCount()).toBe(0);
  });
});

// ── Integration: Zero messages first poll ──────────────────────────────

describe("integration: zero messages", () => {
  let m: PollerMocks;

  beforeEach(() => { m = setupPollerMocks(); });
  afterEach(() => { restoreTimers(m); });

  it("12. zero messages + idle → not_ready → no error, no timeout", async () => {
    m.statusFn.mockImplementation(() => sdkResult({ s1: { type: "idle" } }));
    m.messagesFn.mockImplementation(() => sdkResult([])); // zero messages
    m.completionDetector.mockImplementation(() => ({ type: "not_ready" }));

    const poller = makePoller(m);
    poller.registerTask("t1", "s1");

    await runCycle(poller);

    expect(m.onCompleted).toHaveBeenCalledTimes(0);
    expect(m.onError).toHaveBeenCalledTimes(0);
    expect(m.onTimeout).toHaveBeenCalledTimes(0);
    expect(poller.getTaskCount()).toBe(1); // still registered, waiting
  });
});

// ── Integration: Session returns after being "gone" ────────────────────

describe("integration: session returns after being gone", () => {
  let m: PollerMocks;

  beforeEach(() => { m = setupPollerMocks(); });
  afterEach(() => { restoreTimers(m); });

  it("13. session reappears after 2 uncertain polls → counter resets", async () => {
    m.statusFn.mockImplementation(() => sdkResult({})); // empty map
    const poller = makePoller(m);
    poller.registerTask("t1", "s1");

    // 2 polls below MIN_SESSION_GONE_POLLS → uncertain, no error
    await runCycle(poller);
    await runCycle(poller);
    expect(m.onError).toHaveBeenCalledTimes(0);

    // Session returns on 3rd poll
    m.statusFn.mockImplementation(() => sdkResult({ s1: { type: "busy" } }));
    await runCycle(poller);

    // Should be active now, counter reset. No error.
    expect(m.onError).toHaveBeenCalledTimes(0);

    // Verify it stays active
    await runCycle(poller);
    expect(m.onError).toHaveBeenCalledTimes(0);
  });

  it("13b. session gone for 3+ polls → 'gone' then 404 → error", async () => {
    m.statusFn.mockImplementation(() => sdkResult({})); // empty map
    m.getFn.mockImplementation(() => sdk404());
    const poller = makePoller(m);
    poller.registerTask("t1", "s1");

    // 3 uncertain → next is gone
    for (let i = 0; i < MIN_SESSION_GONE_POLLS; i++) {
      await runCycle(poller);
    }
    // "gone" triggers verify → 404 → error
    await runCycle(poller);

    expect(m.onError).toHaveBeenCalledWith("t1", "Session disappeared");
    expect(poller.getTaskCount()).toBe(0);
  });
});

// ── Integration: Adaptive interval ─────────────────────────────────────

describe("integration: adaptive interval", () => {
  it("14. 1 task → interval ≈ MAX (5000ms)", async () => {
    const m = setupPollerMocks();
    try {
      m.statusFn.mockImplementation(() => sdkResult({ s1: { type: "busy" } }));
      const poller = makePoller(m, 5);
      poller.registerTask("t1", "s1");
      await runCycle(poller);
      expect(m.capturedTimeoutMs).toBe(MAX_POLL_INTERVAL_MS);
    } finally {
      restoreTimers(m);
    }
  });

  it("14b. 5 tasks (≥80% of 5) → interval ≈ MIN (500ms)", async () => {
    const m = setupPollerMocks();
    try {
      m.statusFn.mockImplementation(() => sdkResult({
        s1: { type: "busy" }, s2: { type: "busy" },
        s3: { type: "busy" }, s4: { type: "busy" }, s5: { type: "busy" },
      }));
      const poller = makePoller(m, 5);
      for (let i = 1; i <= 5; i++) {
        poller.registerTask(`t${i}`, `s${i}`);
      }
      await runCycle(poller);
      expect(m.capturedTimeoutMs).toBe(MIN_POLL_INTERVAL_MS);
    } finally {
      restoreTimers(m);
    }
  });
});
