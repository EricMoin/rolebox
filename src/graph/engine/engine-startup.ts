/**
 * Graph Execution Engine v2 — Startup Recovery Sweep
 *
 * Version: 1.0
 * Date: 2026-07-25
 *
 * The plugin-startup counterpart to {@link recover()}. On every plugin reload /
 * process restart, the platform sweeps the on-disk engine-state store
 * (`.rolebox/state/engine-*.json`) and resumes every graph that was left
 * mid-execution by a crash. This module is the *orchestrating loop* that walks
 * the store; the per-graph mechanics live in `engine-recovery.ts`
 * (`EngineRuntime.recover()`).
 *
 * Contract (engine-state-machine.md §5.1):
 * - Scan the `.rolebox/state` directory under `directory` for `engine-*.json`.
 * - Parse each via `loadEngineStateForResume` (version-gated through the
 *   storage-format registry; a corrupt / unsupported / migration-required file
 *   is REPORTED as that kind instead of collapsing to a single `null`).
 * - **Route by execution protocol (C3c).** A record bound to the OUTCOME
 *   protocol is NOT resumed through the legacy engine: it is handed to
 *   `resumePersistedOutcomeGraph` (`src/graph/outcome/recovery.ts`), which
 *   reads the SAVED compiled plan and its binding, continues the graph from the
 *   state in the acceptance ledger, launches what the state says is armed, and
 *   reports every unsettled effect. What that path did lands in the optional
 *   `outcomeProtocol` bucket. A protocol-2 record the outcome path cannot
 *   resume is reported there — never in `failed[]` (the record is valid) and
 *   never resumed under legacy rules.
 * - **Skip** graphs whose phase is already `complete` — a terminal graph has
 *   nothing to resume.
 * - For every remaining LEGACY graph, build `createEngine(declaration, {
 *   manager, graphId, stateDir, onNodeCompletion, onGraphTerminal,
 *   graphEvents })` and `await recover()` **inside a per-graph
 *   try/catch**, so one corrupt or failing graph never aborts the sweep.
 *   Failures are captured in `failed[]` and the loop continues to the sibling.
 *
 * Observer seams (monitor S10): the optional `onNodeCompletion` /
 * `onGraphTerminal` / `graphEvents` options are forwarded to every resumed
 * engine, so a graph that finished while the plugin was down re-announces its
 * transitions and continues its durable event log instead of being silent.
 * Absent → resumed engines behave exactly as before.
 *
 * Failure isolation is a hard guarantee: plugin startup must never be blocked
 * by a single bad engine file. This is enforced at three levels:
 *   1. A missing state dir → clean no-op (`scanned: 0`).
 *   2. `loadEngineStateForResume` answers a non-valid kind →
 *      corrupt / unsupported land in `failed[]`, migration-required lands in
 *      `migrationRequired[]`, never thrown.
 *   3. `recover()` per-graph try/catch → a throwing graph is captured and the
 *      remaining graphs still recover.
 *
 * Grades of success (B3): `recover()` answers a structured
 * {@link RecoveryReport}. Only `recovered` (state adopted AND the reconcile
 * pass completed) increments `recovered`; a `degraded` answer (the state was
 * adopted but `reconcileEngine` threw, so some `running` nodes were left
 * unreconciled while the graph stays runnable) is collected in `degraded[]`
 * with its error text; a throw past `recover()`'s own containment still lands
 * in `failed[]`. A file in a recognized storage format that has a registered
 * migration path is neither: it is collected in `migrationRequired[]` (the
 * snapshot is intact but not executable until the conversion commits), so the
 * sweep never counts it as a clean resume and never mislabels it as bad data.
 *
 * Idempotency: this sweep is safe to call repeatedly, but it must not be run
 * CONCURRENTLY — two overlapping sweeps would recover the same graph twice. An
 * OUTCOME graph is idempotent on its own terms: a resumed dispatch effect is
 * durably marked `started` BEFORE its seam runs, so a second sweep launches
 * nothing and reports the same unsettled rows (see `OutcomeGraphRuntime.resume`);
 * a graph with no ledger state gets its FIRST EXECUTION from the saved plan, and
 * a graph with a state is never started from scratch.
 * `recover()` reconciles every persisted `running` node against the dispatch
 * system: a still-live task is re-attached (never re-dispatched), a vanished
 * task is timed out, and a task that finished during the restart window has
 * its terminating signal re-emitted. It then rebuilds the frontier from the
 * `ready` nodes and DISPATCHES them — so "never re-dispatches" holds only for
 * nodes that are already running. A second sweep after a successful pass
 * finds every graph already `complete` and skips it (the phase is persisted).
 *
 * Design references:
 * - `.rolebox/design/engine-state-machine.md` §5 (resilience / crash recovery),
 *   §5.1 (recovery entry point), §5.2 (idempotency).
 * - `src/pi-extension.ts` loop-recovery block (the plugin-startup pattern this
 *   mirrors).
 * - Pattern mirrored from `src/loop/loop-store.ts` / `src/utils/state-paths.ts`
 *   (`.rolebox/state` layout — pattern reference only, those files are not
 *   modified).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DispatchManager } from "../../dispatch/core/manager.ts";
import { EnginePhase } from "../../constants.ts";
import { errorText } from "../../utils/error-text.ts";
import { type StorageFormatRegistry } from "../persistence/storage-format.ts";
import {
  DEFAULT_STORAGE_FORMAT_REGISTRY,
  engineStateDir,
  loadEngineStateForResume,
  type EngineLoadResult,
} from "./engine-persistence.ts";
import { OUTCOME_PROTOCOL } from "../protocol/execution-protocol.ts";
import { SqliteAcceptanceLedger } from "../ledger/sqlite-ledger.ts";
import {
  readPersistedOutcomePlan,
  resumePersistedOutcomeGraph,
} from "../outcome/recovery.ts";
import { describeOutcomeStop } from "../outcome/graph-state.ts";
import {
  createValidatorRegistry,
  type ValidatorRegistry,
} from "../outcome/validators.ts";
import type { CompletionPolicyRegistry } from "../policy/completion-policy.ts";
import {
  credentialIsolationRefusal,
  readCredentialIsolationAdapter,
  type CredentialIsolationAdapter,
} from "../outcome/credential-isolation.ts";
import {
  hostIdentityRefusal,
  readHostIdentityCapability,
  type HostIdentityCapability,
} from "../outcome/host-identity.ts";
import type {
  OutcomeDispatchAdapter,
  OutcomeResumeResult,
} from "../outcome/runtime.ts";
import { logWarn } from "./log-warn.ts";
import type {
  NodeCompletionEvent,
  GraphTerminalEvent,
} from "./engine-advance.ts";
import type { GraphEventRecorder } from "./graph-events.ts";
// NOTE: imports createEngine from the public barrel (./index.ts) rather than
// a separate factory file. createEngine is defined in index.ts alongside its
// private EngineRuntimeImpl class — extracting it to a standalone factory
// module is a separate refactoring task. The barrel import is safe because
// engine-startup.ts is itself an engine-internal module; the barrel re-exports
// are additive (no cycle).
import { createEngine } from "./index.ts";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * What one sweep did with the OUTCOME-protocol (declared) graphs it found
 * (C3c).
 *
 * A declared graph is not resumed through the legacy engine, so it has its own
 * bucket rather than being counted in `recovered` (which means "a legacy engine
 * adopted its snapshot and reconciled") or reported in `failed` (which means
 * "unreadable or corrupt"). Every line names the graph so the report is
 * evidence, not a count:
 *
 * - `started` — the graph had NO ledger state, so this sweep performed its
 *   FIRST EXECUTION from the SAVED plan. The line names the plan revision.
 * - `resumed` — the graph had a ledger state and was continued from it: the
 *   line names the plan revision, the phase and every armed node/attempt.
 * - `dispatched` — the dispatch requests this sweep actually launched
 *   (`graph:node#attempt`). A launch happens only for a dispatch effect the
 *   state corroborates and the HOST confirms has no execution yet (`absent`);
 *   the effect is marked `started` only AFTER the create returns, so a second
 *   sweep resolves the row again and re-creates nothing.
 * - `reconciled` — every unsettled effect the sweep RESOLVED WITHOUT
 *   LAUNCHING, with the host fact that resolved it (`graph:effectId:reason`):
 *   the host reported the execution as already created, or the row already
 *   recorded a create that returned. This is the crash window being closed by
 *   asking the host instead of retrying.
 * - `armed` — every node the persisted state records as in flight
 *   (`graph:node#attempt`), including one whose effect is already `started`
 *   (a dead process began it) and one recorded by an earlier `start()`.
 * - `unsettledEffects` — every effect still `pending` or `started` after the
 *   sweep (`graph:effectId@status`). A `started` row from a dead process is
 *   REPORTED here; it is never re-launched and never dropped.
 * - `refused` — an outcome graph this sweep could not resume, with the reason
 *   (no persisted plan, a plan/binding revision disagreement, a state bound to
 *   another revision, a protocol this build cannot run). The record is
 *   preserved exactly as it was.
 *
 * The whole bucket is absent from a report when the sweep saw no
 * outcome-protocol record at all, so a legacy-only store keeps the exact report
 * shape it had before C3c.
 */
