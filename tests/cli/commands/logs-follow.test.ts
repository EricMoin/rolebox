/**
 * `rolebox logs --follow` — the live tail.
 *
 * A follower has no end, so every case here is a START and a STOP: the runner
 * takes its abort signal and its waiter through the `LogsIo` seam, and each test
 * waits (bounded) for the record it appended and then aborts. Nothing may hang —
 * a follower that ignores its stop signal fails the test through
 * {@link settleWithin} instead of blocking the suite.
 *
 * The contract asserted here is the read layer's, surfaced by the CLI: a
 * follower starts at the CURRENT end of every file (the past is not replayed),
 * records arrive as they are written, `--limit`/`--order` do not apply to a
 * stream, and the stop is clean — exit code 0, nothing on stderr.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runLogsQuery, type LogsIo } from "../../../src/cli/commands/logs/logs-run.ts";
import { formatLogLine } from "../../../src/log/sinks/console.ts";
import type { LogRecord } from "../../../src/log/types.ts";
import { makeRecord, setLogEnv } from "../../helpers/log.ts";

const BASE = Date.parse("2026-10-08T10:00:00.000Z");

let dir: string;
/** `ROLEBOX_LOG_FILE` as the test found it. */
let originalLogFile: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rolebox-logs-follow-"));
  // A case that names no location reads the WRITER'S chain, where an exported
  // ROLEBOX_LOG_FILE outranks ROLEBOX_LOG_DIR and would silently redirect the
  // case at the developer's own file.
  originalLogFile = process.env.ROLEBOX_LOG_FILE;
  setLogEnv("ROLEBOX_LOG_FILE", undefined);
});

afterEach(() => {
  setLogEnv("ROLEBOX_LOG_FILE", originalLogFile);
  rmSync(dir, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────────────

/** One record, with the writer's defaults filled in. */
function record(time: number, channel: string, message: string): LogRecord {
  return makeRecord({ time, channel, level: "info", message });
}

/** Append one record as the JSON line the writer produces. */
function append(fileName: string, item: LogRecord): void {
  appendFileSync(join(dir, fileName), JSON.stringify(item) + "\n", "utf8");
}

/** A collector standing in for the two writers. */
function capture(): { out: string[]; err: string[]; io: LogsIo } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (line: string): void => {
        out.push(line);
      },
      err: (line: string): void => {
        err.push(line);
      },
    },
  };
}

/** Wait (bounded) until `predicate` holds; throws instead of hanging. */
function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("timed out waiting for the follower"));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

