/**
 * THE PUBLIC API, END TO END.
 *
 * This suite drives the kernel the way a consumer does — configureLogger,
 * createLogger, logEvent, withLogScope, subscribeLogRecords — and pins the
 * promises the platform makes:
 *
 *   • THE DEFAULT PIPELINE IS ALL THREE SINKS: one warn reaches console.warn,
 *     `<logDir>/<channel>.log` and a live subscriber.
 *   • THE FILE LINE IS THE DOCUMENTED RECORD, in the documented key order, with
 *     identity in `scope`, data in `fields` and no `code` key for a level helper.
 *   • TWO GATES, NOT ONE: the console stays at "warn" while the file still takes
 *     the info record.
 *   • NEVER THROWS: a throwing sink, a throwing subscriber and a throwing
 *     console method all leave the caller untouched, and configureLogging
 *     survives being handed nonsense.
 *   • __resetLoggingForTest IS RE-ENTRANT and leaves a freshly imported kernel.
 *
 * The file cases run against a temporary ROLEBOX_LOG_DIR set by the helper, so
 * the workspace's own log directory is never written to.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  __resetLoggingForTest,
  __setLogClockForTest,
  configureLogging,
  createLogger,
  getLogDir,
  getLogFilePath,
  getUnknownEventCodeCount,
  logEvent,
  subscribeLogRecords,
  withLogScope,
} from "../../src/log/index.ts";
import { LOG_EVENTS } from "../../src/log/registry.ts";
import { createMemorySink } from "../../src/log/sinks/memory.ts";
import type { LogRecord, LogSink } from "../../src/log/types.ts";
import { beginLogTest, captureConsole, endLogTest, removeDir, setLogEnv, tempDir } from "../helpers/log.ts";

let state: { env: Record<string, string | undefined>; dir: string };

beforeEach(() => {
  state = beginLogTest();
});

afterEach(() => {
  endLogTest(state);
});

/** The lines a channel's file holds right now. */
function fileLines(dir: string, channelFile: string): string[] {
  return readFileSync(join(dir, channelFile), "utf8").trim().split("\n");
}

describe("default pipeline", () => {
  it("ships console + file + memory: one warn reaches all three", () => {
    const seen: LogRecord[] = [];
    const unsubscribe = subscribeLogRecords((record) => seen.push(record));
    const captured = captureConsole();
    try {
      createLogger("graph:host").warn("sweep blocked", { reason: "unreadable" });
    } finally {
      captured.restore();
      unsubscribe();
    }

    expect(captured.warn).toHaveLength(1);
    expect(captured.warn[0]).toBe('[warn] graph:host reason="unreadable" — sweep blocked');
    expect(seen.map((record) => record.message)).toEqual(["sweep blocked"]);
    expect(seen[0].code).toBeUndefined();
    expect(seen[0].scope).toEqual({});
    expect(getLogDir()).toBe(state.dir);
    expect(getLogFilePath("graph:host")).toBe(join(state.dir, "graph-host.log"));
    expect(JSON.parse(fileLines(state.dir, "graph-host.log")[0]).message).toBe("sweep blocked");
  });

  it("writes the documented record shape, in the documented key order", async () => {
    await withLogScope({ graphId: "g1", attemptId: "a2" }, async () => {
      await Promise.resolve();
      createLogger("graph:host").warn("sweep blocked", { reason: "unreadable" });
    });

    const parsed = JSON.parse(fileLines(state.dir, "graph-host.log")[0]);
    expect(Object.keys(parsed)).toEqual(["time", "level", "channel", "message", "scope", "fields", "process"]);
    expect(typeof parsed.time).toBe("number");
    expect(parsed.level).toBe("warn");
    expect(parsed.channel).toBe("graph:host");
    expect(parsed.scope).toEqual({ graphId: "g1", attemptId: "a2" });
    expect(parsed.fields).toEqual({ reason: "unreadable" });
    expect(parsed.process).toEqual({ pid: process.pid, role: "host" });

    logEvent("log.sink.failed", { sink: "file", error: "EACCES" });
    const event = JSON.parse(fileLines(state.dir, "log.log")[0]);
    expect(Object.keys(event)).toEqual(["time", "level", "channel", "code", "message", "scope", "fields", "process"]);
    expect(event.level).toBe(LOG_EVENTS["log.sink.failed"].level);
    expect(event.channel).toBe("log");
    expect(event.code).toBe("log.sink.failed");
    expect(event.message).toBe(LOG_EVENTS["log.sink.failed"].message);
    expect(event.fields).toEqual({ sink: "file", error: "EACCES" });
  });

  it("keeps the console at warn while the file still takes everything", () => {
    const captured = captureConsole();
    try {
      createLogger("graph:host").info("quiet detail");
      createLogger("graph:host").warn("visible");
    } finally {
      captured.restore();
    }

    expect(captured.warn).toHaveLength(1);
    expect(captured.debug).toHaveLength(0);
    const lines = fileLines(state.dir, "graph-host.log");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).level).toBe("info");
  });

  it("reports the configured role and this process's pid", () => {
    configureLogging({ role: "worker" });
    createLogger("dispatch").warn("delivering");

    expect(JSON.parse(fileLines(state.dir, "dispatch.log")[0]).process).toEqual({ pid: process.pid, role: "worker" });
  });

  it("points getLogFilePath at the channel's sanitized file", () => {
    expect(getLogFilePath("graph:host")).toBe(join(state.dir, "graph-host.log"));
    expect(getLogFilePath(":::")).toBe(join(state.dir, "rolebox.log"));
    expect(getLogDir()).toBe(state.dir);
  });
});

