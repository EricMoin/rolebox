/// <reference types="bun-types" />

/**
 * The TUI Logs VIEW STATE MACHINE, driven by a REAL log directory.
 *
 * Every case here writes its fixture through the platform's own file sink
 * (`createFileSink`, src/log/sinks/file.ts) and polls through the platform's own
 * view source (`readLogView`) — no fake reader, no hand-written JSON. So the
 * assertions are about the contract the pane actually depends on: the cursor
 * {@link pollLogsStore} keeps really does make the next poll incremental, and
 * the `skippedLines`/`truncated`/`source` it reports are the reader's own.
 *
 * THE ENVIRONMENT IS ALWAYS CLOSED. `ROLEBOX_LOG_DIR`/`ROLEBOX_LOG_FILE` (and
 * the rest of the ROLEBOX_LOG* family) are snapshotted, cleared for the case and
 * restored afterwards, and each case gets a fresh directory under the OS temp
 * directory which is removed again — a suite that leaked the variable would let
 * a later case write into the workspace's own `.rolebox/logs/`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileSink } from "../../src/log/sinks/file.ts";
import { resolveLogSource } from "../../src/log/read.ts";
import { readLogView } from "../../src/log/view.ts";
import type { LogLevel, LogRecord } from "../../src/log/types.ts";
import {
  BUFFER_LIMIT,
  POLL_LIMIT,
  appendLogsRecords,
  collectLogChannels,
  createLogsStore,
  cycleLogsChannel,
  logsDropCounts,
  logsIdentity,
  logsModeText,
  logsQuery,
  logsStatusText,
  normalizeLogsFilters,
  pollLogsStore,
  setLogsChannel,
  setLogsFilters,
  setLogsPaused,
  setLogsSession,
  stepLogsLevel,
  toggleLogsPaused,
  type LogsBuffer,
  type LogsReader,
  type LogsStore,
} from "../../src/tui/logs.ts";

// ── Environment harness ─────────────────────────────────────────────────

let env: Record<string, string | undefined>;
let dir: string;

beforeEach(() => {
  env = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ROLEBOX_LOG")) {
      env[key] = process.env[key];
      delete process.env[key];
    }
  }
  dir = join(tmpdir(), `rolebox-tui-logs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  process.env.ROLEBOX_LOG_DIR = dir;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ROLEBOX_LOG")) delete process.env[key];
  }
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (value !== undefined) process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

// ── Fixture helpers ─────────────────────────────────────────────────────

/** One complete record; `extra` overrides any field. */
function rec(time: number, channel: string, message: string, extra: Partial<LogRecord> = {}): LogRecord {
  return {
    time,
    level: "info",
    channel,
    message,
    fields: {},
    scope: {},
    process: { pid: 4242, role: "host" },
    ...extra,
  };
}

/** Write records through the REAL file sink into `target` and close it. */
function writeRecords(records: readonly LogRecord[], target = dir): void {
  const sink = createFileSink({ dir: target });
  for (const record of records) sink(record);
  sink.close();
}

/** A store whose reader is the real `readLogView`, and whose clock is fixed. */
function realStore(options: { filters?: Parameters<typeof createLogsStore>[0] extends undefined ? never : NonNullable<Parameters<typeof createLogsStore>[0]>["filters"]; paused?: boolean } = {}) {
  const reader: LogsReader = { read: readLogView, now: () => 1_791_450_000_000 };
  return createLogsStore({ ...options, reader });
}

// ── First paint ─────────────────────────────────────────────────────────

describe("pollLogsStore — first paint", () => {
  it("answers the newest window with no cursor and reports the real source", () => {
    writeRecords([rec(1_000, "alpha", "first"), rec(2_000, "alpha", "second")]);
    const store = realStore();

    const { store: after, result } = pollLogsStore(store);

    expect(result.records.map((r) => r.message)).toEqual(["first", "second"]);
    expect(result.reset).toBe(false); // a fresh store already holds its own identity
    expect(result.error).toBeNull();
    expect(result.source).toEqual({ kind: "dir", path: dir });
    expect(after.cursor.length).toBeGreaterThan(0);
    expect(after.buffer.records).toHaveLength(2);
  });

  it("sends no cursor on the first poll and the previous cursor afterwards", () => {
    writeRecords([rec(1_000, "alpha", "first")]);
    const first = pollLogsStore(realStore());
    expect(logsQuery(createLogsStore())).not.toHaveProperty("cursor");
    expect(logsQuery(first.store).cursor).toBe(first.store.cursor);
  });

  it("reads an empty, missing directory as an empty view and not an error", () => {
    const store = createLogsStore({
      filters: { logDir: join(dir, "does-not-exist") },
      reader: { read: readLogView, now: () => 1 },
    });

    const { store: after, result } = pollLogsStore(store);

    expect(result.records).toEqual([]);
    expect(result.error).toBeNull();
    expect(after.buffer.records).toEqual([]);
    expect(after.buffer.dropped).toBe(0);
    expect(after.cursor.length).toBeGreaterThan(0);
  });
});

