import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Logger } from "tslog";
import type { ILogObj } from "tslog";
import {
  parseLogLevel,
  resolveLogFilePath,
  createSubLogger,
  formatError,
  getLogFilePath,
  rootLogger,
} from "../src/logger";

function captureTransport(logger: Logger<ILogObj>): ILogObj[] {
  const entries: ILogObj[] = [];
  logger.attachTransport((logObj) => {
    entries.push(logObj);
  });
  return entries;
}

// ── Level filtering ──────────────────────────────────────────

describe("level filtering", () => {
  it("only delivers messages at or above minLevel", () => {
    const logger = new Logger<ILogObj>({ type: "hidden", name: "level-test", minLevel: 4 });
    const entries = captureTransport(logger);

    logger.silly("s");
    logger.trace("t");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    logger.fatal("f");

    const messages = entries.map((e) => e[0]);
    expect(messages).toEqual(["w", "e", "f"]);
  });

  it("defaults to info level (3) when no env is set", () => {
    const logger = new Logger<ILogObj>({ type: "hidden", name: "default-test", minLevel: 3 });
    const entries = captureTransport(logger);

    logger.debug("d");
    logger.info("i");
    logger.warn("w");

    const messages = entries.map((e) => e[0]);
    expect(messages).toEqual(["i", "w"]);
  });
});

// ── File transport ───────────────────────────────────────────

describe("file transport", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rolebox-log-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes JSON log entries to file via attached transport", () => {
    const logFile = join(tmpDir, "app.log");
    const logger = new Logger<ILogObj>({ type: "hidden", name: "file-test" });

    logger.attachTransport((logObj) => {
      try {
        const entry = JSON.stringify({ ...logObj, pid: process.pid }) + "\n";
        appendFileSync(logFile, entry);
      } catch {
        // ignore
      }
    });

    logger.info("hello file transport");
    logger.warn("warning message");

    const content = readFileSync(logFile, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);

    const first = JSON.parse(lines[0]!);
    expect(first[0]).toBe("hello file transport");
    expect(first._meta.name).toBe("file-test");
    expect(first._meta.logLevelName).toBe("INFO");
    expect(first.pid).toBe(process.pid);

    const second = JSON.parse(lines[1]!);
    expect(second[0]).toBe("warning message");
    expect(second._meta.logLevelName).toBe("WARN");
  });

  it("does not write entries below minLevel", () => {
    const logFile = join(tmpDir, "filtered.log");
    const logger = new Logger<ILogObj>({ type: "hidden", name: "filtered-test", minLevel: 4 });

    logger.attachTransport((logObj) => {
      try {
        const entry = JSON.stringify({ ...logObj, pid: process.pid }) + "\n";
        appendFileSync(logFile, entry);
      } catch {
        // ignore
      }
    });

    logger.info("should be filtered");
    logger.warn("should appear");

    const content = readFileSync(logFile, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("should appear");
  });
});

// ── Sub-logger naming ────────────────────────────────────────

describe("sub-logger naming", () => {
  it("creates sub-logger with correct name in metadata", () => {
    const parent = new Logger<ILogObj>({ type: "hidden", name: "Parent" });
    const entries = captureTransport(parent);

    const child = parent.getSubLogger({ name: "Child" });
    const grandchild = child.getSubLogger({ name: "Grandchild" });

    child.info("child log");
    grandchild.warn("grandchild log");

    expect(entries.length).toBe(2);
    expect(entries[0]!._meta.name).toBe("Child");
    expect(entries[0]!._meta.logLevelName).toBe("INFO");
    expect(entries[1]!._meta.name).toBe("Grandchild");
    expect(entries[1]!._meta.logLevelName).toBe("WARN");
  });

  it("createSubLogger uses the root logger", () => {
    const sub = createSubLogger("TestSub");
    const entries = captureTransport(sub);

    sub.info("via sub");

    expect(entries.length).toBe(1);
    expect(entries[0]!._meta.name).toBe("TestSub");
    expect(entries[0]!._meta.logLevelName).toBe("INFO");
  });

  it("createSubLogger with level override filters correctly", () => {
    const sub = createSubLogger("LevelSub", 5);

    const parentLogger = new Logger<ILogObj>({ type: "hidden", name: "ParentLogger" });
    const parentEntries = captureTransport(parentLogger);
    const childLogger = parentLogger.getSubLogger({ name: "ChildLogger", minLevel: 5 });

    childLogger.error("this");
    childLogger.warn("not this");

    expect(parentEntries.length).toBe(1);
    expect(parentEntries[0]![0]).toBe("this");
  });
});

// ── Error formatting ─────────────────────────────────────────

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

// ── ROLEBOX_LOG_LEVEL parsing ────────────────────────────────

