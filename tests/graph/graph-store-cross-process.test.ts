/**
 * CROSS-PROCESS acceptance evidence for the workspace's ONE GraphStore.
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * WHY THIS FILE EXISTS. P1 acceptance bullet 3 ("two independent connections,
 * two ACTUAL processes: unique keys and conditional updates take effect") and
 * bullet 4 ("a committed receipt replayed returns the identical persisted
 * receipt, with state and counts NOT advanced twice") were proven only by
 * inline probes that were never saved (gap G11, see
 * `docs/graph-v3-execution-plan.md` §8.2), and §5 says a temporary probe
 * cannot be the sole acceptance evidence. These cases are that evidence,
 * tracked in the test suite.
 *
 * WHICH PROCESS DOES WHAT. The test file runs in ONE process (`--isolate`),
 * and it holds its OWN connection to the store file (`makeFixture`). Every
 * worker is a REAL second/third/fourth OS process — `Bun.spawn(process.execPath,
 * <this directory>/helpers/graph-store-xproc-worker.ts, ...)` — and each
 * opens its own SQLite connection to the SAME file:
 *
 *   - "a create-right race across three real processes...": the PARENT opens the
 *     store, then spawns THREE workers. Each worker claims every contested
 *     effect key once. The parent's connection reads the result afterwards.
 *   - "a stale claim is taken over...": the parent seeds the stale claim, three
 *     worker processes race the takeover, the parent verifies.
 *   - "created is reachable only through a non-empty execution id...": ONE
 *     worker performs the transitions; the parent's own connection verifies
 *     the rows and the DDL CHECK.
 *   - "PINNED TODAY (G1/P2)...": the parent claims and marks creating; a
 *     WORKER that never claimed the effect binds the execution id.
 *   - "a committed receipt...": worker A commits, worker B replays and worker C
 *     conflicts, each in its own process; the parent reads the durable rows.
 *
 * Two `GraphStore` objects inside ONE process would share that process's
 * connection (`graph-store.ts`: ONE CONNECTION PER FILE PER PROCESS), which
 * is exactly the single-process evidence the plan refuses to count. Every
 * worker report therefore carries its own `pid`, and the race case asserts
 * the pids are distinct and different from the test process's.
 *
 * DETERMINISM. The parent passes the SAME fixed `now` (epoch ms) to every
 * worker, so the lease arithmetic is identical in all of them and the store's
 * primary key / conditional `UPDATE ... WHERE` decide the winner — never a
 * wall-clock sleep. The race uses a REAL barrier: a worker writes
 * `ready-<id>-<round>.marker` and waits for `go-<round>.marker`, and the
 * parent writes each round's `go` only after EVERY worker signalled ready
 * for that round. The parent enforces a deadline on every child and kills a
 * worker that overruns, so a hang fails with a readable message instead of
 * hanging the suite. Each case uses its own `mkdtempSync` directory, and
 * `afterEach` closes the parent's store, kills any surviving child and
 * removes the directory, so no test leaves a stray file.
 *
 * G1 IS PINNED, NOT PRETENDED. §8.2 records that `confirmExecution`
 * conditions on `state = 'creating'` and does NOT check the owner, so a
 * non-claimant can bind an execution id; P2 owns the fix. The G1 case asserts
 * that behaviour EXACTLY as it is today, with the P2 note in place, so the fix
 * makes the case fail loudly instead of arriving unnoticed.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { GraphStore, GRAPH_STORE_TABLES } from "../../src/graph/store/index.ts";
import type { ReceiptRecord } from "../../src/graph/ledger/types.ts";

/** The checked-in worker every case spawns as a REAL separate process. */
const WORKER = fileURLToPath(
  new URL("./helpers/graph-store-xproc-worker.ts", import.meta.url),
);

const GRAPH = "graph.xproc";
/** One fixed epoch-ms instant, passed to EVERY process, so leases are deterministic. */
const NOW = 1_700_000_000_000;
const LEASE_MS = 60_000;
/** The parent's deadline for one child process; a child that overruns is killed. */
const CHILD_DEADLINE_MS = 30_000;
/** The parent's deadline for one barrier round. */
const BARRIER_DEADLINE_MS = 15_000;

// ── Worker protocol ─────────────────────────────────────────────────────────

interface WorkerReport {
  readonly pid: number;
  readonly ok: boolean;
  readonly mode: string;
  readonly error?: string;
}

