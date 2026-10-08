/**
 * THE THREE DESTINATIONS AND THE FAN-OUT.
 *
 * Each sink is pinned on its own contract:
 *
 *   • MEMORY: a bounded ring that keeps the last N records in order, answers a
 *     frozen snapshot a reader cannot write through, delivers to subscribers that
 *     cannot break it, and forgets everything on clear().
 *   • FANOUT: every member receives the record, a member that throws loses only
 *     its own copy, and its failure is reported exactly once — including when the
 *     report itself travels back through the fan-out.
 *   • FILE: one JSON line per record in `<logDir>/<channel>.log` — or in the ONE
 *     file a legacy `file` / ROLEBOX_LOG_FILE names — a directory created lazily,
 *     rotation at the size limit with only the retained copies kept, and failure
 *     as degradation: reported once, never thrown.
 *
 * Every file case runs in a temporary directory and removes it afterwards; the
 * workspace's own log directory is never touched.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getConfigDir } from "../../src/cli/paths.ts";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_RETAIN,
  ROTATE_LOCK_STALE_MS,
  ROTATE_LOCK_SUFFIX,
  ROTATE_WAIT_MS,
  createFileSink,
  logChannelFileName,
  resolveLogDir,
  resolveLogFile,
  type FileSinkFailure,
} from "../../src/log/sinks/file.ts";
import { createFanoutSink, type FanoutSink } from "../../src/log/sinks/fanout.ts";
import { DEFAULT_MEMORY_CAPACITY, createMemorySink, isMemorySink } from "../../src/log/sinks/memory.ts";
import { listLogFiles } from "../../src/log/index.ts";
import type { LogSink } from "../../src/log/types.ts";
import { beginLogTest, endLogTest, makeRecord, removeDir, setLogEnv, tempDir } from "../helpers/log.ts";

let state: { env: Record<string, string | undefined>; dir: string };

/**
 * The real other process the rotation-wait cases need: one thread cannot hold a
 * rotation lock and watch the sink wait for it (the wait parks the thread), so
 * the holder is spawned. See tests/log/fixtures/sink-lock-holder.ts.
 */
const LOCK_HOLDER = join(import.meta.dir, "fixtures", "sink-lock-holder.ts");

/** Spawn the holder fixture and hand back the child plus its captured stderr. */
function spawnLockHolder(args: readonly string[]): { child: Bun.Subprocess; stderr: () => Promise<string> } {
  const child = Bun.spawn(["bun", "run", LOCK_HOLDER, ...args], {
    stdout: "ignore",
    stderr: "pipe",
    // The legacy single-file variable beats an explicit dir, and this suite's
    // parent process may have it set: the child must write where it was told.
    env: { ...process.env, ROLEBOX_LOG_FILE: "" },
  });
  return { child, stderr: () => new Response(child.stderr as ReadableStream).text() };
}

beforeEach(() => {
  state = beginLogTest();
});

afterEach(() => {
  endLogTest(state);
});

