/**
 * THE READ SIDE OF THE LOG FILES.
 *
 * Every case builds its data in a temporary directory — through the REAL file
 * sink, so the bytes on disk are the ones the writer produces — and reads them
 * back with the query API. Malformed lines are written by hand, because no sink
 * would ever produce one. The workspace's own `.rolebox/logs/` is never touched:
 * the shared helper points ROLEBOX_LOG_DIR at an OS temporary directory, and
 * every test removes it again.
 *
 * The follower is stepped, not waited for: it takes its waiter as an option, so
 * each case resolves one poll at a time and asserts what arrived.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_FOLLOW_POLL_MS,
  DEFAULT_LOG_CHANNEL,
  DEFAULT_LOG_QUERY_LIMIT,
  DEFAULT_LOG_ROLE,
  followLogRecords,
  listLogFiles,
  pruneLogs,
  readLogRecords,
  resolveLogSource,
  type LogQuery,
  type LogRecord,
} from "../../src/log/index.ts";
import { createFileSink } from "../../src/log/sinks/file.ts";
import { beginLogTest, endLogTest, makeRecord, setLogEnv } from "../helpers/log.ts";

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

/** Write records through the REAL file sink; answer the file it wrote them to. */
function writeThroughSink(
  dir: string,
  records: readonly LogRecord[],
  options: { maxBytes?: number; retain?: number } = {},
): string {
  const sink = createFileSink({ dir, maxBytes: options.maxBytes, retain: options.retain });
  for (const record of records) sink(record);
  sink.close();
  return sink.pathFor(records[0]?.channel ?? DEFAULT_LOG_CHANNEL);
}

/** A waiter a test steps by hand: `advance()` resolves the pending poll once. */
function manualSleeper(): { sleep: (ms: number) => Promise<void>; delays: number[]; advance: () => Promise<void> } {
  const delays: number[] = [];
  let wake: (() => void) | undefined;
  const sleep = (ms: number): Promise<void> => {
    delays.push(ms);
    return new Promise<void>((resolve) => {
      wake = resolve;
    });
  };
  const advance = async (): Promise<void> => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
    // A macrotask, so the follower's continuation (its poll) has run.
    await new Promise<void>((done) => setTimeout(done, 0));
  };
  return { sleep, delays, advance };
}

describe("listLogFiles", () => {
  it("answers an empty list for a directory that does not exist", () => {
    expect(listLogFiles({ logDir: join(state.dir, "missing") })).toEqual([]);
  });

  it("lists the active file and its rotated copies with rotation numbers and sizes", () => {
    const path = writeThroughSink(state.dir, [rec(1, "alpha", "a"), rec(2, "alpha", "b")]);
    renameSync(path, path + ".1");
    writeFileSync(path, JSON.stringify(rec(3, "alpha", "c")) + "\n");
    writeFileSync(join(state.dir, "notes.txt"), "not a log\n");

    const files = listLogFiles({ logDir: state.dir });
    expect(files.map((file) => [file.channel, file.rotation])).toEqual([
      ["alpha", 0],
      ["alpha", 1],
    ]);
    expect(files[0]!.path).toBe(path);
    expect(files[0]!.sizeBytes).toBe(readFileSync(path).length);
    expect(files[0]!.mtimeMs).toBeGreaterThan(0);
    expect(files[1]!.path).toBe(path + ".1");
  });

  it("reports the one legacy file and its rotations instead of every .log file", () => {
    const legacy = join(state.dir, "rolebox.log");
    setLogEnv("ROLEBOX_LOG_FILE", legacy);
    writeFileSync(legacy, JSON.stringify(rec(1, "alpha", "a")) + "\n");
    writeFileSync(legacy + ".1", JSON.stringify(rec(2, "beta", "b")) + "\n");
    writeFileSync(join(state.dir, "unrelated.log"), JSON.stringify(rec(3, "other", "c")) + "\n");

    expect(listLogFiles().map((file) => [file.channel, file.rotation])).toEqual([
      ["rolebox", 0],
      ["rolebox", 1],
    ]);
  });
});

