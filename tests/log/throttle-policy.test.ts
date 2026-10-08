/**
 * WHICH ENTRIES MAY BE THROTTLED, AND WHICH MAY NEVER BE.
 *
 * `throttleMs` is the one field in the registry that DELETES diagnostics, so the
 * set that carries it is pinned here twice over:
 *
 * 1. AS A SET. Every throttled code and its window is listed explicitly, so
 *    adding a window to an entry is a deliberate edit to this file — not a
 *    one-word change somewhere in a 1300-line table. The evidence behind each
 *    window (records, burst sizes, repeated fields, how many records the window
 *    lets through) is in the entry's own comment and is reproducible with
 *    `bun scripts/log-event-density.ts`.
 * 2. AS A RULE. The entries whose whole value is "this just broke" are named and
 *    asserted to carry NO window: a first failure must stay visible, and because
 *    the gate is keyed by (channel, code) rather than by graph or attempt, a
 *    suppression can hide a DIFFERENT subject's first report.
 *
 * The last cases drive the real pipeline with an injected clock, so the claim
 * "a burst collapses and the loss is counted" is shown on the same code path
 * production uses.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { LOG_EVENTS, configureLogging, logEvent } from "../../src/log/index.ts";
import type { LogEventDefinition } from "../../src/log/index.ts";
import { createMemorySink, type MemorySink } from "../../src/log/sinks/memory.ts";
import { beginLogTest, endLogTest } from "../helpers/log.ts";
import { __setLogClockForTest } from "../../src/log/index.ts";

/**
 * Every entry that declares a window, with the window it declares, IN TABLE
 * ORDER (the platform's four head entries, then the engine sections, then the
 * `log:compat` section last) — the order is part of the assertion, so a window
 * added to an entry shows up in this diff.
 */
const THROTTLED: ReadonlyArray<readonly [string, number]> = [
  ["log.event.unknown-code", 60_000],
  ["sweep.summary", 10_000],
  ["dispatch.unclaimed-confirmation", 60_000],
  ["tool.control-continuation", 60_000],
  ["tool.cancel-delivery", 60_000],
  ["log.field.narrowed", 60_000],
];

/**
 * The first-failure events. Each one reports something that has NOT happened —
 * a write that failed, a delivery with no proof, a definition that never reached
 * the store — and every occurrence may be the first one about a different
 * subject, so none of them may be suppressed.
 */
const NEVER_THROTTLED: readonly string[] = [
  "log.sink.failed",
  "log.file.write-failed",
  "log.file.rotate-failed",
  "sweep.store-blocked",
  "watch.unwatched-executions",
  "watch.announcement-unconfirmed",
  "dispatch.delivery-unproven",
  "dispatch.binding-failed",
  "index.confirmation-refused",
  "index.release-unproven",
  "declare.persistence-failed",
  "tool.control-follow-up-threw",
  "plugin-core.init-failed",
  "service-supervisor.permanently-degraded",
  "health-monitor.service-degraded",
];

/** The table entry for a code, or `undefined`. */
function entryOf(code: string): LogEventDefinition | undefined {
  return (LOG_EVENTS as Record<string, LogEventDefinition>)[code];
}

describe("throttle policy", () => {
  it("throttles exactly the entries the density evidence names, with these windows", () => {
    const throttled = Object.entries(LOG_EVENTS)
      .filter(([, entry]) => (entry as LogEventDefinition).throttleMs !== undefined)
      .map(([code, entry]) => [code, (entry as LogEventDefinition).throttleMs]);
    expect(throttled).toEqual(THROTTLED.map(([code, window]) => [code, window]));
  });

  it("leaves every first-failure event unthrottled", () => {
    for (const code of NEVER_THROTTLED) {
      const entry = entryOf(code);
      expect(entry, `${code} must stay registered`).toBeDefined();
      expect(entry?.throttleMs, `${code} reports a first failure and must never be throttled`).toBeUndefined();
    }
  });

  it("keeps each window a positive whole number of milliseconds", () => {
    for (const [code, window] of THROTTLED) {
      expect(Number.isInteger(window), `${code} window must be a whole number`).toBe(true);
      expect(window, `${code} window must be positive`).toBeGreaterThan(0);
      expect(entryOf(code)?.throttleMs, `${code} window must match the table`).toBe(window);
    }
  });
});

describe("throttle policy in the pipeline", () => {
  let state: { env: Record<string, string | undefined>; dir: string };
  let memory: MemorySink;
  let now = 0;

  beforeEach(() => {
    state = beginLogTest();
    memory = createMemorySink({ capacity: 50 });
    now = 1_000;
    __setLogClockForTest(() => now);
    configureLogging({ sinks: [memory], level: "debug" });
  });

  afterEach(() => {
    endLogTest(state);
  });

  it("collapses a burst of sweeps and reports the suppressed count on the next window", () => {
    logEvent("sweep.summary", { started: [] });
    now = 1_100;
    logEvent("sweep.summary", { started: ["a"] });
    now = 9_000;
    logEvent("sweep.summary", { started: ["b"] });

    // Three sweeps inside the 10s window, one line: the burst is one observation
    // repeated, and the first sweep's own fields are what survives.
    expect(memory.size).toBe(1);
    expect(memory.last()?.fields).toEqual({ started: [] });

    now = 11_000;
    logEvent("sweep.summary", { started: ["c"] });

    expect(memory.size).toBe(2);
    expect(memory.last()?.fields).toEqual({ started: ["c"], suppressed: 2 });
  });

  it("keeps the first failure of a throttled code visible", () => {
    logEvent("dispatch.unclaimed-confirmation", { executionId: "e1", verdict: "fenced" });
    expect(memory.size).toBe(1);
    expect(memory.last()?.fields).toEqual({ executionId: "e1", verdict: "fenced" });
  });

  it("never suppresses a first-failure event, however fast it repeats", () => {
    for (let index = 0; index < 3; index++) {
      now = 1_000 + index;
      logEvent("sweep.store-blocked", { reason: "storage " + index });
    }
    expect(memory.size).toBe(3);
    expect(memory.records().every((record) => record.fields.suppressed === undefined)).toBe(true);
  });
});