describe("memory sink", () => {
  it("keeps the last N records in order", () => {
    const sink = createMemorySink({ capacity: 3 });
    for (let index = 1; index <= 5; index++) sink(makeRecord({ level: "info", message: "m" + index }));

    expect(sink.records().map((record) => record.message)).toEqual(["m3", "m4", "m5"]);
    expect(sink.size).toBe(3);
    expect(sink.capacity).toBe(3);
    expect(sink.last()?.message).toBe("m5");
  });

  it("answers a frozen snapshot copy that cannot be written through", () => {
    const sink = createMemorySink({ capacity: 2 });
    sink(makeRecord({ level: "info", message: "m1" }));

    const snapshot = sink.records();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => (snapshot as unknown as unknown[]).push("x")).toThrow();
    expect(sink.records().map((record) => record.message)).toEqual(["m1"]);
  });

  it("answers an empty buffer and no last record before anything arrives", () => {
    const sink = createMemorySink();
    expect(sink.size).toBe(0);
    expect(sink.records()).toEqual([]);
    expect(sink.last()).toBeUndefined();
  });

  it("delivers to subscribers in order and stops after unsubscribe", () => {
    const sink = createMemorySink({ capacity: 5 });
    const first: string[] = [];
    const second: string[] = [];
    const unsubscribeFirst = sink.subscribe((record) => first.push(record.message));
    const unsubscribeSecond = sink.subscribe((record) => second.push(record.message));

    sink(makeRecord({ level: "info", message: "one" }));
    unsubscribeFirst();
    unsubscribeFirst(); // idempotent
    sink(makeRecord({ level: "info", message: "two" }));

    expect(first).toEqual(["one"]);
    expect(second).toEqual(["one", "two"]);
    unsubscribeSecond();
  });

  it("contains a throwing subscriber and keeps delivering to the others", () => {
    const sink = createMemorySink({ capacity: 5 });
    const seen: string[] = [];
    sink.subscribe(() => {
      throw new Error("viewer exploded");
    });
    sink.subscribe((record) => seen.push(record.message));

    expect(() => sink(makeRecord({ level: "warn", message: "still delivered" }))).not.toThrow();
    expect(seen).toEqual(["still delivered"]);
    expect(sink.size).toBe(1);
  });

  it("clears records and subscriptions together", () => {
    const sink = createMemorySink({ capacity: 5 });
    const seen: string[] = [];
    sink.subscribe((record) => seen.push(record.message));
    sink(makeRecord({ level: "info", message: "before" }));

    sink.clear();

    expect(sink.size).toBe(0);
    expect(sink.records()).toEqual([]);
    expect(sink.last()).toBeUndefined();
    sink(makeRecord({ level: "info", message: "after" }));
    expect(seen).toEqual(["before"]);
  });

  it("falls back to the default capacity for an unusable one", () => {
    expect(createMemorySink().capacity).toBe(DEFAULT_MEMORY_CAPACITY);
    expect(createMemorySink({ capacity: 0 }).capacity).toBe(DEFAULT_MEMORY_CAPACITY);
    expect(createMemorySink({ capacity: -5 }).capacity).toBe(DEFAULT_MEMORY_CAPACITY);
    expect(createMemorySink({ capacity: 1.5 }).capacity).toBe(DEFAULT_MEMORY_CAPACITY);
    expect(createMemorySink({ capacity: 2 }).capacity).toBe(2);
  });

  it("is recognizable among arbitrary sinks", () => {
    expect(isMemorySink(createMemorySink())).toBe(true);
    expect(isMemorySink(() => {})).toBe(false);
  });
});

