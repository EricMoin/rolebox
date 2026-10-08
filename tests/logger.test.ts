/**
 * THE COMPATIBILITY SHELL, ON THE PLATFORM PIPELINE.
 *
 * src/logger.ts is what ~170 modules import; it used to be tslog and is now a
 * thin translation layer over src/log/**. This suite pins that contract, not
 * tslog's: the module surface the call sites use, the level helpers (including
 * the fifth level, `fatal`), the channel a logger records on and the file it
 * writes, the transport adapter the capture tests rely on, the legacy single
 * file (ROLEBOX_LOG_FILE), the workspace mapping of configureLogDirectory, and
 * the flat record that replaces tslog's `{"0":…,"1":…,"_meta":{…}}` shape.
 *
 * WHAT IT DELIBERATELY DOES NOT PIN: `_meta`, `parentNames`, a numeric level
 * ladder, per-sub-logger transports, the stderr warning for an invalid level and
 * the two helpers that answered the level ladder and the old transport's file
 * (`parseLogLevel`, `resolveLogFilePath`). Those were tslog behaviours and they
 * are gone; the cases below pin what replaced them.
 *
 * Every case runs against a temporary ROLEBOX_LOG_DIR (tests/helpers/log.ts), so
 * no case writes into the workspace's own log directory.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __resetForTest,
  configureLogDirectory,
  createSubLogger,
  formatError,
  getLogFilePath,
  getRootLogger,
  rootLogger,
} from "../src/logger.ts";
import { __setLogClockForTest, configureLogging } from "../src/log/index.ts";
import { createMemorySink, type MemorySink } from "../src/log/sinks/memory.ts";
import type { LogRecord } from "../src/log/types.ts";
import { beginLogTest, captureConsole, endLogTest, setLogEnv } from "./helpers/log.ts";

let state: { env: Record<string, string | undefined>; dir: string };

beforeEach(() => {
  state = beginLogTest();
});

afterEach(() => {
  endLogTest(state);
});

/** The parsed JSON lines a file holds right now. */
function lines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The levels a channel's file recorded, in order. */
function levels(channel: string): unknown[] {
  return lines(join(state.dir, channel.replace(/[^A-Za-z0-9]/g, "-") + ".log")).map((record) => record.level);
}

// ── Channels ─────────────────────────────────────────────────────────────────

describe("channel loggers", () => {
  it("records on the channel createSubLogger was given, colons and all", () => {
    createSubLogger("tui:events").warn("attention failed");

    const file = join(state.dir, "tui-events.log");
    expect(existsSync(file)).toBe(true);
    const [record] = lines(file);
    expect(record.channel).toBe("tui:events");
    expect(record.level).toBe("warn");
    expect(record.message).toBe("attention failed");
  });

  it("keeps the channel name verbatim in the record, not just in the file name", () => {
    createSubLogger("graph:host").info("sweep finished");

    expect(lines(join(state.dir, "graph-host.log"))[0].channel).toBe("graph:host");
  });

  it("root-logger and createSubLogger write to their own channel's file", () => {
    getRootLogger().warn("from the root");
    createSubLogger("dispatch").warn("from a sub-logger");

    expect(lines(join(state.dir, "rolebox.log")).map((record) => record.message)).toEqual(["from the root"]);
    expect(lines(join(state.dir, "dispatch.log")).map((record) => record.message)).toEqual(["from a sub-logger"]);
  });

  it("getRootLogger and rootLogger are the same logger on the root channel", () => {
    expect(rootLogger).toBe(getRootLogger());
    rootLogger.info("through the alias");

    expect(lines(join(state.dir, "rolebox.log"))[0].channel).toBe("rolebox");
  });

  it("getSubLogger stays on the parent's channel unless a name is given", () => {
    const parent = createSubLogger("parent");
    parent.getSubLogger().info("anonymous child");
    parent.getSubLogger({ name: "child:one" }).info("named child");

    expect(lines(join(state.dir, "parent.log")).map((record) => record.message)).toEqual(["anonymous child"]);
    expect(lines(join(state.dir, "child-one.log")).map((record) => record.message)).toEqual(["named child"]);
  });

  it("falls back to the root channel for an unusable name", () => {
    createSubLogger("").info("no name at all");

    expect(lines(join(state.dir, "rolebox.log"))[0].channel).toBe("rolebox");
  });
});

