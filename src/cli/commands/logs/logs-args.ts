// ── The `rolebox logs` command line, parsed ─────────────────────────────────
//
// WHAT THIS MODULE OWNS. It turns citty's loosely typed `args` record into the
// three shapes the runners work with — a query, a file listing and a prune — and
// it says NO to a value the command cannot honour. Every rejection is a
// {@link LogsUsageError}: the command catches it, prints the message plus the
// usage line and answers exit code 1, which is the one failure a `logs`
// invocation reports as an error (an empty answer is not an error).
//
// RELATIVE TIMES ARE RESOLVED HERE, ONCE. `--since 10m` is the operator's
// shorthand for "ten minutes ago", which is a POINT IN TIME and has to be
// resolved against a clock — the caller passes `now`, so a test can freeze it
// and the parser stays pure. The same parser serves `--until`; an ISO 8601
// timestamp and plain epoch milliseconds are accepted unchanged, because those
// are what a script has in hand.
//
// WHY A BARE NUMBER IS NOT A DURATION. `--since 10` could mean ten seconds,
// ten minutes or an epoch-millisecond literal, and guessing would answer a
// question nobody asked. A relative time therefore REQUIRES a unit (`10s`,
// `10m`, `2h`, `1d`, `1w`), while an all-digit value is read as epoch
// milliseconds only when it is large enough to be one (after 1973); anything
// else is a usage error that names both accepted forms.
//
// DEFAULTS LIVE HERE, not in the citty argument definitions: `--limit` defaults
// to 100 and `--order` to "desc", so the command, a test calling the parser and
// `--help`'s description all read the same number.

import type { LogOrder } from "../../../log/index.ts";
import { isLogLevel, LOG_LEVELS, type LogLevel } from "../../../log/types.ts";

/** How many records the CLI shows when `--limit` is not given. */
export const DEFAULT_LOGS_LIMIT = 100;

/** The order the CLI answers in when `--order` is not given (newest first). */
export const DEFAULT_LOGS_ORDER: LogOrder = "desc";

/** The usage line the default query answers an invalid argument with. */
export const LOGS_USAGE = "rolebox logs [options]";

/** The usage line `rolebox logs files` answers an invalid argument with. */
export const LOGS_FILES_USAGE = "rolebox logs files [--log-dir <path>]";

/** The usage line `rolebox logs prune` answers an invalid argument with. */
export const LOGS_PRUNE_USAGE =
  "rolebox logs prune [--days <n>] [--keep <n>] [--max-total-bytes <n>] [--dry-run] [--log-dir <path>]";

/** How many milliseconds one unit of a relative time is worth. */
const DURATION_MS: ReadonlyMap<string, number> = new Map([
  ["s", 1_000],
  ["m", 60_000],
  ["h", 3_600_000],
  ["d", 86_400_000],
  ["w", 604_800_000],
]);

/**
 * The smallest all-digit value read as epoch MILLISECONDS (1973-03-03). Below
 * it an all-digit value is ambiguous — seconds and minutes are both plausible
 * readings — so it is rejected instead of guessed.
 */
const MIN_EPOCH_MS = 100_000_000_000;

/**
 * An argument the command cannot honour. The command owns the usage line, so
 * this error carries only the reason: `Error: <message>` then `Usage: <line>`.
 */
export class LogsUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogsUsageError";
  }
}

/** The parsed form of the default query's arguments. */
export interface LogsQueryArgs {
  /** An explicit directory; `undefined` lets ROLEBOX_LOG_DIR and its fallbacks decide. */
  readonly logDir?: string;
  /** The LOWEST level to show: warn shows warn, error and fatal, like ROLEBOX_LOG_LEVEL. */
  readonly minLevel?: LogLevel;
  /** Only these channels (exact match); `undefined` keeps every channel. */
  readonly channels?: readonly string[];
  /** Only these event codes (exact match); a record without a code never matches. */
  readonly codes?: readonly string[];
  /** Only records whose scope carries this graphId. */
  readonly graphId?: string;
  /** Only records whose scope carries this sessionId. */
  readonly sessionId?: string;
  /** Only records at or after this epoch-millisecond time. */
  readonly sinceMs?: number;
  /** Only records at or before this epoch-millisecond time. */
  readonly untilMs?: number;
  /** Case-insensitive substring, looked for in message, channel, code and field values. */
  readonly text?: string;
  /** How many records to show (default {@link DEFAULT_LOGS_LIMIT}). */
  readonly limit: number;
  /** Newest first ("desc", the default) or oldest first ("asc"). */
  readonly order: LogOrder;
  /** Write one raw JSON record per line instead of the human line. */
  readonly json: boolean;
  /** Stream new records instead of answering once. */
  readonly follow: boolean;
}

/** The parsed form of `rolebox logs files`. */
export interface LogsFilesArgs {
  /** An explicit directory; `undefined` lets the read layer resolve the default. */
  readonly logDir?: string;
}

/** The parsed form of `rolebox logs prune`. */
export interface LogsPruneArgs {
  /** An explicit directory; `undefined` lets the read layer resolve the default. */
  readonly logDir?: string;
  /** Only consider rotated copies at least this many days old (by mtime). */
  readonly days?: number;
  /** How many rotated copies to KEEP per channel; `undefined` uses the writer's retention. */
  readonly keep?: number;
  /**
   * A byte budget for the whole source: after the two gates above, the oldest
   * surviving rotated copies go until every log file left fits in this many
   * bytes. `undefined` leaves the disk footprint unbounded.
   */
  readonly maxTotalBytes?: number;
  /** Report what would be removed and remove nothing. */
  readonly dryRun: boolean;
}

