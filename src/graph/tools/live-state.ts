/**
 * Live GraphToolSet registry accessor — the bridge the TUI monitor uses to
 * read the process's in-memory graph registry on platforms where engine state
 * is never persisted to disk.
 *
 * Platform contract (monitor S10): on the opencode platform the graph engine
 * runs FULLY IN-MEMORY — engine state is never written to
 * `.rolebox/state/engine-*.json`, there is no durable graph-events ndjson log,
 * and graph lifecycles are scoped to the process that created them (see the
 * contract note in `src/core/services/tool-service.ts`). A disk scan of
 * `engine-*.json` therefore cannot see a running graph there; the monitor must
 * project the live registry instead.
 *
 * This module holds a module-level reference to the process's active
 * {@link GraphToolSet} (the single instance constructed by tool-service) so
 * the monitor reader (`readLiveEngineGraphs` in
 * `src/cli/commands/monitor/monitor-reader-engine.ts`) can project its live
 * runtimes via {@link GraphToolSet.liveEngineStates}. Exactly one toolset is
 * registered per process — last registration wins (a plugin reload constructs
 * a fresh toolset and re-registers it, abandoning any prior in-flight graph
 * exactly as the platform contract dictates).
 */

import type { GraphToolSet } from "./graph-tools.ts";

let liveToolSet: GraphToolSet | undefined;

/**
 * Register the process's active {@link GraphToolSet} for the live monitor
 * reader. Called once by the platform assembly layer that constructs the
 * single toolset (tool-service on opencode); a re-registration replaces the
 * previous reference (last registration wins).
 */
export function registerLiveGraphToolSet(toolset: GraphToolSet): void {
  liveToolSet = toolset;
}

/**
 * The registered live {@link GraphToolSet}, or `undefined` when none is
 * registered (no platform assembly has registered one, or it was cleared).
 * Callers fall back to the disk scan when this returns `undefined`.
 */
export function getLiveGraphToolSet(): GraphToolSet | undefined {
  return liveToolSet;
}

/**
 * Drop the registered live toolset reference. Test hygiene — lets a test
 * suite fully isolate itself from the module-level slot (bun runs each test
 * file in its own worker, but an `afterEach` clear keeps in-file ordering
 * deterministic).
 */
export function clearLiveGraphToolSet(): void {
  liveToolSet = undefined;
}