describe("configuration", () => {
  it("merges into the configuration in effect instead of replacing it", () => {
    const merged = tempDir("rolebox-log-merge-");
    try {
      configureLogging({ logDir: merged, consoleLevel: "error" });
      configureLogging({ role: "worker" });

      createLogger("dispatch").warn("kept");

      expect(getLogDir()).toBe(merged);
      expect(existsSync(join(merged, "dispatch.log"))).toBe(true);
    } finally {
      removeDir(merged);
    }
  });

  it("replaces the destinations when a sink list is given", () => {
    const memory = createMemorySink({ capacity: 5 });
    configureLogging({ sinks: [memory], level: "debug" });

    createLogger("dispatch").warn("memory only");

    expect(memory.size).toBe(1);
    expect(existsSync(join(state.dir, "dispatch.log"))).toBe(false);
    // The resolved directory is still reported even with no file sink installed.
    expect(getLogDir()).toBe(state.dir);
  });

  it("writes every channel into the one file configureLogging names", () => {
    const single = join(state.dir, "single.log");
    configureLogging({ logFile: single });

    createLogger("alpha").warn("a");
    createLogger("beta").info("b");

    expect(getLogFilePath("alpha")).toBe(single);
    expect(getLogFilePath("beta")).toBe(single);
    expect(getLogDir()).toBe(state.dir);
    const records = fileLines(state.dir, "single.log").map((line) => JSON.parse(line));
    expect(records.map((record) => record.channel)).toEqual(["alpha", "beta"]);
    expect(existsSync(join(state.dir, "alpha.log"))).toBe(false);
  });

  it("answers the legacy ROLEBOX_LOG_FILE before the first record is built", () => {
    const legacy = join(state.dir, "legacy.log");
    setLogEnv("ROLEBOX_LOG_FILE", legacy);
    __resetLoggingForTest();

    // No dispatch yet: the pending configuration is what the query answers.
    expect(getLogFilePath("anything")).toBe(legacy);
    expect(getLogFilePath("anything")).toBe(legacy);

    createLogger("alpha").fatal("the process cannot go on");
    expect(getLogFilePath("alpha")).toBe(legacy);
    expect(JSON.parse(fileLines(state.dir, "legacy.log")[0]).level).toBe("fatal");
  });

  it("never throws while configuring, whatever it is handed", () => {
    const memory = createMemorySink({ capacity: 5 });
    configureLogging({ sinks: [memory] });
    createLogger("dispatch").warn("before");

    const nonsense: unknown[] = [
      undefined,
      null,
      42,
      "nope",
      [],
      { level: "loud" },
      { consoleLevel: 7 },
      { logDir: 42 },
      { logFile: 42 },
      { sinks: "nope" },
      { role: "" },
      { channelLevels: { dispatch: "shout" } },
    ];
    for (const patch of nonsense) {
      expect(() => configureLogging(patch as never)).not.toThrow();
    }

    createLogger("dispatch").warn("after");
    expect(memory.records().map((record) => record.message)).toEqual(["before", "after"]);
  });
});