// ── Incremental polling ─────────────────────────────────────────────────

describe("pollLogsStore — incremental polling", () => {
  it("appends only what the cursor has not delivered: no repeat, no gap", () => {
    writeRecords([rec(1_000, "alpha", "a"), rec(2_000, "alpha", "b")]);
    let store = realStore();
    ({ store } = pollLogsStore(store));
    expect(store.buffer.records.map((r) => r.message)).toEqual(["a", "b"]);

    writeRecords([rec(3_000, "alpha", "c")]);
    const second = pollLogsStore(store);
    store = second.store;

    expect(second.result.records.map((r) => r.message)).toEqual(["c"]);
    expect(store.buffer.records.map((r) => r.message)).toEqual(["a", "b", "c"]);
  });

  it("costs nothing on an empty poll and still delivers the next millisecond", () => {
    writeRecords([rec(5_000, "alpha", "burst-1")]);
    let store = realStore();
    ({ store } = pollLogsStore(store));

    const idle = pollLogsStore(store);
    expect(idle.result.records).toEqual([]);
    expect(idle.result.error).toBeNull();
    expect(idle.store.buffer.records.map((r) => r.message)).toEqual(["burst-1"]);
    store = idle.store;

    // A record written AFTER the watermark's own millisecond is delivered; one
    // written INSIDE it is not, and view.ts states that limit of a time
    // watermark in full. What the state machine must not do is repeat a record
    // it already delivered or lose one that lands after the watermark.
    writeRecords([rec(6_000, "alpha", "burst-2")]);
    const next = pollLogsStore(store);

    expect(next.result.records.map((r) => r.message)).toEqual(["burst-2"]);
    expect(next.store.buffer.records.map((r) => r.message)).toEqual(["burst-1", "burst-2"]);
  });

  it("keeps a drained walk equal to one full read of the same source", () => {
    const records = Array.from({ length: 12 }, (_, i) => rec(1_000 + i, "alpha", `m${i}`));
    writeRecords(records);

    let store = realStore();
    const seen: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const poll = pollLogsStore(store);
      store = poll.store;
      seen.push(...poll.result.records.map((r) => r.message));
      if (poll.result.records.length === 0) break;
    }

    const full = readLogView({ logDir: dir, order: "asc", limit: 1000 });
    expect(seen).toEqual(full.records.map((r) => r.message));
  });

  it("delivers two identical same-millisecond records through the real sink and reader", () => {
    const record = rec(1_000, "alpha", "identical");
    writeRecords([record, record]);

    let store = realStore();
    const seen: LogRecord[] = [];
    for (let i = 0; i < 3; i += 1) {
      const poll = pollLogsStore(store);
      store = poll.store;
      seen.push(...poll.result.records);
      if (poll.result.records.length === 0) break;
    }

    // The file holds both, one full read answers both, and the pane's walk
    // holds both — the same count, with no drop to report.
    const full = readLogView({ logDir: dir, order: "asc", limit: 1000 });
    expect(full.records).toHaveLength(2);
    expect(seen).toHaveLength(2);
    expect(seen.map((r) => r.message)).toEqual(["identical", "identical"]);
    expect(store.buffer.records).toHaveLength(2);
    expect(store.buffer.dropped).toBe(0);
  });

  it("reports a reader's malformed line as skippedLines and keeps reading", () => {
    writeRecords([rec(1_000, "alpha", "ok")]);
    Bun.write(join(dir, "alpha.log"), `not json at all\n${JSON.stringify(rec(2_000, "alpha", "after"))}\n`);

    const { result } = pollLogsStore(realStore());

    expect(result.records.map((r) => r.message)).toEqual(["after"]);
    expect(result.skippedLines).toBe(1);
  });
});

// ── Pause / resume ──────────────────────────────────────────────────────

