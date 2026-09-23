/**
 * Cross-process worker fixture for the GraphStore acceptance evidence.
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * WHY THIS FILE EXISTS. P1 acceptance bullet 3 (`two independent connections,
 * two ACTUAL processes: unique keys and conditional updates take effect`) and
 * bullet 4 (`a committed receipt replays identically`) were proven only by
 * inline probes that were never saved (gap G11, `docs/graph-v3-execution-plan.md`
 * §8.2), and §5 forbids a probe as the sole acceptance evidence. The parent
 * test `tests/graph/graph-store-cross-process.test.ts` spawns THIS file as a
 * REAL separate OS process — one `bun` process per worker — so every worker
 * opens its OWN SQLite connection to the SAME store file. Two `GraphStore`
 * objects inside one process would share the process's connection
 * (`graph-store.ts`, ONE CONNECTION PER FILE PER PROCESS), which is exactly
 * the single-process evidence the plan refuses to count.
 *
 *     bun tests/graph/helpers/graph-store-xproc-worker.ts --mode <mode> ...
 *
 * Every mode opens `GraphStore.openFile(root)`, does its work, and prints
 * exactly ONE JSON line on stdout — `{"pid":<n>,"ok":true,...}` on success,
 * `{"pid":<n>,"ok":false,...}` plus a non-zero exit on failure. The parent
 * enforces its own deadline and kills a worker that overruns, so a hung child
 * fails the test with a readable message instead of hanging the suite.
 *
 * COORDINATION IS MARKER FILES ONLY (`--mode claim-race`). A worker writes
 * `ready-<id>-<round>.marker` and then busy-waits (bounded by
 * `--deadline-ms`) for `go-<round>.marker`; the parent writes `go-<round>`
 * only after EVERY worker signalled ready for that round, so all racing claims
 * for one effect key start from the same barrier. The parent passes the SAME
 * fixed `--now` to every worker, so the lease arithmetic is identical in all
 * of them: the store's primary key and its conditional `UPDATE ... WHERE`
 * decide the winner, never a wall-clock sleep.
 *
 * MODES
 *
 *   --mode claim-race
 *     --id <workerId> --owner <ownerId> --graph <graphId>
 *     --effect-prefix <p> --rounds <n> --lease-ms <n> --now <epochMs>
 *     --marker-dir <dir> [--confirm on|off] [--deadline-ms <n>]
 *     For each round, waits for the round barrier, then calls
 *     `claimExecution` on `<p>-<round>` / `<p>-attempt-<round>` with this
 *     worker's own owner id. A winner with `--confirm on` then records the
 *     host fact from a REAL second connection: `markExecutionCreating` and
 *     `confirmExecution({executionId: "exec-<id>-<round>"})`. Reports every
 *     claim (kind, the owner the store reported, the observed state).
 *
 *   --mode confirm-shape
 *     --graph --effect --attempt --owner --now --lease-ms
 *     Claim, mark creating, then prove the SHAPE of the transition: an empty
 *     execution id is refused with `GraphStoreWriteError`/`invalid-record`
 *     and leaves the row `creating`; a non-empty id moves it to `created`;
 *     and a `created` row refuses `markExecutionCreating`, `releaseExecution`
 *     and a second `claimExecution`.
 *
 *   --mode confirm-non-owner
 *     --graph --effect --attempt --owner --execution-id --now
 *     The G1 pin: a process that does NOT hold the claim calls
 *     `confirmExecution` on a row another owner left `creating`. Today the
 *     store's conditional update is on `state = 'creating'` only, so this
 *     SUCCEEDS; P2 owns the owner-fencing fix and this report is what makes
 *     that fix visible.
 *
 *   --mode receipt
 *     --graph --attempt --submission --effect --plan-revision --outcome
 *     --digest --tag --now --accepted-at --effect-at --result-at
 *     Commits ONE acceptance batch (receipt + accepted event + pending effect
 *     + accepted result) and, only when the verdict is `committed`, writes the
 *     run state in the SAME transaction. Prints the verdict and the persisted
 *     receipt, so the parent can compare a replay/conflict from another
 *     process against what this one committed.
 *
 * PRIVACY: this fixture receives only store roots under the OS temp directory,
 * graph/effect/attempt ids minted by the test, and epoch milliseconds. It never
 * reads or prints a credential value, a real home-directory path or a session
 * transcript — the store's credential table is not touched here at all.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  GraphStore,
  GraphStoreWriteError,
  type ExecutionBindingRecord,
  type GraphAcceptanceBatch,
  type StoreEffectKey,
} from "../../../src/graph/store/index.ts";

// ── Argument access ─────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

/** The value of `--name`, or `undefined`. */
function arg(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** The value of `--name`, refused when absent or empty. */
function required(name: string): string {
  const value = arg(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`graph-store-xproc-worker: --${name} is required`);
  }
  return value;
}

/** The value of `--name` as a safe integer, refused otherwise. */
function numberArg(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `graph-store-xproc-worker: --${name} must be a safe integer, got ${JSON.stringify(arg(name))}`,
    );
  }
  return value;
}

