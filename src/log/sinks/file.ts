// ── JSON-lines file sink ────────────────────────────────────────────────────
//
// ONE FILE PER CHANNEL, ONE JSON OBJECT PER LINE. Every record becomes a single
// line — `{"time":…,"level":…,"channel":…,"code":…,"message":…,"scope":{…},
// "fields":{…},"process":{…}}` — so `jq` reads it without a parser and a line
// can never be mistaken for a continuation of the previous one.
//
// WHY ONE FILE PER CHANNEL. `<logDir>/<channel>.log`, with every character that
// is not a letter or a digit replaced by "-", so `graph:host` writes
// `graph-host.log`. Two processes logging different channels therefore never
// race over one rotation, a channel can be tailed on its own, and the file names
// stay stable enough to be documented.
//
// LEGACY SINGLE-FILE MODE. When ROLEBOX_LOG_FILE is set (or a caller passes
// `file`), EVERY channel writes into that ONE path instead of its own file. It
// is the contract src/logger.ts has always honored — a process whose operator
// asked for one file gets one file — and it is resolved once per sink. The
// explicit `file` option beats the environment; the environment beats the
// per-channel layout. Its directory is the path's own dirname, so getLogDir()
// keeps answering where the sink writes. Rotation applies to that one file the
// same way it applies to a channel file.
//
// THE LOG DIRECTORY, in order:
//   1. the directory of the single file in legacy mode;
//   2. an explicit directory — configureLogging({ logDir }) or createFileSink({ dir });
//   3. ROLEBOX_LOG_DIR;
//   4. the workspace's `.rolebox/logs`: the nearest ancestor of the working
//      directory that holds a `.rolebox` directory, i.e. the same directory
//      src/logger.ts writes to once a workspace has configured it;
//   5. `<config dir>/logs`, mirroring src/logger.ts's getConfigDir() fallback
//      (ROLEBOX_CONFIG_DIR → XDG_CONFIG_HOME/rolebox → ~/.config/rolebox,
//      APPDATA on win32);
//   6. `<tmpdir>/rolebox-logs`, mirroring src/logger.ts's tmpdir() fallback.
// The directory is created lazily on the first write, so importing the kernel
// creates nothing and a process that never logs opens nothing.
//
// ROTATION. Before a line is appended the file's size is read FROM DISK and
// checked against ROLEBOX_LOG_MAX_BYTES (default 10 MB): at the limit the file
// becomes `.1`, `.1` becomes `.2`, and only ROLEBOX_LOG_RETAIN rotated copies
// (default 3) are kept — a retain of 0 removes the file instead of keeping a
// copy. Unset, blank or invalid values fall back to the defaults.
//
// ROTATION IS COORDINATED ACROSS PROCESSES, BECAUSE IT HAS TO BE. Every rename
// in the shift is atomic, but `rename(path, path + ".1")` REPLACES an existing
// `.1` — so a second process that decided to rotate a moment before the first
// one finished silently overwrites the copy the first just made, and the
// records that were in the file at that first rotation are gone. Measured on
// three real processes writing one channel through this sink
// (scripts/log-multiprocess-probe.ts, 3 x 400 records, 4 KB limit, retention far
// above the volume), that window lost 70 of 1200 records: the first ~24 of every
// writer, exactly the records the first rotation had moved aside. Rotation
// therefore runs under a per-file lock (`<path>.rotate.lock`, created O_EXCL)
// and re-reads the file's size once the lock is held: the process that finds the
// file already rotated adopts the new size, and only the lock holder renames.
// Appends are not lost by a rename — the inode's bytes move with the file, and
// an append either lands in the old inode or recreates the path — but they are
// what pushes a rotated copy past the limit, so a writer that finds a rotation
// in flight WAITS for it while it keeps making progress (below) and appends to
// the file the path names afterwards. A process that dies holding the lock
// leaves the lock file behind, so a lock older than ROTATE_LOCK_STALE_MS is
// broken rather than blocking rotation forever. The lock is not a log file: the read side's name grammar
// (`<channel>.log` and `<channel>.log.N`) ignores it, so it never appears in
// `rolebox logs files`, in a query or in a prune.
//
// THE GATE READS THE FILE, NOT THIS PROCESS'S COUNTER, AND THAT IS THE WHOLE
// POINT OF IT. A per-process tally sees only the bytes THAT process appended,
// so N writers sharing one file each wait for their own share to reach the
// limit: measured with three sink instances (three independent counters, the
// same thing three processes have) at a 1 KB limit, the live file reached 2316
// bytes — 2.3x — before the first rotation, and the factor is the number of
// writers. The gate therefore stats the file before every record, which is what
// makes ROLEBOX_LOG_MAX_BYTES the size the file actually rotates at; one stat
// costs ~1 us against an 18 us append, so every record pays it.
//
// AND THE FILE STOPS GROWING WHILE THE SHIFT RUNS. Reading the size is not
// enough on its own: a record written while the lock holder renames is not
// lost, but it moves with the inode into the copy being rotated, and a writer
// that appends back to back can put thousands of bytes into that copy — three
// real processes at a 2 KB limit and a 4096-deep retention ladder measured a
// worst copy of 8431 bytes, 4.1x the limit, even though the gate was already
// reading the file's size. A writer that finds somebody else rotating therefore
// WAITS for it instead of appending into the file about to be moved, and appends
// to whatever file the path names afterwards.
//
// THE WAIT FOLLOWS THE HOLDER'S PROGRESS, NOT A STOPWATCH, AND THAT IS WHAT
// MAKES THE BOUND HOLD WHEN A ROTATION IS SLOW. The first version of this wait
// gave up after ROTATE_WAIT_MS and remembered the give-up for the rest of the
// process's life, so ONE rotation slower than that window turned the process
// into a writer that appended into every later file mid-rename. On the
// reviewer's deep-ladder load (three real processes, one channel, a 1 KB limit
// and RETAIN 4096, writers back to back) rotated copies reached 41,412 bytes —
// 40x the limit — and the probe's own 4 KB configuration produced a 20,879-byte
// copy (5.1x) in one run of fourteen. The holder now refreshes its lock's mtime
// at least every ROTATE_HEARTBEAT_MS while it works — the slot scan and the
// shift both announce — and a waiter keeps waiting while that mtime is younger
// than ROTATE_WAIT_MS: a slow rotation is waited out for as long as it keeps
// moving, and only one that has stopped for a whole window (five missed
// heartbeats) releases the waiter. The give-up is remembered per lock STAMP
// (inode + mtime), so the holder's next refresh or a replaced lock file arms the
// wait again; it is never a property of this process.
//
// WHAT THAT BUYS, MEASURED ON THE SAME LOAD: the worst rotated copy fell from
// 27.6x of a 1 KB limit to 1.58-1.70x, with all 1800 of 1800 records delivered
// exactly once, and the probe's own configurations measure 1.010-1.204x — see
// docs/logging-architecture.md, "Rotation is serialized across processes". THE
// RESIDUAL IS THE APPENDS ALREADY IN FLIGHT, NOT THE SHIFT: the gate is a check
// followed by an append, so a record that passes the gate an instant before
// another process rotates lands in that copy. That is one record per concurrent
// writer (roughly +0.5x at a 1 KB limit with ~280-byte records), which is why
// the bound is stated as the limit plus an allowance rather than as one
// fraction. The other residual is a holder that has STOPPED progressing: the
// waiter appends once per stalled lock instance rather than once per record,
// because blocking a caller for as long as an unresponsive process holds a lock
// is worse than a file that is briefly over its limit — ROTATE_LOCK_STALE_MS
// breaks that lock and rotation resumes.
//
// FAILURE IS DEGRADATION, REPORTED ONCE. A write that throws disables file
// logging for this process (no further writes are attempted) and a rotation that
// throws abandons rotation (records keep being appended, the file just grows).
// Each is reported at most once through `onFailure` — a sink that reported its
// own failure by writing another record would recurse into the very file that
// just failed. The sink itself never throws.
//
// SYNCHRONOUS ON PURPOSE, MEASURED RATHER THAN DEFERRED. The sink appends with
// appendFileSync: no open stream, no flush on exit, no drain handling, and a
// process that logs three lines does not hold a file descriptor. Stage 5 put
// that against an asynchronous queue and kept it: one representative record
// costs 0.03 ms at p99 (about 15x under the 0.5 ms budget the decision was
// reviewed against), the 10,000-record burst is volume rather than an added
// stall, and a bounded queue would drop exactly the records `debug` was turned
// on to capture while giving up the read-after-write visibility `rolebox logs`,
// the TUI pane and the read-side tests are built on. The measurements and the
// trigger that would reopen the question are in docs/logging-architecture.md,
// "What one write costs, measured". There is no asynchronous write path behind
// a flag; this is the decision, not a stage still to come.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { LogRecord, LogSink } from "../types.ts";

