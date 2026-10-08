// ── The platform logging API ────────────────────────────────────────────────
//
// ONE IMPORT FOR EVERYTHING A CALLER NEEDS. This module is the public face of
// the logging platform: emit an event, build a channel logger, carry identity
// through the work, configure the sinks, watch the live buffer, and find the
// files. Everything else under src/log is internal to it.
//
//   logEvent(code, fields?)           emit a registered event (registry owns its
//                                     level, channel and message)
//   createLogger(channel)             { debug, info, warn, error, event }
//   withLogScope(scope, fn)           ambient identity for the work (read the
//                                     propagation rules in ./context.ts)
//   currentLogScope()                 the identity in effect right now
//   configureLogging(options)         sinks / levels / logDir / role
//   subscribeLogRecords(listener)     live records, returns an unsubscribe fn
//   getLogDir() / getLogFilePath(ch)  where the JSON-lines files live (one file
//                                     per channel, or the single legacy file)
//   listLogFiles(options)             the files on disk, rotated copies included
//   resolveLogSource(options)         WHERE list/read/follow/prune actually look
//                                     (an explicit logDir/logFile beats the
//                                     environment)
//   readLogRecords(query)             filtered records back out of those files
//   readLogView(query)                the same records as a POLLABLE view: one
//                                     window plus a cursor for the next call,
//                                     which is what the TUI and the web client
//                                     hold between refreshes
//   followLogRecords(query, onRecord) live tail by polling, returns a stop fn
//   pruneLogs(options)                remove ROTATED files only (never the
//                                     active one)
//   __resetLoggingForTest()           test seam: back to a freshly imported kernel
//
// THE DEFAULT CONFIGURATION IS THE FULL PIPELINE: console + file + memory, the
// global level "info", the console gate "warn" and file logging under the
// resolved log directory. It is built LAZILY on the first dispatch, so importing
// this module creates no directory and opens no file; a test that logs must
// therefore point ROLEBOX_LOG_DIR (or configureLogging({ logDir })) at a
// temporary directory before its first record.
//
// CONFIGURATION MERGES. configureLogging applies the fields a call names on top
// of the configuration already in effect, so a later call that only sets a role
// cannot silently drop an earlier logDir. Pass `sinks` again to replace the
// destination list. Configuration NEVER throws: an invalid value is ignored and
// the previous (or default) value stands.

import { dirname, join } from "node:path";

import {
  emitLogEvent,
  resetLogRuntime,
  setDefaultLogSinkFactory,
  setLogClock,
  setLogLevelOverrides,
  setLogRole,
  setLogSink,
} from "./runtime.ts";
import { createConsoleSink } from "./sinks/console.ts";
import { createFileSink, logChannelFileName, resolveLogDir, resolveLogFile } from "./sinks/file.ts";
import type { FileSink, FileSinkFailure } from "./sinks/file.ts";
import { createFanoutSink } from "./sinks/fanout.ts";
import type { FanoutSink } from "./sinks/fanout.ts";
import { createMemorySink, isMemorySink } from "./sinks/memory.ts";
import type { MemorySink } from "./sinks/memory.ts";
import { __setLogThrottleForTest, createLogThrottle } from "./throttle.ts";
import { isLogLevel } from "./types.ts";
import type { LogLevel, LogRecord, LogSink } from "./types.ts";

export { createLogger, logEvent, DEFAULT_LOG_CHANNEL } from "./logger.ts";
export type { Logger } from "./logger.ts";
export { currentLogScope, withLogScope } from "./context.ts";
export {
  channelLevelEnvKey,
  getUnknownEventCodeCount,
  resolveLogLevel,
  DEFAULT_LOG_LEVEL,
  DEFAULT_LOG_ROLE,
  GLOBAL_LEVEL_ENV,
} from "./runtime.ts";
export { LOG_EVENTS, isLogEventCode, logEventDefinition } from "./registry.ts";
export type { LogEventCode, LogEventDefinition } from "./registry.ts";
export { isLogLevel, LOG_LEVEL_RANK, LOG_LEVELS, parseLogLevel } from "./types.ts";
export type { LogFieldValue, LogFields, LogLevel, LogProcessIdentity, LogRecord, LogScope, LogSink } from "./types.ts";
export { DEFAULT_MEMORY_CAPACITY, MEMORY_SINK_KIND, createMemorySink, isMemorySink } from "./sinks/memory.ts";
export type { MemorySink } from "./sinks/memory.ts";
export { CONSOLE_LEVEL_ENV, DEFAULT_CONSOLE_LEVEL } from "./sinks/console.ts";
export { FILE_ENV, LOG_DIR_ENV, MAX_BYTES_ENV, RETAIN_ENV } from "./sinks/file.ts";