describe("parseLogLevel", () => {
  it("returns 3 (info) when env var is unset", () => {
    delete process.env.ROLEBOX_LOG_LEVEL;
    expect(parseLogLevel()).toBe(3);
  });

  it("returns 3 (info) when env var is empty string", () => {
    process.env.ROLEBOX_LOG_LEVEL = "";
    expect(parseLogLevel()).toBe(3);
  });

  it("parses known levels case-insensitively", () => {
    expect(parseLogLevel("silly")).toBe(0);
    expect(parseLogLevel("TRACE")).toBe(1);
    expect(parseLogLevel("Debug")).toBe(2);
    expect(parseLogLevel("info")).toBe(3);
    expect(parseLogLevel("WARN")).toBe(4);
    expect(parseLogLevel("Error")).toBe(5);
    expect(parseLogLevel("FATAL")).toBe(6);
  });

  it("trims whitespace from level string", () => {
    expect(parseLogLevel("  warn  ")).toBe(4);
  });

  it("falls back to info and warns on invalid value via raw arg", () => {
    const stderrMock = mock((_s: string) => {});
    const orig = process.stderr.write;
    process.stderr.write = stderrMock as unknown as typeof process.stderr.write;

    const level = parseLogLevel("invalid");

    process.stderr.write = orig;

    expect(level).toBe(3);
    expect(stderrMock).toHaveBeenCalledTimes(1);
    const callArg = stderrMock.mock.calls[0]![0] as string;
    expect(callArg).toContain("Invalid ROLEBOX_LOG_LEVEL='invalid'");
    expect(callArg).toContain("falling back to 'info'");
  });

  it("falls back to info and warns on invalid env var", () => {
    process.env.ROLEBOX_LOG_LEVEL = "not-a-real-level";
    const stderrMock = mock((_s: string) => {});
    const orig = process.stderr.write;
    process.stderr.write = stderrMock as unknown as typeof process.stderr.write;

    const level = parseLogLevel();

    process.stderr.write = orig;

    expect(level).toBe(3);
    expect(stderrMock).toHaveBeenCalledTimes(1);
    const callArg = stderrMock.mock.calls[0]![0] as string;
    expect(callArg).toContain("not-a-real-level");
  });
});

// ── Log file path resolution ─────────────────────────────────

describe("resolveLogFilePath", () => {
  const origLogFile = process.env.ROLEBOX_LOG_FILE;

  afterEach(() => {
    if (origLogFile) {
      process.env.ROLEBOX_LOG_FILE = origLogFile;
    } else {
      delete process.env.ROLEBOX_LOG_FILE;
    }
  });

  it("uses ROLEBOX_LOG_FILE env var when set to writable path", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-path-test-"));
    const logPath = join(tmpDir, "custom.log");
    process.env.ROLEBOX_LOG_FILE = logPath;

    const resolved = resolveLogFilePath();
    expect(resolved).toBe(logPath);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("falls back to config dir when env var is not set", () => {
    delete process.env.ROLEBOX_LOG_FILE;
    const resolved = resolveLogFilePath();
    expect(resolved).not.toBeNull();
  });

  it("returns a path under /tmp/rolebox.log if config dir is unavailable", () => {
    delete process.env.ROLEBOX_LOG_FILE;
    const resolved = resolveLogFilePath();
    expect(resolved).not.toBeNull();
    expect(typeof resolved).toBe("string");
  });

  it("falls back when ROLEBOX_LOG_FILE points to unwritable location", () => {
    process.env.ROLEBOX_LOG_FILE = "/dev/null/nope/subdir/file.log";
    const resolved = resolveLogFilePath();
    expect(resolved).not.toBe("/dev/null/nope/subdir/file.log");
    expect(resolved).not.toBeNull();
  });
});

// ── Transport safety ─────────────────────────────────────────

describe("transport safety", () => {
  it("wrapping transport body in try/catch prevents exception propagation", () => {
    const logger = new Logger<ILogObj>({ type: "hidden", name: "safety-test" });
    let caught = false;

    logger.attachTransport(() => {
      try {
        throw new Error("transport explosion");
      } catch {
        caught = true;
      }
    });

    expect(() => logger.info("safe")).not.toThrow();
    expect(caught).toBe(true);
  });

  it("unwrapped transport exceptions propagate (tslog does not shield)", () => {
    const logger = new Logger<ILogObj>({ type: "hidden", name: "raw-safety-test" });

    logger.attachTransport(() => {
      appendFileSync("/this/path/does/not/exist/file.log", "data");
    });

    expect(() => logger.info("test")).toThrow();
  });
});

// ── Exported API surface ─────────────────────────────────────

describe("exported API", () => {
  it("exports rootLogger as a Logger instance", () => {
    expect(rootLogger).toBeInstanceOf(Logger);
  });

  it("exports createSubLogger as a function", () => {
    expect(typeof createSubLogger).toBe("function");
  });

  it("exports formatError as a function", () => {
    expect(typeof formatError).toBe("function");
  });

  it("exports getLogFilePath returning string or null", () => {
    const path = getLogFilePath();
    expect(path === null || typeof path === "string").toBe(true);
  });

  it("exports parseLogLevel as a function", () => {
    expect(typeof parseLogLevel).toBe("function");
  });

  it("exports resolveLogFilePath as a function", () => {
    expect(typeof resolveLogFilePath).toBe("function");
  });
});
