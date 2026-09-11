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
 * - Parse each via `loadEngineStateFromJson` (version-gated, tolerant of a
 *   corrupt / version-mismatched file → `null`).
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
 *   2. `loadEngineStateFromJson` returns `null` (corrupt/version-mismatch) →
 *      the file is captured in `failed[]`, not thrown.
 *   3. `recover()` per-graph try/catch → a throwing graph is captured and the
 *      remaining graphs still recover.
 *
 * Idempotency: this sweep is safe to call repeatedly. `recover()` never
 * re-dispatches — it only re-attaches to already-dispatched tasks (or times
 * out vanished ones), so re-running the sweep after a successful pass finds
 * every graph already `complete` and skips it.
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
import { loadEngineStateFromJson } from "./engine-persistence.ts";
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
  /** Graphs successfully resumed via {@link createEngine} + `recover()`. */
  recovered: number;
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
   * (`{ scanned: 0, recovered: 0, failed: [] }`) without touching the store.
   * Defaults to `true`.
   */
  enabled?: boolean;

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
  onNodeCompletion?: (event: NodeCompletionEvent) => void;

  /**
   * Optional graph-terminal notification seam (graph monitoring) forwarded to
   * every resumed engine's `onGraphTerminal` hook — re-announces
   * [GRAPH COMPLETE] / [GRAPH BLOCKED] for graphs that reached a terminal
   * state while the plugin was down. Defaults to absent → no-op (unchanged
   * behavior).
   */
  onGraphTerminal?: (event: GraphTerminalEvent) => void;

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
 * Walks `.rolebox/state/engine-*.json` under `directory`, parses each via the
 * version-gated `loadEngineStateFromJson` helper, skips already-`complete`
 * graphs, and resumes the rest — each in its own try/catch so a single bad
 * file never aborts the sweep (see the module docs for the three-level failure
 * isolation).
 *
 * Idempotent and callable any number of times (a resumed graph is persisted as
 * `complete` and skipped on the next pass).
 *
 * @param opts The sweep configuration (directory + manager are required).
 * @returns A {@link RecoveryStartupReport} describing what was scanned,
 *          recovered, and failed.
 */
export async function recoverInterruptedGraphs(
  opts: RecoverInterruptedGraphsOptions,
): Promise<RecoveryStartupReport> {
  // Hard disable — return a no-op report without touching the store.
  if (opts.enabled === false) {
    return { scanned: 0, recovered: 0, failed: [] };
  }

  const stateDir = join(opts.directory, ".rolebox", "state");

  // 1. List the store. A missing/unreadable store → nothing to recover.
  let files: string[];
  try {
    files = readdirSync(stateDir).filter(
      (f) => f.startsWith("engine-") && f.endsWith(".json"),
    );
  } catch {
    // No `.rolebox/state` yet — first run. Clean no-op.
    return { scanned: 0, recovered: 0, failed: [] };
  }

  const scanned = files.length;
  const failed: string[] = [];
  let recovered = 0;

  // 2. Parse + recover each file in isolation.
  for (const file of files) {
    const filePath = join(stateDir, file);
    const label = `engine-*.json:${file}`;

    // 2a. Read + parse. A read error or a corrupt / version-mismatched file is
    //     captured in `failed[]`, never thrown past the sweep.
    let loaded: ReturnType<typeof loadEngineStateFromJson>;
    try {
      const raw = readFileSync(filePath, "utf-8");
      loaded = loadEngineStateFromJson(raw, filePath);
    } catch (err) {
      logWarn(`engine-startup: read failed for ${label}: ${messageOf(err)}`);
      failed.push(`${label} (read error: ${messageOf(err)})`);
      continue;
    }
    if (!loaded) {
      // Corrupt JSON / version mismatch / not a v2 engine state file.
      logWarn(`engine-startup: skipped unparseable state file ${label}`);
      failed.push(`${label} (unparseable or version-mismatched state)`);
      continue;
    }

    // 2b. A terminal graph has nothing to resume — skip.
    if (loaded.phase === EnginePhase.Complete) continue;

    // 2c. Per-graph recovery in its own try/catch — one failing graph must
    //     never abort the sweep of its siblings.
    try {
      const engine = createEngine(loaded.graphDeclaration, {
        manager: opts.manager,
        graphId: loaded.graphId,
        stateDir: opts.stateDir ?? opts.directory,
        // Monitor (S10): forward the observer seams onto the resumed engine so
        // a recovered graph re-announces node completions / graph-terminal
        // transitions and continues its durable event log instead of running
        // completely silent on reminders and audit lines.
        onNodeCompletion: opts.onNodeCompletion,
        onGraphTerminal: opts.onGraphTerminal,
        graphEvents: opts.graphEvents,
      });
      await engine.recover();
      recovered += 1;
    } catch (err) {
      logWarn(
        `engine-startup: recovery failed for graph ${loaded.graphId}: ${messageOf(err)}`,
      );
      failed.push(
        `${label} (graph ${loaded.graphId}: ${messageOf(err)})`,
      );
    }
  }

  return { scanned, recovered, failed };
}

/** Coerce an unknown thrown value to a short, safe error string. */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Minimal, dependency-free warning logger (no createSubLogger import cycle). */
function logWarn(message: string): void {
  // eslint-disable-next-line no-console
  console.warn(message);
}