describe("pollLogsStore — pause and resume", () => {
  it("does not advance the cursor while paused and does not lose what it skipped", () => {
    writeRecords([rec(1_000, "alpha", "a")]);
    let store = setLogsPaused(realStore(), true);
    ({ store } = pollLogsStore(store));

    writeRecords([rec(2_000, "alpha", "b")]);
    const held = pollLogsStore(store);
    store = held.store;

    expect(held.result.records).toEqual([]); // nothing delivered while paused
    expect(held.result.skipped).toBe(true); // a frozen poll does not read at all
    expect(store.cursor).toBe(""); // the cursor did not move

    store = setLogsPaused(store, false);
    const resumed = pollLogsStore(store);

    expect(resumed.result.records.map((r) => r.message)).toEqual(["a", "b"]);
    expect(resumed.store.buffer.records.map((r) => r.message)).toEqual(["a", "b"]);
  });

  it("performs no read at all while frozen, so a hidden tab costs no I/O", () => {
    let reads = 0;
    const reader: LogsReader = {
      read: (query) => {
        reads += 1;
        return readLogView(query);
      },
      now: () => 1,
    };
    writeRecords([rec(1_000, "alpha", "a")]);
    let store = createLogsStore({ reader });
    ({ store } = pollLogsStore(store));
    expect(reads).toBe(1);

    // The pause freezes the READ, not only the delivery: the cursor already
    // names the position the stream stopped at, so a frozen poll has nothing to
    // learn — and the Activity view is frozen for every tick the Logs tab is
    // hidden, which is where a per-tick full scan would actually be paid.
    store = setLogsPaused(store, true);
    writeRecords([rec(2_000, "alpha", "b")]);
    const paused = pollLogsStore(store);
    expect(reads).toBe(1);
    expect(paused.result.skipped).toBe(true);
    expect(paused.store).toBe(store); // the same store: nothing to publish

    const hidden = pollLogsStore(store, { hostPaused: true });
    expect(reads).toBe(1);
    expect(hidden.store).toBe(store);
    expect(hidden.result.records).toEqual([]);

    // Resume reads once, from the frozen cursor, and delivers the withheld
    // window — nothing repeated, nothing lost.
    store = setLogsPaused(store, false);
    const resumed = pollLogsStore(store);
    expect(reads).toBe(2);
    // `a` was delivered before the pause and stays in the buffer; the withheld
    // window is `b`, delivered exactly once on resume.
    expect(resumed.result.records.map((r) => r.message)).toEqual(["b"]);
    expect(resumed.store.buffer.records.map((r) => r.message)).toEqual(["a", "b"]);
  });

  it("keeps the records shown before the pause on screen while paused", () => {
    writeRecords([rec(1_000, "alpha", "a")]);
    let store = createLogsStore({ reader: { read: readLogView, now: () => 1 } });
    ({ store } = pollLogsStore(store));
    const before = store.buffer.records.map((r) => r.message);

    store = toggleLogsPaused(store);
    writeRecords([rec(2_000, "alpha", "b")]);
    ({ store } = pollLogsStore(store));

    expect(store.buffer.records.map((r) => r.message)).toEqual(before);
    expect(store.paused).toBe(true);
  });

  it("freezes for a paused HOST exactly like the pause key does", () => {
    let store = createLogsStore({ reader: { read: readLogView, now: () => 1 } });
    writeRecords([rec(1_000, "alpha", "a")]);
    ({ store } = pollLogsStore(store));

    // The host view switch freezes the stream. The store's `cursor` keeps
    // naming the last record the pane SHOWED (that is what a paused pane
    // prints); the frozen cursor is the position the next poll resumes from.
    writeRecords([rec(2_000, "alpha", "b")]);
    const shownBefore = store.cursor;
    const hidden = pollLogsStore(store, { hostPaused: true });
    expect(hidden.result.records).toEqual([]);
    expect(hidden.store.cursor).toBe(shownBefore);
    expect(hidden.store.buffer.records.map((r) => r.message)).toEqual(["a"]);

    // While frozen, nothing advances and nothing is lost.
    writeRecords([rec(3_000, "alpha", "c")]);
    const stillHidden = pollLogsStore(hidden.store, { hostPaused: true });
    expect(stillHidden.result.records).toEqual([]);
    expect(stillHidden.store.buffer.records.map((r) => r.message)).toEqual(["a"]);

    // Resume delivers exactly the window the freeze withheld — the buffer keeps
    // what was already on screen, so nothing is repeated and nothing is lost.
    const shown = pollLogsStore(stillHidden.store);
    expect(shown.result.records.map((r) => r.message)).toEqual(["b", "c"]);
    expect(shown.store.buffer.records.map((r) => r.message)).toEqual(["a", "b", "c"]);
  });

  it("toggles back to the same state when paused twice", () => {
    const store = realStore();
    expect(toggleLogsPaused(toggleLogsPaused(store)).paused).toBe(false);
    expect(setLogsPaused(store, false)).toBe(store); // a no-op returns the same object
  });
});