// The read side of the same files: what an operator, a CLI or a TUI asks for.
// It depends on the writer's conventions (./sinks/file.ts) and on nothing that
// is browser-safe, because it is a Node/Bun-side operations surface.
export {
  DEFAULT_FOLLOW_POLL_MS,
  DEFAULT_LOG_QUERY_LIMIT,
  followLogRecords,
  listLogFiles,
  pruneLogs,
  readLogRecords,
  resolveLogSource,
} from "./read.ts";
export type {
  FollowLogOptions,
  ListLogFilesOptions,
  LogFileInfo,
  LogOrder,
  LogQuery,
  LogReadResult,
  LogSource,
  PruneLogsOptions,
  PruneLogsResult,
  PruneRemoval,
} from "./read.ts";

// The pollable view: the read layer plus a cursor, for the live surfaces.
export { DEFAULT_LOG_VIEW_LIMIT, readLogView } from "./view.ts";
export type { LogViewQuery, LogViewResult } from "./view.ts";

/** What configureLogging accepts. Every field is optional; the call merges. */
export interface ConfigureLoggingOptions {
  /** Replace the destination list (default: console + file + memory). */
  readonly sinks?: readonly LogSink[];
  /** Global level threshold. */
  readonly level?: LogLevel;
  /** Console sink threshold (default: "warn", or ROLEBOX_LOG_CONSOLE_LEVEL). */
  readonly consoleLevel?: LogLevel;
  /** Per-channel thresholds, keyed by the channel name itself. */
  readonly channelLevels?: Readonly<Record<string, LogLevel>>;
  /** Explicit log directory for the file sink. */
  readonly logDir?: string;
  /** ONE file for every channel (legacy mode); beats `logDir`. */
  readonly logFile?: string;
  /** The role this process reports in every record (default: "host"). */
  readonly role?: string;
}

/** The configuration in effect; each configureLogging call merges into this. */
interface LoggingOptions {
  sinks?: readonly LogSink[];
  level?: LogLevel;
  consoleLevel?: LogLevel;
  channelLevels?: Record<string, LogLevel>;
  logDir?: string;
  logFile?: string;
  role?: string;
}

/** The sinks a pipeline dispatches to, and the file sink it owns (if any). */
interface Pipeline {
  readonly sinks: readonly LogSink[];
  readonly fanout: FanoutSink;
  readonly file: FileSink | undefined;
}

/** How much of an internal failure's message is kept: one line, bounded. */
const MAX_FAILURE_DETAIL = 160;

let options: LoggingOptions = {};
let pipeline: Pipeline | undefined;
let processMemorySink: MemorySink | undefined;

/**
 * The process's memory sink. It is created once and survives reconfiguration,
 * so a viewer that subscribed to it keeps receiving records when the rest of
 * the pipeline is rebuilt.
 */
function defaultMemorySink(): MemorySink {
  if (processMemorySink === undefined) processMemorySink = createMemorySink();
  return processMemorySink;
}

/**
 * Describe a contained failure for a record field: the error's name plus a
 * bounded, single-line detail. This describes a LOCAL sink failure (a file that
 * cannot be written, a sink that threw) — never a platform error body, which the
 * privacy rule keeps out of the log entirely.
 */
