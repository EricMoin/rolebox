#!/usr/bin/env bun
// ── Which registered events actually flood the log? ─────────────────────────
//
// THE EVIDENCE BEHIND EVERY `throttleMs` IN src/log/registry.ts. Throttling is
// opt-in per entry, so the question "which entries should opt in" has to be
// answered from the log a real workspace produced, not from taste. This script
// reads a log directory through the platform's OWN read layer (listLogFiles +
// readLogRecords, so the numbers are what `rolebox logs` sees) and reports, per
// (channel, code):
//
//   total        records of that code in the sample;
//   max/60s      the most records of that code inside any 60-second window —
//   max/10s      the burst size, from 60 s down to 1 s. A loop that re-emits the
//   max/1s       same fact shows up here;
//   same-as-prev how many records carry exactly the fields of the record before
//                them: a repeat of the same observation, not a new one;
//   signatures   how many DISTINCT field sets the code produced. `total` much
//                larger than `signatures` plus `same-as-prev` is the fingerprint
//                of a re-reporting loop;
//   would-emit   for a code that already declares `throttleMs`: how many of its
//                records the gate would let through (the first of each window),
//                i.e. what the throttle costs and what it saves. A code whose
//                entry declares `throttleBy` holds ONE WINDOW PER SUBJECT, so
//                this column sums the per-subject decisions instead of counting
//                one (channel, code) window — see below.
//
// THE SUBJECT DIMENSION IS MODELLED FOR `would-emit` ONLY. A row is one
// (channel, code) pair, the unit the read layer groups by, and the burst and
// repetition columns (`total`, `max/60s`, `max/10s`, `max/1s`, `same-as-prev`,
// `signatures`) say nothing about how a code's records divide into subjects;
// today no entry with a subject window has a row here at all. `would-emit` is
// the one column a subject window can make wrong, so it reads the entry's own
// `throttleBy` through the pipeline's `logThrottleSubject` and measures each
// subject's window separately: one (channel, code) window would UNDERSTATE what
// the gate lets through, because every subject emits its own first record.
// An entry WITHOUT `throttleBy` is computed exactly as it was before.
//
// USAGE
//   bun scripts/log-event-density.ts [--dir <logDir>] [--json] [--window <ms>]
//
// Without `--dir` the read layer's own resolution decides (ROLEBOX_LOG_FILE,
// then ROLEBOX_LOG_DIR, then the workspace's `.rolebox/logs`).
//
// A DENSITY IS NOT A VERDICT. A code with many records may be reporting many
// DISTINCT facts (index.confirmation-refused names a different generation every
// time); a code with few records may be the first warning of a real failure and
// must stay unthrottled. This script prints the counts; the decision and its
// reason live beside each `throttleMs` in the registry.

import { LOG_EVENTS, listLogFiles, readLogRecords } from "../src/log/index.ts";
import { logThrottleSubject } from "../src/log/throttle.ts";
import type { LogEventDefinition } from "../src/log/index.ts";
import type { LogRecord } from "../src/log/types.ts";

/** One (channel, code) row of the report. */
interface DensityRow {
  readonly channel: string;
  readonly code: string;
  readonly total: number;
  readonly max60: number;
  readonly max10: number;
  readonly max1: number;
  readonly sameAsPrev: number;
  readonly signatures: number;
  readonly throttleMs?: number;
  readonly wouldEmit?: number;
}

/** Read `--flag value` pairs from the command line. */
function argValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