// ── Bounded buffer ──────────────────────────────────────────────────────

describe("appendLogsRecords — the bounded buffer", () => {
  it("keeps the newest BUFFER_LIMIT records and counts what it dropped", () => {
    const incoming = Array.from({ length: BUFFER_LIMIT + 25 }, (_, i) => rec(i, "alpha", `m${i}`));

    const buffer = appendLogsRecords({ records: [], dropped: 0, totalDropped: 0 }, incoming);

    expect(buffer.records).toHaveLength(BUFFER_LIMIT);
    expect(buffer.dropped).toBe(25);
    expect(buffer.records[0]?.message).toBe("m25");
    expect(buffer.records[buffer.records.length - 1]?.message).toBe(`m${BUFFER_LIMIT + 24}`);
  });

  it("counts every dropped record exactly, including one that overflows alone", () => {
    const empty: LogsBuffer = { records: [], dropped: 0, totalDropped: 0 };
    const full = appendLogsRecords(empty, [rec(1, "alpha", "a"), rec(2, "alpha", "b"), rec(3, "alpha", "c")], 3);
    expect(full.dropped).toBe(0);

    const overflowed = appendLogsRecords(full, [rec(4, "alpha", "d")], 3);

    expect(overflowed.records.map((r) => r.message)).toEqual(["b", "c", "d"]);
    expect(overflowed.dropped).toBe(1);
    // The earlier-view ledger belongs to views this one REPLACED; a cap
    // overflow inside the live view is `dropped` alone.
    expect(overflowed.totalDropped).toBe(0);
  });

  it("leaves the earlier-view ledger alone, so the status line sums the loss once", () => {
    const first = appendLogsRecords({ records: [], dropped: 0, totalDropped: 0 }, Array.from({ length: BUFFER_LIMIT + 1 }, (_, i) => rec(i, "alpha", `a${i}`)));
    expect(first.dropped).toBe(1);

    const second = appendLogsRecords(first, [rec(9_000, "alpha", "new")]);

    expect(second.dropped).toBe(2);
    // Appending happens INSIDE the current view, so nothing moves into the
    // ledger: two records were dropped in total, and the line says so once.
    expect(second.totalDropped).toBe(0);
    const line = logsStatusText({ ...logsDropCounts(second), shown: second.records.length, total: second.records.length, pending: false, skippedLines: 0 });
    expect(line).toContain("2 dropped");
    expect(line).not.toContain("earlier");
  });

  it("keeps two identical records that share one millisecond, and drops neither", () => {
    // Nothing in a record is unique — no id, no sequence, and the writer stamps
    // whole milliseconds — so two identical lines inside one millisecond are
    // indistinguishable from each other and BOTH really happened. Suppressing
    // the second one is silent loss: the buffer would report `dropped = 0`.
    const record = rec(1_000, "alpha", "same");
    const twice = appendLogsRecords({ records: [], dropped: 0, totalDropped: 0 }, [record, record]);

    expect(twice.records).toHaveLength(2);
    expect(twice.records.map((r) => r.message)).toEqual(["same", "same"]);
    expect(twice.dropped).toBe(0);
    expect(twice.totalDropped).toBe(0);
  });

  it("returns the same buffer object for an empty delivery", () => {
    const buffer: LogsBuffer = { records: [], dropped: 0, totalDropped: 0 };
    expect(appendLogsRecords(buffer, [])).toBe(buffer);
  });
});

// ── Filters and view identity ───────────────────────────────────────────

