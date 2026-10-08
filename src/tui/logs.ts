/**
 * The TUI's LIVE LOG VIEW state machine — cursor, bounded buffer, filters.
 *
 * Pure logic in the shape this module's siblings already use: no SolidJS, no
 * OpenTUI, no timers. A {@link LogsStore} holds one string between polls (the
 * cursor {@link readLogView} returned last) and one bounded array of records;
 * the sidebar calls {@link pollLogsStore} from its EXISTING 1s refresh, so the
 * Logs view adds no second timer and no second cadence to the TUI.
 *
 * WHY A CURSOR AND NOT A RE-READ. `readLogView` answers "what came after this
 * watermark" and never repeats a delivered record — see the module comment on
 * src/log/view.ts for the full contract. This module keeps that promise
 * mechanically: a first poll sends NO cursor (the newest window), every later
 * poll sends the previous answer's cursor and APPENDS what came after it. A
 * poll therefore costs one incremental scan, never a full re-read, and no
 * record is painted twice or skipped.
 *
 * THE FOUR THINGS THIS MODULE OWNS
 *
 *   • BOUNDED BUFFER. The sidebar is 40 cells wide and minutes long; the stream
 *     is unbounded. The buffer keeps the newest {@link BUFFER_LIMIT} records and
 *     REPORTS how many the cap dropped (`dropped`), because a silently
 *     shortened history reads as "that is all there was". Losses of the views
 *     this one replaced are carried in `totalDropped`: the two counters are
 *     DISJOINT, so a reader that adds them gets the lifetime total and never a
 *     doubled loss.
 *   • PAUSE / RESUME that costs nothing. Pausing freezes the cursor AND stops
 *     the read: a frozen poll answers immediately with `skipped: true` and
 *     touches no file, so a hidden tab costs no I/O at all. The cursor does not
 *     move, so the window the pause withheld is delivered — never discarded — by
 *     the first poll after Resume, and nothing shown before the pause leaves the
 *     buffer. Paused is the STORE's flag or the CALLER's (`hostPaused`) — the
 *     host view switch freezes the pane exactly like the Pause key does.
 *   • VIEW IDENTITY. Level threshold, channel filter, session filter and the
 *     resolved source path are one identity string ({@link logsIdentity}).
 *     Changing any of them starts a NEW view: the cursor names a position in
 *     the OLD stream and the buffer holds records the new filter excludes, so
 *     both are cleared together. That reset is the only operation that discards
 *     what is on screen.
 *   • FAILURE IS A STATE, NOT AN EXCEPTION. A read that throws for a reason
 *     `readLogView` did not absorb becomes an `error` on the result: the last
 *     good buffer stays on screen, the cursor does not move (so nothing is
 *     skipped), and the next successful poll clears the error.
 *
 * @module
 */

import { LOG_LEVELS, LOG_LEVEL_RANK, type LogLevel, type LogRecord } from "../log/types.ts";
import { readLogView, type LogViewQuery, type LogViewResult } from "../log/view.ts";
import { resolveLogSource, type LogSource } from "../log/read.ts";

/** The five level words, in rank order. Re-exported so the TUI imports one module. */
export const LOGS_LEVELS: readonly LogLevel[] = LOG_LEVELS;

/**
 * The default level threshold. `info` matches the kernel's own file gate
 * (`ROLEBOX_LOG_LEVEL`), so the pane shows what the file holds before the user
 * narrows it.
 */
export const DEFAULT_LOGS_MIN_LEVEL: LogLevel = "info";

/**
 * The most records the buffer keeps.
 *
 * A log view is watched for minutes and nothing about the stream is bounded by
 * nature, so the buffer is: the newest {@link BUFFER_LIMIT} records stay, the
 * oldest are dropped and counted. 500 is what the dsh web panel keeps, so both
 * live surfaces of the same source answer the same question the same way.
 */
export const BUFFER_LIMIT = 500;

/**
 * How many records one poll asks for.
 *
 * The view widens a window to hold a whole timestamp group, so a burst can
 * answer with a few more than this; a poll that comes back `truncated` is
 * drained by the next poll from the cursor the answer returned, which is why
 * this can stay small next to the buffer.
 */
export const POLL_LIMIT = 200;

