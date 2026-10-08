// ── A pollable view of the log files ────────────────────────────────────────
//
// THE SHARED SOURCE BEHIND EVERY LIVE VIEW. The TUI's Logs pane and the dsh web
// client's log route both want the same thing, over and over: "give me what is
// visible now, then give me everything since the last answer". A follower
// (followLogRecords) is the wrong shape for both — it is push-based, it can only
// start at the current end of the files, and it has no return value to report a
// malformed line or a truncated answer in. A viewer is pull-based and stateless:
// the browser or the TUI holds one string between requests, and the server holds
// nothing at all.
//
// This module is that shape, and it is a thin layer over src/log/read.ts — the
// same scan, the same filters, the same defensive parsing, the same file order.
// It adds exactly one thing the reader does not have: a CURSOR that names a
// position in the record stream, so the next call can answer "what came after
// this" without repeating a record and without skipping one.
//
// THE CURSOR (the contract, in full)
//
//   cursor := "<epoch-millis, zero-padded to 15>" + "." + "<millis, 3 digits>"
//             + "~" + "<how many records share that millisecond>"
//             e.g. "000001791450000.250~7"
//
//   • OPAQUE. Callers store it and hand it back unread; its spelling is this
//     module's business and may change. It is JSON-safe (digits, one ".", one
//     "~", nothing else) and survives a query string, a JSON body or an SSE
//     event field unchanged. Both numbers are zero-padded so that sorting
//     cursors as TEXT sorts them as time. ONLY this spelling is read back
//     (CURSOR_PATTERN): a truncated, hand-edited or foreign value is not a
//     cursor and counts as absent, exactly as the CLI, the route and the docs
//     promise — parseCursor states why leniency would break that promise.
//   • A WATERMARK, not a record id: "everything up to and including the records
//     that carry time T has been delivered". readLogView answers with the
//     records STRICTLY after it, in the reader's own order.
//   • GROUP-ATOMIC. A watermark never lands inside a burst that shares one
//     millisecond: the window is widened (or narrowed) so the cursor sits at the
//     boundary of a timestamp group. That is the whole trick — inside a group
//     the records are indistinguishable from each other, so a cursor that split
//     one could not be resumed without either repeating or losing records. A
//     window can therefore hold a few more than `limit` records when the newest
//     group is large; its exact size is in `records`.
//   • MONOTONIC AND LOSSLESS on one append-only source. The next call with the
//     returned cursor never repeats a delivered record and never skips one that
//     was appended after it: a drained walk holds exactly the records ONE full
//     read returns. The ORDER of that walk is the caller's `order` applied to
//     each window separately, not to the concatenation. Under `asc` (the
//     reader's scan order) the windows therefore concatenate into one full read
//     in that same order, which is what tests/log/view.test.ts pins against
//     `readLogRecords` itself. Under `desc` the walk still moves FORWARD in time
//     (pollWindow proves why it must), so each window reads newest-first while
//     the windows arrive in write order: the same records, no repeat and no gap,
//     but NOT the single descending sequence a full `desc` read produces.
//   • ABSENT means "the newest stretch, as of now": the last `limit` matching
//     records, with `truncated` telling the caller that older records exist
//     behind them. That is the first paint of a viewer, and it is also the
//     watermark's starting point: a viewer shows the recent past once, then
//     moves forward, and never re-delivers what it already painted. When that
//     stretch is EMPTY the watermark is anchored one millisecond BEFORE the read
//     (see firstPaintWatermark), so a record the writer stamps in the same
//     millisecond as the first paint is still delivered by the next poll.
//
// WHY A TIME AND NOT A LINE OFFSET. There is no record number on disk: a record
// is a JSON line and nothing in it is unique — no id, no sequence, and the
// writer timestamps whole milliseconds, so a burst of records routinely shares
// one `time`. A per-file BYTE offset is the obvious alternative and the wrong
// one: a rotation renames the file under it (the offset then points into
// different bytes), and a viewer of several channels would need a different
// offset per file plus a way to order what it read from each. A time watermark is
// one string for the whole source, it survives a restart of the server, and it
// is comparable with any later scan.
//
// WHAT THE CURSOR HONESTLY DOES NOT COVER. A cursor cannot promise a gap-free
// stream through history that no longer exists, and this one does not pretend
// to:
//
//   • ROTATION AND DELETION LOSE A WINDOW. When the writer rotates a file the
//     oldest lines of a channel move into `.1` and beyond, and once a copy falls
//     out of retention (or `pruneLogs` removes it) those records are gone from
//     every future scan. If they were written after the caller's cursor and were
//     never delivered, they are simply never delivered — a viewer shows a gap.
//     Records written AFTER the rotation are still delivered once each, and a
//     delivered record is never delivered twice. The guarantee above is stated
//     for an append-only source, which is what a live viewer watches.
//   • TIME IS THE ORDER, SO A LATE RECORD IS BEHIND THE CURSOR. Records are
//     ordered by `time`, not by arrival. A writer that appends a record whose
//     `time` is at or before the cursor's timestamp (another process with a
//     skewed clock, a backfill, a second write inside a millisecond the viewer
//     already read) lands where a delivered record was and is not delivered
//     again. "No repeats" and "deliver late arrivals" cannot both hold, and a
//     live view needs the first one: re-reading a watermark's own millisecond is
//     exactly what would turn every poll into a duplicate.
//
// NOTHING HERE THROWS. A missing directory, an unreadable file, a destroyed
// line and a nonsense cursor all answer a result: an empty `records`, a `cursor`
// that is safe to pass back, and `skippedLines` counted exactly as the reader
// counts it. `source` is always the location the read actually used — resolved
// once, through the reader's own {@link resolveLogSource}, and never a guess
// (Stage 3a's lesson: the printed location must be the read location).

