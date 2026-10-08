/**
 * THE POLLABLE VIEW OVER THE LOG FILES.
 *
 * Every case builds its data in a temporary directory through the REAL file sink
 * — the same bytes the writer produces, including a forced rotation — and reads
 * it back through readLogView. The workspace's own `.rolebox/logs/` is never
 * touched: the shared helper points ROLEBOX_LOG_DIR at an OS temporary directory
 * and every test removes it again.
 *
 * The property this suite exists for is the CURSOR: polling with the returned
 * cursor must never repeat a delivered record and never skip one, so a drained
 * walk holds exactly the records one full read returns — and under the default
 * `asc` order the sequence of polls concatenates into exactly one full read, in
 * the reader's own order. That is asserted against the reader itself
 * (readLogRecords), not against a hand-written expectation, so the two cannot
 * drift apart. The `desc` cases pin the weaker, honest property the module
 * documents for that order: the same records, no repeat and no gap, but windowed
 * rather than one descending sequence.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_LOG_QUERY_LIMIT,
  DEFAULT_LOG_VIEW_LIMIT,
  listLogFiles,
  readLogRecords,
  readLogView,
  resolveLogSource,
  type LogRecord,
  type LogViewResult,
} from "../../src/log/index.ts";
import { createFileSink } from "../../src/log/sinks/file.ts";
import { beginLogTest, endLogTest, makeRecord } from "../helpers/log.ts";

let state: { env: Record<string, string | undefined>; dir: string };

beforeEach(() => {
  state = beginLogTest();
});

afterEach(() => {
  endLogTest(state);
});

/** One record with a time, a channel and a message; `extra` adds anything else. */
function rec(time: number, channel: string, message: string, extra: Partial<LogRecord> = {}): LogRecord {
  return makeRecord({ time, channel, level: "info", message, ...extra });
}

/** Write records through the REAL file sink with rotation settings a test picks. */
function writeThroughSink(records: readonly LogRecord[], options: { dir?: string; maxBytes?: number; retain?: number } = {}): void {
  const sink = createFileSink({ dir: options.dir ?? state.dir, maxBytes: options.maxBytes, retain: options.retain });
  for (const record of records) sink(record);
  sink.close();
}

/** `count` records a millisecond apart, all on one channel. */
function run(count: number, channel: string, startTime: number, startIndex = 1): LogRecord[] {
  const records: LogRecord[] = [];
  for (let index = 0; index < count; index++) {
    records.push(rec(startTime + index, channel, `${channel} #${startIndex + index}`));
  }
  return records;
}

/** The messages of an answer, which is what a viewer renders. */
function messages(result: LogViewResult): string[] {
  return result.records.map((record) => record.message);
}

/**
 * The time an opaque cursor names. ONLY a test may look inside the value —
 * callers hand it back untouched — and it is here to pin the one property a
 * viewer cannot observe directly: that an EMPTY first paint anchors its
 * watermark strictly BEFORE the read it answered, which is what keeps the
 * no-gap promise for a writer that is already running.
 */
function cursorTime(cursor: string): number {
  return Number(cursor.slice(0, cursor.indexOf("~")));
}

/**
 * The tail of a full read that starts at the answer's own first record, i.e.
 * exactly the records a viewer ends up holding after painting `first` and
 * polling every window it reports as truncated. A first paint whose window is
 * narrower than the source deliberately leaves the older records behind the
 * watermark (see the readLogView JSDoc), so the comparison starts there.
 */
function expectedFrom(first: LogViewResult, logDir: string, options: { order?: "asc" | "desc" } = {}): string[] {
  const full = readLogRecords({ logDir, order: options.order }).records.map((record) => record.message);
  const head = first.records[0]?.message;
  if (head === undefined) return [];
  const start = full.indexOf(head);
  return start < 0 ? [] : full.slice(start);
}

/** Every record of a poll sequence, in the order the polls delivered them. */
function drainPoll(first: LogViewResult, poll: (cursor: string) => LogViewResult, rounds: number): { records: LogRecord[]; cursors: string[] } {
  const records = [...first.records];
  const cursors = [first.cursor];
  let cursor = first.cursor;
  for (let round = 0; round < rounds; round++) {
    const next = poll(cursor);
    records.push(...next.records);
    cursor = next.cursor;
    cursors.push(cursor);
  }
  return { records, cursors };
}

