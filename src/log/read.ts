// ── The read side of the log files ──────────────────────────────────────────
//
// THE OTHER HALF OF THE FILE SINK. src/log/sinks/file.ts appends one JSON object
// per line to `<logDir>/<channel>.log` (or the ONE file ROLEBOX_LOG_FILE names)
// and rotates it to `.1`, `.2`, … This module turns those lines back into
// records: list the files, query them, follow them while they grow, and prune
// the rotated copies the writer left behind. It is the only module that reads
// the format, and it reuses the writer's conventions instead of restating them:
// resolveLogDir/resolveLogFile decide WHERE the files are, RETAIN_ENV and
// DEFAULT_RETAIN decide how many rotated copies survive, and DEFAULT_LOG_CHANNEL
// is the channel a nameless record falls back to.
//
// THE FILE NAME IS THE CHANNEL'S NAME, SANITIZED. `graph:host` writes
// `graph-host.log`, so the channel a file belongs to cannot be recovered exactly
// from its name — `graph-host.log` could have come from `graph:host`, from
// `graph-host` or from `graph host`. listLogFiles therefore reports the file
// STEM as the channel (the name the sink would give that channel), and every
// record carries the channel it was written with, which is what the `channels`
// filter compares against.
//
// WHAT THE READER TOLERATES. The files are shared with other processes, other
// rolebox versions and a human with an editor, so a line is allowed to be junk:
// a line that is not JSON, or JSON that is not a record, is COUNTED and SKIPPED
// (`skippedLines`, plus a bounded `malformedSamples` for the operator), never
// thrown. A record that is missing `fields`, `scope`, `process`, `level`,
// `channel` or `time` is normalised to the same defaults the writer would have
// used, and unknown extra keys are ignored rather than rejected — a newer
// version may write fields this one does not know. Nothing in this module
// throws: a missing directory answers an empty list, an unreadable file is
// skipped, and pruning reports what it could not remove.
//
// A LEGACY SINGLE FILE IS JUST ANOTHER CHANNEL FILE, and callers must not
// pretend otherwise. Before the per-channel layout every record went to one
// `rolebox.log`; the read side cannot tell that file from a channel literally
// named `rolebox`, because both are `<channel>.log`. Such a file is therefore
// listed and scanned like any other, and its historical tslog lines (valid JSON
// in the old tslog shape, but not record-shaped) are counted in `skippedLines`
// rather than silently ignored — a workspace that still carries one reports a
// large malformed count for it. The reader never rewrites or removes it: only
// the writer decides where records go from now on. (ROLEBOX_LOG_FILE is
// different again: it names ONE file that every channel is currently writing
// to.)
//
// AN EXPLICIT SOURCE BEATS THE ENVIRONMENT. The four entry points below resolve
// their location through {@link resolveLogSource}: a `logFile` the caller named
// wins outright; a `logDir` the caller named is read and NOTHING else — the
// legacy ROLEBOX_LOG_FILE does not outrank it, so `rolebox logs --log-dir <D>`
// can neither list nor delete a file outside <D>, and the location a command
// prints is the location it read. Only when the caller names neither does the
// writer's chain decide, ROLEBOX_LOG_FILE first. The WRITE side keeps the
// opposite precedence (ROLEBOX_LOG_FILE still beats a configured directory
// there, so one process logs to one file); read-side explicitness is what makes
// an explicit request mean what it says.
//
// ORDER AND LIMITS. readLogRecords answers by `time` ascending by default (the
// order an operator reads a story in) and caps the answer at
// DEFAULT_LOG_QUERY_LIMIT; `truncated` says whether the cap cut it. With
// `order: "desc"` the newest records come first AND the cap keeps the newest
// ones, which is what a "show me the last N" query means. Files are scanned
// oldest-first (`.N … .1`, active file last), so scan order is chronological,
// and records with equal times keep that scan order under `asc`; `desc` reverses
// the whole answer, so equal times come back in reverse scan order there.
//
// ONE LINE HAS TO BE COMPLETE. A blank line (the trailing newline of a file, an
// empty line an editor left) is structural and is neither a record nor a
// malformed line.

import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// The kernel facade and the runtime slot, NOT the retired src/logger.ts shim:
// the two constants below are the writer's own fallbacks, reused so a record
// this module reads back cannot disagree with the one the kernel would build.
import { DEFAULT_LOG_CHANNEL } from "./logger.ts";
import { DEFAULT_LOG_ROLE } from "./runtime.ts";
import { DEFAULT_RETAIN, RETAIN_ENV, resolveLogDir, resolveLogFile } from "./sinks/file.ts";
import {
  LOG_LEVEL_RANK,
  isLogLevel,
  parseLogLevel,
  type LogFieldValue,
  type LogFields,
  type LogLevel,
  type LogProcessIdentity,
  type LogRecord,
  type LogScope,
} from "./types.ts";

/** How many records a query answers with when it does not name a `limit`. */
export const DEFAULT_LOG_QUERY_LIMIT = 1000;

/** How often a follower polls when it does not name a `pollMs`. */
export const DEFAULT_FOLLOW_POLL_MS = 250;

/** How many malformed samples a query keeps (the count is never capped). */
const MALFORMED_SAMPLE_LIMIT = 10;

/** How much of a malformed line a sample keeps. */
const MALFORMED_SAMPLE_LENGTH = 200;

/**
 * A channel file, with its optional rotation suffix: `<channel>.log` is the
 * active file, `<channel>.log.N` the Nth rotated copy. Channel names are
 * sanitized by the sink, so a writer-produced name never contains a dot.
 */
