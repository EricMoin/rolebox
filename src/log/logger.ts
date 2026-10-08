// ── The channel logger facade ───────────────────────────────────────────────
//
// WHAT A CALL SITE USES. `createLogger("graph:host")` returns the five level
// helpers plus `event(code, fields)`, and every one of them funnels into the
// pipeline in ./runtime.ts. Nothing here holds state, decides a level or
// touches a sink: the facade exists so a module can name its channel once and
// then write `log.warn("…", { attemptId })` without knowing how records travel.
//
// LEVEL HELPERS vs EVENTS
//   debug/info/warn/error/fatal take a message and data fields; they carry no code,
//   because a sentence that only exists at the call site is not an event.
//   event(code, fields) carries a code from the closed vocabulary
//   (./registry.ts) and takes its level, its channel and its message from the
//   table, so the same diagnostic always reads the same way.
//
// `event()` ignores the logger's channel on purpose: the registry entry owns the
// channel, which is what lets one module emit into the channel the event
// belongs to.
//
// WHO INSTALLS A SINK. Nothing here does: the default pipeline (console + file +
// memory) is installed by ./index.ts when it is imported, which is why callers
// are expected to import the public API rather than this module directly. A
// consumer that imports only this file gets no destination until one is set.
//
// NEVER THROWS. Every helper returns void and the pipeline swallows everything
// (including a sink that throws), so a diagnostic can never break the code it
// observes. A message that is not a string, a channel that is empty and a code
// outside the vocabulary are all handled without an exception.

import { emitLogEvent, emitLogRecord } from "./runtime.ts";
import type { LogEventCode } from "./registry.ts";
import type { LogFields } from "./types.ts";

/** The channel a logger falls back to when it is built without a usable name. */
export const DEFAULT_LOG_CHANNEL = "rolebox";

/**
 * The per-channel logging surface: five level helpers and the event emitter.
 * Every method returns void and never throws.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** The one level above error: the process cannot go on. */
  fatal(message: string, fields?: LogFields): void;
  /** Emit a registered event; its level, channel and message come from the table. */
  event(code: LogEventCode, fields?: LogFields): void;
}

/**
 * Build the logger for one channel.
 *
 * `channel` names the source, conventionally `"<area>"` or `"<area>:<part>"`
 * (`"graph:host"`, `"dispatch"`); it is what the file sink turns into a file
 * name and what a channel level override is keyed by. An empty or non-string
 * channel falls back to {@link DEFAULT_LOG_CHANNEL} rather than producing a
 * nameless record.
 */
export function createLogger(channel: string): Logger {
  const name = typeof channel === "string" && channel.length > 0 ? channel : DEFAULT_LOG_CHANNEL;
  return {
    debug: (message: string, fields?: LogFields): void => emitLogRecord("debug", name, undefined, message, fields),
    info: (message: string, fields?: LogFields): void => emitLogRecord("info", name, undefined, message, fields),
    warn: (message: string, fields?: LogFields): void => emitLogRecord("warn", name, undefined, message, fields),
    error: (message: string, fields?: LogFields): void => emitLogRecord("error", name, undefined, message, fields),
    fatal: (message: string, fields?: LogFields): void => emitLogRecord("fatal", name, undefined, message, fields),
    event: (code: LogEventCode, fields?: LogFields): void => emitLogEvent(code, fields),
  };
}

/**
 * Emit ONE registered event without naming a channel first: the table owns the
 * channel, so `logEvent("log.sink.failed", { … })` is the shortest correct call.
 * An unregistered code is dropped and counted (see getUnknownEventCodeCount).
 */
export function logEvent(code: LogEventCode, fields?: LogFields): void {
  emitLogEvent(code, fields);
}