interface RowView {
  readonly state: string;
  readonly ownerId: string;
  readonly executionId?: string;
  readonly claimedAt: number;
}

interface ClaimReport {
  readonly round: number;
  readonly effectId: string;
  readonly attemptId: string;
  readonly kind: "claimed" | "held";
  readonly state: string;
  readonly ownerId: string;
  readonly marked?: boolean;
  readonly confirmed?: boolean;
  readonly executionId?: string;
}

interface ShapeReport extends WorkerReport {
  readonly claim: string;
  readonly marked: boolean;
  readonly emptyIdError: { readonly name: string; readonly problem?: string };
  readonly afterEmptyId: RowView | null;
  readonly confirmed: boolean;
  readonly afterConfirm: RowView | null;
  readonly markedAgain: boolean;
  readonly released: boolean;
  readonly secondClaim: string;
  readonly secondClaimState?: string;
  readonly afterSecond: RowView | null;
}

interface NonOwnerReport extends WorkerReport {
  readonly owner: string;
  readonly executionId: string;
  readonly confirmed: boolean;
  readonly row: RowView | null;
}

interface ReceiptReport extends WorkerReport {
  readonly verdict: string;
  readonly receipt: ReceiptRecord | null;
  readonly reason: string | null;
}

interface Child {
  readonly id: string;
  readonly pid: number;
  readonly done: Promise<WorkerReport & Record<string, unknown>>;
  readonly kill: () => void;
}

interface XprocFixture {
  readonly dir: string;
  readonly markerDir: string;
  readonly store: GraphStore;
}

// ── Cleanup: every case owns its temp directory and its children ────────────

const children: Child[] = [];
const fixtures: XprocFixture[] = [];

