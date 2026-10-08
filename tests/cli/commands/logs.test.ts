/**
 * `rolebox logs` — the QUERY surface, end to end through the runner and the
 * citty wiring.
 *
 * Every case builds its own directory under the OS temp directory and passes it
 * as `--log-dir`, so nothing here can read or write the workspace's own
 * `.rolebox/logs/`. The records are written by hand as JSON lines rather than
 * through the file sink, because a query test also has to be able to leave a
 * malformed line behind — which no sink would ever produce.
 *
 * The human line is asserted to be EXACTLY `formatLogLine(record)`: the CLI must
 * reuse the runtime's renderer rather than grow a second one.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import logsCommand from "../../../src/cli/commands/logs.ts";
import { LogsUsageError, parseLogTime, parseLogsQueryArgs } from "../../../src/cli/commands/logs/logs-args.ts";
import { runLogsQuery, type LogsIo } from "../../../src/cli/commands/logs/logs-run.ts";
import { formatLogLine } from "../../../src/log/sinks/console.ts";
import type { LogRecord } from "../../../src/log/types.ts";
import { makeRecord, setLogEnv } from "../../helpers/log.ts";

/** The instant every fixture is laid out around. */
const BASE = Date.parse("2026-10-08T10:00:00.000Z");

let dir: string;
/** `process.exitCode` as the test found it (its type admits null). */
let exitCode: string | number | null | undefined;
/** `ROLEBOX_LOG_FILE` as the test found it. */
let originalLogFile: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rolebox-logs-cli-"));
  exitCode = process.exitCode;
  originalLogFile = process.env.ROLEBOX_LOG_FILE;
  // A case that names no location reads the WRITER'S chain, where an exported
  // ROLEBOX_LOG_FILE outranks ROLEBOX_LOG_DIR and would silently redirect the
  // case at the developer's own file. A case that wants the legacy variable
  // sets it itself (see `withLogFile` below).
  setLogEnv("ROLEBOX_LOG_FILE", undefined);
});

afterEach(() => {
  setLogEnv("ROLEBOX_LOG_FILE", originalLogFile);
  process.exitCode = exitCode;
  rmSync(dir, { recursive: true, force: true });
});

// ── Fixtures ───────────────────────────────────────────────────────────────

/** One record, with the writer's defaults filled in. */
function record(
  time: number,
  channel: string,
  message: string,
  extra: Partial<LogRecord> = {},
): LogRecord {
  return makeRecord({ time, channel, level: "info", message, ...extra });
}

/** Write a channel's file: a record becomes a JSON line, a string is left verbatim. */
function writeChannel(fileName: string, lines: readonly (LogRecord | string)[]): void {
  const body = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n");
  writeFileSync(join(dir, fileName), body + "\n", "utf8");
}

/** A collector standing in for the two writers. */
interface Capture {
  readonly out: string[];
  readonly err: string[];
  readonly io: LogsIo;
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (line: string): void => {
        out.push(line);
      },
      err: (line: string): void => {
        err.push(line);
      },
    },
  };
}