describe("explicit location precedence", () => {
  /**
   * `<state.dir>/mine.log` (the legacy single file) with two rotated copies, and
   * `<state.dir>/requested` holding another channel's active file and rotation.
   * The two sources hold DIFFERENT messages, so a read that used the wrong one
   * cannot pass by accident.
   */
  function writeTwoSources(): { legacy: string; requested: string } {
    const legacy = join(state.dir, "mine.log");
    writeFileSync(legacy, JSON.stringify(rec(1, "alpha", "legacy active")) + "\n");
    writeFileSync(legacy + ".1", JSON.stringify(rec(2, "alpha", "legacy rotation 1")) + "\n");
    writeFileSync(legacy + ".2", JSON.stringify(rec(3, "alpha", "legacy rotation 2")) + "\n");
    const requested = join(state.dir, "requested");
    mkdirSync(requested, { recursive: true });
    writeFileSync(join(requested, "other.log"), JSON.stringify(rec(4, "other", "requested active")) + "\n");
    writeFileSync(join(requested, "other.log.1"), JSON.stringify(rec(5, "other", "requested rotation")) + "\n");
    return { legacy, requested };
  }

  it("resolves an explicit logDir to that directory, whatever ROLEBOX_LOG_FILE says", () => {
    const { legacy, requested } = writeTwoSources();
    setLogEnv("ROLEBOX_LOG_FILE", legacy);

    // The environment's legacy file only decides when the caller names nothing.
    expect(resolveLogSource({ logDir: requested })).toEqual({ kind: "dir", path: requested });
    expect(resolveLogSource({ logFile: legacy, logDir: requested })).toEqual({ kind: "file", path: legacy });
    expect(resolveLogSource()).toEqual({ kind: "file", path: legacy });
    expect(resolveLogSource({ logDir: "  " })).toEqual({ kind: "file", path: legacy });
  });

  it("lists and reads only the explicit logDir while the legacy file is set", () => {
    const { legacy, requested } = writeTwoSources();
    setLogEnv("ROLEBOX_LOG_FILE", legacy);

    expect(listLogFiles({ logDir: requested }).map((file) => [file.channel, file.rotation])).toEqual([
      ["other", 0],
      ["other", 1],
    ]);
    const result = readLogRecords({ logDir: requested });
    expect(result.scannedFiles).toBe(2);
    expect(result.records.map((record) => record.message)).toEqual(["requested active", "requested rotation"]);
  });

  it("prunes only inside the explicit logDir and leaves the legacy file's rotations alone", () => {
    const { legacy, requested } = writeTwoSources();
    setLogEnv("ROLEBOX_LOG_FILE", legacy);

    const result = pruneLogs({ logDir: requested, keepRotated: 0 });
    expect(result.removed.map((removal) => removal.path)).toEqual([join(requested, "other.log.1")]);
    expect(existsSync(join(requested, "other.log"))).toBe(true);
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(legacy + ".1")).toBe(true);
    expect(existsSync(legacy + ".2")).toBe(true);
  });

  it("still answers the legacy file when no location is given", () => {
    const { legacy } = writeTwoSources();
    setLogEnv("ROLEBOX_LOG_FILE", legacy);

    expect(listLogFiles().map((file) => [file.channel, file.rotation])).toEqual([
      ["mine", 0],
      ["mine", 1],
      ["mine", 2],
    ]);
    const messages = readLogRecords().records.map((record) => record.message);
    expect(messages).toEqual(["legacy active", "legacy rotation 1", "legacy rotation 2"]);
    expect(messages.some((message) => message.startsWith("requested"))).toBe(false);
  });
});

