// ── The logger compatibility shell ──────────────────────────────────────────
//
// WHAT THIS FILE IS. Every one of the ~170 modules that log imports THIS module
// and nothing else: `createSubLogger("dispatch")`, `formatError(err)`,
// `getRootLogger().attachTransport(...)`. The platform's real pipeline lives in
// src/log/**; this file is the thin, permanent translation layer between the two
// — the reason the call sites did not have to change when tslog left.
//
// WHAT EACH EXPORT MAPS TO
//   createSubLogger(name, minLevel?)  → a logger whose CHANNEL is `name`, over
//                                       the kernel's createLogger(name). The
//                                       name is used verbatim, colons and all
//                                       ("graph:host" stays "graph:host").
//   getRootLogger() / rootLogger      → the same logger on the ROOT_CHANNEL
//                                       ("rolebox").
//   log.debug/info/warn/error/fatal   → the kernel's five levels, level-gated by
//                                       the kernel and by the logger's own
//                                       minLevel.
//   log.silly / log.trace             → "debug", with the alias recorded in the
//                                       record's fields (see below).
//   logger.attachTransport(fn)        → subscribeLogRecords, adapted to the
//                                       tslog-shaped entry (see below).
//   logger.getSubLogger({name,…})     → createSubLogger(name, minLevel), so the
//                                       object a caller already holds keeps
//                                       working.
//   formatError(err)                  → unchanged; still { message, stack?, name? }.
//   configureLogDirectory(workspace)  → configureLogging({ logDir }), with the
//                                       workspace root mapped to the directory
//                                       the legacy API meant (see below).
//   getLogFilePath(channel?)          → the kernel's resolved file for a channel
//                                       (the single legacy file when there is one)
//   __resetForTest()                  → __resetLoggingForTest()
//
// TWO HELPERS OF THE OLD MODULE ARE GONE ON PURPOSE. `parseLogLevel` answered
// tslog's numeric rank ladder by reading ROLEBOX_LOG_LEVEL, and
// `resolveLogFilePath` answered the one file the old transport resolved; with
// the platform owning both, keeping them would have meant a second reader of
// ROLEBOX_LOG_LEVEL and a second answer to "where does a record go". The
// vocabulary parser lives in src/log/types.ts, the file resolution in
// src/log/sinks/file.ts, and neither environment variable has another reader.
//
// THE ARGUMENTS OF A LEVEL HELPER. tslog took `(…args)` and wrote them into
// numbered slots; the kernel takes a message and NAMED fields. This shell
// translates, and the translation is deliberately lossless for the shapes the
// repository actually calls:
//   • the first argument is the message. A non-string message is rendered: an
//     Error contributes its message, an object its JSON, anything else String().
//   • every FURTHER argument is adapted into fields. A plain object is a field
//     bag: its string/number/boolean values and its uniform string[]/number[]
//     arrays are kept as they are, a value that is an Error (or a formatError
//     result — anything carrying a string `message`) contributes that message as
//     the reason, and any other object is dropped: the kernel's field type is
//     the privacy rule, and this shell does not widen it.
//   • a further argument that is a SCALAR cannot become a field bag, so it lands
//     under the positional key `arg1`, `arg2`, … (`log.warn("save failed", dir, err)`
//     records `arg1` and `error`). Stage 4 rewrites those few call sites.
//   • an Error passed on its own — `log.warn("save failed", err)` — becomes
//     `{ error: <message> }`, which is what the call site meant and what the old
//     numbered slots never actually preserved in JSON.
//
// THE TRANSPORT ENTRY. `attachTransport(fn)` must keep working for the capture
// tests that already exist, so the entry keeps the tslog-accessor contract their
// assertions use — the message at "0", the fields at "1" — and adds the two
// identity keys in the open instead of under `_meta`:
//
//   { "0": message, "1": fields, level: "warn", channel: "graph:host" }
//
// There is no `_meta` object, no parentNames chain and no numeric level ladder:
// those were tslog's shapes and they are gone. A transport that wants the real
// record should use the kernel's subscribeLogRecords instead.
//
// THE LEGACY SINGLE FILE. When ROLEBOX_LOG_FILE is set, the kernel's file sink
// writes EVERY channel into that one file (src/log/sinks/file.ts), which is the
// contract this module has always honored. Otherwise the layout is the kernel's:
// one `<logDir>/<channel>.log` per channel.
//
// CONFIGURE LOG DIRECTORY. The argument is a WORKSPACE root, not a log
// directory: the legacy implementation resolved `<dir>/.rolebox/logs/rolebox.log`
// from it, and src/entries/*.ts pass `ctx.directory`, `workingDir` and the like.
// The shell therefore forwards `<dir>/.rolebox/logs` as the kernel's `logDir`, so
// the files land where they always landed. A path that already ends in
// `.rolebox/logs` is forwarded as it is.
//
// WHAT CHANGED FOR THE CALLER (Stage 2, deliberate):
//   • a warn (or error/fatal) record is now VISIBLE on the console, which used
//     to be silent by construction ("type: hidden");
//   • the file record is flat — `{"time":…,"level":"warn","channel":…,"message":…,
//     "scope":{…},"fields":{…},"process":{…}}` — instead of tslog's
//     `{"0":…,"1":…,"_meta":{…}}`;
//   • a custom transport is a SUBSCRIBER: it sees records produced after it was
//     attached (the old per-sub-logger transport inheritance is gone).

