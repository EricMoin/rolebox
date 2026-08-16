/**
 * Pi Hook Pipeline — `src/platform/adapters/pi/hook-pipeline.ts`
 *
 * Constructs the full HookDeps for the Pi platform and routes every canonical
 * event emitted by the PiEventBridge through the shared event handler
 * (`src/hooks/event-handler.ts`), mirroring how hook-service.ts wires the
 * opencode platform:
 *
 *   - `session`            = the Pi notification-wrapped session client
 *   - `roleFunctionsMap` / `roleGraphMap` / `roleMap` = derived from the
 *     resolved roles (roleFunctionsMap / roleGraphMap are the module-scope
 *     maps shared with pi-extension.ts)
 *   - `dir`                = process.cwd() on Pi
 *   - `dispatchManager` / `loopManager` = the live Pi instances
 *   - `customHooks`        = CustomHookRegistry populated from each role's
 *     `config.hooks.custom` declarations (hook-service.ts:92-100 pattern)
 *   - `notificationManager` = the S3-wired Pi NotificationManager
 *   - `builtInHooks`       = omitted (the recovery/built-in engine is
 *     opencode-only)
 *
 * The three persistent stores (graphSessionState, functionRuntime,
 * sessionSignalLedger) are pointed at `dir` and recovered exactly as
 * hook-service.ts:59-66 does, so function/graph/signal state survives
 * restarts on the Pi platform.
 *
 * Because the pipeline subscribes with `PiEventBridge.on()` (a general
 * handler), it receives every emitted canonical event — including the
 * synthetic `session.status` events produced by wirePiSessionStatusEvents and
 * the adapter's `session.idle`/`session.status` emissions. The five ad-hoc
 * dispatchManager bridge handlers previously wired in pi-extension.ts
 * (session.idle/status/error/deleted/message.updated) are therefore removed:
 * `handleEvent` is the single dispatch path, preventing double-handling.
 *
 * @module
 */

import { CustomHookRegistry } from "../../../hooks/custom/registry.ts";
import { HookState } from "../../../hooks/state.ts";
import { handleEvent } from "../../../hooks/event-handler.ts";
import type { HookDeps } from "../../../hooks/deps.ts";
import { functionRuntime } from "../../../function/runtime-state.ts";
import { graphSessionState } from "../../../graph/collaboration-state.ts";
import { sessionSignalLedger } from "../../../signal/session-signal-ledger.ts";
import { createSubLogger } from "../../../logger.ts";
import type { CanonicalEvent } from "../../../platform/types.ts";
import type { ISessionClient } from "../../../platform/ports/session-client.ts";
import type { DispatchManager } from "../../../dispatch/core/manager.ts";
import type { LoopCoordinator } from "../../../loop/coordinator.ts";
import type { NotificationManager } from "../../../notifications/manager.ts";
import type {
  ResolvedFunction,
  ResolvedGraph,
  ResolvedRole,
} from "../../../types.ts";
import type { PiEventBridge } from "./event-bridge.ts";

const log = createSubLogger("pi-hook-pipeline");

// ── Options / result interfaces ─────────────────────────────────────────────

export interface PiHookPipelineOptions {
  /** Canonical bridge whose emitted events route into handleEvent. */
  eventBridge: PiEventBridge;
  /** Session client — the Pi notification-wrapped process adapter. */
  session: ISessionClient;
  /** Resolved roles (source of roleFunctionsMap/roleGraphMap/roleMap and custom hooks). */
  resolvedRoles: ResolvedRole[];
  /** Shared role → functions map (the module-scope map from pi-extension.ts). */
  roleFunctionsMap: Map<string, ResolvedFunction[]>;
  /** Shared role → collaboration graph map (module-scope from pi-extension.ts). */
  roleGraphMap: Map<string, ResolvedGraph>;
  /** Live DispatchManager (completion pipeline). */
  dispatchManager: DispatchManager;
  /** Live LoopCoordinator (loop phase suppression for continuations). */
  loopManager: LoopCoordinator;
  /** S3-wired Pi NotificationManager, if notifications are enabled. */
  notificationManager?: NotificationManager;
  /**
   * The shared GraphToolSet in-flight query surface (subtask 2) — the SAME
   * instance backing the `graph_*` tools (exposed by
   * `PiLightweightServiceStack.getGraphToolSet()`). Lets the auto-continue
   * path ask whether the invoking session still owns executing graphs before
   * continuing (same registry as graph_run). Optional for backward
   * compatibility — absent when the stack was built without a dispatch
   * manager (no graph tools either).
   */
  graphTools?: HookDeps["graphTools"];
  /** State persistence directory (process.cwd() on Pi). */
  dir: string;
}

