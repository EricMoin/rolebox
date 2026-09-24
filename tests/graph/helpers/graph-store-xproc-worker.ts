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
 *   --mode confirm-stale
 *     --graph --effect --attempt --owner --generation --execution-id --now
 *     A process presents a claim it believes is current — one it never held
 *     (generation 0), or one the row has moved past. The store's conditional
 *     update names `(owner_id, owner_generation)`, so the confirmation is
 *     REFUSED (`fenced`), the row is untouched, and the attempt is recorded on
 *     it as a `stale-confirmation` refusal. This is the case that replaced the
 *     pre-P2 pin, which asserted a NON-claimant SUCCEEDING at binding the
 *     execution id (G1).
 *
 *   --mode apply-control
 *     --graph --node --attempt --command --reason --at [--run <candidate>]
 *     [--session <id>]
 *     Applies ONE control command to an EXISTING run from this process: adopts
 *     the run identity the store already holds (`mintRun` is idempotent) and
 *     records the decision plus the run's control fact in one transaction.
 *     Used with `Bun.spawnSync` from inside a declared acceptance gate, so the
 *     parent's submission is between its pre-transaction control check and its
 *     acceptance transaction when the command commits.
 *
 *   --mode hold-write-lock
 *     --graph --now --lease-ms --marker-dir --hold-ms
 *     Holds the store's WRITE LOCK for `--hold-ms` inside ONE transaction, and
 *     says so from inside it (`lock-held.marker`). A transaction that reads
 *     first and writes afterwards must PROMOTE its shared lock, and SQLite
 *     refuses that promotion immediately while another connection holds the
 *     write lock; the parent uses this mode to prove that a confirmation
 *     arriving in that window WAITS instead of failing.
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

import { hostExecutionNotCreated } from "../../../src/graph/host/execution-index.ts";
import {
  CONTROL_COMMAND_NAMES,
  type ControlCommandName,
} from "../../../src/graph/ledger/types.ts";
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

/**
 * The value of `--name` as one of the durable control commands, refused
 * otherwise: the fixture never invents a command the store's CHECK would reject.
 */