import { join } from "node:path";

import {
  __resetLoggingForTest,
  configureLogging,
  createLogger,
  getLogFilePath as kernelLogFilePath,
  subscribeLogRecords,
} from "./log/index.ts";
import { LOG_LEVEL_RANK, type LogFields, type LogFieldValue, type LogLevel } from "./log/types.ts";

/** The channel the root logger writes on when a caller does not name one. */
export const ROOT_CHANNEL = "rolebox";

/**
 * The record shape tslog handed a transport, kept as the NAME the call sites
 * already import for their logger types (`Logger<ILogObj>`). It is a plain
 * string-keyed bag: this shell's transport entry puts the message at "0" and the
 * fields at "1" (see {@link Logger.attachTransport}).
 */
export type ILogObj = Record<string, unknown>;

/** What `getSubLogger` accepts: tslog's settings object, minus `parentNames`. */
export interface LoggerSettings {
  /** The channel of the sub-logger; omitted means "the parent's channel". */
  readonly name?: string;
  /** A numeric tslog rank (0–6) or a level name; omitted means "inherit". */
  readonly minLevel?: number | LogLevel;
}

/**
 * The logging surface this module has always exposed. Every method returns void
 * and never throws: a diagnostic can never break the code it observes.
 *
 * `T` is retained only so the historical `Logger<ILogObj>` annotations in the
 * modules that take a logger parameter keep compiling; the shape is not generic.
 */
export interface Logger<T = unknown> {
  /** Message plus optional data; anything below the effective level is dropped. */
  debug(message: unknown, ...args: unknown[]): void;
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
  /** The one level above error: the process cannot go on. */
  fatal(message: unknown, ...args: unknown[]): void;
  /** tslog's quietest level, recorded as `debug` with an `alias: "silly"` field. */
  silly(message: unknown, ...args: unknown[]): void;
  /** tslog's second level, recorded as `debug` with an `alias: "trace"` field. */
  trace(message: unknown, ...args: unknown[]): void;
  /** A sub-logger on `settings.name` (default: this logger's channel). */
  getSubLogger(settings?: LoggerSettings): Logger<T>;
  /** Receive every record this process produces from now on, in tslog's shape. */
  attachTransport(transport: (entry: ILogObj) => void): void;
}

/** The level each legacy minLevel/alias name maps to. */
const LEGACY_LEVELS: Readonly<Record<string, LogLevel>> = {
  silly: "debug",
  trace: "debug",
  verbose: "debug",
  debug: "debug",
  info: "info",
  log: "info",
  warn: "warn",
  warning: "warn",
  error: "error",
  fatal: "fatal",
};

/**
 * Translate a legacy `minLevel` into a kernel level: a name is looked up in
 * {@link LEGACY_LEVELS}, a number is tslog's rank ladder (debug and below → 2,
 * info → 3, warn → 4, error → 5, fatal → 6). Anything unrecognized means "no
 * level of its own" and the kernel's own gate decides.
 */
