/**
 * THROTTLING: OPT-IN, WINDOWED, PER SUBJECT, AND HONEST ABOUT WHAT IT DROPPED.
 *
 * Three layers are pinned here.
 *
 * 1. THE GATE ITSELF, with an injected clock so a window is crossed by moving
 *    time rather than by waiting: the first occurrence opens the window and is
 *    emitted, the ones inside it are dropped and counted, the first one after it
 *    is emitted WITH that count attached, and an entry that declares no window
 *    is never suppressed at all.
 * 2. THE PIPELINE'S USE OF IT: a drifted unknown code is counted and reported
 *    with the true running total, and the suppressed occurrences ride on that
 *    code's next report — while unthrottled events keep emitting every time.
 * 3. THE SUBJECT DIMENSION: the window is keyed by the channel, the code and the
 *    record's own subject field (`throttleBy`). Three DIFFERENT drifted codes
 *    inside one window each get their first report; only a repeat of the SAME
 *    subject is collapsed, and its count rides on the next report about that
 *    same subject — never on another subject's record, and never hidden by it.
 *    The same holds for the compatibility shell's `log.field.narrowed`, whose
 *    subject is the CALLER channel inside one registry channel (`log:compat`).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  __resetLoggingForTest,
  __setLogClockForTest,
  configureLogging,
  createLogger,
  getUnknownEventCodeCount,
  logEvent,
} from "../../src/log/index.ts";
import { createSubLogger } from "../../src/logger.ts";
import { createMemorySink, type MemorySink } from "../../src/log/sinks/memory.ts";
import { createLogThrottle, logThrottleKey } from "../../src/log/throttle.ts";
import { beginLogTest, endLogTest } from "../helpers/log.ts";

describe("throttle windows", () => {
  it("emits the first occurrence, drops the rest and reports them on the next emit", () => {
    let now = 1_000;
    const throttle = createLogThrottle({ now: () => now });
    const key = logThrottleKey("graph:host", "sweep.summary");

    expect(throttle.check(key, 1_000)).toEqual({ emit: true, suppressed: 0 });

    now = 1_100;
    expect(throttle.check(key, 1_000)).toEqual({ emit: false, suppressed: 0 });
    now = 1_500;
    expect(throttle.check(key, 1_000)).toEqual({ emit: false, suppressed: 0 });

    // Exactly at the window's end counts as a new window.
    now = 2_000;
    expect(throttle.check(key, 1_000)).toEqual({ emit: true, suppressed: 2 });

    // The emit consumed the count.
    now = 2_100;
    expect(throttle.check(key, 1_000)).toEqual({ emit: false, suppressed: 0 });
  });

  it("never suppresses an entry that declared no window", () => {
    const throttle = createLogThrottle({ now: () => 0 });
    for (const window of [undefined, 0, -5, Number.NaN]) {
      expect(throttle.check("k", window as number | undefined)).toEqual({ emit: true, suppressed: 0 });
      expect(throttle.check("k", window as number | undefined)).toEqual({ emit: true, suppressed: 0 });
    }
  });

  it("measures each key's window on its own", () => {
    let now = 0;
    const throttle = createLogThrottle({ now: () => now });
    const host = logThrottleKey("graph:host", "sweep.summary");
    const worker = logThrottleKey("graph:worker", "sweep.summary");
    const other = logThrottleKey("graph:host", "watch.port-threw");

    expect(throttle.check(host, 1_000).emit).toBe(true);
    expect(throttle.check(worker, 1_000).emit).toBe(true);
    expect(throttle.check(other, 1_000).emit).toBe(true);
    expect(throttle.check(host, 1_000).emit).toBe(false);
    expect(throttle.check(host, 1_000).suppressed).toBe(0);
    now = 1_000;
    // Two occurrences fell inside the window (the two checks above).
    expect(throttle.check(host, 1_000)).toEqual({ emit: true, suppressed: 2 });
  });

  it("opens a fresh window when the clock steps backwards", () => {
    let now = 10_000;
    const throttle = createLogThrottle({ now: () => now });
    throttle.check("k", 1_000);
    now = 5_000;
    expect(throttle.check("k", 1_000)).toEqual({ emit: true, suppressed: 0 });
  });

  it("builds a key from the channel and the code", () => {
    expect(logThrottleKey("graph:host", "a")).not.toBe(logThrottleKey("graph:worker", "a"));
    expect(logThrottleKey("graph:host", "a")).not.toBe(logThrottleKey("graph:host", "b"));
  });

  it("forgets every window on reset", () => {
    let now = 0;
    const throttle = createLogThrottle({ now: () => now });
    throttle.check("k", 1_000);
    now = 10;
    expect(throttle.check("k", 1_000).emit).toBe(false);
    throttle.reset();
    expect(throttle.check("k", 1_000)).toEqual({ emit: true, suppressed: 0 });
  });
});

describe("throttling in the pipeline", () => {
  let state: { env: Record<string, string | undefined>; dir: string };
  let memory: MemorySink;
  let now = 0;

  beforeEach(() => {
    state = beginLogTest();
    memory = createMemorySink({ capacity: 20 });
    now = 0;
    __setLogClockForTest(() => now);
    configureLogging({ sinks: [memory], level: "debug" });
  });

  afterEach(() => {
    endLogTest(state);
  });

  it("stamps records with the injected clock", () => {
    createLogger("dispatch").warn("stamped");
    expect(memory.last()?.time).toBe(0);
    now = 5_000;
    createLogger("dispatch").warn("stamped again");
    expect(memory.last()?.time).toBe(5_000);
  });

  it("suppresses a throttled event inside its window and reports the count afterwards", () => {
    logEvent("log.event.unknown-code", { event: "a" });
    logEvent("log.event.unknown-code", { event: "b" });
    logEvent("log.event.unknown-code", { event: "c" });

    expect(memory.size).toBe(1);
    expect(memory.last()?.fields).toEqual({ event: "a" });

    now = 60_000;
    logEvent("log.event.unknown-code", { event: "d" });

    expect(memory.size).toBe(2);
    expect(memory.last()?.fields).toEqual({ event: "d", suppressed: 2 });
  });

  it("never suppresses an event whose entry declares no window", () => {
    for (let index = 0; index < 3; index++) logEvent("log.sink.failed", { sink: "console", error: "Error" });
    expect(memory.size).toBe(3);
    expect(memory.records().every((record) => record.fields.suppressed === undefined)).toBe(true);
  });

  it("overwrites a caller field named suppressed with the pipeline's own count", () => {
    logEvent("log.event.unknown-code", { event: "a", suppressed: 99 });
    logEvent("log.event.unknown-code", { event: "b" });
    now = 60_000;
    logEvent("log.event.unknown-code", { event: "c", suppressed: 99 });

    expect(memory.last()?.fields).toEqual({ event: "c", suppressed: 1 });
  });

  it("clears the windows with the kernel reset", () => {
    logEvent("log.event.unknown-code", { event: "a" });
    logEvent("log.event.unknown-code", { event: "b" });
    expect(memory.size).toBe(1);

    __resetLoggingForTest();
    __setLogClockForTest(() => now);
    configureLogging({ sinks: [memory], level: "debug" });
    logEvent("log.event.unknown-code", { event: "c" });

    expect(memory.size).toBe(2);
    expect(memory.last()?.fields.suppressed).toBeUndefined();
  });

  it("names each DIFFERENT dropped code, however many drift inside one window", () => {
    // The defect this pins: keyed by (channel, code) alone, the window is one
    // window for EVERY drifted code — the first report names `AAA` and the other
    // two are silently dropped for a minute (and forever, if nothing drifts
    // again). The subject is the dropped code itself, so each one keeps its own
    // window and its own first report.
    now = 1_000;
    logEvent("drift.code.AAA" as never);
    now = 1_001;
    logEvent("drift.code.BBB" as never);
    now = 1_002;
    logEvent("drift.code.CCC" as never);

    expect(getUnknownEventCodeCount()).toBe(3);
    expect(memory.size).toBe(3);
    expect(memory.records().map((record) => record.fields.code)).toEqual([
      "drift.code.AAA",
      "drift.code.BBB",
      "drift.code.CCC",
    ]);
    expect(memory.records().map((record) => record.fields.count)).toEqual([1, 2, 3]);

    // A repeat of the FIRST code is still inside its own window and is counted
    // apart from the other two: no subject's suppression crosses into another's.
    now = 1_003;
    logEvent("drift.code.AAA" as never);
    expect(memory.size).toBe(3);
    expect(getUnknownEventCodeCount()).toBe(4);

    // ...and the count of that repeat rides on the NEXT record about `AAA`.
    now = 61_004;
    logEvent("drift.code.AAA" as never);
    const reopened = memory.last();
    expect(reopened?.fields.code).toBe("drift.code.AAA");
    expect(reopened?.fields.suppressed).toBe(1);
    // The true running total is the kernel's own counter, not the window's count.
    expect(reopened?.fields.count).toBe(5);
    expect(reopened?.fields.dropped).toBe(5);
    expect(getUnknownEventCodeCount()).toBe(5);
  });

  it("collapses repeats of ONE dropped code and reports them on that code's next record", () => {
    now = 1_000;
    logEvent("drift.code.SAME" as never);
    now = 11_000;
    logEvent("drift.code.SAME" as never);

    expect(memory.size).toBe(1);
    expect(memory.last()?.fields.suppressed).toBeUndefined();

    now = 61_001;
    logEvent("drift.code.SAME" as never);

    const reopened = memory.last();
    expect(reopened?.fields).toEqual({
      event: "drift.code.SAME",
      code: "drift.code.SAME",
      // The kernel's counter counts EVERY dropped occurrence, the suppressed one
      // included, so the true total is 3 while the window suppressed 1 of them.
      count: 3,
      dropped: 3,
      suppressed: 1,
    });
  });

  it("keys the window by the dropped code, not by the event's own code", () => {
    now = 1_000;
    logEvent("drift.code.ONE" as never);
    now = 2_000;
    logEvent("drift.code.TWO" as never);

    // Both records carry the SAME event code (`log.event.unknown-code`) and the
    // same channel; only the subject differs. One window for the pair would emit
    // one record, so two records here is the subject dimension doing its work.
    expect(memory.size).toBe(2);
    expect(memory.records().every((record) => record.code === "log.event.unknown-code")).toBe(true);
    expect(memory.records().map((record) => record.fields.code)).toEqual([
      "drift.code.ONE",
      "drift.code.TWO",
    ]);
  });
});

describe("subject-keyed windows in the compatibility shell", () => {
  let state: { env: Record<string, string | undefined>; dir: string };
  let memory: MemorySink;
  let now = 0;

  beforeEach(() => {
    state = beginLogTest();
    memory = createMemorySink({ capacity: 20 });
    now = 1_000_000;
    __setLogClockForTest(() => now);
    configureLogging({ sinks: [memory], level: "debug" });
  });

  afterEach(() => {
    endLogTest(state);
  });

  it("gives two different CALLER channels their own first narrowing report", () => {
    // `log.field.narrowed` reports on ONE registry channel (`log:compat`), so
    // without a subject its window is process-wide: whichever call site narrows
    // first owns the minute and the other's first report — and its `keys` — is
    // lost. The subject is the caller channel the record already carries.
    createSubLogger("probe:channelX").warn("narrow here", { payload: { deeply: "nested" } });
    now += 1_000;
    createSubLogger("probe:channelY").warn("narrow there", { payload: { another: "nested" } });

    const reports = memory
      .records()
      .filter((record) => record.code === "log.field.narrowed");
    expect(reports.length).toBe(2);
    expect(reports.map((record) => record.fields.channel)).toEqual([
      "probe:channelX",
      "probe:channelY",
    ]);
    // The registry channel is the same on both; the call site is what differs.
    expect(reports.every((record) => record.channel === "log:compat")).toBe(true);
  });

  it("counts the suppressed narrowing under the SAME caller channel that produced it", () => {
    const first = createSubLogger("probe:repeat");
    first.warn("narrow one", { payload: { n: 1 } });
    now += 30_000;
    first.warn("narrow two", { payload: { n: 2 } });
    // A second source narrowing inside the first source's window is NOT
    // suppressed by it, and it does not consume the first source's count.
    now += 1_000;
    createSubLogger("probe:other").warn("narrow elsewhere", { item: { n: 3 } });

    const reports = memory
      .records()
      .filter((record) => record.code === "log.field.narrowed");
    expect(reports.map((record) => record.fields.channel)).toEqual([
      "probe:repeat",
      "probe:other",
    ]);
    expect(reports[0]?.fields.suppressed).toBeUndefined();
    expect(reports[1]?.fields.suppressed).toBeUndefined();

    // The first source's suppressed occurrence rides on ITS next report only.
    now += 30_000;
    first.warn("narrow three", { payload: { n: 4 } });

    const next = memory
      .records()
      .filter((record) => record.code === "log.field.narrowed" && record.fields.channel === "probe:repeat");
    expect(next.length).toBe(2);
    expect(next[1]?.fields.suppressed).toBe(1);
    expect(next[1]?.fields.keys).toEqual(["payload"]);
  });
});