describe("view identity", () => {
  it("normalises a partial filter set into a complete, deduplicated one", () => {
    const filters = normalizeLogsFilters({ channels: ["a", "a", "", "b"], minLevel: "nope" as LogLevel });
    expect(filters.channels).toEqual(["a", "b"]);
    expect(filters.minLevel).toBe("info");
    expect(filters.sessionId).toBe("");
    expect(filters.logDir).toBe("");
  });

  it("changes identity with the level, the channels, the session and the resolved source", () => {
    const base = normalizeLogsFilters({ logDir: dir });
    const identity = logsIdentity(base);

    expect(logsIdentity(setLogsFilters(createLogsStore({ filters: { logDir: dir } }), { minLevel: "warn" }).filters)).not.toBe(identity);
    expect(logsIdentity(setLogsChannel(createLogsStore({ filters: { logDir: dir } }), "alpha").filters)).not.toBe(identity);
    expect(logsIdentity(setLogsSession(createLogsStore({ filters: { logDir: dir } }), "ses_1").filters)).not.toBe(identity);
    expect(logsIdentity({ ...base, logDir: join(dir, "other") })).not.toBe(identity);
  });

  it("starts on EVERY session, because no producer writes scope.sessionId", () => {
    writeRecords([rec(1_000, "alpha", "plain", { scope: {} })]);

    // The store the TUI builds has no session filter (state.tsx calls
    // `createLogsStore()`): narrowing by the host slot's session would filter
    // EVERY record away, because nothing in src/ writes `scope.sessionId` — a
    // full log directory would paint as `0/0 records`.
    const store = createLogsStore({ reader: { read: readLogView, now: () => 1 } });
    expect(store.filters.sessionId).toBe("");
    expect(pollLogsStore(store).result.records.map((r) => r.message)).toEqual(["plain"]);

    // The narrowing itself still works, for a source that really carries the
    // field: it is opt-in, not the default.
    const narrowed = createLogsStore({
      filters: { sessionId: "ses_present" },
      reader: { read: readLogView, now: () => 1 },
    });
    expect(pollLogsStore(narrowed).result.records).toEqual([]);
  });

  it("follows the writer's chain when no directory is configured", () => {
    expect(logsIdentity(normalizeLogsFilters())).toContain(resolveLogSource().path);
  });

  it("resets the cursor and the buffer when the filter changes, then re-paints", () => {
    writeRecords([rec(1_000, "alpha", "a"), rec(2_000, "beta", "b")]);
    let store = createLogsStore({ reader: { read: readLogView, now: () => 1 } });
    ({ store } = pollLogsStore(store));
    expect(store.buffer.records).toHaveLength(2);
    const oldCursor = store.cursor;

    store = setLogsChannel(store, "beta");
    const changed = pollLogsStore(store);
    store = changed.store;

    // A cursor is a TIME watermark, so the new view's first paint can name the
    // same instant as the old one; what must not survive the switch is the
    // BUFFER, and what must not leak into the new view is the old channel.
    expect(changed.result.reset).toBe(true);
    expect(store.buffer.records.map((r) => r.message)).toEqual(["b"]);
    expect(store.buffer.records.some((r) => r.channel === "alpha")).toBe(false);
    expect(oldCursor.length).toBeGreaterThan(0);

    writeRecords([rec(3_000, "alpha", "a2"), rec(4_000, "beta", "b2")]);
    ({ store } = pollLogsStore(store));

    expect(store.buffer.records.map((r) => r.message)).toEqual(["b", "b2"]);
  });

  it("clears the buffer and the cursor at the moment the filter changes", () => {
    writeRecords([rec(1_000, "alpha", "a"), rec(2_000, "beta", "b")]);
    let store = createLogsStore({ reader: { read: readLogView, now: () => 1 } });
    ({ store } = pollLogsStore(store));
    expect(store.buffer.records).toHaveLength(2);

    store = setLogsFilters(store, { minLevel: "warn" });

    // No poll has run yet, and the pane already holds nothing: the filter it
    // advertises is the filter its records satisfy, at every instant.
    expect(store.buffer.records).toEqual([]);
    expect(store.cursor).toBe("");
    expect(store.source).toBeNull();
  });

  it("resets for a channel, a session and a directory change too, but not for an identical set", () => {
    const store = setLogsChannel(createLogsStore(), "alpha");

    // Same identity → the buffer survives (nothing to reset).
    expect(setLogsChannel(store, "alpha").buffer).toEqual(store.buffer);
    expect(setLogsFilters(store, { channels: ["alpha"] }).filters.channels).toEqual(["alpha"]);
    expect(setLogsChannel(store, "beta").buffer.records).toEqual([]);
    expect(setLogsSession(store, "ses_1").filters.sessionId).toBe("ses_1");
    expect(setLogsFilters(store, { logDir: join(dir, "other") }).cursor).toBe("");
  });

  it("starts a new view when the filter changes while paused, and resumes into THAT view", () => {
    writeRecords([rec(1_000, "alpha", "a"), rec(2_000, "beta", "b")]);
    let store = createLogsStore({ reader: { read: readLogView, now: () => 1 } });
    ({ store } = pollLogsStore(store));
    store = setLogsPaused(store, true);
    expect(store.buffer.records).toHaveLength(2);

    // Paused and re-filtered: the buffer belongs to the OLD view, and so does
    // the snapshot a resume would restore. Both go, or the pane comes back with
    // an `alpha` row under a `chan beta` header.
    store = setLogsChannel(store, "beta");
    expect(store.buffer.records).toEqual([]);
    expect(store.frozenBuffer.records).toEqual([]);
    expect(store.frozenCursor).toBe("");

    store = setLogsPaused(store, false);
    ({ store } = pollLogsStore(store));

    expect(store.buffer.records.map((r) => r.message)).toEqual(["b"]);
    expect(store.buffer.records.some((r) => r.channel === "alpha")).toBe(false);
  });

  it("carries exactly what the discarded view dropped into the earlier-view ledger", () => {
    // A REACHABLE buffer: a view that really dropped 7 records and was never
    // reset. (`dropped: 7, totalDropped: 3` cannot happen — the ledger only
    // ever ABSORBS `dropped` at a reset, it is never added to separately.)
    const saturated = appendLogsRecords(
      { records: [], dropped: 0, totalDropped: 0 },
      Array.from({ length: BUFFER_LIMIT + 7 }, (_, i) => rec(i, "alpha", `m${i}`)),
    );
    expect(saturated.dropped).toBe(7);
    expect(saturated.totalDropped).toBe(0);

    const polled = pollLogsStore({ ...createLogsStore({ reader: { read: readLogView, now: () => 1 } }), buffer: saturated, identity: "stale" });

    expect(polled.store.buffer.dropped).toBe(0);
    expect(polled.store.buffer.totalDropped).toBe(7);
  });

  it("sends level, channels, session and directory to the reader", () => {
    const store = setLogsFilters(createLogsStore(), { minLevel: "warn", channels: ["alpha"], sessionId: "ses_9" });
    expect(logsQuery(store)).toMatchObject({
      minLevel: "warn",
      channels: ["alpha"],
      sessionId: "ses_9",
      order: "asc",
      limit: POLL_LIMIT,
    });
  });

  it("filters through the reader's own query, not in the pane", () => {
    writeRecords([rec(1_000, "alpha", "a", { level: "warn" }), rec(2_000, "beta", "b", { level: "debug" })]);
    const store = setLogsFilters(createLogsStore({ reader: { read: readLogView, now: () => 1 } }), { minLevel: "warn" });

    const { result } = pollLogsStore(store);

    expect(result.records.map((r) => r.message)).toEqual(["a"]);
  });
});

