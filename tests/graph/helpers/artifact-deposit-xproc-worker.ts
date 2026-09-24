/**
 * Cross-process worker for the artifact store's publish-once rule (D4).
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * WHY THIS FILE EXISTS. "A second deposit of the same bytes is the same object"
 * is not proven by two calls in one process: the deposit publishes with an
 * exists-refusing link, and the property that matters is that SEVERAL REAL OS
 * PROCESSES racing that link leave one intact object and no failure. The parent
 * test (`tests/graph/artifact-deposit-cross-process.test.ts`) spawns this file
 * as a real `bun` process per worker, so every worker publishes into the SAME
 * store directory with its own process identity.
 *
 *     bun tests/graph/helpers/artifact-deposit-xproc-worker.ts \
 *       --root <storeRoot> --bytes <bytesFile> --marker-dir <dir> \
 *       --id <workerId> --rounds <n> --deadline-ms <n>
 *
 * COORDINATION IS MARKER FILES ONLY. The worker writes `ready-<id>.marker` and
 * then waits for `go.marker`; the parent writes `go` only after EVERY worker
 * signalled ready, so the deposits start from one controllable barrier rather
 * than from timing. `--rounds` deposits run back to back after the barrier, so
 * the first is contended and the rest exercise verified reuse.
 *
 * It prints exactly ONE JSON line on stdout — `{"pid":<n>,"ok":true,...}` on
 * success, `{"pid":<n>,"ok":false,...}` plus a non-zero exit when ANY deposit
 * was refused or the barrier was not released in time.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { putArtifact } from "../../../src/graph/store/artifacts.ts";

interface WorkerArgs {
  readonly root: string;
  readonly bytes: string;
  readonly markerDir: string;
  readonly id: string;
  readonly rounds: number;
  readonly deadlineMs: number;
}

/** Read `--name value` pairs, refusing a missing or empty one by name. */
function parseArgs(argv: readonly string[]): WorkerArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || !name.startsWith("--") || value === undefined) {
      fail("malformed worker arguments: " + JSON.stringify(argv));
    }
    values.set(name.slice(2), value);
  }
  const text = (name: string): string => {
    const value = values.get(name);
    if (value === undefined || value.length === 0) {
      fail("the worker needs --" + name);
    }
    return value;
  };
  const rounds = Number(text("rounds"));
  if (!Number.isSafeInteger(rounds) || rounds < 1) {
    fail("--rounds must be a positive integer");
  }
  return {
    root: text("root"),
    bytes: text("bytes"),
    markerDir: text("marker-dir"),
    id: text("id"),
    rounds,
    deadlineMs: Number(text("deadline-ms")),
  };
}

/** Report one failure and exit non-zero; the parent turns this into a test failure. */
function fail(message: string): never {
  console.log(JSON.stringify({ pid: process.pid, ok: false, error: message }));
  process.exit(1);
}

/** A synchronous 1ms pause that does not depend on any timer or event loop. */
function pauseOneMillisecond(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}

const args = parseArgs(process.argv.slice(2));
const goPath = join(args.markerDir, "go.marker");
writeFileSync(join(args.markerDir, "ready-" + args.id + ".marker"), String(process.pid));

const deadline = Date.now() + args.deadlineMs;
while (!existsSync(goPath)) {
  if (Date.now() > deadline) {
    fail("the barrier was not released within " + String(args.deadlineMs) + "ms");
  }
  pauseOneMillisecond();
}

const bytes = readFileSync(args.bytes);
let last: { readonly artifactId: string; readonly digest: string; readonly size: number } | undefined;
for (let round = 0; round < args.rounds; round++) {
  const deposit = putArtifact(args.root, bytes);
  if (deposit.kind !== "deposited") {
    fail("deposit round " + String(round) + " was refused: " + deposit.reason);
  }
  last = { artifactId: deposit.artifactId, digest: deposit.digest, size: deposit.size };
}
if (last === undefined) fail("no deposit round ran");

console.log(
  JSON.stringify({
    pid: process.pid,
    ok: true,
    kind: "deposited",
    rounds: args.rounds,
    artifactId: last.artifactId,
    digest: last.digest,
    size: last.size,
  }),
);