/** The environment variable that names the log directory outright. */
export const LOG_DIR_ENV = "ROLEBOX_LOG_DIR";

/** The environment variable that names ONE file every channel writes to. */
export const FILE_ENV = "ROLEBOX_LOG_FILE";

/** The environment variable that names the rotation size limit. */
export const MAX_BYTES_ENV = "ROLEBOX_LOG_MAX_BYTES";

/** The environment variable that names how many rotated copies to keep. */
export const RETAIN_ENV = "ROLEBOX_LOG_RETAIN";

/** Default rotation size limit (10 MB), matching src/logger.ts. */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/** Default number of rotated copies kept, matching src/logger.ts. */
export const DEFAULT_RETAIN = 3;

/** How far the workspace search walks up before giving up. */
const WORKSPACE_SEARCH_DEPTH = 32;

/** The suffix of the per-file rotation lock. Not a log file name (see below). */
export const ROTATE_LOCK_SUFFIX = ".rotate.lock";

/**
 * How long a rotation lock may sit unmodified before another process breaks it.
 * Rotation holds the lock for a few renames, so this only ever fires for a
 * process that died (or was killed) between acquiring and releasing it.
 */
export const ROTATE_LOCK_STALE_MS = 10_000;

/**
 * How long a writer tolerates NO PROGRESS from another process's rotation before
 * appending anyway. Progress is the lock file's mtime, which the holder
 * refreshes at least every {@link ROTATE_HEARTBEAT_MS} while it walks the
 * retention ladder; a writer therefore stays for a rotation that is slow but
 * moving, and leaves only for one that has stopped. It is deliberately a tenth
 * of {@link ROTATE_LOCK_STALE_MS}: a holder that has stalled costs a writer one
 * window per lock instance, not ten seconds of windows.
 */