function levelFromMinLevel(minLevel: number | LogLevel | undefined): LogLevel | undefined {
  if (typeof minLevel === "string") return LEGACY_LEVELS[minLevel.trim().toLowerCase()];
  if (typeof minLevel !== "number" || !Number.isFinite(minLevel)) return undefined;
  const rank = Math.floor(minLevel);
  if (rank <= 2) return "debug";
  if (rank === 3) return "info";
  if (rank === 4) return "warn";
  if (rank === 5) return "error";
  return "fatal";
}

/** Render a caller's first argument as the record's message. */
function describeMessage(message: unknown): string {
  if (typeof message === "string") return message;
  if (message instanceof Error) return message.message;
  if (message === null || message === undefined) return String(message);
  if (typeof message === "object") {
    try {
      return JSON.stringify(message) ?? String(message);
    } catch {
      return String(message);
    }
  }
  return String(message);
}

/** A value the kernel's field type admits, or `undefined` when it does not. */
function admissibleValue(value: unknown): LogFieldValue | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (value.every((entry) => typeof entry === "string")) return value as string[];
    if (value.every((entry) => typeof entry === "number")) return value as number[];
  }
  return undefined;
}

/** The reason an error-like value states: an Error's, or a `message` string. */
function reasonOf(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  if (value !== null && typeof value === "object") {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return undefined;
}

/** Merge one field bag into `fields`, keeping only what the kernel admits. */
function mergeFieldBag(fields: Record<string, LogFieldValue>, bag: object): void {
  for (const key of Object.keys(bag)) {
    const value = (bag as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    const admissible = admissibleValue(value);
    if (admissible !== undefined) {
      fields[key] = admissible;
      continue;
    }
    if (Array.isArray(value) || typeof value !== "object") continue;
    const reason = reasonOf(value);
    if (reason !== undefined) fields[key] = reason;
  }
}

/** Adapt a level helper's extra arguments into the kernel's named fields. */
function fieldsFromArgs(args: readonly unknown[]): LogFields {
  const fields: Record<string, LogFieldValue> = {};
  let position = 0;
  for (const arg of args) {
    position += 1;
    if (arg === undefined || arg === null) continue;
    if (typeof arg === "object" && !Array.isArray(arg)) {
      if (arg instanceof Error) {
        fields.error = arg.message;
        continue;
      }
      mergeFieldBag(fields, arg);
      continue;
    }
    const admissible = admissibleValue(arg);
    if (admissible !== undefined) fields["arg" + position] = admissible;
  }
  return fields;
}

/**
 * Build one compatibility logger over the kernel. `channel` is used verbatim;
 * `minLevel` adds a gate in front of the kernel's own.
 */
function createCompatLogger(channel: string, minLevel?: number | LogLevel): Logger {
  const name = typeof channel === "string" && channel.trim().length > 0 ? channel : ROOT_CHANNEL;
  const gate = levelFromMinLevel(minLevel);
  const kernel = createLogger(name);

  const emit = (level: LogLevel, message: unknown, args: readonly unknown[]): void => {
    try {
      if (gate !== undefined && LOG_LEVEL_RANK[level] < LOG_LEVEL_RANK[gate]) return;
      kernel[level](describeMessage(message), fieldsFromArgs(args));
    } catch {
      // A diagnostic must never break the code it observes.
    }
  };

  return {
    debug: (message: unknown, ...args: unknown[]): void => emit("debug", message, args),
    info: (message: unknown, ...args: unknown[]): void => emit("info", message, args),
    warn: (message: unknown, ...args: unknown[]): void => emit("warn", message, args),
    error: (message: unknown, ...args: unknown[]): void => emit("error", message, args),
    fatal: (message: unknown, ...args: unknown[]): void => emit("fatal", message, args),
    silly: (message: unknown, ...args: unknown[]): void => emit("debug", message, [{ alias: "silly" }, ...args]),
    trace: (message: unknown, ...args: unknown[]): void => emit("debug", message, [{ alias: "trace" }, ...args]),
    getSubLogger: (settings?: LoggerSettings): Logger => {
      const childName = typeof settings?.name === "string" && settings.name.trim().length > 0 ? settings.name : name;
      return createCompatLogger(childName, settings?.minLevel ?? gate);
    },
    attachTransport: (transport: (entry: ILogObj) => void): void => {
      if (typeof transport !== "function") return;
      try {
        subscribeLogRecords((record) => {
          try {
            transport({ "0": record.message, "1": record.fields, level: record.level, channel: record.channel });
          } catch {
            // A transport must not break the pipeline or the caller.
          }
        });
      } catch {
        // Subscribing must never throw either.
      }
    },
  };
}

/** The root logger: the channel the platform's own diagnostics use. */
const ROOT_LOGGER: Logger = createCompatLogger(ROOT_CHANNEL);

/**
 * Get the root logger (channel "rolebox"). The object is created once per
 * process; the kernel behind it stays lazy, so this opens no file by itself.
 */
export function getRootLogger(): Logger {
  return ROOT_LOGGER;
}

/** Backward-compatible alias: direct access to the root logger singleton. */
export const rootLogger: Logger = ROOT_LOGGER;

/**
 * Create a logger for one channel. The name is the channel the kernel records
 * and the file it writes (`"graph:host"` → `<logDir>/graph-host.log`, unless
 * ROLEBOX_LOG_FILE asks for a single file).
 *
 * `minLevel` is the legacy per-logger gate: a numeric tslog rank (0–6) or a
 * level name. It filters THIS logger's records before the kernel's own gate
 * sees them; omitted, the kernel's configured level decides alone.
 */
export function createSubLogger(name: string, minLevel?: number | LogLevel): Logger {
  return createCompatLogger(name, minLevel);
}

/**
 * Normalize any error-like value into { message, stack?, name? }.
 * Handles Error objects, strings, null, undefined, and arbitrary objects.
 */
export function formatError(err: unknown): { message: string; stack?: string; name?: string } {
  if (err instanceof Error) {
    return {
      message: err.message,
      stack: err.stack,
      name: err.name,
    };
  }
  if (typeof err === "string") {
    return { message: err };
  }
  if (err === null || err === undefined) {
    return { message: String(err) };
  }
  try {
    return { message: JSON.stringify(err) };
  } catch {
    return { message: String(err) };
  }
}

/** The workspace root the legacy API meant, as the kernel's log directory. */
function workspaceLogDir(directory: string): string {
  const trimmed = directory.trim().replace(/[\\/]+$/, "");
  if (/[\\/]\.rolebox[\\/]logs$/i.test(trimmed)) return trimmed;
  return join(trimmed, ".rolebox", "logs");
}

/**
 * Point the file sink at a workspace: `configureLogging({ logDir })` on
 * `<directory>/.rolebox/logs`, the directory the legacy implementation resolved
 * `<directory>` to. Under ROLEBOX_LOG_FILE the single-file contract wins and the
 * directory is never consulted.
 */
export function configureLogDirectory(directory: string): void {
  if (typeof directory !== "string" || directory.trim().length === 0) return;
  try {
    configureLogging({ logDir: workspaceLogDir(directory) });
  } catch {
    // Configuring the log must never break the process that configures it.
  }
}

/**
 * The JSON-lines file a channel writes to — or, when ROLEBOX_LOG_FILE is set,
 * the one file every channel shares. A channel that is not a usable name falls
 * back to the root channel.
 */
export function getLogFilePath(channel?: string): string {
  const name = typeof channel === "string" && channel.trim().length > 0 ? channel : ROOT_CHANNEL;
  return kernelLogFilePath(name);
}

/**
 * Reset the logging kernel to the state a fresh import would have (for testing
 * only): the default configuration, no installed pipeline, no level overrides
 * and an empty memory buffer. The environment is read again on the next record,
 * so a test can change ROLEBOX_LOG_LEVEL / ROLEBOX_LOG_FILE / ROLEBOX_LOG_DIR
 * and call this to make the change take effect.
 */
export function __resetForTest(): void {
  try {
    __resetLoggingForTest();
  } catch {
    // A reset must not throw.
  }
}