import { DEFAULT_LOG_QUERY_LIMIT, readLogRecords, resolveLogSource, type LogQuery, type LogSource } from "./read.ts";
import type { LogRecord } from "./types.ts";

/**
 * How many records {@link readLogView} answers with when it does not name a
 * `limit`. The same ceiling `readLogRecords` uses, so a caller that switches
 * from the query API to the view API does not silently change its window.
 */
export const DEFAULT_LOG_VIEW_LIMIT = DEFAULT_LOG_QUERY_LIMIT;

/** The separator between a cursor's timestamp and its occurrence count. */
const CURSOR_SEPARATOR = "~";

/** The timestamp's fractional part is always this many digits, so text order is time order. */
const CURSOR_FRACTION_DIGITS = 3;

/**
 * How many digits the whole seconds are padded to. Epoch milliseconds need 13
 * until the year 2286; 15 leaves room and still fits a double exactly, so a
 * cursor can be compared as text and the padded spelling is what a viewer sorts.
 */
const CURSOR_SECONDS_DIGITS = 15;

/**
 * THE ONE SPELLING THIS MODULE READS BACK. Exactly what {@link formatCursor}
 * writes: at least CURSOR_SECONDS_DIGITS whole digits, a dot, exactly
 * CURSOR_FRACTION_DIGITS fraction digits, the separator, and one or more digits
 * of occurrence. Anything else — a truncated value, a hand-edited one, a value
 * from another source, an empty occurrence, a bare integer, a wrong-width
 * fraction — is NOT a cursor, and {@link parseCursor} answers `undefined` so the
 * caller treats it as absent. {@link parseCursor} states why that strictness is
 * a contract rather than pedantry.
 */
const CURSOR_PATTERN = new RegExp(
  `^(\\d{${CURSOR_SECONDS_DIGITS},})\\.(\\d{${CURSOR_FRACTION_DIGITS}})${CURSOR_SEPARATOR}(\\d+)$`,
);

/** A watermark: a `time` plus the rank (at least 1) the caller has seen at that time. */
interface LogViewCursor {
  /** Epoch milliseconds of the last record the caller has seen. */
  readonly time: number;
  /** How many records carrying exactly `time` the caller has seen (at least 1). */
  readonly occurrence: number;
}

/**
 * What {@link readLogView} accepts: every filter {@link LogQuery} has, plus the
 * cursor. `limit` and `order` keep the meaning the reader gave them.
 */