export const ROTATE_WAIT_MS = 25;

/**
 * How often a held rotation lock's mtime is refreshed while the ladder is
 * walked. It is the heartbeat a waiting writer reads (see {@link ROTATE_WAIT_MS}),
 * so it has to sit comfortably below that window: five refreshes fit inside one.
 */
export const ROTATE_HEARTBEAT_MS = 5;

/** The slice of a wait: long enough to cost nothing, short enough to be prompt. */
const ROTATE_WAIT_SLICE_MS = 1;

/** The word `Atomics.wait` parks on; the logging path has no event loop to yield to. */
const rotationWaitWord = new Int32Array(new SharedArrayBuffer(4));

/** Sleep synchronously, or do nothing where shared memory is unavailable. */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(rotationWaitWord, 0, 0, ms);
  } catch {
    // A runtime without shared memory: the wait degrades to a spin of one probe.
  }
}

/** Why a file sink could not do its job. */
export type FileSinkFailureCode = "log.file.write-failed" | "log.file.rotate-failed";

/** What the file sink reports when it degrades; src/log/index.ts names the event. */
export interface FileSinkFailure {
  readonly code: FileSinkFailureCode;
  readonly channel: string;
  /** The error a write failed with (write-failed only). */
  readonly error?: unknown;
  /** The size limit rotation was attempted at (rotate-failed only). */
  readonly maxBytes?: number;
}