/** The filter and source identity of one view. */
export interface LogsFilters {
  /** Show records at or above this level; also sent to the reader. */
  readonly minLevel: LogLevel;
  /**
   * Restrict to these channels. An empty list means every channel — the filter
   * is CLEARED, not "show nothing", which is the same convention LogQuery uses.
   */
  readonly channels: readonly string[];
  /** Restrict to this session's records; `""` means every session. */
  readonly sessionId: string;
  /**
   * Where to read. `""` follows the writer's own chain (ROLEBOX_LOG_FILE, then
   * ROLEBOX_LOG_DIR and its fallbacks) exactly as `rolebox logs` does.
   */
  readonly logDir: string;
}

/** The filters a store starts with: every channel, every session, the writer's chain. */
export const DEFAULT_LOGS_FILTERS: LogsFilters = {
  minLevel: DEFAULT_LOGS_MIN_LEVEL,
  channels: [],
  sessionId: "",
  logDir: "",
};

/**
 * The bounded record buffer: the newest records plus what the cap dropped.
 *
 * `records` is in DELIVERY order (oldest first): the first paint's window as the
 * reader ordered it, then everything appended after it. The renderer walks it
 * backwards, so "newest at the bottom" is a rendering choice rather than
 * something the buffer has to reverse.
 */
export interface LogsBuffer {
  readonly records: readonly LogRecord[];
  /** How many records the cap dropped from the FRONT of the CURRENT view. */
  readonly dropped: number;
  /**
   * How many records every view BEFORE this one dropped (carried across resets).
   *
   * THE TWO COUNTERS ARE DISJOINT, and that is the whole contract:
   * `dropped + totalDropped` is every record the cap has ever discarded, so a
   * reader that adds them — the pane's status line does — never counts one loss
   * twice. {@link resetLogsStore} is the only writer: it absorbs what the view
   * being closed dropped and restarts `dropped` at zero; {@link appendLogsRecords}
   * never touches this field.
   *
   * An operator who narrows the view and comes back needs to see that history
   * was discarded by their own action, not that the stream was short — the same
   * reason `dropped` is reported rather than hidden.
   */
  readonly totalDropped: number;
}

/** A read that failed outside the reader's own tolerance. */
export interface LogsError {
  /** The message of whatever was thrown, as text. */
  readonly message: string;
  /** When the failed poll ran (epoch millis). */
  readonly time: number;
}

/**
 * One poll's outcome.
 *
 * `records` is the APPENDED slice (empty while paused), while `buffer` is the
 * whole new state — a caller that keeps the store can ignore both and read
 * {@link LogsStore.buffer}; a caller that drives a signal wants the buffer.
 */
export interface LogsPollResult {
  readonly buffer: LogsBuffer;
  readonly cursor: string;
  /** Records this poll appended; empty while paused or on error. */
  readonly records: readonly LogRecord[];
  /** Malformed lines the reader skipped in THIS answer. */
  readonly skippedLines: number;
  /** True when the answer held more than `limit` records; poll again to drain. */
  readonly truncated: boolean;
  /** The location the read ACTUALLY used, or `null` before the first answer. */
  readonly source: LogSource | null;
  /** Set when the read threw; `null` when the poll succeeded. */
  readonly error: LogsError | null;
  /** True when this poll reset the view (identity changed) before reading. */
  readonly reset: boolean;
  /** True when nothing was read: the store is paused. */
  readonly skipped: boolean;
}

/**
 * The store a caller holds. `identity` is the frozen view identity the current
 * cursor and buffer belong to; it is compared on every poll, so a filter change
 * made anywhere upstream resets the view without the caller having to announce
 * it.
 */
export interface LogsStore {
  /**
   * The read/clock seam this store polls through. It lives on the store (not on
   * each call) so a store built for a test — or for a future remote source —
   * keeps reading through it for its whole life, and every state transition in
   * this module carries it forward unchanged.
   */
  readonly reader: LogsReader;
  readonly filters: LogsFilters;
  readonly identity: string;
  readonly cursor: string;
  readonly buffer: LogsBuffer;
  /** Records the last successful answer could not deliver yet (`truncated`). */
  readonly pending: boolean;
  /** Malformed lines counted by the last answer. */
  readonly skippedLines: number;
  readonly source: LogSource | null;
  readonly error: LogsError | null;
  readonly paused: boolean;
  /**
   * True while the stream is frozen. Set by the Pause key AND by an unpaused
   * store on the first poll a paused host asked for, so both pauses behave
   * identically: the read stops, delivery stops, the cursor holds still.
   */
  readonly frozen: boolean;
  /**
   * The position the stream stopped at. {@link LogsStore.cursor} is left alone
   * while frozen so a surface reading only `cursor` still shows where the pane
   * actually stopped; the resume adopts THIS value and re-reads from it.
   */
  readonly frozenCursor: string;
  /** The buffer as it stood when the stream froze. */
  readonly frozenBuffer: LogsBuffer;
  /** The pending flag as it stood when the stream froze. */
  readonly frozenPending: boolean;
}