export interface LogViewQuery extends LogQuery {
  /**
   * The watermark a previous call returned. Omit it for the newest stretch of
   * the source. A value that is not exactly the spelling this module writes
   * (CURSOR_PATTERN) is treated as OMITTED: a viewer that cached a truncation of
   * a cursor, hand-edited one, or kept one from another source re-paints the
   * recent window instead of dying or being pinned to a position nobody
   * delivered. A WELL-FORMED but old cursor is honoured, and the walk continues
   * forward from it.
   */
  readonly cursor?: string;
}

/** What {@link readLogView} answers. */
export interface LogViewResult {
  /** The records after the cursor (or the newest `limit`), filtered and ordered. */
  readonly records: LogRecord[];
  /**
   * Hand this back as `cursor` on the next call to continue where this one
   * stopped. Always a usable cursor, even when `records` is empty: then it is
   * the position just BEFORE the empty answer was taken, so two consecutive
   * empty polls cost nothing and lose nothing, and a record the writer stamps
   * in that same millisecond is not lost either (see firstPaintWatermark).
   */
  readonly cursor: string;
  /** WHERE this answer was actually read from, as the reader resolved it. */
  readonly source: LogSource;
  /**
   * True when more matching records existed than this answer returned. With a
   * cursor those records are waiting at the returned one — call again to drain
   * them. Without a cursor they are the older records BEHIND the window
   * (`readLogView` starts at the newest end), so a first paint that reports
   * `truncated` is telling the caller its window is not the whole story.
   */
  readonly truncated: boolean;
  /** Lines skipped as unusable, counted exactly as `readLogRecords` counts them. */
  readonly skippedLines: number;
}

/**
 * The `cursor` a query carries, or `undefined` for anything unusable.
 *
 * STRICT ON PURPOSE, and the strictness is a contract rather than pedantry: the
 * live surfaces over this view (the dsh web route, the TUI pane and the CLI's
 * follower) all promise that a value they cannot read behaves as if NO cursor
 * had been sent, so a viewer holding a stale, truncated or foreign value
 * re-paints the recent window instead of being pinned somewhere wrong. A lenient
 * parser breaks exactly that promise, and quietly: a value like `"1.5~"` (an
 * empty occurrence) or `"1.5~2"` (a one-digit fraction) still parses as a time
 * near zero, which is a perfectly VALID watermark behind every record — so the
 * view would answer the OLDEST window of the source and walk forward from there
 * while the route and the docs said it would repaint the recent one. Only
 * {@link CURSOR_PATTERN} — the spelling this module writes — is a cursor.
 *
 * A WELL-FORMED cursor is never "too old" to honour: it is a position the caller
 * has seen, and the walk continues forward from it. That is a different case
 * from an unreadable value, and the tests pin them separately.
 *
 * `occurrence` is carried for the operator (and any future reader) who looks at
 * the value; the walk itself compares the timestamp only, because a watermark
 * never splits a timestamp group — see {@link boundedWindow}.
 */
function parseCursor(cursor: unknown): LogViewCursor | undefined {
  if (typeof cursor !== "string") return undefined;
  const match = CURSOR_PATTERN.exec(cursor);
  if (match === null) return undefined;
  const time = Number(`${match[1]}.${match[2]}`);
  if (!Number.isFinite(time) || time < 0) return undefined;
  const occurrence = Number(match[3]);
  if (!Number.isInteger(occurrence) || occurrence < 0) return undefined;
  return { time, occurrence };
}

/**
 * Spell a watermark. The fractional part is padded to a fixed width so that a
 * lexicographic comparison of two cursors agrees with their numeric order (an
 * operator reading a log of cursors, and any future lexicographic shortcut,
 * both depend on that).
 */
function formatCursor(cursor: LogViewCursor): string {
  const whole = Math.floor(cursor.time);
  const fraction = Math.round((cursor.time - whole) * 10 ** CURSOR_FRACTION_DIGITS);
  const seconds = String(whole).padStart(CURSOR_SECONDS_DIGITS, "0");
  const stamp = `${seconds}.${String(fraction).padStart(CURSOR_FRACTION_DIGITS, "0")}`;
  return `${stamp}${CURSOR_SEPARATOR}${cursor.occurrence}`;
}