export interface OutcomeRecoveryReport {
  /** First executions performed from the saved plan. */
  started: string[];
  /** Graphs continued from their persisted ledger state. */
  resumed: string[];
  /** Dispatch effects actually launched by this sweep. */
  dispatched: string[];
  /** Unsettled effects this sweep resolved without launching, with the reason. */
  reconciled: string[];
  /**
   * Every DISAGREEMENT this sweep found between a persisted local effect status
   * and the host's fact about the same stable effect id (D9), each naming the
   * effect, the two sides and what the sweep did about it. A divergence is never
   * a re-dispatch and never a silent drop: the local-ahead case (`started` while
   * the host reports `absent`) is also a `refused[]` entry, and the host-ahead
   * case (`pending` while the host reports `created`) is also a `reconciled[]`
   * entry — this bucket names the disagreement itself, so a reader that only
   * wants the contradictions finds them without reverse-engineering the others.
   */
  divergences: string[];
  /** Nodes the persisted state records as in flight, with their attempts. */
  armed: string[];
  /** Effects still pending or started after this sweep. */
  unsettledEffects: string[];
  /**
   * Graphs the persisted state reports as STOPPED (body version 4), each with
   * the reason and the round it hit. A stopped graph is resumed in the sense
   * that it is READ and reported, and in no other: nothing is launched and no
   * node is offered as armed. Listed separately from `resumed[]` so a run that
   * ended on a declared hard limit is never counted as one that merely
   * continued.
   */
  stopped: string[];
  /** Outcome graphs that could not be resumed, with the reason. */
  refused: string[];
}

