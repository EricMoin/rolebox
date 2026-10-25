import { sleepSync } from "../../../scripts/node-process.ts";

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

const mode = args.get("mode") ?? "hold";
if (mode === "hold" || mode === "hold-still") {
  const holdMs = Number(args.get("hold-ms") ?? "400");
  // In hold mode, tick faster than the production heartbeat. The still mode
  // leaves mtime unchanged to model a descheduled owner.
  const tickMs = Math.max(1, Math.floor(ROTATE_HEARTBEAT_MS / 5));
  writeFileSync(lock, String(process.pid), "utf8");
  const deadline = Date.now() + holdMs;
  while (Date.now() < deadline) {
    sleepSync(tickMs);
    if (mode === "hold") {
      const now = new Date();
      utimesSync(lock, now, now);
    }
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