/**
 * The records a previous call has NOT answered with yet, in the order the reader
 * produced them: STRICTLY newer than the watermark.
 *
 * Strict, because a watermark at time T means every record carrying T has been
 * answered with — see {@link boundedWindow}, which never anchors a cursor inside
 * a timestamp group. That is what makes the rule safe against a writer that
 * appends in the same millisecond the viewer just read: a record at T that
 * arrives later is not distinguishable from a delivered one, and re-delivering
 * the group would be a repeat.
 */
function afterCursor(records: readonly LogRecord[], cursor: LogViewCursor): LogRecord[] {
  return records.filter((record) => record.time > cursor.time);
}

/**
 * The watermark for a window: the position just past the newest record the
 * window contains, spelled as that timestamp plus how many records carry it.
 *
 * `asc` returns the window oldest-first and `desc` newest-first, so a caller
 * cannot read the watermark off the last element — it asks here, and the answer
 * is the window's MAXIMUM timestamp. A timestamp's records are contiguous in the
 * reader's order, so counting the maximum timestamp inside the window counts the
 * whole group; the count is what makes the cursor self-describing to an operator
 * reading it, while {@link afterCursor} only ever compares the timestamp.
 */
function cursorAfter(records: readonly LogRecord[], fallbackTime: number): LogViewCursor {
  const last = lastRecord(records);
  if (last === undefined) return { time: fallbackTime, occurrence: 0 };
  let occurrence = 0;
  for (const record of records) {
    if (record.time === last.time) occurrence += 1;
  }
  return { time: last.time, occurrence };
}

/** The newest record of a window, or `undefined` for an empty one. */
function lastRecord(records: readonly LogRecord[]): LogRecord | undefined {
  let newest: LogRecord | undefined;
  for (const record of records) {
    if (newest === undefined || record.time >= newest.time) newest = record;
  }
  return newest;
}

/**
 * The newest window of a run, with the watermark that continues from it.
 *
 * THE WATERMARK NAMES A WHOLE TIMESTAMP GROUP, and the window never SPLITS the
 * group its edge falls in. The `limit`-th newest record of the run is the EDGE,
 * its timestamp decides where the run is cut, and the window is the whole group
 * at that timestamp — `records.filter(time >= edgeTime)` — so the group is
 * delivered in one piece and the next call can resume with a plain `time >`
 * test. A cursor that landed inside a group could not be resumed exactly (the
 * records behind it look exactly like the records ahead of it).
 *
 * `descending` says which END of the array that edge sits at, because `records`
 * is already in the caller's order: the reader answers `asc` oldest-first and
 * `desc` newest-first (read.ts), so the newest records are the TAIL under `asc`
 * and the HEAD under `desc`. This is the one place a first paint differs between
 * the two orders; the same `time >= edgeTime` filter is right for both, because
 * it always selects from the edge's whole group up to the newest end of the run.
 *
 * A window therefore holds AT LEAST `limit` records and can hold more when a
 * burst shares one millisecond: returning the whole newest group is what keeps
 * the cursor exact, and the caller can see the real size in `records`. A limit
 * of 0 means "no records at all", the one case where a caller asked for none.
 *
 * `fallbackTime` is the watermark to keep when there is no record to name (an
 * empty run, an empty window): a watermark is a position the caller has SEEN, so
 * it must never move to a rank that was not delivered.
 */
function boundedWindow(
  records: readonly LogRecord[],
  limit: number,
  descending: boolean,
  fallbackTime: number,
): { records: LogRecord[]; cursor: LogViewCursor; truncated: boolean } {
  if (limit <= 0) return { records: [], cursor: { time: fallbackTime, occurrence: 0 }, truncated: records.length > 0 };
  if (records.length <= limit) {
    const whole = [...records];
    return { records: whole, cursor: cursorAfter(whole, fallbackTime), truncated: false };
  }
  // The `limit`-th newest record of the run: the tail under `asc`, the head
  // under `desc`.
  const edge = descending ? records[limit - 1] : records[records.length - limit];
  const edgeTime = edge?.time ?? fallbackTime;
  const window = records.filter((record) => record.time >= edgeTime);
  return { records: window, cursor: cursorAfter(window, fallbackTime), truncated: window.length < records.length };
}