/** Parse one `--since`-style value; `undefined` for a value this build rejects. */
export function parseLogTime(value: string, now: number): number | undefined {
  const text = value.trim();
  if (text.length === 0) return undefined;
  const relative = /^(\d+(?:\.\d+)?)([smhdw])$/.exec(text);
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unit = DURATION_MS.get(relative[2] ?? "");
    if (Number.isFinite(amount) && unit !== undefined) return Math.round(now - amount * unit);
    return undefined;
  }
  if (/^\d+$/.test(text)) {
    const millis = Number(text);
    return Number.isFinite(millis) && millis >= MIN_EPOCH_MS ? millis : undefined;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** One argument's raw value, as citty hands it over. */
function raw(args: Record<string, unknown>, name: string): unknown {
  return args[name];
}

/**
 * A required-value string argument. `undefined` when the flag was not given; a
 * usage error when it was given without a value (citty hands that over as an
 * empty string), because "the flag is there but empty" is a typo, not a filter.
 */
function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = raw(args, name);
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) throw new LogsUsageError(`--${name} needs a value`);
    return trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (parts.length === 0) throw new LogsUsageError(`--${name} needs a value`);
    return parts.join(",");
  }
  throw new LogsUsageError(`--${name} needs a value`);
}

/** A comma-separated list argument (`--channel a,b`), trimmed and de-blanked. */
function listArg(args: Record<string, unknown>, name: string): string[] | undefined {
  const text = stringArg(args, name);
  if (text === undefined) return undefined;
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) throw new LogsUsageError(`--${name} needs at least one value`);
  return parts;
}

/** A numeric argument, rejected unless it is finite, in range and (when asked) whole. */
function numberArg(
  args: Record<string, unknown>,
  name: string,
  limits: { readonly min: number; readonly integer: boolean },
): number | undefined {
  const text = stringArg(args, name);
  if (text === undefined) return undefined;
  const parsed = Number(text);
  const shape = limits.integer ? "a whole number" : "a number";
  if (!Number.isFinite(parsed)) throw new LogsUsageError(`--${name} must be ${shape} (got "${text}")`);
  if (limits.integer && !Number.isInteger(parsed)) throw new LogsUsageError(`--${name} must be ${shape} (got "${text}")`);
  if (parsed < limits.min) throw new LogsUsageError(`--${name} must be at least ${limits.min} (got "${text}")`);
  return parsed;
}

/** A boolean flag: true only when the caller actually asked for it. */
function booleanArg(args: Record<string, unknown>, name: string): boolean {
  return raw(args, name) === true;
}

/**
 * Parse the default query's arguments. Every rejection is a
 * {@link LogsUsageError}; nothing here touches the file system or the clock
 * beyond the `now` the caller passes for a relative `--since`/`--until`.
 */
export function parseLogsQueryArgs(args: Record<string, unknown>, now: number): LogsQueryArgs {
  const levelText = stringArg(args, "level");
  let minLevel: LogLevel | undefined;
  if (levelText !== undefined) {
    const normalized = levelText.toLowerCase();
    if (!isLogLevel(normalized)) {
      throw new LogsUsageError(`--level must be one of ${LOG_LEVELS.join(", ")} (got "${levelText}")`);
    }
    minLevel = normalized;
  }

  const orderText = stringArg(args, "order");
  const order = orderText === undefined ? DEFAULT_LOGS_ORDER : orderText.toLowerCase();
  if (order !== "asc" && order !== "desc") {
    throw new LogsUsageError(`--order must be asc or desc (got "${orderText ?? ""}")`);
  }

  const limit = numberArg(args, "limit", { min: 0, integer: true }) ?? DEFAULT_LOGS_LIMIT;

  const sinceText = stringArg(args, "since");
  const sinceMs = sinceText === undefined ? undefined : parseLogTime(sinceText, now);
  if (sinceText !== undefined && sinceMs === undefined) {
    throw new LogsUsageError(
      `--since must be a duration (10s, 10m, 2h, 1d, 1w), an ISO 8601 time, or epoch milliseconds (got "${sinceText}")`,
    );
  }
  const untilText = stringArg(args, "until");
  const untilMs = untilText === undefined ? undefined : parseLogTime(untilText, now);
  if (untilText !== undefined && untilMs === undefined) {
    throw new LogsUsageError(
      `--until must be a duration (10s, 10m, 2h, 1d, 1w), an ISO 8601 time, or epoch milliseconds (got "${untilText}")`,
    );
  }
  if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) {
    throw new LogsUsageError("--since is later than --until, so no record can match both");
  }

  return {
    logDir: stringArg(args, "log-dir"),
    minLevel,
    channels: listArg(args, "channel"),
    codes: listArg(args, "code"),
    graphId: stringArg(args, "graph"),
    sessionId: stringArg(args, "session"),
    sinceMs,
    untilMs,
    text: stringArg(args, "text"),
    limit,
    order,
    json: booleanArg(args, "json"),
    follow: booleanArg(args, "follow"),
  };
}

/** Parse `rolebox logs files`' arguments. */
export function parseLogsFilesArgs(args: Record<string, unknown>): LogsFilesArgs {
  return { logDir: stringArg(args, "log-dir") };
}

/** Parse `rolebox logs prune`' arguments. */
export function parseLogsPruneArgs(args: Record<string, unknown>): LogsPruneArgs {
  return {
    logDir: stringArg(args, "log-dir"),
    days: numberArg(args, "days", { min: 0, integer: false }),
    keep: numberArg(args, "keep", { min: 0, integer: true }),
    // Whole bytes: a fractional budget is a typo, and 0 is legal ("keep as
    // little as the active files allow") even though it usually cannot be met.
    maxTotalBytes: numberArg(args, "max-total-bytes", { min: 0, integer: true }),
    dryRun: booleanArg(args, "dry-run"),
  };
}
