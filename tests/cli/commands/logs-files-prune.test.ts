/**
 * `rolebox logs files` and `rolebox logs prune`.
 *
 * The fixtures are laid out by hand under the OS temp directory — an active file
 * per channel plus rotated copies with controlled mtimes — so the two gates a
 * prune applies (`--keep` by rotation number, `--days` by mtime) can each be
 * exercised on their own. Nothing here goes near the workspace's own
 * `.rolebox/logs/`.
 *
 * The rule the prune cases exist to protect: an ACTIVE file is never removed,
 * whatever the options say.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import logsCommand, { logsFilesCommand, logsPruneCommand } from "../../../src/cli/commands/logs.ts";
import { runLogsFiles, runLogsPrune } from "../../../src/cli/commands/logs/logs-run.ts";
import type { LogsIo } from "../../../src/cli/commands/logs/logs-run.ts";
import { stripAnsi } from "../../../src/utils/text-format.ts";
import { setLogEnv } from "../../helpers/log.ts";

let dir: string;
/** `process.exitCode` as the test found it (its type admits null). */
let exitCode: string | number | null | undefined;
let originalRetain: string | undefined;
let originalLogFile: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rolebox-logs-files-"));
  exitCode = process.exitCode;
  originalRetain = process.env.ROLEBOX_LOG_RETAIN;
  originalLogFile = process.env.ROLEBOX_LOG_FILE;
  // The retention gate and the legacy single-file mode must not depend on the
  // developer's environment; a case that wants the legacy variable sets it.
  setLogEnv("ROLEBOX_LOG_RETAIN", undefined);
  setLogEnv("ROLEBOX_LOG_FILE", undefined);
});

afterEach(() => {
  setLogEnv("ROLEBOX_LOG_RETAIN", originalRetain);
  setLogEnv("ROLEBOX_LOG_FILE", originalLogFile);
  // Bun does not clear `process.exitCode` when it is assigned `undefined`, so
  // the restore must write a number (the captured value, or 0 when unset).
  process.exitCode = exitCode ?? 0;
  rmSync(dir, { recursive: true, force: true });
});

// ── Fixtures ───────────────────────────────────────────────────────────────

/** One JSON line, repeated so a file has a size worth reporting. */
function body(marker: string, times = 1): string {
  const line = JSON.stringify({
    time: 1,
    level: "info",
    channel: "graph:host",
    message: marker,
    fields: {},
    scope: {},
    process: { pid: 1, role: "host" },
  });
  return (line + "\n").repeat(times);
}

/** The active file of a channel. */
function activeFile(fileName: string, marker = "active"): string {
  const path = join(dir, fileName);
  writeFileSync(path, body(marker, 4), "utf8");
  return path;
}

/** One rotated copy, `ageDays` old by mtime. */
function rotatedFile(fileName: string, rotation: number, ageDays: number, times = 4): string {
  const path = join(dir, `${fileName}.${rotation}`);
  writeFileSync(path, body(`rotation ${rotation}`, times), "utf8");
  const seconds = Date.now() / 1000 - ageDays * 86_400;
  utimesSync(path, seconds, seconds);
  return path;
}

