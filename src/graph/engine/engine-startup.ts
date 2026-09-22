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
 * - **Skip** graphs whose phase is already `complete` — a terminal graph has
 *   nothing to resume.
 * - For every remaining graph, build `createEngine(declaration, { manager,
 *   graphId, stateDir, onNodeCompletion, onGraphTerminal, graphEvents })` and
 *   `await recover()` **inside a per-graph
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
 * CONCURRENTLY — two overlapping sweeps would recover the same graph twice.
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
  loadEngineStateForResume,
  type EngineLoadResult,
} from "./engine-persistence.ts";
import { OUTCOME_PROTOCOL } from "../protocol/execution-protocol.ts";
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

  const stateDir = join(opts.directory, ".rolebox", "state");
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

    // 2a-v. C3b: the outcome protocol now HAS a registered handler, so a
    //       declared graph loads as `valid` — but its restart recovery is a
    //       LATER slice, and this legacy sweep must never resume it under
    //       legacy rules. The record is reported and preserved exactly as it
    //       was; the outcome run path is the only thing that may start it.
    if (loaded.executionProtocol === OUTCOME_PROTOCOL) {
      logWarn(
        `engine-startup: skipped outcome-protocol state file ${label}: restart recovery for the outcome protocol is not implemented in this build`,
      );
      failed.push(
        `${label} (outcome protocol: restart recovery is deferred in this build; the record was preserved and not resumed under legacy rules)`,
      );
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

  return { scanned, recovered, degraded, migrationRequired, failed };
}

