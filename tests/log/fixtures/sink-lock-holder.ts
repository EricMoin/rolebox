// ── The other process a file-sink case needs ────────────────────────────────
//
// tests/log/sinks.test.ts drives the sink on ONE thread, and the sink's wait for
// another process's rotation parks that thread (Atomics.wait) — so a test cannot
// both hold the rotation lock and watch the sink wait for it. This fixture is
// the real other process, spawned with `bun run`, in the two roles the wait has
// to tell apart:
//
//   --mode hold    take `<dir>/<channel>.log.rotate.lock`, refresh its mtime
//                  while it is held, then remove it. This is a rotation that is
//                  slow but PROGRESSING — what a waiting sink must stay for,
//                  however long it takes.
//   --mode rotate  run ONE real record through createFileSink against the ladder
//                  the parent built. This is the holder side of the heartbeat:
//                  the lock's mtime moves while the walk runs.
//
// It prints nothing on success: the parent reads the file system, and a failure
// is a non-zero child exit plus its stderr.

import { rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ROTATE_HEARTBEAT_MS,
  ROTATE_LOCK_SUFFIX,
  createFileSink,
  logChannelFileName,
} from "../../../src/log/sinks/file.ts";

/** `--flag value` pairs, the shape the sibling probes use. */
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set((process.argv[index] ?? "").replace(/^--/, ""), process.argv[index + 1] ?? "");
}

const dir = args.get("dir");
if (dir === undefined) throw new Error("sink-lock-holder needs --dir");
const channel = args.get("channel") ?? "held";
const path = join(dir, logChannelFileName(channel));
const lock = path + ROTATE_LOCK_SUFFIX;

if ((args.get("mode") ?? "hold") === "hold") {
  const holdMs = Number(args.get("hold-ms") ?? "400");
  // Tick FASTER than the production heartbeat so a scheduling hiccup cannot
  // make a holder that is genuinely alive look stalled to the sink under test.
  const tickMs = Math.max(1, Math.floor(ROTATE_HEARTBEAT_MS / 5));
  writeFileSync(lock, String(process.pid), "utf8");
  const deadline = Date.now() + holdMs;
  while (Date.now() < deadline) {
    Bun.sleepSync(tickMs);
    const now = new Date();
    utimesSync(lock, now, now);
  }
  rmSync(lock, { force: true });
} else {
  const sink = createFileSink({
    dir,
    maxBytes: Number(args.get("max-bytes") ?? "1"),
    retain: Number(args.get("retain") ?? "3"),
  });
  sink({
    time: Date.now(),
    level: "info",
    channel,
    message: "holder-rotated",
    fields: { by: "sink-lock-holder" },
    scope: {},
    process: { pid: process.pid, role: "worker" },
  });
  sink.close();
}