// ── Level and channel controls ──────────────────────────────────────────

describe("level and channel controls", () => {
  it("steps the threshold one rank at a time and clamps at both ends", () => {
    let store = createLogsStore(); // info
    store = stepLogsLevel(store, 1);
    expect(store.filters.minLevel).toBe("warn");
    store = stepLogsLevel(store, 1);
    store = stepLogsLevel(store, 1);
    store = stepLogsLevel(store, 1);
    expect(store.filters.minLevel).toBe("fatal");
    store = stepLogsLevel(store, -1);
    store = stepLogsLevel(store, -1);
    store = stepLogsLevel(store, -1);
    store = stepLogsLevel(store, -1);
    expect(store.filters.minLevel).toBe("debug");
    expect(stepLogsLevel(setLogsFilters(store, { minLevel: "fatal" }), 1).filters.minLevel).toBe("fatal");
  });

  it("cycles the channel filter once through each channel and then clears it", () => {
    let store = createLogsStore();
    store = cycleLogsChannel(store, ["alpha", "beta"]);
    expect(store.filters.channels).toEqual(["alpha"]);
    store = cycleLogsChannel(store, ["alpha", "beta"]);
    expect(store.filters.channels).toEqual(["beta"]);
    store = cycleLogsChannel(store, ["alpha", "beta"]);
    expect(store.filters.channels).toEqual([]);
    expect(cycleLogsChannel(store, [])).toBe(store);
  });

  it("restarts the cycle when the current filter names a channel that is gone", () => {
    const store = setLogsChannel(createLogsStore(), "gamma");
    expect(cycleLogsChannel(store, ["alpha", "beta"]).filters.channels).toEqual(["alpha"]);
  });

  it("replaces channels only when the patch names them", () => {
    const store = setLogsChannel(createLogsStore(), "alpha");
    expect(setLogsFilters(store, { minLevel: "error" }).filters.channels).toEqual(["alpha"]);
    expect(setLogsFilters(store, { channels: [] }).filters.channels).toEqual([]);
  });

  it("spells the mode words the pane prints", () => {
    expect(logsModeText("open")).toBe("live");
    expect(logsModeText("paused")).toBe("paused");
    expect(logsModeText("hidden")).toBe("hidden");
    expect(logsStatusText("paused")).toBe("paused");
  });
});

