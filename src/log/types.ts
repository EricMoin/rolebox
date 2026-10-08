// ── The platform log record contract ────────────────────────────────────────
//
// ONE SHAPE FOR EVERY DIAGNOSTIC THE PLATFORM PRODUCES. A record says WHAT
// happened (level, channel, optional event code, message, data fields), WHO it
// happened to (the ambient scope) and WHERE it happened (pid and process role).
// Identity and data are separate keys on purpose: `scope` is the part a query
// filters on, `fields` is the part an operator reads, and a sink may render the
// two differently without either party guessing which is which.
//
// WHY THE SHAPES ARE THIS NARROW
//   • LogFieldValue admits ids, states, reasons, counts and arrays of them —
//     never a payload, an accepted result, a credential or a raw platform error
//     body. The type is the first line of that rule (src/log/redact.ts is the
//     last), and the field shape is narrow enough that a call site cannot
//     smuggle more through it without a deliberate cast.
//   • LogRecord and every part of it are readonly: a sink cannot rewrite what
//     the next sink sees.
//   • LogSink returns void and is always called under a guard, so a diagnostic
//     can never throw into the code it observes.
//
// This module imports nothing and adds no behaviour beyond the four-level table
// and the parsing of the level vocabulary, so every other module under src/log
// can depend on it without a cycle.
//
// Note on `undefined` field values: LogFields admits them so a call site can
// write `{ attemptId: maybeUndefined }` without a conditional, while the record
// builder (src/log/runtime.ts) drops those keys and the console renderer omits
// them — see the tests for the exact convention.

/**
 * The five levels, ordered debug < info < warn < error < fatal.
 *
 * `fatal` is the one level above `error`, for the diagnostics that describe a
 * process which cannot go on: an uncaught exception, a critical service that
 * failed to initialise. It ranks higher than error so every gate that already
 * admits error admits it too, it renders through console.error (never a
 * separate channel an operator has to learn) and it is recorded verbatim as
 * `"level":"fatal"` in the JSON-lines file.
 */
export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

/** Every level, in rank order. Derived consumers use this instead of a copy. */
export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error", "fatal"];

/** Rank of each level; the gates compare ranks, never string literals. */
export const LOG_LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

/** The field value shapes a record may carry. Arrays stay real arrays. */
export type LogFieldValue = string | number | boolean | readonly string[] | readonly number[];

/** Data fields of a record. `undefined` values are dropped before dispatch. */
export type LogFields = Readonly<Record<string, LogFieldValue | undefined>>;

/**
 * The ambient identity a diagnostic belongs to. Every entry is an ID or a name
 * that already exists elsewhere in the system — this type never introduces a
 * new identifier, it only carries the ones the caller is working with.
 */
export interface LogScope {
  readonly sessionId?: string;
  readonly agent?: string;
  readonly graphId?: string;
  readonly runId?: string;
  readonly nodeId?: string;
  readonly attemptId?: string;
  readonly effectId?: string;
  readonly tool?: string;
}

/** Where the record was produced: the OS process and the role it plays. */
export interface LogProcessIdentity {
  readonly pid: number;
  readonly role: string;
}

/**
 * One diagnostic, as every sink receives it.
 *
 * `code` is present only for events (a record built from the closed vocabulary
 * in src/log/registry.ts); the level helpers (`logger.warn(...)`) leave it out.
 */
export interface LogRecord {
  /** Epoch milliseconds when the record was built. */
  readonly time: number;
  readonly level: LogLevel;
  /** The channel the record belongs to, e.g. "graph:host" or "log". */
  readonly channel: string;
  /** The registered event code, when the record is an event. */
  readonly code?: string;
  readonly message: string;
  readonly fields: LogFields;
  readonly scope: LogScope;
  readonly process: LogProcessIdentity;
}

/** A destination for records. A sink must not throw; if it does, it is contained. */
export type LogSink = (record: LogRecord) => void;

/** True when `value` names one of the five levels. */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && Object.hasOwn(LOG_LEVEL_RANK, value);
}

/**
 * Parse a level value, case-insensitively, falling back to `fallback` for
 * anything that is not one of the five names (including `undefined`, an empty
 * string and an unknown word). This NEVER throws and never guesses a level:
 * an illegal value is answered with the caller's default.
 */
export function parseLogLevel(value: unknown, fallback: LogLevel): LogLevel {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return isLogLevel(normalized) ? normalized : fallback;
}