describe("readLogView defaults", () => {
  it("answers the newest records when no cursor is given, and reports the cut", () => {
    writeThroughSink(run(5, "alpha", 1000));
    const result = readLogView({ logDir: state.dir, limit: 3 });

    expect(messages(result)).toEqual(["alpha #3", "alpha #4", "alpha #5"]);
    expect(result.truncated).toBe(true);
    expect(result.skippedLines).toBe(0);
    expect(result.source).toEqual({ kind: "dir", path: state.dir });
    expect(typeof result.cursor).toBe("string");
  });

  it("does not report truncation when the whole source fits in the window", () => {
    writeThroughSink(run(3, "alpha", 1000));
    const result = readLogView({ logDir: state.dir, limit: 10 });

    expect(messages(result)).toEqual(["alpha #1", "alpha #2", "alpha #3"]);
    expect(result.truncated).toBe(false);
  });

  it("uses the read layer's own default limit when none is given", () => {
    writeThroughSink(run(4, "alpha", 1000));
    const result = readLogView({ logDir: state.dir });

    expect(DEFAULT_LOG_VIEW_LIMIT).toBe(DEFAULT_LOG_QUERY_LIMIT);
    expect(result.records.length).toBe(4);
    expect(result.truncated).toBe(false);
  });

  it("answers the newest records first under desc, and continues from there", () => {
    writeThroughSink(run(5, "alpha", 1000));
    const first = readLogView({ logDir: state.dir, order: "desc" });

    expect(messages(first)).toEqual(["alpha #5", "alpha #4", "alpha #3", "alpha #2", "alpha #1"]);
    expect(first.truncated).toBe(false);

    writeThroughSink(run(2, "alpha", 2000, 6));
    const next = readLogView({ logDir: state.dir, order: "desc", cursor: first.cursor });

    expect(messages(next)).toEqual(["alpha #7", "alpha #6"]);
    expect(next.truncated).toBe(false);
  });

  it("caps a desc first paint at the newest `limit`, exactly as it does under asc", () => {
    // ONE window rule for both orders: a first paint holds the `limit` NEWEST
    // records. The reader answers `desc` newest-first, so those records are the
    // HEAD of its array, not the tail — a window that took the tail would answer
    // the whole source (and report it as untruncated) for every limit below the
    // size of the source.
    writeThroughSink(run(200, "alpha", 5000));
    const full = readLogRecords({ logDir: state.dir, order: "desc" }).records.map((record) => record.message);
    expect(full.length).toBe(200);

    for (const limit of [1, 10, 50, 199]) {
      const result = readLogView({ logDir: state.dir, order: "desc", limit });
      expect(messages(result)).toEqual(full.slice(0, limit));
      expect(result.records.length).toBe(limit);
      expect(result.truncated).toBe(true);
    }

    const whole = readLogView({ logDir: state.dir, order: "desc", limit: 200 });
    expect(messages(whole)).toEqual(full);
    expect(whole.truncated).toBe(false);
  });

  it("completes the desc window's edge group instead of splitting a tie", () => {
    writeThroughSink([
      rec(100, "alpha", "t100"),
      rec(200, "alpha", "t200 #1"),
      rec(200, "alpha", "t200 #2"),
      rec(300, "alpha", "t300"),
    ]);

    // The newest group (t300) is one record, so it is the whole window.
    const single = readLogView({ logDir: state.dir, order: "desc", limit: 1 });
    expect(messages(single)).toEqual(["t300"]);
    expect(single.truncated).toBe(true);

    // limit 2 lands INSIDE the t200 group, so the group is delivered whole —
    // exactly the widening a cursor needs to stay exact, and the reason a window
    // may hold more than `limit` records.
    const tied = readLogView({ logDir: state.dir, order: "desc", limit: 2 });
    expect(messages(tied)).toEqual(["t300", "t200 #2", "t200 #1"]);
    expect(tied.truncated).toBe(true);

    // A window wide enough for the source is the reader's whole answer.
    const all = readLogView({ logDir: state.dir, order: "desc", limit: 5 });
    expect(messages(all)).toEqual(["t300", "t200 #2", "t200 #1", "t100"]);
    expect(all.truncated).toBe(false);
  });

  it("gives back an empty window, not an error, for a directory that does not exist", () => {
    const missing = join(state.dir, "missing");
    const result = readLogView({ logDir: missing });

    expect(result.records).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.skippedLines).toBe(0);
    expect(result.source).toEqual({ kind: "dir", path: missing });
    expect(result.cursor.length).toBeGreaterThan(0);
  });

  it("reports the directory it read for an empty directory, and keeps the cursor usable", () => {
    const empty = join(state.dir, "empty");
    mkdirSync(empty, { recursive: true });
    const first = readLogView({ logDir: empty });

    expect(first.records).toEqual([]);
    expect(first.source).toEqual({ kind: "dir", path: empty });

    // The records are written AFTER the first paint, so they are newer than the
    // watermark it answered with — one millisecond before the read, which is
    // what a real writer's clock produces.
    writeThroughSink(run(2, "alpha", Date.now() + 1000), { dir: empty });
    const next = readLogView({ logDir: empty, cursor: first.cursor });
    expect(messages(next)).toEqual(["alpha #1", "alpha #2"]);
  });

  it("keeps an empty source's watermark stable across two polls", () => {
    const empty = join(state.dir, "empty-polls");
    mkdirSync(empty, { recursive: true });

    const first = readLogView({ logDir: empty });
    const second = readLogView({ logDir: empty, cursor: first.cursor });

    // Nothing was delivered, so nothing moved: a viewer that polls an idle,
    // empty source does not walk its cursor forward and cannot miss a record
    // that appears later.
    expect(second.records).toEqual([]);
    expect(second.cursor).toBe(first.cursor);
    expect(cursorTime(first.cursor)).toBeLessThanOrEqual(Date.now());
  });

  it("does not lose a record stamped in the millisecond of an empty first paint", () => {
    const empty = join(state.dir, "same-ms");
    mkdirSync(empty, { recursive: true });

    const before = Date.now();
    const first = readLogView({ logDir: empty });
    const after = Date.now();

    // An empty answer must anchor BEFORE the instant of the read it answered:
    // a writer that is already running stamps its next record with the
    // millisecond the view was read in, and a watermark AT that millisecond
    // would place the record behind the cursor and drop it forever.
    expect(cursorTime(first.cursor)).toBeLessThan(after);
    expect(cursorTime(first.cursor)).toBeGreaterThanOrEqual(before - 1);

    writeThroughSink([rec(after, "alpha", "stamped during the read")], { dir: empty });
    const next = readLogView({ logDir: empty, cursor: first.cursor });
    expect(messages(next)).toEqual(["stamped during the read"]);

    // Delivered once: the record is behind the cursor now, not in front of it.
    const again = readLogView({ logDir: empty, cursor: next.cursor });
    expect(again.records).toEqual([]);
  });

  it("anchors an empty first paint before the caller's `since`, so a record AT the bound is not lost", () => {
    const empty = join(state.dir, "since-empty");
    mkdirSync(empty, { recursive: true });

    const first = readLogView({ logDir: empty, since: 1_000_000 });
    expect(first.records).toEqual([]);

    // `since` is an INCLUSIVE filter bound, so the watermark has to sit strictly
    // before it: a record stamped exactly at the bound that appears after this
    // read is still inside the window.
    writeThroughSink([rec(1_000_000, "alpha", "at the bound")], { dir: empty });
    const next = readLogView({ logDir: empty, since: 1_000_000, cursor: first.cursor });
    expect(messages(next)).toEqual(["at the bound"]);
    expect(next.truncated).toBe(false);

    const again = readLogView({ logDir: empty, since: 1_000_000, cursor: next.cursor });
    expect(again.records).toEqual([]);
  });
});