// ── Levels ───────────────────────────────────────────────────────────────────

describe("level helpers", () => {
  it("covers debug/info/warn/error/fatal and drops what is below the global level", () => {
    setLogEnv("ROLEBOX_LOG_LEVEL", "info");
    setLogEnv("ROLEBOX_LOG_CONSOLE_LEVEL", "fatal");
    const log = createSubLogger("levels");

    log.debug("dropped");
    log.info("kept");
    log.warn("kept");
    log.error("kept");
    log.fatal("kept");

    expect(levels("levels")).toEqual(["info", "warn", "error", "fatal"]);
  });

  it("records fatal as its own level and routes it to console.error", () => {
    setLogEnv("ROLEBOX_LOG_CONSOLE_LEVEL", "warn");
    const captured = captureConsole();
    try {
      const log = createSubLogger("loud");
      log.warn("a warning");
      log.fatal("the process cannot go on");
    } finally {
      captured.restore();
    }

    // THE DISCLOSED BEHAVIOUR CHANGE: warnings are visible on the console now.
    expect(captured.warn).toHaveLength(1);
    expect(captured.warn[0]).toBe("[warn] loud — a warning");
    expect(captured.error).toHaveLength(1);
    expect(captured.error[0]).toBe("[fatal] loud — the process cannot go on");
    expect(levels("loud")).toEqual(["warn", "fatal"]);
  });

  it("keeps info and debug off the console at the default console gate", () => {
    const captured = captureConsole();
    try {
      const log = createSubLogger("quiet");
      log.debug("quiet");
      log.info("quiet");
    } finally {
      captured.restore();
    }

    expect(captured.debug).toHaveLength(0);
    expect(captured.warn).toHaveLength(0);
    expect(captured.error).toHaveLength(0);
    // ...while the file still takes the info record. Debug is below the
    // default global level, so it is dropped before any sink sees it.
    expect(levels("quiet")).toEqual(["info"]);
  });

  it("maps silly and trace onto debug and records the alias in the fields", () => {
    setLogEnv("ROLEBOX_LOG_LEVEL", "debug");
    const log = createSubLogger("aliases");

    log.silly("the quietest message");
    log.trace("the second quietest");

    const records = lines(join(state.dir, "aliases.log"));
    expect(records.map((record) => record.level)).toEqual(["debug", "debug"]);
    expect(records.map((record) => record.fields)).toEqual([{ alias: "silly" }, { alias: "trace" }]);
  });

  it("gates a sub-logger with a numeric minLevel before the kernel's own gate", () => {
    setLogEnv("ROLEBOX_LOG_LEVEL", "debug");
    const log = createSubLogger("gated", 5 /* error */);

    log.debug("dropped by the logger's own gate");
    log.warn("dropped too");
    log.error("kept");
    log.fatal("kept");

    expect(levels("gated")).toEqual(["error", "fatal"]);
  });

  it("gates a sub-logger with a level name and lets a child inherit the parent's gate", () => {
    setLogEnv("ROLEBOX_LOG_LEVEL", "debug");
    const parent = createSubLogger("inherited", "warn");
    parent.info("dropped");
    parent.getSubLogger({ name: "inherited:child" }).info("dropped by the inherited gate");
    parent.getSubLogger({ name: "inherited:open", minLevel: "debug" }).debug("kept");

    // A dropped record never reaches a sink, so neither file is even created.
    expect(existsSync(join(state.dir, "inherited.log"))).toBe(false);
    expect(existsSync(join(state.dir, "inherited-child.log"))).toBe(false);
    expect(levels("inherited-open")).toEqual(["debug"]);
  });

  it("renders a non-string message instead of dropping the record", () => {
    const log = createSubLogger("messages");
    log.warn(new Error("boom"));
    log.warn({ code: 7 });
    log.warn(42);

    expect(lines(join(state.dir, "messages.log")).map((record) => record.message)).toEqual([
      "boom",
      '{"code":7}',
      "42",
    ]);
  });
});

