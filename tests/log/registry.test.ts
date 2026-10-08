/**
 * THE CLOSED VOCABULARY, PINNED AT RUNTIME AND (via typecheck:tests' sibling
 * scratch config) AT THE TYPE LEVEL.
 *
 * What these cases fix in place:
 *
 * 1. THE TABLE'S SECTIONS, EXACTLY. The four platform codes are the table's
 *    head, in their original order; the graph engine's nineteen follow them as
 *    four channel sections (thirteen `graph:host`, two `graph:index`, three
 *    `graph:tool`, one `graph:declare`); stage 4's per-channel sections follow
 *    those. The appended block is pinned ENTRY BY ENTRY against a fixture
 *    grouped by channel, so this suite answers "which codes exist, in which
 *    section, in what order" rather than "at least nineteen of something" —
 *    an entry dropped, reordered into another channel's section, or added
 *    without updating the fixture fails here by name.
 * 2. EVERY ENTRY IS USABLE. A level from the four, a non-empty channel, a
 *    non-empty single-line message and, when present, a positive integer
 *    throttle window.
 * 3. THE LITERAL TYPE IS PRESERVED. `as const satisfies` (not an index-signature
 *    annotation) is what makes an unregistered code a compile error; the
 *    @ts-expect-error below is that assertion, and it stays live because
 *    tsconfig.tests.json's scratch sibling compiles this file.
 * 4. A CODE OUTSIDE THE TABLE IS DROPPED, COUNTED AND REPORTED — never thrown,
 *    never silently ignored.
 * 5. AN EVENT'S level, channel AND message COME FROM THE TABLE, which is what
 *    lets a call site migrate without its sentence drifting.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  LOG_EVENTS,
  LOG_LEVELS,
  __resetLoggingForTest,
  configureLogging,
  getUnknownEventCodeCount,
  isLogEventCode,
  logEvent,
  logEventDefinition,
} from "../../src/log/index.ts";
import type { LogEventCode, LogEventDefinition } from "../../src/log/index.ts";
import { createMemorySink, type MemorySink } from "../../src/log/sinks/memory.ts";
import { beginLogTest, endLogTest } from "../helpers/log.ts";

/** The platform codes stage 1 registers, in declaration order. */
const PLATFORM_CODES: readonly string[] = [
  "log.sink.failed",
  "log.file.write-failed",
  "log.file.rotate-failed",
  "log.event.unknown-code",
];

/**
 * The GRAPH ENGINE EVENTS block: one section per channel, in the table's own
 * order, each holding every code that section declares in declaration order.
 *
 * These are the nineteen diagnostics the engine emitted before the platform
 * existed, and their counts are the engine's own mapping (13 host / 2 index /
 * 3 tool / 1 declare) — a code that moves to another channel without moving
 * section is a vocabulary change, not a refactor, so it belongs here.
 */
const ENGINE_SECTIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["graph:host", [
    "host.control-continuation.failed",
    "sweep.store-blocked",
    "sweep.summary",
    "watch.unwatched-executions",
    "watch.port-threw",
    "watch.announcement-unconfirmed",
    "watch.announcement-settled",
    "watch.settlement-threw",
    "dispatch.delivery-unproven",
    "dispatch.prime-failed",
    "dispatch.query-threw",
    "dispatch.binding-failed",
    "dispatch.unclaimed-confirmation",
  ]],
  ["graph:index", [
    "index.confirmation-refused",
    "index.release-unproven",
  ]],
  ["graph:tool", [
    "tool.control-continuation",
    "tool.control-follow-up-threw",
    "tool.cancel-delivery",
  ]],
  ["graph:declare", [
    "declare.persistence-failed",
  ]],
];

/**
 * Every section stage 4 appended after the engine's block, in table order.
 *
 * Grouped exactly the way `LOG_EVENTS` is written: the channel comment
 * introduces the entries below it, so the fixture is also the statement that a
 * code lives in the section of the channel it reports on.
 */