describe("the cursor is monotonic", () => {
  it("answers the same nothing twice when the source did not change", () => {
    writeThroughSink(run(3, "alpha", 1000));
    const first = readLogView({ logDir: state.dir });
    const second = readLogView({ logDir: state.dir, cursor: first.cursor });

    expect(messages(second)).toEqual([]);
    expect(second.cursor).toBe(first.cursor);
    expect(second.truncated).toBe(false);
  });

  it("delivers only what was appended after the cursor", () => {
    writeThroughSink(run(3, "alpha", 1000));
    const first = readLogView({ logDir: state.dir });

    writeThroughSink(run(2, "alpha", 2000, 4));
    const second = readLogView({ logDir: state.dir, cursor: first.cursor });

    expect(messages(second)).toEqual(["alpha #4", "alpha #5"]);
    expect(second.truncated).toBe(false);
  });

  it("concatenates consecutive polls into exactly one full read (no repeat, no gap)", () => {
    // A burst that shares ONE timestamp, so the cursor has to carry the rank
    // inside that timestamp as well as the time itself.
    writeThroughSink([
      rec(500, "alpha", "same #1"),
      rec(500, "alpha", "same #2"),
      rec(500, "alpha", "same #3"),
      rec(500, "alpha", "same #4"),
      rec(500, "alpha", "same #5"),
      rec(500, "alpha", "same #6"),
      rec(600, "alpha", "after the burst"),
    ]);

    const first = readLogView({ logDir: state.dir });
    const { records, cursors } = drainPoll(first, (cursor) => readLogView({ logDir: state.dir, cursor }), 4);
    const full = readLogRecords({ logDir: state.dir }).records;

    expect(records.map((record) => record.message)).toEqual(full.map((record) => record.message));
    expect(messages(first)).toEqual(["same #1", "same #2", "same #3", "same #4", "same #5", "same #6", "after the burst"]);
    // Once drained, the cursor stops moving and keeps answering nothing.
    expect(cursors[cursors.length - 1]).toBe(cursors[cursors.length - 2]!);
  });

  it("drains a burst larger than the window across polls without losing a record", () => {
    const batch = run(25, "alpha", 7000);
    writeThroughSink(batch);

    const first = readLogView({ logDir: state.dir, limit: 4 });
    expect(messages(first)).toEqual(["alpha #22", "alpha #23", "alpha #24", "alpha #25"]);

    // Every record written AFTER the first window is still reachable: append a
    // burst that shares one timestamp and ask for it four at a time.
    const burst = Array.from({ length: 10 }, (_unused, index) => rec(8000, "alpha", `burst #${index + 1}`));
    writeThroughSink(burst);
    const collected: string[] = [];
    let cursor = first.cursor;
    let result = readLogView({ logDir: state.dir, cursor, limit: 4 });
    while (result.records.length > 0) {
      collected.push(...messages(result));
      // A poll that delivered something must have advanced the watermark; a
      // regression that re-delivers a millisecond fails here instead of looping.
      expect(result.cursor > cursor).toBe(true);
      cursor = result.cursor;
      result = readLogView({ logDir: state.dir, cursor, limit: 4 });
    }

    expect(collected).toEqual(burst.map((record) => record.message));
    expect(new Set(collected).size).toBe(collected.length);
    expect(readLogView({ logDir: state.dir, cursor, limit: 4 }).truncated).toBe(false);
  });

  it("streams records to the same end a single read reaches, over many appends", () => {
    writeThroughSink(run(3, "alpha", 1000));
    const first = readLogView({ logDir: state.dir });
    // The first paint IS the watermark: a viewer that just painted #1..#3 has
    // seen them, so the polls below are what it has NOT seen.
    expect(messages(first)).toEqual(["alpha #1", "alpha #2", "alpha #3"]);
    const collected: string[] = [];
    let current = first.cursor;

    for (let round = 1; round <= 6; round++) {
      // Every round appends four fresh records a second apart, numbered from 4,
      // strictly after the records the previous round wrote.
      writeThroughSink(run(4, "alpha", 1000 + round * 100, 4 + (round - 1) * 4));
      const next = readLogView({ logDir: state.dir, cursor: current, limit: 25 });
      collected.push(...messages(next));
      expect(next.truncated).toBe(false);
      current = next.cursor;
    }

    // Everything appended after the first paint, each record exactly once.
    expect(collected).toEqual(run(27, "alpha", 1000).map((record) => record.message).slice(3));
    expect(new Set(collected).size).toBe(collected.length);
    expect(readLogRecords({ logDir: state.dir }).records.length).toBe(27);
  });

  it("keeps the reader's scan order for records that share a timestamp", () => {
    // Two channels, interleaved times, with a tie across files: the view must
    // answer exactly what the reader answers, in the same order.
    writeThroughSink([rec(10, "alpha", "a-1"), rec(30, "alpha", "a-3")]);
    writeThroughSink([rec(20, "beta", "b-2"), rec(30, "beta", "b-3")]);

    const first = readLogView({ logDir: state.dir, limit: 2 });
    const { records } = drainPoll(first, (cursor) => readLogView({ logDir: state.dir, cursor, limit: 2 }), 2);

    // A window wide enough for the source is the reader's answer, ties included.
    expect(messages(readLogView({ logDir: state.dir, limit: 10 }))).toEqual(["a-1", "b-2", "a-3", "b-3"]);
    // And the windows a polling viewer sees concatenate into the same order.
    expect(records.map((record) => record.message)).toEqual(expectedFrom(first, state.dir));
  });

  it("walks forward under desc too, listing the poll window newest-first", () => {
    writeThroughSink(run(3, "alpha", 1000));
    const paint = readLogView({ logDir: state.dir, order: "desc" });
    expect(messages(paint)).toEqual(["alpha #3", "alpha #2", "alpha #1"]);

    // Six records arrive after the paint; a poll with a small window takes the
    // OLDEST of them (the cursor walks forward) and lists them newest-first.
    writeThroughSink(run(6, "alpha", 2000, 4));
    const first = readLogView({ logDir: state.dir, order: "desc", limit: 3, cursor: paint.cursor });
    expect(messages(first)).toEqual(["alpha #6", "alpha #5", "alpha #4"]);
    expect(first.truncated).toBe(true);

    const second = readLogView({ logDir: state.dir, order: "desc", limit: 3, cursor: first.cursor });
    expect(messages(second)).toEqual(["alpha #9", "alpha #8", "alpha #7"]);
    expect(second.truncated).toBe(false);

    const third = readLogView({ logDir: state.dir, order: "desc", limit: 3, cursor: second.cursor });
    expect(third.records).toEqual([]);
  });

  it("drains a desc walk to the same records a single desc read gives, windowed", () => {
    // The `desc` walk moves FORWARD in time — it must, or the records between
    // the cursor and a newest-first window would be skipped forever — so its
    // windows arrive in write order and read newest-first INSIDE each window.
    // That is the honest property the module documents: the same records as one
    // full `desc` read, no repeat and no gap, chunked rather than one descending
    // sequence.
    writeThroughSink([rec(10, "alpha", "a1"), rec(20, "alpha", "a2")]);
    const paint = readLogView({ logDir: state.dir, order: "desc", limit: 2 });
    expect(messages(paint)).toEqual(["a2", "a1"]);

    writeThroughSink(run(5, "beta", 30, 3));
    const chunks: string[][] = [];
    let cursor = paint.cursor;
    for (let round = 0; round < 6; round++) {
      const next = readLogView({ logDir: state.dir, order: "desc", limit: 2, cursor });
      if (next.records.length === 0) break;
      // Every window that delivered something moved the watermark forward: a
      // regression that re-delivers a timestamp fails here instead of looping.
      expect(next.cursor > cursor).toBe(true);
      chunks.push(messages(next));
      cursor = next.cursor;
    }

    // Window by window: the OLDEST pending pair first, listed newest-first.
    expect(chunks).toEqual([["beta #4", "beta #3"], ["beta #6", "beta #5"], ["beta #7"]]);

    const collected = chunks.flat();
    const fullDesc = readLogRecords({ logDir: state.dir, order: "desc" }).records.map((record) => record.message);
    expect(fullDesc).toEqual(["beta #7", "beta #6", "beta #5", "beta #4", "beta #3", "a2", "a1"]);
    // No repeat, no gap: the union is exactly the records written after the
    // paint...
    expect(new Set(collected).size).toBe(collected.length);
    expect([...collected].sort()).toEqual([...fullDesc.slice(0, 5)].sort());
    // ...but NOT in the order one full `desc` read gives them: reversing each
    // window shows the walk really is the ascending sequence, chunked.
    expect(collected).not.toEqual(fullDesc.slice(0, 5));
    expect(chunks.flatMap((chunk) => [...chunk].reverse())).toEqual(["beta #3", "beta #4", "beta #5", "beta #6", "beta #7"]);
  });

  it("concatenates its windows into the same answer a single full read gives", () => {
    // Two channels whose times interleave, a tie between them, and a window far
    // smaller than the source: the sequence of windows a viewer polls must be
    // exactly ONE readLogRecords answer for the same filters — same set, same
    // order, ties included — starting from the paint the viewer began with.
    writeThroughSink([rec(10, "alpha", "a1"), rec(30, "alpha", "a3"), rec(50, "alpha", "a5")]);
    writeThroughSink([rec(20, "beta", "b2"), rec(30, "beta", "b3"), rec(60, "beta", "b6")]);
    const expected = readLogRecords({ logDir: state.dir }).records;
    expect(expected.map((record) => record.message)).toEqual(["a1", "b2", "a3", "b3", "a5", "b6"]);

    // The first paint is WIDE (the whole source), which is what a viewer's first
    // request ordinarily asks for. Its watermark is therefore the end of the
    // source and every poll after it must answer nothing.
    const first = readLogView({ logDir: state.dir, limit: 100 });
    expect(first.records).toEqual([...expected]);
    expect(first.truncated).toBe(false);
    expect(readLogView({ logDir: state.dir, cursor: first.cursor }).records).toEqual([]);

    // A viewer that polls in small windows from an empty start reaches the same
    // answer: window by window, each record exactly once, in the reader's order.
    const narrow: LogRecord[] = [];
    let cursor = readLogView({ logDir: state.dir, limit: 2, until: 0 }).cursor;
    for (let round = 0; round < 12; round++) {
      const answer = readLogView({ logDir: state.dir, limit: 2, cursor });
      narrow.push(...answer.records);
      if (answer.records.length === 0) break;
      cursor = answer.cursor;
    }
    expect(narrow).toEqual([]);

    // And from a watermark BEHIND every record, the windows concatenate to the
    // reader's whole answer in the reader's order. The watermark is one the
    // module PRODUCED — the only record of a scratch source is stamped at time
    // 0, so its first paint answers that time — rather than a hand-written
    // literal: parseCursor is strict, and a literal would silently degrade into
    // an absent cursor, leaving the equality below to compare a recent window
    // against a full read.
    const scratch = join(state.dir, "scratch");
    mkdirSync(scratch, { recursive: true });
    writeThroughSink([rec(0, "alpha", "scratch")], { dir: scratch });
    const drained: LogRecord[] = [];
    let from = readLogView({ logDir: scratch, limit: 1 }).cursor;
    for (let round = 0; round < 12; round++) {
      const answer = readLogView({ logDir: state.dir, limit: 2, cursor: from });
      drained.push(...answer.records);
      if (answer.records.length === 0) break;
      from = answer.cursor;
    }
    expect(drained.map((record) => record.message)).toEqual(expected.map((record) => record.message));
    expect(drained).toEqual([...expected]);
  });

  it("drains a fixed pseudo-random multi-channel stream without a repeat or a gap", () => {
    // A deterministic "several writers at once" stream: times that collide,
    // interleave across channels and move both forwards and backwards, written
    // one record per poll so every single poll has to be exactly right.
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const channels = ["alpha", "beta", "gamma"];
    const written: LogRecord[] = [];
    const collected: string[] = [];
    let cursor = readLogView({ logDir: state.dir }).cursor;

    for (let step = 0; step < 60; step++) {
      const record = rec(1000 + (next() % 12), channels[next() % channels.length] ?? "alpha", `s${step}`);
      writeThroughSink([record]);
      written.push(record);

      const answer = readLogView({ logDir: state.dir, cursor });
      for (const delivered of answer.records) expect(collected).not.toContain(delivered.message);
      collected.push(...messages(answer));
      // Every poll that delivered something must have moved the watermark, so a
      // regression that re-delivers a timestamp cannot hide behind the cap.
      if (answer.records.length > 0) expect(answer.cursor > cursor).toBe(true);
      cursor = answer.cursor;
    }

    // Nothing repeated, and the union of every poll is the prefix of the final
    // read whose length the polls delivered (the tail is in flight, not lost).
    expect(new Set(collected).size).toBe(collected.length);
    const full = readLogRecords({ logDir: state.dir }).records.map((record) => record.message);
    expect(full.slice(0, collected.length)).toEqual(collected);
    expect(written.length).toBe(60);
  });

  it("leaves a record stamped into an already-read millisecond behind the cursor (no repeat wins)", () => {
    // A cursor is a TIME watermark and cannot split a millisecond: a record
    // that lands in a group the viewer has already read is indistinguishable
    // from a delivered one, so it is left behind rather than delivered twice.
    // The module comment states this window; this case pins the trade-off so a
    // later "fix" for late arrivals cannot silently turn it into a repeat.
    writeThroughSink([rec(1000, "alpha", "seen #1"), rec(1000, "alpha", "seen #2"), rec(2000, "alpha", "seen #3")]);
    const first = readLogView({ logDir: state.dir });
    expect(messages(first)).toEqual(["seen #1", "seen #2", "seen #3"]);

    // A writer appends a record stamped INSIDE the millisecond just delivered.
    writeThroughSink([rec(2000, "alpha", "late at 2000")]);
    const next = readLogView({ logDir: state.dir, cursor: first.cursor });
    expect(next.records).toEqual([]);
    expect(next.cursor).toBe(first.cursor);

    // The stream still continues: the next millisecond IS delivered.
    writeThroughSink([rec(3000, "alpha", "after")]);
    const later = readLogView({ logDir: state.dir, cursor: next.cursor });
    expect(messages(later)).toEqual(["after"]);
    expect(later.cursor > first.cursor).toBe(true);
  });

});