const CHANNEL_FILE_NAME = /^(.+)\.log(?:\.(\d+))?$/;

/** The keys that make a parsed JSON object a log record rather than junk. */
const RECORD_KEY_HINTS: readonly string[] = ["time", "level", "channel", "message"];

/** The scope entries a record may carry; anything else is dropped. */
const SCOPE_KEYS: readonly (keyof LogScope)[] = [
  "sessionId",
  "agent",
  "graphId",
  "runId",
  "nodeId",
  "attemptId",
  "effectId",
  "tool",
];

/** The scope entries a query can filter on. */
const SCOPE_FILTER_KEYS = ["graphId", "runId", "nodeId", "attemptId", "sessionId", "tool"] as const;

/** Ascending (oldest first) or descending (newest first). */
export type LogOrder = "asc" | "desc";

/** What {@link listLogFiles} and the query functions accept as a location. */
export interface ListLogFilesOptions {
  /**
   * An explicit directory: the caller named the source, so ONLY this directory is
   * read and ROLEBOX_LOG_FILE does not outrank it. Without it, the writer's chain
   * decides (ROLEBOX_LOG_FILE, then ROLEBOX_LOG_DIR and its fallbacks).
   */
  readonly logDir?: string;
  /** ONE file every channel wrote to (legacy mode); beats `logDir` when given. */
  readonly logFile?: string;
}

/**
 * Where a read actually looks. `file` is the legacy single-file mode: one file
 * holds every channel's records and only it and its rotated copies are read.
 * `dir` is the per-channel layout inside one directory.
 */
export interface LogSource {
  readonly kind: "file" | "dir";
  /** The file (`kind: "file"`) or the directory (`kind: "dir"`) that is read. */
  readonly path: string;
}