/** The buffer a fresh (or reset) view starts from. */
export const EMPTY_LOGS_BUFFER: LogsBuffer = { records: [], dropped: 0, totalDropped: 0 };

/** The seam a test injects: the read, the clock and the cursor in one object. */
export interface LogsReader {
  readonly read: (query: LogViewQuery) => LogViewResult;
  readonly now: () => number;
}

/** The production seam: the platform's own view source and the wall clock. */
export const LOGS_READER: LogsReader = { read: readLogView, now: () => Date.now() };

/** Options for {@link createLogsStore}. */
export interface LogsStoreOptions {
  /** The view's initial filters; omitted fields fall back to the defaults. */
  readonly filters?: Partial<LogsFilters>;
  /** Override the read/clock seam (tests, a future remote source). */
  readonly reader?: LogsReader;
  /** Start paused. */
  readonly paused?: boolean;
}

/**
 * The identity string of one view: everything that makes a cursor and a buffer
 * meaningless when it changes.
 *
 * `source` is the RESOLVED location rather than the raw `logDir`, so a store
 * that follows the environment notices ROLEBOX_LOG_DIR/ROLEBOX_LOG_FILE moving
 * under it and resets, instead of appending records from a different file into
 * one history. Resolution never throws and never touches the disk.
 */
export function logsIdentity(filters: LogsFilters): string {
  const resolved = filters.logDir.length > 0 ? filters.logDir : resolveLogSource().path;
  return [
    `level=${filters.minLevel}`,
    `channels=${[...filters.channels].join(",")}`,
    `session=${filters.sessionId}`,
    `source=${resolved}`,
  ].join("|");
}

/** The view modes the Logs tab can be in. */
export type LogsViewMode = "hidden" | "open" | "paused";

/** True when the mode shows live records (open, not frozen). */
export function isLogsViewOpen(mode: LogsViewMode): boolean {
  return mode === "open";
}

/** The one-word status of a mode, for a header or a collapsed line. */
export function logsModeText(mode: LogsViewMode): string {
  if (mode === "paused") return "paused";
  if (mode === "open") return "live";
  return "hidden";
}

/** The colour KEY a level renders with; the component maps it to a theme colour. */
export function logsLevelColor(level: LogLevel): "error" | "warning" | "info" | "textMuted" {
  if (level === "fatal" || level === "error") return "error";
  if (level === "warn") return "warning";
  if (level === "debug") return "textMuted";
  return "info";
}

/** The message text that goes with {@link logsLevelColor}. */
export function logsLevelText(level: LogLevel): string {
  return `level ${level}`;
}

/**
 * The two drop counters a status line renders, read from ONE buffer.
 *
 * THEY ARE DISJOINT by construction (see {@link LogsBuffer}): `dropped` is the
 * view on screen and `earlierDropped` is the views it replaced, so their sum is
 * the lifetime total. Two overlapping counters once made this pane print
 * `7 dropped (7 earlier)` for seven records — the same loss reported twice — so
 * the mapping is one named function rather than an assignment per call site.
 */
export interface LogsDropCounts {
  /** Records the cap dropped in the view on screen (since the last reset). */
  readonly dropped: number;
  /** Records the cap dropped in the views before it (carried across resets). */
  readonly earlierDropped: number;
}

/**
 * THE PRODUCTION MAPPING from a buffer to the counters the pane prints: the
 * wiring and the status line both go through here, so a test can drive a real
 * store and assert the very line an operator would read.
 */
export function logsDropCounts(buffer: LogsBuffer): LogsDropCounts {
  return { dropped: buffer.dropped, earlierDropped: buffer.totalDropped };
}