describe("never throws", () => {
  it("contains a throwing sink and reports it once through the pipeline", () => {
    const memory = createMemorySink({ capacity: 10 });
    const boom: LogSink = () => {
      throw new Error("boom");
    };
    configureLogging({ sinks: [boom, memory], level: "debug" });

    expect(() => createLogger("dispatch").warn("first")).not.toThrow();
    expect(() => createLogger("dispatch").warn("second")).not.toThrow();

    const reports = memory.records().filter((record) => record.code === "log.sink.failed");
    expect(reports).toHaveLength(1);
    expect(reports[0].level).toBe("error");
    expect(reports[0].channel).toBe("log");
    expect(reports[0].fields).toEqual({ sink: "sink#0", error: "Error", detail: "boom" });
  });

  it("contains a throwing subscriber", () => {
    configureLogging({ sinks: [createMemorySink({ capacity: 3 })] });
    const unsubscribe = subscribeLogRecords(() => {
      throw new Error("viewer exploded");
    });

    try {
      expect(() => createLogger("dispatch").warn("still fine")).not.toThrow();
    } finally {
      unsubscribe();
    }
  });

  it("contains a console method that throws", () => {
    const original = console.warn;
    console.warn = (): void => {
      throw new Error("console is broken");
    };
    try {
      expect(() => createLogger("graph:host").warn("boom")).not.toThrow();
    } finally {
      console.warn = original;
    }
  });

  it("drops an unknown code through logEvent without throwing and counts it", () => {
    const memory = createMemorySink({ capacity: 5 });
    configureLogging({ sinks: [memory], level: "debug" });

    expect(() => logEvent("nope.not-registered" as never)).not.toThrow();
    expect(getUnknownEventCodeCount()).toBe(1);
    expect(memory.last()?.code).toBe("log.event.unknown-code");
  });

  it("returns an idempotent unsubscribe from subscribeLogRecords", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeLogRecords((record) => seen.push(record.message));
    expect(typeof unsubscribe).toBe("function");

    createLogger("dispatch").warn("one");
    unsubscribe();
    unsubscribe();
    createLogger("dispatch").warn("two");

    expect(seen).toEqual(["one"]);
  });
});

describe("test seams", () => {
  it("resets to a freshly imported kernel, idempotently", () => {
    const memory = createMemorySink({ capacity: 5 });
    configureLogging({ sinks: [memory], level: "debug" });
    createLogger("dispatch").warn("custom sink");
    expect(memory.size).toBe(1);

    __resetLoggingForTest();
    __resetLoggingForTest();
    __resetLoggingForTest();
    expect(getUnknownEventCodeCount()).toBe(0);

    const seen: LogRecord[] = [];
    const unsubscribe = subscribeLogRecords((record) => seen.push(record));
    const captured = captureConsole();
    try {
      createLogger("graph:host").warn("after reset");
    } finally {
      captured.restore();
      unsubscribe();
    }

    expect(captured.warn).toHaveLength(1);
    expect(seen.map((record) => record.message)).toEqual(["after reset"]);
    expect(existsSync(join(state.dir, "graph-host.log"))).toBe(true);

    // The custom destination is gone: the default pipeline was rebuilt.
    createLogger("dispatch").warn("not the custom one");
    expect(memory.size).toBe(1);
  });

  it("stamps records with the test clock and forgets it on reset", () => {
    const memory = createMemorySink({ capacity: 5 });
    configureLogging({ sinks: [memory] });

    __setLogClockForTest(() => 1_700_000_000_123);
    createLogger("dispatch").warn("stamped");
    expect(memory.last()?.time).toBe(1_700_000_000_123);

    __resetLoggingForTest();
    configureLogging({ sinks: [memory] });
    createLogger("dispatch").warn("real clock");
    expect(memory.last()?.time).toBeGreaterThan(1_700_000_000_123);
  });
});