/** One JSON-lines file on disk, as {@link listLogFiles} reports it. */
export interface LogFileInfo {
  /** The absolute or caller-relative path of the file. */
  readonly path: string;
  /**
   * The channel name the FILE NAME spells — the sink's sanitized channel, e.g.
   * `graph-host` for `graph-host.log`. Records carry the exact channel.
   */
  readonly channel: string;
  /** 0 for the ACTIVE file; N for `<file>.log.N` (the writer's Nth rotated copy). */
  readonly rotation: number;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

/**
 * What a query filters on. Every field is optional and independent: the fields a
 * call names are ANDed, an empty array or blank string is "no filter at all",
 * and a filter this build does not understand is ignored rather than fatal.
 */
export interface LogQuery {
  /**
   * An explicit directory: the caller named the source, so ONLY this directory is
   * read and ROLEBOX_LOG_FILE does not outrank it. Without it, the writer's chain
   * decides (ROLEBOX_LOG_FILE, then ROLEBOX_LOG_DIR and its fallbacks).
   */
  readonly logDir?: string;
  /** ONE file every channel wrote to (legacy mode); beats `logDir` when given. */
  readonly logFile?: string;
  /** Read exactly these files (rotated copies included); beats the directory scan. */
  readonly files?: readonly string[];
  /** Keep records whose level is one of these; an empty list keeps every level. */
  readonly levels?: readonly LogLevel[];
  /** Keep records at or above this level. Combined with `levels` when both are given. */
  readonly minLevel?: LogLevel;
  /** Keep records whose `channel` is one of these. */
  readonly channels?: readonly string[];
  /** Keep records whose `code` is one of these; a record without a code never matches. */
  readonly codes?: readonly string[];
  /** Scope filters: the record's scope entry must equal the value exactly. */
  readonly graphId?: string;
  readonly runId?: string;
  readonly nodeId?: string;
  readonly attemptId?: string;
  readonly sessionId?: string;
  readonly tool?: string;
  /** Keep records at or after this epoch-millisecond time (inclusive). */
  readonly since?: number;
  /** Keep records at or before this epoch-millisecond time (inclusive). */
  readonly until?: number;
  /**
   * Case-insensitive substring, looked for in the record's `message`, its
   * `channel`, its `code` and every FIELD value (arrays joined with ",").
   * Scope ids are not searched — use the scope filters for those.
   */
  readonly text?: string;
  /** How many records to answer with; defaults to {@link DEFAULT_LOG_QUERY_LIMIT}. */
  readonly limit?: number;
  /** `asc` (default) answers oldest first; `desc` answers newest first. */
  readonly order?: LogOrder;
}

/** What a query answers. */
export interface LogReadResult {
  /** The records, filtered, ordered and capped. */
  readonly records: LogRecord[];
  /** How many files were actually read (a missing or unreadable file is not one). */
  readonly scannedFiles: number;
  /** How many lines were skipped because they were not a usable record. */
  readonly skippedLines: number;
  /** Up to ten skipped lines, for the operator to look at; the count is exact. */
  readonly malformedSamples: string[];
  /** True when matching records existed beyond `limit` and were left out. */
  readonly truncated: boolean;
}

/** The mutable collector a scan fills; LogReadResult is its frozen answer. */
interface ReadState {
  records: LogRecord[];
  scannedFiles: number;
  skippedLines: number;
  malformedSamples: string[];
}

/** What {@link followLogRecords} accepts beyond the query. */
export interface FollowLogOptions extends LogQuery {
  /** How often to poll; defaults to {@link DEFAULT_FOLLOW_POLL_MS}. */
  readonly pollMs?: number;
  /** Stop the follower when this signal aborts. */
  readonly signal?: AbortSignal;
  /**
   * How the follower waits between polls; defaults to a `setTimeout` sleep.
   * Injectable so a test can step the follower instead of waiting.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** What {@link pruneLogs} accepts. */
export interface PruneLogsOptions {
  /**
   * An explicit directory: the caller named the source, so ONLY this directory is
   * pruned and ROLEBOX_LOG_FILE does not outrank it. Without it, the writer's
   * chain decides (ROLEBOX_LOG_FILE, then ROLEBOX_LOG_DIR and its fallbacks).
   */
  readonly logDir?: string;
  /** ONE file every channel wrote to (legacy mode); beats `logDir` when given. */
  readonly logFile?: string;
  /**
   * Only consider rotated copies at least this old (mtime <= now - olderThanMs).
   * A missing or invalid value is no age limit.
   */
  readonly olderThanMs?: number;
  /**
   * How many rotated copies to KEEP per channel; defaults to the same retention
   * the writer uses (ROLEBOX_LOG_RETAIN, else DEFAULT_RETAIN). 0 keeps none.
   */
  readonly keepRotated?: number;
  /** Report what would be removed without removing anything. */
  readonly dryRun?: boolean;
  /**
   * A BYTE BUDGET for the whole source: after the retention and age gates have
   * run, the oldest rotated copies still present are removed until every log
   * file left (active files included) fits in this many bytes. Active files are
   * still never candidates, so a budget smaller than the active files' own size
   * cannot be met — {@link PruneBudgetReport.satisfied} then says so. Omitted
   * means no budget.
   */
  readonly maxTotalBytes?: number;
}

/** What a byte budget did, reported only when {@link PruneLogsOptions.maxTotalBytes} was given. */
export interface PruneBudgetReport {
  /** The budget the prune worked to. */
  readonly maxTotalBytes: number;
  /**
   * Rotated copies removed (or, under `dryRun`, that would be removed) TO MEET
   * THE BUDGET — a subset of {@link PruneLogsResult.removed}, counted apart from
   * the copies the retention and age gates had already rejected.
   */
  readonly removed: number;
  /** Bytes of every log file left after the prune (active files and survivors). */
  readonly remainingBytes: number;
  /** True when the files left fit the budget; false when active files alone exceed it. */
  readonly satisfied: boolean;
}

/** One file a prune removed (or, under `dryRun`, would remove). */
export interface PruneRemoval {
  readonly path: string;
  readonly sizeBytes: number;
}

/** What a prune did. */
export interface PruneLogsResult {
  /** The rotated copies removed (or, under `dryRun`, that would be removed). */
  readonly removed: PruneRemoval[];
  /** The bytes those files held; under `dryRun`, the bytes that would be freed. */
  readonly freedBytes: number;
  /** How many ROTATED copies were left in place — active files are never counted. */
  readonly kept: number;
  /** Present only when the caller set a byte budget; see {@link PruneBudgetReport}. */
  readonly budget?: PruneBudgetReport;
}

/** A file's identity, its size and its modification time. */
interface FileStat {
  readonly dev: number;
  readonly ino: number;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

/** Stat a readable regular file; `undefined` for missing, unreadable or a directory. */
function statLogFile(path: string): FileStat | undefined {
  try {
    const info = statSync(path);
    if (!info.isFile()) return undefined;
    return { dev: info.dev, ino: info.ino, sizeBytes: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  }
}

/** The entries of a directory, or `[]` when it cannot be read. */
function directoryEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** The channel and rotation a writer-produced file name spells, if it is one. */
function channelFileParts(name: string): { channel: string; rotation: number } | undefined {
  const match = CHANNEL_FILE_NAME.exec(name);
  if (match === null) return undefined;
  const channel = match[1] ?? "";
  if (channel.length === 0 || channel.replace(/\./g, "").length === 0) return undefined;
  const suffix = match[2];
  // The writer only ever rotates to `.1` and up, so a `.log.0` name (which it
  // cannot produce) is reported as rotation 1: `rotation === 0` always means the
  // ACTIVE file, the one prune must never remove.
  return { channel, rotation: suffix === undefined ? 0 : Math.max(1, Number.parseInt(suffix, 10)) };
}

/** The channel a legacy single file's name suggests, when it is not a `.log` name. */
function legacyChannel(single: string): string {
  const parts = channelFileParts(basename(single));
  if (parts !== undefined) return parts.channel;
  const name = basename(single);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem.length > 0 ? stem : DEFAULT_LOG_CHANNEL;
}

/**
 * THE READ-SIDE PRECEDENCE, IN ONE PLACE. Every entry point below resolves its
 * location here, so the answer a caller reads and the location a caller prints
 * can never disagree.
 *
 * An EXPLICIT source beats the environment, and the environment decides only
 * when the caller named nothing:
 *
 *   1. `logFile` — the caller named one file; it is read;
 *   2. `logDir` — the caller named a directory, which is read and nothing else;
 *      ROLEBOX_LOG_FILE is deliberately NOT consulted here;
 *   3. neither — the writer's own chain: ROLEBOX_LOG_FILE (one file) first, else
 *      resolveLogDir (ROLEBOX_LOG_DIR → workspace `.rolebox/logs` → config →
 *      tmp).
 *
 * Step 3 is what keeps a process that logs to one legacy file readable without
 * options; steps 1-2 are what make `rolebox logs --log-dir <D>` mean <D>.
 */
export function resolveLogSource(options?: ListLogFilesOptions): LogSource {
  const explicitFile = nonBlank(options?.logFile);
  if (explicitFile !== undefined) return { kind: "file", path: explicitFile };
  if (nonBlank(options?.logDir) !== undefined) return { kind: "dir", path: resolveLogDir({ dir: options?.logDir }) };
  const single = resolveLogFile();
  if (single !== undefined) return { kind: "file", path: single };
  return { kind: "dir", path: resolveLogDir() };
}

/** Every log file present, in SCAN order: channel ascending, rotation descending. */
function scanLogFiles(options?: ListLogFilesOptions): LogFileInfo[] {
  const files: LogFileInfo[] = [];
  const source = resolveLogSource(options);
  if (source.kind === "file") {
    collectSingleFile(source.path, files);
  } else {
    for (const name of directoryEntries(source.path)) {
      const parts = channelFileParts(name);
      if (parts === undefined) continue;
      const path = join(source.path, name);
      const info = statLogFile(path);
      if (info === undefined) continue;
      files.push({ path, channel: parts.channel, rotation: parts.rotation, sizeBytes: info.sizeBytes, mtimeMs: info.mtimeMs });
    }
  }
  files.sort((left, right) => compareLogFiles(left, right, "desc"));
  return files;
}

/** Collect the ONE legacy file and its rotated siblings. */
function collectSingleFile(single: string, files: LogFileInfo[]): void {
  const channel = legacyChannel(single);
  const add = (path: string, rotation: number): void => {
    const info = statLogFile(path);
    if (info === undefined) return;
    files.push({ path, channel, rotation, sizeBytes: info.sizeBytes, mtimeMs: info.mtimeMs });
  };
  add(single, 0);
  const dir = dirname(single);
  const prefix = basename(single) + ".";
  for (const name of directoryEntries(dir)) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    add(join(dir, name), Math.max(1, Number.parseInt(suffix, 10)));
  }
}

/**
 * Order two files by channel, then by rotation in `direction` ("asc" puts the
 * active file first, "desc" puts the oldest rotated copy first), then by path so
 * the order is total.
 */
function compareLogFiles(left: LogFileInfo, right: LogFileInfo, direction: "asc" | "desc"): number {
  const byChannel = left.channel.localeCompare(right.channel);
  if (byChannel !== 0) return byChannel;
  const byRotation = direction === "asc" ? left.rotation - right.rotation : right.rotation - left.rotation;
  if (byRotation !== 0) return byRotation;
  return left.path.localeCompare(right.path);
}

/**
 * List the JSON-lines files on disk: the active `<channel>.log` files and their
 * rotated copies, or — when `logFile` (or, with no explicit `logDir`,
 * ROLEBOX_LOG_FILE) names one file — that file and its rotations alone. An
 * explicit `logDir` is read on its own, whatever the environment says.
 * `rotation` is 0 for an active file and N for `.<N>`; `channel` is the name
 * the FILE NAME spells, not the channel the records inside carry. A missing
 * directory answers `[]` and nothing here throws.
 */
export function listLogFiles(options?: ListLogFilesOptions): LogFileInfo[] {
  try {
    return scanLogFiles(options).sort((left, right) => compareLogFiles(left, right, "asc"));
  } catch {
    return [];
  }
}

/** A non-empty string, or `undefined`. */
function nonBlank(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim().length > 0 ? value : undefined;
}

/** A JSON object that is not an array, or `undefined`. */
function plainObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** One field value, keeping only the shapes LogFields admits. */
function fieldValue(value: unknown): LogFieldValue | undefined {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) return value as string[];
    if (value.every((item) => typeof item === "number" && Number.isFinite(item))) return value as number[];
  }
  return undefined;
}

/** A record's fields, with unknown shapes and unknown nesting dropped. */
function normaliseFields(value: unknown): LogFields {
  const source = plainObject(value);
  if (source === undefined) return {};
  const fields: Record<string, LogFieldValue> = {};
  for (const key of Object.keys(source)) {
    const kept = fieldValue(source[key]);
    if (kept !== undefined) fields[key] = kept;
  }
  return fields;
}

/** A record's scope, keeping the known identity keys that carry a name. */
function normaliseScope(value: unknown): LogScope {
  const source = plainObject(value);
  if (source === undefined) return {};
  const scope: Record<string, string> = {};
  for (const key of SCOPE_KEYS) {
    const kept = nonBlank(source[key]);
    if (kept !== undefined) scope[key] = kept;
  }
  return scope;
}

/** A record's process identity, defaulting what another writer left out. */
function normaliseProcess(value: unknown): LogProcessIdentity {
  const source = plainObject(value);
  const pid = source !== undefined && typeof source.pid === "number" && Number.isFinite(source.pid) ? source.pid : 0;
  const role = (source !== undefined ? nonBlank(source.role) : undefined) ?? DEFAULT_LOG_ROLE;
  return { pid, role };
}

/** A record's time: a finite number, or 0 for a line that carries none. */
function normaliseTime(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * Turn one parsed JSON value into a record, or `undefined` when it is not one.
 * A value is a record when it is an object carrying at least one of `time`,
 * `level`, `channel` or `message`; the rest is filled in with the writer's
 * defaults, and every unknown key is ignored.
 */
function normaliseRecord(value: unknown): LogRecord | undefined {
  const source = plainObject(value);
  if (source === undefined) return undefined;
  if (!RECORD_KEY_HINTS.some((key) => Object.hasOwn(source, key))) return undefined;
  const record: LogRecord = {
    time: normaliseTime(source.time),
    level: parseLogLevel(source.level, "info"),
    channel: nonBlank(source.channel) ?? DEFAULT_LOG_CHANNEL,
    message: typeof source.message === "string" ? source.message : "",
    fields: normaliseFields(source.fields),
    scope: normaliseScope(source.scope),
    process: normaliseProcess(source.process),
  };
  const code = nonBlank(source.code);
  return code === undefined ? record : { ...record, code };
}

/** Parse one line into a record; `undefined` for junk, never an exception. */
function parseLogLine(line: string): LogRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  return normaliseRecord(value);
}

/** Count a skipped line and keep a bounded, single-line sample of it. */
function skipMalformed(state: ReadState, line: string): void {
  state.skippedLines += 1;
  if (state.malformedSamples.length >= MALFORMED_SAMPLE_LIMIT) return;
  const sample = line.trim();
  state.malformedSamples.push(sample.length > MALFORMED_SAMPLE_LENGTH ? sample.slice(0, MALFORMED_SAMPLE_LENGTH) + "…" : sample);
}

/** Everything the text filter looks at: message, channel, code and field values. */
function searchableText(record: LogRecord): string {
  const parts: string[] = [record.message, record.channel];
  if (record.code !== undefined) parts.push(record.code);
  for (const key of Object.keys(record.fields)) {
    const value = record.fields[key];
    if (value === undefined) continue;
    parts.push(Array.isArray(value) ? value.join(",") : String(value));
  }
  return parts.join("\n").toLowerCase();
}

/** True when the record satisfies every filter the query names. */
function matchesQuery(record: LogRecord, query: LogQuery): boolean {
  const levels = query.levels;
  if (levels !== undefined && levels.length > 0) {
    const wanted = levels.filter(isLogLevel);
    if (wanted.length > 0 && !wanted.includes(record.level)) return false;
  }
  const minLevel = query.minLevel;
  if (isLogLevel(minLevel) && LOG_LEVEL_RANK[record.level] < LOG_LEVEL_RANK[minLevel]) return false;

  if (query.channels !== undefined && query.channels.length > 0 && !query.channels.includes(record.channel)) return false;
  if (query.codes !== undefined && query.codes.length > 0) {
    if (record.code === undefined || !query.codes.includes(record.code)) return false;
  }
  for (const key of SCOPE_FILTER_KEYS) {
    const wanted = nonBlank(query[key]);
    if (wanted !== undefined && record.scope[key] !== wanted) return false;
  }
  if (typeof query.since === "number" && Number.isFinite(query.since) && record.time < query.since) return false;
  if (typeof query.until === "number" && Number.isFinite(query.until) && record.time > query.until) return false;
  const text = nonBlank(query.text);
  if (text !== undefined && !searchableText(record).includes(text.trim().toLowerCase())) return false;
  return true;
}

/** Read one file into `state`, counting what it could not use. */
function scanFile(path: string, query: LogQuery, state: ReadState): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // Missing, a directory or unreadable: skipped, never thrown.
    return;
  }
  state.scannedFiles += 1;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const record = parseLogLine(line);
    if (record === undefined) {
      skipMalformed(state, line);
      continue;
    }
    if (matchesQuery(record, query)) state.records.push(record);
  }
}

