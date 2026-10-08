/**
 * THE LOOP SLICE'S PLACE IN THE SHARED LOG VOCABULARY.
 *
 * Stage 4 promoted the loop slice's recurring, identity-carrying warnings into
 * registered events. What is pinned HERE is the part the slice owns:
 *
 * 1. THE VOCABULARY. Every code this slice reports is registered in the shared
 *    table (src/log/registry.ts) at `warn` — the level the loose call sites had,
 *    so visibility does not move — and each one's sentence is a single line.
 * 2. THE CHANNELS. A code reports on the channel of the module that emits it:
 *    `loop/coordinator` and `loop/worker-dispatch` (which is what the file sink
 *    turns into <logDir>/<channel>.log). The slice owns every code on those
 *    channels, so nothing outside this list can claim one.
 * 3. THE FIELD SHAPE. A loop is identified by its origin session, which travels
 *    in the SCOPE as `sessionId`; the worker task id, the phase and the failure
 *    text are data and stay fields.
 * 4. A REAL CALL SITE. The sweeper's event is emitted by driving the
 *    production sweeper (LoopCoordinator._sweepStaleLocks) over an abandoned
 *    lock, rather than by calling logEvent directly.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import {
  LOG_EVENTS,
  __resetLoggingForTest,
  configureLogging,
  isLogEventCode,
  logEvent,
  logEventDefinition,
  withLogScope,
} from "../../src/log/index.ts";
import type { LogEventCode } from "../../src/log/index.ts";
import { createMemorySink, type MemorySink } from "../../src/log/sinks/memory.ts";
import { ADVANCING_LOCK_TIMEOUT_MS } from "../../src/loop/constants.ts";
import { LoopCoordinator } from "../../src/loop/coordinator.ts";
import type { IDispatchAdapter } from "../../src/loop/dispatch-adapter.ts";
import { beginLogTest, endLogTest } from "../helpers/log.ts";

/** Every event the loop slice registers, and the channel it belongs to. */
const LOOP_EVENTS: ReadonlyArray<readonly [LogEventCode, string]> = [
  ["coordinator.stale-advancing-lock", "loop/coordinator"],
  ["coordinator.progress-note-failed", "loop/coordinator"],
  ["coordinator.cascade-cancel-failed", "loop/coordinator"],
  ["coordinator.resubscribe-advance-failed", "loop/coordinator"],
  ["coordinator.task-status-read-failed", "loop/coordinator"],
  ["worker-dispatch.started-note-failed", "loop/worker-dispatch"],
  ["worker-dispatch.round-cancel-failed", "loop/worker-dispatch"],
  ["worker-dispatch.error-note-failed", "loop/worker-dispatch"],
];

/** The channels this slice's modules own. */
const SLICE_CHANNELS: readonly string[] = ["loop/coordinator", "loop/worker-dispatch"];

/** The identity names a record carries in its scope instead of its fields. */
const SCOPE_KEYS: readonly string[] = ["sessionId", "graphId", "attemptId", "effectId"];

let state: { env: Record<string, string | undefined>; dir: string };
let memory: MemorySink;

beforeEach(() => {
  state = beginLogTest();
  memory = createMemorySink({ capacity: 64 });
  configureLogging({ sinks: [memory], level: "debug" });
});

afterEach(() => {
  endLogTest(state);
});

/**
 * A quiet adapter: none of its methods is reached by the cases below, but the
 * coordinator's constructor and sweeper need a total IDispatchAdapter.
 */
function createFakeAdapter(): IDispatchAdapter {
  let round = 0;
  return {
    dispatchRound: mock(async () => {
      round += 1;
      return { workerTaskId: `task-${round}`, workerSessionId: `session-${round}` };
    }),
    getRoundResult: mock(async () => ({ text: "worker output", hadError: false })),
    cancelRound: mock(async () => {}),
    readOriginSummary: mock(async () => "Round summary."),
    getLastMessageId: mock(async () => "msg-boundary"),
    injectNote: mock(async () => {}),
    registerTerminatedListener: mock(
      (_taskId: string, callback: (taskId: string, status: string) => void) => callback,
    ),
    removeTerminatedListener: mock(() => {}),
    getTaskStatus: mock(async () => "completed"),
  };
}

describe("loop slice event vocabulary", () => {
  it("registers exactly the slice's eight events on the slice's channels", () => {
    expect(LOOP_EVENTS.length).toBe(8);
    for (const [code] of LOOP_EVENTS) {
      expect(isLogEventCode(code)).toBe(true);
      expect(LOG_EVENTS[code]).toBeDefined();
    }
    const registered = Object.entries(LOG_EVENTS)
      .filter(([, entry]) => SLICE_CHANNELS.includes(entry.channel))
      .map(([code]) => code);
    expect([...registered].sort()).toEqual(LOOP_EVENTS.map(([code]) => code as string).sort());
  });

  it("keeps every slice event at warn", () => {
    for (const [code] of LOOP_EVENTS) {
      expect(logEventDefinition(code).level).toBe("warn");
    }
  });

  it("routes every slice event to the channel of the module that emits it", () => {
    const counts: Record<string, number> = {};
    for (const [code, channel] of LOOP_EVENTS) {
      expect(logEventDefinition(code).channel).toBe(channel);
      counts[channel] = (counts[channel] ?? 0) + 1;
    }
    expect(counts).toEqual({ "loop/coordinator": 5, "loop/worker-dispatch": 3 });
  });

  it("keeps every message a single non-empty sentence", () => {
    for (const [code] of LOOP_EVENTS) {
      const { message } = logEventDefinition(code);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("\n");
    }
  });

  it("carries identity in the scope and data in the fields", () => {
    for (const [code, channel] of LOOP_EVENTS) {
      withLogScope({ sessionId: "loop-1", attemptId: "a1" }, () => {
        logEvent(code, { taskId: "task-1", count: 2, ok: false, ids: ["a", "b"] });
      });
      const record = memory.last();
      expect(record?.code).toBe(code);
      expect(record?.level).toBe("warn");
      expect(record?.channel).toBe(channel);
      expect(record?.scope).toEqual({ sessionId: "loop-1", attemptId: "a1" });
      expect(record?.fields).toEqual({ taskId: "task-1", count: 2, ok: false, ids: ["a", "b"] });
      for (const identity of SCOPE_KEYS) {
        expect(Object.hasOwn(record?.fields ?? {}, identity)).toBe(false);
      }
    }
  });
});

describe("the loop slice's events come from the modules that own them", () => {
  it("reports a swept stale advancing lock from the coordinator's sweeper", () => {
    const coordinator = new LoopCoordinator(createFakeAdapter());
    try {
      const internals = coordinator as unknown as {
        _advancing: Map<string, number>;
        _sweepStaleLocks: () => void;
      };
      internals._advancing.set("loop-1", Date.now() - ADVANCING_LOCK_TIMEOUT_MS - 10_000);

      internals._sweepStaleLocks();

      const record = memory.records().find((item) => item.code === "coordinator.stale-advancing-lock");
      expect(record?.level).toBe("warn");
      expect(record?.channel).toBe("loop/coordinator");
      expect(record?.message).toBe(LOG_EVENTS["coordinator.stale-advancing-lock"].message);
      // The loop is its origin session; the age of the abandoned lock is data.
      expect(record?.scope).toEqual({ sessionId: "loop-1" });
      expect(typeof record?.fields?.acquiredAgeMs).toBe("number");
    } finally {
      coordinator.dispose();
    }
  });
});