/** A collector standing in for the two writers. */
function capture(): { out: string[]; err: string[]; io: LogsIo } {
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

/** The plain text of what a command wrote. */
function text(lines: readonly string[]): string {
  return stripAnsi(lines.join("\n"));
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

// ── `logs files` ───────────────────────────────────────────────────────────

describe("rolebox logs files", () => {
  it("lists the channel, rotation, size and mtime of every log file", () => {
    activeFile("graph-host.log");
    rotatedFile("graph-host.log", 1, 1);
    rotatedFile("graph-host.log", 2, 2);
    writeFileSync(join(dir, "notes.txt"), "not a log file\n", "utf8");

    const seen = capture();
    expect(runLogsFiles({ logDir: dir }, seen.io)).toBe(0);

    const rendered = text(seen.out);
    expect(rendered).toContain("3 log file(s) in " + dir);
    expect(rendered).toContain("CHANNEL");
    expect(rendered).toContain("ROTATION");
    expect(rendered).toContain("SIZE");
    expect(rendered).toContain("MODIFIED");
    const rows = rendered.split("\n").filter((line) => line.startsWith("  graph-host"));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("active");
    expect(rows[1]).toContain(".1");
    expect(rows[2]).toContain(".2");
    // Every row carries a size and a local mtime, the other two columns.
    for (const row of rows) {
      expect(row).toMatch(/\d+(\.\d+)? (B|KB|MB|GB)/);
      expect(row).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    }
    expect(rendered).toContain("1 active file(s), 2 rotated copy(ies)");
    expect(rendered).not.toContain("notes.txt");
    expect(seen.err).toEqual([]);
  });

  it("answers a directory with no log files with exit 0 and a hint", () => {
    const seen = capture();
    expect(runLogsFiles({ logDir: join(dir, "missing") }, seen.io)).toBe(0);
    expect(seen.out).toEqual([]);
    expect(seen.err[0]).toContain("no log directory at");
    expect(seen.err[1]).toContain("hint:");
  });

  it("answers through the citty command with exit 0", async () => {
    activeFile("cli.log");
    const captured = captureConsole();
    try {
      await runCommandWith(logsFilesCommand, { "log-dir": dir });
    } finally {
      captured.restore();
    }
    expect(process.exitCode).toBe(0);
    expect(text(captured.stdout)).toContain("1 log file(s) in " + dir);
  });

  it("leaves the default query silent when citty has already run `files`", async () => {
    activeFile("cli.log");
    const captured = captureConsole();
    try {
      await runCommandWith(logsCommand, { _: ["files"], "log-dir": dir });
    } finally {
      captured.restore();
    }
    // The subcommand itself is not run here; the point is that the parent's run
    // adds nothing on top of it.
    expect(captured.stdout).toEqual([]);
  });
});

// ── `logs prune` ───────────────────────────────────────────────────────────

describe("rolebox logs prune", () => {
  /** Five rotated copies, 2 to 10 days old, plus one active file. */
  function writePruneFixture(): { active: string; rotations: string[] } {
    const active = activeFile("graph-host.log");
    const rotations = [1, 2, 3, 4, 5].map((rotation) => rotatedFile("graph-host.log", rotation, rotation * 2));
    return { active, rotations };
  }

  it("removes only the copies beyond the retained window, never the active file", () => {
    const { active, rotations } = writePruneFixture();
    const seen = capture();
    expect(runLogsPrune({ logDir: dir, dryRun: false }, seen.io)).toBe(0);

    const rendered = text(seen.out);
    expect(rendered).toContain("Removed 2 rotated file(s)");
    expect(rendered).toContain("Active files are not touched");
    expect(existsSync(rotations[0] ?? "")).toBe(true);
    expect(existsSync(rotations[2] ?? "")).toBe(true);
    expect(existsSync(rotations[3] ?? "")).toBe(false);
    expect(existsSync(rotations[4] ?? "")).toBe(false);
    expect(existsSync(active)).toBe(true);
    expect(readFileSync(active, "utf8")).toBe(body("active", 4));
  });

  it("--dry-run reports what would go and removes nothing", () => {
    const { active, rotations } = writePruneFixture();
    const seen = capture();
    expect(runLogsPrune({ logDir: dir, dryRun: true }, seen.io)).toBe(0);

    const rendered = text(seen.out);
    expect(rendered).toContain("Dry run: would remove 2 rotated file(s)");
    expect(rendered).toContain("Active files are not touched");
    for (const path of [...rotations, active]) expect(existsSync(path)).toBe(true);
  });

  it("--days is an independent age gate: a candidate inside it survives", () => {
    const { rotations } = writePruneFixture();
    const seen = capture();
    // --keep 1 puts .2-.5 beyond the retained window, and the 30-day age gate
    // then spares every one of them (2-10 days old).
    expect(runLogsPrune({ logDir: dir, keep: 1, days: 30, dryRun: false }, seen.io)).toBe(0);
    const rendered = text(seen.out);
    expect(rendered).toContain("Nothing to prune: no rotated copy is beyond the retained window and older than 30 days");
    for (const path of rotations) expect(existsSync(path)).toBe(true);
  });

  it("--days removes the copies past the age gate and keeps the younger ones", () => {
    const { rotations } = writePruneFixture();
    const seen = capture();
    expect(runLogsPrune({ logDir: dir, keep: 1, days: 5, dryRun: false }, seen.io)).toBe(0);
    expect(existsSync(rotations[0] ?? "")).toBe(true); //  2 days old, inside --keep
    expect(existsSync(rotations[1] ?? "")).toBe(true); //  4 days old, beyond --keep but too young
    expect(existsSync(rotations[2] ?? "")).toBe(false); // 6 days old
    expect(existsSync(rotations[3] ?? "")).toBe(false); // 8 days old
    expect(existsSync(rotations[4] ?? "")).toBe(false); // 10 days old
    expect(text(seen.out)).toContain("Removed 3 rotated file(s)");
  });

  it("--keep 0 --days 0 removes every rotated copy and still keeps the active file", () => {
    const { active, rotations } = writePruneFixture();
    const seen = capture();
    expect(runLogsPrune({ logDir: dir, keep: 0, days: 0, dryRun: false }, seen.io)).toBe(0);
    for (const path of rotations) expect(existsSync(path)).toBe(false);
    expect(existsSync(active)).toBe(true);
    expect(text(seen.out)).toContain("Removed 5 rotated file(s)");
  });

  it("answers a directory that does not exist with exit 0 and the active-file sentence", () => {
    const seen = capture();
    expect(runLogsPrune({ logDir: join(dir, "missing"), dryRun: false }, seen.io)).toBe(0);
    const rendered = text(seen.out);
    expect(rendered).toContain("Nothing to prune");
    expect(rendered).toContain("Active files are not touched");
  });

  it("answers through the citty command with exit 0 and reports the removal", async () => {
    writePruneFixture();
    const captured = captureConsole();
    try {
      await runCommandWith(logsPruneCommand, { "log-dir": dir, "dry-run": true });
    } finally {
      captured.restore();
    }
    expect(process.exitCode).toBe(0);
    expect(text(captured.stdout)).toContain("Dry run: would remove 2 rotated file(s)");
  });

  it("--max-total-bytes reaches inside the kept window, oldest copy first", () => {
    const { active, rotations } = writePruneFixture();
    // Room for the active file and ONE rotated copy: the four oldest go, even
    // though --keep 99 says every one of them is inside the retained window.
    const budget = statSync(active).size + statSync(rotations[0] ?? "").size;
    const seen = capture();
    expect(runLogsPrune({ logDir: dir, keep: 99, maxTotalBytes: budget, dryRun: false }, seen.io)).toBe(0);

    const rendered = text(seen.out);
    expect(rendered).toContain("Removed 4 rotated file(s)");
    expect(rendered).toContain("Byte budget");
    expect(rendered).toContain(": met");
    expect(existsSync(rotations[0] ?? "")).toBe(true);
    for (const path of rotations.slice(1)) expect(existsSync(path)).toBe(false);
    expect(existsSync(active)).toBe(true);
    expect(readFileSync(active, "utf8")).toBe(body("active", 4));
  });

  it("--max-total-bytes says NOT met when the active file alone is over budget", () => {
    const { active, rotations } = writePruneFixture();
    const seen = capture();
    expect(runLogsPrune({ logDir: dir, keep: 99, maxTotalBytes: 1, dryRun: true }, seen.io)).toBe(0);

    const rendered = text(seen.out);
    expect(rendered).toContain("Dry run: would remove 5 rotated file(s)");
    expect(rendered).toContain(": NOT met");
    expect(rendered).toContain("active files are never removed");
    expect(existsSync(active)).toBe(true);
    for (const path of rotations) expect(existsSync(path)).toBe(true);
  });

  it("--days outranks the budget: a protected copy is never removed to meet it", () => {
    const { rotations } = writePruneFixture();
    const seen = capture();
    // Every copy is 2-10 days old, so a 30-day age gate protects all of them and
    // the budget simply cannot be met — the report says so instead of overriding.
    expect(runLogsPrune({ logDir: dir, keep: 99, days: 30, maxTotalBytes: 1, dryRun: false }, seen.io)).toBe(0);

    const rendered = text(seen.out);
    expect(rendered).toContain("Nothing to prune");
    expect(rendered).toContain(": NOT met");
    for (const path of rotations) expect(existsSync(path)).toBe(true);
  });

  it("--max-total-bytes travels through the citty command", async () => {
    const { active, rotations } = writePruneFixture();
    const budget = statSync(active).size + statSync(rotations[0] ?? "").size;
    const captured = captureConsole();
    try {
      await runCommandWith(logsPruneCommand, { "log-dir": dir, "max-total-bytes": String(budget), "dry-run": true });
    } finally {
      captured.restore();
    }
    expect(process.exitCode).toBe(0);
    expect(text(captured.stdout)).toContain("Byte budget");
  });

  it("rejects an unusable --max-total-bytes with exit 1 and the prune usage line", async () => {
    writePruneFixture();
    const captured = captureConsole();
    try {
      await runCommandWith(logsPruneCommand, { "log-dir": dir, "max-total-bytes": "1.5" });
    } finally {
      captured.restore();
    }
    expect(process.exitCode).toBe(1);
    expect(captured.stderr.join("\n")).toContain('Error: --max-total-bytes must be a whole number (got "1.5")');
    expect(captured.stderr.join("\n")).toContain("Usage: rolebox logs prune");
  });

  it("rejects an unusable --keep with exit 1 and the prune usage line", async () => {
    writePruneFixture();
    const captured = captureConsole();
    try {
      await runCommandWith(logsPruneCommand, { "log-dir": dir, keep: "-1" });
    } finally {
      captured.restore();
    }
    expect(process.exitCode).toBe(1);
    expect(captured.stderr.join("\n")).toContain('Error: --keep must be at least 0 (got "-1")');
    expect(captured.stderr.join("\n")).toContain("Usage: rolebox logs prune");
    expect(captured.stdout).toEqual([]);
  });
});

// ── Explicit --log-dir vs the legacy ROLEBOX_LOG_FILE ──────────────────────

describe("rolebox logs files/prune --log-dir precedence", () => {
  /**
   * `<dir>/legacy/mine.log` (the file ROLEBOX_LOG_FILE names) with a rotated
   * copy, and `<dir>/requested` with another channel's active file and rotation.
   * Both rotations are an hour old, so `--days 0` is deterministic: a
   * just-written file can carry an mtime a fraction of a millisecond in the
   * future, which `mtime <= now` would rightly keep.
   */
  function writeTwoSources(): { legacy: string; requested: string } {
    const legacyDir = join(dir, "legacy");
    const requested = join(dir, "requested");
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(requested, { recursive: true });
    const legacy = join(legacyDir, "mine.log");
    writeFileSync(legacy, body("legacy active", 4), "utf8");
    writeFileSync(legacy + ".1", body("legacy rotation", 4), "utf8");
    writeFileSync(join(requested, "other.log"), body("requested active", 4), "utf8");
    writeFileSync(join(requested, "other.log.1"), body("requested rotation", 4), "utf8");
    const anHourAgo = Date.now() / 1000 - 3_600;
    utimesSync(legacy + ".1", anHourAgo, anHourAgo);
    utimesSync(join(requested, "other.log.1"), anHourAgo, anHourAgo);
    return { legacy, requested };
  }

  it("files lists only the explicit directory and names that directory", () => {
    const { legacy, requested } = writeTwoSources();
    setLogEnv("ROLEBOX_LOG_FILE", legacy);
    const seen = capture();

    expect(runLogsFiles({ logDir: requested }, seen.io)).toBe(0);

    const rendered = text(seen.out);
    expect(rendered).toContain(`2 log file(s) in ${requested}`);
    expect(rendered).toContain("other");
    expect(rendered).not.toContain("mine");
    expect(seen.err).toEqual([]);
  });

  it("prune acts inside the explicit directory only, whatever ROLEBOX_LOG_FILE names", () => {
    const { legacy, requested } = writeTwoSources();
    const legacyRotation = readFileSync(legacy + ".1", "utf8");
    setLogEnv("ROLEBOX_LOG_FILE", legacy);
    const seen = capture();

    expect(runLogsPrune({ logDir: requested, keep: 0, days: 0, dryRun: false }, seen.io)).toBe(0);

    const rendered = text(seen.out);
    expect(rendered).toContain(`Source: the log directory ${requested}`);
    expect(rendered).toContain("Removed 1 rotated file(s)");
    expect(rendered).toContain(join(requested, "other.log.1"));
    expect(existsSync(join(requested, "other.log.1"))).toBe(false);
    expect(existsSync(join(requested, "other.log"))).toBe(true);
    // The legacy file and its rotation are outside the named source: untouched.
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(legacy + ".1")).toBe(true);
    expect(readFileSync(legacy + ".1", "utf8")).toBe(legacyRotation);
  });

  it("files names the legacy FILE when --log-dir is absent, because that is the source", () => {
    const { legacy } = writeTwoSources();
    setLogEnv("ROLEBOX_LOG_FILE", legacy);
    const seen = capture();

    expect(runLogsFiles({}, seen.io)).toBe(0);

    const rendered = text(seen.out);
    expect(rendered).toContain(`2 log file(s) for the legacy single file ${legacy}`);
    expect(rendered).toContain("mine");
    expect(rendered).toContain(".1");
    expect(seen.err).toEqual([]);
  });

  it("prune without --log-dir still acts on the legacy file's rotations", () => {
    const { legacy } = writeTwoSources();
    setLogEnv("ROLEBOX_LOG_FILE", legacy);
    const seen = capture();

    expect(runLogsPrune({ keep: 0, days: 0, dryRun: false }, seen.io)).toBe(0);

    const rendered = text(seen.out);
    expect(rendered).toContain(`Source: the legacy single file ${legacy}`);
    expect(existsSync(legacy + ".1")).toBe(false);
    expect(existsSync(legacy)).toBe(true);
  });
});