/** The files a query reads: an explicit list, or the directory's own scan order. */
function queryPaths(query: LogQuery): string[] {
  if (query.files !== undefined && query.files.length > 0) {
    return query.files.filter((path): path is string => typeof path === "string" && path.length > 0);
  }
  return scanLogFiles(query).map((file) => file.path);
}

/** The effective limit: a finite non-negative `limit`, else the default. */
function resolveLimit(limit: number | undefined): number {
  if (typeof limit === "number" && Number.isFinite(limit) && limit >= 0) return Math.floor(limit);
  return DEFAULT_LOG_QUERY_LIMIT;
}

/**
 * Read the records back out of the JSON-lines files.
 *
 * The files are scanned oldest-first (rotated copies, then the active file),
 * lines are parsed defensively, and the answer is sorted by `time` — ascending
 * unless `order: "desc"` — and then capped at `limit` (default
 * {@link DEFAULT_LOG_QUERY_LIMIT}) from the end the order implies: `asc` keeps
 * the oldest, `desc` the newest. `truncated` reports that the cap applied.
 *
 * A malformed line is counted in `skippedLines` and sampled in
 * `malformedSamples`; a file that cannot be read is skipped and is not counted
 * in `scannedFiles`. This function never throws.
 */
export function readLogRecords(options?: LogQuery): LogReadResult {
  const query = options ?? {};
  const state: ReadState = { records: [], scannedFiles: 0, skippedLines: 0, malformedSamples: [] };
  for (const path of queryPaths(query)) scanFile(path, query, state);
  state.records.sort((left, right) => left.time - right.time);
  if (query.order === "desc") state.records.reverse();
  const limit = resolveLimit(query.limit);
  const truncated = state.records.length > limit;
  return {
    records: truncated ? state.records.slice(0, limit) : state.records,
    scannedFiles: state.scannedFiles,
    skippedLines: state.skippedLines,
    malformedSamples: state.malformedSamples,
    truncated,
  };
}

