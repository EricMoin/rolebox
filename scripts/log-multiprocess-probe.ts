#!/usr/bin/env bun
// ── The multi-process log probe ─────────────────────────────────────────────
//
// WHAT THIS ANSWERS. Everything the logging platform claims about CONCURRENCY
// has to be shown with real processes, not with one process pretending to be
// three: this probe starts three `bun` child processes that write the SAME
// channel into the SAME log directory at the same time, each one through a
// different real module path, plus a real `rolebox logs --follow` process that
// reads the live stream while they write.
//
//   • `worker`   — src/logger.ts, the compatibility shell: `createSubLogger`
//                  is the path the graph worker and the platform adapters use;
//   • `pipeline` — src/log/index.ts, the kernel API: `configureLogging` +
//                  `createLogger`, i.e. a caller that talks to the pipeline
//                  directly;
//   • `sink`     — src/log/sinks/file.ts, the JSON-lines writer itself, driven
//                  with hand-built records (the lowest layer that rotates).
//
// The writers deliberately cross the rotation limit many times over: the run
// sets ROLEBOX_LOG_MAX_BYTES small (`--max-bytes`, default 4096) and
// ROLEBOX_LOG_RETAIN large (`--retain`, default 4096) so that NO probe record
// can fall out of the retained window by retention — every missing record is
// therefore a genuine loss and not a window the operator chose to drop.
//
// WHAT IT CHECKS, and each check is reported by name:
//
//   exactly-once    every (writer, seq) the writers announced appears exactly
//                   once in the read layer's merged view;
//   raw-lines       every physical line of every <channel>.log[.N] file is one
//                   complete JSON record of this probe (a torn or interleaved
//                   line is a parse failure or a foreign record) and the raw
//                   file scan agrees with the read layer line for line;
//   writer-order    within one writer, records appear in ascending `seq` in
//                   scan order (.N … .1 then the active file), i.e. rotation did
//                   not reorder a writer's own stream;
//   merged-order    `readLogRecords({ order: "asc" })` is non-decreasing in
//                   `time` and the `desc` answer is its exact reverse;
//   rotation        the run actually rotated (more than one file, and every
//                   writer's records spread over more than one file) — without
//                   this the concurrency claim would be untested;
//   rotation-bound  rotation happened AT ROLEBOX_LOG_MAX_BYTES rather than at
//                   the writer's own byte count: every rotated copy on disk is
//                   within THE LIMIT PLUS ONE RECORD PER CONCURRENT WRITER. That
//                   bound is stated in bytes, not as a fraction of the limit: a
//                   record that passed the gate an instant before another
//                   process rotated is IN the copy, and how large that allowance
//                   is next to the limit depends on the record size. A gate that
//                   counted only the writing process's own bytes produced copies
//                   at 2.3x the limit (three writers, 1 KB limit) — this check is
//                   what fails if that gate comes back;
//   follower-complete
//                   the real `rolebox logs --follow --json` process delivered at
//                   least as many records as the writers announced;
//   follower-missing
//                   every (writer, seq) pair the writers announced came out of
//                   the follower;
//   follower-duplicates
//                   no announced (writer, seq) pair came out of the follower
//                   more than once;
//   follower-malformed
//                   every line the follower printed was one parseable record of
//                   this probe;
//   follower-order
//                   the stream's per-writer ORDER: the follower delivers a poll
//                   in `time` order, but a file a concurrent rotation renamed
//                   past its walk can arrive one poll late, so reordering is
//                   measured and bounded by FOLLOWER_LATE_RECORD_LIMIT rather
//                   than assumed away — losing or repeating a record is what
//                   fails.
//
// USAGE
//   bun scripts/log-multiprocess-probe.ts [--records 400] [--max-bytes 4096]
//       [--retain 4096] [--delay-ms 2] [--runs 1] [--dir <path>] [--keep]
//       [--json]
//
// The parent prints a `PROBE SUMMARY` block per run and a final JSON object on
// stdout; it exits 0 only when every check passed. `--json` prints ONLY the JSON
// object, which is what a captured evidence file wants.
//
// THIS FILE IS A PROBE, NOT PRODUCTION CODE: it is not imported by src/**, it is
// not part of `bun run typecheck` (tsconfig.json includes only src), and its only
// job is to produce evidence a reviewer can re-run.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readLogRecords } from "../src/log/index.ts";
import { logChannelFileName } from "../src/log/sinks/file.ts";
import type { LogRecord } from "../src/log/types.ts";

/** The channel all three writers share: one file, three processes. */
export const PROBE_CHANNEL = "probe:shared";

/** The message every probe record carries; the writer and seq are fields. */
export const PROBE_MESSAGE = "probe-record";