/**
 * The window a POLL answers with: the OLDEST `limit` records of the pending run,
 * completed to the whole timestamp group at the walking edge. The run's own order
 * decides how that chunk READS — oldest-first under `asc`, newest-first under
 * `desc` — but not WHICH records it holds.
 *
 * OLDEST IN BOTH ORDERS, and that is forced by the cursor rather than chosen by
 * it: the watermark only ever moves FORWARD in time, so a window that took the
 * NEWEST `limit` records of the pending run would push the watermark past
 * everything between the previous cursor and that window, and those records
 * could never be delivered again — a gap. Taking the oldest chunk is what keeps
 * the no-gap promise. `desc` therefore does not make the walk go backwards: it
 * lists every window newest-first while the windows themselves still arrive in
 * write order. The concatenation of a `desc` walk is thus the record set of one
 * full `desc` read in the same chunking, never the single descending sequence;
 * only the `asc` walk concatenates into one full read in the reader's own order
 * (the module comment states exactly that, and nothing stronger).
 *
 * Either way the window's edge is completed to its whole timestamp group, so the
 * watermark it returns is a boundary the next call can compare against with
 * `time >`; the group straddling the cap is delivered whole, and the window can
 * hold a few more than `limit` records — exactly as {@link boundedWindow}
 * documents for the first paint.
 */
function pollWindow(
  records: readonly LogRecord[],
  limit: number,
  descending: boolean,
  fallbackTime: number,
): { records: LogRecord[]; cursor: LogViewCursor; truncated: boolean } {
  if (limit <= 0) return { records: [], cursor: { time: fallbackTime, occurrence: 0 }, truncated: records.length > 0 };
  if (records.length <= limit) {
    const whole = [...records];
    return { records: whole, cursor: cursorAfter(whole, fallbackTime), truncated: false };
  }
  // The run is sorted in the reader's `order`, so the walking edge is the
  // `limit`-th record from the front under `asc` and from the back under `desc`.
  // The window ENDS at that record — it keeps everything up to and including the
  // edge record's whole timestamp group, so the group is delivered in one piece
  // and the next poll starts strictly after it.
  const edge = descending ? records[records.length - limit] : records[limit - 1];
  const edgeTime = edge?.time ?? fallbackTime;
  const window = records.filter((record) => record.time <= edgeTime);
  return { records: window, cursor: cursorAfter(window, fallbackTime), truncated: window.length < records.length };
}

/** True when the query asks for the reader's descending order. */
function isDescending(query: LogViewQuery): boolean {
  return query.order === "desc";
}

/** The effective window: a finite non-negative `limit`, else the view default. */
function resolveWindowLimit(limit: number | undefined): number {
  if (typeof limit === "number" && Number.isFinite(limit) && limit >= 0) return Math.floor(limit);
  return DEFAULT_LOG_VIEW_LIMIT;
}

/**
 * The watermark an EMPTY first paint answers with: THE INSTANT JUST BEFORE THE
 * READ.
 *
 * Nothing was delivered, so there is no record to name — but the cursor still
 * has to be a position the next call can compare against, and "just before this
 * read" is the only honest one. A record's `time` is epoch MILLISECONDS, so
 * `now - 1` is the latest instant that cannot hold a record this read already
 * saw (there was nothing to see: the window is empty), and it is early enough
 * that a record the writer stamps in the SAME millisecond as this read — the
 * ordinary case for a writer that is already running when a viewer first paints
 * — is still strictly after the watermark and is delivered by the next poll.
 * Anchoring at `now` itself would drop exactly that record, which is the one
 * gap an append-only source must not have.
 *
 * `since` is the caller's own earliest interesting time, an INCLUSIVE bound, so
 * an empty window under it anchors one millisecond before the bound for the
 * same reason: a record stamped AT `since` that appears after this read is
 * still inside the window. The value is clamped at 0, the oldest watermark this
 * spelling can carry, so even a zero clock still answers a parseable cursor.
 */
function firstPaintWatermark(query: LogViewQuery): number {
  const since = query.since;
  const anchor = typeof since === "number" && Number.isFinite(since) && since > 0 ? since : Date.now();
  return Math.max(0, Math.floor(anchor) - 1);
}