function describeLogFailure(error: unknown): { error: string; detail?: string } {
  let name = "Error";
  let message = "";
  try {
    if (error instanceof Error) {
      name = typeof error.name === "string" && error.name.length > 0 ? error.name : "Error";
      message = typeof error.message === "string" ? error.message : "";
    } else if (typeof error === "string") {
      message = error;
    } else if (error !== null && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
      message = (error as { message: string }).message;
    }
  } catch {
    // Keep the defaults.
  }
  const firstLine = message.split("\n", 1)[0]?.trim() ?? "";
  const detail = firstLine.length > MAX_FAILURE_DETAIL ? firstLine.slice(0, MAX_FAILURE_DETAIL) + "…" : firstLine;
  return detail.length > 0 ? { error: name, detail } : { error: name };
}

/** A sink threw: report it once through the pipeline (the fanout reports once). */
function reportSinkFailure(name: string, error: unknown): void {
  try {
    emitLogEvent("log.sink.failed", { sink: name, ...describeLogFailure(error) });
  } catch {
    // Logging never throws.
  }
}

/** The file sink could not write or rotate: name the registered event. */
function reportFileFailure(failure: FileSinkFailure): void {
  try {
    if (failure.code === "log.file.rotate-failed") {
      emitLogEvent(failure.code, { channel: failure.channel, maxBytes: failure.maxBytes ?? 0 });
      return;
    }
    emitLogEvent(failure.code, { channel: failure.channel, ...describeLogFailure(failure.error) });
  } catch {
    // Logging never throws.
  }
}

/**
 * Build a pipeline for `current`: the console + file + memory default, or the
 * caller's own destination list when it named one.
 */
function buildPipeline(current: LoggingOptions): Pipeline {
  if (current.sinks !== undefined) {
    const members = [...current.sinks];
    const fanout = createFanoutSink(members, {
      names: members.map((_, index) => "sink#" + index),
      onFailure: reportSinkFailure,
    });
    return { sinks: members, fanout, file: undefined };
  }

  const file = createFileSink({ dir: current.logDir, file: current.logFile, onFailure: reportFileFailure });
  const members: LogSink[] = [createConsoleSink({ level: current.consoleLevel }), file, defaultMemorySink()];
  const fanout = createFanoutSink(members, { names: ["console", "file", "memory"], onFailure: reportSinkFailure });
  return { sinks: members, fanout, file };
}

/** Make `next` the live pipeline and release the file sink it replaces. */
function installPipeline(next: Pipeline): void {
  const previous = pipeline;
  pipeline = next;
  setLogSink(next.fanout);
  if (previous !== undefined && previous.file !== undefined && previous.file !== next.file) {
    try {
      previous.file.close();
    } catch {
      // Closing a sink must not break configuration.
    }
  }
}

/** The memory sink the current pipeline dispatches to, for subscriptions. */
function currentMemorySink(): MemorySink {
  const members = pipeline?.sinks ?? [];
  for (const member of members) {
    if (isMemorySink(member)) return member;
  }
  return defaultMemorySink();
}

/** Apply the fields a call named on top of the configuration in effect. */
function mergeOptions(base: LoggingOptions, patch: ConfigureLoggingOptions): LoggingOptions {
  const next: LoggingOptions = { ...base };
  if (Array.isArray(patch.sinks)) next.sinks = [...patch.sinks];
  if (isLogLevel(patch.level)) next.level = patch.level;
  if (isLogLevel(patch.consoleLevel)) next.consoleLevel = patch.consoleLevel;
  if (patch.channelLevels !== undefined && patch.channelLevels !== null) {
    const channels: Record<string, LogLevel> = { ...(next.channelLevels ?? {}) };
    for (const key of Object.keys(patch.channelLevels)) {
      const value = patch.channelLevels[key];
      if (isLogLevel(value)) channels[key] = value;
    }
    next.channelLevels = channels;
  }
  const dir = typeof patch.logDir === "string" && patch.logDir.trim().length > 0 ? patch.logDir.trim() : undefined;
  if (dir !== undefined) next.logDir = dir;
  const file = typeof patch.logFile === "string" && patch.logFile.trim().length > 0 ? patch.logFile.trim() : undefined;
  if (file !== undefined) next.logFile = file;
  const role = typeof patch.role === "string" && patch.role.trim().length > 0 ? patch.role.trim() : undefined;
  if (role !== undefined) next.role = role;
  return next;
}

