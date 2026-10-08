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
// ROTATION. Before a line is appended the file's size is checked against
// ROLEBOX_LOG_MAX_BYTES (default 10 MB): at the limit the file becomes `.1`,
// `.1` becomes `.2`, and only ROLEBOX_LOG_RETAIN rotated copies (default 3) are
// kept — a retain of 0 removes the file instead of keeping a copy. Unset, blank
// or invalid values fall back to the defaults.
//
// FAILURE IS DEGRADATION, REPORTED ONCE. A write that throws disables file
// logging for this process (no further writes are attempted) and a rotation that
// throws abandons rotation (records keep being appended, the file just grows).
// Each is reported at most once through `onFailure` — a sink that reported its
// own failure by writing another record would recurse into the very file that
// just failed. The sink itself never throws.
//
// SYNCHRONOUS ON PURPOSE. Stage 1 appends with appendFileSync: no open stream,
// no flush on exit, no drain handling, and a process that logs three lines does
// not hold a file descriptor. Asynchronous writing and backpressure are
// deliberately a later stage's subject.

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
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

/**
 * Shift `<path>` to `<path>.1`, `.1` to `.2`, … keeping `retain` copies. A
 * `retain` of 0 removes the file instead. A missing source is skipped; a rename
 * that fails for any other reason throws, and the caller abandons rotation.
 */
function rotate(path: string, retain: number): void {
  if (retain <= 0) {
    rmSync(path, { force: true });
    return;
  }
  for (let index = retain; index >= 1; index--) {
    const source = index === 1 ? path : path + "." + (index - 1);
    if (!existsSync(source)) continue;
    renameSync(source, path + "." + index);
  }
}

/** Per-file bookkeeping: where a channel writes and how big the file is. */
interface FileState {
  readonly path: string;
  /** Bytes written so far; -1 means "not measured yet". */
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
    const created: FileState = { path, bytes: -1 };
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
      if (state.bytes < 0) state.bytes = fileSize(state.path);

      if (maxBytes > 0 && !rotationBroken && state.bytes >= maxBytes) {
        try {
          rotate(state.path, retain);
          state.bytes = 0;
        } catch (error) {
          rotationBroken = true;
          if (!rotationFailureReported) {
            rotationFailureReported = true;
            report({ code: "log.file.rotate-failed", channel, maxBytes, error });
          }
        }
      }

      const line = JSON.stringify(record) + "\n";
      appendFileSync(state.path, line);
      state.bytes += Buffer.byteLength(line, "utf8");
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