// ── Output ──────────────────────────────────────────────────────────────────

/**
 * Print the one JSON result line. `pid` is always included: it is the parent's
 * evidence that a report came from a REAL separate OS process and not from a
 * second object in its own process.
 */
function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ pid: process.pid, ...payload })}\n`);
}

/** One effect's binding row, as a JSON-safe view (never the record itself). */
function rowView(row: ExecutionBindingRecord | undefined): Record<string, unknown> | null {
  if (row === undefined) return null;
  return {
    state: row.state,
    ownerId: row.ownerId,
    executionId: row.execution?.executionId,
    claimedAt: row.claimedAt,
  };
}

// ── The marker barrier ──────────────────────────────────────────────────────

/**
 * Busy-wait for a marker file to APPEAR, bounded by a deadline.
 *
 * The marker's existence is the signal; its contents are never read, so a
 * half-written file is not a hazard. The deadline turns a parent that never
 * released the barrier into a readable non-zero exit instead of a hung worker.
 */
async function waitForMarker(path: string, deadlineMs: number, what: string): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(
        `graph-store-xproc-worker: timed out after ${deadlineMs}ms waiting for ${what}`,
      );
    }
    // Yield to the event loop between polls; this is a poll interval, not a
    // timer that decides the outcome.
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

// ── Modes ───────────────────────────────────────────────────────────────────

/** The key one round of the claim race uses, derived the same way by the parent. */
function raceKey(graphId: string, effectPrefix: string, round: number): StoreEffectKey {
  return {
    graphId,
    effectId: `${effectPrefix}-${round}`,
    attemptId: `${effectPrefix}-attempt-${round}`,
  };
}

/**
 * Race this process against its siblings for one create right per round.
 *
 * The barrier is per round: `ready-<id>-<round>` is written BEFORE the wait,
 * and the parent writes `go-<round>` only after every sibling's ready marker
 * exists, so each round's claims all begin from the same instant.
 */
async function claimRace(store: GraphStore): Promise<void> {
  const id = required("id");
  const owner = required("owner");
  const graphId = required("graph");
  const effectPrefix = required("effect-prefix");
  const markerDir = required("marker-dir");
  const rounds = numberArg("rounds");
  const leaseMs = numberArg("lease-ms");
  const now = numberArg("now");
  const confirm = arg("confirm") !== "off";
  const deadlineMs = Number(arg("deadline-ms") ?? "30000");

  const claims: Array<Record<string, unknown>> = [];
  for (let round = 0; round < rounds; round++) {
    const effect = raceKey(graphId, effectPrefix, round);
    writeFileSync(join(markerDir, `ready-${id}-${round}.marker`), "1");
    await waitForMarker(
      join(markerDir, `go-${round}.marker`),
      deadlineMs,
      `go-${round}.marker`,
    );

    const claim = store.claimExecution(effect, owner, now, leaseMs);
    if (claim.kind === "held") {
      // The store's own refusal vocabulary: the create right is HELD by the
      // row's owner. "unknown" is not a claim answer — it is the host-delivery
      // answer for a row left `creating`, which is why the observed state is
      // reported here as well.
      claims.push({
        round,
        effectId: effect.effectId,
        attemptId: effect.attemptId,
        kind: "held",
        state: claim.row.state,
        ownerId: claim.row.ownerId,
        executionId: claim.row.execution?.executionId,
      });
      continue;
    }

    let marked: boolean | undefined;
    let confirmed: boolean | undefined;
    let executionId: string | undefined;
    if (confirm) {
      executionId = `exec-${id}-${round}`;
      // Two conditional updates, each its own transaction, from a real second
      // connection: "creating" is only reachable from this owner's pending
      // row, and "created" only from a row that is creating.
      marked = store.markExecutionCreating(effect, owner, now);
      confirmed = store.confirmExecution(effect, { executionId }, now);
    }
    claims.push({
      round,
      effectId: effect.effectId,
      attemptId: effect.attemptId,
      kind: "claimed",
      state: "pending",
      ownerId: owner,
      marked,
      confirmed,
      executionId,
    });
  }

  emit({ ok: true, mode: "claim-race", id, owner, claims });
}

/**
 * Prove the shape of the `created` transition from a real second process.
 *
 * "created" is the one state a lookup reports as a host FACT, so the store
 * refuses to write it without a non-empty execution id and the DDL CHECK makes
 * it unrepresentable without a non-NULL one. The transitions that follow are
 * conditional: a `created` row is not creating again, not released, and not
 * claimable.
 */
function confirmShape(store: GraphStore): void {
  const effect: StoreEffectKey = {
    graphId: required("graph"),
    effectId: required("effect"),
    attemptId: required("attempt"),
  };
  const owner = required("owner");
  const now = numberArg("now");
  const leaseMs = numberArg("lease-ms");

  const claim = store.claimExecution(effect, owner, now, leaseMs);
  const marked = store.markExecutionCreating(effect, owner, now);

  let emptyIdError: { name: string; problem?: string };
  try {
    store.confirmExecution(effect, { executionId: "" }, now);
    emptyIdError = { name: "none" };
  } catch (error) {
    emptyIdError =
      error instanceof GraphStoreWriteError
        ? { name: error.name, problem: error.problem }
        : { name: error instanceof Error ? error.name : typeof error };
  }
  const afterEmptyId = store.readExecution(effect);

  const confirmed = store.confirmExecution(effect, { executionId: "exec-shape" }, now);
  const afterConfirm = store.readExecution(effect);

  // The refused transitions: a `created` row is not `pending` again.
  const markedAgain = store.markExecutionCreating(effect, owner, now);
  const released = store.releaseExecution(effect, owner);
  const secondClaim = store.claimExecution(effect, "owner-other", now, leaseMs);
  const afterSecond = store.readExecution(effect);

  emit({
    ok: true,
    mode: "confirm-shape",
    claim: claim.kind,
    marked,
    emptyIdError,
    afterEmptyId: rowView(afterEmptyId),
    confirmed,
    afterConfirm: rowView(afterConfirm),
    markedAgain,
    released,
    secondClaim: secondClaim.kind,
    secondClaimState: secondClaim.kind === "held" ? secondClaim.row.state : undefined,
    afterSecond: rowView(afterSecond),
  });
}

/**
 * The G1 pin: a NON-claimant binds the execution id (today's honest behaviour).
 *
 * `confirmExecution`'s conditional update names `state = 'creating'` and NOT
 * the owner, so a process that never claimed this effect can still make the
 * host fact real. P2 owns the fencing fix; the parent asserts the current
 * outcome so the fix fails loudly instead of arriving unnoticed.
 */
function confirmNonOwner(store: GraphStore): void {
  const effect: StoreEffectKey = {
    graphId: required("graph"),
    effectId: required("effect"),
    attemptId: required("attempt"),
  };
  const now = numberArg("now");
  const executionId = required("execution-id");
  const confirmed = store.confirmExecution(effect, { executionId }, now);
  emit({
    ok: true,
    mode: "confirm-non-owner",
    owner: required("owner"),
    executionId,
    confirmed,
    row: rowView(store.readExecution(effect)),
  });
}

/**
 * Commit ONE acceptance batch and, only when it is actually committed, the run
 * state — the state belongs to the SAME transaction boundary as the receipt.
 *
 * A replayed or conflicting batch writes NOTHING, so the state this process
 * would have written must not appear: the parent's count and timestamp
 * assertions are what prove "not advanced twice".
 */
function receipt(store: GraphStore): void {
  const graphId = required("graph");
  const attemptId = required("attempt");
  const submissionId = required("submission");
  const planRevision = required("plan-revision");
  const outcomeId = required("outcome");
  const digest = required("digest");
  const tag = required("tag");
  const effectId = required("effect");
  const now = numberArg("now");
  const acceptedAt = numberArg("accepted-at");
  const effectAt = numberArg("effect-at");
  const resultAt = numberArg("result-at");

  const batch: GraphAcceptanceBatch = {
    receipt: {
      graphId,
      attemptId,
      submissionId,
      planRevision,
      proposalDigest: digest,
      decision: "accepted",
      committedAt: now,
    },
    acceptedEvent: {
      graphId,
      attemptId,
      submissionId,
      planRevision,
      outcomeId,
      acceptedAt,
    },
    effects: [
      {
        graphId,
        effectId,
        attemptId,
        kind: "dispatch",
        payload: { tag },
        createdAt: effectAt,
        status: "pending",
      },
    ],
    acceptedResult: {
      graphId,
      attemptId,
      planRevision,
      payload: { tag },
      acceptedAt: resultAt,
    },
  };

  const verdict = store.transaction((tx) => {
    const committed = tx.commitAccepted(batch);
    if (committed.kind === "committed") {
      tx.writeGraphState({ graphId, planRevision, body: { tag }, updatedAt: now });
    }
    return committed;
  });

  emit({
    ok: true,
    mode: "receipt",
    verdict: verdict.kind,
    receipt:
      verdict.kind === "committed" || verdict.kind === "replayed" ? verdict.receipt : null,
    reason: verdict.kind === "conflict" || verdict.kind === "settled" ? verdict.reason : null,
  });
}

// ── Entry ───────────────────────────────────────────────────────────────────

const MODES = ["claim-race", "confirm-shape", "confirm-non-owner", "receipt"] as const;
type Mode = (typeof MODES)[number];

function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value);
}

async function main(): Promise<void> {
  const root = required("root");
  const mode = required("mode");
  if (!isMode(mode)) {
    throw new Error(
      `graph-store-xproc-worker: unknown --mode ${JSON.stringify(mode)}; expected one of ${MODES.join(", ")}`,
    );
  }

  // THIS process's own connection to the workspace's ONE store file.
  const store = GraphStore.openFile(root);
  try {
    switch (mode) {
      case "claim-race":
        await claimRace(store);
        return;
      case "confirm-shape":
        confirmShape(store);
        return;
      case "confirm-non-owner":
        confirmNonOwner(store);
        return;
      case "receipt":
        receipt(store);
        return;
    }
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  emit({
    ok: false,
    mode: arg("mode") ?? null,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
  process.exit(1);
});