describe("readLogRecords", () => {
  it("merges every channel and sorts the records by time", () => {
    writeThroughSink(state.dir, [rec(300, "beta", "third"), rec(100, "beta", "first")]);
    writeThroughSink(state.dir, [rec(200, "alpha", "second")]);

    const result = readLogRecords({ logDir: state.dir });
    expect(result.records.map((record) => record.message)).toEqual(["first", "second", "third"]);
    expect(result.scannedFiles).toBe(2);
    expect(result.skippedLines).toBe(0);
    expect(result.malformedSamples).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("filters by level list and by minimum level", () => {
    const levels = ["debug", "info", "warn", "error", "fatal"] as const;
    writeThroughSink(
      state.dir,
      levels.map((level, index) => rec(100 + index, "levels", level, { level })),
    );

    expect(readLogRecords({ logDir: state.dir, levels: ["warn", "error"] }).records.map((r) => r.level)).toEqual([
      "warn",
      "error",
    ]);
    expect(readLogRecords({ logDir: state.dir, minLevel: "warn" }).records.map((r) => r.level)).toEqual([
      "warn",
      "error",
      "fatal",
    ]);
    expect(readLogRecords({ logDir: state.dir, levels: [] }).records.length).toBe(5);
  });

  it("filters by channel", () => {
    writeThroughSink(state.dir, [rec(100, "alpha", "a")]);
    writeThroughSink(state.dir, [rec(200, "beta", "b")]);

    expect(readLogRecords({ logDir: state.dir, channels: ["beta"] }).records.map((r) => r.message)).toEqual(["b"]);
    expect(readLogRecords({ logDir: state.dir, channels: ["beta", "alpha"] }).records.map((r) => r.message)).toEqual([
      "a",
      "b",
    ]);
    expect(readLogRecords({ logDir: state.dir, channels: ["gamma"] }).records).toEqual([]);
  });

  it("filters by event code, excluding records that carry none", () => {
    writeThroughSink(state.dir, [
      rec(100, "codes", "settled", { code: "graph.node.settled" }),
      rec(200, "codes", "advanced", { code: "graph.node.advanced" }),
      rec(300, "codes", "plain"),
    ]);

    expect(readLogRecords({ logDir: state.dir, codes: ["graph.node.settled"] }).records.map((r) => r.message)).toEqual(
      ["settled"],
    );
    expect(
      readLogRecords({ logDir: state.dir, codes: ["graph.node.settled", "graph.node.advanced"] }).records.map(
        (r) => r.message,
      ),
    ).toEqual(["settled", "advanced"]);
    expect(readLogRecords({ logDir: state.dir, codes: ["graph.node.unknown"] }).records).toEqual([]);
  });

  it("filters by each scope id", () => {
    writeThroughSink(state.dir, [
      rec(100, "scope", "in-graph", {
        scope: { graphId: "g1", runId: "r1", nodeId: "n1", attemptId: "a1", sessionId: "s1", tool: "read" },
      }),
      rec(200, "scope", "other-graph", { scope: { graphId: "g2", sessionId: "s2" } }),
      rec(300, "scope", "no-scope"),
    ]);
    const query = (filter: Partial<LogQuery>): string[] =>
      readLogRecords({ logDir: state.dir, ...filter }).records.map((record) => record.message);

    expect(query({ graphId: "g1" })).toEqual(["in-graph"]);
    expect(query({ runId: "r1" })).toEqual(["in-graph"]);
    expect(query({ nodeId: "n1" })).toEqual(["in-graph"]);
    expect(query({ attemptId: "a1" })).toEqual(["in-graph"]);
    expect(query({ sessionId: "s2" })).toEqual(["other-graph"]);
    expect(query({ tool: "read" })).toEqual(["in-graph"]);
    expect(query({ graphId: "g3" })).toEqual([]);
  });

  it("filters inclusively by time window", () => {
    writeThroughSink(
      state.dir,
      [100, 200, 300, 400].map((time) => rec(time, "window", "at-" + time)),
    );

    expect(readLogRecords({ logDir: state.dir, since: 200, until: 300 }).records.map((r) => r.message)).toEqual([
      "at-200",
      "at-300",
    ]);
    expect(readLogRecords({ logDir: state.dir, since: 350 }).records.map((r) => r.message)).toEqual(["at-400"]);
    expect(readLogRecords({ logDir: state.dir, until: 100 }).records.map((r) => r.message)).toEqual(["at-100"]);
    expect(readLogRecords({ logDir: state.dir, since: 500 }).records).toEqual([]);
  });

  it("searches message, fields and code case-insensitively", () => {
    writeThroughSink(state.dir, [
      rec(100, "alpha", "Disk Full", { fields: { detail: "rotation failed", count: 3 } }),
      rec(200, "beta", "all good", { code: "graph.node.settled" }),
      rec(300, "gamma", "nothing here"),
    ]);
    const query = (text: string): string[] =>
      readLogRecords({ logDir: state.dir, text }).records.map((record) => record.message);

    expect(query("disk full")).toEqual(["Disk Full"]);
    expect(query("rotation")).toEqual(["Disk Full"]);
    expect(query("3")).toEqual(["Disk Full"]);
    expect(query("node.settled")).toEqual(["all good"]);
    expect(query("beta")).toEqual(["all good"]);
    expect(query("  disk full  ")).toEqual(["Disk Full"]);
    expect(query("   ")).toEqual(["Disk Full", "all good", "nothing here"]);
    expect(query("absent")).toEqual([]);
  });

  it("reads the rotated copies the writer produced", () => {
    const sink = createFileSink({ dir: state.dir, maxBytes: 1, retain: 3 });
    for (let index = 1; index <= 3; index++) sink(rec(index * 100, "rolling", "m" + index));
    sink.close();

    expect(listLogFiles({ logDir: state.dir }).map((file) => file.rotation)).toEqual([0, 1, 2]);
    const result = readLogRecords({ logDir: state.dir });
    expect(result.scannedFiles).toBe(3);
    expect(result.records.map((record) => record.message)).toEqual(["m1", "m2", "m3"]);
  });

  it("reads every channel back out of the one legacy file", () => {
    const legacy = join(state.dir, "rolebox.log");
    setLogEnv("ROLEBOX_LOG_FILE", legacy);
    const sink = createFileSink({});
    sink(rec(200, "beta", "from-beta"));
    sink(rec(100, "alpha", "from-alpha"));
    sink.close();

    const result = readLogRecords();
    expect(result.scannedFiles).toBe(1);
    expect(result.records.map((record) => [record.time, record.channel, record.message])).toEqual([
      [100, "alpha", "from-alpha"],
      [200, "beta", "from-beta"],
    ]);
  });

  it("counts and samples malformed lines without losing the good ones", () => {
    const legacyLine = JSON.stringify({ "0": "legacy tslog line", _meta: {} });
    writeFileSync(
      join(state.dir, "broken.log"),
      [
        JSON.stringify(rec(100, "broken", "ok-1")),
        "{not json",
        "",
        "   ",
        JSON.stringify([1, 2, 3]),
        legacyLine,
        "null",
        JSON.stringify(rec(200, "broken", "ok-2", { level: "warn" })),
      ].join("\n") + "\n",
    );

    const result = readLogRecords({ logDir: state.dir });
    expect(result.records.map((record) => record.message)).toEqual(["ok-1", "ok-2"]);
    expect(result.skippedLines).toBe(4);
    expect(result.malformedSamples).toEqual(["{not json", "[1,2,3]", legacyLine, "null"]);
    expect(result.scannedFiles).toBe(1);
  });

  it("normalises a partial record instead of crashing on it", () => {
    writeFileSync(
      join(state.dir, "partial.log"),
      JSON.stringify({
        message: "bare",
        extra: "ignored",
        code: "graph.node.settled",
        fields: { keep: "yes", list: ["a", "b"], mixed: [1, "a"], nested: { deep: true }, count: 2 },
        scope: { graphId: "g1", rogue: "x", runId: "" },
      }) + "\n",
    );

    const record = readLogRecords({ logDir: state.dir }).records[0]!;
    expect(record.time).toBe(0);
    expect(record.level).toBe("info");
    expect(record.channel).toBe(DEFAULT_LOG_CHANNEL);
    expect(record.message).toBe("bare");
    expect(record.code).toBe("graph.node.settled");
    expect(record.fields).toEqual({ keep: "yes", list: ["a", "b"], count: 2 });
    expect(record.scope).toEqual({ graphId: "g1" });
    expect(record.process).toEqual({ pid: 0, role: DEFAULT_LOG_ROLE });

    const barePath = join(state.dir, "bare.log");
    writeFileSync(barePath, JSON.stringify({ time: 5, message: "no fields" }) + "\n");
    const bare = readLogRecords({ files: [barePath] }).records[0]!;
    expect(bare.fields).toEqual({});
    expect(bare.scope).toEqual({});
    expect(readLogRecords({ logDir: state.dir }).skippedLines).toBe(0);
  });

  it("answers empty for a missing directory and skips a missing explicit file", () => {
    const missing = join(state.dir, "missing");
    expect(listLogFiles({ logDir: missing })).toEqual([]);
    expect(readLogRecords({ logDir: missing })).toEqual({
      records: [],
      scannedFiles: 0,
      skippedLines: 0,
      malformedSamples: [],
      truncated: false,
    });
    expect(readLogRecords({ files: [join(missing, "gone.log")] })).toEqual({
      records: [],
      scannedFiles: 0,
      skippedLines: 0,
      malformedSamples: [],
      truncated: false,
    });
  });

  it("reads exactly the files a query names", () => {
    const alpha = writeThroughSink(state.dir, [rec(100, "alpha", "a")]);
    writeThroughSink(state.dir, [rec(200, "beta", "b")]);

    const result = readLogRecords({ logDir: state.dir, files: [alpha] });
    expect(result.records.map((record) => record.message)).toEqual(["a"]);
    expect(result.scannedFiles).toBe(1);
  });

  it("caps at the default limit and says the answer was truncated", () => {
    const lines: string[] = [];
    for (let index = 1; index <= DEFAULT_LOG_QUERY_LIMIT + 1; index++) {
      lines.push(JSON.stringify(rec(index, "many", "m" + index)));
    }
    writeFileSync(join(state.dir, "many.log"), lines.join("\n") + "\n");

    const result = readLogRecords({ logDir: state.dir });
    expect(result.records.length).toBe(DEFAULT_LOG_QUERY_LIMIT);
    expect(result.records[0]!.message).toBe("m1");
    expect(result.records.at(-1)!.message).toBe("m" + DEFAULT_LOG_QUERY_LIMIT);
    expect(result.truncated).toBe(true);
  });

  it("orders newest first on request and truncates from that end", () => {
    writeThroughSink(
      state.dir,
      [100, 200, 300].map((time) => rec(time, "order", "m" + time)),
    );

    expect(readLogRecords({ logDir: state.dir, order: "desc" }).records.map((r) => r.time)).toEqual([300, 200, 100]);
    const newest = readLogRecords({ logDir: state.dir, order: "desc", limit: 2 });
    expect(newest.records.map((r) => r.time)).toEqual([300, 200]);
    expect(newest.truncated).toBe(true);
    expect(readLogRecords({ logDir: state.dir, limit: 2 }).records.map((r) => r.time)).toEqual([100, 200]);
    expect(readLogRecords({ logDir: state.dir, limit: 0 }).records).toEqual([]);
  });
});

describe("followLogRecords", () => {
  it("delivers what is written after it starts, never the past, and stops", async () => {
    const path = writeThroughSink(state.dir, [rec(100, "live", "before")]);
    const sleeper = manualSleeper();
    const seen: LogRecord[] = [];
    const stop = followLogRecords({ logDir: state.dir, pollMs: 5, sleep: sleeper.sleep }, (record) => seen.push(record));
    expect(sleeper.delays).toEqual([5]);
    expect(seen).toEqual([]);

    appendFileSync(path, JSON.stringify(rec(200, "live", "after-1")) + "\n");
    await sleeper.advance();
    expect(seen.map((record) => record.message)).toEqual(["after-1"]);

    appendFileSync(path, JSON.stringify(rec(300, "live", "after-2")) + "\n");
    await sleeper.advance();
    expect(seen.map((record) => record.message)).toEqual(["after-1", "after-2"]);

    const pollsWhileRunning = sleeper.delays.length;
    stop();
    stop();
    appendFileSync(path, JSON.stringify(rec(400, "live", "after-3")) + "\n");
    await sleeper.advance();
    expect(seen.map((record) => record.message)).toEqual(["after-1", "after-2"]);
    expect(sleeper.delays.length).toBe(pollsWhileRunning);
  });

  it("picks up a channel's file that appears later", async () => {
    const sleeper = manualSleeper();
    const seen: LogRecord[] = [];
    const stop = followLogRecords({ logDir: state.dir, sleep: sleeper.sleep }, (record) => seen.push(record));
    await sleeper.advance();
    expect(seen).toEqual([]);

    writeThroughSink(state.dir, [rec(100, "late", "appeared")]);
    await sleeper.advance();
    expect(seen.map((record) => record.message)).toEqual(["appeared"]);
    stop();
  });

  it("follows a rotation without losing or repeating a line", async () => {
    const first = writeThroughSink(state.dir, [rec(100, "rot", "first")]);
    const sleeper = manualSleeper();
    const seen: LogRecord[] = [];
    const stop = followLogRecords({ logDir: state.dir, sleep: sleeper.sleep }, (record) => seen.push(record));

    appendFileSync(first, JSON.stringify(rec(200, "rot", "second")) + "\n");
    renameSync(first, first + ".1");
    writeThroughSink(state.dir, [rec(300, "rot", "third")]);

    await sleeper.advance();
    expect(seen.map((record) => record.message)).toEqual(["second", "third"]);
    await sleeper.advance();
    expect(seen.map((record) => record.message)).toEqual(["second", "third"]);
    stop();
  });

  it("keeps a file's offset while a rotation hides it from one poll", async () => {
    // THE RACE A REAL PROCESS PRODUCES. A concurrent rotation renames the file
    // between the follower's listing and its read, so one poll sees that file
    // under NO name at all. A ledger rebuilt from each poll's listing forgets
    // the offset, and the whole file is delivered a second time when it
    // reappears under its rotated name — the probe
    // (scripts/log-multiprocess-probe.ts) had a run that delivered 157 of 1200
    // records twice that way. The ledger is keyed by file identity and survives
    // the poll that could not see the file.
    const dir = state.dir;
    const path = writeThroughSink(dir, [rec(100, "moved", "one"), rec(200, "moved", "two")]);
    const sleeper = manualSleeper();
    const seen: LogRecord[] = [];
    const stop = followLogRecords({ logDir: dir, sleep: sleeper.sleep }, (record) => seen.push(record));

    await sleeper.advance();
    expect(seen).toEqual([]);

    appendFileSync(path, JSON.stringify(rec(300, "moved", "three")) + "\n");
    await sleeper.advance();
    expect(seen.map((record) => record.message)).toEqual(["three"]);

    // The file leaves the source for exactly one poll: the name it had is gone
    // and the name it will have does not exist yet.
    const parked = join(dir, "parked.tmp");
    renameSync(path, parked);
    await sleeper.advance();
    expect(seen.map((record) => record.message)).toEqual(["three"]);

    // It comes back under its rotated name; nothing may be replayed.
    renameSync(parked, path + ".1");
    await sleeper.advance();
    expect(seen.map((record) => record.message)).toEqual(["three"]);

    appendFileSync(path + ".1", JSON.stringify(rec(400, "moved", "four")) + "\n");
    await sleeper.advance();
    expect(seen.map((record) => record.message)).toEqual(["three", "four"]);
    stop();
  });

  it("applies the query's filters to what it delivers", async () => {
    const keep = writeThroughSink(state.dir, [rec(1, "keep", "seed")]);
    const drop = writeThroughSink(state.dir, [rec(1, "drop", "seed")]);
    const sleeper = manualSleeper();
    const seen: LogRecord[] = [];
    const stop = followLogRecords(
      { logDir: state.dir, channels: ["keep"], minLevel: "warn", sleep: sleeper.sleep },
      (record) => seen.push(record),
    );

    appendFileSync(keep, JSON.stringify(rec(200, "keep", "kept", { level: "warn" })) + "\n");
    appendFileSync(keep, JSON.stringify(rec(300, "keep", "too-quiet", { level: "info" })) + "\n");
    appendFileSync(drop, JSON.stringify(rec(400, "drop", "wrong-channel", { level: "error" })) + "\n");

    await sleeper.advance();
    expect(seen.map((record) => record.message)).toEqual(["kept"]);
    stop();
  });

  it("waits for a line's newline before delivering it", async () => {
    const path = writeThroughSink(state.dir, [rec(100, "partial", "seed")]);
    const sleeper = manualSleeper();
    const seen: LogRecord[] = [];
    const stop = followLogRecords({ logDir: state.dir, sleep: sleeper.sleep }, (record) => seen.push(record));

    appendFileSync(path, JSON.stringify(rec(200, "partial", "half")));
    await sleeper.advance();
    expect(seen).toEqual([]);

    appendFileSync(path, "\n");
    await sleeper.advance();
    expect(seen.map((record) => record.message)).toEqual(["half"]);
    stop();
  });

  it("stops on an aborted signal and passes the poll interval to the sleeper", async () => {
    const path = writeThroughSink(state.dir, [rec(100, "signal", "seed")]);
    const controller = new AbortController();
    const sleeper = manualSleeper();
    const seen: LogRecord[] = [];
    const stop = followLogRecords(
      { logDir: state.dir, signal: controller.signal, sleep: sleeper.sleep },
      (record) => seen.push(record),
    );
    expect(sleeper.delays).toEqual([DEFAULT_FOLLOW_POLL_MS]);

    controller.abort();
    appendFileSync(path, JSON.stringify(rec(200, "signal", "after-abort")) + "\n");
    await sleeper.advance();
    expect(seen).toEqual([]);
    expect(sleeper.delays.length).toBe(1);
    stop();
  });

  it("never polls when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const sleeper = manualSleeper();
    const seen: LogRecord[] = [];
    const stop = followLogRecords(
      { logDir: state.dir, signal: controller.signal, sleep: sleeper.sleep },
      (record) => seen.push(record),
    );

    expect(sleeper.delays).toEqual([]);
    await sleeper.advance();
    expect(seen).toEqual([]);
    stop();
  });
});

describe("pruneLogs", () => {
  it("removes rotated copies beyond the retention and never the active file", () => {
    const dir = state.dir;
    const sink = createFileSink({ dir, maxBytes: 1, retain: 5 });
    for (let index = 1; index <= 4; index++) sink(rec(index * 100, "prune", "m" + index));
    sink.close();
    expect(listLogFiles({ logDir: dir }).map((file) => file.rotation)).toEqual([0, 1, 2, 3]);

    const result = pruneLogs({ logDir: dir, keepRotated: 1 });
    expect(result.removed.map((entry) => entry.path).sort()).toEqual(
      [join(dir, "prune.log.2"), join(dir, "prune.log.3")].sort(),
    );
    expect(result.kept).toBe(1);
    expect(result.freedBytes).toBe(result.removed.reduce((total, entry) => total + entry.sizeBytes, 0));
    expect(result.freedBytes).toBeGreaterThan(0);
    expect(existsSync(join(dir, "prune.log"))).toBe(true);
    expect(existsSync(join(dir, "prune.log.1"))).toBe(true);
    expect(existsSync(join(dir, "prune.log.2"))).toBe(false);
    expect(existsSync(join(dir, "prune.log.3"))).toBe(false);
  });

  it("keeps the writer's retention when keepRotated is not given", () => {
    const dir = state.dir;
    const sink = createFileSink({ dir, maxBytes: 1, retain: 5 });
    for (let index = 1; index <= 5; index++) sink(rec(index * 100, "keep", "m" + index));
    sink.close();

    const result = pruneLogs({ logDir: dir });
    expect(result.removed.map((entry) => entry.path)).toEqual([join(dir, "keep.log.4")]);
    expect(result.kept).toBe(3);
  });

  it("reports what a dry run would remove and removes nothing", () => {
    const dir = state.dir;
    const sink = createFileSink({ dir, maxBytes: 1, retain: 5 });
    for (let index = 1; index <= 3; index++) sink(rec(index * 100, "dry", "m" + index));
    sink.close();

    const result = pruneLogs({ logDir: dir, keepRotated: 0, dryRun: true });
    expect(result.removed.map((entry) => entry.path).sort()).toEqual(
      [join(dir, "dry.log.1"), join(dir, "dry.log.2")].sort(),
    );
    expect(result.freedBytes).toBeGreaterThan(0);
    expect(result.kept).toBe(0);
    expect(existsSync(join(dir, "dry.log"))).toBe(true);
    expect(existsSync(join(dir, "dry.log.1"))).toBe(true);
    expect(existsSync(join(dir, "dry.log.2"))).toBe(true);
  });

  it("removes every rotated copy with keepRotated 0 and still keeps the active file", () => {
    const dir = state.dir;
    const sink = createFileSink({ dir, maxBytes: 1, retain: 5 });
    for (let index = 1; index <= 3; index++) sink(rec(index * 100, "zero", "m" + index));
    sink.close();

    const result = pruneLogs({ logDir: dir, keepRotated: 0 });
    expect(result.removed.length).toBe(2);
    expect(result.kept).toBe(0);
    expect(existsSync(join(dir, "zero.log"))).toBe(true);
    expect(existsSync(join(dir, "zero.log.1"))).toBe(false);
    expect(existsSync(join(dir, "zero.log.2"))).toBe(false);

    expect(pruneLogs({ logDir: dir, keepRotated: 0 })).toEqual({ removed: [], freedBytes: 0, kept: 0 });
    expect(readLogRecords({ logDir: dir }).records.map((record) => record.message)).toEqual(["m3"]);
  });

  it("leaves an active file alone even when it is the only file", () => {
    writeThroughSink(state.dir, [rec(100, "solo", "only")]);

    expect(pruneLogs({ logDir: state.dir, keepRotated: 0 })).toEqual({ removed: [], freedBytes: 0, kept: 0 });
    expect(existsSync(join(state.dir, "solo.log"))).toBe(true);
  });

  it("applies the age gate only when olderThanMs is given", () => {
    const path = writeThroughSink(state.dir, [rec(100, "age", "active")]);
    renameSync(path, path + ".1");
    writeThroughSink(state.dir, [rec(200, "age", "fresh")]);
    writeFileSync(path + ".2", JSON.stringify(rec(50, "age", "old")) + "\n");
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(path + ".2", old, old);

    const result = pruneLogs({ logDir: state.dir, keepRotated: 0, olderThanMs: 60 * 1000 });
    expect(result.removed.map((entry) => entry.path)).toEqual([path + ".2"]);
    expect(result.kept).toBe(1);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(path + ".1")).toBe(true);
    expect(existsSync(path + ".2")).toBe(false);
  });

  it("answers zeros for a missing directory", () => {
    expect(pruneLogs({ logDir: join(state.dir, "missing") })).toEqual({ removed: [], freedBytes: 0, kept: 0 });
  });
});