/**
 * Configure the pipeline. The call merges into the configuration already in
 * effect, installs the resulting pipeline and NEVER throws: an unusable value is
 * ignored, and a failure while building sinks leaves whatever pipeline was live
 * in place (or the default one, which is rebuilt on the next dispatch).
 */
export function configureLogging(patch?: ConfigureLoggingOptions): void {
  try {
    if (patch === undefined || patch === null || typeof patch !== "object") return;
    options = mergeOptions(options, patch);
    setLogLevelOverrides({ level: options.level, channelLevels: options.channelLevels });
    if (options.role !== undefined) setLogRole(options.role);
    installPipeline(buildPipeline(options));
  } catch {
    // Configuring the log must never break the process that configures it.
  }
}

/**
 * Subscribe to every record the pipeline produces, synchronously, as it is
 * produced. Returns the unsubscribe function (idempotent).
 *
 * The subscription is served by the memory sink: the process's own by default,
 * or the one the caller put in a custom sink list. Subscribe AFTER configuring
 * when the list carries its own memory sink, because a subscription taken
 * earlier belongs to the process sink that list replaced. A record is delivered
 * even when a sink in front of the memory sink threw.
 */
export function subscribeLogRecords(listener: (record: LogRecord) => void): () => void {
  try {
    if (typeof listener !== "function") return () => {};
    return currentMemorySink().subscribe(listener);
  } catch {
    return () => {};
  }
}

/** The directory the file sink writes into (or would write into). */
export function getLogDir(): string {
  try {
    if (pipeline?.file !== undefined) return pipeline.file.dir;
    // No pipeline yet: answer from the PENDING configuration, so a caller that
    // configured a legacy single file learns its directory before the first
    // record builds the sink.
    const pending = resolveLogFile({ file: options.logFile });
    if (pending !== undefined) return dirname(pending);
    return resolveLogDir({ dir: options.logDir });
  } catch {
    return resolveLogDir({});
  }
}

/**
 * The JSON-lines file a channel writes to: `<logDir>/<channel>.log` with every
 * non-alphanumeric character of the channel replaced by "-" — or, in legacy
 * single-file mode (ROLEBOX_LOG_FILE / configureLogging({ logFile })), the one
 * file every channel shares.
 */
export function getLogFilePath(channel: string): string {
  try {
    const single = pipeline?.file?.singleFile ?? resolveLogFile({ file: options.logFile });
    if (single !== undefined) return single;
    return join(getLogDir(), logChannelFileName(channel));
  } catch {
    return logChannelFileName(channel);
  }
}

/**
 * TEST SEAM. Return the kernel to the state a fresh import would have: the
 * default configuration, no pipeline (rebuilt on the next dispatch), no level
 * overrides, no throttle windows, no dropped-code count and an empty memory
 * buffer with no subscribers. Idempotent and safe to call repeatedly; a running
 * pipeline's file sink is closed first.
 */
export function __resetLoggingForTest(): void {
  try {
    const previous = pipeline;
    pipeline = undefined;
    options = {};
    setLogSink(undefined);
    setLogClock(undefined);
    __setLogThrottleForTest(undefined);
    resetLogRuntime();
    if (previous?.file !== undefined) {
      try {
        previous.file.close();
      } catch {
        // A reset must not throw.
      }
    }
    processMemorySink?.clear();
  } catch {
    // A reset must not throw.
  }
}

/**
 * TEST SEAM. Replace the clock records are stamped with and the clock the
 * throttle windows are measured with, so a test can assert a record's `time` and
 * cross a throttle window without waiting. `undefined` restores Date.now.
 */
export function __setLogClockForTest(now?: () => number): void {
  try {
    setLogClock(now);
    __setLogThrottleForTest(now === undefined ? undefined : createLogThrottle({ now }));
  } catch {
    // A test seam must not throw either.
  }
}

// The default pipeline is installed by the runtime on the first dispatch. The
// factory closes over the configuration in effect at that moment, so a
// reconfigured pipeline built earlier is never resurrected by a stale factory.
setDefaultLogSinkFactory(() => {
  const built = buildPipeline(options);
  installPipeline(built);
  return built.fanout;
});
