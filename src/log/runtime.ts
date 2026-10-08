// ── The process-wide log runtime (kernel-internal) ──────────────────────────
//
// THE ONE PIECE OF MUTABLE STATE THE PIPELINE READS. Everything a record needs
// beyond its own arguments lives here: the installed sink (and the factory that
// installs the default one on first use), the level overrides, the process role,
// the clock and the unknown-code counter. src/log/logger.ts is the facade that
// call sites use, and src/log/index.ts is the module that configures this slot —
// neither of them owns state, which is why a test can reset the kernel without
// re-importing anything.
//
// WHY THIS IS NOT IN logger.ts OR index.ts
//   The facade must stay free of process-wide configuration so its contract can
//   be read at a glance, and index.ts must not be imported by the modules it
//   configures (that would be a cycle). A small internal slot is the seam both
//   sides share.
//
// WHAT A DISPATCH DOES, IN ORDER
//   1. the level gate: the channel's effective level (explicit override >
//      channel environment variable > global override > global environment
//      variable > "info") drops everything quieter than itself;
//   2. fields are normalised (undefined dropped) and redacted;
//   3. the throttle gate, only for an event code whose registry entry declares
//      `throttleMs`; a suppressed count rides on the next emitted record;
//   4. the record is built from the ambient scope, the process identity and the
//      clock, frozen, and handed to the sink under a guard.
// Every step is wrapped, so a dispatch NEVER throws — a JavaScript caller
// passing nonsense gets a dropped record, not an exception in the code being
// observed.
//
// PRIVACY. The normalisation here is structural (drop undefined, copy arrays);
// the key-name rule lives in ./redact.ts and runs on every dispatch.

import { currentLogScope } from "./context.ts";
import { redactFields } from "./redact.ts";
import { LOG_EVENTS, isLogEventCode, logEventDefinition, type LogEventCode } from "./registry.ts";
import { logThrottle, logThrottleKey } from "./throttle.ts";
import {
  LOG_LEVEL_RANK,
  isLogLevel,
  type LogFieldValue,
  type LogFields,
  type LogLevel,
  type LogProcessIdentity,
  type LogRecord,
  type LogScope,
  type LogSink,
} from "./types.ts";

/** The environment variable that sets the global level. */
export const GLOBAL_LEVEL_ENV = "ROLEBOX_LOG_LEVEL";

/** The global level an unset or invalid environment falls back to. */
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

/** The role a process reports when configureLogging did not name one. */
export const DEFAULT_LOG_ROLE = "host";

/**
 * The code the runtime emits when it drops an unregistered one. Annotated with
 * the table's own type, so removing the entry from the vocabulary is a compile
 * error here rather than a silent hole in the pipeline.
 */
export const UNKNOWN_EVENT_CODE: LogEventCode = "log.event.unknown-code";

/** Everything the runtime remembers between dispatches. */
interface RuntimeState {
  levelOverride: LogLevel | undefined;
  channelLevelOverrides: Record<string, LogLevel>;
  role: string;
  sink: LogSink | undefined;
  defaultSinkFactory: (() => LogSink | undefined) | undefined;
  clock: (() => number) | undefined;
  unknownCodes: number;
}

const state: RuntimeState = {
  levelOverride: undefined,
  channelLevelOverrides: {},
  role: DEFAULT_LOG_ROLE,
  sink: undefined,
  defaultSinkFactory: undefined,
  clock: undefined,
  unknownCodes: 0,
};

/** The environment key a channel's level override is read from, if it has one. */
export function channelLevelEnvKey(channel: string): string | undefined {
  if (typeof channel !== "string") return undefined;
  const normalized = channel.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  if (normalized.replace(/_/g, "").length === 0) return undefined;
  return "ROLEBOX_LOG_LEVEL_" + normalized;
}