/**
 * How many file identities a follower remembers before it forgets the oldest.
 * A rotation renames a file rather than changing it, so the entries are small
 * and a long-running follower over a busy directory must not grow without bound;
 * an identity is only evicted once thousands of newer files have been seen.
 */
const MAX_FOLLOW_IDENTITIES = 4_096;

/**
 * How many times one poll may re-list and read what it has not read yet.
 *
 * WHY A POLL IS NOT ONE PASS. The scan lists files OLDEST COPY FIRST — highest
 * rotation number down to the active file — while a concurrent rotation shifts
 * every copy UP one name. A file whose name changes after the walk has passed
 * that name is therefore missed until the next poll, and by then the follower
 * may have delivered newer records from the active file: the stream goes back in
 * `time` (measured while three processes rotated one channel at ~100
 * rotations/second: seq 394-399 delivered, then 325-330 of the same writer).
 * Re-listing until a pass reads no file it has not already read this poll closes
 * that window: whatever the churn, everything in the directory at the last
 * listing is read into the SAME batch, which is delivered sorted by `time`. The
 * bound keeps a pathological directory from turning one poll into a loop; at the
 * bound the follower behaves as it did before, delivering the rest next poll.
 */
const MAX_FOLLOW_PASSES = 6;

/** An open log file: the descriptor, and the identity read FROM that descriptor. */
interface OpenLogFile {
  readonly fd: number;
  readonly dev: number;
  readonly ino: number;
  readonly sizeBytes: number;
}