// ── Failure degradation ─────────────────────────────────────────────────

describe("read failure degradation", () => {
  it("turns a throwing read into an error state without throwing", () => {
    const reader: LogsReader = {
      read: () => {
        throw new Error("disk on fire");
      },
      now: () => 777,
    };
    let store = createLogsStore({ reader });
    ({ store } = pollLogsStore(store));

    const failed = pollLogsStore(store);

    expect(failed.result.error).toEqual({ message: "disk on fire", time: 777 });
    expect(failed.result.records).toEqual([]);
    expect(failed.store.error?.message).toBe("disk on fire");
  });

  it("keeps the last good records and cursor on screen while failing", () => {
    writeRecords([rec(1_000, "alpha", "a")]);
    let store = createLogsStore({ reader: { read: readLogView, now: () => 1 } });
    ({ store } = pollLogsStore(store));
    const good = store.buffer.records.map((r) => r.message);
    const cursor = store.cursor;

    const failing: LogsStore = { ...store };
    const failed = pollLogsStore(failing, {
      reader: {
        read: () => {
          throw new Error("nope");
        },
        now: () => 2,
      },
    });

    expect(failed.store.buffer.records.map((r) => r.message)).toEqual(good);
    expect(failed.store.cursor).toBe(cursor);
  });

  it("clears the error on the next successful poll", () => {
    writeRecords([rec(1_000, "alpha", "a")]);
    let store = createLogsStore({ reader: { read: readLogView, now: () => 1 } });
    ({ store } = pollLogsStore(store));
    ({ store } = pollLogsStore(store, {
      reader: {
        read: () => {
          throw new Error("transient");
        },
        now: () => 2,
      },
    }));
    expect(store.error).not.toBeNull();

    ({ store } = pollLogsStore(store));

    expect(store.error).toBeNull();
    expect(store.buffer.records.map((r) => r.message)).toEqual(["a"]);
  });

  it("falls back to the last good source when a poll fails", () => {
    writeRecords([rec(1_000, "alpha", "a")]);
    let store = createLogsStore({ reader: { read: readLogView, now: () => 1 } });
    ({ store } = pollLogsStore(store));

    const failed = pollLogsStore(store, {
      reader: {
        read: () => {
          throw new Error("boom");
        },
        now: () => 3,
      },
    });

    expect(failed.store.source).toEqual({ kind: "dir", path: dir });
  });
});

// ── Hygiene ─────────────────────────────────────────────────────────────

describe("hygiene", () => {
  it("never writes into the workspace while this suite runs", () => {
    // A fresh checkout has no .rolebox/ at all (CI does not create one), so the
    // guarantee is that this suite never RESOLVES to the workspace's dir — not
    // that the workspace has one.
    const workspaceDir = join(process.cwd(), ".rolebox", "logs");
    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(resolveLogSource().path).toBe(dir);
    expect(resolveLogSource().path).not.toBe(workspaceDir);
  });
});

// ── Channel collection and buffer-overflow ──────────────────────────────

describe("collectLogChannels", () => {
  it("answers the channels present in the buffer, sorted and de-duplicated", () => {
    expect(collectLogChannels([
      rec(1, "beta", "b"),
      rec(2, "alpha", "a"),
      rec(3, "beta", "b2"),
    ])).toEqual(["alpha", "beta"]);
  });

  it("answers an empty list for an empty buffer and drops blank channel names", () => {
    expect(collectLogChannels([])).toEqual([]);
    expect(collectLogChannels([rec(1, "", "no channel")])).toEqual([]);
  });
});

describe("the buffer cap in steady state", () => {
  it("keeps exactly BUFFER_LIMIT records and counts every record it drops, one poll at a time", () => {
    let buffer: LogsBuffer = { records: [], dropped: 0, totalDropped: 0 };
    // One poll per record, the way a live pane actually fills up.
    for (let i = 0; i < BUFFER_LIMIT + 7; i += 1) {
      buffer = appendLogsRecords(buffer, [rec(i, "alpha", `m${i}`)]);
    }

    expect(buffer.records).toHaveLength(BUFFER_LIMIT);
    expect(buffer.dropped).toBe(7);
    // Nothing was reset, so nothing is "earlier": the ledger counts the views
    // this one replaced. `7 dropped (7 earlier)` for these seven records — what
    // the pane printed before this fix — reported the same loss twice.
    expect(buffer.totalDropped).toBe(0);
    expect(buffer.records[0]?.message).toBe("m7");
    expect(buffer.records[buffer.records.length - 1]?.message).toBe(`m${BUFFER_LIMIT + 6}`);
  });
});

