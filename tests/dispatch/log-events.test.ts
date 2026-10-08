/**
 * THE DISPATCH SLICE'S PLACE IN THE SHARED LOG VOCABULARY.
 *
 * Stage 4 promoted the dispatch slice's recurring, identity-carrying warnings
 * into registered events. What is pinned HERE is the part the slice owns:
 *
 * 1. THE VOCABULARY. Every code this slice reports is registered in the shared
 *    table (src/log/registry.ts) at `warn` — the level the loose call sites had,
 *    so visibility does not move — and each one's sentence is a single line.
 * 2. THE CHANNELS. A code reports on the channel of the module that emits it:
 *    `dispatch:checkpoint`, `task:tools` and `dispatch:notify` (which is what
 *    the file sink turns into <logDir>/<channel>.log). The slice owns every
 *    code on those channels, so nothing outside this list can claim one.
 * 3. THE FIELD SHAPE. Identity travels in the SCOPE and data in the fields, so
 *    a record filters by `scope.sessionId` and its fields stay flat. Ids the
 *    scope vocabulary does not carry (a task id) stay fields.
 * 4. THE REAL CALL SITES. Two of the four codes are emitted by driving the
 *    production code that owns them — FileSystemCheckpointStore.cleanupExpired
 *    with its rewrite blocked, and notifyParent with a transport that refuses —
 *    rather than by calling logEvent directly.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { FileSystemCheckpointStore } from "../../src/dispatch/checkpoint/checkpoint-store.ts";
import {
  clearParentQueues,
  clearSentFinalNotifies,
  notifyParent,
} from "../../src/dispatch/notification.ts";
import { metrics } from "../../src/dispatch/persistence/metrics.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { CheckpointData } from "../../src/dispatch/types.checkpoint.ts";
import type { ISessionClient } from "../../src/platform/ports/session-client.ts";
import { beginLogTest, endLogTest } from "../helpers/log.ts";

/** Every event the dispatch slice registers, and the channel it belongs to. */
const DISPATCH_EVENTS: ReadonlyArray<readonly [LogEventCode, string]> = [
  ["checkpoint.rewrite-failed", "dispatch:checkpoint"],
  ["tools.result-preview-failed", "task:tools"],
  ["tools.retry-failed", "task:tools"],
  ["notify.parent-notify-failed", "dispatch:notify"],
];

/** The channels this slice's modules own. */
const SLICE_CHANNELS: readonly string[] = ["dispatch:checkpoint", "task:tools", "dispatch:notify"];

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
  metrics.reset();
  clearSentFinalNotifies();
  clearParentQueues();
  endLogTest(state);
});

/** A checkpoint entry whose age decides whether cleanup keeps or drops it. */
function makeCheckpoint(overrides: Partial<CheckpointData> = {}): CheckpointData {
  return {
    task_id: "task-rewrite",
    checkpoint_id: "cp-1",
    phase: "implementation",
    completed_items: ["a"],
    remaining_items: ["b"],
    created_at: new Date().toISOString(),
    ttl_ms: 3_600_000,
    ...overrides,
  };
}

/** A terminal task, shaped the way the dispatch manager materialises one. */
function makeTask(overrides: Partial<DispatchTask> = {}): DispatchTask {
  return {
    id: "bg_notify_1",
    sessionId: "child-session-1",
    parentSessionId: "parent-1",
    depth: 0,
    status: "completed",
    agent: "helper",
    prompt: "do work",
    description: "Test task description",
    startedAt: new Date(Date.now() - 5_000),
    completedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 3 },
    priority: 0,
    ...overrides,
  };
}

