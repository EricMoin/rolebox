// ── The `rolebox logs` runners ──────────────────────────────────────────────
//
// THREE COMMANDS, THREE ANSWERS, ONE EXIT-CODE CONTRACT:
//
//   • `rolebox logs` answers the records a query matches, newest first by
//     default, one line each — the runtime's own human line, or one raw JSON
//     record per line with `--json`. It writes to STDOUT, so `| jq` sees records
//     and nothing else; everything the operator should read about the answer
//     itself (an empty result, a truncation at `--limit`, malformed lines) goes
//     to STDERR.
//   • `rolebox logs files` answers the files on disk.
//   • `rolebox logs prune` removes ROTATED copies only and says so.
//
// EXIT CODES: 0 whenever the command answered — including "no records matched"
// and "there is no log directory (or legacy file) yet", which are answers, not
// failures — and 1
// only for an argument the command cannot honour, in which case the caller
// prints the usage line. Nothing here throws for a missing directory, an
// unreadable file or a file that cannot be removed: the read layer reports what
// it managed.
//
// WHAT A COMMAND PRINTS IS WHERE IT READ. The location in a heading, a report or
// an empty-answer note comes from the READ layer's own resolution
// ({@link resolveLogSource}), never from `--log-dir` alone: with no flag and
// ROLEBOX_LOG_FILE set the source is that ONE file, so the output names the file
// (or the file's own directory) instead of a directory the command never
// touched. `--log-dir <D>` is a source the caller named: exactly <D> is read,
// listed and pruned, and the legacy variable does not outrank it.
//
// TESTABILITY IS PART OF THE CONTRACT. The runners take an {@link LogsIo} seam:
// where a line goes, what "now" is, and for `--follow` the abort signal and the
// waiter the follower polls with. That is what lets a test step the follower
// instead of hanging on a live tail.

import { existsSync } from "node:fs";

import {
  followLogRecords,
  listLogFiles,
  pruneLogs,
  readLogRecords,
  resolveLogSource,
  type LogQuery,
} from "../../../log/index.ts";
import type { LogFileInfo, LogSource } from "../../../log/index.ts";
import type { LogRecord } from "../../../log/types.ts";
import type { LogsFilesArgs, LogsPruneArgs, LogsQueryArgs } from "./logs-args.ts";
import { renderFileTable, renderPruneReport, renderRecord } from "./logs-render.ts";

/** How many milliseconds one day is worth, for `prune --days`. */
const DAY_MS = 86_400_000;

