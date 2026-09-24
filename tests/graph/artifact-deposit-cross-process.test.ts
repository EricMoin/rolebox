/// <reference types="bun-types" />

/**
 * The content store publishes once — across REAL OS processes (D4).
 *
 * WHY THIS FILE EXISTS. "Depositing the same bytes twice reuses one object" is a
 * same-process observation, and the rule it must hold under is concurrency: two
 * acceptances in two processes may deposit the same bytes at the same moment.
 * The deposit publishes with an exists-refusing link, so at most one process
 * creates the object and every other process must VERIFY and REUSE it rather
 * than overwrite it.
 *
 * The workers here are REAL `bun` processes (`Bun.spawn(process.execPath, ...)`),
 * four of them, released together by a marker-file barrier — each writes
 * `ready-<id>.marker` and the parent writes `go.marker` only after every one is
 * ready — so the deposits start from one controllable point instead of from
 * timing. Each worker deposits the same bytes several times, so the first round
 * is contended and the rest exercise verified reuse; every round must succeed,
 * the object must read back as the exact bytes, and the pids must be real and
 * distinct.
 *
 * Every case runs in its own `mkdtemp` directory and removes it afterwards;
 * the parent kills any surviving child so no test leaves a stray process or a
 * stray file.
 *
 * @module
 */

import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  artifactIdOf,
  digestOf,
  readArtifactById,
} from "../../src/graph/store/artifacts.ts";

/** The checked-in worker every case spawns as a REAL separate process. */
const WORKER = fileURLToPath(
  new URL("./helpers/artifact-deposit-xproc-worker.ts", import.meta.url),
);

/** The parent's deadline for one child process; a child that overruns is killed. */
const CHILD_DEADLINE_MS = 20_000;
/** The parent's deadline for the barrier. */
const BARRIER_DEADLINE_MS = 15_000;
/** How many deposits each contending process performs after the barrier. */
const ROUNDS = 8;

/**
 * THE HARNESS BUDGET MUST EXCEED THIS FILE'S OWN DEADLINES, so a slow child is
 * reported as the store's behaviour rather than as a killed case with no
 * diagnosis.
 */
setDefaultTimeout(CHILD_DEADLINE_MS + 15_000);

interface DepositReport {
  readonly pid: number;
  readonly ok: boolean;
  readonly kind?: string;
  readonly rounds?: number;
  readonly artifactId?: string;
  readonly digest?: string;
  readonly size?: number;
  readonly reason?: string;
  readonly error?: string;
}

interface Child {
  readonly id: string;
  readonly pid: number;
  readonly done: Promise<DepositReport>;
  readonly kill: () => void;
}

const children: Child[] = [];

afterEach(() => {
  for (const child of children) child.kill();
  children.length = 0;
});

/** Spawn one REAL bun process running the deposit worker. */
function spawnWorker(
  id: string,
  args: Readonly<Record<string, string>>,
): Child {
  const argv = [process.execPath, WORKER, "--id", id];
  for (const [name, value] of Object.entries(args)) argv.push("--" + name, value);
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const stdout = Bun.readableStreamToText(proc.stdout);
  const stderr = Bun.readableStreamToText(proc.stderr);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, CHILD_DEADLINE_MS);

  const done = (async (): Promise<DepositReport> => {
    const code = await proc.exited;
    clearTimeout(timer);
    const [out, err] = await Promise.all([stdout, stderr]);
    const line = out
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith("{"))
      .pop();
    if (timedOut) {
      throw new Error(
        "deposit worker " + id + " (pid " + String(proc.pid) + ") did not exit within " +
          String(CHILD_DEADLINE_MS) + "ms and was killed — stdout: " + out.trim() +
          " stderr: " + err.trim(),
      );
    }
    if (line === undefined) {
      throw new Error(
        "deposit worker " + id + " (pid " + String(proc.pid) + ") exited " + String(code) +
          " without a JSON result — stdout: " + out.trim() + " stderr: " + err.trim(),
      );
    }
    const report = JSON.parse(line) as DepositReport;
    if (code !== 0 || report.ok !== true) {
      throw new Error(
        "deposit worker " + id + " (pid " + String(proc.pid) + ") exited " + String(code) +
          " with " + JSON.stringify(report) + " — stderr: " + err.trim(),
      );
    }
    return report;
  })();
  void done.catch(() => undefined);

  const child: Child = {
    id,
    pid: proc.pid,
    done,
    kill: () => {
      try {
        proc.kill(9);
      } catch {
        // already exited
      }
    },
  };
  children.push(child);
  return child;
}

/** Wait until every named marker file exists, or fail with what is missing. */
async function waitForMarkers(
  entries: readonly { readonly path: string; readonly what: string }[],
): Promise<void> {
  const deadline = Date.now() + BARRIER_DEADLINE_MS;
  for (;;) {
    const missing = entries.filter((entry) => !existsSync(entry.path));
    if (missing.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        "the deposit barrier did not complete within " + String(BARRIER_DEADLINE_MS) +
          "ms; still missing: " + missing.map((entry) => entry.what).join(", "),
      );
    }
    // Yield between polls; the marker files are the barrier, this loop only
    // notices them and never decides an outcome.
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

describe("the content store publishes once across REAL processes", () => {
  it("four processes depositing the same bytes leave one intact object and report no failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-deposit-xproc-"));
    const markerDir = join(dir, "markers");
    const storeRoot = join(dir, "store");
    mkdirSync(markerDir, { recursive: true });
    const shared = Buffer.from("the same bytes deposited by every process", "utf-8");
    const bytesPath = join(dir, "shared-bytes.bin");
    writeFileSync(bytesPath, shared);

    const ids = ["p1", "p2", "p3", "p4"];
    try {
      const started = ids.map((id) =>
        spawnWorker(id, {
          root: storeRoot,
          bytes: bytesPath,
          "marker-dir": markerDir,
          rounds: String(ROUNDS),
          "deadline-ms": String(CHILD_DEADLINE_MS),
        }),
      );
      await waitForMarkers(
        ids.map((id) => ({
          path: join(markerDir, "ready-" + id + ".marker"),
          what: "worker " + id + "'s ready marker",
        })),
      );
      // THE BARRIER: every worker is parked on `go.marker`, so the deposits
      // below are concurrent by construction, not by hope.
      writeFileSync(join(markerDir, "go.marker"), String(Date.now()));

      const reports = await Promise.all(started.map((child) => child.done));
      const expected = artifactIdOf(digestOf(shared));
      for (const report of reports) {
        expect(report.kind).toBe("deposited");
        expect(report.rounds).toBe(ROUNDS);
        expect(report.artifactId).toBe(expected);
        expect(report.digest).toBe(digestOf(shared));
        expect(report.size).toBe(shared.length);
      }
      // REAL, DISTINCT processes: the same process cannot be four workers.
      const pids = reports.map((report) => report.pid);
      expect(new Set(pids).size).toBe(ids.length);
      expect(pids).not.toContain(process.pid);

      // ONE object, and it is exactly the bytes every process deposited.
      const read = readArtifactById(storeRoot, expected);
      expect(read.kind).toBe("read");
      if (read.kind !== "read") return;
      expect(Buffer.compare(read.bytes, shared)).toBe(0);
      expect(read.digest).toBe(digestOf(shared));
    } finally {
      for (const child of children) child.kill();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});
