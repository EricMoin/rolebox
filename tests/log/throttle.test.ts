/**
 * THROTTLING: OPT-IN, WINDOWED, AND HONEST ABOUT WHAT IT DROPPED.
 *
 * Two layers are pinned here.
 *
 * 1. THE GATE ITSELF, with an injected clock so a window is crossed by moving
 *    time rather than by waiting: the first occurrence opens the window and is
 *    emitted, the ones inside it are dropped and counted, the first one after it
 *    is emitted WITH that count attached, and an entry that declares no window
 *    is never suppressed at all.
 * 2. THE PIPELINE'S USE OF IT: `log.event.unknown-code` is the one registered
 *    entry with a window, so a drifted call site in a loop is reported once and
 *    the suppressed occurrences ride on the next report — while unthrottled
 *    events keep emitting every time.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { __resetLoggingForTest, __setLogClockForTest, configureLogging, createLogger, logEvent } from "../../src/log/index.ts";
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
});