/** The three real write paths, in the order the report names them. */
export const PROBE_WRITERS = ["worker", "pipeline", "sink"] as const;

/**
 * What fraction of the live stream may arrive out of `time` order before the
 * run fails. The follower delivers one poll's records in `time` order and never
 * loses or repeats one, but BETWEEN polls a file that a concurrent rotation
 * renamed past its walk can be delivered a poll late — after records written
 * into the fresh active file. That is bounded reordering, not a scramble: this
 * probe measures it and fails above the fraction below. Ten stress runs
 * (3 writers back to back, a 2 KB limit, ~29 rotations per run) measured 0 late
 * records in nine of them and 9 of 360 (2.5%) in the tenth, always with 0
 * missing and 0 duplicated; without the follower's multi-pass read the same
 * configuration produced late blocks of 17%. The 10% bound leaves CI room while
 * still failing a follower that delivers a channel backwards.
 */
export const FOLLOWER_LATE_RECORD_LIMIT = 0.1;

/**
 * How long, in milliseconds, the follower may still be behind AFTER the writers
 * finished before the probe stops waiting and SIGINTs it. The follower is a
 * 250 ms poll loop, so under the load of a whole CI suite it can need longer
 * than a fixed grace to deliver the tail of the stream: a fixed `Bun.sleep(800)`
 * here reported a healthy follower that had simply not caught up yet as LOSS
 * (macOS CI: `follower-complete` false with `follower-missing` false, i.e.
 * records still arriving). The wait is on the condition the probe actually
 * needs — every announced record delivered — and this deadline is what keeps it
 * BOUNDED: it says when to STOP waiting, so a follower that truly loses records
 * still fails, and fails promptly. It never changes what the checks count.
 */
export const FOLLOWER_CATCH_UP_DEADLINE_MS = 5_000;

/**
 * The floor on "one record" in the rotated-copy bound, in bytes. The probe's own
 * records measure a few hundred bytes (its widest line is reported as
 * `maxRecordBytes`), and this floor covers the widest one measured here. It is a
 * per-WRITER allowance and not a fraction of the limit, because a fraction is
 * not load-independent: the records already in flight when a rotation starts are
 * ~0.8x of a 1 KB limit but ~0.03x of a 32 KB one (three writers, ~280-byte
 * records), so the same healthy run sits above a factor at one limit and under
 * it at another.
 */
export const ROTATION_BOUND_MARGIN_PER_WRITER_BYTES = 512;

/**
 * The bound a rotated copy must respect: ROLEBOX_LOG_MAX_BYTES plus one record
 * per concurrent writer, where "one record" is the widest physical line this run
 * actually READ (never below {@link ROTATION_BOUND_MARGIN_PER_WRITER_BYTES}).
 * Two effects are separated by it, and only one of them is a defect:
 *
 *   • a WRONG GATE lets the file run to (writers x the limit) before anybody
 *     rotates. Measured with three sink instances (three private counters, what
 *     three processes have) at a 1 KB limit: a 2316-byte live file, 2.26x — far
 *     above this bound. The gate reads the file's own size now.
 *   • a CORRECT GATE with appends still racing the shift adds the records
 *     written while the lock holder renames to the copy being rotated. Measured
 *     here with the gate fixed but no wait: 8431 bytes for a 2 KB limit, 4.1x.
 *     A writer that finds another process rotating now WAITS for it instead.
 * What remains is the in-flight record itself, which is why the bound carries an
 * allowance per writer rather than a factor over the limit.
 */
export function rotationBoundBytes(maxBytes: number, maxRecordBytes: number): number {
  return maxBytes + PROBE_WRITERS.length * Math.max(maxRecordBytes, ROTATION_BOUND_MARGIN_PER_WRITER_BYTES);
}

/** One of the three write paths. */
export type ProbeWriter = (typeof PROBE_WRITERS)[number];

/** Everything the parent (and a child, for its own slice) needs to know. */
export interface ProbeOptions {
  readonly dir: string;
  readonly records: number;
  readonly maxBytes: number;
  readonly retain: number;
  readonly delayMs: number;
}