/** Await `promise`, but fail the test rather than hang if it never settles. */
async function settleWithin<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The io a follower case uses: a real waiter, a 1ms poll and the signal. */
function followerIo(seen: { io: LogsIo }, signal: AbortSignal): LogsIo {
  return {
    ...seen.io,
    signal,
    pollMs: 1,
    sleep: (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
}

// ── Following ──────────────────────────────────────────────────────────────

describe("rolebox logs --follow", () => {
  it("streams records written after it starts and never replays the past", async () => {
    const past = record(BASE, "cli", "written before the follower started");
    writeFileSync(join(dir, "cli.log"), JSON.stringify(past) + "\n", "utf8");

    const seen = capture();
    const controller = new AbortController();
    const running = runLogsQuery(
      { logDir: dir, limit: 100, order: "desc", json: true, follow: true },
      followerIo(seen, controller.signal),
    );

    const live = record(BASE + 1_000, "cli", "appended while following");
    append("cli.log", live);
    await waitUntil(() => seen.out.length > 0);
    controller.abort();

    expect(await settleWithin(running)).toBe(0);
    // `--json` writes the record the READ layer normalised, one line per record.
    expect(seen.out).toHaveLength(1);
    expect(JSON.parse(seen.out[0] ?? "{}")).toEqual(live);
    expect(seen.out[0]?.includes("\n")).toBe(false);
    expect(seen.err).toEqual([]);
  });

  it("renders the streamed record with the runtime's own human line", async () => {
    writeFileSync(join(dir, "cli.log"), "", "utf8");
    const seen = capture();
    const controller = new AbortController();
    const running = runLogsQuery(
      { logDir: dir, limit: 100, order: "desc", json: false, follow: true },
      followerIo(seen, controller.signal),
    );

    const live = record(BASE + 1_000, "cli", "human line please");
    append("cli.log", live);
    await waitUntil(() => seen.out.length > 0);
    controller.abort();
    await settleWithin(running);

    expect(seen.out).toEqual([formatLogLine(live)]);
  });

  it("applies the query filters to the stream", async () => {
    writeFileSync(join(dir, "alpha.log"), "", "utf8");
    writeFileSync(join(dir, "beta.log"), "", "utf8");
    const seen = capture();
    const controller = new AbortController();
    const running = runLogsQuery(
      { logDir: dir, limit: 100, order: "desc", json: true, follow: true, channels: ["beta"] },
      followerIo(seen, controller.signal),
    );

    append("alpha.log", record(BASE + 1_000, "alpha", "not wanted"));
    append("beta.log", record(BASE + 1_001, "beta", "wanted"));
    await waitUntil(() => seen.out.length > 0);
    controller.abort();
    await settleWithin(running);

    expect(seen.out).toHaveLength(1);
    expect((JSON.parse(seen.out[0] ?? "{}") as LogRecord).message).toBe("wanted");
  });

  it("does not cap a stream at --limit: a stream has no end", async () => {
    writeFileSync(join(dir, "cli.log"), "", "utf8");
    const seen = capture();
    const controller = new AbortController();
    const running = runLogsQuery(
      { logDir: dir, limit: 1, order: "desc", json: true, follow: true },
      followerIo(seen, controller.signal),
    );

    append("cli.log", record(BASE + 1_000, "cli", "one"));
    append("cli.log", record(BASE + 1_001, "cli", "two"));
    await waitUntil(() => seen.out.length >= 2);
    controller.abort();
    await settleWithin(running);

    expect(seen.out).toHaveLength(2);
  });

  it("waits on a directory with no files yet and streams the first record written", async () => {
    const empty = join(dir, "empty");
    mkdirSync(empty, { recursive: true });
    const seen = capture();
    const controller = new AbortController();
    const running = runLogsQuery(
      { logDir: empty, limit: 100, order: "desc", json: true, follow: true },
      followerIo(seen, controller.signal),
    );

    // An empty source is not an answer that ends the command — like `tail -f`,
    // the follower waits, says so on stderr and starts the file at its beginning
    // when it appears.
    await waitUntil(() => seen.err.length > 0);
    expect(seen.err[0]).toBe(`no log files in ${empty} yet`);
    expect(seen.err[1]).toContain("waiting for the first record");
    expect(seen.out).toEqual([]);

    const live = record(BASE + 1_000, "cli", "the first record");
    appendFileSync(join(empty, "cli.log"), JSON.stringify(live) + "\n", "utf8");
    await waitUntil(() => seen.out.length > 0);
    controller.abort();

    expect(await settleWithin(running)).toBe(0);
    expect(seen.out).toHaveLength(1);
    expect(JSON.parse(seen.out[0] ?? "{}")).toEqual(live);
  });

  it("stops cleanly when the signal is already aborted, writing nothing", async () => {
    writeFileSync(join(dir, "cli.log"), JSON.stringify(record(BASE, "cli", "past")) + "\n", "utf8");
    const seen = capture();
    const controller = new AbortController();
    controller.abort();

    const running = runLogsQuery(
      { logDir: dir, limit: 100, order: "desc", json: true, follow: true },
      followerIo(seen, controller.signal),
    );

    expect(await settleWithin(running)).toBe(0);
    expect(seen.out).toEqual([]);
    expect(seen.err).toEqual([]);
  });

  it("stops when the signal aborts with no record in flight", async () => {
    writeFileSync(join(dir, "cli.log"), "", "utf8");
    const seen = capture();
    const controller = new AbortController();

    const running = runLogsQuery(
      { logDir: dir, limit: 100, order: "desc", json: false, follow: true },
      followerIo(seen, controller.signal),
    );
    controller.abort();

    expect(await settleWithin(running)).toBe(0);
    expect(seen.out).toEqual([]);
  });
});