/** The key two names for the SAME file share, so a rename keeps its offset. */
function identityKey(entry: { readonly dev: number; readonly ino: number }): string {
  return entry.dev + ":" + entry.ino;
}

/**
 * Open a file and stat the DESCRIPTOR rather than the path.
 *
 * WHY THIS IS NOT `stat(path)` FOLLOWED BY `open(path)`. A concurrent rotation
 * renames the file between the two calls, so the stat describes one inode and the
 * descriptor another: reading at an offset that belongs to the first from the
 * second either re-delivers a prefix or skips one. Opening first and asking the
 * DESCRIPTOR who it is makes the identity and the bytes the same inode, always.
 */
function openLogFile(path: string): OpenLogFile | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const info = fstatSync(fd);
    if (!info.isFile()) {
      closeSync(fd);
      return undefined;
    }
    return { fd, dev: info.dev, ino: info.ino, sizeBytes: info.size };
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A descriptor that cannot be closed must not hide the failure above.
      }
    }
    return undefined;
  }
}

/** Close a descriptor without letting a failure escape. */
function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Closing a reader must not break the follower.
  }
}

/** The default wait between polls: a plain timer, which also keeps a CLI alive. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Complete lines after `offset` of an ALREADY OPEN descriptor, and the offset
 * they end at. The caller owns the descriptor (it was opened together with the
 * identity), so this reads exactly the inode the offset belongs to.
 */
function readNewLines(fd: number, offset: number): { lines: string[]; offset: number } | undefined {
  try {
    const info = fstatSync(fd);
    if (info.size <= offset) return { lines: [], offset };
    const length = info.size - offset;
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, offset);
    if (read <= 0) return { lines: [], offset };
    const lastNewline = buffer.subarray(0, read).lastIndexOf(0x0a);
    // A trailing line without its newline is still being written: leave the
    // offset where it is and pick the line up once it is complete.
    if (lastNewline < 0) return { lines: [], offset };
    return { lines: buffer.subarray(0, lastNewline).toString("utf8").split("\n"), offset: offset + lastNewline + 1 };
  } catch {
    return undefined;
  }
}

/**
 * Follow the files as they grow, polling instead of watching: `fs.watch` behaves
 * differently on every platform (and not at all on some file systems), while a
 * poll sees appends, a new channel's file and a rotation alike.
 *
 * The follower starts at the CURRENT end of every file, so it delivers records
 * written after the call and never replays the past. Each poll re-lists the
 * files: a file that appeared since the last poll is read from its beginning,
 * and a file that was ROTATED is recognised by its identity, so the records
 * appended to it before the rotation are delivered once and the renamed copy's
 * already-seen prefix is not delivered again. Records are delivered in `time`
 * order within a poll, filtered by the same query readLogRecords applies —
 * `limit` and `order` do not apply to a live stream, which has no end.
 *
 * THE OFFSET LEDGER IS KEYED BY FILE IDENTITY AND IS NEVER DROPPED BY A RENAME.
 * Both halves of that sentence are load-bearing under concurrent rotation, and
 * both were measured wrong before this was written (the same probe that found
 * the writer's rotation window — scripts/log-multiprocess-probe.ts — had a run
 * that delivered 157 of 1200 records twice):
 *
 *   • IDENTITY, NOT PATH. A rotation renames the file, so the name a record was
 *     last read under is not the name it has now; the ledger is keyed by
 *     (device, inode) and the map is kept ACROSS polls. Rebuilding it from each
 *     poll's listing forgets a file that a rotation hid between the listing and
 *     the read — and a forgotten file is re-delivered from its beginning when it
 *     reappears under its new name. The map is capped at
 *     {@link MAX_FOLLOW_IDENTITIES} and evicts the oldest entry, which is a file
 *     thousands of rotations old.
 *   • OPEN FIRST, THEN ASK THE DESCRIPTOR WHO IT IS. Statting the path and then
 *     opening it lets a rotation slip in between, and the offset then belongs to
 *     a different inode than the bytes: the read either re-delivers a prefix or
 *     skips one. {@link openLogFile} opens once and takes the identity from the
 *     descriptor, so the two always agree.
 *   • ONE POLL IS SEVERAL PASSES. The listing is oldest-copy-first while a
 *     rotation moves every copy UP a name, so a single walk can pass a file that
 *     then moves to a name the walk is already past — and delivering what the
 *     walk did read, then that file, puts the stream back in `time`. A poll
 *     therefore re-lists and reads until a pass finds no unread byte, up to
 *     {@link MAX_FOLLOW_PASSES} passes, and delivers the union of the passes as
 *     one batch sorted by `time`. The carried offsets are what make a repeated
 *     pass free of duplicates: a file read to its end answers no lines.
 *
 * Polling waits `pollMs` (default {@link DEFAULT_FOLLOW_POLL_MS}) through
 * `sleep`, both injectable so a test can step the follower. The returned
 * function stops it: it is idempotent, calling it twice is a no-op, and a record
 * already delivered stays delivered. Passing `signal` stops the follower when it
 * aborts. Malformed lines are skipped silently (a follower has no return value
 * to report them in), `onRecord` is called under a guard so a throwing listener
 * cannot kill the follower, and nothing here throws or rejects.
 */