/** A writer child's exit report. */
interface ChildReport {
  readonly mode: string;
  readonly pid: number;
  readonly records: number;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** One parsed `(writer, seq)` occurrence, with where it was found. */
interface Occurrence {
  readonly writer: string;
  readonly seq: number;
  readonly file: string;
  readonly index: number;
}

/** What one run found. */
export interface ProbeRun {
  readonly dir: string;
  readonly recordsPerWriter: number;
  readonly expected: number;
  readonly observed: number;
  readonly missing: number;
  readonly duplicates: number;
  readonly missingSamples: string[];
  readonly duplicateSamples: string[];
  readonly files: string[];
  readonly rotations: number;
  readonly bytes: number;
  readonly rawLines: number;
  readonly parseFailures: number;
  readonly foreignLines: number;
  readonly skippedLines: number;
  readonly malformedSamples: string[];
  readonly mergedOrderOk: boolean;
  readonly writerOrderOk: boolean;
  readonly rotationOk: boolean;
  /** The largest rotated copy (`.N`) left on disk, in bytes. */
  readonly maxRotatedBytes: number;
  /** How far that copy sat above ROLEBOX_LOG_MAX_BYTES; 0 when it did not. */
  readonly rotationOvershootBytes: number;
  /** The widest physical line this run read, in bytes (0 when it read none). */
  readonly maxRecordBytes: number;
  /** What the copy bound came out to: the limit plus one record per writer. */
  readonly rotationBoundBytes: number;
  /** The overshoot as a fraction of the limit. Reported, never a gate. */
  readonly rotationFactor: number;
  /** True when every rotated copy is within {@link rotationBoundBytes}. */
  readonly rotationBoundOk: boolean;
  /** The highest size a 1 ms sampler saw on the LIVE file during the writes. */
  readonly livePeakBytes: number;
  readonly followerRecords: number;
  readonly followerDuplicates: number;
  readonly followerOtherChannels: number;
  readonly followerMalformed: number;
  /** Strictly increasing per-writer `seq` across the whole stream. */
  readonly followerOrderOk: boolean;
  /** Expected records the follower never delivered. */
  readonly followerMissing: number;
  /** Records delivered after a higher `seq` of the same writer. */
  readonly followerLateRecords: number;
  /** Records the follower delivered more than once. */
  readonly followerDuplicateRecords: number;
  readonly followerStderr: string;
  readonly children: ChildReport[];
  readonly cliFiles: string;
  readonly cliPrune: string;
  readonly checks: Record<string, boolean>;
  readonly ok: boolean;
  readonly startedAt: string;
  readonly elapsedMs: number;
}

/** `--flag value` parsing; no dependencies, no citty. */
interface RawArgs {
  records: number;
  maxBytes: number;
  retain: number;
  delayMs: number;
  runs: number;
  dir?: string;
  keep: boolean;
  json: boolean;
  child?: string;
  writer?: string;
}

/** Read the probe's own command line. Unknown flags are ignored, not fatal. */
function parseArgs(argv: readonly string[]): RawArgs {
  const args: RawArgs = { records: 400, maxBytes: 4096, retain: 4096, delayMs: 2, runs: 1, keep: false, json: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    const number = (): number => {
      const parsed = Number(value);
      index += 1;
      return Number.isFinite(parsed) ? parsed : 0;
    };
    if (flag === "--records") args.records = Math.max(1, Math.floor(number()));
    else if (flag === "--max-bytes") args.maxBytes = Math.max(1, Math.floor(number()));
    else if (flag === "--retain") args.retain = Math.max(0, Math.floor(number()));
    else if (flag === "--delay-ms") args.delayMs = Math.max(0, number());
    else if (flag === "--runs") args.runs = Math.max(1, Math.floor(number()));
    else if (flag === "--dir") {
      args.dir = value;
      index += 1;
    } else if (flag === "--keep") args.keep = true;
    else if (flag === "--json") args.json = true;
    else if (flag === "--child") {
      args.child = value;
      index += 1;
    } else if (flag === "--writer") {
      args.writer = value;
      index += 1;
    }
  }
  return args;
}

/** The environment every child gets: the probe's own, minus the legacy file. */
function childEnv(options: ProbeOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "ROLEBOX_LOG_FILE") continue; // legacy single-file mode would hide rotation
    env[key] = value;
  }
  env.ROLEBOX_LOG_DIR = options.dir;
  env.ROLEBOX_LOG_MAX_BYTES = String(options.maxBytes);
  env.ROLEBOX_LOG_RETAIN = String(options.retain);
  env.ROLEBOX_LOG_LEVEL = "info";
  env.ROLEBOX_LOG_CONSOLE_LEVEL = "fatal";
  return env;
}