/** The counters a status line renders. */
export interface LogsStatusCounts {
  /** Records the free-text filter matched out of the buffer. */
  readonly shown: number;
  /** Records the buffer holds, matching or not. */
  readonly total: number;
  /** Records the cap dropped since the last reset. */
  readonly dropped: number;
  /** Records the cap dropped before the last reset. */
  readonly earlierDropped: number;
  /** True when the last answer held more records than one poll delivers. */
  readonly pending: boolean;
  /** Malformed lines the reader skipped in the last answer. */
  readonly skippedLines: number;
}

/**
 * The pane's status line: `12/500 records · 3 dropped · 2 skipped · more waiting`.
 *
 * It always leads with the record count, so the line is never empty, and only
 * mentions a loss or a backlog when there is one — a pane that prints `0
 * dropped` forever teaches the reader to stop reading that part of the line.
 */
export function logsStatusText(counts: LogsStatusCounts | LogsViewMode): string {
  if (typeof counts === "string") return logsModeText(counts);
  const parts = [`${counts.shown}/${counts.total} records`];
  // The counters are disjoint (logsDropCounts), so this sum is the lifetime
  // total: the pair below names both halves, the single number is everything.
  const dropped = counts.dropped + counts.earlierDropped;
  if (counts.earlierDropped > 0) parts.push(`${counts.dropped} dropped (${counts.earlierDropped} earlier)`);
  else if (dropped > 0) parts.push(`${dropped} dropped`);
  if (counts.skippedLines > 0) parts.push(`${counts.skippedLines} skipped`);
  if (counts.pending) parts.push("more waiting");
  return parts.join(" · ");
}

/** A non-blank string, or `""`. */
function text(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value : "";
}

/** A level word, or the fallback for anything this build does not know. */
function level(value: unknown, fallback: LogLevel): LogLevel {
  return typeof value === "string" && value in LOG_LEVEL_RANK ? (value as LogLevel) : fallback;
}

/** Normalise a partial filter set into a complete, comparable one. */
export function normalizeLogsFilters(patch?: Partial<LogsFilters>): LogsFilters {
  const channels = Array.isArray(patch?.channels)
    ? patch.channels.filter((channel): channel is string => typeof channel === "string" && channel.length > 0)
    : [];
  return {
    minLevel: level(patch?.minLevel, DEFAULT_LOGS_MIN_LEVEL),
    channels: [...new Set(channels)],
    sessionId: text(patch?.sessionId),
    logDir: text(patch?.logDir),
  };
}

/**
 * A fresh store for one view.
 *
 * A store starts EMPTY and unpolled: it has no cursor, no records and no source
 * until the first {@link pollLogsStore} — the caller's own refresh cadence is
 * what decides when the first paint happens, so this constructor starts no work
 * and touches no file.
 */
export function createLogsStore(options?: LogsStoreOptions): LogsStore {
  const filters = normalizeLogsFilters(options?.filters);
  return {
    reader: options?.reader ?? LOGS_READER,
    filters,
    identity: logsIdentity(filters),
    cursor: "",
    buffer: EMPTY_LOGS_BUFFER,
    pending: false,
    skippedLines: 0,
    source: null,
    error: null,
    paused: options?.paused === true,
    frozen: options?.paused === true,
    frozenCursor: "",
    frozenBuffer: EMPTY_LOGS_BUFFER,
    frozenPending: false,
  };
}

/** A message from whatever a read threw. */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  const rendered = String(error);
  return rendered.length > 0 ? rendered : "log read failed";
}

/**
 * The query one poll sends: the cursor in hand (omitted for a first paint), the
 * active filters, and `asc` — a live pane reads forward in time, so the windows
 * concatenate into one full read in write order.
 */
export function logsQuery(store: LogsStore): LogViewQuery {
  const filters = store.filters;
  // Built in ONE expression and never mutated: LogViewQuery's fields are
  // readonly, and a query that is assembled by assignment would only type-check
  // by widening the reader's own contract.
  return {
    limit: POLL_LIMIT,
    order: "asc",
    minLevel: filters.minLevel,
    // An empty filter is OMITTED rather than sent as "": the reader's own
    // convention is that a blank string is no filter at all, and omitting keeps
    // the query — which a test can read — the exact set of narrowings in force.
    ...(store.cursor.length > 0 ? { cursor: store.cursor } : {}),
    ...(filters.channels.length > 0 ? { channels: filters.channels } : {}),
    ...(filters.sessionId.length > 0 ? { sessionId: filters.sessionId } : {}),
    ...(filters.logDir.length > 0 ? { logDir: filters.logDir } : {}),
  };
}