/** Outcome of a startup recovery sweep over the on-disk engine store. */
export interface RecoveryStartupReport {
  /** Total number of `engine-*.json` files found in the state store. */
  scanned: number;
  /**
   * Graphs successfully resumed via {@link createEngine} + `recover()` —
   * `recover()` answered `recovered`, so the persisted state was adopted AND
   * the reconcile pass completed. A degraded recovery is counted here NEVER
   * (B3): a partially-reconciled graph is not a clean resume.
   */
  recovered: number;
  /**
   * Graphs whose persisted state was adopted but whose reconcile pass threw
   * (`recover()` answered `degraded`), each labelled with the
   * `engine-*.json` filename, the graph id and the reconcile error text (B3).
   * The graph is still runnable — recovery rebuilt the frontier and dispatched
   * ready nodes — but some `running` nodes were left unreconciled, so the
   * sweep must not report it as a clean `recovered`.
   */
  degraded: string[];
  /**
   * Files written in a recognized storage format that has a REGISTERED
   * conversion path but cannot execute until that conversion is committed
   * (docs/graph-outcome-protocol.md § "Exact mismatch rules"), each labelled
   * like `failed[]`. A migration-required graph is deliberately counted in
   * NEITHER `recovered` NOR `failed`: the snapshot is intact (not bad data)
   * and it is not resumed (not a clean recovery), so the sweep must surface it
   * separately rather than silently skipping it or mislabelling a build
   * limitation as corruption.
   */
  migrationRequired: string[];
  /**
   * Files/graphs that could not be recovered, each labelled with the
   * underlying `engine-*.json` filename (and the graph id when extractable).
   * Never empty a sweep — it is a diagnostic log, not a blocker.
   */
  failed: string[];
  /**
   * What this sweep did with the OUTCOME-protocol (declared) graphs it found
   * (C3c). PRESENT exactly when the sweep encountered at least one valid
   * protocol-2 record; absent for a legacy-only store, so an existing caller
   * that deep-compares the report keeps its exact shape.
   */
  outcomeProtocol?: OutcomeRecoveryReport;
}

/** Options for {@link recoverInterruptedGraphs}. */
export interface RecoverInterruptedGraphsOptions {
  /**
   * Workspace directory whose `.rolebox/state/` store is swept for
   * `engine-*.json` files. This is the same directory `EnginePersistence`
   * writes to (`join(directory, ".rolebox", "state")`).
   */
  directory: string;