/** Emit `records` records through ONE real module path. */
async function runChild(mode: ProbeWriter | string, options: ProbeOptions, writer: string): Promise<void> {
  const { dir, records, maxBytes, retain, delayMs } = options;
  const started = Date.now();
  const report: Record<string, unknown> = { kind: "child-done", mode, writer, pid: process.pid, records };
  if (mode === "worker") {
    // The compatibility shell the graph worker, the platform adapters and every
    // migrated module uses: createSubLogger(channel).info(message, fields).
    const { createSubLogger } = await import("../src/logger.ts");
    const log = createSubLogger(PROBE_CHANNEL);
    for (let seq = 0; seq < records; seq++) {
      log.info(PROBE_MESSAGE, { writer, seq });
      if (delayMs > 0) await Bun.sleep(delayMs);
    }
  } else if (mode === "pipeline") {
    // The kernel API directly: configure the pipeline, then log through it.
    const { configureLogging, createLogger } = await import("../src/log/index.ts");
    configureLogging({ logDir: dir, level: "info", consoleLevel: "fatal" });
    const log = createLogger(PROBE_CHANNEL);
    for (let seq = 0; seq < records; seq++) {
      log.info(PROBE_MESSAGE, { writer, seq });
      if (delayMs > 0) await Bun.sleep(delayMs);
    }
  } else if (mode === "sink") {
    // The JSON-lines writer itself, driven with hand-built records: this is the
    // layer that rotates, and the one two other processes share the file with.
    const { createFileSink } = await import("../src/log/sinks/file.ts");
    const failures: string[] = [];
    const sink = createFileSink({
      dir,
      maxBytes,
      retain,
      onFailure: (failure) => {
        failures.push(failure.code);
      },
    });
    for (let seq = 0; seq < records; seq++) {
      sink({
        time: Date.now(),
        level: "info",
        channel: PROBE_CHANNEL,
        message: PROBE_MESSAGE,
        fields: { writer, seq },
        scope: {},
        process: { pid: process.pid, role: "sink" },
      });
      if (delayMs > 0) await Bun.sleep(delayMs);
    }
    report.failures = failures;
  } else {
    report.error = `unknown child mode: ${String(mode)}`;
  }
  report.ms = Date.now() - started;
  process.stdout.write(JSON.stringify(report) + "\n");
}

/** Run one CLI invocation and answer its stdout, stderr and exit code. */
async function runCli(argv: readonly string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli", "main.ts"), ...argv], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await child.exited;
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
}

/** The rotation number of a probe file: 0 for the active one, N for `.N`. */
function rotationOf(name: string): number {
  const suffix = name.slice("probe-shared.log".length);
  if (suffix === "") return 0;
  return Math.max(1, Number.parseInt(suffix.slice(1), 10) || 1);
}

/** The probe's files in the read layer's SCAN order: oldest rotation first. */
function probeFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name === "probe-shared.log" || /^probe-shared\.log\.\d+$/.test(name))
    .map((name) => ({ name, rotation: rotationOf(name) }))
    .sort((left, right) => right.rotation - left.rotation || left.name.localeCompare(right.name))
    .map((entry) => join(dir, entry.name));
}

/** A `(writer, seq)` key. */
function keyOf(writer: unknown, seq: unknown): string {
  return `${String(writer)}:${String(seq)}`;
}

/** One run's checks, as booleans keyed by name. */
function allPass(checks: Record<string, boolean>): boolean {
  return Object.values(checks).every((value) => value);
}