/** Turn one successful read into the poll outcome it implies. */
function outcomeOf(store: LogsStore, result: LogViewResult, reset: boolean): LogsPollResult {
  const buffer = appendLogsRecords(store.buffer, result.records);
  return {
    buffer,
    cursor: result.cursor,
    records: result.records,
    skippedLines: result.skippedLines,
    truncated: result.truncated,
    source: result.source,
    error: null,
    reset,
    skipped: false,
  };
}

/**
 * Read once and answer what the store becomes.
 *
 * THE ORDER OF OPERATIONS IS THE CONTRACT: resolve the identity (and reset the
 * view when it moved) BEFORE reading, so the read is made with the new filters
 * and the cursor it returns belongs to them; freeze the cursor when paused,
 * so a paused poll can never advance past a record it did not show.
 */
/** Options for {@link pollLogsStore}. */
export interface LogsPollOptions {
  /**
   * True when the CALLER's surface is not delivering: a hidden tab, a collapsed
   * pane. It freezes the stream exactly like the store's own pause flag.
   */
  readonly hostPaused?: boolean;
  /** One poll's read/clock override; defaults to the store's own seam. */
  readonly reader?: LogsReader;
}

export interface LogsPollOutcome {
  /** The store the caller must keep for the next poll. */
  readonly store: LogsStore;
  /** What this poll did, for a caller that renders the result. */
  readonly result: LogsPollResult;
}

export function pollLogsStore(
  store: LogsStore,
  options?: LogsPollOptions,
): LogsPollOutcome {
  // The store's own seam is the default; the option is the per-call override a
  // test uses to drive one poll into the failure path.
  const reader = options?.reader ?? store.reader;
  const identity = logsIdentity(store.filters);
  const reset = identity !== store.identity;
  const base: LogsStore = reset ? { ...resetLogsStore(store), identity } : store;

  const frozen = base.paused || options?.hostPaused === true;
  // The freeze marker is written on the first paused poll: the cursor that
  // belongs to the paused window is the one the NEXT unpaused poll must resume
  // from, and the store's own `cursor` field is left untouched until then, so a
  // host that renders a paused store shows the position it actually stopped at.
  const frozenBase: LogsStore = frozen && !base.frozen
    ? { ...base, frozen: true, frozenCursor: base.cursor, frozenBuffer: base.buffer, frozenPending: base.pending }
    : base;

  // FROZEN MEANS NO READ AT ALL. The cursor already names the position the
  // stream stopped at, so a frozen poll has nothing to learn: what it would read
  // is withheld, not lost, and delivered by the first poll after Resume; a
  // window nobody is looking at cannot make a counter more honest. What the read
  // WOULD cost is a full scan of the log directory on every tick — including the
  // ticks of the Activity view, where the Logs pane is hidden — which is exactly
  // the I/O a live sidebar must not spend on a surface the reader cannot see.
  // The store is answered unchanged — the SAME object while nothing else moved —
  // so a caller that publishes on identity publishes nothing at all.
  if (frozen) {
    return {
      store: frozenBase,
      result: {
        buffer: frozenBase.buffer,
        cursor: frozenBase.cursor,
        records: [],
        skippedLines: frozenBase.skippedLines,
        truncated: frozenBase.pending,
        source: frozenBase.source,
        error: frozenBase.error,
        reset,
        skipped: true,
      },
    };
  }

  let result: LogViewResult;
  try {
    result = reader.read(logsQuery(frozenBase));
  } catch (error) {
    const failure: LogsStore = { ...frozenBase, error: { message: messageOf(error), time: reader.now() } };
    return {
      store: failure,
      result: {
        buffer: failure.buffer,
        cursor: failure.cursor,
        records: [],
        skippedLines: failure.skippedLines,
        truncated: failure.pending,
        source: failure.source,
        error: failure.error,
        reset,
        skipped: false,
      },
    };
  }

  // A resume: adopt the buffer and cursor frozen at the pause, then append the
  // window the pause withheld — the cursor never moved, so nothing is lost.
  const resumed: LogsStore = base.frozen
    ? { ...base, frozen: false, frozenCursor: "", frozenBuffer: EMPTY_LOGS_BUFFER, frozenPending: false }
    : base;
  const outcome = outcomeOf(resumed, result, reset);
  const next: LogsStore = {
    ...resumed,
    cursor: outcome.cursor,
    buffer: outcome.buffer,
    pending: result.truncated,
    skippedLines: result.skippedLines,
    source: result.source,
    error: null,
  };
  return { store: next, result: outcome };
}