/** Options for {@link createFileSink}. */
export interface FileSinkOptions {
  /** An explicit directory; otherwise the environment and the fallbacks decide. */
  readonly dir?: string;
  /** ONE file for every channel (legacy mode); beats `dir` and the environment. */
  readonly file?: string;
  /** Rotation size limit; overrides the environment, defaulting to 10 MB. */
  readonly maxBytes?: number;
  /** Rotated copies kept; overrides the environment, defaulting to 3. */
  readonly retain?: number;
  /** Called at most once per failure kind. */
  readonly onFailure?: (failure: FileSinkFailure) => void;
}

/** A per-channel JSON-lines writer. */
export interface FileSink extends LogSink {
  /** The directory written into (the single file's dirname in legacy mode). */
  readonly dir: string;
  /** The single file every channel writes to, or `undefined` for per-channel files. */
  readonly singleFile: string | undefined;
  readonly maxBytes: number;
  readonly retain: number;
  /** True after a write failure: the sink no longer touches the file system. */
  readonly disabled: boolean;
  /** The file a channel writes to. */
  pathFor(channel: string): string;
  /** Stop writing (idempotent). */
  close(): void;
}

/** A non-blank string, or `undefined`. */
function nonBlank(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Read an environment variable without letting a hostile `process` throw. */
function readEnv(name: string): string | undefined {
  try {
    if (typeof process === "undefined" || process.env === undefined) return undefined;
    return process.env[name];
  } catch {
    return undefined;
  }
}

/**
 * The file name a channel writes to: every non-alphanumeric character becomes
 * "-" (`graph:host` → `graph-host.log`). A channel with no alphanumeric
 * character at all falls back to the default channel's name.
 */
export function logChannelFileName(channel: string): string {
  const name = typeof channel === "string" ? channel : "";
  const safe = name.replace(/[^A-Za-z0-9]/g, "-");
  return (safe.replace(/-/g, "").length > 0 ? safe : "rolebox") + ".log";
}

/** The nearest ancestor of `cwd` holding a `.rolebox` directory, as a log dir. */
function workspaceLogDir(cwd: string | undefined): string | undefined {
  let current: string;
  try {
    current = nonBlank(cwd) ?? process.cwd();
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < WORKSPACE_SEARCH_DEPTH; depth++) {
    try {
      if (statSync(join(current, ".rolebox")).isDirectory()) return join(current, ".rolebox", "logs");
    } catch {
      // No .rolebox here; keep walking up.
    }
    try {
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    } catch {
      break;
    }
  }
  return undefined;
}

/**
 * The config directory's log dir, mirroring src/logger.ts's getConfigDir()
 * chain (ROLEBOX_CONFIG_DIR → XDG_CONFIG_HOME/rolebox → APPDATA on win32 →
 * ~/.config/rolebox).
 */
function configDirLogDir(): string | undefined {
  try {
    const explicit = nonBlank(readEnv("ROLEBOX_CONFIG_DIR"));
    if (explicit !== undefined) return join(explicit, "logs");
    const xdg = nonBlank(readEnv("XDG_CONFIG_HOME"));
    if (xdg !== undefined) return join(xdg, "rolebox", "logs");
    if (typeof process !== "undefined" && process.platform === "win32") {
      const appData = nonBlank(readEnv("APPDATA")) ?? join(homedir(), "AppData", "Roaming");
      return join(appData, "rolebox", "logs");
    }
    return join(homedir(), ".config", "rolebox", "logs");
  } catch {
    return undefined;
  }
}

/** The last-resort directory, mirroring src/logger.ts's tmpdir() fallback. */
function tmpLogDir(): string {
  try {
    return join(tmpdir(), "rolebox-logs");
  } catch {
    return "rolebox-logs";
  }
}

/**
 * Resolve the ONE file every channel writes to, or `undefined` when the
 * per-channel layout is in effect. `file` is the explicit configuration and
 * beats ROLEBOX_LOG_FILE; a blank value at either step falls through. This
 * never throws.
 */
export function resolveLogFile(options?: { readonly file?: string }): string | undefined {
  return nonBlank(options?.file) ?? nonBlank(readEnv(FILE_ENV));
}

/**
 * Resolve the directory the file sink writes into. `dir` is the explicit
 * configuration; `cwd` is only a seam for tests that need a deterministic
 * workspace search. This never throws and always answers a non-empty path.
 */
export function resolveLogDir(options?: { readonly dir?: string; readonly cwd?: string }): string {
  const explicit = nonBlank(options?.dir);
  if (explicit !== undefined) return explicit;
  const fromEnv = nonBlank(readEnv(LOG_DIR_ENV));
  if (fromEnv !== undefined) return fromEnv;
  const workspace = workspaceLogDir(options?.cwd);
  if (workspace !== undefined) return workspace;
  const config = configDirLogDir();
  if (config !== undefined) return config;
  return tmpLogDir();
}

/** A positive integer from `raw` or `fallback`; blanks and junk fall back. */
function positiveInt(raw: string | undefined, explicit: number | undefined, fallback: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const text = nonBlank(raw);
  if (text === undefined) return fallback;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** A non-negative integer from `raw` or `fallback`; blanks and junk fall back. */
function nonNegativeInt(raw: string | undefined, explicit: number | undefined, fallback: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 0) return Math.floor(explicit);
  const text = nonBlank(raw);
  if (text === undefined) return fallback;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Size of an existing file, or 0 when it does not exist yet. */
function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** A held rotation lock: the lock file that must be removed when rotation ends. */
interface RotationLock {
  readonly path: string;
}

/**
 * One lock file as it was seen at one moment: WHICH file (inode) and HOW FRESH
 * (mtime). Together they identify one rotation, which is what lets a give-up be
 * scoped to it — a holder that resumes refreshing, or a lock file that is
 * replaced, is a different stamp and is waited for again.
 */
interface LockStamp {
  readonly ino: number;
  readonly mtimeMs: number;
}

/** Read a lock file's stamp, or `undefined` when there is no lock to read. */
function lockStamp(lockPath: string): LockStamp | undefined {
  try {
    const stat = statSync(lockPath);
    return { ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

/** A comparable form of a lock stamp. */
function lockStampKey(stamp: LockStamp): string {
  return `${stamp.ino}:${stamp.mtimeMs}`;
}

/** True when a lock file is old enough to be the leftover of a dead process. */
function rotationLockIsStale(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > ROTATE_LOCK_STALE_MS;
  } catch {
    // It vanished between the failed create and this stat: not a lock any more.
    return true;
  }
}

/**
 * Try to take the rotation lock for `path`, or answer `undefined` when another
 * process holds it. The lock is the EXISTENCE of `<path>.rotate.lock`: `wx`
 * fails when the file is already there, which is the whole mutex. A lock older
 * than {@link ROTATE_LOCK_STALE_MS} is broken once, because the process that
 * wrote it is not coming back to release it. The lock's CONTENT is this
 * process's pid, for an operator looking at a stuck directory; nothing reads it.
 */
function acquireRotationLock(path: string): RotationLock | undefined {
  const lockPath = path + ROTATE_LOCK_SUFFIX;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, String(process.pid));
      } catch {
        // The lock is the file's existence, not its content.
      } finally {
        closeSync(fd);
      }
      return { path: lockPath };
    } catch {
      if (!rotationLockIsStale(lockPath)) return undefined;
      try {
        rmSync(lockPath, { force: true });
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Wait for another process's rotation on `path` for as long as it is making
 * progress, and answer the lock stamp the wait gave up on — or `undefined` when
 * the rotation finished instead (the lock went away, or was never there).
 *
 * WHY WAIT RATHER THAN APPEND: a record appended during a rotation is not lost —
 * it moves with the inode into the copy being renamed — but it is bytes added to
 * that copy, and a fast writer can add a great many of them while the lock
 * holder walks a deep retention ladder. Waiting is what keeps a rotated copy at
 * the size the gate tripped at instead of at whatever the write rate made of it,
 * and the delay is the rotation the lock holder is already paying.
 *
 * WHY THE HOLDER'S PROGRESS AND NOT A DEADLINE: a fixed deadline cannot tell a
 * slow rotation from a dead one, and a writer that gives up on a slow rotation
 * appends into the file being renamed for as long as that rotation lasts — which
 * is how a rotated copy once reached 40x the limit. The heartbeat separates the
 * cases: a rotation that is slow but moving is waited out however long it takes,
 * and only a lock that has not moved for ROTATE_WAIT_MS is abandoned. A rotation
 * is finite — the ladder is bounded by `retain` — so waiting for progress is
 * waiting for a bounded piece of work.
 */
function waitForRotation(path: string): LockStamp | undefined {
  const lockPath = path + ROTATE_LOCK_SUFFIX;
  for (;;) {
    const stamp = lockStamp(lockPath);
    if (stamp === undefined) return undefined;
    if (Date.now() - stamp.mtimeMs > ROTATE_WAIT_MS) return stamp;
    sleepSync(ROTATE_WAIT_SLICE_MS);
  }
}

/** Release a rotation lock; one that cannot be removed is left to the stale rule. */
function releaseRotationLock(lock: RotationLock): void {
  try {
    rmSync(lock.path, { force: true });
  } catch {
    // A lock file that outlives its rotation is broken by the stale rule.
  }
}

/**
 * Refresh a held lock's mtime: the heartbeat a waiting writer reads to tell a
 * slow rotation from a stalled one. Nothing about the rotation itself depends on
 * this write — an unrefreshable lock is simply one waiters abandon after a
 * window, and the stale rule still breaks it if the holder dies.
 */
function announceRotationProgress(lock: RotationLock): void {
  try {
    const now = new Date();
    utimesSync(lock.path, now, now);
  } catch {
    // Treated as a stalled holder by the next waiter, which is the safe reading.
  }
}

/**
 * Shift `<path>` to `<path>.1`, `.1` to `.2`, … keeping `retain` copies. A
 * `retain` of 0 removes the file instead. A missing source is skipped; a rename
 * that fails for any other reason throws, and the caller abandons rotation.
 *
 * THE WALK STARTS AT THE COPIES THAT EXIST, NOT AT `retain`. The shift has to
 * run from the top down — `.1` must be moved before the active file can become
 * `.1` — but starting at slot `retain` stats every slot that cannot exist, and
 * that is the rotation's whole cost: measured on one file with 40 copies on
 * disk, the crossing record took 0.34 ms at the default retain of 3, 3.3 ms at
 * 1024 and 8–13 ms at 4096. Those milliseconds are the window in which the OTHER
 * writers keep appending into the file about to become `.1`, i.e. the only way a
 * rotated copy can end up above ROLEBOX_LOG_MAX_BYTES. Scanning up from `.1`
 * until the first missing slot makes the shift cost what the copies on disk
 * cost, so a large ROLEBOX_LOG_RETAIN no longer widens that window (or stalls
 * the writer that holds the lock). A gap in the numbering — only ever left by
 * hand, `prune` removes from the top — simply stops the scan there, which is
 * where the shift would have stopped anyway.
 *
 * THE HOLDER ANNOUNCES ITS PROGRESS WHILE IT WALKS (`progress`, the lock's
 * heartbeat — see {@link announceRotationProgress}). Both loops are O(copies)
 * and a deep ladder is exactly the slow rotation a waiter must not mistake for a
 * dead one, so the announcement starts before the first rename and repeats at
 * least every ROTATE_HEARTBEAT_MS: a waiter sees a moving lock for as long as
 * the walk is moving, and appends nothing into the file being rotated.
 */
function rotate(path: string, retain: number, progress?: () => void): void {
  if (retain <= 0) {
    rmSync(path, { force: true });
    return;
  }
  let announcedAt = Date.now();
  const announce = (): void => {
    announcedAt = Date.now();
    progress?.();
  };
  // Announce before the first rename: a waiter that arrives mid-shift must see
  // the same fresh lock the holder does.
  announce();
  let highest = 0;
  for (let index = 1; index <= retain; index++) {
    if (!existsSync(path + "." + index)) break;
    highest = index;
    if (Date.now() - announcedAt >= ROTATE_HEARTBEAT_MS) announce();
  }
  for (let index = Math.min(retain, highest + 1); index >= 1; index--) {
    const source = index === 1 ? path : path + "." + (index - 1);
    if (!existsSync(source)) continue;
    renameSync(source, path + "." + index);
    if (Date.now() - announcedAt >= ROTATE_HEARTBEAT_MS) announce();
  }
}

/** Per-file bookkeeping: where a channel writes and how big the file is. */
interface FileState {
  readonly path: string;
  /**
   * The file's size as last OBSERVED ON DISK, refreshed from disk before every
   * record. It is deliberately not "the bytes this process appended": other
   * processes append to the same file, so a private tally under-counts and
   * would let the file run to (writers x maxBytes). See the gate in the sink.
   */
  bytes: number;
}

/**
 * Build the file sink. The directory and the limits are resolved once, at
 * construction; nothing is created until the first record arrives.
 */
export function createFileSink(options?: FileSinkOptions): FileSink {
  const singleFile = resolveLogFile({ file: options?.file });
  const dir = singleFile === undefined ? resolveLogDir({ dir: options?.dir }) : dirname(singleFile);
  const maxBytes = positiveInt(readEnv(MAX_BYTES_ENV), options?.maxBytes, DEFAULT_MAX_BYTES);
  const retain = nonNegativeInt(readEnv(RETAIN_ENV), options?.retain, DEFAULT_RETAIN);
  const onFailure = options?.onFailure;
  const files = new Map<string, FileState>();

  let closed = false;
  let disabled = false;
  let directoryReady = false;
  let rotationBroken = false;
  // The lock stamp whose holder stopped making progress and was given up on.
  // Scoped to ONE lock file instance: the holder's next heartbeat changes the
  // stamp and a replaced lock is a different inode, so both re-arm the wait. The
  // permanent version of this flag let a single slow rotation turn the process
  // into a writer that appended into every later file mid-rename (rotated copies
  // reached 40x the limit); the stamp is what makes the give-up temporary.
  let stalledRotation: string | undefined;
  let writeFailureReported = false;
  let rotationFailureReported = false;

  const report = (failure: FileSinkFailure): void => {
    try {
      onFailure?.(failure);
    } catch {
      // A reporter must not break the pipeline.
    }
  };

  /**
   * The bookkeeping for a channel's destination. Keyed by PATH, so in legacy
   * mode every channel shares the one entry (and therefore the one size
   * counter) of the single file.
   */
  const stateFor = (channel: string): FileState => {
    const path = singleFile ?? join(dir, logChannelFileName(channel));
    const existing = files.get(path);
    if (existing !== undefined) return existing;
    const created: FileState = { path, bytes: 0 };
    files.set(path, created);
    return created;
  };

  const sink = ((record: LogRecord): void => {
    if (closed || disabled) return;
    let channel = "rolebox";
    try {
      channel = typeof record.channel === "string" && record.channel.length > 0 ? record.channel : "rolebox";
      const state = stateFor(channel);

      if (!directoryReady) {
        mkdirSync(dir, { recursive: true });
        directoryReady = true;
      }
      // MEASURE, DO NOT COUNT. The file is shared with every other process
      // writing this channel, so this process's own byte tally is only a lower
      // bound on its size: gating on it lets the file grow to (writers x the
      // limit) before anybody rotates. One stat per record (~1 us against an
      // 18 us append) keeps ROLEBOX_LOG_MAX_BYTES the size the file actually
      // rotates at, and the value it produces is also what the lock holder
      // re-checks below.
      state.bytes = fileSize(state.path);

      if (maxBytes > 0 && !rotationBroken && state.bytes >= maxBytes) {
        const lock = acquireRotationLock(state.path);
        if (lock === undefined) {
          // Another process is rotating this file RIGHT NOW. Two things follow.
          // First, do NOT queue a second rotation behind it: the rename this
          // process would perform is the one that overwrites the copy the other
          // just made. Second, do not append into the file it is about to move
          // either — that is what lets a rotated copy run past the limit by
          // every record written while the shift lasts, which at a fast write
          // rate is many times the limit (measured: 3.5-4x with three writers
          // appending back to back). Wait for it, then append to whatever file
          // the path names now.
          //
          // The wait follows the holder's HEARTBEAT, and the give-up is scoped to
          // the lock instance it gave up on: while the holder keeps moving this
          // record appends nothing at all, and when the holder has not moved for
          // ROTATE_WAIT_MS the stamp is remembered so the next record does not
          // pay the same window again. Progress resumed, or a replaced lock file,
          // is a different stamp and is waited for again.
          const stamp = lockStamp(state.path + ROTATE_LOCK_SUFFIX);
          if (stamp === undefined) {
            stalledRotation = undefined;
          } else if (lockStampKey(stamp) !== stalledRotation) {
            const stalled = waitForRotation(state.path);
            stalledRotation = stalled === undefined ? undefined : lockStampKey(stalled);
          }
          state.bytes = fileSize(state.path);
        } else {
          try {
            // Re-read the size UNDER the lock: the holder that just left may have
            // rotated already, in which case this file is new and far from full.
            const current = fileSize(state.path);
            if (current >= maxBytes) {
              rotate(state.path, retain, () => announceRotationProgress(lock));
              state.bytes = 0;
            } else {
              state.bytes = current;
            }
          } catch (error) {
            rotationBroken = true;
            if (!rotationFailureReported) {
              rotationFailureReported = true;
              report({ code: "log.file.rotate-failed", channel, maxBytes, error });
            }
          } finally {
            releaseRotationLock(lock);
          }
        }
      }

      const line = JSON.stringify(record) + "\n";
      appendFileSync(state.path, line);
      // The next record re-measures from disk; keeping the local view current
      // only saves nothing, so it is not kept current. A record that landed in
      // another process's append between the stat and this one is therefore
      // invisible here until the next record — which is exactly the overshoot
      // the gate tolerates (documented above), not a lost record.
    } catch (error) {
      disabled = true;
      if (!writeFailureReported) {
        writeFailureReported = true;
        report({ code: "log.file.write-failed", channel, error });
      }
    }
  }) as FileSink;

  Object.defineProperties(sink, {
    dir: { value: dir, enumerable: true },
    singleFile: { value: singleFile, enumerable: true },
    maxBytes: { value: maxBytes, enumerable: true },
    retain: { value: retain, enumerable: true },
    disabled: { get: (): boolean => disabled, enumerable: true },
    pathFor: {
      value: (channel: string): string => singleFile ?? join(dir, logChannelFileName(channel)),
      enumerable: true,
    },
    close: {
      value: (): void => {
        closed = true;
      },
      enumerable: true,
    },
  });

  return sink;
}