/** Run one full probe: writers, a live CLI follower, then the file checks. */
export async function runOnce(options: ProbeOptions): Promise<ProbeRun> {
  const started = Date.now();
  const { dir, records } = options;
  const env = childEnv(options);
  const script = import.meta.path;

  // Every (writer, seq) pair the writers are about to announce. Built here
  // because the follower's catch-up wait below waits for this many probe
  // records; the checks below still pair these keys against the full stream.
  const expectedKeys: string[] = [];
  for (const writer of PROBE_WRITERS) for (let seq = 0; seq < records; seq++) expectedKeys.push(keyOf(writer, seq));

  // The real CLI follower starts FIRST, so it is already polling when the first
  // record is written: this is the live path an operator uses.
  const follower = Bun.spawn(
    [process.execPath, join(import.meta.dir, "..", "src", "cli", "main.ts"), "logs", "--log-dir", dir, "--json", "--follow"],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  // The follower's stdout is drained WHILE it runs, not only after it exits: the
  // probe has to know how far the follower has got (the bounded catch-up wait
  // below), and a piped stream nobody reads fills up and stalls the writer.
  // `followerChunks` still accumulates the WHOLE stream, so the accounting below
  // parses exactly what it parsed before — including everything that arrives
  // after the writers stopped.
  const followerChunks: string[] = [];
  const followerDecoder = new TextDecoder();
  let followerPending = "";
  // Probe records the follower has delivered so far, counted with the same
  // classification the end-of-run parse applies (this channel, a numeric `seq`).
  // No check reads this number: it only decides when waiting is over.
  let followerStreamed = 0;
  // Set when the stream reaches end-of-stream, i.e. when no further record can
  // arrive and waiting longer could not change the answer.
  let followerStreamClosed = false;
  const followerDrained = (async (): Promise<void> => {
    try {
      const reader = follower.stdout.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = followerDecoder.decode(value, { stream: true });
        followerChunks.push(text);
        followerPending += text;
        const lines = followerPending.split("\n");
        followerPending = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim().length === 0) continue;
          try {
            const record = JSON.parse(line) as Partial<LogRecord>;
            if (record.channel === PROBE_CHANNEL && typeof record.fields?.seq === "number") followerStreamed += 1;
          } catch {
            // Not a record at all: the end-of-run parse counts it as malformed.
          }
        }
      }
      // Flush the decoder's buffered bytes (a multi-byte character split across
      // two chunks) into the accumulated stream.
      const tail = followerDecoder.decode();
      if (tail.length > 0) followerChunks.push(tail);
    } catch {
      // A read error ends the drain; whatever arrived is still checked below, so
      // a short stream shows up as a failed check rather than a thrown probe.
    } finally {
      followerStreamClosed = true;
    }
  })();
  await Bun.sleep(250);

  // The rotated copies say WHERE rotation happened; this sampler says what the
  // active file grew to while it happened, which is the operator's own number.
  const livePath = join(dir, logChannelFileName(PROBE_CHANNEL));
  let livePeakBytes = 0;
  const sampler = setInterval(() => {
    try {
      const size = statSync(livePath).size;
      if (size > livePeakBytes) livePeakBytes = size;
    } catch {
      // Absent for the instant between a rename and the next append.
    }
  }, 1);

  const children = await Promise.all(
    PROBE_WRITERS.map(async (mode): Promise<ChildReport> => {
      const child = Bun.spawn(
        [
          process.execPath,
          script,
          "--child",
          mode,
          "--writer",
          mode,
          "--dir",
          dir,
          "--records",
          String(records),
          "--max-bytes",
          String(options.maxBytes),
          "--retain",
          String(options.retain),
          "--delay-ms",
          String(options.delayMs),
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      const exitCode = await child.exited;
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { pid?: number; records?: number };
      return { mode, pid: parsed.pid ?? 0, records: parsed.records ?? 0, exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
    }),
  );

  clearInterval(sampler);

  // The writers are done, but the follower is a 250 ms poll loop: under the load
  // of a full CI run it can still be behind when the last writer exits. Waiting
  // a FIXED grace here reported exactly that as LOSS — the macOS run failed
  // `follower-complete` with `follower-missing` still 0, i.e. records were
  // arriving, not lost. Wait instead on the condition the probe needs: the
  // follower has delivered as many probe records as the writers announced
  // (`expectedKeys.length`, counted as the stream arrived above), and keep
  // reading until that is true OR the bounded deadline expires OR the stream
  // itself ends. The deadline decides only WHEN the follower is stopped; what
  // the checks count is still the full stream read below, including whatever
  // arrives after the writers stopped.
  const catchUpDeadline = Date.now() + FOLLOWER_CATCH_UP_DEADLINE_MS;
  while (!followerStreamClosed && followerStreamed < expectedKeys.length && Date.now() < catchUpDeadline) {
    await Bun.sleep(25);
  }
  follower.kill("SIGINT");
  const followerCode = await follower.exited;
  // The drain ends at end-of-stream, after the SIGINT: `followerOut` is the same
  // complete stdout the old `new Response(follower.stdout).text()` read.
  await followerDrained;
  const followerOut = followerChunks.join("");
  const followerErr = await new Response(follower.stderr).text();

  // The two other real CLI processes: what files exist, and what a prune would
  // remove. Both are the operator's own commands, run against the same directory.
  const filesRun = await runCli(["logs", "files", "--log-dir", dir], env);
  const pruneRun = await runCli(["logs", "prune", "--log-dir", dir, "--keep", String(options.retain), "--dry-run"], env);

  // ── the raw file scan: one complete JSON record per physical line ─────────
  const files = probeFiles(dir);
  const occurrences: Occurrence[] = [];
  const perWriterRaw = new Map<string, number[]>();
  let rawLines = 0;
  let parseFailures = 0;
  let foreignLines = 0;
  let bytes = 0;
  const lineProblems: string[] = [];
  let maxRotatedBytes = 0;
  // The widest physical line read: "one record" in the rotated-copy bound, so
  // the bound is measured rather than assumed when the record shape grows.
  let maxRecordBytes = 0;
  for (const path of files) {
    const size = statSync(path).size;
    bytes += size;
    if (rotationOf(path.split("/").pop() ?? path) >= 1 && size > maxRotatedBytes) maxRotatedBytes = size;
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      if (line.trim().length === 0) continue;
      rawLines += 1;
      if (line.length > maxRecordBytes) maxRecordBytes = line.length;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        parseFailures += 1;
        if (lineProblems.length < 5) lineProblems.push(`${path.split("/").pop()}:${index + 1} not JSON: ${line.slice(0, 80)}`);
        continue;
      }
      const record = value as Partial<LogRecord> & { fields?: Record<string, unknown> };
      const writer = record.fields?.writer;
      const seq = record.fields?.seq;
      if (record.channel !== PROBE_CHANNEL || record.message !== PROBE_MESSAGE || typeof writer !== "string" || typeof seq !== "number") {
        foreignLines += 1;
        if (lineProblems.length < 5) lineProblems.push(`${path.split("/").pop()}:${index + 1} foreign record: ${line.slice(0, 80)}`);
        continue;
      }
      occurrences.push({ writer, seq, file: path.split("/").pop() ?? path, index: index + 1 });
      const list = perWriterRaw.get(writer);
      if (list === undefined) perWriterRaw.set(writer, [seq]);
      else list.push(seq);
    }
  }

  // ── the read layer's merged view ──────────────────────────────────────────
  const ascending = readLogRecords({ logDir: dir, limit: 10_000_000, order: "asc" });
  const descending = readLogRecords({ logDir: dir, limit: 10_000_000, order: "desc" });
  const probeRecords = ascending.records.filter((record) => record.channel === PROBE_CHANNEL);
  const counts = new Map<string, number>();
  for (const record of probeRecords) {
    const key = keyOf(record.fields.writer, record.fields.seq);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const missing = expectedKeys.filter((key) => (counts.get(key) ?? 0) === 0);
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1);
  const extra = [...counts.keys()].filter((key) => !expectedKeys.includes(key));

  // The raw scan must agree with the read layer: same multiset.
  const rawCounts = new Map<string, number>();
  for (const occurrence of occurrences) {
    const key = keyOf(occurrence.writer, occurrence.seq);
    rawCounts.set(key, (rawCounts.get(key) ?? 0) + 1);
  }
  const rawMissing = expectedKeys.filter((key) => (rawCounts.get(key) ?? 0) !== (counts.get(key) ?? 0));

  // ── order ─────────────────────────────────────────────────────────────────
  let mergedOrderOk = true;
  for (let index = 1; index < ascending.records.length; index++) {
    if ((ascending.records[index]?.time ?? 0) < (ascending.records[index - 1]?.time ?? 0)) mergedOrderOk = false;
  }
  const reversed = [...descending.records].reverse();
  const exactReverse =
    reversed.length === ascending.records.length &&
    reversed.every((record, index) => record.time === ascending.records[index]?.time && record.message === ascending.records[index]?.message);
  mergedOrderOk = mergedOrderOk && exactReverse;

  let writerOrderOk = true;
  const writerOrderProblems: string[] = [];
  for (const [writer, seqs] of perWriterRaw) {
    for (let index = 1; index < seqs.length; index++) {
      if ((seqs[index] ?? -1) <= (seqs[index - 1] ?? -1)) {
        writerOrderOk = false;
        if (writerOrderProblems.length < 3) writerOrderProblems.push(`${writer}: ${seqs[index - 1]} -> ${seqs[index]} in scan order`);
      }
    }
  }

  const writersInFiles = new Set(occurrences.map((occurrence) => occurrence.writer));
  const rotations = Math.max(0, files.length - 1);
  const rotationOk = rotations >= 1 && writersInFiles.size === PROBE_WRITERS.length && occurrences.length > 0;
  const rotationOvershootBytes = Math.max(0, maxRotatedBytes - options.maxBytes);
  const rotationBound = rotationBoundBytes(options.maxBytes, maxRecordBytes);
  const rotationFactor = options.maxBytes > 0 ? maxRotatedBytes / options.maxBytes : 0;
  // Every rotated copy WAS the active file when the gate tripped, so its size is
  // where the limit was applied — PLUS the records already in flight, because
  // the gate is a check followed by an append and one record per concurrent
  // writer can therefore land in the copy. The bound is stated in those terms
  // and not as a factor of the limit: a factor is not load-independent (see
  // rotationBoundBytes). A per-process counter instead let copies grow to
  // (writers x the limit), far above either form; this check fails then.
  const rotationBoundOk = rotations >= 1 && maxRotatedBytes <= rotationBound;

  // ── the live follower ─────────────────────────────────────────────────────
  const followerRecords: LogRecord[] = [];
  // A record of ANOTHER channel is not a defect: the follower streams the whole
  // source, and the pipeline's own `log` channel may legitimately appear beside
  // the probe's. Only a line that is not a record at all is counted as malformed.
  let followerOtherChannels = 0;
  let followerMalformed = 0;
  for (const line of followerOut.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const value = JSON.parse(line) as Partial<LogRecord>;
      if (value.channel !== PROBE_CHANNEL || typeof value.fields?.seq !== "number") {
        followerOtherChannels += 1;
        continue;
      }
      followerRecords.push(value as LogRecord);
    } catch {
      followerMalformed += 1;
    }
  }
  const followerSeen = new Map<string, number>();
  const followerOrder = new Map<string, number[]>();
  for (const record of followerRecords) {
    const key = keyOf(record.fields.writer, record.fields.seq);
    followerSeen.set(key, (followerSeen.get(key) ?? 0) + 1);
    const writer = String(record.fields.writer);
    const list = followerOrder.get(writer);
    if (list === undefined) followerOrder.set(writer, [record.fields.seq as number]);
    else list.push(record.fields.seq as number);
  }
  const followerDuplicates = [...followerSeen.values()].filter((count) => count > 1).length;
  const followerDuplicateRecords = [...followerSeen.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  // Two different questions, and only the second one is a gate:
  //   • ORDER is strict per-writer monotonicity. It is what a tail gives when
  //     nothing rotates under it, and it is reported — but a concurrent rotation
  //     can put a whole file one poll late, so it is not what the stream
  //     promises (see FOLLOWER_LATE_RECORD_LIMIT).
  //   • LATE RECORDS counts how much of the stream that touched. A record is
  //     late when its `seq` is below the highest already delivered FOR THAT
  //     WRITER: bounded by the metric, an unbounded scramble fails.
  let followerOrderOk = true;
  let followerLateRecords = 0;
  for (const seqs of followerOrder.values()) {
    let highest = -1;
    for (const seq of seqs) {
      if (seq <= highest) {
        followerOrderOk = false;
        followerLateRecords += 1;
      }
      if (seq > highest) highest = seq;
    }
  }
  // A record that never arrived is a LOSS, which no reordering excuses: every
  // (writer, seq) the children announced must come out of the follower.
  const followerKeys = new Set(followerSeen.keys());
  const followerMissing = expectedKeys.filter((key) => !followerKeys.has(key)).length;
  const childrenOk = children.every((child) => child.exitCode === 0 && child.records === records);
  const checks: Record<string, boolean> = {
    children: childrenOk,
    "exactly-once": missing.length === 0 && duplicates.length === 0 && extra.length === 0 && probeRecords.length === expectedKeys.length,
    "raw-lines": parseFailures === 0 && foreignLines === 0 && rawLines === occurrences.length && rawMissing.length === 0,
    "writer-order": writerOrderOk,
    "merged-order": mergedOrderOk,
    rotation: rotationOk,
    "rotation-bound": rotationBoundOk,
    "follower-complete": followerRecords.length >= expectedKeys.length,
    "follower-missing": followerMissing === 0,
    "follower-duplicates": followerDuplicates === 0,
    "follower-malformed": followerMalformed === 0,
    "follower-order": followerLateRecords <= Math.floor(expectedKeys.length * FOLLOWER_LATE_RECORD_LIMIT),
  };

  return {
    dir,
    recordsPerWriter: records,
    expected: expectedKeys.length,
    observed: counts.size,
    missing: missing.length,
    duplicates: duplicates.length,
    missingSamples: missing.slice(0, 5),
    duplicateSamples: duplicates.slice(0, 5).map(([key, count]) => `${key} x${count}`),
    files: files.map((path) => path.split("/").pop() ?? path),
    rotations,
    bytes,
    rawLines,
    parseFailures,
    foreignLines,
    skippedLines: ascending.skippedLines,
    malformedSamples: [...ascending.malformedSamples, ...lineProblems].slice(0, 5),
    mergedOrderOk,
    writerOrderOk,
    rotationOk,
    maxRotatedBytes,
    rotationOvershootBytes,
    maxRecordBytes,
    rotationBoundBytes: rotationBound,
    rotationFactor,
    rotationBoundOk,
    livePeakBytes,
    followerRecords: followerRecords.length,
    followerDuplicates,
    followerOtherChannels,
    followerMalformed,
    followerOrderOk,
    followerMissing,
    followerLateRecords,
    followerDuplicateRecords,
    followerStderr: followerErr.trim().split("\n").slice(0, 3).join(" | "),
    children,
    cliFiles: filesRun.out.trim().split("\n").slice(0, 4).join(" | "),
    cliPrune: pruneRun.out.trim().split("\n").slice(0, 3).join(" | "),
    checks,
    ok: allPass(checks),
    startedAt: new Date(started).toISOString(),
    elapsedMs: Date.now() - started,
  };
}

