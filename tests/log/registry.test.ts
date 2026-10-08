/**
 * THE CLOSED VOCABULARY, PINNED AT RUNTIME AND (via typecheck:tests' sibling
 * scratch config) AT THE TYPE LEVEL.
 *
 * What these cases fix in place:
 *
 * 1. THE TABLE'S FAMILIES. The four platform codes are the table's head, in
 *    their original order, the graph engine's nineteen follow them on the
 *    engine's own "graph:" channels, and stage 4's engine-slice entries follow
 *    those on the channels of the modules that emit them. (Before the migration
 *    node ran, this suite pinned the platform-only intermediate state the
 *    registry marked as an insertion point; that node filled it, and stage 4
 *    appended its own per-channel sections — so the graph engine's nineteen are
 *    guarded by their channel, which is what the table actually promises.)
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

  it("holds the graph engine's events after them, on the engine's own channels", () => {
    const appended = Object.keys(LOG_EVENTS).slice(PLATFORM_CODES.length);
    // Every appended entry — the engine's nineteen and each section a later
    // stage added — reports on the channel of the module that emits it, never
    // on the platform's "log", and the engine's own channels are all still
    // present among them.
    expect(appended.length).toBeGreaterThanOrEqual(19);
    const channels = new Set(appended.map((code) => logEventDefinition(code as LogEventCode).channel));
    for (const engineChannel of ["graph:host", "graph:index", "graph:tool", "graph:declare"]) {
      expect(channels.has(engineChannel)).toBe(true);
    }
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