/** Where a line goes; both default to the console. */
export interface LogsIo {
  /** One stdout line; defaults to `console.log`. */
  readonly out?: (line: string) => void;
  /** One stderr line — hints, truncation notes, usage errors; defaults to `console.error`. */
  readonly err?: (line: string) => void;
  /** Stop `--follow` when this aborts (the CLI wires SIGINT to it). */
  readonly signal?: AbortSignal;
  /** How often `--follow` polls; defaults to the read layer's own interval. */
  readonly pollMs?: number;
  /** The waiter `--follow` sleeps with; injectable so a test can step the follower. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The two writers an answer uses, resolved once. */
interface Writers {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Resolve the writers, defaulting to the console. */
function writers(io: LogsIo): Writers {
  return {
    out: io.out ?? ((line: string): void => console.log(line)),
    err: io.err ?? ((line: string): void => console.error(line)),
  };
}

/** The location options the read layer accepts, with an absent `--log-dir` left out. */
function location(logDir: string | undefined): { readonly logDir?: string } {
  return logDir === undefined ? {} : { logDir };
}

/**
 * Where the command ACTUALLY reads: the read layer's own resolution. An explicit
 * `--log-dir` is the source; without it the writer's chain decides, and when
 * ROLEBOX_LOG_FILE names one file, that file is the source — which is what the
 * output must name. Sharing the resolution with {@link listLogFiles} is what
 * keeps a printed location and a read location from disagreeing.
 */
function readSource(logDir: string | undefined): LogSource {
  return resolveLogSource(location(logDir));
}

/** The read layer's query for a parsed command line. */
function toQuery(args: LogsQueryArgs): LogQuery {
  return {
    ...location(args.logDir),
    minLevel: args.minLevel,
    channels: args.channels,
    codes: args.codes,
    graphId: args.graphId,
    sessionId: args.sessionId,
    since: args.sinceMs,
    until: args.untilMs,
    text: args.text,
    limit: args.limit,
    order: args.order,
  };
}

/** The sentence for a source that holds nothing to read yet, or does not exist. */
function describeMissingSource(source: LogSource): string {
  if (source.kind === "file") return `no log file at ${source.path} yet`;
  return existsSync(source.path) ? `no log files in ${source.path} yet` : `no log directory at ${source.path}`;
}

/** Say where the command looked, and how to look elsewhere. */
function reportNothingToRead(write: Writers, source: LogSource): void {
  write.err(describeMissingSource(source));
  write.err(
    source.kind === "file"
      ? "hint: pass --log-dir <path> to read a directory, or unset ROLEBOX_LOG_FILE"
      : "hint: pass --log-dir <path>, or set ROLEBOX_LOG_DIR for the process that writes the records",
  );
}

/**
 * Say that a `--follow` found nothing YET and is waiting rather than exiting.
 * Like `tail -f`, the follower does not need the file to exist when it starts:
 * the read layer reads a file that appears later from its beginning, so the
 * first record a process writes is delivered.
 */
function reportWaitingToFollow(write: Writers, source: LogSource): void {
  write.err(describeMissingSource(source));
  write.err("waiting for the first record; Ctrl-C to stop");
}

/** Wait until `signal` aborts; a signal that is already aborted answers at once. */
function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Stream records written after the call, until the signal aborts.
 *
 * It starts at the CURRENT end of every file — like `tail -f`, a follower does
 * not replay the past — and `--limit`/`--order` do not apply, because a stream
 * has no end to cap or to order against. SIGINT is turned into a clean stop when
 * the caller did not bring its own signal: the process then exits 0 with no
 * stack trace.
 */
async function follow(query: LogsQueryArgs, io: LogsIo, write: Writers): Promise<number> {
  // The caller's signal when it brought one (a test, a wrapper), otherwise a
  // controller this command owns and SIGINT aborts.
  const owned = io.signal === undefined ? new AbortController() : undefined;
  const signal = owned === undefined ? io.signal : owned.signal;
  if (signal === undefined) return 0;

  const onInterrupt = (): void => {
    owned?.abort();
  };
  if (owned !== undefined) process.on("SIGINT", onInterrupt);

  const emit = (record: LogRecord): void => {
    write.out(renderRecord(record, query.json));
  };

  const stop = followLogRecords(
    { ...toQuery(query), pollMs: io.pollMs, sleep: io.sleep, signal },
    emit,
  );

  try {
    await waitForAbort(signal);
  } finally {
    stop();
    if (owned !== undefined) process.removeListener("SIGINT", onInterrupt);
  }
  return 0;
}

/**
 * `rolebox logs` — answer the records the query matches.
 *
 * A source that holds no log file is an ANSWER, not an error: the command names
 * the location it actually read — the directory, or the ONE file
 * ROLEBOX_LOG_FILE names — and exits 0. With `--follow` that answer waits
 * instead, and the note about waiting goes to stderr. Records go to stdout; the
 * notes about the answer go to stderr, so `--json` stays parseable.
 */
export async function runLogsQuery(args: LogsQueryArgs, io: LogsIo = {}): Promise<number> {
  const write = writers(io);
  const source = readSource(args.logDir);
  const files: LogFileInfo[] = listLogFiles(location(args.logDir));
  if (files.length === 0 && args.follow) {
    // `--follow` on a source with nothing in it yet WAITS, like `tail -f`: the
    // first record may create the file (or the whole directory) after the
    // command started. The note goes to stderr, so a `| jq` pipeline still sees
    // only records.
    reportWaitingToFollow(write, source);
    return follow(args, io, write);
  }
  if (files.length === 0) {
    reportNothingToRead(write, source);
    return 0;
  }

  if (args.follow) return follow(args, io, write);

  const result = readLogRecords(toQuery(args));
  for (const record of result.records) write.out(renderRecord(record, args.json));

  if (result.records.length === 0) {
    write.err(`no records matched (${result.scannedFiles} file(s) scanned)`);
  }
  if (result.truncated) {
    write.err(`output truncated at --limit ${args.limit}; raise --limit to see more`);
  }
  if (result.skippedLines > 0) {
    write.err(`skipped ${result.skippedLines} malformed line(s) while reading ${result.scannedFiles} file(s)`);
  }
  return 0;
}

/**
 * `rolebox logs files` — answer the log files at the source: the channel the file
 * name spells, the rotation, the size and the mtime. `--log-dir <D>` reads
 * exactly <D>; without it the resolved source decides, and when ROLEBOX_LOG_FILE
 * names one file the heading names that file and lists its rotated copies. A
 * source that does not exist is again an answer (exit 0) with the same hint.
 */
export function runLogsFiles(args: LogsFilesArgs, io: LogsIo = {}): number {
  const write = writers(io);
  const source = readSource(args.logDir);
  const files = listLogFiles(location(args.logDir));
  if (files.length === 0) {
    reportNothingToRead(write, source);
    return 0;
  }
  for (const line of renderFileTable(files, source)) write.out(line);
  return 0;
}

/**
 * `rolebox logs prune` — remove ROTATED copies, and only rotated copies.
 *
 * The two gates are independent and a file must pass BOTH: `--keep` (default:
 * the writer's own retention, ROLEBOX_LOG_RETAIN else 3) says how many of a
 * channel's newest rotated copies are never candidates, and `--days` says how
 * old by mtime a candidate must additionally be. `--max-total-bytes` is a third,
 * harder gate: it may reach inside the kept window (a disk budget is a budget),
 * but never past `--days`, and it never touches an active file.
 * `--dry-run` reports what would go and removes nothing. The report names the
 * source it acted on — `--log-dir <D>` is exactly <D>, so nothing outside it can
 * be removed — and always states that active files were not touched.
 */
export function runLogsPrune(args: LogsPruneArgs, io: LogsIo = {}): number {
  const write = writers(io);
  const source = readSource(args.logDir);
  const files = listLogFiles(location(args.logDir));
  const activeFiles = files.filter((file) => file.rotation === 0).map((file) => file.path);
  const result = pruneLogs({
    ...location(args.logDir),
    keepRotated: args.keep,
    olderThanMs: args.days === undefined ? undefined : Math.round(args.days * DAY_MS),
    maxTotalBytes: args.maxTotalBytes,
    dryRun: args.dryRun,
  });
  for (const line of renderPruneReport({
    result,
    dryRun: args.dryRun,
    days: args.days,
    maxTotalBytes: args.maxTotalBytes,
    activeFiles,
    source,
  })) {
    write.out(line);
  }
  return 0;
}
