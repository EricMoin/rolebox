/**
 * THE LEVEL GATE: global, per channel, and the fallback for nonsense.
 *
 * The gate is what keeps the console readable while the file keeps everything,
 * so its precedence has to be exact:
 *
 *   explicit per-channel > channel environment > explicit global >
 *   ROLEBOX_LOG_LEVEL > "info"
 *
 * and every invalid value at every step falls through to the next one instead of
 * throwing or latching. The gate runs BEFORE the throttle gate, which the last
 * case pins (a record dropped by the level must not consume a throttle window).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  channelLevelEnvKey,
  configureLogging,
  createLogger,
  logEvent,
} from "../../src/log/index.ts";
import { createMemorySink, type MemorySink } from "../../src/log/sinks/memory.ts";
import { beginLogTest, endLogTest, setLogEnv } from "../helpers/log.ts";

let state: { env: Record<string, string | undefined>; dir: string };
let memory: MemorySink;

beforeEach(() => {
  state = beginLogTest();
  memory = createMemorySink({ capacity: 50 });
  // No explicit level: the environment (or the "info" default) decides.
  configureLogging({ sinks: [memory] });
});

afterEach(() => {
  endLogTest(state);
});

/** Emit one record per level on one channel. */
function emitFour(channel: string): void {
  const log = createLogger(channel);
  log.debug("debug message");
  log.info("info message");
  log.warn("warn message");
  log.error("error message");
}

/** The levels that actually arrived, in order. */
function levels(): string[] {
  return memory.records().map((record) => record.level);
}

describe("level thresholds", () => {
  it("defaults to info and drops everything quieter", () => {
    emitFour("dispatch");
    expect(levels()).toEqual(["info", "warn", "error"]);
  });

  it("honors ROLEBOX_LOG_LEVEL case-insensitively and trims it", () => {
    setLogEnv("ROLEBOX_LOG_LEVEL", "DEBUG");
    memory.clear();
    emitFour("dispatch");
    expect(levels()).toEqual(["debug", "info", "warn", "error"]);

    setLogEnv("ROLEBOX_LOG_LEVEL", "  Error  ");
    memory.clear();
    emitFour("dispatch");
    expect(levels()).toEqual(["error"]);
  });

  it("falls back to info for an unset, blank, unknown or numeric value", () => {
    for (const value of ["", "   ", "verbose", "3", "silly", "INFO2"]) {
      setLogEnv("ROLEBOX_LOG_LEVEL", value);
      memory.clear();
      expect(() => emitFour("dispatch")).not.toThrow();
      expect(levels()).toEqual(["info", "warn", "error"]);
    }
    setLogEnv("ROLEBOX_LOG_LEVEL", undefined);
    memory.clear();
    emitFour("dispatch");
    expect(levels()).toEqual(["info", "warn", "error"]);
  });

  it("derives a channel's environment key from its name", () => {
    expect(channelLevelEnvKey("graph:host")).toBe("ROLEBOX_LOG_LEVEL_GRAPH_HOST");
    expect(channelLevelEnvKey("dispatch")).toBe("ROLEBOX_LOG_LEVEL_DISPATCH");
    expect(channelLevelEnvKey("Graph.Host-2")).toBe("ROLEBOX_LOG_LEVEL_GRAPH_HOST_2");
    expect(channelLevelEnvKey(":::")).toBeUndefined();
    expect(channelLevelEnvKey("")).toBeUndefined();
  });

  it("honors a per-channel override without lowering the other channels", () => {
    setLogEnv("ROLEBOX_LOG_LEVEL_GRAPH_HOST", "debug");
    emitFour("graph:host");
    expect(levels()).toEqual(["debug", "info", "warn", "error"]);

    memory.clear();
    emitFour("graph:worker");
    expect(levels()).toEqual(["info", "warn", "error"]);
  });

  it("falls back to the global level when a channel override is invalid", () => {
    setLogEnv("ROLEBOX_LOG_LEVEL_DISPATCH", "loud");
    emitFour("dispatch");
    expect(levels()).toEqual(["info", "warn", "error"]);
  });

  it("lets an explicit global level beat ROLEBOX_LOG_LEVEL", () => {
    setLogEnv("ROLEBOX_LOG_LEVEL", "debug");
    configureLogging({ level: "warn" });
    emitFour("dispatch");
    expect(levels()).toEqual(["warn", "error"]);
  });

  it("lets an explicit channel level beat everything else", () => {
    setLogEnv("ROLEBOX_LOG_LEVEL", "error");
    setLogEnv("ROLEBOX_LOG_LEVEL_GRAPH_HOST", "debug");
    configureLogging({ channelLevels: { "graph:host": "error", dispatch: "debug" } });
    emitFour("graph:host");
    expect(levels()).toEqual(["error"]);
    memory.clear();
    emitFour("dispatch");
    expect(levels()).toEqual(["debug", "info", "warn", "error"]);
  });

  it("lets a channel environment variable beat an explicit global level", () => {
    setLogEnv("ROLEBOX_LOG_LEVEL_GRAPH_HOST", "debug");
    configureLogging({ level: "error" });
    emitFour("graph:host");
    expect(levels()).toEqual(["debug", "info", "warn", "error"]);
    memory.clear();
    emitFour("dispatch");
    expect(levels()).toEqual(["error"]);
  });

  it("ignores an invalid programmatic level instead of throwing", () => {
    expect(() => configureLogging({ level: "loud" as never })).not.toThrow();
    emitFour("dispatch");
    expect(levels()).toEqual(["info", "warn", "error"]);
  });

  it("gates an event by the channel its registry entry names", () => {
    // "log.event.unknown-code" is a registered warn-level event on channel "log".
    setLogEnv("ROLEBOX_LOG_LEVEL_LOG", "error");
    logEvent("log.event.unknown-code", { event: "manual" });
    expect(memory.size).toBe(0);

    setLogEnv("ROLEBOX_LOG_LEVEL_LOG", "warn");
    logEvent("log.event.unknown-code", { event: "manual" });
    expect(memory.size).toBe(1);
    expect(memory.last()?.channel).toBe("log");
    expect(memory.last()?.code).toBe("log.event.unknown-code");
  });

  it("drops a gated record before the throttle gate sees it", () => {
    setLogEnv("ROLEBOX_LOG_LEVEL_LOG", "error");
    for (let index = 0; index < 3; index++) logEvent("log.event.unknown-code", { event: "gated" });
    expect(memory.size).toBe(0);

    // Nothing was suppressed while the channel was gated, so the first occurrence
    // after the level is lowered is a plain record with no `suppressed` count.
    setLogEnv("ROLEBOX_LOG_LEVEL_LOG", "warn");
    logEvent("log.event.unknown-code", { event: "visible" });
    expect(memory.size).toBe(1);
    expect(memory.last()?.fields.suppressed).toBeUndefined();
  });

  it("ranks fatal above error, so a fatal gate admits nothing else", () => {
    setLogEnv("ROLEBOX_LOG_LEVEL", "fatal");
    const log = createLogger("dispatch");
    log.debug("dropped");
    log.info("dropped");
    log.warn("dropped");
    log.error("dropped");
    log.fatal("kept");

    expect(levels()).toEqual(["fatal"]);
  });

  it("admits fatal at the default info level and under an explicit error level", () => {
    const log = createLogger("dispatch");
    log.fatal("the process cannot go on");
    expect(levels()).toEqual(["fatal"]);

    memory.clear();
    configureLogging({ level: "error" });
    log.fatal("still admitted");
    expect(levels()).toEqual(["fatal"]);
    expect(memory.last()?.level).toBe("fatal");
  });
});