describe("readLogView passes the read filters through", () => {
  function writeFilterFixture(): void {
    writeThroughSink([rec(100, "alpha", "a-1"), rec(200, "alpha", "a-2", { level: "warn" })]);
    writeThroughSink([
      rec(300, "beta", "b-1", { fields: { reason: "wanted" } }),
      rec(400, "beta", "b-2", { scope: { graphId: "g1" } }),
    ]);
  }

  it("filters by channel, level and scope on the first paint", () => {
    writeFilterFixture();
    expect(messages(readLogView({ logDir: state.dir, limit: 10, channels: ["beta"] }))).toEqual(["b-1", "b-2"]);
    // The only warn record in the fixture is a-2; the beta records are info.
    expect(messages(readLogView({ logDir: state.dir, limit: 10, minLevel: "warn" }))).toEqual(["a-2"]);
    expect(messages(readLogView({ logDir: state.dir, limit: 10, levels: ["warn"] }))).toEqual(["a-2"]);
    expect(messages(readLogView({ logDir: state.dir, limit: 10, graphId: "g1" }))).toEqual(["b-2"]);
    expect(messages(readLogView({ logDir: state.dir, limit: 10, text: "wanted" }))).toEqual(["b-1"]);
  });

  it("keeps filtering while polling with a cursor", () => {
    writeFilterFixture();
    const cursor = readLogView({ logDir: state.dir, channels: ["beta"] }).cursor;

    writeThroughSink([rec(500, "alpha", "a-3"), rec(600, "beta", "b-3")]);
    const next = readLogView({ logDir: state.dir, channels: ["beta"], cursor });

    expect(messages(next)).toEqual(["b-3"]);
  });

  it("reports truncation for records the CURRENT window had to leave behind", () => {
    writeFilterFixture();
    const bounded = readLogView({ logDir: state.dir, limit: 2 });
    expect(messages(bounded)).toEqual(["b-1", "b-2"]);
    expect(bounded.truncated).toBe(true);

    const drained = readLogView({ logDir: state.dir, cursor: bounded.cursor, limit: 2 });
    expect(drained.records).toEqual([]);
    expect(drained.truncated).toBe(false);
  });

  it("answers nothing, without throwing, when the limit is zero", () => {
    writeFilterFixture();
    const result = readLogView({ logDir: state.dir, limit: 0 });
    expect(result.records).toEqual([]);
    expect(typeof result.cursor).toBe("string");
  });
});