/** A level read from `name`, or `undefined` when unset, blank or invalid. */
export function logLevelFromEnv(name: string): LogLevel | undefined {
  try {
    if (typeof process === "undefined" || process.env === undefined) return undefined;
    const raw = process.env[name];
    if (typeof raw !== "string") return undefined;
    const normalized = raw.trim().toLowerCase();
    return isLogLevel(normalized) ? normalized : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The effective level of a channel: an explicit per-channel override, then the
 * channel's environment key (`ROLEBOX_LOG_LEVEL_<CHANNEL>` with every
 * non-alphanumeric character replaced by `_`), then the global override, then
 * ROLEBOX_LOG_LEVEL, then "info". An invalid value at any step falls through to
 * the next step — never to an exception and never to a guessed level.
 */
export function resolveLogLevel(channel: string): LogLevel {
  try {
    const name = typeof channel === "string" ? channel : String(channel);
    const override = state.channelLevelOverrides[name];
    if (override !== undefined) return override;
    const envKey = channelLevelEnvKey(name);
    if (envKey !== undefined) {
      const fromEnv = logLevelFromEnv(envKey);
      if (fromEnv !== undefined) return fromEnv;
    }
    return state.levelOverride ?? logLevelFromEnv(GLOBAL_LEVEL_ENV) ?? DEFAULT_LOG_LEVEL;
  } catch {
    return state.levelOverride ?? DEFAULT_LOG_LEVEL;
  }
}

/** Replace the level overrides a configuration call established. */
export function setLogLevelOverrides(overrides: {
  readonly level?: LogLevel | undefined;
  readonly channelLevels?: Readonly<Record<string, LogLevel>> | undefined;
}): void {
  state.levelOverride = isLogLevel(overrides.level) ? overrides.level : undefined;
  const channels: Record<string, LogLevel> = {};
  if (overrides.channelLevels !== undefined) {
    for (const key of Object.keys(overrides.channelLevels)) {
      const value = overrides.channelLevels[key];
      if (isLogLevel(value)) channels[key] = value;
    }
  }
  state.channelLevelOverrides = channels;
}

/** Install the sink records are dispatched to. `undefined` means "none yet". */
export function setLogSink(sink: LogSink | undefined): void {
  state.sink = sink;
}

/**
 * Install the factory that builds the default pipeline. src/log/index.ts sets
 * it once, at import time; the runtime calls it lazily on the first dispatch so
 * importing the kernel never touches the file system by itself.
 */
export function setDefaultLogSinkFactory(factory: (() => LogSink | undefined) | undefined): void {
  state.defaultSinkFactory = factory;
}

/** The sink to dispatch to, building the default pipeline on first use. */
function currentSink(): LogSink | undefined {
  if (state.sink !== undefined) return state.sink;
  const factory = state.defaultSinkFactory;
  if (factory === undefined) return undefined;
  try {
    const built = factory();
    if (state.sink === undefined && built !== undefined) state.sink = built;
    return state.sink ?? built;
  } catch {
    return undefined;
  }
}

/** Set the role this process reports. A non-string or blank value is ignored. */
export function setLogRole(role: string | undefined): void {
  if (typeof role === "string" && role.trim().length > 0) state.role = role.trim();
}

/** The process identity every record carries. */
export function logProcessIdentity(): LogProcessIdentity {
  let pid = 0;
  try {
    if (typeof process !== "undefined" && typeof process.pid === "number") pid = process.pid;
  } catch {
    pid = 0;
  }
  return Object.freeze({ pid, role: state.role });
}

/** The clock records are stamped with. */
function runtimeClock(): number {
  try {
    return typeof state.clock === "function" ? state.clock() : Date.now();
  } catch {
    return Date.now();
  }
}

/** Test seam: replace the record clock (`undefined` restores Date.now). */
export function setLogClock(clock: (() => number) | undefined): void {
  state.clock = typeof clock === "function" ? clock : undefined;
}

/** How many event codes outside the vocabulary have been dropped. */
export function getUnknownEventCodeCount(): number {
  return state.unknownCodes;
}

/** Copy the ambient scope, keeping only non-empty string entries. */
function scopeSnapshot(): LogScope {
  let scope: LogScope;
  try {
    scope = currentLogScope();
  } catch {
    scope = {};
  }
  const defined: Record<string, string> = {};
  for (const key of Object.keys(scope)) {
    const value = (scope as Record<string, string | undefined>)[key];
    if (typeof value === "string" && value.length > 0) defined[key] = value;
  }
  return Object.freeze(defined);
}

/**
 * Normalise caller fields: drop `undefined` values, copy and freeze arrays, and
 * drop a value whose runtime shape the declared type does not admit (a
 * JavaScript caller cannot smuggle an object into a record).
 */
function definedFields(fields: LogFields | undefined): Record<string, LogFieldValue> {
  const defined: Record<string, LogFieldValue> = {};
  if (fields === undefined || fields === null) return defined;
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    if (value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      defined[key] = value;
    } else if (Array.isArray(value)) {
      const copy: (string | number)[] = [];
      for (const entry of value) {
        if (typeof entry === "string" || typeof entry === "number") copy.push(entry);
      }
      // The declared union admits a string[] or a number[]; a JavaScript
      // caller's mixed array is copied and frozen rather than rejected.
      defined[key] = Object.freeze(copy) as LogFieldValue;
    }
  }
  return defined;
}