/** Set the store's own pause flag, freezing/unfreezing the cursor as it moves. */
export function setLogsPaused(store: LogsStore, paused: boolean): LogsStore {
  if (paused === store.paused) return store;
  if (paused) {
    return { ...store, paused: true, frozen: true, frozenCursor: store.cursor, frozenBuffer: store.buffer, frozenPending: store.pending };
  }
  // Resume: the frozen cursor is the position the stream stopped at, so the next
  // poll re-reads from it and appends everything the pause skipped.
  return {
    ...store,
    paused: false,
    frozen: false,
    cursor: store.frozenCursor,
    buffer: store.frozenBuffer,
    pending: store.frozenPending,
    frozenCursor: "",
    frozenBuffer: EMPTY_LOGS_BUFFER,
    frozenPending: false,
  };
}

/** Flip the pause flag. */
export function toggleLogsPaused(store: LogsStore): LogsStore {
  return setLogsPaused(store, !store.paused);
}

/**
 * Change the view's filters. Fields the patch omits keep their current value —
 * including `channels`, which is replaced only when the caller names it, so
 * `setLogsFilters(store, { minLevel: "warn" })` is a threshold change and not a
 * silent channel clear.
 *
 * THE VIEW RESETS HERE, IMMEDIATELY, and not at the next poll. A cursor names a
 * position in the OLD stream and the buffer holds records the NEW filter
 * excludes, so keeping either would leave records on screen that the filter the
 * pane is advertising says are hidden — the pane would print `level warn` above
 * an `info` row until the next tick. {@link pollLogsStore} still watches the
 * identity and resets if a filter moved behind its back (an effect that sets the
 * session, a caller that rebuilds the store), so this is the fast path and not
 * the only one.
 */
export function setLogsFilters(store: LogsStore, patch: Partial<LogsFilters>): LogsStore {
  const merged = normalizeLogsFilters({ ...store.filters, ...patch });
  const identity = logsIdentity(merged);
  // An unchanged identity keeps the buffer and the cursor — the filters are
  // still re-normalised into the store (a caller may set the same value in a
  // different spelling), but there is no new stream to start.
  const next = { ...store, filters: merged };
  return identity === store.identity ? next : resetLogsStore(next);
}

/**
 * Raise or lower the level threshold by one rank, clamped at both ends.
 * `direction` of +1 is stricter (toward `fatal`), -1 is more permissive.
 */
export function stepLogsLevel(store: LogsStore, direction: number): LogsStore {
  const current = LOG_LEVEL_RANK[store.filters.minLevel] ?? 0;
  const next = Math.max(0, Math.min(LOG_LEVELS.length - 1, current + (direction >= 0 ? 1 : -1)));
  const word = LOG_LEVELS[next];
  if (word === undefined || word === store.filters.minLevel) return store;
  return setLogsFilters(store, { minLevel: word });
}

/** Keep exactly `channel` as the only channel filter; `""` clears the filter. */
export function setLogsChannel(store: LogsStore, channel: string): LogsStore {
  return setLogsFilters(store, { channels: channel.length > 0 ? [channel] : [] });
}

/** Keep exactly `sessionId`; `""` clears the filter. */
export function setLogsSession(store: LogsStore, sessionId: string): LogsStore {
  return setLogsFilters(store, { sessionId });
}

/**
 * Move to the next channel in `channels`, or clear the filter at the end.
 *
 * The cycle is "each channel once, then everything", and the current filter is
 * found by exact match — a filter naming a channel that is not in the list
 * restarts the cycle at the first entry rather than silently sticking.
 */
export function cycleLogsChannel(store: LogsStore, channels: readonly string[]): LogsStore {
  const available = channels.filter((channel) => channel.length > 0);
  if (available.length === 0) return store;
  const current = store.filters.channels.length === 1 ? store.filters.channels[0] : undefined;
  const index = current === undefined ? -1 : available.indexOf(current);
  const next = available[index + 1];
  return setLogsChannel(store, next ?? "");
}