describe("readLogView and the single-file source", () => {
  it("reads and reports the one legacy file an explicit logFile names", () => {
    const legacy = join(state.dir, "mine.log");
    writeFileSync(legacy, JSON.stringify(rec(1, "alpha", "legacy #1")) + "\n" + JSON.stringify(rec(2, "beta", "legacy #2")) + "\n");

    const result = readLogView({ logFile: legacy });
    expect(messages(result)).toEqual(["legacy #1", "legacy #2"]);
    expect(result.source).toEqual({ kind: "file", path: legacy });

    const next = readLogView({ logFile: legacy, cursor: result.cursor });
    expect(next.records).toEqual([]);
    expect(next.source).toEqual({ kind: "file", path: legacy });
  });

  it("reports the directory it read even when ROLEBOX_LOG_FILE names another file", () => {
    // The Stage 3a lesson: the location in the answer is the location that was
    // READ, so an explicit logDir is never shadowed by the environment.
    const elsewhere = join(state.dir, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const legacy = join(elsewhere, "mine.log");
    // The writer honors the environment (it is the legacy single-file mode), so
    // its records land OUTSIDE the directory the view is asked for.
    process.env.ROLEBOX_LOG_FILE = legacy;
    writeThroughSink([rec(1, "alpha", "not read")]);

    const result = readLogView({ logDir: state.dir });
    expect(result.source).toEqual({ kind: "dir", path: state.dir });
    expect(result.source).toEqual(resolveLogSource({ logDir: state.dir }));
    expect(messages(result)).toEqual([]);
  });
});

describe("readLogView tolerates broken input", () => {
  it("counts malformed lines exactly as the read layer does, and answers the rest", () => {
    writeThroughSink([rec(100, "alpha", "good #1")]);
    const path = join(state.dir, "alpha.log");
    appendFileSync(path, "this is not json\n");
    // An old tslog line: valid JSON, not a record.
    appendFileSync(path, JSON.stringify({ "0": "legacy message", "1": { old: true }, _meta: { logLevelName: "INFO" } }) + "\n");
    appendFileSync(path, "\n");
    appendFileSync(path, JSON.stringify(rec(200, "alpha", "good #2")) + "\n");

    const view = readLogView({ logDir: state.dir });
    const read = readLogRecords({ logDir: state.dir });

    expect(messages(view)).toEqual(["good #1", "good #2"]);
    expect(view.skippedLines).toBe(2);
    expect(view.skippedLines).toBe(read.skippedLines);
    expect(read.malformedSamples.length).toBe(2);
  });

  it("treats an unparsable cursor as absent instead of throwing", () => {
    // The window is deliberately NARROWER than the source: "absent" means the
    // NEWEST records, while a truncated cursor that parsed as a time near zero
    // would answer the OLDEST ones. The two answers are only distinguishable
    // when the source is bigger than the window, which is what makes this case
    // a pin on the R3 symptom rather than on a spelling.
    writeThroughSink(run(6, "alpha", 1000));
    const options = { logDir: state.dir, limit: 3 } as const;
    const expected = messages(readLogView(options));
    expect(expected).toEqual(["alpha #4", "alpha #5", "alpha #6"]);

    // Garbage, and truncations of a real cursor. None of them is the spelling
    // the module writes (CURSOR_PATTERN), and each must behave as if NO cursor
    // had been sent. The truncated spellings are the dangerous ones: "1.5~"
    // (empty occurrence) and "1.5~2" (a one-digit fraction) would otherwise
    // parse as a time near zero, which IS a valid watermark behind every record
    // — the view would answer the OLDEST window and walk forward from there
    // while the route and the docs promise it re-paints the recent window.
    const rejected = [
      "",
      "   ",
      "not a cursor",
      "~",
      "abc~1",
      "12x.5~1",
      "1000.5~2.5",
      "1000.5~-1",
      "-5.000~1",
      "{}",
      "1000-5",
      "1~",
      "1.5~",
      "1.5~2",
      "1.000",
      "00179145000000.250~1",
      "001791450000000.250~",
      "001791450000000.25~1",
      "001791450000000.2500~1",
      "001791450000000.250~1 ",
    ];
    for (const cursor of rejected) {
      const result = readLogView({ ...options, cursor });
      expect(messages(result)).toEqual(expected);
      expect(result.source).toEqual({ kind: "dir", path: state.dir });
      // The unreadable value is not echoed back either: the viewer receives a
      // cursor it can actually poll with, anchored at this read.
      expect(result.cursor).not.toBe(cursor);
    }
  });

  it("answers nothing for a cursor that is ahead of every record, without losing it", () => {
    writeThroughSink(run(3, "alpha", 1000));
    const ahead = "009999999999999.000~1";
    const result = readLogView({ logDir: state.dir, cursor: ahead });

    expect(result.records).toEqual([]);
    expect(result.cursor).toBe(ahead);
    expect(result.truncated).toBe(false);
  });

  it("answers everything for a cursor older than every record", () => {
    writeThroughSink(run(3, "alpha", 1000));
    // Zero-padded exactly as the module writes a watermark: OLD is not the same
    // thing as UNREADABLE, so this one is honoured and walked forward from (an
    // unpadded "1.000~1" is a foreign spelling and counts as absent).
    const result = readLogView({ logDir: state.dir, cursor: "000000000000001.000~1" });
    expect(messages(result)).toEqual(["alpha #1", "alpha #2", "alpha #3"]);
  });

  it("survives a file that disappears between two polls", () => {
    writeThroughSink(run(2, "alpha", 1000));
    const first = readLogView({ logDir: state.dir });
    rmSync(join(state.dir, "alpha.log"), { force: true });

    const next = readLogView({ logDir: state.dir, cursor: first.cursor });
    expect(next.records).toEqual([]);
    expect(next.cursor).toBe(first.cursor);
    expect(next.source).toEqual({ kind: "dir", path: state.dir });
  });
});

describe("readLogView across a rotation", () => {
  it("keeps polling a real, forced rotation without repeating a delivered record", () => {
    // A tiny maxBytes rotates the file every few records, through the REAL sink.
    const before = run(6, "alpha", 1000);
    writeThroughSink(before, { maxBytes: 1, retain: 3 });
    const rotated = listLogFiles({ logDir: state.dir }).filter((file) => file.rotation > 0);
    expect(rotated.length).toBeGreaterThan(0);

    const first = readLogView({ logDir: state.dir, limit: 25 });
    const seen = new Set(messages(first));
    expect(seen.size).toBe(first.records.length);

    const after = run(6, "alpha", 2000, 7);
    writeThroughSink(after, { maxBytes: 1, retain: 3 });
    const next = readLogView({ logDir: state.dir, cursor: first.cursor, limit: 25 });

    // Nothing delivered twice, and everything that arrived after the cursor and
    // still exists is delivered.
    for (const message of messages(next)) expect(seen.has(message)).toBe(false);
    expect(next.records.map((record) => record.time)).toEqual([...next.records.map((record) => record.time)].sort((a, b) => a - b));
    expect(new Set(messages(next)).size).toBe(next.records.length);
    expect(messages(next).some((message) => message.startsWith("alpha #"))).toBe(true);
    expect(next.truncated).toBe(false);

    const drained = readLogView({ logDir: state.dir, cursor: next.cursor, limit: 25 });
    expect(drained.records).toEqual([]);
  });

  it("follows a rotation that renamed the file it had already read", () => {
    writeThroughSink(run(2, "alpha", 1000));
    const first = readLogView({ logDir: state.dir });
    expect(messages(first)).toEqual(["alpha #1", "alpha #2"]);

    // What the writer does at the size limit: the active file becomes `.1` and
    // a fresh active file takes the new records.
    renameSync(join(state.dir, "alpha.log"), join(state.dir, "alpha.log.1"));
    writeThroughSink(run(2, "alpha", 2000, 3));

    const next = readLogView({ logDir: state.dir, cursor: first.cursor });
    expect(messages(next)).toEqual(["alpha #3", "alpha #4"]);
    expect(next.source).toEqual({ kind: "dir", path: state.dir });

    const again = readLogView({ logDir: state.dir, cursor: next.cursor });
    expect(again.records).toEqual([]);
  });
});

describe("the cursor value itself", () => {
  it("reads exactly the spelling it writes, and walks forward from a well-formed old one", () => {
    writeThroughSink(run(3, "alpha", 1000));

    // Well-formed and old: the walk continues from it, in the reader's order.
    const old = "000000000000001.000~9";
    expect(messages(readLogView({ logDir: state.dir, cursor: old }))).toEqual(["alpha #1", "alpha #2", "alpha #3"]);

    // And the value the module writes is accepted verbatim by the next poll:
    // formatCursor and CURSOR_PATTERN cannot drift apart unnoticed.
    const { cursor } = readLogView({ logDir: state.dir, limit: 2 });
    expect(readLogView({ logDir: state.dir, cursor }).records).toEqual([]);
  });

  it("is JSON-safe and survives a round trip through JSON", () => {
    writeThroughSink(run(3, "alpha", 1000));
    const { cursor } = readLogView({ logDir: state.dir });

    expect(JSON.parse(JSON.stringify({ cursor })).cursor).toBe(cursor);
    expect(/^\d{15}\.\d{3}~\d+$/.test(cursor)).toBe(true);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  it("sorts lexicographically in the same order as the times it names", () => {
    // The seconds are zero-padded, so a shorter time never sorts after a longer
    // one; the fractional part is padded for the same reason.
    const times = [9, 10, 100, 1000, 1_000_000, Date.now()];
    const cursors: string[] = [];
    for (const time of times) {
      writeThroughSink([rec(time, "alpha", `t-${time}`)]);
      cursors.push(readLogView({ logDir: state.dir }).cursor);
    }
    const sorted = [...cursors].sort();
    expect(sorted).toEqual(cursors);
    expect(new Set(cursors).size).toBe(cursors.length);
  });

  it("moves forward for every delivered record, never backwards", () => {
    writeThroughSink(run(20, "alpha", 1000));
    let cursor = readLogView({ logDir: state.dir, limit: 1 }).cursor;
    const seen = new Set<string>();
    for (let round = 0; round < 25; round++) {
      const next = readLogView({ logDir: state.dir, cursor, limit: 1 });
      if (next.records.length === 0) break;
      expect(seen.has(next.cursor)).toBe(false);
      seen.add(next.cursor);
      expect(next.cursor >= cursor).toBe(true);
      cursor = next.cursor;
    }
    expect(existsSync(join(state.dir, "alpha.log"))).toBe(true);
    expect(readFileSync(join(state.dir, "alpha.log"), "utf8").length).toBeGreaterThan(0);
  });
});