/** Replace console.log/console.error for the duration of one command call. */
function captureConsole(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: any[]): void => {
    stdout.push(args.join(" "));
  };
  console.error = (...args: any[]): void => {
    stderr.push(args.join(" "));
  };
  return {
    stdout,
    stderr,
    restore: (): void => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

/** Call a citty command's `run` exactly as `runCommand` would. */
async function runCommandWith(command: { run?: unknown }, args: Record<string, unknown>): Promise<void> {
  const run = command.run as ((context: { args: Record<string, unknown> }) => Promise<unknown>) | undefined;
  await run?.({ args: { _: [], ...args } });
}

// ── The human answer ───────────────────────────────────────────────────────

describe("rolebox logs (default query)", () => {
  it("answers in the runtime's own console line, newest first", async () => {
    const older = record(BASE - 60_000, "graph:host", "graph opened");
    const newer = record(BASE, "cli", "resolved the workspace root");
    writeChannel("graph-host.log", [older]);
    writeChannel("cli.log", [newer]);

    const seen = capture();
    expect(await runLogsQuery({ logDir: dir, limit: 100, order: "desc", json: false, follow: false }, seen.io)).toBe(0);

    expect(seen.out).toEqual([formatLogLine(newer), formatLogLine(older)]);
    expect(seen.err).toEqual([]);
  });

  it("orders oldest first with --order asc", async () => {
    const older = record(BASE - 60_000, "cli", "first");
    const newer = record(BASE, "cli", "second");
    writeChannel("cli.log", [older, newer]);

    const seen = capture();
    await runLogsQuery({ logDir: dir, limit: 100, order: "asc", json: false, follow: false }, seen.io);
    expect(seen.out).toEqual([formatLogLine(older), formatLogLine(newer)]);
  });

  it("caps at --limit from the newest end and reports the truncation on stderr", async () => {
    writeChannel("cli.log", [record(BASE - 2_000, "cli", "a"), record(BASE - 1_000, "cli", "b"), record(BASE, "cli", "c")]);

    const seen = capture();
    await runLogsQuery({ logDir: dir, limit: 2, order: "desc", json: false, follow: false }, seen.io);
    expect(seen.out).toHaveLength(2);
    expect(seen.out[0]).toContain("— c");
    expect(seen.err.join("\n")).toContain("truncated at --limit 2");
  });

  it("counts malformed lines, keeps the good ones and still exits 0", async () => {
    const good = record(BASE, "cli", "survived");
    writeChannel("cli.log", ["{not json", "", good, "[]"]);

    const seen = capture();
    expect(await runLogsQuery({ logDir: dir, limit: 100, order: "desc", json: false, follow: false }, seen.io)).toBe(0);
    expect(seen.out).toEqual([formatLogLine(good)]);
    // Two unusable lines: "{not json" and "[]"; the blank line is structural.
    expect(seen.err.join("\n")).toContain("skipped 2 malformed line(s)");
  });
});

// ── --json ─────────────────────────────────────────────────────────────────

describe("rolebox logs --json", () => {
  it("writes one raw JSON record per line and keeps stdout free of notes", async () => {
    const first = record(BASE - 1_000, "cli", "one", { fields: { count: 2 } });
    const second = record(BASE, "cli", "two", { code: "cli.example", scope: { sessionId: "s-1" } });
    writeChannel("cli.log", ["junk", first, second]);

    const seen = capture();
    await runLogsQuery({ logDir: dir, limit: 100, order: "desc", json: true, follow: false }, seen.io);

    expect(seen.out).toHaveLength(2);
    for (const line of seen.out) expect(line.includes("\n")).toBe(false);
    const parsed = seen.out.map((line) => JSON.parse(line) as LogRecord);
    expect(parsed[0]).toEqual(second);
    expect(parsed[1]).toEqual(first);
    // The malformed-line note is a note about the answer, not a record.
    expect(seen.out.some((line) => line.includes("skipped"))).toBe(false);
    expect(seen.err.join("\n")).toContain("skipped 1 malformed line(s)");
  });
});

// ── Filters ────────────────────────────────────────────────────────────────

describe("rolebox logs filters", () => {
  /** The fixture every filter case shares. */
  function writeFilterFixture(): { warn: LogRecord; error: LogRecord; debug: LogRecord } {
    const warn = record(BASE - 30_000, "graph:host", "a node attempt stalled", {
      level: "warn",
      code: "node.attempt.retry",
      fields: { reason: "timeout" },
      scope: { graphId: "g-42", sessionId: "s-7", nodeId: "impl" },
    });
    const error = record(BASE, "graph:host", "the index could not settle", {
      level: "error",
      code: "index.settle-failed",
      fields: { error: "Error" },
      scope: { graphId: "g-42" },
    });
    const debug = record(BASE - 45_000, "cli", "resolved the workspace root", {
      level: "debug",
      scope: { sessionId: "s-7" },
    });
    writeChannel("graph-host.log", [warn, error]);
    writeChannel("cli.log", [debug]);
    return { warn, error, debug };
  }

  /** The messages a query answers with, newest first. */
  async function messagesFor(args: Record<string, unknown>, now = BASE + 10_000): Promise<string[]> {
    const seen = capture();
    const options = parseLogsQueryArgs({ "log-dir": dir, ...args, json: true }, now);
    await runLogsQuery(options, seen.io);
    return (seen.out.map((line) => JSON.parse(line) as LogRecord)).map((item) => item.message);
  }

  it("--level is a threshold: warn shows warn and above", async () => {
    writeFilterFixture();
    expect(await messagesFor({ level: "warn" })).toEqual(["the index could not settle", "a node attempt stalled"]);
    expect(await messagesFor({ level: "error" })).toEqual(["the index could not settle"]);
  });

  it("--channel keeps only the named channels", async () => {
    writeFilterFixture();
    expect(await messagesFor({ channel: "cli" })).toEqual(["resolved the workspace root"]);
  });

  it("--code keeps only the named event codes", async () => {
    writeFilterFixture();
    expect(await messagesFor({ code: "node.attempt.retry" })).toEqual(["a node attempt stalled"]);
  });

  it("--graph and --session filter on the record scope", async () => {
    writeFilterFixture();
    expect(await messagesFor({ graph: "g-42" })).toEqual(["the index could not settle", "a node attempt stalled"]);
    expect(await messagesFor({ session: "s-7" })).toEqual(["a node attempt stalled", "resolved the workspace root"]);
  });

  it("--text searches message, code and field values, case-insensitively", async () => {
    writeFilterFixture();
    expect(await messagesFor({ text: "TIMEOUT" })).toEqual(["a node attempt stalled"]);
    expect(await messagesFor({ text: "settle-failed" })).toEqual(["the index could not settle"]);
    expect(await messagesFor({ text: "graph:host" })).toEqual(["the index could not settle", "a node attempt stalled"]);
  });

  it("--since resolves a relative duration against the caller's clock", async () => {
    writeFilterFixture();
    // 40 seconds before BASE: only the two records at BASE-30s and BASE remain.
    expect(await messagesFor({ since: "40s" })).toEqual(["the index could not settle", "a node attempt stalled"]);
  });

  it("--until and --since accept an ISO 8601 instant", async () => {
    writeFilterFixture();
    const before = new Date(BASE - 40_000).toISOString();
    expect(await messagesFor({ since: before })).toEqual(["the index could not settle", "a node attempt stalled"]);
    expect(await messagesFor({ until: before })).toEqual(["resolved the workspace root"]);
  });

  it("combines filters with AND and answers nothing (exit 0) when none match", async () => {
    writeFilterFixture();
    expect(await messagesFor({ graph: "g-42", channel: "cli" })).toEqual([]);
  });
});

// ── Empty answers and exit codes ───────────────────────────────────────────

describe("rolebox logs exit behaviour", () => {
  it("answers a directory that does not exist with exit 0 and an actionable hint", async () => {
    const seen = capture();
    const missing = join(dir, "not-created");
    expect(await runLogsQuery({ logDir: missing, limit: 100, order: "desc", json: false, follow: false }, seen.io)).toBe(0);
    expect(seen.out).toEqual([]);
    expect(seen.err[0]).toBe(`no log directory at ${missing}`);
    expect(seen.err[1]).toContain("hint:");
  });

  it("answers a directory with no log files with exit 0 and an actionable hint", async () => {
    writeFileSync(join(dir, "notes.txt"), "not a log file\n", "utf8");
    const seen = capture();
    expect(await runLogsQuery({ logDir: dir, limit: 100, order: "desc", json: false, follow: false }, seen.io)).toBe(0);
    expect(seen.out).toEqual([]);
    expect(seen.err[0]).toBe(`no log files in ${dir} yet`);
    expect(seen.err[1]).toContain("hint:");
  });

  it("answers an empty result with exit 0 and a note on stderr", async () => {
    writeChannel("cli.log", [record(BASE, "cli", "only record")]);
    const seen = capture();
    const code = await runLogsQuery(
      { logDir: dir, limit: 100, order: "desc", json: false, follow: false, text: "nothing matches this" },
      seen.io,
    );
    expect(code).toBe(0);
    expect(seen.out).toEqual([]);
    expect(seen.err.join("\n")).toContain("no records matched");
  });

  it("reads the resolved directory when --log-dir is absent (ROLEBOX_LOG_DIR decides)", async () => {
    const original = process.env.ROLEBOX_LOG_DIR;
    try {
      writeChannel("cli.log", [record(BASE, "cli", "through the environment")]);
      setLogEnv("ROLEBOX_LOG_DIR", dir);
      const seen = capture();
      await runLogsQuery({ limit: 100, order: "desc", json: true, follow: false }, seen.io);
      expect(seen.out).toHaveLength(1);
      expect((JSON.parse(seen.out[0] ?? "{}") as LogRecord).message).toBe("through the environment");
    } finally {
      setLogEnv("ROLEBOX_LOG_DIR", original);
    }
  });

  it("reports an invalid argument as exit 1 with the usage line, through citty", async () => {
    writeChannel("cli.log", [record(BASE, "cli", "a record")]);
    const captured = captureConsole();
    try {
      await runCommandWith(logsCommand, { "log-dir": dir, level: "verbose" });
    } finally {
      captured.restore();
    }
    expect(process.exitCode).toBe(1);
    expect(captured.stderr.join("\n")).toContain('Error: --level must be one of debug, info, warn, error, fatal (got "verbose")');
    expect(captured.stderr.join("\n")).toContain("Usage: rolebox logs [options]");
    expect(captured.stdout).toEqual([]);
  });

  it("answers through the citty wiring with exit 0", async () => {
    writeChannel("cli.log", [record(BASE, "cli", "through citty")]);
    const captured = captureConsole();
    try {
      await runCommandWith(logsCommand, { "log-dir": dir, json: true });
    } finally {
      captured.restore();
    }
    expect(process.exitCode).toBe(0);
    expect(captured.stdout).toHaveLength(1);
    expect((JSON.parse(captured.stdout[0] ?? "{}") as LogRecord).message).toBe("through citty");
  });

  it("does not answer a query when citty already ran a subcommand", async () => {
    writeChannel("cli.log", [record(BASE, "cli", "must not be queried")]);
    const captured = captureConsole();
    try {
      // citty 0.2.2 calls the subcommand AND the parent's run; the parent's run
      // is what stands down here, which is why stdout must stay empty.
      await runCommandWith(logsCommand, { _: ["files"], "log-dir": dir });
    } finally {
      captured.restore();
    }
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([]);
  });
});

// ── Explicit --log-dir vs the legacy ROLEBOX_LOG_FILE ──────────────────────

describe("rolebox logs --log-dir precedence", () => {
  /**
   * `<dir>/dirA/mine.log` (the file ROLEBOX_LOG_FILE will name) with two rotated
   * copies, and `<dir>/dirB` holding another channel's active file and rotation.
   * The messages differ, so reading the wrong source cannot pass by accident.
   */
  function writeTwoSources(): { legacy: string; dirB: string } {
    const dirA = join(dir, "dirA");
    const dirB = join(dir, "dirB");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const legacy = join(dirA, "mine.log");
    writeFileSync(legacy, JSON.stringify(record(BASE, "alpha", "from the legacy file")) + "\n", "utf8");
    writeFileSync(legacy + ".1", JSON.stringify(record(BASE - 1_000, "alpha", "legacy rotation")) + "\n", "utf8");
    writeFileSync(join(dirB, "other.log"), JSON.stringify(record(BASE, "other", "from the requested directory")) + "\n", "utf8");
    writeFileSync(join(dirB, "other.log.1"), JSON.stringify(record(BASE - 1_000, "other", "requested rotation")) + "\n", "utf8");
    return { legacy, dirB };
  }

  /** Run `body` with ROLEBOX_LOG_FILE set, restoring the variable afterwards. */
  async function withLogFile<T>(value: string, body: () => Promise<T>): Promise<T> {
    const original = process.env.ROLEBOX_LOG_FILE;
    setLogEnv("ROLEBOX_LOG_FILE", value);
    try {
      return await body();
    } finally {
      setLogEnv("ROLEBOX_LOG_FILE", original);
    }
  }

  it("reads the explicit --log-dir, not the file ROLEBOX_LOG_FILE names", async () => {
    const { legacy, dirB } = writeTwoSources();
    const seen = capture();
    await withLogFile(legacy, async () => {
      expect(await runLogsQuery({ logDir: dirB, limit: 100, order: "desc", json: true, follow: false }, seen.io)).toBe(0);
    });

    expect(seen.out.map((line) => (JSON.parse(line) as LogRecord).message)).toEqual([
      "from the requested directory",
      "requested rotation",
    ]);
    expect(seen.out.join("\n")).not.toContain("legacy");
    expect(seen.err).toEqual([]);
  });

  it("names the requested directory when it holds nothing, not the legacy file", async () => {
    const { legacy } = writeTwoSources();
    const empty = join(dir, "empty");
    mkdirSync(empty, { recursive: true });
    const seen = capture();
    await withLogFile(legacy, async () => {
      expect(await runLogsQuery({ logDir: empty, limit: 100, order: "desc", json: false, follow: false }, seen.io)).toBe(0);
    });

    expect(seen.out).toEqual([]);
    expect(seen.err[0]).toBe(`no log files in ${empty} yet`);
  });

  it("without --log-dir reads the legacy file the environment names", async () => {
    const { legacy } = writeTwoSources();
    const seen = capture();
    await withLogFile(legacy, async () => {
      expect(await runLogsQuery({ limit: 100, order: "desc", json: true, follow: false }, seen.io)).toBe(0);
    });

    expect(seen.out.map((line) => (JSON.parse(line) as LogRecord).message)).toEqual([
      "from the legacy file",
      "legacy rotation",
    ]);
  });

  it("names the legacy FILE, not a directory, when that file does not exist yet", async () => {
    const missing = join(dir, "dirA", "not-written-yet.log");
    mkdirSync(join(dir, "dirA"), { recursive: true });
    const seen = capture();
    await withLogFile(missing, async () => {
      expect(await runLogsQuery({ limit: 100, order: "desc", json: false, follow: false }, seen.io)).toBe(0);
    });

    expect(seen.out).toEqual([]);
    expect(seen.err[0]).toBe(`no log file at ${missing} yet`);
    expect(seen.err[1]).toContain("hint:");
  });
});

// ── The argument parser ────────────────────────────────────────────────────

describe("logs argument parsing", () => {
  const now = Date.parse("2026-10-08T12:00:00.000Z");

  it("defaults to the newest 100 records, human-rendered, without following", () => {
    expect(parseLogsQueryArgs({}, now)).toMatchObject({
      limit: 100,
      order: "desc",
      json: false,
      follow: false,
    });
  });

  it("resolves durations, ISO times and epoch milliseconds", () => {
    expect(parseLogTime("30s", now)).toBe(now - 30_000);
    expect(parseLogTime("10m", now)).toBe(now - 600_000);
    expect(parseLogTime("2h", now)).toBe(now - 7_200_000);
    expect(parseLogTime("1d", now)).toBe(now - 86_400_000);
    expect(parseLogTime("1w", now)).toBe(now - 604_800_000);
    expect(parseLogTime("2026-10-08T09:00:00.000Z", now)).toBe(Date.parse("2026-10-08T09:00:00.000Z"));
    expect(parseLogTime("1791450000000", now)).toBe(1791450000000);
  });

  it("rejects an ambiguous bare number and an unknown word", () => {
    expect(parseLogTime("10", now)).toBeUndefined();
    expect(parseLogTime("yesterday", now)).toBeUndefined();
    expect(parseLogTime("", now)).toBeUndefined();
  });

  it("rejects every value the command cannot honour", () => {
    const cases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ level: "verbose" }, "--level must be one of debug, info, warn, error, fatal"],
      [{ order: "newest" }, "--order must be asc or desc"],
      [{ limit: "x" }, "--limit must be a whole number"],
      [{ limit: "-1" }, "--limit must be at least 0"],
      [{ since: "yesterday" }, "--since must be a duration"],
      [{ until: "10" }, "--until must be a duration"],
      [{ channel: "" }, "--channel needs a value"],
      [{ since: "1h", until: "1d" }, "--since is later than --until"],
    ];
    for (const [args, message] of cases) {
      expect(() => parseLogsQueryArgs(args, now)).toThrow(LogsUsageError);
      expect(() => parseLogsQueryArgs(args, now)).toThrow(message);
    }
  });

  it("splits comma-separated channel and code lists", () => {
    expect(parseLogsQueryArgs({ channel: "cli, graph:host", code: "a.b,c.d" }, now)).toMatchObject({
      channels: ["cli", "graph:host"],
      codes: ["a.b", "c.d"],
    });
  });
});