describe("dispatch slice event vocabulary", () => {
  it("registers exactly the slice's four events on the slice's channels", () => {
    expect(DISPATCH_EVENTS.length).toBe(4);
    for (const [code] of DISPATCH_EVENTS) {
      expect(isLogEventCode(code)).toBe(true);
      expect(LOG_EVENTS[code]).toBeDefined();
    }
    const registered = Object.entries(LOG_EVENTS)
      .filter(([, entry]) => SLICE_CHANNELS.includes(entry.channel))
      .map(([code]) => code);
    expect([...registered].sort()).toEqual(DISPATCH_EVENTS.map(([code]) => code as string).sort());
  });

  it("keeps every slice event at warn", () => {
    for (const [code] of DISPATCH_EVENTS) {
      expect(logEventDefinition(code).level).toBe("warn");
    }
  });

  it("routes every slice event to the channel of the module that emits it", () => {
    for (const [code, channel] of DISPATCH_EVENTS) {
      expect(logEventDefinition(code).channel).toBe(channel);
    }
  });

  it("keeps every message a single non-empty sentence", () => {
    for (const [code] of DISPATCH_EVENTS) {
      const { message } = logEventDefinition(code);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("\n");
    }
  });

  it("carries identity in the scope and data in the fields", () => {
    for (const [code, channel] of DISPATCH_EVENTS) {
      withLogScope({ sessionId: "s1", attemptId: "a1" }, () => {
        logEvent(code, { reason: "denied", count: 2, ok: false, ids: ["a", "b"] });
      });
      const record = memory.last();
      expect(record?.code).toBe(code);
      expect(record?.level).toBe("warn");
      expect(record?.channel).toBe(channel);
      expect(record?.scope).toEqual({ sessionId: "s1", attemptId: "a1" });
      expect(record?.fields).toEqual({ reason: "denied", count: 2, ok: false, ids: ["a", "b"] });
      for (const identity of SCOPE_KEYS) {
        expect(Object.hasOwn(record?.fields ?? {}, identity)).toBe(false);
      }
    }
  });
});

describe("the dispatch slice's events come from the modules that own them", () => {
  it("reports a blocked checkpoint rewrite from cleanupExpired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-log-events-"));
    try {
      const store = new FileSystemCheckpointStore(dir);
      await store.saveCheckpoint("task-rewrite", makeCheckpoint({
        checkpoint_id: "cp-expired",
        created_at: new Date(Date.now() - 60_000).toISOString(),
        ttl_ms: 1_000,
      }));
      await store.saveCheckpoint("task-rewrite", makeCheckpoint({
        checkpoint_id: "cp-live",
        created_at: new Date().toISOString(),
        ttl_ms: 3_600_000,
      }));
      // Block the rewrite: the store writes through "<file>.tmp", so a
      // directory sitting there fails the write the way a permission error or a
      // full disk would — after the expired entry was already dropped from the
      // in-memory copy.
      const filePath = join(dir, ".rolebox", "state", "checkpoints", "task-rewrite.json");
      mkdirSync(filePath + ".tmp");

      await store.cleanupExpired(1_000);

      const record = memory.records().find((item) => item.code === "checkpoint.rewrite-failed");
      expect(record?.level).toBe("warn");
      expect(record?.channel).toBe("dispatch:checkpoint");
      expect(record?.message).toBe(LOG_EVENTS["checkpoint.rewrite-failed"].message);
      expect(record?.fields?.taskId).toBe("task-rewrite");
      expect(typeof record?.fields?.error).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a refused parent notification from notifyParent", async () => {
    const client = {
      prompt: mock(() => Promise.reject(new Error("prompt refused"))),
    } as unknown as ISessionClient;
    const task = makeTask();

    expect(await notifyParent(client, task, 0, { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 })).toBe(false);
    // The send runs inside the per-parent queue; let the chain settle.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const record = memory.records().find((item) => item.code === "notify.parent-notify-failed");
    expect(record?.level).toBe("warn");
    expect(record?.channel).toBe("dispatch:notify");
    expect(record?.message).toBe(LOG_EVENTS["notify.parent-notify-failed"].message);
    // The parent session is identity; the task id is data the scope does not
    // carry.
    expect(record?.scope).toEqual({ sessionId: "parent-1" });
    expect(record?.fields).toEqual({ taskId: "bg_notify_1", error: "prompt refused" });
  });
});