const STAGE_SECTIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["graph:notifications", [
    "notifications.source-unreadable",
    "notifications.lease-renewal-failed",
    "notifications.delivery-failed",
  ]],
  ["dispatch:checkpoint", [
    "checkpoint.rewrite-failed",
  ]],
  ["task:tools", [
    "tools.result-preview-failed",
    "tools.retry-failed",
  ]],
  ["dispatch:notify", [
    "notify.parent-notify-failed",
  ]],
  ["loop/worker-dispatch", [
    "worker-dispatch.started-note-failed",
    "worker-dispatch.round-cancel-failed",
    "worker-dispatch.error-note-failed",
  ]],
  ["loop/coordinator", [
    "coordinator.stale-advancing-lock",
    "coordinator.progress-note-failed",
    "coordinator.cascade-cancel-failed",
    "coordinator.resubscribe-advance-failed",
    "coordinator.task-status-read-failed",
  ]],
  ["plugin-core", [
    "plugin-core.registration-replaced",
    "plugin-core.init-skipped",
    "plugin-core.init-failed",
    "plugin-core.dispose-failed",
    "plugin-core.restart-unknown-service",
    "plugin-core.restart-no-context",
    "plugin-core.restart-dispose-failed",
  ]],
  ["plugin-hooks", [
    "plugin-hooks.hook-service-unavailable",
    "plugin-hooks.handlers-uninitialized",
  ]],
  ["service-supervisor", [
    "service-supervisor.budget-exceeded",
    "service-supervisor.permanently-degraded",
  ]],
  ["health-monitor", [
    "health-monitor.service-unhealthy",
    "health-monitor.service-degraded",
    "health-monitor.supervisor-error",
  ]],
  ["loop-service", [
    "loop-service.degraded",
    "loop-service.state-load-failed",
    "loop-service.state-reconcile-failed",
  ]],
  ["dispatch-service", [
    "dispatch-service.degraded",
    "dispatch-service.recover-failed",
    "dispatch-service.flush-failed",
  ]],
  ["hook-tool-after", [
    "tool-after.observe-failed",
    "tool-after.handler-failed",
  ]],
  ["hook-tool-before", [
    "tool-before.deprecated-tool",
  ]],
  ["handler-drain", [
    "handler-drain.inject-cap-reached",
    "handler-drain.activation-cap-reached",
  ]],
  ["hook-sys-xform", [
    "sys-xform.memory-inject-failed",
  ]],
  ["hook:custom-registry", [
    "custom-registry.on-load-failed",
    "custom-registry.hook-failed",
    "custom-registry.on-dispose-failed",
  ]],
  ["recovery:chain-executor", [
    "chain-executor.strategy-missing",
    "chain-executor.strategy-threw",
  ]],
  ["recovery:engine", [
    "engine.aborted",
    "engine.exhausted",
  ]],
  ["hook:context-window", [
    "context-window.large-output",
  ]],
  ["recovery:builtin-registry", [
    "builtin-registry.hook-failed",
  ]],
  ["memory:store", [
    "store.read-failed",
  ]],
  ["log:compat", [
    "log.field.narrowed",
  ]],
];

/** The two blocks above, in the order `LOG_EVENTS` declares them. */
const APPENDED_SECTIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ...ENGINE_SECTIONS,
  ...STAGE_SECTIONS,
];

/** Every appended code, in table order. */
const APPENDED_CODES: readonly string[] = APPENDED_SECTIONS.flatMap(([, codes]) => codes);

/**
 * The appended entries, grouped by channel in the order each channel first
 * appears — i.e. the table's section layout, read off the table itself.
 */
function observedSections(codes: readonly string[]): Array<[string, string[]]> {
  const sections: Array<[string, string[]]> = [];
  for (const code of codes) {
    const channel = logEventDefinition(code as LogEventCode).channel;
    const last = sections[sections.length - 1];
    if (last !== undefined && last[0] === channel) {
      last[1].push(code);
      continue;
    }
    sections.push([channel, [code]]);
  }
  return sections;
}

let state: { env: Record<string, string | undefined>; dir: string };
let memory: MemorySink;

beforeEach(() => {
  state = beginLogTest();
  memory = createMemorySink({ capacity: 50 });
  configureLogging({ sinks: [memory], level: "debug" });
});

afterEach(() => {
  endLogTest(state);
});