/**
 * The BYTE BUDGET is the third prune gate, and the only one that may reach
 * inside the retained window: a disk budget is a budget. These cases pin what it
 * may and may not do — oldest first, never an active file, never past the age
 * gate, and an honest "not met" when the active files alone are larger than it.
 */
describe("pruneLogs byte budget", () => {
  /** Five rotated copies with distinct mtimes, plus one active file, all sized. */
  function budgetFixture(): { active: string; rotated: string[] } {
    const dir = state.dir;
    const rotated: string[] = [];
    for (let rotation = 1; rotation <= 5; rotation++) {
      // Write ONE record through the real sink, then move the file aside: this
      // is exactly what a rotation does, so each copy has the writer's bytes.
      const written = writeThroughSink(dir, [rec(rotation, "budget", "rotation " + rotation)], { maxBytes: 10_000_000 });
      const copy = join(dir, "budget.log." + rotation);
      renameSync(written, copy);
      // .1 is the newest, .5 the oldest — the writer's own convention.
      const seconds = Date.now() / 1000 - rotation * 60;
      utimesSync(copy, seconds, seconds);
      rotated.push(copy);
    }
    // The active file last, so it is the one a process would be appending to.
    const active = writeThroughSink(dir, [rec(100, "budget", "active")], { maxBytes: 10_000_000 });
    return { active, rotated };
  }

  it("removes the oldest survivors until the budget is met, never the active file", () => {
    const { active, rotated } = budgetFixture();
    const budget = statSync(active).size + statSync(rotated[0] ?? "").size + statSync(rotated[1] ?? "").size;

    const result = pruneLogs({ logDir: state.dir, keepRotated: 99, maxTotalBytes: budget });

    expect(result.removed.map((entry) => entry.path)).toEqual([rotated[4], rotated[3], rotated[2]]);
    expect(result.budget?.removed).toBe(3);
    expect(result.budget?.satisfied).toBe(true);
    expect(result.budget?.remainingBytes).toBeLessThanOrEqual(budget);
    expect(result.budget?.maxTotalBytes).toBe(budget);
    expect(result.kept).toBe(2);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(rotated[0] ?? "")).toBe(true);
    expect(existsSync(rotated[1] ?? "")).toBe(true);
    expect(existsSync(rotated[2] ?? "")).toBe(false);
  });

  it("squeezes out every rotated copy and still reports a budget the active files alone exceed", () => {
    const { active, rotated } = budgetFixture();
    const result = pruneLogs({ logDir: state.dir, keepRotated: 99, maxTotalBytes: 1 });

    // The budget squeezes as far as it legally can — every rotated copy goes —
    // and then says the truth: the active file alone is already over budget.
    expect(result.removed.length).toBe(5);
    expect(result.kept).toBe(0);
    expect(result.budget?.removed).toBe(5);
    expect(result.budget?.satisfied).toBe(false);
    expect(result.budget?.remainingBytes).toBe(statSync(active).size);
    expect(existsSync(active)).toBe(true);
    for (const path of rotated) expect(existsSync(path)).toBe(false);
  });

  it("keeps what the age gate protects, even when that leaves the budget unmet", () => {
    const { rotated } = budgetFixture();
    // Every rotated copy is minutes old, so a one-day age gate protects all of
    // them; the budget cannot reach past the operator's freshness promise.
    const result = pruneLogs({ logDir: state.dir, keepRotated: 99, olderThanMs: 86_400_000, maxTotalBytes: 1 });

    expect(result.removed).toEqual([]);
    expect(result.budget?.satisfied).toBe(false);
    for (const path of rotated) expect(existsSync(path)).toBe(true);
  });

  it("honours dryRun: the removals are reported, the budget counts them and nothing goes", () => {
    const { active, rotated } = budgetFixture();
    const budget = statSync(active).size + statSync(rotated[0] ?? "").size;

    const result = pruneLogs({ logDir: state.dir, keepRotated: 99, maxTotalBytes: budget, dryRun: true });

    expect(result.removed.length).toBe(4);
    expect(result.budget?.removed).toBe(4);
    expect(result.budget?.satisfied).toBe(true);
    expect(result.kept).toBe(1);
    expect(existsSync(active)).toBe(true);
    for (const path of rotated) expect(existsSync(path)).toBe(true);
  });

  it("omits the budget report when the caller set no budget", () => {
    budgetFixture();
    const result = pruneLogs({ logDir: state.dir, keepRotated: 99 });
    expect(result.budget).toBeUndefined();
    expect("budget" in result).toBe(false);
  });
});