  /**
   * The live {@link DispatchManager} every resumed engine reconciles its
   * `running` nodes against (`getTask` / `onTaskTerminated`).
   */
  manager: DispatchManager;

  /**
   * Hard on/off switch for the sweep. When `false`, returns a no-op report
   * (`{ scanned: 0, recovered: 0, degraded: [], migrationRequired: [], failed: [] }`)
   * without touching the store. Defaults to `true`.
   */
  enabled?: boolean;

  /**
   * Storage-format support registry used to classify each file's `version`
   * (capability vocabulary in `src/graph/persistence/storage-format.ts`;
   * {@link DEFAULT_STORAGE_FORMAT_REGISTRY} is assembled next to the format-2
   * decoder in `engine-persistence.ts`). Defaults to that registry — exactly
   * one decoder, for format 2, and no registered migrations — which is the
   * production behavior. Injectable so a test can install a decoder or a
   * migration capability and exercise the `migrationRequired[]` bucket without
   * a real on-disk predecessor format.
   */
  storageFormatRegistry?: StorageFormatRegistry;

  /**
   * Optional workspace directory passed through to {@link createEngine} for
   * the resumed engine's persistence seam. Defaults to `directory` — they are
   * the same thing unless a caller deliberately separates the scan root from
   * the re-persist root.
   */
  stateDir?: string;

  /**
   * Optional node-completion notification seam (graph monitoring) forwarded to
   * every resumed engine's `onNodeCompletion` hook. Recovery re-emits the
   * terminating transitions of nodes whose tasks finished during the restart
   * window — wiring a notifier here lets the orchestrator perceive those
   * completions instead of the recovered engine being completely silent on
   * reminders (the pre-fix gap). Defaults to absent → each resumed engine
   * keeps its default no-op seam, so behavior is identical to older versions.
   */
  onNodeCompletion?: (
    event: NodeCompletionEvent,
  ) => void | Promise<unknown>;

  /**
   * Optional graph-terminal notification seam (graph monitoring) forwarded to
   * every resumed engine's `onGraphTerminal` hook — re-announces
   * [GRAPH COMPLETE] / [GRAPH BLOCKED] for graphs that reached a terminal
   * state while the plugin was down. Defaults to absent → no-op (unchanged
   * behavior).
   */
  onGraphTerminal?: (
    event: GraphTerminalEvent,
  ) => void | Promise<unknown>;

  /**
   * Optional write-side durable event log (graph monitoring) forwarded to
   * every resumed engine's `graphEvents` seam. Passing the same
   * {@link GraphEventRecorder} (built over the same `stateDir`) the running
   * graph used lets a recovered engine CONTINUE appending
   * `node_completed` / `phase_change` / … lines to
   * `graph-events-{hash}.ndjson` instead of leaving the audit log silent
   * after a restart. Defaults to absent → no event logging (unchanged
   * behavior).
   */
  graphEvents?: GraphEventRecorder;

  /**
   * The HOST dispatch adapter for resumed/first-run OUTCOME-protocol graphs
   * (C3c, D8). The outcome run path starts a node by calling it, and a restart
   * asks its execution query whether a create already happened.
   *
   * REQUIRED IN PRACTICE: without one the sweep reports every outcome graph as
   * refused (`dispatch-unavailable`) and opens no ledger. There is deliberately
   * no no-op default — a no-op would let the run record a dispatch nobody
   * performed (and hand no worker its attempt credential) while every report
   * reads as if the node were running. A bare seam is accepted as the
   * degenerate adapter: it can create, it cannot be queried, and a recovery that
   * needs the query reports the effect instead of re-issuing the create.
   */
  outcomeDispatch?: OutcomeDispatchAdapter;

  /**
   * Optional installed validator implementations for outcome-protocol graphs
   * (C3c). The plan pins each acceptance requirement at an exact
   * `{ validator, version }`; a requirement with no registered implementation
   * is REFUSED by the acceptance core rather than skipped, so the default is an
   * EMPTY registry (a plan whose gates need a capability this process does not
   * have must not read as accepted).
   */
  outcomeValidators?: ValidatorRegistry;

  /**
   * Optional HOST-INSTALLED completion-policy capability (D6). A persisted
   * plan that pins natural-completion authorizations is corroborated against
   * it before the sweep resumes anything; WITHOUT it such a graph is reported
   * as refused (`completion-policy-unavailable`) and its state is left exactly
   * as it is. A graph whose plan pins none is unaffected.
   */
  outcomeCompletionPolicies?: CompletionPolicyRegistry;