describe("fanout sink", () => {
  it("delivers to every member, in order, and names them", () => {
    const seen: string[] = [];
    const first: LogSink = (record) => seen.push("first:" + record.message);
    const second: LogSink = (record) => seen.push("second:" + record.message);
    const fanout = createFanoutSink([first, second]);

    fanout(makeRecord({ level: "warn", message: "one" }));

    expect(seen).toEqual(["first:one", "second:one"]);
    expect(fanout.names).toEqual(["sink#0", "sink#1"]);
    expect(fanout.sinks).toHaveLength(2);
    expect(fanout.failed()).toEqual([]);
  });

  it("isolates a throwing member and reports it exactly once", () => {
    const seen: string[] = [];
    const failures: Array<{ name: string; error: unknown }> = [];
    const boom: LogSink = () => {
      throw new Error("boom");
    };
    const good: LogSink = (record) => seen.push(record.message);
    const fanout = createFanoutSink([boom, good], {
      names: ["boom", "good"],
      onFailure: (name, error) => failures.push({ name, error }),
    });

    expect(() => fanout(makeRecord({ level: "warn", message: "one" }))).not.toThrow();
    expect(() => fanout(makeRecord({ level: "warn", message: "two" }))).not.toThrow();

    expect(seen).toEqual(["one", "two"]);
    expect(failures).toHaveLength(1);
    expect(failures[0].name).toBe("boom");
    expect((failures[0].error as Error).message).toBe("boom");
    expect(fanout.failed()).toEqual(["boom"]);
  });

  it("treats a member that is not callable as a failing destination", () => {
    const failures: string[] = [];
    const seen: string[] = [];
    const fanout = createFanoutSink([null as unknown as LogSink, (record) => seen.push(record.message)], {
      names: ["broken", "good"],
      onFailure: (name) => failures.push(name),
    });

    expect(() => fanout(makeRecord({ level: "warn", message: "one" }))).not.toThrow();
    expect(failures).toEqual(["broken"]);
    expect(seen).toEqual(["one"]);
  });

  it("contains a report that travels back through the fan-out", () => {
    const seen: string[] = [];
    const boom: LogSink = () => {
      throw new Error("boom");
    };
    const good: LogSink = (record) => seen.push(record.message);

    let fanout: FanoutSink | undefined;
    fanout = createFanoutSink([boom, good], {
      names: ["boom", "good"],
      onFailure: () => {
        // The reporter emits another record through the same fan-out, exactly as
        // the pipeline's `log.sink.failed` reporter does.
        fanout?.(makeRecord({ level: "error", message: "report" }));
      },
    });

    fanout(makeRecord({ level: "warn", message: "first" }));

    expect(seen).toEqual(["report", "first"]);
    expect(fanout.failed()).toEqual(["boom"]);
  });

  it("contains a reporter that throws", () => {
    const boom: LogSink = () => {
      throw new Error("boom");
    };
    const seen: string[] = [];
    const fanout = createFanoutSink([boom, (record) => seen.push(record.message)], {
      onFailure: () => {
        throw new Error("reporter exploded");
      },
    });

    expect(() => fanout(makeRecord({ level: "warn", message: "one" }))).not.toThrow();
    expect(seen).toEqual(["one"]);
  });

  it("does nothing at all with no members", () => {
    const fanout = createFanoutSink([]);
    expect(() => fanout(makeRecord({ level: "warn" }))).not.toThrow();
    expect(fanout.failed()).toEqual([]);
  });
});