/** The throttle window an event code declares, or `undefined` when it has none. */
function eventThrottleMs(code: string): number | undefined {
  if (!isLogEventCode(code)) return undefined;
  return logEventDefinition(code).throttleMs;
}

/**
 * Dispatch ONE record. This is the whole pipeline and it NEVER throws.
 *
 * `code` is present only for events; the throttle gate applies only to a code
 * whose registry entry declares `throttleMs`. A record suppressed by the gate
 * is not built at all; the count of what was suppressed is attached to the next
 * emitted record as a `suppressed` field (overwriting any caller field of that
 * name, because the number is the pipeline's own accounting).
 */
export function emitLogRecord(
  level: LogLevel,
  channel: string,
  code: string | undefined,
  message: string,
  fields?: LogFields,
): void {
  try {
    if (!isLogLevel(level)) return;
    const name = typeof channel === "string" && channel.length > 0 ? channel : "rolebox";
    if (LOG_LEVEL_RANK[level] < LOG_LEVEL_RANK[resolveLogLevel(name)]) return;

    let prepared: LogFields = redactFields(definedFields(fields));

    if (code !== undefined) {
      const throttleMs = eventThrottleMs(code);
      if (throttleMs !== undefined) {
        const decision = logThrottle().check(logThrottleKey(name, code), throttleMs);
        if (!decision.emit) return;
        if (decision.suppressed > 0) {
          prepared = Object.freeze({ ...prepared, suppressed: decision.suppressed });
        }
      }
    }

    const sink = currentSink();
    if (sink === undefined) return;

    const record: LogRecord = Object.freeze({
      time: runtimeClock(),
      level,
      channel: name,
      code,
      message: typeof message === "string" ? message : String(message),
      scope: scopeSnapshot(),
      fields: Object.freeze(prepared),
      process: logProcessIdentity(),
    });

    try {
      sink(record);
    } catch {
      // A sink must never break the code it observes. A composite sink reports
      // its own members; a lone sink that throws is simply contained here.
    }
  } catch {
    // Logging never throws.
  }
}

/**
 * Emit ONE registered event: level, channel and message come from the closed
 * vocabulary, and only the fields come from the caller.
 *
 * An unregistered code is dropped, counted (getUnknownEventCodeCount) and
 * reported through {@link UNKNOWN_EVENT_CODE}, which is itself throttled so a
 * drifted call site in a loop cannot flood the log. The counter keeps increasing
 * while that report is suppressed, so the next report carries the true total.
 */
export function emitLogEvent(code: LogEventCode, fields?: LogFields): void {
  try {
    if (!isLogEventCode(code)) {
      state.unknownCodes += 1;
      const unknown = LOG_EVENTS[UNKNOWN_EVENT_CODE];
      emitLogRecord(unknown.level, unknown.channel, UNKNOWN_EVENT_CODE, unknown.message, {
        event: String(code),
        dropped: state.unknownCodes,
      });
      return;
    }
    const definition = LOG_EVENTS[code];
    emitLogRecord(definition.level, definition.channel, code, definition.message, fields);
  } catch {
    // Logging never throws.
  }
}

/**
 * Forget every configuration value the runtime holds, the throttle windows and
 * the dropped-code counter, and drop the installed sink so the next dispatch
 * rebuilds the default pipeline.
 *
 * The default-sink factory survives: it belongs to src/log/index.ts and is
 * installed once at import time.
 */
export function resetLogRuntime(): void {
  try {
    state.levelOverride = undefined;
    state.channelLevelOverrides = {};
    state.role = DEFAULT_LOG_ROLE;
    state.sink = undefined;
    state.clock = undefined;
    state.unknownCodes = 0;
    logThrottle().reset();
  } catch {
    // A reset must not throw either.
  }
}
