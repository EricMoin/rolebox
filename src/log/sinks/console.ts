// ── Console sink ────────────────────────────────────────────────────────────
//
// ONE LINE PER RECORD, IN THE SHAPE AN OPERATOR READS:
//
//   [warn] graph:host sweep.store-blocked graph=g1 attempt=a2 reason="…" — <message>
//
//   • `[level]`, then the channel, then the event code when the record has one;
//   • then the SCOPE, whose keys are shortened to the names those ids are known
//     by (graphId → graph, attemptId → attempt, …) and always rendered in the
//     same order, so two lines from the same run line up;
//   • then the caller's FIELDS, in the caller's order;
//   • then the message, after an em dash.
//
// CONVENTIONS (the same ones the engine's renderer used, so a line reads the
// same wherever it was produced)
//   • a SCOPE value is written bare when it is a plain id or name — `graph=g1`,
//     `attempt=a2` — and quoted only when it carries whitespace or a quote, so
//     the identity segment stays the readable part of the line;
//   • a FIELD string is double-quoted and JSON-escaped — the repository's one
//     quoting rule, reused rather than re-invented;
//   • numbers and booleans are written bare;
//   • an array is joined with "," and quoted as ONE value; a console line has no
//     room for a nested form, while the file record keeps the real array;
//   • a field whose value is `undefined` is omitted, and a record with neither
//     scope nor fields has neither segment.
//
// THE GATE. Records are normally already filtered by the pipeline's level, and
// this sink applies the second gate an operator actually asked for: it writes at
// or above ROLEBOX_LOG_CONSOLE_LEVEL (default "warn"; unset, blank or invalid
// values fall back to it), or at the level an explicit option names. warn goes
// to console.warn, error AND fatal to console.error, info and debug to
// console.debug — fatal is the loudest level, not a separate destination.
//
// The write itself is guarded: console output must never break the caller.

import { LOG_LEVEL_RANK, parseLogLevel, type LogFieldValue, type LogFields, type LogLevel, type LogRecord, type LogScope, type LogSink } from "../types.ts";

/** The environment variable that sets the console gate. */
export const CONSOLE_LEVEL_ENV = "ROLEBOX_LOG_CONSOLE_LEVEL";

/** The console level an unset or invalid value falls back to. */
export const DEFAULT_CONSOLE_LEVEL: LogLevel = "warn";

/**
 * The scope key labels, in the order they are rendered. A scope entry that is
 * not named here (only reachable from a JavaScript caller) is not rendered.
 */
const SCOPE_LABELS: ReadonlyArray<readonly [keyof LogScope, string]> = [
  ["sessionId", "session"],
  ["agent", "agent"],
  ["graphId", "graph"],
  ["runId", "run"],
  ["nodeId", "node"],
  ["attemptId", "attempt"],
  ["effectId", "effect"],
  ["tool", "tool"],
];

/** The console method a level writes through. */
type ConsoleMethod = "debug" | "warn" | "error";

/** How a line reaches the console; replaceable so a test can read it directly. */
export type ConsoleEmit = (method: ConsoleMethod, line: string) => void;

/** Options for {@link createConsoleSink}. */
export interface ConsoleSinkOptions {
  /** Fixed gate level; when omitted the environment decides, per record. */
  readonly level?: LogLevel;
  /** Where a line goes; defaults to console.debug / console.warn / console.error. */
  readonly emit?: ConsoleEmit;
}

/** Render ONE value, or `undefined` for a value that must be omitted. */
function renderValue(value: LogFieldValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return JSON.stringify(value.join(","));
  return undefined;
}

/** Render the `k=v` segment of the caller's fields, or "" when there is none. */
export function formatLogFields(fields: LogFields | undefined): string {
  if (fields === undefined || fields === null) return "";
  const parts: string[] = [];
  for (const key of Object.keys(fields)) {
    const rendered = renderValue(fields[key]);
    if (rendered !== undefined) parts.push(key + "=" + rendered);
  }
  return parts.join(" ");
}

/**
 * Render ONE scope value. An id or a name is written BARE (`graph=g1`), because
 * that is how the identity segment is read; a value carrying whitespace, a quote
 * or a control character is quoted instead, so the line can never be misread.
 */
function renderScopeValue(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return /^[A-Za-z0-9._:@/+\-]+$/.test(value) ? value : JSON.stringify(value);
}

/** Render the scope segment with its short labels, or "" when it is empty. */
export function formatLogScope(scope: LogScope | undefined): string {
  if (scope === undefined || scope === null) return "";
  const parts: string[] = [];
  for (const [key, label] of SCOPE_LABELS) {
    const rendered = renderScopeValue(scope[key]);
    if (rendered !== undefined) parts.push(label + "=" + rendered);
  }
  return parts.join(" ");
}

/** Render one record as the console's single line. */
export function formatLogLine(record: LogRecord): string {
  const head = "[" + record.level + "] " + record.channel + (record.code === undefined ? "" : " " + record.code);
  const segments = [formatLogScope(record.scope), formatLogFields(record.fields)].filter((part) => part.length > 0);
  const body = segments.length === 0 ? head : head + " " + segments.join(" ");
  return body + " — " + record.message;
}

/** The effective console level: an explicit option, then the environment, then "warn". */
export function resolveConsoleLevel(explicit?: LogLevel): LogLevel {
  if (explicit !== undefined) return explicit;
  let raw: string | undefined;
  try {
    if (typeof process !== "undefined" && process.env !== undefined) raw = process.env[CONSOLE_LEVEL_ENV];
  } catch {
    raw = undefined;
  }
  return parseLogLevel(raw, DEFAULT_CONSOLE_LEVEL);
}

/** The default emit: the console method that matches the level. */
function consoleEmit(method: ConsoleMethod, line: string): void {
  if (method === "error") console.error(line);
  else if (method === "warn") console.warn(line);
  else console.debug(line);
}

/**
 * Build the console sink. The gate is read per record when no explicit level was
 * given, so a process that changes ROLEBOX_LOG_CONSOLE_LEVEL — a test, a CLI
 * wrapper — is honored without rebuilding the pipeline.
 */
export function createConsoleSink(options?: ConsoleSinkOptions): LogSink {
  const explicit = options?.level !== undefined && LOG_LEVEL_RANK[options.level] !== undefined ? options.level : undefined;
  const emit = options?.emit ?? consoleEmit;

  return (record: LogRecord): void => {
    try {
      const rank = LOG_LEVEL_RANK[record.level];
      if (rank === undefined) return;
      if (rank < LOG_LEVEL_RANK[resolveConsoleLevel(explicit)]) return;
      const level = record.level;
      const method: ConsoleMethod = level === "error" || level === "fatal" ? "error" : level === "warn" ? "warn" : "debug";
      emit(method, formatLogLine(record));
    } catch {
      // Console output must never break the caller.
    }
  };
}