  /**
   * Optional HOST credential-isolation capability (D7) for the outcome run
   * path. The sweep is one of that path's entry points, so it consults the
   * capability BEFORE it opens the ledger: without a readable adapter the
   * graph is reported in `outcomeProtocol.refused` with
   * `credential-isolation-unavailable` and NOTHING is opened, launched or
   * written. With one, the ledger is opened at the adapter's declared
   * `credentialStoreRoot` instead of the scanned workspace's default.
   */
  outcomeCredentialIsolation?: CredentialIsolationAdapter;

  /**
   * Optional HOST invocation-identity capability (D9) for the outcome run path.
   * The sweep forwards it to `resumePersistedOutcomeGraph` unchanged: a recovered
   * attempt keeps the dispatch identity its own state recorded (a restart never
   * re-binds it), a FIRST execution the sweep performs records whatever identity
   * the host reports for this invocation, and a capability that is present but
   * UNREADABLE is reported in `outcomeProtocol.refused` with
   * `host-identity-unavailable` before the ledger is opened. ABSENT is legal: the
   * identity binding is not enabled and the sweep behaves exactly as before.
   */
  outcomeHostIdentity?: HostIdentityCapability;

  /**
   * Root every outcome evidence reference must resolve inside (C3c). Defaults
   * to `directory` — the workspace whose `.rolebox/state` store was scanned.
   */
  outcomeArtifactRoot?: string;

  /**
   * Epoch milliseconds the outcome resume stamps on a FIRST-EXECUTION state
   * snapshot (C3c). Time is an explicit protocol input, so a caller may pin it;
   * omitted → `Date.now()`. Resuming an EXISTING state writes no state, so the
   * value only matters when the sweep performs a graph's first execution.
   */
  outcomeNow?: number;
}

// ── Outcome-protocol recovery (C3c) ─────────────────────────────────────────

/**
 * The validator capability used when the caller injects none: EMPTY.
 *
 * Not a silent pass: the acceptance core refuses a requirement whose exact
 * `{ validator, version }` has no registered implementation, so an empty
 * registry can only produce refusals — never an accepted gate nobody checked.
 */
const NO_OUTCOME_VALIDATORS: ValidatorRegistry = createValidatorRegistry([]);

/** An empty outcome bucket; created on the first protocol-2 record. */
function emptyOutcomeRecoveryReport(): OutcomeRecoveryReport {
  return {
    started: [],
    resumed: [],
    dispatched: [],
    reconciled: [],
    divergences: [],
    armed: [],
    unsettledEffects: [],
    stopped: [],
    refused: [],
  };
}

/**
 * Record one outcome resume result into the sweep's outcome bucket.
 *
 * Every line names the graph, and every launched dispatch, armed node and
 * unsettled effect is listed individually: this bucket IS the restart-recovery
 * evidence, so a count would not be enough to tell what was continued, what was
 * launched, and what a dead process left behind.
 */
function recordOutcomeRecovery(
  bucket: OutcomeRecoveryReport,
  label: string,
  graphId: string,
  result: OutcomeResumeResult,
): void {
  if (result.kind === "refused") {
    for (const refusal of result.refusals) {
      bucket.refused.push(
        `${label} (graph ${graphId}: [${refusal.code}] ${refusal.message})`,
      );
    }
    return;
  }
  const armed = result.armed.map((node) => node.attemptId).join(", ");
  const stop = result.kind === "resumed" ? result.stop : undefined;
  const line =
    `${label} (graph ${graphId}: plan revision ${result.state.planRevision}, ` +
    `phase ${result.state.phase}` +
    (stop === undefined
      ? ""
      : `, STOPPED by ${stop.reason} (${describeOutcomeStop(stop)})`) +
    (armed.length === 0 ? "" : `, armed [${armed}]`) +
    ")";
  if (result.kind === "started") bucket.started.push(line);
  else bucket.resumed.push(line);
  if (stop !== undefined) {
    bucket.stopped.push(
      `${label} (graph ${graphId}: [${stop.reason}] ${describeOutcomeStop(stop)}, ` +
        `node ${stop.nodeId}, outcome ${stop.outcomeId})`,
    );
  }
  for (const request of result.dispatched) {
    bucket.dispatched.push(`${graphId}:${request.attemptId}`);
  }
  for (const effect of result.reconciled) {
    bucket.reconciled.push(`${graphId}:${effect.effectId}:${effect.reason}`);
  }
  for (const divergence of result.divergences) {
    bucket.divergences.push(
      `${graphId}:${divergence.effectId}:` +
        `local-${divergence.local}-host-${divergence.host}:${divergence.resolution}`,
    );
  }
  for (const node of result.armed) {
    bucket.armed.push(`${graphId}:${node.attemptId}`);
  }
  for (const effect of result.unsettledEffects) {
    bucket.unsettledEffects.push(`${graphId}:${effect.effectId}@${effect.status}`);
  }
  for (const refusal of result.refusals) {
    bucket.refused.push(
      `${label} (graph ${graphId}: [${refusal.code}] ${refusal.message})`,
    );
  }
}