function controlCommandArg(name: string): ControlCommandName {
  const value = required(name);
  const found = CONTROL_COMMAND_NAMES.find((command) => command === value);
  if (found === undefined) {
    throw new Error(
      `graph-store-xproc-worker: --${name} must be one of ${CONTROL_COMMAND_NAMES.join(", ")}, got ${JSON.stringify(value)}`,
    );
  }
  return found;
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
    generation: row.generation,
    executionId: row.execution?.executionId,
    taskId: row.execution?.taskId,
    releasedAt: row.releasedAt,
    refused: row.refused,
    claimedAt: row.claimedAt,
    updatedAt: row.updatedAt,
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
        generation: claim.row.generation,
        executionId: claim.row.execution?.executionId,
      });
      continue;
    }

    let marked: boolean | undefined;
    let confirmed: boolean | undefined;
    let confirmedKind: string | undefined;
    let executionId: string | undefined;
    if (confirm) {
      executionId = `exec-${id}-${round}`;
      // Three conditional updates, each naming the generation THIS claim was
      // granted, from a real second connection: "creating" is only reachable
      // from this claim's pending row, and "created" only from a row that is
      // creating AND still this claim's.
      marked = store.markExecutionCreating(effect, owner, claim.generation, now);
      const verdict = store.confirmExecution(
        effect,
        owner,
        claim.generation,
        { executionId },
        now,
      );
      confirmedKind = verdict.kind;
      confirmed = verdict.kind === "confirmed" || verdict.kind === "replayed";
    }
    claims.push({
      round,
      effectId: effect.effectId,
      attemptId: effect.attemptId,
      kind: "claimed",
      state: "pending",
      ownerId: owner,
      generation: claim.generation,
      marked,
      confirmed,
      confirmedKind,
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
  if (claim.kind !== "claimed") throw new Error("fixture: the claim was not granted");
  const marked = store.markExecutionCreating(effect, owner, claim.generation, now);

  let emptyIdError: { name: string; problem?: string };
  try {
    store.confirmExecution(effect, owner, claim.generation, { executionId: "" }, now);
    emptyIdError = { name: "none" };
  } catch (error) {
    emptyIdError =
      error instanceof GraphStoreWriteError
        ? { name: error.name, problem: error.problem }
        : { name: error instanceof Error ? error.name : typeof error };
  }
  const afterEmptyId = store.readExecution(effect);

  const confirmedVerdict = store.confirmExecution(
    effect,
    owner,
    claim.generation,
    { executionId: "exec-shape" },
    now,
  );
  const confirmed = confirmedVerdict.kind;
  const afterConfirm = store.readExecution(effect);

  // The refused transitions: a `created` row is not `pending` again, and a
  // RELEASE demands a proof — a proven-not-created drops the claim, and a
  // proof-less call is refused by the statement itself.
  const markedAgain = store.markExecutionCreating(effect, owner, claim.generation, now);
  const released = store.releaseExecution(
    effect,
    owner,
    claim.generation,
    hostExecutionNotCreated("fixture: the delivery refused before handing anything over"),
    now,
  );
  const afterRelease = store.readExecution(effect);
  const secondClaim = store.claimExecution(effect, "owner-other", now, leaseMs);
  const afterSecond = store.readExecution(effect);
  // AFTER the release the row is free: the other owner takes it over on a new
  // generation, which is what the fenced-takeover assertions read.
  const releasedRowState = afterRelease?.state;
  const releasedRowGeneration = afterRelease?.generation;

  emit({
    ok: true,
    mode: "confirm-shape",
    claim: claim.kind,
    generation: claim.generation,
    marked,
    emptyIdError,
    afterEmptyId: rowView(afterEmptyId),
    confirmed,
    afterConfirm: rowView(afterConfirm),
    markedAgain,
    released,
    releasedRowState,
    releasedRowGeneration,
    afterRelease: rowView(afterRelease),
    secondClaim: secondClaim.kind,
    secondClaimOwner: secondClaim.kind === "claimed" ? secondClaim.ownerId : undefined,
    secondClaimGeneration: secondClaim.kind === "claimed" ? secondClaim.generation : undefined,
    secondClaimState: secondClaim.kind === "held" ? secondClaim.row.state : undefined,
    afterSecond: rowView(afterSecond),
  });
}

/**
 * The FENCING probe (P2 item 3): present a claim the row may no longer carry and
 * try to bind an execution id. The store must refuse by name, write nothing to
 * the claim, and RECORD the stale attempt on the row.
 *
 * This is the case the G1 pin used to assert as "a non-claimant CAN bind the
 * execution id": the same real second process, the same call, now presenting a
 * claim — its own (owner, generation) or the no-claim generation 0 when it never
 * claimed the effect at all.
 */
function confirmStale(store: GraphStore): void {
  const effect: StoreEffectKey = {
    graphId: required("graph"),
    effectId: required("effect"),
    attemptId: required("attempt"),
  };
  const now = numberArg("now");
  const executionId = required("execution-id");
  const owner = required("owner");
  const generation = numberArg("generation");
  const verdict = store.confirmExecution(effect, owner, generation, { executionId }, now);
  emit({
    ok: true,
    mode: "confirm-stale",
    owner,
    generation,
    executionId,
    verdict: verdict.kind,
    verdictDetail: verdict,
    row: rowView(store.readExecution(effect)),
  });
}

/**
 * Read one effect's DURABLE row from a real second process (P2 item 4): what the
 * binding holds after the process that wrote it exited.
 */
function readExecution(store: GraphStore): void {
  const effect: StoreEffectKey = {
    graphId: required("graph"),
    effectId: required("effect"),
    attemptId: required("attempt"),
  };
  emit({
    ok: true,
    mode: "read-execution",
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
      payload: { kind: "value", value: { tag } },
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

/**
 * Race a CONTROL DECISION against an acceptance — or against another control
 * command — from a REAL separate process (P3 item 1).
 *
 * WHY THIS MODE EXISTS. "A repeated command, a command that races an acceptance
 * and a command that races another control command each have a DETERMINISTIC
 * outcome" is a claim about the STORE's conditional writes, and two
 * `GraphStore` objects inside one process share one connection — exactly the
 * single-process evidence the plan refuses to count. Each worker here is its own
 * OS process with its own SQLite connection to the same file, and every round
 * starts from a marker barrier (`ready-<id>-<round>.marker` then
 * `go-<round>.marker`, the same protocol `claim-race` uses).
 *
 * WHAT IT DOES. With `--accept on` it commits ONE acceptance batch (receipt +
 * accepted event) for the attempt, exactly as the acceptance core does. Without
 * it, it applies ONE control decision for the attempt with its own
 * `--command`, `--reason` and `--at`. Both write through the SAME store
 * methods the shipped paths use, and both print the verdict they observed, so
 * the parent can assert the outcome per round rather than assume it.
 *
 * PRIVACY: store roots under the OS temp dir, minted ids and epoch
 * milliseconds only. No credential value is read or printed.
 */
async function controlRace(store: GraphStore): Promise<void> {
  const id = required("id");
  const graphId = required("graph");
  const runId = required("run");
  const nodeId = required("node");
  const attemptId = required("attempt");
  const reason = required("reason");
  const at = numberArg("at");
  const markerDir = required("marker-dir");
  const round = numberArg("round");
  const deadlineMs = Number(arg("deadline-ms") ?? "30000");
  const sessionId = arg("session") ?? "session.declarer";
  const accept = arg("accept") === "on";

  // The run identity the decision belongs to. Both racers mint it; the store
  // answers the FIRST one to every later mint, so the two processes agree.
  store.runs.mintRun({
    graphId,
    runId,
    startedAt: at,
    planRevision: arg("plan-revision") ?? "plan.xproc",
  });

  writeFileSync(join(markerDir, `ready-${id}-${round}.marker`), "1");
  await waitForMarker(
    join(markerDir, `go-${round}.marker`),
    deadlineMs,
    `go-${round}.marker`,
  );

  if (accept) {
    const committed = store.commitAccepted({
      receipt: {
        graphId,
        attemptId,
        submissionId: `submission:${id}:${round}`,
        planRevision: required("plan-revision"),
        proposalDigest: `digest-${id}-${round}`,
        decision: "accepted",
        committedAt: at,
      },
      acceptedEvent: {
        graphId,
        attemptId,
        submissionId: `submission:${id}:${round}`,
        planRevision: required("plan-revision"),
        outcomeId: required("outcome"),
        acceptedAt: at,
      },
    });
    emit({ ok: true, mode: "control-race", id, round, role: "acceptance", verdict: committed.kind });
    return;
  }

  const command = controlCommandArg("command");
  const verdict = store.runs.writeControlDecision({
    decision: {
      graphId,
      runId,
      nodeId,
      attemptId,
      command,
      reason,
      decidedAt: at,
      decidedBy: { sessionId },
    },
    runControl: {
      graphId,
      runId,
      command,
      reason,
      decidedAt: at,
      decidedBy: { sessionId },
    },
  });
  emit({
    ok: true,
    mode: "control-race",
    id,
    round,
    role: "control",
    command,
    verdict: verdict.kind,
    attemptId,
  });
}

/**
 * Apply ONE trusted control command to an EXISTING run, from THIS process.
 *
 * WHY THIS MODE EXISTS (P3 item 1, the inverse race). A submission's declared
 * acceptance gate is evaluated OUTSIDE the acceptance transaction, so a control
 * command that commits in that window is invisible to the run path's
 * pre-transaction check. The parent's gate spawns this worker SYNCHRONOUSLY
 * (`Bun.spawnSync`), so a REAL second OS process with its OWN connection
 * commits the command while the parent's submission has not opened its
 * transaction yet.
 *
 * THE RUN IDENTITY IS THE RUN PATH'S OWN. `mintRun` is idempotent: it answers
 * the identity the store already holds, so this process ADOPTS the run id
 * instead of minting a second one — `--run` is only a candidate for a graph
 * that has none.
 */
function applyControl(store: GraphStore): void {
  const graphId = required("graph");
  const nodeId = required("node");
  const attemptId = required("attempt");
  const command = controlCommandArg("command");
  const reason = required("reason");
  const at = numberArg("at");
  const sessionId = arg("session") ?? "session.declarer";
  const run = store.runs.mintRun({
    graphId,
    runId: arg("run") ?? graphId + "@apply-control",
    startedAt: at,
    planRevision: arg("plan-revision") ?? "plan.xproc",
  });
  const verdict = store.runs.writeControlDecision({
    decision: {
      graphId,
      runId: run.runId,
      nodeId,
      attemptId,
      command,
      reason,
      decidedAt: at,
      decidedBy: { sessionId },
    },
    runControl: {
      graphId,
      runId: run.runId,
      command,
      reason,
      decidedAt: at,
      decidedBy: { sessionId },
    },
  });
  emit({
    ok: true,
    mode: "apply-control",
    verdict: verdict.kind,
    runId: run.runId,
    command,
    nodeId,
    attemptId,
  });
}

/**
 * Hold the store's WRITE LOCK for `--hold-ms` and say so from INSIDE the
 * transaction.
 *
 * WHY THIS MODE EXISTS. A transaction that reads first and writes afterwards
 * must PROMOTE its shared lock to a reserved one, and SQLite refuses that
 * promotion immediately while another connection holds the write lock — it does
 * not wait on `busy_timeout`. This mode is that other connection: it takes the
 * lock with a REAL store write (a claim for its own, unrelated effect key inside
 * one explicit transaction) and keeps it, so the parent can prove that a
 * confirmation arriving in that window waits rather than failing. The marker is
 * written after the write and before the commit, so the parent never has to
 * guess whether the lock was held.
 */
function holdWriteLock(store: GraphStore): void {
  const graphId = required("graph");
  const markerDir = required("marker-dir");
  const now = numberArg("now");
  const leaseMs = numberArg("lease-ms");
  const holdMs = numberArg("hold-ms");

  store.transaction(() => {
    // The FIRST operation is a WRITE, so this transaction already holds the
    // store's write lock when the marker below announces it. `claimExecution`
    // joins this open transaction instead of opening a second one.
    store.claimExecution(
      { graphId, effectId: "lock-holder", attemptId: "lock-holder" },
      "owner-lock-holder",
      now,
      leaseMs,
    );
    writeFileSync(join(markerDir, "lock-held.marker"), "1");
    // Hold the lock for a fixed window. The wait is BLOCKING on purpose: the lock
    // belongs to this synchronous transaction, so yielding to the event loop
    // would not end the hold, and an async sleep could not be awaited inside it.
    const until = Date.now() + holdMs;
    while (Date.now() < until) {
      // spin: the transaction stays open for exactly `holdMs`
    }
  });
  emit({ ok: true, mode: "hold-write-lock", holdMs });
}

// ── Entry ───────────────────────────────────────────────────────────────────

const MODES = [
  "apply-control",
  "claim-race",
  "confirm-shape",
  "confirm-stale",
  "control-race",
  "hold-write-lock",
  "read-execution",
  "receipt",
] as const;
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
      case "apply-control":
        applyControl(store);
        return;
      case "claim-race":
        await claimRace(store);
        return;
      case "confirm-shape":
        confirmShape(store);
        return;
      case "confirm-stale":
        confirmStale(store);
        return;
      case "control-race":
        await controlRace(store);
        return;
      case "hold-write-lock":
        holdWriteLock(store);
        return;
      case "read-execution":
        readExecution(store);
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