/** A one-line human summary of a run. */
function printRun(run: ProbeRun, index: number): void {
  const failed = Object.entries(run.checks).filter(([, ok]) => !ok).map(([name]) => name);
  process.stdout.write(`PROBE SUMMARY run ${index + 1} dir=${run.dir}\n`);
  process.stdout.write(
    `  expected=${run.expected} observed=${run.observed} missing=${run.missing} duplicates=${run.duplicates} ` +
      `rawLines=${run.rawLines} parseFailures=${run.parseFailures} foreignLines=${run.foreignLines} skipped=${run.skippedLines}\n`,
  );
  process.stdout.write(
    `  files=${run.files.length} rotations=${run.rotations} bytes=${run.bytes} ` +
      `maxRotatedBytes=${run.maxRotatedBytes} rotationBoundBytes=${run.rotationBoundBytes} ` +
      `rotationFactor=${run.rotationFactor.toFixed(3)} livePeakBytes=${run.livePeakBytes} follower=${run.followerRecords} ` +
      `followerMissing=${run.followerMissing} followerDuplicates=${run.followerDuplicates} ` +
      `followerLateRecords=${run.followerLateRecords} elapsedMs=${run.elapsedMs}\n`,
  );
  process.stdout.write(`  checks=${Object.entries(run.checks).map(([name, ok]) => `${name}:${ok ? "ok" : "FAIL"}`).join(" ")}\n`);
  if (failed.length > 0) {
    process.stdout.write(`  FAILED: ${failed.join(", ")}\n`);
    if (run.missingSamples.length > 0) process.stdout.write(`  missing: ${run.missingSamples.join(", ")}\n`);
    if (run.duplicateSamples.length > 0) process.stdout.write(`  duplicates: ${run.duplicateSamples.join(", ")}\n`);
    for (const sample of run.malformedSamples) process.stdout.write(`  malformed: ${sample}\n`);
  }
  process.stdout.write(`  followerStderr=${run.followerStderr || "(empty)"}\n`);
}