// ── Argument adaptation ──────────────────────────────────────────────────────

describe("argument adaptation", () => {
  it("keeps the field bag, drops what the record may not carry", () => {
    createSubLogger("fields").warn("mixed bag", {
      count: 3,
      ok: true,
      names: ["a", "b"],
      missing: undefined,
      nested: { deep: true },
      objects: [{ deep: true }],
    });

    expect(lines(join(state.dir, "fields.log"))[0].fields).toEqual({
      count: 3,
      ok: true,
      names: ["a", "b"],
    });
  });

  it("turns a bare error argument into its reason", () => {
    createSubLogger("errors").warn("save failed", new Error("disk full"));

    expect(lines(join(state.dir, "errors.log"))[0].fields).toEqual({ error: "disk full" });
  });

  it("keeps an error-shaped value's message, and a scalar under its position", () => {
    createSubLogger("shapes").warn("saveSync failed for directory", "/tmp/x", new Error("read-only"));

    expect(lines(join(state.dir, "shapes.log"))[0].fields).toEqual({ arg1: "/tmp/x", error: "read-only" });
  });

  it("flattens a formatError result the call site passed as the field bag", () => {
    const err = new TypeError("something broke");
    createSubLogger("formatted").error("boom", formatError(err));

    const [record] = lines(join(state.dir, "formatted.log"));
    expect(record.message).toBe("boom");
    const fields = record.fields as Record<string, unknown>;
    expect(fields.name).toBe("TypeError");
    expect(fields.message).toBe("something broke");
    expect(String(fields.stack)).toContain("something broke");
  });
});

// ── The transport adapter ────────────────────────────────────────────────────

describe("attachTransport", () => {
  it("hands the transport the message at 0 and the fields at 1", () => {
    const entries: Array<Record<string, unknown>> = [];
    getRootLogger().attachTransport((entry) => entries.push(entry as Record<string, unknown>));

    createSubLogger("transport").warn("delivered", { reason: "why" });

    expect(entries).toHaveLength(1);
    expect(entries[0]["0"]).toBe("delivered");
    expect(entries[0]["1"]).toEqual({ reason: "why" });
  });

  it("adds the level and the channel in the open, with no legacy metadata object", () => {
    const entries: Array<Record<string, unknown>> = [];
    rootLogger.attachTransport((entry) => entries.push(entry as Record<string, unknown>));

    createSubLogger("transport:shape").error("failed");

    expect(Object.keys(entries[0])).toEqual(["0", "1", "level", "channel"]);
    expect(entries[0].level).toBe("error");
    expect(entries[0].channel).toBe("transport:shape");
    expect(entries[0]._meta).toBeUndefined();
  });

  it("sees every sub-logger, including one built before the attach", () => {
    const early = createSubLogger("early");
    const entries: Array<Record<string, unknown>> = [];
    getRootLogger().attachTransport((entry) => entries.push(entry as Record<string, unknown>));

    early.warn("built before");
    createSubLogger("late").warn("built after");

    expect(entries.map((entry) => entry["0"])).toEqual(["built before", "built after"]);
  });

  it("contains a transport that throws and keeps the caller untouched", () => {
    let called = false;
    getRootLogger().attachTransport(() => {
      called = true;
      throw new Error("transport explosion");
    });

    expect(() => createSubLogger("boom").warn("safe")).not.toThrow();
    expect(called).toBe(true);
  });

  it("stops delivering to a transport attached before __resetForTest", () => {
    // The reset clears the kernel's memory buffer, subscribers included. The
    // supported order is reset first, attach after — which is what the capture
    // suites do.
    const entries: Array<Record<string, unknown>> = [];
    getRootLogger().attachTransport((entry) => entries.push(entry as Record<string, unknown>));
    createSubLogger("before-reset").warn("seen");

    __resetForTest();
    createSubLogger("after-reset").warn("not seen");

    expect(entries.map((entry) => entry["0"])).toEqual(["seen"]);
  });
});

// ── File layout ──────────────────────────────────────────────────────────────