// ── The drop ledger, through the production mapping ─────────────────────

/**
 * The pane prints both drop counters through `logsDropCounts` — the same call
 * `src/tui/state.tsx` makes — and `logsStatusText`. These cases drive real
 * buffers (one of them through the real file sink, the real reader and the real
 * store) and assert the LINE a reader sees, so a ledger that double counts is
 * caught where it becomes visible instead of where it is stored.
 */
describe("the drop ledger the pane prints", () => {
  it("prints one number while the view has never been reset", () => {
    let buffer: LogsBuffer = { records: [], dropped: 0, totalDropped: 0 };
    for (let i = 0; i < BUFFER_LIMIT + 7; i += 1) buffer = appendLogsRecords(buffer, [rec(i, "alpha", `m${i}`)]);

    const counts = logsDropCounts(buffer);
    const line = logsStatusText({ ...counts, shown: buffer.records.length, total: buffer.records.length, pending: false, skippedLines: 0 });

    expect(counts).toEqual({ dropped: 7, earlierDropped: 0 });
    expect(line).toContain("7 dropped");
    // THE DEFECT THIS PINS: this line used to read `7 dropped (7 earlier)` for
    // these same seven records, so a reader adding the halves saw fourteen.
    expect(line).not.toContain("earlier");
  });

  it("moves exactly what a reset discarded into `earlier`, once, from a real store", () => {
    // A REAL VIEW FILLING UP: three waves through the platform's own file sink,
    // each drained by one poll, so the cap overflows inside the live view.
    const all = Array.from({ length: BUFFER_LIMIT + 7 }, (_, i) => rec(1_000 + i, "alpha", `m${i}`));
    writeRecords(all.slice(0, POLL_LIMIT));
    let store = createLogsStore({ reader: { read: readLogView, now: () => 1 } });

    ({ store } = pollLogsStore(store));
    expect(store.buffer.records).toHaveLength(POLL_LIMIT);
    writeRecords(all.slice(POLL_LIMIT, POLL_LIMIT * 2));
    ({ store } = pollLogsStore(store));
    expect(store.buffer.records).toHaveLength(POLL_LIMIT * 2);
    writeRecords(all.slice(POLL_LIMIT * 2));
    ({ store } = pollLogsStore(store));

    expect(store.buffer.records).toHaveLength(BUFFER_LIMIT);
    expect(store.buffer.dropped).toBe(7);
    expect(store.buffer.totalDropped).toBe(0);
    const live = logsStatusText({ ...logsDropCounts(store.buffer), shown: BUFFER_LIMIT, total: BUFFER_LIMIT, pending: store.pending, skippedLines: store.skippedLines });
    expect(live).toContain("7 dropped");
    expect(live).not.toContain("earlier");

    // The level key the pane wires: one threshold step IS the reset, and the
    // reset is what discards the records the buffer could not keep.
    store = stepLogsLevel(store, 1);
    expect(store.buffer.records).toEqual([]);
    expect(store.buffer.dropped).toBe(0);
    expect(store.buffer.totalDropped).toBe(7);

    // The poll that follows (the next 1s tick) leaves the ledger alone.
    ({ store } = pollLogsStore(store));

    const counts = logsDropCounts(store.buffer);
    const after = logsStatusText({ ...counts, shown: 0, total: 0, pending: store.pending, skippedLines: store.skippedLines });
    expect(after).toContain("0 dropped (7 earlier)");
    // The reader's own arithmetic is the truth: 0 + 7 = what was really lost.
    expect(counts.dropped + counts.earlierDropped).toBe(7);
  });

  it("adds a second view's losses on top of the ledger, never on top of itself", () => {
    const saturated = appendLogsRecords(
      { records: [], dropped: 0, totalDropped: 0 },
      Array.from({ length: BUFFER_LIMIT + 3 }, (_, i) => rec(i, "alpha", `a${i}`)),
    );

    let store = setLogsFilters({ ...createLogsStore(), buffer: saturated }, { minLevel: "warn" });
    expect(store.buffer.dropped).toBe(0);
    expect(store.buffer.totalDropped).toBe(3);

    // A second reset while the new view has dropped nothing must not re-add the
    // first view's losses: the ledger is carried forward, not recomputed.
    store = setLogsFilters(store, { minLevel: "error" });
    expect(logsDropCounts(store.buffer)).toEqual({ dropped: 0, earlierDropped: 3 });
  });
});