// ── Startup recovery sweep ──────────────────────────────────────────────────

/**
 * Sweep the on-disk engine-state store and resume every interrupted graph.
 *
 * Walks `.rolebox/state/engine-*.json` under `directory`, classifies each via
 * the version-gated `loadEngineStateForResume` loader, skips already-`complete`
 * graphs, and resumes the rest — each in its own try/catch so a single bad
 * file never aborts the sweep (see the module docs for the three-level failure
 * isolation). Corrupt / unsupported files land in `failed[]`, files with a
 * registered storage migration in `migrationRequired[]`.
 *
 * Idempotent and callable any number of times (a resumed graph is persisted as
 * `complete` and skipped on the next pass).
 *
 * @param opts The sweep configuration (directory + manager are required).
 * @returns A {@link RecoveryStartupReport} describing what was scanned,
 *          recovered, degraded, migration-required, and failed.
 */
export async function recoverInterruptedGraphs(
  opts: RecoverInterruptedGraphsOptions,
): Promise<RecoveryStartupReport> {
  // Hard disable — return a no-op report without touching the store.
  if (opts.enabled === false) {
    return {
      scanned: 0,
      recovered: 0,
      degraded: [],
      migrationRequired: [],
      failed: [],
    };
  }

  const stateDir = engineStateDir(opts.directory);
  const registry =
    opts.storageFormatRegistry ?? DEFAULT_STORAGE_FORMAT_REGISTRY;

  // 1. List the store. A missing/unreadable store → nothing to recover.
  let files: string[];
  try {
    files = readdirSync(stateDir).filter(
      (f) => f.startsWith("engine-") && f.endsWith(".json"),
    );
  } catch {
    // No `.rolebox/state` yet — first run. Clean no-op.
    return {
      scanned: 0,
      recovered: 0,
      degraded: [],
      migrationRequired: [],
      failed: [],
    };
  }

  const scanned = files.length;
  const failed: string[] = [];
  const degraded: string[] = [];
  const migrationRequired: string[] = [];
  let recovered = 0;
  /**
   * The outcome-protocol half of the report (C3c). Created lazily on the first
   * valid protocol-2 record, so a legacy-only store keeps the exact report shape
   * it had before this slice (an absent optional field).
   */
  let outcome: OutcomeRecoveryReport | undefined;

  // 2. Parse + recover each file in isolation.
  for (const file of files) {
    const filePath = join(stateDir, file);
    const label = `engine-*.json:${file}`;

    // 2a. Read + parse. A read error is captured in `failed[]`, never thrown
    //     past the sweep; a non-valid load result is routed to the bucket that
    //     describes it (corrupt / unsupported → `failed[]`, migration-required
    //     → `migrationRequired[]`).
    let loaded: EngineLoadResult;
    try {
      const raw = readFileSync(filePath, "utf-8");
      loaded = loadEngineStateForResume(raw, filePath, registry);
    } catch (err) {
      logWarn(`engine-startup: read failed for ${label}: ${errorText(err)}`);
      failed.push(`${label} (read error: ${errorText(err)})`);
      continue;
    }

    // 2a-i. Defensive arm, kept deliberately. This call reads RAW TEXT through
    //       `loadEngineStateForResume`, which cannot itself answer `absent`:
    //       absent is produced only by the file-level loader's ENOENT path
    //       (`EnginePersistence.loadForResume`), and a file vanishing between
    //       the directory listing and the read is already handled by the read-
    //       error arm above — so this arm must NOT claim that happened. It
    //       exists because the result union requires exhaustive handling and a
    //       `default:` would hide a future union member; a future narrowing of
    //       the loader's return type could remove it. Behavior is unchanged:
    //       still recorded as a read failure.
    if (loaded.kind === "absent") {
      logWarn(`engine-startup: loader returned absent for ${label} (recorded as a read failure)`);
      failed.push(`${label} (read error: loader returned absent)`);
      continue;
    }
    // 2a-ii. A recognized representation that violates its schema / required
    //        shape / enum vocabulary / format discriminator is corrupt:
    //        preserved and reported, never rerun as fresh. The dimension is
    //        labelled like `unsupported`'s, so a later non-storage axis cannot
    //        read as a storage mismatch.
    if (loaded.kind === "corrupt") {
      logWarn(
        `engine-startup: skipped corrupt state file ${label}: corrupt ${loaded.dimension}: ${loaded.reason}`,
      );
      failed.push(
        `${label} (corrupt ${loaded.dimension}: ${loaded.reason})`,
      );
      continue;
    }
    // 2a-iii. No installed decoder for this storage format — the file needs
    //         compatible code (or a migration), not a clean start.
    if (loaded.kind === "unsupported") {
      logWarn(
        `engine-startup: skipped unsupported state file ${label}: unsupported ${loaded.dimension}: ${loaded.detail}`,
      );
      failed.push(
        `${label} (unsupported ${loaded.dimension}: ${loaded.detail})`,
      );
      continue;
    }
    // 2a-iv. Recognized format with a registered migration: intact data that
    //        cannot execute yet. Counted as neither recovered nor failed.
    if (loaded.kind === "migration-required") {
      logWarn(
        `engine-startup: storage migration required for ${label}: ${loaded.from} -> ${loaded.to}`,
      );
      migrationRequired.push(
        `${label} (migration-required storage: ${loaded.from} -> ${loaded.to})`,
      );
      continue;
    }

    // 2a-v. C3c: a DECLARED (protocol 2) graph is resumed through the OUTCOME
    //       run path — never through the legacy engine below. Recovery reads
    //       the SAVED plan and its binding out of this record and the graph
    //       state out of the ledger: a graph with a state is CONTINUED from it,
    //       and a graph with NO state is started — its FIRST EXECUTION — from
    //       that same saved plan. Neither path builds a legacy engine, and
    //       nothing here rewrites the record. A record this path cannot resume
    //       (no persisted plan, a plan/binding disagreement, a state bound to
    //       another revision) is REPORTED in `outcomeProtocol.refused` and left
    //       exactly as it is.
    if (loaded.executionProtocol === OUTCOME_PROTOCOL) {
      if (outcome === undefined) outcome = emptyOutcomeRecoveryReport();
      const bucket = outcome;
      // THE RECORD'S OWN IDENTITY IS READ FIRST, AND NO STORE IS OPENED FOR
      // IT. A record that carries no persisted plan, or a plan/binding
      // disagreement, is a fact about THAT record; it is reported by name
      // before the environment's capability is judged — the same order the
      // submission ingress uses, so a broken record is never hidden behind an
      // environment refusal.
      const planReading = readPersistedOutcomePlan(loaded.state);
      if (planReading.kind === "refused") {
        recordOutcomeRecovery(bucket, label, loaded.state.graphId, {
          kind: "refused",
          refusals: planReading.refusals,
        });
        continue;
      }
      // THE HOST CAPABILITY GATE (D7) RUNS BEFORE THE LEDGER IS OPENED. This
      // build persists attempt credentials in a store it cannot keep out of a
      // same-account reader's reach, so a sweep with no readable host adapter
      // must not create, read or resume anything: it reports the refusal and
      // leaves the persisted record exactly as it found it. With an adapter,
      // the ledger opens at the root the host declared as protected.
      const unprotected = credentialIsolationRefusal(
        opts.outcomeCredentialIsolation,
      );
      if (unprotected !== undefined) {
        bucket.refused.push(
          `${label} (graph ${loaded.state.graphId}: [${unprotected.code}] ${unprotected.message})`,
        );
        continue;
      }
      // THE HOST IDENTITY GATE (D9) RUNS BEFORE THE LEDGER IS OPENED, exactly
      // like the credential gate: a capability this build cannot read is a
      // declared constraint the sweep must not silently drop, so it reports the
      // refusal and leaves the record exactly as it found it. No capability at
      // all is NOT a refusal — the identity binding is simply not enabled.
      const unreadableHostIdentity = hostIdentityRefusal(
        opts.outcomeHostIdentity,
      );
      if (unreadableHostIdentity !== undefined) {
        bucket.refused.push(
          `${label} (graph ${loaded.state.graphId}: [${unreadableHostIdentity.code}] ` +
            `${unreadableHostIdentity.message})`,
        );
        continue;
      }
      // NO DISPATCH ADAPTER, NO RESUME (D8). A dispatch intent recorded without
      // a host that can create the execution is a dispatch this sweep would be
      // claiming it performed, so the graph is REPORTED and the store is left
      // exactly as it was — the same shape as the credential gate above, and
      // checked before the ledger is opened.
      if (opts.outcomeDispatch === undefined) {
        bucket.refused.push(
          `${label} (graph ${loaded.state.graphId}: [dispatch-unavailable] ` +
            "no dispatch adapter is installed for this process — an outcome graph's " +
            "dispatch effects have to be created by a host, and a no-op default would " +
            "record dispatches nobody performed; nothing was opened and nothing was " +
            "resumed)",
        );
        continue;
      }
      const isolation = readCredentialIsolationAdapter(
        opts.outcomeCredentialIsolation,
      );
      // The gate above admitted only an ABSENT or READABLE identity capability,
      // so this normalization only ever lifts a readable host declaration.
      const hostIdentity = readHostIdentityCapability(opts.outcomeHostIdentity);
      let ledger: SqliteAcceptanceLedger | undefined;
      try {
        ledger = await SqliteAcceptanceLedger.create(
          isolation?.credentialStoreRoot ?? stateDir,
        );
        recordOutcomeRecovery(
          bucket,
          label,
          loaded.state.graphId,
          resumePersistedOutcomeGraph({
            state: loaded.state,
            ledger,
            dispatch: opts.outcomeDispatch,
            validators: opts.outcomeValidators ?? NO_OUTCOME_VALIDATORS,
            artifactRoot: opts.outcomeArtifactRoot ?? opts.directory,
            ...(opts.outcomeNow === undefined ? {} : { now: opts.outcomeNow }),
            ...(opts.outcomeCompletionPolicies === undefined
              ? {}
              : { completionPolicies: opts.outcomeCompletionPolicies }),
            ...(isolation === undefined
              ? {}
              : { credentialIsolation: isolation }),
            ...(hostIdentity === undefined ? {} : { hostIdentity }),
          }),
        );
      } catch (err) {
        logWarn(
          `engine-startup: outcome recovery failed for ${label}: ${errorText(err)}`,
        );
        bucket.refused.push(
          `${label} (graph ${loaded.state.graphId}: ${errorText(err)})`,
        );
      } finally {
        // Per-graph handle: the ledger is opened only for an outcome record and
        // closed here, so a sweep never leaks a store handle and a legacy-only
        // store never grows one.
        ledger?.close();
      }
      continue;
    }

    const state = loaded.state;

    // 2b. A terminal graph has nothing to resume — skip.
    if (state.phase === EnginePhase.Complete) continue;

    // 2c. Per-graph recovery in its own try/catch — one failing graph must
    //     never abort the sweep of its siblings.
    try {
      const engine = createEngine(state.graphDeclaration, {
        manager: opts.manager,
        graphId: state.graphId,
        stateDir: opts.stateDir ?? opts.directory,
        // Monitor (S10): forward the observer seams onto the resumed engine so
        // a recovered graph re-announces node completions / graph-terminal
        // transitions and continues its durable event log instead of running
        // completely silent on reminders and audit lines.
        onNodeCompletion: opts.onNodeCompletion,
        onGraphTerminal: opts.onGraphTerminal,
        graphEvents: opts.graphEvents,
      });
      // B3: only a full `recovered` status counts as a clean resume. A
      // `degraded` reconcile is reported separately (the graph is still
      // runnable, but some `running` nodes were left unreconciled), and
      // `no_state` (the persisted file vanished between the parse and the
      // engine's own load) is counted as neither.
      const recovery = await engine.recover();
      if (recovery.status === "recovered") {
        recovered += 1;
      } else if (recovery.status === "degraded") {
        const detail = recovery.reconcileError ?? "reconcile failed";
        logWarn(
          `engine-startup: recovery degraded for graph ${state.graphId}: ${detail}`,
        );
        degraded.push(`${label} (graph ${state.graphId}: ${detail})`);
      }
    } catch (err) {
      logWarn(
        `engine-startup: recovery failed for graph ${state.graphId}: ${errorText(err)}`,
      );
      failed.push(
        `${label} (graph ${state.graphId}: ${errorText(err)})`,
      );
    }
  }

  return {
    scanned,
    recovered,
    degraded,
    migrationRequired,
    failed,
    ...(outcome === undefined ? {} : { outcomeProtocol: outcome }),
  };
}