export function followLogRecords(
  options: FollowLogOptions | undefined,
  onRecord: (record: LogRecord) => void,
): () => void {
  const query = options ?? {};
  const pollMs =
    typeof query.pollMs === "number" && Number.isFinite(query.pollMs) && query.pollMs >= 0
      ? Math.floor(query.pollMs)
      : DEFAULT_FOLLOW_POLL_MS;
  const sleep = typeof query.sleep === "function" ? query.sleep : defaultSleep;
  const listener = typeof onRecord === "function" ? onRecord : (): void => {};
  const signal = query.signal;
  const canAbort = signal !== undefined && typeof signal.addEventListener === "function";

  let stopped = false;
  // The offset ledger: (device, inode) → bytes already delivered. It is keyed by
  // identity rather than by path on purpose, and it survives every poll.
  let state = new Map<string, number>();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (canAbort) {
      try {
        signal.removeEventListener("abort", stop);
      } catch {
        // Removing a listener must not break the stop.
      }
    }
  };

  if (canAbort && signal.aborted) stopped = true;
  else if (canAbort) {
    try {
      signal.addEventListener("abort", stop, { once: true });
    } catch {
      // A signal that refuses listeners simply cannot stop this follower.
    }
  }

  /** Remember an offset for an identity, keeping the map bounded and LRU-ordered. */
  const remember = (identity: string, offset: number): void => {
    // Delete first, so an updated identity moves to the end of the insertion
    // order and the entry evicted at the cap is the least recently seen one.
    state.delete(identity);
    state.set(identity, offset);
    while (state.size > MAX_FOLLOW_IDENTITIES) {
      const oldest = state.keys().next();
      if (oldest.done === true) break;
      state.delete(oldest.value);
    }
  };

  /** Where the follower is now: every listed file, consumed up to its size. */
  const baseline = (): void => {
    state = new Map<string, number>();
    for (const path of queryPaths(query)) {
      const opened = openLogFile(path);
      if (opened === undefined) continue;
      remember(identityKey(opened), opened.sizeBytes);
      closeQuietly(opened.fd);
    }
  };

  /**
   * One poll: read every file from where the follower left it, then deliver.
   *
   * The read walks every file the listing names, oldest copy first, and REPEATS
   * until a pass finds no byte it has not already read; a file that a rotation
   * renamed past the walk is caught by the re-listing, and a file that grew while
   * the poll was reading is caught by the next pass. The offsets make a repeated
   * pass idempotent — a file already read to its end returns no lines, so nothing
   * is delivered twice — and {@link MAX_FOLLOW_PASSES} bounds the work a
   * directory under continuous rotation can ask for. Without this, a file the
   * walk passed over was delivered a poll later, after newer records (measured:
   * seq 394-399, then 325-330 of the same writer).
   */
  const poll = (): void => {
    const batch: LogRecord[] = [];
    for (let pass = 0; pass < MAX_FOLLOW_PASSES; pass++) {
      let readAnyBytes = false;
      for (const path of queryPaths(query)) {
        const opened = openLogFile(path);
        if (opened === undefined) continue;
        const identity = identityKey(opened);
        try {
          const carried = state.get(identity);
          // A carried offset means this file was already known — under this name
          // (an append) or under another one (a rotation renamed it). An offset
          // beyond the current size means the file was REWRITTEN, so it is read
          // from the start again. Identities this poll does NOT see keep their
          // offsets: a rotation can hide a file between the listing and the open,
          // and forgetting it would re-deliver the whole file next poll.
          const offset = carried !== undefined && carried <= opened.sizeBytes ? carried : 0;
          const read = readNewLines(opened.fd, offset);
          remember(identity, read === undefined ? offset : read.offset);
          if (read === undefined) continue;
          if (read.lines.length > 0) readAnyBytes = true;
          for (const line of read.lines) {
            if (line.trim().length === 0) continue;
            const record = parseLogLine(line);
            if (record === undefined) continue;
            if (matchesQuery(record, query)) batch.push(record);
          }
        } finally {
          closeQuietly(opened.fd);
        }
      }
      // A pass that found no unread byte has nothing left to catch; another pass
      // would re-list every directory and read nothing.
      if (!readAnyBytes) break;
    }

    batch.sort((left, right) => left.time - right.time);
    for (const record of batch) {
      if (stopped) return;
      try {
        listener(record);
      } catch {
        // A listener that throws loses only its own record.
      }
    }
  };

  const loop = async (): Promise<void> => {
    try {
      if (stopped) return;
      baseline();
      while (!stopped) {
        try {
          await sleep(pollMs);
        } catch {
          // An injected waiter that rejects must not end the follower.
        }
        if (stopped) break;
        try {
          poll();
        } catch {
          // A poll must never kill the follower.
        }
      }
    } catch {
      // The follower never rejects: nothing awaits it.
    }
  };

  void loop();
  return stop;
}

/** How many rotated copies a prune keeps: the explicit value, else the writer's retention. */
function resolveKeepRotated(explicit: number | undefined): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 0) return Math.floor(explicit);
  try {
    const raw = process.env[RETAIN_ENV];
    if (typeof raw === "string") {
      const parsed = Number.parseInt(raw.trim(), 10);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
  } catch {
    // An unreadable environment falls back to the default.
  }
  return DEFAULT_RETAIN;
}