/** The largest number of `times` inside any window of `windowMs`. */
function maxInWindow(times: readonly number[], windowMs: number): number {
  const sorted = [...times].sort((left, right) => left - right);
  let best = 0;
  let start = 0;
  for (let end = 0; end < sorted.length; end++) {
    while ((sorted[end] ?? 0) - (sorted[start] ?? 0) > windowMs) start += 1;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

/**
 * How many records a `throttleMs` window would let through, in time order.
 *
 * A SUBJECT-KEYED ENTRY (`throttleBy`) holds one window per `(channel, code,
 * subject)`, so the count is the sum over subjects: two subjects inside one
 * window each emit their first record, and a single (channel, code) window would
 * understate what the gate lets through. The subject is read with the pipeline's
 * own `logThrottleSubject`, so this column cannot drift from the gate it models.
 */
function emittedUnderThrottle(
  records: readonly LogRecord[],
  throttleMs: number,
  throttleBy: string | undefined,
): number {
  if (throttleBy === undefined) {
    return emittedInOneWindow(records.map((record) => record.time), throttleMs);
  }
  const bySubject = new Map<string, number[]>();
  for (const record of records) {
    const subject = logThrottleSubject(record.fields, throttleBy);
    const times = bySubject.get(subject);
    if (times === undefined) bySubject.set(subject, [record.time]);
    else times.push(record.time);
  }
  let emitted = 0;
  for (const times of bySubject.values()) emitted += emittedInOneWindow(times, throttleMs);
  return emitted;
}

/** How many timestamps ONE window lets through, in time order. */
function emittedInOneWindow(times: readonly number[], throttleMs: number): number {
  const sorted = [...times].sort((left, right) => left - right);
  let emitted = 0;
  let last: number | undefined;
  for (const time of sorted) {
    if (last === undefined || time < last || time - last >= throttleMs) {
      last = time;
      emitted += 1;
    }
  }
  return emitted;
}

/** A stable signature of a record's fields, for the "same observation" count. */
function signatureOf(record: LogRecord): string {
  const keys = Object.keys(record.fields).sort();
  return JSON.stringify(keys.map((key) => [key, record.fields[key]]));
}

/** Every row, computed from one read of the source. */
function density(dir: string | undefined, windowMs: number): DensityRow[] {
  const query = dir === undefined ? { limit: 5_000_000, order: "asc" as const } : { logDir: dir, limit: 5_000_000, order: "asc" as const };
  const records = readLogRecords(query).records.filter((record) => record.code !== undefined);
  const byCode = new Map<string, LogRecord[]>();
  for (const record of records) {
    const key = record.channel + "\u0000" + String(record.code);
    const group = byCode.get(key);
    if (group === undefined) byCode.set(key, [record]);
    else group.push(record);
  }

  const rows: DensityRow[] = [];
  for (const [key, group] of byCode) {
    const [channel = "", code = ""] = key.split("\u0000");
    const times = group.map((record) => record.time);
    const signatures = new Set<string>();
    let sameAsPrev = 0;
    let previous: string | undefined;
    for (const record of group) {
      const signature = signatureOf(record);
      signatures.add(signature);
      if (signature === previous) sameAsPrev += 1;
      previous = signature;
    }
    const definition = (LOG_EVENTS as Record<string, LogEventDefinition>)[code];
    const throttleMs = definition?.throttleMs;
    rows.push({
      channel,
      code,
      total: group.length,
      max60: maxInWindow(times, 60_000),
      max10: maxInWindow(times, 10_000),
      max1: maxInWindow(times, Math.min(1_000, windowMs)),
      sameAsPrev,
      signatures: signatures.size,
      ...(throttleMs === undefined
        ? {}
        : { throttleMs, wouldEmit: emittedUnderThrottle(group, throttleMs, definition?.throttleBy) }),
    });
  }
  rows.sort((left, right) => right.total - left.total || left.code.localeCompare(right.code));
  return rows;
}

/** The report entry point. */
function main(): void {
  const argv = process.argv.slice(2);
  const dir = argValue(argv, "--dir");
  const windowArg = argValue(argv, "--window");
  const windowMs = windowArg === undefined ? 1_000 : Math.max(1, Number(windowArg) || 1_000);
  const json = argv.includes("--json");

  const files = listLogFiles(dir === undefined ? {} : { logDir: dir });
  const rows = density(dir, windowMs);

  if (json) {
    process.stdout.write(JSON.stringify({ files: files.length, rows }, null, 2) + "\n");
    return;
  }

  const name = (row: DensityRow): string => `${row.channel}/${row.code}`;
  const width = Math.max(34, ...rows.map((row) => name(row).length));
  process.stdout.write(`files=${files.length} codes=${rows.length} (${dir ?? "resolved source"})\n`);
  process.stdout.write(
    "  " +
      "channel/code".padEnd(width) +
      " total  max/60s  max/10s  max/1s  same-as-prev  signatures  throttleMs  would-emit\n",
  );
  for (const row of rows) {
    process.stdout.write(
      "  " +
        name(row).padEnd(width) +
        String(row.total).padStart(6) +
        String(row.max60).padStart(9) +
        String(row.max10).padStart(9) +
        String(row.max1).padStart(8) +
        String(row.sameAsPrev).padStart(14) +
        String(row.signatures).padStart(12) +
        String(row.throttleMs ?? "-").padStart(12) +
        String(row.wouldEmit ?? "-").padStart(12) +
        "\n",
    );
  }
}

main();