describe("file sink", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir("rolebox-log-file-");
  });

  afterEach(() => {
    removeDir(dir);
  });

  it("writes one JSON line per record, one file per channel, in the documented key order", () => {
    const sink = createFileSink({ dir });
    sink(
      makeRecord({
        level: "warn",
        channel: "graph:host",
        code: "sweep.store-blocked",
        message: "the workspace store could not be read",
        scope: { graphId: "g1", attemptId: "a2" },
        fields: { reason: "unreadable" },
        process: { pid: 7, role: "host" },
      }),
    );
    sink(makeRecord({ level: "info", channel: "dispatch", message: "created" }));

    const hostLine = readFileSync(join(dir, "graph-host.log"), "utf8").trim();
    const parsed = JSON.parse(hostLine);
    // The parsed line is the record, exactly. The KEY ORDER of the documented
    // shape is pinned in tests/log/index.test.ts, where the record is built by
    // the pipeline rather than by a fixture.
    expect(parsed).toEqual({
      time: 1,
      level: "warn",
      channel: "graph:host",
      code: "sweep.store-blocked",
      message: "the workspace store could not be read",
      scope: { graphId: "g1", attemptId: "a2" },
      fields: { reason: "unreadable" },
      process: { pid: 7, role: "host" },
    });

    const dispatchLine = JSON.parse(readFileSync(join(dir, "dispatch.log"), "utf8").trim());
    expect(dispatchLine.message).toBe("created");
    expect(readFileSync(join(dir, "dispatch.log"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("records the fatal level verbatim", () => {
    const sink = createFileSink({ dir });
    sink(makeRecord({ level: "fatal", channel: "core", message: "critical service init failed" }));

    const parsed = JSON.parse(readFileSync(join(dir, "core.log"), "utf8").trim());
    expect(parsed.level).toBe("fatal");
    expect(parsed.message).toBe("critical service init failed");
  });

  it("writes every channel into the one file a `file` option names", () => {
    const file = join(dir, "single.log");
    const sink = createFileSink({ file });

    expect(sink.singleFile).toBe(file);
    expect(sink.dir).toBe(dir);
    expect(sink.pathFor("alpha")).toBe(file);
    sink(makeRecord({ level: "warn", channel: "alpha", message: "a" }));
    sink(makeRecord({ level: "info", channel: "beta", message: "b" }));

    const records = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.channel)).toEqual(["alpha", "beta"]);
    expect(existsSync(join(dir, "alpha.log"))).toBe(false);
    expect(existsSync(join(dir, "beta.log"))).toBe(false);
  });

  it("resolves the legacy single file: explicit option, then environment, then none", () => {
    expect(resolveLogFile({})).toBeUndefined();
    expect(createFileSink({ dir }).singleFile).toBeUndefined();

    setLogEnv("ROLEBOX_LOG_FILE", "/tmp/rolebox-from-env.log");
    expect(resolveLogFile({})).toBe("/tmp/rolebox-from-env.log");
    expect(resolveLogFile({ file: "/tmp/rolebox-explicit.log" })).toBe("/tmp/rolebox-explicit.log");
    expect(createFileSink({}).singleFile).toBe("/tmp/rolebox-from-env.log");

    // A blank value is not a file name; the per-channel layout stands.
    setLogEnv("ROLEBOX_LOG_FILE", "   ");
    expect(resolveLogFile({})).toBeUndefined();
  });

  it("rotates the single file under the same limits as a channel file", () => {
    const file = join(dir, "rotating.log");
    const sink = createFileSink({ file, maxBytes: 1, retain: 2 });
    for (let index = 0; index < 4; index++) {
      sink(makeRecord({ level: "warn", channel: "channel-" + index, message: "m" + index }));
    }

    expect(existsSync(file)).toBe(true);
    expect(existsSync(file + ".1")).toBe(true);
    expect(existsSync(file + ".2")).toBe(true);
    expect(existsSync(file + ".3")).toBe(false);
    expect(readFileSync(file, "utf8")).toContain('"m3"');
  });

  it("creates the directory lazily, including a nested path", () => {
    const nested = join(dir, "nested", "logs");
    const sink = createFileSink({ dir: nested });
    expect(existsSync(nested)).toBe(false);

    sink(makeRecord({ level: "warn" }));

    expect(existsSync(join(nested, "dispatch.log"))).toBe(true);
  });

  it("rotates at the size limit and keeps only the retained copies", () => {
    const sink = createFileSink({ dir, maxBytes: 1, retain: 2 });
    for (let index = 0; index < 4; index++) sink(makeRecord({ level: "warn", message: "m" + index }));

    expect(existsSync(join(dir, "dispatch.log"))).toBe(true);
    expect(existsSync(join(dir, "dispatch.log.1"))).toBe(true);
    expect(existsSync(join(dir, "dispatch.log.2"))).toBe(true);
    expect(existsSync(join(dir, "dispatch.log.3"))).toBe(false);
    expect(readFileSync(join(dir, "dispatch.log"), "utf8")).toContain('"m3"');
    expect(readFileSync(join(dir, "dispatch.log.1"), "utf8")).toContain('"m2"');
  });

  it("rotates at the limit when the bytes are split between writers", () => {
    // Two sinks are two writers: each keeps its own byte count, exactly like
    // two processes, and NEITHER reaches the limit on its own. Gating rotation
    // on the private count therefore lets the file they share grow to
    // (writers x maxBytes) before anybody rotates — the defect the multi-process
    // probe found (a 2.26x live file with three writers at a 1 KB limit). The
    // gate reads the file, so the file rotates at the limit whoever wrote the
    // bytes.
    const first = createFileSink({ dir, maxBytes: 1_024, retain: 40 });
    const second = createFileSink({ dir, maxBytes: 1_024, retain: 40 });
    for (let index = 0; index < 6; index++) {
      first(makeRecord({ level: "info", channel: "split", message: "first-" + index }));
      second(makeRecord({ level: "info", channel: "split", message: "second-" + index }));
    }
    first.close();
    second.close();

    const path = join(dir, "split.log");
    // Each writer appended ~700 bytes, so a private-counter gate would not have
    // rotated at all; the shared file crossed 1024 twice.
    expect(existsSync(path + ".1")).toBe(true);
    const lines = [path, path + ".1", path + ".2"]
      .filter((candidate) => existsSync(candidate))
      .flatMap((candidate) => readFileSync(candidate, "utf8").trim().split("\n").filter((line) => line.length > 0));
    // Nothing lost, nothing duplicated across the live file and its copies.
    expect(lines).toHaveLength(12);
    // And the live file sits at the limit, not past it: one record may be in
    // flight while the shift runs.
    expect(statSync(path).size).toBeLessThanOrEqual(1_024 + 200);
  });

  it("does not walk retention slots that hold no copy", () => {
    // The shift must start at the copies that exist. A retain far above them
    // once meant one stat per empty slot — the rotation window in which other
    // writers keep appending into the copy being made.
    const sink = createFileSink({ dir, maxBytes: 1, retain: 512 });
    for (let index = 0; index < 4; index++) sink(makeRecord({ level: "warn", message: "m" + index }));

    expect(existsSync(join(dir, "dispatch.log.1"))).toBe(true);
    expect(existsSync(join(dir, "dispatch.log.2"))).toBe(true);
    expect(existsSync(join(dir, "dispatch.log.3"))).toBe(true);
    expect(existsSync(join(dir, "dispatch.log.512"))).toBe(false);
    expect(existsSync(join(dir, "dispatch.log.4"))).toBe(false);
  });

  it("removes the file instead of keeping a copy when retain is 0", () => {
    const sink = createFileSink({ dir, maxBytes: 1, retain: 0 });
    sink(makeRecord({ level: "warn", message: "first" }));
    sink(makeRecord({ level: "warn", message: "second" }));

    expect(existsSync(join(dir, "dispatch.log"))).toBe(true);
    expect(existsSync(join(dir, "dispatch.log.1"))).toBe(false);
    expect(readFileSync(join(dir, "dispatch.log"), "utf8")).toContain('"second"');
    expect(readFileSync(join(dir, "dispatch.log"), "utf8")).not.toContain('"first"');
  });

  it("degrades on a write failure, reports it once and never throws", () => {
    const blocked = join(dir, "not-a-directory");
    writeFileSync(blocked, "this path is a file");
    const failures: FileSinkFailure[] = [];
    const sink = createFileSink({ dir: blocked, onFailure: (failure) => failures.push(failure) });

    expect(() => sink(makeRecord({ level: "warn" }))).not.toThrow();
    expect(() => sink(makeRecord({ level: "warn" }))).not.toThrow();

    expect(failures).toHaveLength(1);
    expect(failures[0].code).toBe("log.file.write-failed");
    expect(failures[0].channel).toBe("dispatch");
    expect(sink.disabled).toBe(true);
  });

  it("waits out a stalled rotation lock, and waits again for a replacement", () => {
    // Two processes rotating one file is what loses records: `rename(path,
    // path.1)` REPLACES an existing `.1`. A lock held by somebody else must
    // therefore mean "do not rotate" — and the holder's lock must be left
    // exactly where it is. Appending straight into the file the holder is about
    // to rename is the other half of the defect (those bytes land in the copy
    // and push it past the limit), so the writer WAITS while the holder is
    // making progress and appends anyway only when it has stopped.
    const sink = createFileSink({ dir: state.dir, maxBytes: 1, retain: 3 });
    const path = sink.pathFor("locked");
    const lock = path + ROTATE_LOCK_SUFFIX;
    writeFileSync(lock, "999999", "utf8");

    // The first record finds an empty file, so the gate does not trip yet.
    sink(makeRecord({ level: "info", message: "first", channel: "locked" }));

    // Nobody is refreshing this lock, so the record pays one no-progress window
    // and then appends.
    const secondStarted = Date.now();
    sink(makeRecord({ level: "info", message: "second", channel: "locked" }));
    expect(Date.now() - secondStarted).toBeGreaterThanOrEqual(ROTATE_WAIT_MS - 1);

    // The give-up is scoped to the lock INSTANCE it gave up on: the same
    // stalled lock is not paid for twice.
    const thirdStarted = Date.now();
    sink(makeRecord({ level: "info", message: "third", channel: "locked" }));
    expect(Date.now() - thirdStarted).toBeLessThan(ROTATE_WAIT_MS);

    // A REPLACED lock is a different stamp (inode + mtime) and is waited for
    // again. This is the regression: a permanent per-process give-up let ONE
    // slow rotation turn the sink into a writer that appended into every later
    // file mid-rename (rotated copies reached 40x the limit).
    rmSync(lock, { force: true });
    writeFileSync(lock, "999998", "utf8");
    const fourthStarted = Date.now();
    sink(makeRecord({ level: "info", message: "fourth", channel: "locked" }));
    expect(Date.now() - fourthStarted).toBeGreaterThanOrEqual(ROTATE_WAIT_MS - 1);
    sink.close();

    expect(existsSync(path + ".1")).toBe(false);
    const content = readFileSync(path, "utf8");
    expect(content).toContain('"first"');
    expect(content).toContain('"second"');
    expect(content).toContain('"third"');
    expect(content).toContain('"fourth"');
    // The lock is not a log file: the read side never lists it.
    rmSync(lock, { force: true });
  });

  it("keeps waiting while another process's rotation is making progress", async () => {
    // THE HEARTBEAT, FROM THE WAITER'S SIDE. A fixed deadline cannot tell a slow
    // rotation from a dead one: the sink would append into the copy the holder
    // is making. A holder that keeps refreshing its lock is waited out for as
    // long as it keeps moving, so this record — which starts while the holder
    // has 400 ms of work left — must not append until the holder releases.
    const sink = createFileSink({ dir: state.dir, maxBytes: 1, retain: 3 });
    const path = sink.pathFor("progressing");
    const lock = path + ROTATE_LOCK_SUFFIX;
    sink(makeRecord({ level: "info", message: "before", channel: "progressing" }));

    const holder = spawnLockHolder([
      "--mode", "hold", "--dir", state.dir, "--channel", "progressing", "--hold-ms", "400",
    ]);
    try {
      const appeared = Date.now() + 10_000;
      while (!existsSync(lock) && Date.now() < appeared) await Bun.sleep(1);
      expect(existsSync(lock)).toBe(true);

      const started = Date.now();
      sink(makeRecord({ level: "info", message: "during", channel: "progressing" }));
      const waited = Date.now() - started;

      // Far beyond ROTATE_WAIT_MS, because the holder never stopped moving —
      // and it ended when the holder released, not on a stopwatch.
      expect(waited).toBeGreaterThanOrEqual(100);
      expect(waited).toBeLessThan(10_000);
      expect(existsSync(lock)).toBe(false);
    } finally {
      await holder.child.exited;
      rmSync(lock, { force: true });
    }

    // The holder released its lock and exited cleanly: the wait ended because
    // the rotation did, not because a window ran out under it.
    expect(await holder.stderr()).toBe("");
    expect(holder.child.exitCode).toBe(0);
    expect(readFileSync(path, "utf8")).toContain('"during"');
    sink.close();
  });

  it("refreshes its lock while a long rotation walks the ladder", async () => {
    // THE HEARTBEAT, FROM THE HOLDER'S SIDE. A deep ladder is the slow rotation
    // a waiter must not mistake for a dead one, so the holder announces its
    // progress while it scans and shifts. The parent cannot watch a rotation it
    // would have to run itself (one thread), so a child process runs the real
    // sink over a ladder the parent built, and the parent samples the lock's
    // mtime until the child releases it.
    const sink = createFileSink({ dir: state.dir, maxBytes: 1, retain: 4_000 });
    const path = sink.pathFor("heartbeat");
    writeFileSync(path, "x".repeat(2_000), "utf8");
    for (let index = 1; index <= 3_000; index++) writeFileSync(`${path}.${index}`, "x", "utf8");
    const lock = path + ROTATE_LOCK_SUFFIX;

    const holder = spawnLockHolder([
      "--mode", "rotate", "--dir", state.dir, "--channel", "heartbeat",
      "--max-bytes", "1", "--retain", "4000",
    ]);
    const stamps = new Set<number>();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        stamps.add(statSync(lock).mtimeMs);
      } catch {
        // The lock is gone: the rotation finished (or never started).
        if (stamps.size > 0 || holder.child.exitCode !== null) break;
      }
      await Bun.sleep(1);
    }
    await holder.child.exited;
    rmSync(lock, { force: true });
    sink.close();

    expect(await holder.stderr()).toBe("");
    expect(holder.child.exitCode).toBe(0);
    // More than one stamp means the lock moved while it was held: a waiter
    // reading it would have kept waiting instead of appending into the copy.
    expect(stamps.size).toBeGreaterThan(1);
    // And the walk really happened: the top of the 3,000-copy ladder moved up.
    expect(existsSync(`${path}.3001`)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain('"holder-rotated"');
  });

  it("breaks a stale rotation lock and removes the lock it took", () => {
    const sink = createFileSink({ dir: state.dir, maxBytes: 1, retain: 3 });
    const path = sink.pathFor("stale");
    const lock = path + ROTATE_LOCK_SUFFIX;
    writeFileSync(lock, "1", "utf8");
    const old = new Date(Date.now() - ROTATE_LOCK_STALE_MS - 1_000);
    utimesSync(lock, old, old);

    sink(makeRecord({ level: "info", message: "one", channel: "stale" }));
    sink(makeRecord({ level: "info", message: "two", channel: "stale" }));
    sink.close();

    expect(existsSync(path + ".1")).toBe(true);
    // The lock the sink took for its own rotation is gone afterwards.
    expect(existsSync(lock)).toBe(false);
  });

  it("never lists a rotation lock as a log file", () => {
    const sink = createFileSink({ dir: state.dir, maxBytes: 1, retain: 3 });
    const path = sink.pathFor("graph:host");
    sink(makeRecord({ level: "info", message: "real", channel: "graph:host" }));
    sink.close();
    writeFileSync(path + ROTATE_LOCK_SUFFIX, "1", "utf8");

    const listed = listLogFiles({ logDir: state.dir }).map((file) => file.path);
    // The channel file is listed; the lock sitting beside it is not a log file.
    expect(listed).toContain(path);
    expect(listed).not.toContain(path + ROTATE_LOCK_SUFFIX);
  });

  it("abandons rotation on a rotate failure, reports it once and keeps writing", () => {
    const file = join(dir, "dispatch.log");
    const failures: FileSinkFailure[] = [];
    const sink = createFileSink({ dir, maxBytes: 1, retain: 1, onFailure: (failure) => failures.push(failure) });

    sink(makeRecord({ level: "warn", message: "before" }));
    // The rotation destination is a directory, so renaming the file onto it fails.
    mkdirSync(file + ".1");
    sink(makeRecord({ level: "warn", message: "rotate-attempt" }));
    sink(makeRecord({ level: "warn", message: "after" }));

    expect(failures.map((failure) => failure.code)).toEqual(["log.file.rotate-failed"]);
    expect(failures[0].maxBytes).toBe(1);
    expect(sink.disabled).toBe(false);
    const content = readFileSync(file, "utf8");
    expect(content).toContain("rotate-attempt");
    expect(content).toContain("after");
  });

  it("stops writing after close and ignores a second close", () => {
    const sink = createFileSink({ dir });
    sink(makeRecord({ level: "warn", message: "before" }));
    sink.close();
    sink.close();
    sink(makeRecord({ level: "warn", message: "after" }));

    const content = readFileSync(join(dir, "dispatch.log"), "utf8");
    expect(content).toContain("before");
    expect(content).not.toContain("after");
  });

  it("reads the rotation limits from the environment with sane fallbacks", () => {
    setLogEnv("ROLEBOX_LOG_MAX_BYTES", "2048");
    setLogEnv("ROLEBOX_LOG_RETAIN", "7");
    expect(createFileSink({ dir }).maxBytes).toBe(2048);
    expect(createFileSink({ dir }).retain).toBe(7);

    for (const value of ["junk", "0", "-2", "  "]) {
      setLogEnv("ROLEBOX_LOG_MAX_BYTES", value);
      expect(createFileSink({ dir }).maxBytes).toBe(DEFAULT_MAX_BYTES);
    }
    for (const value of ["junk", "-2", "  "]) {
      setLogEnv("ROLEBOX_LOG_RETAIN", value);
      expect(createFileSink({ dir }).retain).toBe(DEFAULT_RETAIN);
    }
    // A retain of 0 is legal and means "remove the file, keep no copy".
    setLogEnv("ROLEBOX_LOG_RETAIN", "0");
    expect(createFileSink({ dir }).retain).toBe(0);

    setLogEnv("ROLEBOX_LOG_MAX_BYTES", undefined);
    setLogEnv("ROLEBOX_LOG_RETAIN", undefined);
    expect(createFileSink({ dir }).maxBytes).toBe(DEFAULT_MAX_BYTES);
    expect(createFileSink({ dir }).retain).toBe(DEFAULT_RETAIN);
  });

  it("names a channel's file safely", () => {
    expect(logChannelFileName("graph:host")).toBe("graph-host.log");
    expect(logChannelFileName("dispatch")).toBe("dispatch.log");
    expect(logChannelFileName("a b/c")).toBe("a-b-c.log");
    expect(logChannelFileName("")).toBe("rolebox.log");
    expect(logChannelFileName(":::")).toBe("rolebox.log");
    expect(logChannelFileName("../etc/passwd")).toBe("---etc-passwd.log");
  });

  it("resolves the log directory: explicit, then environment, then workspace, then config", () => {
    expect(resolveLogDir({ dir: "/tmp/explicit-log-dir" })).toBe("/tmp/explicit-log-dir");

    setLogEnv("ROLEBOX_LOG_DIR", "/tmp/from-env");
    expect(resolveLogDir({})).toBe("/tmp/from-env");
    setLogEnv("ROLEBOX_LOG_DIR", undefined);

    const root = tempDir("rolebox-log-workspace-");
    try {
      mkdirSync(join(root, ".rolebox"));
      const nested = join(root, "src", "deep");
      mkdirSync(nested, { recursive: true });
      // The nearest ancestor holding a .rolebox directory wins.
      expect(resolveLogDir({ cwd: nested })).toBe(join(root, ".rolebox", "logs"));
    } finally {
      removeDir(root);
    }

    const config = tempDir("rolebox-log-config-");
    try {
      setLogEnv("ROLEBOX_CONFIG_DIR", config);
      expect(resolveLogDir({ cwd: dir })).toBe(join(config, "logs"));
    } finally {
      setLogEnv("ROLEBOX_CONFIG_DIR", undefined);
      removeDir(config);
    }

    // With no workspace above the working directory, the fallback is exactly the
    // config dir src/logger.ts resolves.
    expect(resolveLogDir({ cwd: dir })).toBe(join(getConfigDir(), "logs"));
  });
});