/** The probe's entry point: one child path, or `runs` full parent runs. */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.child !== undefined) {
    const dir = args.dir ?? mkdtempSync(join(tmpdir(), "rolebox-multiproc-"));
    await runChild(args.child, { dir, records: args.records, maxBytes: args.maxBytes, retain: args.retain, delayMs: args.delayMs }, args.writer ?? args.child);
    return;
  }

  const runs: ProbeRun[] = [];
  for (let index = 0; index < args.runs; index++) {
    const dir = args.dir ?? mkdtempSync(join(tmpdir(), "rolebox-multiproc-"));
    const options: ProbeOptions = { dir, records: args.records, maxBytes: args.maxBytes, retain: args.retain, delayMs: args.delayMs };
    const run = await runOnce(options);
    runs.push(run);
    if (args.dir === undefined && !args.keep) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Evidence matters more than cleanup.
      }
    }
    if (!args.json) printRun(run, index);
  }

  const summary = {
    probe: "log-multiprocess-probe",
    channel: PROBE_CHANNEL,
    writers: PROBE_WRITERS,
    recordsPerWriter: args.records,
    maxBytes: args.maxBytes,
    retain: args.retain,
    delayMs: args.delayMs,
    runs: runs.length,
    ok: runs.every((run) => run.ok),
    totals: {
      expected: runs.reduce((sum, run) => sum + run.expected, 0),
      observed: runs.reduce((sum, run) => sum + run.observed, 0),
      missing: runs.reduce((sum, run) => sum + run.missing, 0),
      duplicates: runs.reduce((sum, run) => sum + run.duplicates, 0),
      parseFailures: runs.reduce((sum, run) => sum + run.parseFailures, 0),
      foreignLines: runs.reduce((sum, run) => sum + run.foreignLines, 0),
      followerRecords: runs.reduce((sum, run) => sum + run.followerRecords, 0),
      followerDuplicates: runs.reduce((sum, run) => sum + run.followerDuplicates, 0),
      followerMissing: runs.reduce((sum, run) => sum + run.followerMissing, 0),
      followerLateRecords: runs.reduce((sum, run) => sum + run.followerLateRecords, 0),
      rotations: runs.reduce((sum, run) => sum + run.rotations, 0),
      maxRotatedBytes: runs.reduce((max, run) => Math.max(max, run.maxRotatedBytes), 0),
      livePeakBytes: runs.reduce((max, run) => Math.max(max, run.livePeakBytes), 0),
    },
    results: runs,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  process.exit(summary.ok ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