/**
 * Read the log files as a pollable view.
 *
 * WITH NO CURSOR the answer is the newest stretch of the source: the `limit`
 * NEWEST matching records — the reader's own order is kept, so they read
 * oldest-first under `asc` and newest-first under `desc` — and `truncated` says
 * older records exist behind them. That window is WIDENED to hold every record
 * sharing its edge timestamp, so it can carry a few more than `limit` records —
 * a burst that shares one millisecond is delivered as one whole group at a time,
 * never split across a cursor. WITH A CURSOR the answer is everything matching
 * after that watermark, in the same order, and `truncated` says more than
 * `limit` such records were waiting — poll again with the returned cursor to
 * drain them, one window at a time, in the order they were written (a cursor
 * walks FORWARD through time: it answers the OLDEST records after the watermark,
 * listed in the caller's `order`, while a first paint answers the NEWEST records
 * of the source).
 *
 * The answer is ALWAYS usable: `source` is the location the read used (an
 * explicit `logDir`/`logFile` beats the environment, through the reader's own
 * resolution), `cursor` is always a parseable watermark to continue from, and a
 * missing directory, an unreadable file, a malformed line or a nonsense cursor
 * changes only the records — never the shape of the result and never an
 * exception. In particular anything that is not the exact spelling this module
 * writes (CURSOR_PATTERN) — a truncated, hand-edited or foreign value — is
 * treated as absent, so a viewer holding an unreadable cursor re-paints the
 * recent window instead of failing. A WELL-FORMED but old cursor is a different
 * case: it is a position the caller has seen, and the walk continues forward
 * from it.
 *
 * A FIRST PAINT IS ALWAYS THE NEWEST RECORDS, whatever `order` says — `desc`
 * only lists them newest-first, it does not move the window to the old end — and
 * `limit` bounds that window in BOTH orders (the edge's timestamp group is
 * delivered whole, so the window can hold a few more than `limit`).
 * Every call re-reads the source: this is a view over files other processes own,
 * not a subscription. History that a rotation or a prune removed cannot be
 * recovered by any cursor — the module comment states what is and is not
 * promised between two polls.
 */
export function readLogView(options?: LogViewQuery): LogViewResult {
  const query = options ?? {};
  // Resolved BEFORE the read, exactly once, so the location in the result is the
  // location the read used and not a second, possibly different resolution.
  const source = resolveLogSource(query);
  const cursor = parseCursor(query.cursor);
  try {
    // The window is a SLICE of the whole matching stream, so the reader must not
    // cap it: an unbounded limit is how a caller asks for the stream itself.
    const all = readLogRecords({ ...query, limit: Number.MAX_SAFE_INTEGER });
    const limit = resolveWindowLimit(query.limit);
    if (cursor === undefined) {
      const window = boundedWindow(all.records, limit, isDescending(query), firstPaintWatermark(query));
      return {
        records: window.records,
        cursor: formatCursor(window.cursor),
        source,
        truncated: window.truncated,
        skippedLines: all.skippedLines,
      };
    }

    // WITH A CURSOR THE ANSWER WALKS FORWARD: the window is the records just
    // after the watermark, so a viewer that keeps polling moves through the
    // stream in order and the cursor only ever advances past records it was just
    // given (see pollWindow for how `order` picks the end of a longer run).
    const pending = afterCursor(all.records, cursor);
    const window = pollWindow(pending, limit, isDescending(query), cursor.time);
    // AN EMPTY ANSWER DOES NOT MOVE THE CURSOR. There is no newly delivered
    // record to name, and a watermark is a position the caller HAS SEEN: moving
    // it to "T with nothing delivered" would claim a position that was never
    // shown, and the next record at T would then look like one already seen.
    const advanced = window.records.length === 0 ? null : cursorAfter(window.records, cursor.time);
    return {
      records: window.records,
      cursor: formatCursor(advanced ?? cursor),
      source,
      truncated: window.truncated,
      skippedLines: all.skippedLines,
    };
  } catch {
    // Reading is a view of files other processes own: a failure degrades to an
    // empty answer the caller can keep polling, never to an exception. The
    // cursor the caller sent comes back unchanged, so a retry loses nothing.
    return {
      records: [],
      cursor: formatCursor(cursor ?? { time: firstPaintWatermark(query), occurrence: 0 }),
      source,
      truncated: false,
      skippedLines: 0,
    };
  }
}