/**
 * Start a NEW view: clear the cursor, the buffer and the reported counters.
 *
 * `dropped` restarts because it belongs to the buffer being cleared, while the
 * ledger of everything dropped BEFORE this reset (`totalDropped`) is carried
 * forward — the pane can then say "N dropped, M earlier". The ledger ABSORBS
 * that counter instead of being added on top of it, which is what keeps the two
 * disjoint (see {@link LogsBuffer}).
 *
 * THE FROZEN SNAPSHOT GOES WITH THE VIEW. Changing a filter while paused would
 * otherwise resume into the buffer and cursor of the view the user just left —
 * `setLogsPaused(store, false)` restores exactly what the pause froze, so the
 * new filter would inherit rows it excludes. A reset starts a new stream, so the
 * old stream's frozen position is dropped here as well.
 */
export function resetLogsStore(store: LogsStore): LogsStore {
  return {
    ...store,
    cursor: "",
    // The ledger absorbs exactly what this view dropped and the new view starts
    // at zero: `dropped` and `totalDropped` never overlap (see LogsBuffer).
    buffer: { records: [], dropped: 0, totalDropped: store.buffer.totalDropped + store.buffer.dropped },
    pending: false,
    skippedLines: 0,
    source: null,
    error: null,
    frozenCursor: "",
    frozenBuffer: EMPTY_LOGS_BUFFER,
    frozenPending: false,
  };
}

/**
 * Every channel present in `records`, sorted and de-duplicated.
 *
 * The pane's channel cycle is built from what is actually IN the buffer rather
 * than from a configured list: the TUI reads whichever directory the writer
 * chain resolves, so the honest answer to "what can I filter on" is the set the
 * records themselves carry. An empty answer is a real answer — it means the
 * buffer has nothing to narrow — and the caller clears the filter instead of
 * cycling through nothing.
 */
export function collectLogChannels(records: readonly LogRecord[]): string[] {
  const channels = new Set<string>();
  for (const record of records) {
    if (typeof record.channel === "string" && record.channel.length > 0) channels.add(record.channel);
  }
  return [...channels].sort((left, right) => left.localeCompare(right));
}

/**
 * Append delivered records to a buffer, keeping the newest {@link BUFFER_LIMIT}
 * and counting what falls off the front.
 *
 * `limit` defaults to {@link BUFFER_LIMIT}; it is a parameter only so a test can
 * drive the cap with a handful of records instead of five hundred, and the
 * production caller never passes it.
 *
 * A RECORD IS APPENDED, NEVER COMPARED WITH ITS NEIGHBOUR. The cursor already
 * promises that a delivered record is not delivered twice — the next window
 * starts strictly after the previous watermark — so a "same as the last one"
 * guard cannot catch a repeat. The only thing it CAN catch is a record that
 * really happened twice: two identical lines inside one millisecond in one
 * channel, which nothing in a record distinguishes (no id, no sequence) and
 * which a guard would hide with no counter to report it — the silent loss this
 * module's counters exist to prevent. What arrives is kept.
 *
 * IT DOES NOT TOUCH THE EARLIER-VIEW LEDGER. A cap overflow inside the view on
 * screen is `dropped` alone; `totalDropped` belongs to the views this one
 * replaced, and only {@link resetLogsStore} moves a number into it. Accumulating
 * it here as well is what once made the pane print `7 dropped (7 earlier)` for
 * seven records — the same loss counted twice.
 */
export function appendLogsRecords(
  buffer: LogsBuffer,
  incoming: readonly LogRecord[],
  limit: number = BUFFER_LIMIT,
): LogsBuffer {
  if (incoming.length === 0) return buffer;
  const cap = Math.max(0, Math.floor(limit));
  const records = [...buffer.records];
  let dropped = buffer.dropped;
  for (const record of incoming) {
    records.push(record);
    if (records.length > cap) {
      // Count EXACTLY what left the buffer: the cap is a data-loss report, so
      // the number has to be the number of records, not the number of trims.
      dropped += records.length - cap;
      records.splice(0, records.length - cap);
    }
  }
  return { records, dropped, totalDropped: buffer.totalDropped };
}