afterEach(() => {
  // A child that is still alive (the case threw before awaiting it) is killed;
  // killing an exited process is a no-op.
  for (const child of children) child.kill();
  children.length = 0;
  for (const fx of fixtures) {
    try {
      fx.store.close();
    } catch {
      // already closed
    }
    try {
      rmSync(fx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch {
      // Under the OS temp dir; a leftover there is not a tracked file.
    }
  }
  fixtures.length = 0;
});

/**
 * A private store root for one case. The PARENT opens (and verifies) the store
 * BEFORE any worker starts: a brand-new root must not be initialized by three
 * processes at once, and the parent's handle is its own independent connection
 * for the final reads.
 */
function makeFixture(prefix: string): XprocFixture {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const markerDir = join(dir, "markers");
  mkdirSync(markerDir, { recursive: true });
  const store = GraphStore.openFile(dir);
  const fx: XprocFixture = { dir, markerDir, store };
  fixtures.push(fx);
  return fx;
}

/** `--key value` pairs, plus the store root every mode needs. */
function workerArgs(fx: XprocFixture, args: Readonly<Record<string, string>>): string[] {
  const out: string[] = ["--root", fx.dir];
  for (const [key, value] of Object.entries(args)) out.push(`--${key}`, value);
  return out;
}

/** Spawn one REAL bun process running the worker fixture. */
function spawnWorker(id: string, args: readonly string[]): Child {
  const proc = Bun.spawn([process.execPath, WORKER, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = Bun.readableStreamToText(proc.stdout);
  const stderr = Bun.readableStreamToText(proc.stderr);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, CHILD_DEADLINE_MS);

  const done = (async (): Promise<WorkerReport & Record<string, unknown>> => {
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
        `cross-process worker ${id} (pid ${proc.pid}) did not exit within ${CHILD_DEADLINE_MS}ms and was killed — stdout: ${out.trim()} stderr: ${err.trim()}`,
      );
    }
    if (line === undefined) {
      throw new Error(
        `cross-process worker ${id} (pid ${proc.pid}) exited ${code} without a JSON result — stdout: ${out.trim()} stderr: ${err.trim()}`,
      );
    }
    let report: WorkerReport & Record<string, unknown>;
    try {
      report = JSON.parse(line) as WorkerReport & Record<string, unknown>;
    } catch {
      throw new Error(
        `cross-process worker ${id} (pid ${proc.pid}) printed an unparseable result line: ${line}`,
      );
    }
    if (code !== 0 || report.ok !== true) {
      throw new Error(
        `cross-process worker ${id} (pid ${proc.pid}) exited ${code} with ${JSON.stringify(report)} — stderr: ${err.trim()}`,
      );
    }
    return report;
  })();
  // A worker the case never awaits (because the barrier threw first) must not
  // surface later as an unhandled rejection.
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

/** Spawn a worker and await its report (the sequential cases). */
async function runWorker<T>(id: string, args: readonly string[]): Promise<T> {
  const report = await spawnWorker(id, args).done;
  return report as unknown as T;
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
        `the cross-process barrier did not complete within ${BARRIER_DEADLINE_MS}ms; still missing: ${missing
          .map((entry) => entry.what)
          .join(", ")}`,
      );
    }
    // Yield between polls; the marker files are the barrier, this loop only
    // notices them and never decides an outcome.
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

interface RaceOptions {
  readonly ids: readonly string[];
  readonly rounds: number;
  readonly leaseMs: number;
  readonly now: number;
  readonly effectPrefix: string;
  readonly confirm: boolean;
}

/**
 * Run one gated multi-round claim race.
 *
 * Each worker writes `ready-<id>-<round>` and waits for `go-<round>`;
 * the parent writes `go-<round>` only after every worker is ready for that
 * round, so all three processes attempt the SAME effect key from the same
 * barrier.
 */
async function raceClaims(
  fx: XprocFixture,
  options: RaceOptions,
): Promise<
  { id: string; report: WorkerReport & Record<string, unknown>; claims: ClaimReport[] }[]
> {
  const workers = options.ids.map((id) =>
    spawnWorker(
      id,
      workerArgs(fx, {
        mode: "claim-race",
        id,
        owner: `owner-${id}`,
        graph: GRAPH,
        "effect-prefix": options.effectPrefix,
        rounds: String(options.rounds),
        "lease-ms": String(options.leaseMs),
        now: String(options.now),
        confirm: options.confirm ? "on" : "off",
        "marker-dir": fx.markerDir,
        "deadline-ms": String(CHILD_DEADLINE_MS),
      }),
    ),
  );

  for (let round = 0; round < options.rounds; round++) {
    await waitForMarkers(
      options.ids.map((id) => ({
        path: join(fx.markerDir, `ready-${id}-${round}.marker`),
        what: `worker ${id}'s ready marker for round ${round}`,
      })),
    );
    writeFileSync(join(fx.markerDir, `go-${round}.marker`), "1");
  }

  const reports = await Promise.all(workers.map((worker) => worker.done));
  return reports.map((report, index) => ({
    id: options.ids[index]!,
    report,
    claims: (report["claims"] ?? []) as ClaimReport[],
  }));
}

/** The effect key round `round` of a claim race uses (mirrors the fixture). */
function raceKey(effectPrefix: string, round: number) {
  return {
    graphId: GRAPH,
    effectId: `${effectPrefix}-${round}`,
    attemptId: `${effectPrefix}-attempt-${round}`,
  };
}

/** How many rows one store table holds, read through the parent's connection. */
function countRows(fx: XprocFixture, table: string): number {
  const row = fx.store.all(`SELECT COUNT(*) AS n FROM ${table}`)[0];
  const count = row?.["n"];
  return typeof count === "number" ? count : -1;
}

// ── Bullet 3: real processes, unique keys and conditional updates ───────────

describe("GraphStore — cross-process create right and conditional updates", () => {
  it("gives ONE process the create right per effect key across three real processes, and loses no row", async () => {
    const fx = makeFixture("graph-xproc-race-");
    const ids = ["p1", "p2", "p3"] as const;
    const rounds = 3;

    const results = await raceClaims(fx, {
      ids,
      rounds,
      leaseMs: LEASE_MS,
      now: NOW,
      effectPrefix: "effect-race",
      confirm: true,
    });

    // REAL OS PROCESSES, not two objects in one process.
    const pids = results.map((entry) => entry.report.pid);
    expect(
      new Set(pids).size,
      `the workers reported pids ${pids.join(", ")} — they must be three distinct processes`,
    ).toBe(ids.length);
    expect(pids).not.toContain(process.pid);

    const winners: string[] = [];
    for (let round = 0; round < rounds; round++) {
      const effect = raceKey("effect-race", round);
      const seen = results.map((entry) => ({ id: entry.id, claim: entry.claims[round]! }));
      for (const entry of seen) {
        // The worker reported the key it actually used: the fixture and this
        // file derive it the same way, and this keeps them from drifting.
        expect(entry.claim.effectId).toBe(effect.effectId);
        expect(entry.claim.attemptId).toBe(effect.attemptId);
      }

      const claimed = seen.filter((entry) => entry.claim.kind === "claimed");
      const held = seen.filter((entry) => entry.claim.kind === "held");
      expect(
        claimed.length,
        `round ${round}: ${claimed.length} processes were granted the create right for ${effect.effectId}`,
      ).toBe(1);
      expect(held.length).toBe(ids.length - 1);

      const winner = claimed[0]!;
      winners.push(winner.id);
      for (const loser of held) {
        // "The others are told the effect is held": the store's claim answer is
        // claimed/held (an "unknown" is the HOST-delivery answer for a row left
        // creating, so the observed state is reported too), and every loser
        // names the SAME owner — no split brain, no second claim.
        expect(
          loser.claim.ownerId,
          `round ${round}: ${loser.id} was told the effect is owned by ${loser.claim.ownerId}`,
        ).toBe(`owner-${winner.id}`);
        expect(["pending", "creating", "created"]).toContain(loser.claim.state);
      }

      // The winner recorded the host fact from its own process: creating, then
      // created with its own execution id.
      expect(
        winner.claim.marked,
        `round ${round}: the winner could not mark the effect creating`,
      ).toBe(true);
      expect(winner.claim.confirmed).toBe(true);
      expect(winner.claim.executionId).toBe(`exec-${winner.id}-${round}`);

      // The parent's OWN connection sees exactly one binding row for the key.
      const row = fx.store.readExecution(effect);
      expect(row?.state).toBe("created");
      expect(row?.ownerId).toBe(`owner-${winner.id}`);
      expect(row?.execution?.executionId).toBe(`exec-${winner.id}-${round}`);
    }

    // NO ROW IS LOST: one row per contested key, exactly as many claims granted
    // as there are keys, and every worker reported every round.
    const rows = fx.store.all(
      `SELECT effect_id FROM ${GRAPH_STORE_TABLES.executions} ORDER BY effect_id`,
    );
    expect(rows.length).toBe(rounds);
    expect(new Set(rows.map((row) => row["effect_id"])).size).toBe(rounds);
    expect(winners.length).toBe(rounds);
    for (const entry of results) {
      expect(entry.claims.length, `${entry.id} reported ${entry.claims.length} claims`).toBe(
        rounds,
      );
    }

    console.log(
      `[xproc create-right race] ${ids.length} real processes (pids ${pids.join(", ")}) x ${rounds} effect keys: ` +
        results
          .map(
            (entry) =>
              `pid ${entry.report.pid} won ${entry.claims
                .filter((claim) => claim.kind === "claimed")
                .map((claim) => claim.effectId)
                .join(",") || "-"}`,
          )
          .join("; "),
    );
  });

  it("takes over a STALE claim in exactly one process and tells the others it is held", async () => {
    const fx = makeFixture("graph-xproc-stale-");
    const effect = raceKey("effect-stale", 0);

    // The parent seeds a claim whose lease has already expired. The lease is
    // 30s and the seed is 60s old, so the steal path is reachable in every
    // worker; every worker receives the SAME fixed now, so the arithmetic is
    // identical in all of them.
    const seed = fx.store.claimExecution(effect, "owner-seed", NOW - 60_000, 30_000);
    expect(seed.kind).toBe("claimed");

    const ids = ["s1", "s2", "s3"] as const;
    const results = await raceClaims(fx, {
      ids,
      rounds: 1,
      leaseMs: 30_000,
      now: NOW,
      effectPrefix: "effect-stale",
      confirm: false,
    });
    expect(new Set(results.map((entry) => entry.report.pid)).size).toBe(ids.length);

    const seen = results.map((entry) => ({ id: entry.id, claim: entry.claims[0]! }));
    const claimed = seen.filter((entry) => entry.claim.kind === "claimed");
    expect(
      claimed.length,
      `${claimed.length} processes took over the stale claim: ${claimed
        .map((entry) => entry.id)
        .join(", ")}`,
    ).toBe(1);

    const taker = claimed[0]!;
    for (const loser of seen.filter((entry) => entry.claim.kind === "held")) {
      expect(loser.claim.ownerId).toBe(`owner-${taker.id}`);
    }

    // The conditional update really was conditional: one row, still pending,
    // owned by the one taker, with the claiming instant it wrote.
    const row = fx.store.readExecution(effect);
    expect(row?.state).toBe("pending");
    expect(row?.ownerId).toBe(`owner-${taker.id}`);
    expect(row?.claimedAt).toBe(NOW);
    expect(countRows(fx, GRAPH_STORE_TABLES.executions)).toBe(1);
  });

  it("reaches 'created' only through a non-empty execution id, and refuses what a created row must refuse", async () => {
    const fx = makeFixture("graph-xproc-shape-");
    const effect = raceKey("effect-shape", 0);

    const report = await runWorker<ShapeReport>(
      "shape",
      workerArgs(fx, {
        mode: "confirm-shape",
        graph: GRAPH,
        effect: effect.effectId,
        attempt: effect.attemptId,
        owner: "owner-shape",
        now: String(NOW),
        "lease-ms": String(LEASE_MS),
      }),
    );

    expect(report.claim).toBe("claimed");
    expect(report.marked).toBe(true);

    // THE REFUSED SHAPE: "created" claims a host FACT, so an empty execution id
    // is refused by the store's own record check and the row stays creating.
    expect(report.emptyIdError).toEqual({
      name: "GraphStoreWriteError",
      problem: "invalid-record",
    });
    expect(report.afterEmptyId?.state).toBe("creating");
    expect(report.afterEmptyId?.executionId).toBeUndefined();

    // THE POSITIVE SHAPE: a non-empty id is the only way to created.
    expect(report.confirmed).toBe(true);
    expect(report.afterConfirm?.state).toBe("created");
    expect(report.afterConfirm?.executionId).toBe("exec-shape");

    // CONDITIONAL UPDATES on a created row: not creating again, not released,
    // not claimable by another owner.
    expect(report.markedAgain).toBe(false);
    expect(report.released).toBe(false);
    expect(report.secondClaim).toBe("held");
    expect(report.secondClaimState).toBe("created");
    expect(report.afterSecond?.ownerId).toBe("owner-shape");
    expect(report.afterSecond?.executionId).toBe("exec-shape");

    // The parent's own connection. Non-EMPTY is the store's record check
    // (asserted above); non-NULL is the DDL CHECK, which even a direct SQL
    // writer cannot bypass from another process.
    expect(fx.store.readExecution(effect)?.state).toBe("created");
    expect(fx.store.readExecution(effect)?.execution?.executionId).toBe("exec-shape");
    expect(() =>
      fx.store.run(
        `UPDATE ${GRAPH_STORE_TABLES.executions} SET state = 'created', execution_id = NULL WHERE graph_id = ? AND effect_id = ?`,
        GRAPH,
        effect.effectId,
      ),
    ).toThrow();
    expect(fx.store.readExecution(effect)?.state).toBe("created");
    expect(countRows(fx, GRAPH_STORE_TABLES.executions)).toBe(1);
  });

  it("PINNED TODAY (G1/P2): a process that never claimed the effect can still bind its execution id", async () => {
    const fx = makeFixture("graph-xproc-g1-");
    const effect = raceKey("effect-g1", 0);

    // The parent is the claimant: it takes the create right and marks the
    // effect creating, then leaves the window open.
    expect(fx.store.claimExecution(effect, "owner-A", NOW, LEASE_MS).kind).toBe("claimed");
    expect(fx.store.markExecutionCreating(effect, "owner-A", NOW)).toBe(true);

    // A DIFFERENT real process — owner-B, which never claimed this effect —
    // confirms the host execution.
    const report = await runWorker<NonOwnerReport>(
      "non-owner",
      workerArgs(fx, {
        mode: "confirm-non-owner",
        graph: GRAPH,
        effect: effect.effectId,
        attempt: effect.attemptId,
        owner: "owner-B",
        "execution-id": "exec-B",
        now: String(NOW),
      }),
    );
    expect(report.pid).not.toBe(process.pid);

    // TODAY'S HONEST BEHAVIOUR, PINNED. §8.2 G1: confirmExecution conditions
    // on state='creating' and NOT on the owner, so a non-claimant binds
    // exec-B to owner-A's row. P2 owns the owner-fencing fix; when it lands,
    // confirmed must become false (or the signature must demand the owner)
    // and THIS CASE MUST FAIL LOUDLY rather than be relaxed.
    expect(
      report.confirmed,
      "G1 pin: today a non-claimant CAN bind the execution id; if this is false, P2's fencing landed and the assertion (not the behaviour) is what changed",
    ).toBe(true);
    expect(report.row?.state).toBe("created");
    // The claimant is unchanged; only the host fact was written by someone else.
    expect(report.row?.ownerId).toBe("owner-A");
    expect(report.row?.executionId).toBe("exec-B");
    expect(fx.store.readExecution(effect)?.ownerId).toBe("owner-A");
    expect(fx.store.readExecution(effect)?.execution?.executionId).toBe("exec-B");
    expect(countRows(fx, GRAPH_STORE_TABLES.executions)).toBe(1);
  });
});

// ── Bullet 4: a receipt committed by one process, replayed by another ──────

describe("GraphStore — cross-process receipt replay", () => {
  it("replays a committed receipt identically from another process without advancing state or counts, and refuses a different digest", async () => {
    const fx = makeFixture("graph-xproc-receipt-");
    const attemptId = "attempt-receipt";
    const submissionId = "submission-receipt";
    const effectId = "submission-receipt-effect";
    const key = { graphId: GRAPH, attemptId, submissionId };

    const receiptArgs = (digest: string, tag: string, at: number): string[] =>
      workerArgs(fx, {
        mode: "receipt",
        graph: GRAPH,
        attempt: attemptId,
        submission: submissionId,
        effect: effectId,
        "plan-revision": "rev-1",
        outcome: "done",
        digest,
        tag,
        now: String(at),
        "accepted-at": String(at),
        "effect-at": String(at),
        "result-at": String(at),
      });

    // PROCESS A commits the receipt, the accepted event, the pending effect,
    // the accepted result and the run state in ONE transaction.
    const first = await runWorker<ReceiptReport>("commit", receiptArgs("digest-a", "first", NOW));
    expect(first.verdict).toBe("committed");
    expect(first.receipt).not.toBeNull();
    const persisted = first.receipt!;
    expect(persisted.committedAt).toBe(NOW);
    const firstPid = first.pid;

    // PROCESS B — a REAL SECOND PROCESS over the SAME file — replays the same
    // submission key and digest, carrying LATER timestamps and a different
    // payload. It must get the PERSISTED receipt back and write nothing.
    const replay = await runWorker<ReceiptReport>(
      "replay",
      receiptArgs("digest-a", "second", NOW + 5_000),
    );
    expect(replay.pid).not.toBe(firstPid);
    expect(replay.pid).not.toBe(process.pid);
    expect(
      replay.verdict,
      "the replay carried later timestamps; a store that wrote them would answer committed",
    ).toBe("replayed");
    expect(replay.receipt).toEqual(persisted);

    // PROCESS C conflicts: the same submission key with a DIFFERENT digest is
    // refused, and nothing is written.
    const conflict = await runWorker<ReceiptReport>(
      "conflict",
      receiptArgs("digest-b", "third", NOW + 9_000),
    );
    expect(conflict.pid).not.toBe(replay.pid);
    expect(conflict.verdict).toBe("conflict");
    expect(conflict.reason).toContain("digest-a");
    expect(conflict.reason).toContain("digest-b");

    // The parent's OWN connection: the committed facts are A's, once each.
    expect(fx.store.lookupReceipt(key)).toEqual(persisted);
    expect(countRows(fx, GRAPH_STORE_TABLES.receipts)).toBe(1);
    expect(countRows(fx, GRAPH_STORE_TABLES.acceptedEvents)).toBe(1);
    expect(countRows(fx, GRAPH_STORE_TABLES.acceptedResults)).toBe(1);
    expect(countRows(fx, GRAPH_STORE_TABLES.pendingEffects)).toBe(1);
    expect(countRows(fx, GRAPH_STORE_TABLES.graphState)).toBe(1);

    // STATE AND COUNTS DID NOT ADVANCE TWICE: every durable instant is still
    // A's, and every payload is still A's — B's and C's later timestamps and
    // different payloads left no trace.
    expect(fx.store.acceptedEvents(GRAPH)[0]?.acceptedAt).toBe(NOW);
    expect(fx.store.acceptedEvents(GRAPH)[0]?.submissionId).toBe(submissionId);
    expect(fx.store.pendingEffects(GRAPH)[0]?.createdAt).toBe(NOW);
    expect(fx.store.pendingEffects(GRAPH)[0]?.payload).toEqual({ tag: "first" });
    expect(fx.store.readAcceptedResult(GRAPH, attemptId)?.acceptedAt).toBe(NOW);
    expect(fx.store.readAcceptedResult(GRAPH, attemptId)?.payload).toEqual({ tag: "first" });
    expect(fx.store.readGraphState(GRAPH)?.updatedAt).toBe(NOW);
    expect(fx.store.readGraphState(GRAPH)?.body).toEqual({ tag: "first" });
  });
});