describe("closed event vocabulary", () => {
  it("keeps the platform codes as the table's first entries", () => {
    expect(Object.keys(LOG_EVENTS).slice(0, PLATFORM_CODES.length)).toEqual([...PLATFORM_CODES]);
  });

  it("holds every appended entry in its channel's section, in table order", () => {
    const appended = Object.keys(LOG_EVENTS).slice(PLATFORM_CODES.length);
    // The exact code set, in the exact order: a dropped, renamed, duplicated or
    // moved entry fails with both lists side by side.
    expect(appended).toEqual([...APPENDED_CODES]);
    // And the same entries grouped by channel: every section holds exactly the
    // codes the fixture lists for it — no code of one channel inside another
    // channel's run, no extra section, no missing one.
    expect(observedSections(appended)).toEqual(APPENDED_SECTIONS.map(([channel, codes]) => [channel, [...codes]]));
  });

  it("holds the graph engine's nineteen after the platform entries, on the engine's own channels", () => {
    const appended = Object.keys(LOG_EVENTS).slice(PLATFORM_CODES.length);
    const engineCount = ENGINE_SECTIONS.reduce((total, [, codes]) => total + codes.length, 0);
    expect(engineCount).toBe(19);
    // The engine's block is the head of the appended entries — not merely
    // present somewhere after the platform four.
    expect(appended.slice(0, engineCount)).toEqual([...ENGINE_SECTIONS.flatMap(([, codes]) => codes)]);
    // One section per engine channel, in the engine's own order, each with the
    // engine's count for that channel.
    expect(ENGINE_SECTIONS.map(([channel, codes]) => `${channel}=${codes.length}`)).toEqual([
      "graph:host=13",
      "graph:index=2",
      "graph:tool=3",
      "graph:declare=1",
    ]);
    // No appended entry reports on the platform's own "log" channel: the
    // platform section is closed above.
    for (const code of appended) {
      expect(logEventDefinition(code as LogEventCode).channel).not.toBe("log");
    }
  });

  it("gives every entry a usable level, channel and single-line message", () => {
    for (const [code, raw] of Object.entries(LOG_EVENTS)) {
      const entry = raw as LogEventDefinition;
      expect(LOG_LEVELS).toContain(entry.level);
      expect(typeof entry.channel).toBe("string");
      expect(entry.channel.length).toBeGreaterThan(0);
      expect(typeof entry.message).toBe("string");
      expect(entry.message.length).toBeGreaterThan(0);
      expect(entry.message).not.toContain("\n");
      if (entry.throttleMs !== undefined) {
        expect(Number.isInteger(entry.throttleMs)).toBe(true);
        expect(entry.throttleMs).toBeGreaterThan(0);
      }
      expect(code.length).toBeGreaterThan(0);
    }
  });

  it("preserves the literal code type instead of widening it to string", () => {
    const code: LogEventCode = "log.sink.failed";
    expect(isLogEventCode(code)).toBe(true);

    // @ts-expect-error — a code outside the table is not assignable to LogEventCode
    const invalid: LogEventCode = "nope.not-registered";
    expect(invalid as string).toBe("nope.not-registered");
  });

  it("guards a code at runtime as well, for callers without types", () => {
    expect(isLogEventCode("log.file.rotate-failed")).toBe(true);
    expect(isLogEventCode("nope.not-registered")).toBe(false);
    expect(isLogEventCode(undefined)).toBe(false);
    expect(isLogEventCode(42)).toBe(false);
    expect(isLogEventCode({ code: "log.sink.failed" })).toBe(false);
  });

  it("answers the registered definition for a registered code", () => {
    expect(logEventDefinition("log.event.unknown-code")).toBe(LOG_EVENTS["log.event.unknown-code"]);
  });

  it("takes an event's level, channel and message from the table", () => {
    logEvent("log.sink.failed", { sink: "console", error: "Error" });

    const record = memory.last();
    const entry = LOG_EVENTS["log.sink.failed"];
    expect(record?.code).toBe("log.sink.failed");
    expect(record?.level).toBe(entry.level);
    expect(record?.channel).toBe(entry.channel);
    expect(record?.message).toBe(entry.message);
    expect(record?.fields).toEqual({ sink: "console", error: "Error" });
  });

  it("drops an unregistered code, counts it and reports it once with the count", () => {
    expect(() => logEvent("nope.not-registered" as LogEventCode, { detail: 1 })).not.toThrow();
    expect(getUnknownEventCodeCount()).toBe(1);

    const report = memory.last();
    expect(report?.code).toBe("log.event.unknown-code");
    expect(report?.level).toBe(LOG_EVENTS["log.event.unknown-code"].level);
    expect(report?.channel).toBe("log");
    expect(report?.message).toBe(LOG_EVENTS["log.event.unknown-code"].message);
    expect(report?.fields).toEqual({ event: "nope.not-registered", dropped: 1 });
  });

  it("keeps counting while the report itself is suppressed by its throttle window", () => {
    logEvent("nope.one" as LogEventCode);
    logEvent("nope.two" as LogEventCode);
    logEvent("nope.three" as LogEventCode);

    expect(getUnknownEventCodeCount()).toBe(3);
    expect(memory.records().filter((record) => record.code === "log.event.unknown-code").length).toBe(1);
  });

  it("drops an unregistered code without a sink, and still counts it", () => {
    configureLogging({ sinks: [] });
    expect(() => logEvent("nope.not-registered" as LogEventCode)).not.toThrow();
    expect(getUnknownEventCodeCount()).toBe(1);
  });

  it("resets the dropped-code counter with the kernel", () => {
    logEvent("nope.one" as LogEventCode);
    expect(getUnknownEventCodeCount()).toBe(1);
    __resetLoggingForTest();
    expect(getUnknownEventCodeCount()).toBe(0);
  });
});