export interface PiHookPipeline {
  /** The assembled dependency object consumed by the event handlers. */
  deps: HookDeps;
  /** Hook-owned session state (pendingCorrections, sessionAgentRegistry, …). */
  state: HookState;
  /**
   * Route a single canonical event through the full pipeline. This is what
   * the bridge subscription invokes; also exposed for direct callers/tests.
   */
  handleEvent: (event: CanonicalEvent) => Promise<void>;
  /** Remove the bridge subscription (call during shutdown). */
  unsubscribe: () => void;
  /** Dispose the custom-hook registry (call during shutdown). */
  dispose: () => Promise<void>;
}

// ── Pipeline construction ───────────────────────────────────────────────────

/**
 * Build the Pi hook pipeline: wire persistent stores + recovery, assemble the
 * full HookDeps, populate the custom-hook registry, and subscribe the event
 * bridge so every emitted canonical event flows through handleEvent.
 */
export async function createPiHookPipeline(
  options: PiHookPipelineOptions,
): Promise<PiHookPipeline> {
  const {
    eventBridge,
    session,
    resolvedRoles,
    roleFunctionsMap,
    roleGraphMap,
    dispatchManager,
    loopManager,
    notificationManager,
    graphTools,
    dir,
  } = options;

  // ── Persistent store wiring + recovery (hook-service.ts:59-66) ────────
  if (dir) {
    graphSessionState.setStoreDirectory(dir);
    functionRuntime.setStoreDirectory(dir);
    sessionSignalLedger.setStoreDirectory(dir);
  }
  graphSessionState.recover((_sessionID, agentId) => roleGraphMap.get(agentId));
  functionRuntime.recover();
  sessionSignalLedger.recover();

  // ── Hook state (per-pipeline instance; auto-activate/locked parity) ────
  const state = new HookState();
  for (const resolved of resolvedRoles) {
    if (resolved.config.auto_activate?.length) {
      state.roleAutoActivateMap.set(resolved.id, resolved.config.auto_activate);
    }
    if (resolved.locked !== undefined) {
      state.roleLockedMap.set(resolved.id, resolved.locked);
    }
  }

  // ── Custom hook registry (hook-service.ts:79-100 pattern) ─────────────
  const customHooks = new CustomHookRegistry();
  customHooks.setDeps({
    pendingCorrections: state.pendingCorrections,
    functionRuntime,
    dispatchManager,
    graphSessionState,
  });
  for (const role of resolvedRoles) {
    const hookConfigs = role.config.hooks?.custom;
    if (hookConfigs && hookConfigs.length > 0) {
      for (const hook of hookConfigs) {
        await customHooks.register(hook, dir);
        log.debug("Registered custom hook for role", {
          role: role.id,
          hook: hook.name,
        });
      }
    }
  }

  // ── roleMap ────────────────────────────────────────────────────────────
  const roleMap = new Map(resolvedRoles.map((r) => [r.id, r]));

  // ── HookDeps (builtInHooks intentionally omitted on Pi) ────────────────
  const deps: HookDeps = {
    session,
    roleFunctionsMap,
    roleGraphMap,
    roleMap,
    dir,
    dispatchManager,
    loopManager,
    customHooks,
    notificationManager,
    // Subtask 2: the shared GraphToolSet query surface (same instance backing
    // the graph_* tools). Absent → auto-continue treats graph in-flight as
    // unknown (backward compatible).
    graphTools,
  };
  log.debug("Pi HookDeps assembled", { graphTools: Boolean(deps.graphTools) });

  // ── Route PiEventBridge.emit → handleEvent ─────────────────────────────
  const handler = async (event: CanonicalEvent): Promise<void> => {
    try {
      await handleEvent(event, state, deps);
    } catch (err) {
      log.warn("Pi hook pipeline event handler failed", {
        type: event.type,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };
  const unsubscribe = eventBridge.on(handler);

  return {
    deps,
    state,
    handleEvent: handler,
    unsubscribe,
    dispose: async () => {
      unsubscribe();
      try {
        await customHooks.dispose();
      } catch {
        // best effort — never throw during teardown
      }
    },
  };
}