/** Remove one file; true when it is gone afterwards. */
function removeLogFile(path: string): boolean {
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete ROTATED log files — and only rotated ones.
 *
 * AN ACTIVE FILE IS NEVER A CANDIDATE. `<channel>.log` (or the ONE file
 * ROLEBOX_LOG_FILE names) is the file the running process appends to; removing
 * it would silently break that process's logging, so `rotation === 0` files are
 * left alone whatever the options say. This is the one rule of the function.
 *
 * A rotated copy is removed when it is BEYOND the retained window AND old
 * enough: `keepRotated` (default: the writer's own retention, ROLEBOX_LOG_RETAIN
 * else {@link DEFAULT_RETAIN}) says how many of a channel's newest rotated
 * copies to keep — counted by rotation number, so `.1` is the newest — and
 * `olderThanMs`, when given, additionally requires `mtime <= now -
 * olderThanMs`. Both gates must pass; a copy inside the window, or younger than
 * the age limit, is kept.
 *
 * A BYTE BUDGET IS A SECOND, HARDER GATE. When `maxTotalBytes` is given, the
 * files that survived the two gates above are weighed together with the active
 * files: while that total exceeds the budget, the OLDEST surviving rotated copy
 * is removed — oldest by mtime first, and, at equal mtimes, the highest rotation
 * number first — until the total fits or no candidate is left. The budget
 * therefore reaches INSIDE the retained window (that is what a disk budget
 * means), but it never touches what the age gate protected: `--days` is the
 * operator's freshness promise and it outranks the budget. A budget smaller than
 * the active files' own bytes cannot be met; the report says so rather than
 * deleting a file a process is writing to.
 *
 * `dryRun` reports what would be removed and removes nothing: `removed` and
 * `freedBytes` then describe the files that would go. A file that cannot be
 * removed is reported as kept rather than thrown, a missing directory answers
 * an empty result, and `kept` counts the ROTATED copies left in place.
 */
export function pruneLogs(options?: PruneLogsOptions): PruneLogsResult {
  const removed: PruneRemoval[] = [];
  let kept = 0;
  let freedBytes = 0;
  let budget: PruneBudgetReport | undefined;
  try {
    const keep = resolveKeepRotated(options?.keepRotated);
    const dryRun = options?.dryRun === true;
    const age = options?.olderThanMs;
    const cutoff = typeof age === "number" && Number.isFinite(age) && age >= 0 ? Date.now() - age : undefined;
    const rawBudget = options?.maxTotalBytes;
    const maxTotalBytes =
      typeof rawBudget === "number" && Number.isFinite(rawBudget) && rawBudget >= 0 ? Math.floor(rawBudget) : undefined;

    const files = listLogFiles(options);
    let activeBytes = 0;
    const byChannel = new Map<string, LogFileInfo[]>();
    for (const file of files) {
      if (file.rotation < 1) {
        activeBytes += file.sizeBytes;
        continue;
      }
      const group = byChannel.get(file.channel);
      if (group === undefined) byChannel.set(file.channel, [file]);
      else group.push(file);
    }

    // What the two gates left behind, and — of that — what a byte budget may
    // still take. The two sets differ by exactly one rule: the age gate is the
    // operator's freshness promise and a byte budget may NOT override it, while
    // a copy that is merely inside the retained window is fair game (a disk
    // budget is a budget).
    const remainingFiles: LogFileInfo[] = [];
    const budgetCandidates: LogFileInfo[] = [];
    for (const group of byChannel.values()) {
      // Newest first (`.1` is the most recent rotation), so the copies to KEEP
      // are the first `keep` entries and everything after them is beyond the
      // retained window — the oldest copies go first.
      group.sort((left, right) => left.rotation - right.rotation || left.path.localeCompare(right.path));
      group.forEach((file, index) => {
        const beyondRetention = index >= keep;
        const oldEnough = cutoff === undefined || file.mtimeMs <= cutoff;
        if (!beyondRetention || !oldEnough) {
          kept += 1;
          remainingFiles.push(file);
          if (oldEnough) budgetCandidates.push(file);
          return;
        }
        if (!dryRun && !removeLogFile(file.path)) {
          kept += 1;
          remainingFiles.push(file);
          return;
        }
        removed.push({ path: file.path, sizeBytes: file.sizeBytes });
        freedBytes += file.sizeBytes;
      });
    }

    if (maxTotalBytes !== undefined) {
      // Oldest first: the oldest mtime goes first and, at equal mtimes, the
      // highest rotation number — the copy furthest from the active file.
      const candidates = [...budgetCandidates].sort(
        (left, right) => left.mtimeMs - right.mtimeMs || right.rotation - left.rotation || left.path.localeCompare(right.path),
      );
      let remainingBytes = activeBytes + remainingFiles.reduce((total, file) => total + file.sizeBytes, 0);
      let budgetRemoved = 0;
      for (const file of candidates) {
        if (remainingBytes <= maxTotalBytes) break;
        if (!dryRun && !removeLogFile(file.path)) continue;
        removed.push({ path: file.path, sizeBytes: file.sizeBytes });
        freedBytes += file.sizeBytes;
        remainingBytes -= file.sizeBytes;
        budgetRemoved += 1;
        kept -= 1;
      }
      budget = { maxTotalBytes, removed: budgetRemoved, remainingBytes, satisfied: remainingBytes <= maxTotalBytes };
    }
  } catch {
    // Pruning is maintenance: it reports what it managed, never an exception.
  }
  const result: PruneLogsResult = { removed, freedBytes, kept };
  return budget === undefined ? result : { ...result, budget };
}