describe("file layout", () => {
  it("writes one flat JSON line per record, one file per channel, in the documented key order", () => {
    createSubLogger("flat").warn("the workspace store could not be read", { reason: "unreadable" });

    const [record] = lines(join(state.dir, "flat.log"));
    expect(Object.keys(record)).toEqual(["time", "level", "channel", "message", "scope", "fields", "process"]);
    expect(record["0"]).toBeUndefined();
    expect(record._meta).toBeUndefined();
    expect(record.fields).toEqual({ reason: "unreadable" });
    expect(record.scope).toEqual({});
    expect(record.process).toEqual({ pid: process.pid, role: "host" });
  });

  it("puts every channel into the one file ROLEBOX_LOG_FILE names", () => {
    setLogEnv("ROLEBOX_LOG_FILE", join(state.dir, "legacy.log"));
    __resetForTest();

    createSubLogger("alpha").info("alpha line");
    createSubLogger("beta").warn("beta line");
    getRootLogger().fatal("root line");

    const records = lines(join(state.dir, "legacy.log"));
    expect(records.map((record) => record.channel)).toEqual(["alpha", "beta", "rolebox"]);
    expect(records.map((record) => record.level)).toEqual(["info", "warn", "fatal"]);
    expect(existsSync(join(state.dir, "alpha.log"))).toBe(false);
    expect(getLogFilePath()).toBe(join(state.dir, "legacy.log"));
    expect(getLogFilePath("any:channel")).toBe(join(state.dir, "legacy.log"));
  });

  it("beats ROLEBOX_LOG_DIR, so the legacy contract wins over the new layout", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "rolebox-legacy-dir-"));
    try {
      setLogEnv("ROLEBOX_LOG_DIR", elsewhere);
      setLogEnv("ROLEBOX_LOG_FILE", join(state.dir, "single.log"));
      __resetForTest();

      createSubLogger("alpha").warn("here");

      expect(lines(join(state.dir, "single.log"))).toHaveLength(1);
      expect(existsSync(join(elsewhere, "alpha.log"))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("rotates the legacy file at the byte limit and keeps the retained copies", () => {
    const file = join(state.dir, "rotating.log");
    setLogEnv("ROLEBOX_LOG_FILE", file);
    setLogEnv("ROLEBOX_LOG_MAX_BYTES", "120");
    setLogEnv("ROLEBOX_LOG_RETAIN", "2");
    __resetForTest();

    const log = createSubLogger("rotate");
    for (let index = 0; index < 6; index++) log.info("entry " + index + " " + "x".repeat(60));

    expect(existsSync(file)).toBe(true);
    expect(existsSync(file + ".1")).toBe(true);
    expect(existsSync(file + ".2")).toBe(true);
    expect(existsSync(file + ".3")).toBe(false);
    expect(readFileSync(file, "utf8")).toContain('"entry 5');
  });

  it("creates the configured directory lazily, on the first record", () => {
    const nested = join(state.dir, "nested", "logs");
    setLogEnv("ROLEBOX_LOG_DIR", nested);
    __resetForTest();

    createSubLogger("lazy").info("first");
    createSubLogger("lazy").info("second");

    expect(lines(join(nested, "lazy.log")).map((record) => record.message)).toEqual(["first", "second"]);
  });
});

// ── Path resolution ──────────────────────────────────────────────────────────

describe("path resolution", () => {
  it("answers the channel's file, and the root channel's when no channel is named", () => {
    expect(getLogFilePath("graph:host")).toBe(join(state.dir, "graph-host.log"));
    expect(getLogFilePath(":::")).toBe(join(state.dir, "rolebox.log"));
    expect(getLogFilePath()).toBe(join(state.dir, "rolebox.log"));
  });

  it("reads ROLEBOX_LOG_DIR after a reset", () => {
    const other = mkdtempSync(join(tmpdir(), "rolebox-log-other-"));
    try {
      setLogEnv("ROLEBOX_LOG_DIR", other);
      __resetForTest();

      expect(getLogFilePath()).toBe(join(other, "rolebox.log"));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

// ── configureLogDirectory ────────────────────────────────────────────────────

describe("configureLogDirectory", () => {
  it("maps a workspace root to the directory the legacy API meant", () => {
    const workspace = mkdtempSync(join(tmpdir(), "rolebox-workspace-"));
    try {
      configureLogDirectory(workspace);
      createSubLogger("workspace").warn("inside the workspace");

      const expected = join(workspace, ".rolebox", "logs", "workspace.log");
      expect(getLogFilePath("workspace")).toBe(expected);
      expect(lines(expected)).toHaveLength(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("forwards a path that already is the log directory unchanged", () => {
    const already = join(state.dir, "already", ".rolebox", "logs");
    configureLogDirectory(already);

    expect(getLogFilePath("dispatch")).toBe(join(already, "dispatch.log"));
  });

  it("never throws on an unusable argument", () => {
    expect(() => configureLogDirectory("")).not.toThrow();
    expect(() => configureLogDirectory(undefined as unknown as string)).not.toThrow();
  });
});

// ── Error formatting ─────────────────────────────────────────────────────────

describe("formatError", () => {
  it("extracts message, stack, and name from Error", () => {
    const err = new TypeError("something broke");
    const result = formatError(err);
    expect(result.message).toBe("something broke");
    expect(result.name).toBe("TypeError");
    expect(result.stack).toContain("something broke");
  });

  it("handles string input", () => {
    const result = formatError("plain string error");
    expect(result).toEqual({ message: "plain string error" });
  });

  it("handles null", () => {
    const result = formatError(null);
    expect(result).toEqual({ message: "null" });
  });

  it("handles undefined", () => {
    const result = formatError(undefined);
    expect(result).toEqual({ message: "undefined" });
  });

  it("handles plain objects", () => {
    const result = formatError({ code: 500, detail: "boom" });
    expect(result.message).toBe('{"code":500,"detail":"boom"}');
  });

  it("handles objects that cannot be stringified", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = formatError(circular);
    expect(result.message).toContain("[object Object]");
    expect(result.stack).toBeUndefined();
  });

  it("handles Error with no stack", () => {
    const err = new Error("minimal");
    delete (err as { stack?: string }).stack;
    const result = formatError(err);
    expect(result.message).toBe("minimal");
    expect(result.stack).toBeUndefined();
  });
});

// ── Reset ────────────────────────────────────────────────────────────────────

describe("__resetForTest", () => {
  it("re-reads the environment on the next record", () => {
    const first = join(state.dir, "first.log");
    const second = join(state.dir, "second.log");

    setLogEnv("ROLEBOX_LOG_FILE", first);
    __resetForTest();
    expect(getLogFilePath()).toBe(first);
    createSubLogger("rediscover").warn("into the first file");

    setLogEnv("ROLEBOX_LOG_FILE", second);
    __resetForTest();
    expect(getLogFilePath()).toBe(second);
    createSubLogger("rediscover").warn("into the second file");

    expect(lines(first).map((record) => record.message)).toEqual(["into the first file"]);
    expect(lines(second).map((record) => record.message)).toEqual(["into the second file"]);
  });

  it("is re-entrant and leaves a working pipeline behind", () => {
    __resetForTest();
    __resetForTest();

    expect(() => createSubLogger("after-reset").warn("still works")).not.toThrow();
    expect(lines(join(state.dir, "after-reset.log"))).toHaveLength(1);
  });
});

// ── Field narrowing, made visible ────────────────────────────────────────────
//
// The shell drops a value the kernel's field type does not admit, and until this
// suite existed nothing recorded the drop: a call site could pass an object for
// years with no trace in the record. The three cases below pin the replacement —
// the drop is still a drop (the mapping is unchanged), but it is REPORTED once
// per throttle window, by key name and channel, and never by value.

describe("field narrowing", () => {
  /** A pipeline whose only destination is a memory sink, at the debug level. */
  function memoryPipeline(): MemorySink {
    const memory = createMemorySink({ capacity: 50 });
    setLogEnv("ROLEBOX_LOG_LEVEL", "debug");
    configureLogging({ sinks: [memory], level: "debug" });
    return memory;
  }

  /** The narrowing reports a memory sink received, in order. */
  function narrowings(memory: MemorySink): LogRecord[] {
    return memory.records().filter((record) => record.code === "log.field.narrowed");
  }

  it("reports a dropped object value once, naming the channel and the keys — never the value", () => {
    const memory = memoryPipeline();
    createSubLogger("payloads").warn("save failed", {
      attemptId: "a2",
      payload: { secret: "PAYLOAD-MUST-NOT-APPEAR" },
      items: [1, "two"],
    });

    const reports = narrowings(memory);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.level).toBe("debug");
    expect(reports[0]?.channel).toBe("log:compat");
    expect(reports[0]?.fields).toEqual({ channel: "payloads", keys: ["payload", "items"] });
    // THE POINT OF REGISTERING THE DROP: the report names the keys and never the
    // values that could not be carried.
    expect(JSON.stringify(memory.records())).not.toContain("PAYLOAD-MUST-NOT-APPEAR");

    // ...and the record itself is still written, with the fields the kernel
    // admits: reporting the narrowing did not change the mapping.
    const [record] = memory.records().filter((entry) => entry.channel === "payloads");
    expect(record?.message).toBe("save failed");
    expect(record?.fields).toEqual({ attemptId: "a2" });
  });

  it("throttles repeats on the same channel, and reports what the window suppressed", () => {
    const memory = memoryPipeline();
    let now = 1_000_000;
    __setLogClockForTest(() => now);
    const log = createSubLogger("repeats");

    log.warn("first", { payload: { n: 1 } });
    now += 30_000; // inside the 60s window the first report opened
    log.warn("second", { payload: { n: 2 } });
    now += 31_000; // past that window
    log.warn("third", { payload: { n: 3 } });

    const reports = narrowings(memory);
    expect(reports).toHaveLength(2);
    expect(reports[0]?.fields).toEqual({ channel: "repeats", keys: ["payload"] });
    // The suppressed occurrence is counted and rides on the next report, so the
    // throttling is accounted for instead of being silent.
    expect(reports[1]?.fields).toEqual({ channel: "repeats", keys: ["payload"], suppressed: 1 });

    // The three warnings themselves are untouched by the gate.
    const warned = memory.records().filter((record) => record.channel === "repeats");
    expect(warned.map((record) => record.level)).toEqual(["warn", "warn", "warn"]);
  });

  it("stays silent for the values the kernel admits", () => {
    const memory = memoryPipeline();
    createSubLogger("clean").warn("nothing was dropped", {
      reason: "why",
      count: 2,
      ok: true,
      names: ["a", "b"],
      ids: [1, 2],
      missing: undefined,
      error: new Error("read-only"),
    });

    expect(narrowings(memory)).toEqual([]);
    expect(memory.records().find((record) => record.channel === "clean")?.fields).toEqual({
      reason: "why",
      count: 2,
      ok: true,
      names: ["a", "b"],
      ids: [1, 2],
      error: "read-only",
    });
  });

  it("names a positional argument that cannot become a field by the key it would have had", () => {
    const memory = memoryPipeline();
    createSubLogger("positional").warn("saveSync failed", "/tmp/x", [{ deep: true }]);

    expect(narrowings(memory)[0]?.fields).toEqual({ channel: "positional", keys: ["arg2"] });
  });
});

// ── Exported API surface ─────────────────────────────────────────────────────

describe("exported API", () => {
  it("exports the surface every call site imports", () => {
    expect(typeof createSubLogger).toBe("function");
    expect(typeof getRootLogger).toBe("function");
    expect(typeof formatError).toBe("function");
    expect(typeof configureLogDirectory).toBe("function");
    expect(typeof getLogFilePath).toBe("function");
    expect(typeof __resetForTest).toBe("function");
    expect(rootLogger).toBeDefined();
  });

  it("gives every logger the methods the call sites use", () => {
    const log = createSubLogger("surface");
    for (const method of ["debug", "info", "warn", "error", "fatal", "silly", "trace", "getSubLogger", "attachTransport"] as const) {
      expect(typeof log[method]).toBe("function");
    }
    expect(typeof rootLogger.fatal).toBe("function");
  });
});
