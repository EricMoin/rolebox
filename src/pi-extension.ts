/**
 * Pi Extension Entry Point — `src/pi-extension.ts`
 *
 * This file is the entry point for Pi's extension system. Pi loads it as a
 * TypeScript module (via jiti) and calls the default export with its
 * ExtensionAPI object.
 *
 * It initializes rolebox on the Pi platform by: discovering roles, resolving
 * them, creating platform adapters, syncing agents in-memory, wiring events,
 * injecting agent context, surfacing skill resources, and wiring dispatch
 * and loop tools for multi-round iteration and background task execution.
 *
 * @module
 */

import { dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { PiLightweightServiceStack } from "./platform/adapters/pi/service-stack.ts";
import { PiEventBridge } from "./platform/adapters/pi/event-bridge.ts";
import { PiAgentRegistrar } from "./platform/adapters/pi/agent-registrar.ts";
import { createPiHookPipeline } from "./platform/adapters/pi/hook-pipeline.ts";
import { runPiSystemTransform } from "./platform/adapters/pi/system-transform.ts";
import { wirePiChatActivation } from "./platform/adapters/pi/chat-activation.ts";
import { wireRoleSwitcher } from "./platform/adapters/pi/role-switcher.ts";
import { createActiveAgentRef } from "./platform/adapters/pi/active-agent.ts";
import { piCapabilities } from "./platform/capabilities.ts";
import { createSubLogger, formatError } from "./logger.ts";
import type {
  ResolvedFunction,
  ResolvedGraph,
  ResolvedRole,
  ResolvedSkill,
  ResolvedSubAgent,
} from "./types.ts";
import { NotificationManager } from "./notifications/manager.ts";
import type { NotificationConfig } from "./notifications/types.ts";
import {
  DEFAULT_NOTIFICATION_CONFIG,
  parseNotificationConfig,
  resolveEnvVarsInConfig,
} from "./notifications/config.ts";
import type { ISessionClient } from "./platform/ports/session-client.ts";
import { PiProcessSessionAdapter } from "./platform/adapters/pi/process-session.ts";
import { PiNotificationSessionClient } from "./platform/adapters/pi/notification-session.ts";
import { DispatchAdapter } from "./loop/dispatch-adapter.ts";
import { LoopCoordinator } from "./loop/coordinator.ts";
import { LoopStore } from "./loop/loop-store.ts";
import { createDispatchTools } from "./dispatch/tools.ts";
import { createLoopTools } from "./loop/loop-tools.ts";
import { createTaskTools } from "./dispatch/query/task-tools.ts";
import { createMemoryUpdateTool } from "./memory/tools.ts";
import { createFunctionGraphTool } from "./function/function-graph.ts";
import { createSkillComposeTool } from "./asset/skill-compose.ts";
import { createContextAssembleTool } from "./dispatch/query/context-assemble.ts";
import {
  createDispatchManager,
  buildSubagentLineage,
} from "./dispatch/factory.ts";
import {
  loadNotifyDedup,
  persistNotifyDedupSync,
} from "./platform/adapters/pi/sidecar-persister.ts";
import {
  seedSentFinalNotifies,
  getSentFinalNotifies,
} from "./dispatch/notification.ts";
import { resolveRoleboxDirectories, initializeRoleboxRuntime } from "./platform/factory.ts";
import { recoverInterruptedGraphs } from "./graph/engine/engine-startup.ts";
import {
  createAllLspTools,
  LspClientManager,
  LspDocumentManager,
} from "./lsp/index.ts";

// ── Shared state maps ─────────────────────────────────────────────────────

const roleFunctionsMap: Map<string, ResolvedFunction[]> = new Map();
const roleGraphMap: Map<string, ResolvedGraph> = new Map();

// ── Module-level logger ───────────────────────────────────────────────────
//
// Shared by the default export (extension entry point) and the exported
// notification wiring helper below.

const log = createSubLogger("pi-extension");

// ── Notification manager exposure ─────────────────────────────────────────
//
// The Pi-side NotificationManager (constructed by wirePiNotifications) is
// stored here and exposed via getPiNotificationManager() so a later
// hook-pipeline subtask can consume the same instance (handleToolBefore /
// handleChatMessage / dispatch completion hooks feed it).

let piNotificationManager: NotificationManager | undefined;

/**
 * Get the currently wired Pi NotificationManager instance, if any.
 * Returns `undefined` before `wirePiNotifications()` has run.
 */
export function getPiNotificationManager(): NotificationManager | undefined {
  return piNotificationManager;
}

// ── Canonical event property helpers ──────────────────────────────────────
//
// Shared by the PiEventBridge → DispatchManager wiring (in the default
// export) and the PiEventBridge → NotificationManager wiring below.

/** Extract session ID from canonical event properties with fallback chain. */
export function extractSessionId(
  props: Record<string, unknown>,
): string | undefined {
  if (typeof props.sessionID === "string") return props.sessionID;
  if (typeof props.sessionId === "string") return props.sessionId;
  const info = props.info as Record<string, unknown> | undefined;
  if (typeof info?.sessionID === "string") return info.sessionID;
  if (typeof info?.sessionId === "string") return info.sessionId;
  if (typeof info?.id === "string") return info.id;
  return undefined;
}

/**
 * Extract the acting role/agent id from canonical event properties.
 * Used to select the per-role notification config for a session.
 */
export function extractEventAgent(
  props: Record<string, unknown>,
): string | undefined {
  if (typeof props.agent === "string") return props.agent;
  if (typeof props.agentID === "string") return props.agentID;
  if (typeof props.agentId === "string") return props.agentId;
  const info = props.info as Record<string, unknown> | undefined;
  if (typeof info?.agent === "string") return info.agent;
  return undefined;
}

// ── PiEventBridge → NotificationManager wiring ────────────────────────────
//
// Construct the shared NotificationManager and subscribe it to the canonical
// bridge lifecycle events, mirroring the opencode NotificationService
// (src/core/services/notification-service.ts):
//
//   session.idle      → manager.scheduleIdle(sid, agent)
//   session.error     → manager.handleSessionError(sid, agent)
//   session.deleted   → manager.handleSessionDeleted(sid)
//   message.updated   → manager.handleMessageUpdated(sid, agent)
//
// Global config honors ROLEBOX_NOTIFICATIONS_CONFIG (path to a YAML
// notification config file) and ROLEBOX_NOTIFICATIONS_ENABLED (disable
// switch). Per-role configs come from each resolved role's
// `config.notifications` block.

export interface PiNotificationWireOptions {
  eventBridge: PiEventBridge;
  resolvedRoles: ResolvedRole[];
  client: ISessionClient;
  dir: string;
}

export interface PiNotificationWireResult {
  /** The wired NotificationManager instance. */
  manager: NotificationManager;
  /**
   * Remove all bridge subscriptions owned by this wiring. Does NOT dispose
   * the manager — call `manager.dispose()` separately (the extension
   * shutdown handler does both).
   */
  unsubscribe: () => void;
}

export function wirePiNotifications(
  options: PiNotificationWireOptions,
): PiNotificationWireResult {
  const { eventBridge, resolvedRoles, client, dir } = options;

  // ── Global config: env file path + enable/disable toggle ────────────
  let globalNotifConfig: NotificationConfig = {
    ...DEFAULT_NOTIFICATION_CONFIG,
  };
  const notifConfigPath = process.env.ROLEBOX_NOTIFICATIONS_CONFIG;
  if (notifConfigPath && existsSync(notifConfigPath)) {
    try {
      const raw = readFileSync(notifConfigPath, "utf-8");
      const parsed = loadYaml(raw);
      globalNotifConfig = resolveEnvVarsInConfig(
        parseNotificationConfig(parsed),
      );
    } catch (err) {
      log.warn("Failed to parse notification config file", {
        path: notifConfigPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const enabledFlag = process.env.ROLEBOX_NOTIFICATIONS_ENABLED;
  if (enabledFlag === "false" || enabledFlag === "0") {
    globalNotifConfig = { ...globalNotifConfig, enabled: false };
  }

  // ── Per-role configs from role.yaml `notifications:` blocks ─────────
  const roleNotifConfigs = new Map<string, NotificationConfig>();
  for (const role of resolvedRoles) {
    if (role.config.notifications) {
      const parsed = parseNotificationConfig(role.config.notifications);
      roleNotifConfigs.set(role.id, resolveEnvVarsInConfig(parsed));
    }
  }

  const manager = new NotificationManager({
    globalConfig: globalNotifConfig,
    roleConfigs: roleNotifConfigs,
    client,
    dir,
  });
  piNotificationManager = manager;

  const unsubs: Array<() => void> = [
    eventBridge.onType("session.idle", (event) => {
      try {
        const sid = extractSessionId(event.properties);
        if (sid) manager.scheduleIdle(sid, extractEventAgent(event.properties));
      } catch (err) {
        log.debug("notif:session.idle handler error", {
          error: formatError(err),
        });
      }
    }),
    eventBridge.onType("session.error", (event) => {
      try {
        const sid = extractSessionId(event.properties);
        if (sid) {
          manager.handleSessionError(sid, extractEventAgent(event.properties));
        }
      } catch (err) {
        log.debug("notif:session.error handler error", {
          error: formatError(err),
        });
      }
    }),
    eventBridge.onType("session.deleted", (event) => {
      try {
        const sid = extractSessionId(event.properties);
        if (sid) manager.handleSessionDeleted(sid);
      } catch (err) {
        log.debug("notif:session.deleted handler error", {
          error: formatError(err),
        });
      }
    }),
    eventBridge.onType("message.updated", (event) => {
      try {
        const sid = extractSessionId(event.properties);
        if (sid) {
          manager.handleMessageUpdated(sid, extractEventAgent(event.properties));
        }
      } catch (err) {
        log.debug("notif:message.updated handler error", {
          error: formatError(err),
        });
      }
    }),
  ];

  return {
    manager,
    unsubscribe: () => {
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch {
          // best effort — never throw during teardown
        }
      }
    },
  };
}

// ── PiEventBridge → session.status synthesis wiring ──────────────────────────
//
// Pi emits no native session "busy/idle" status event, so we synthesize
// canonical session.status events from the lifecycle signals that do exist:
//
//   pi.on("agent_start")   → session.status busy  (a turn is starting)
//   pi.on("agent_settled") → session.status idle  (the turn is terminal)
//   adapter turn_end       → session.status idle  (see process-session.ts
//                            _completeTurn — additive to its session.idle)
//
// The sessionID is resolved from the raw event via extractSessionId()'s
// fallback chain (sessionID / sessionId / info.sessionID / info.sessionId /
// info.id). This wiring ONLY synthesizes — it does NOT route the synthesized
// events to dispatchManager. Routing is owned by the PiHookPipeline (subtask
// S6): its single `eventBridge.on()` subscription feeds every canonical event
// into handleEvent, whose session.status case calls
// dispatchManager.handleSessionStatus. Removing the old bridge subscription
// here is what prevents the completion pipeline's progress-heartbeat path
// (completion-evaluator.ts handleSessionStatus) from being double-handled.

export interface PiStatusWireOptions {
  pi: any;
  eventBridge: PiEventBridge;
  /** Retained for signature compatibility — the pipeline owns routing now. */
  dispatchManager: {
    handleSessionStatus(sessionId: string, statusType: string): Promise<void> | void;
  };
}

export interface PiStatusWireResult {
  /**
   * Remove the bridge subscription owned by this wiring. With the S6
   * pipeline architecture this is a no-op (there is no subscription to
   * remove); the pi.on handlers have no Pi-side unsubscribe API and the
   * synthesis events they emit become inert once the pipeline's bridge
   * subscription is torn down.
   */
  unsubscribe: () => void;
}

export function wirePiSessionStatusEvents(
  options: PiStatusWireOptions,
): PiStatusWireResult {
  const { pi, eventBridge } = options;

  if (typeof pi.on === "function") {
    // pi.on("agent_start") → session.status busy. A turn is starting:
    // the session is actively working (model call, tool execution).
    const onAgentStart = async (event: unknown, _ctx: unknown): Promise<void> => {
      try {
        const canonical = eventBridge.normalize(event);
        const sessionID = extractSessionId(canonical.properties);
        if (!sessionID) return;
        await eventBridge.emit({
          type: "session.status",
          rawType: canonical.rawType,
          properties: { ...canonical.properties, sessionID, status: "busy" },
        });
      } catch (err) {
        log.debug("agent_start status handler error", {
          error: formatError(err),
        });
      }
    };
    pi.on("agent_start", onAgentStart);

    // pi.on("agent_settled") → session.status idle. Fires after the agent
    // finishes with no retry/compaction pending — the turn is terminal.
    const onAgentSettled = async (event: unknown, _ctx: unknown): Promise<void> => {
      try {
        const canonical = eventBridge.normalize(event);
        const sessionID = extractSessionId(canonical.properties);
        if (!sessionID) return;
        await eventBridge.emit({
          type: "session.status",
          rawType: canonical.rawType,
          properties: { ...canonical.properties, sessionID, status: "idle" },
        });
      } catch (err) {
        log.debug("agent_settled status handler error", {
          error: formatError(err),
        });
      }
    };
    pi.on("agent_settled", onAgentSettled);
  }

  return {
    unsubscribe: () => {
      // No bridge subscription to remove — synthesis only. Kept as a no-op
      // so the shutdown path (bridgeUnsubscribers) stays uniform.
    },
  };
}

// ── Pi Extension entry point ──────────────────────────────────────────────

/**
 * Pi Extension entry point.
 *
 * Called by Pi's extension loader with the ExtensionAPI object. Performs
 * one-time initialization at load time: discovers the rolebox directory,
 * resolves all roles into their final compiled form, creates platform
 * adapters, wires Pi events into the canonical event system, injects
 * agent system prompts, and surfaces skill resources.
 *
 * @param pi - Pi ExtensionAPI instance (loosely typed since it is an
 *             optional peer dependency).
 */
export default async function (pi: any): Promise<void> {
  try {
    // ── 1. Resolve directories (delegates to R5's PlatformPaths) ─────────

    const dirs = resolveRoleboxDirectories({
      platformId: "opencode",
    });

    log.info("Pi extension starting", {
      roleboxDir: dirs.roleboxDir,
      globalSkillsDir: dirs.globalSkillsDir,
      configDir: dirs.configDir,
    });

    // ── 2. Role discovery & resolution (shared with index.ts) ───────────
    //
    // The registrar is created before bootstrap so syncAllAgents can run
    // inside initializeRoleboxRuntime() as soon as roles are resolved.

    const registrar = new PiAgentRegistrar();

    const { resolvedRoles, discovered, resolved, skipped } =
      await initializeRoleboxRuntime({
        directories: dirs,
        roleFunctionsMap,
        roleGraphMap,
        registrar,
      });

    log.info("Roles resolved", { discovered, resolved, skipped });

    if (resolved === 0) {
      if (discovered > 0) {
        log.warn("All discovered roles failed to resolve — check role.yaml files");
      } else {
        log.info("No roles found — Pi extension has nothing to register");
      }
      return;
    }

    log.info("Agent registry synced");

    // ── 2b. Skill path registration (roles + subagents) ──────────────────
    //
    // Surface every resolved skill directory to Pi's resource discovery
    // so the `resources_discover` handler below can report it. Both
    // role-local skills (`{roleDir}/skills/...`) and global skills
    // (`{globalSkillsDir}/...`) are registered, keyed by the owning agent
    // id (role id, and recursively each subagent id). The registrar's
    // skillPaths map is keyed by agent id, so registering the same
    // directory twice for the same agent is a no-op — getSkillPaths()
    // never contains duplicate entries (de-duplication by construction).

    let skillPathRegistrations = 0;
    const registerAgentSkillPaths = (
      agentId: string,
      skills: ResolvedSkill[],
    ): void => {
      for (const skill of skills) {
        registrar.registerSkillPath(agentId, dirname(skill.filePath));
        skillPathRegistrations++;
      }
    };
    const registerSubagentSkillPaths = (
      subagents: ResolvedSubAgent[],
    ): void => {
      for (const sub of subagents) {
        registerAgentSkillPaths(sub.id, sub.skills);
        registerSubagentSkillPaths(sub.subagents);
      }
    };
    for (const role of resolvedRoles) {
      registerAgentSkillPaths(role.id, role.skills);
      registerSubagentSkillPaths(role.subagents);
    }

    log.info("Skill paths registered", { skillPathRegistrations });

    // ── 3. Create platform adapters ─────────────────────────────────────

    const eventBridge = new PiEventBridge();
    // Pass sessionDir from Pi extension context if available.
    const piSessionDir = (pi as any)?.ctx?.sessionDir ?? (pi as any)?.sessionDir;
    const capabilities = piCapabilities();

    log.info("Platform adapters created", {
      events: "PiEventBridge",
      agents: "PiAgentRegistrar",
      sessionDir: piSessionDir ?? "default",
      capabilities: capabilities.platformId,
    });

    // ── 4. Initialize real dispatch pipeline ──────────────────────────────
    //
    // Create a PiProcessSessionAdapter backed by child process spawning,
    // construct a DispatchManager with real multi-agent orchestration,
    // and wire parent notification through Pi's API when available.

    const sessionAdapter = new PiProcessSessionAdapter(undefined, piSessionDir);
    sessionAdapter.setEventBridge(eventBridge);

    // Recover orphaned Pi sessions from sidecar files.
    const recoveredSessions = await sessionAdapter.recoverOrphanedSessions();
    if (recoveredSessions > 0) {
      log.info("Recovered orphaned Pi sessions", { count: recoveredSessions });
    }

    // Build subagent maps from shared factory.
    const { resolvedSubagents, subagentModelKey } =
      buildSubagentLineage(resolvedRoles);

    // Pi-specific: register agent configs on the process adapter.
    //
    // Child model strings come from role.yaml (`provider/model-id`). pi
    // 0.81.1 rejects ids whose provider is not in ITS model catalog
    // (verified live: `Error: Model "hfai-dev/deepseek-v4-pro-dev0" not
    // found`, exit 1, zero stdout events) — such a child previously
    // produced an empty dispatch result and a completion gate that never
    // fired. Resolve each id against pi's model registry first and fall
    // back to the host session's currently active model, which is by
    // construction a spawn-resolvable id.
    function resolveChildModel(raw: string): string {
      try {
        const slash = raw.indexOf("/");
        const ctx = (pi as any)?.ctx;
        if (slash > 0 && slash < raw.length - 1) {
          const provider = raw.slice(0, slash);
          const id = raw.slice(slash + 1);
          const found = ctx?.modelRegistry?.find?.(provider, id);
          if (found) return raw; // resolvable as configured — keep it.
        } else if (raw === "default") {
          // `--model default` is also rejected by pi 0.81.1 ("Model
          // \"default\" not found") — never pass it to a child.
        } else {
          return raw; // Non-provider-prefixed non-default id — pass through.
        }
        // Fall back to the host session's active model id.
        const host = ctx?.model;
        const hostId =
          typeof host === "string" ? host : (host?.id ?? host?.modelID);
        if (typeof hostId === "string" && hostId.length > 0) {
          log.debug("Child model not in pi registry — using host model", {
            configured: raw,
            host: hostId,
          });
          return hostId;
        }
      } catch (err) {
        log.debug("Child model resolution failed — passing through as-is", {
          model: raw,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return raw;
    }

    function registerPiAgentConfigs(
      subagents: ResolvedSubAgent[],
      parentModel: string | undefined,
    ): void {
      for (const sub of subagents) {
        const model = sub.config.model ?? parentModel;
        const key = model ? resolveChildModel(model) : resolveChildModel("default");
        sessionAdapter.registerAgentConfig(sub.id, {
          model: key,
          tools: [],
          systemPrompt: sub.prompt,
        });
        if (sub.subagents.length > 0) {
          registerPiAgentConfigs(sub.subagents, model);
        }
      }
    }
    for (const role of resolvedRoles) {
      registerPiAgentConfigs(role.subagents, role.config.model);
    }

    log.info("Subagent lineage registered", {
      subagents: resolvedSubagents.size,
    });

    // Wrap sessionAdapter to support parent notification via pi.sendUserMessage.
    const notifyClient = new PiNotificationSessionClient(sessionAdapter, pi, log, eventBridge);

    // Seed notification dedup from persistent storage to prevent duplicates after restart.
    const dedup = loadNotifyDedup();
    if (dedup.size > 0) {
      seedSentFinalNotifies(dedup);
      log.debug("Loaded notification dedup from disk", { count: dedup.size });
    }

    /** Event bridge subscription cleanup functions. Populated after dispatch. */
    const bridgeUnsubscribers: Array<() => void> = [];

    // ── Loop subsystem references (assigned after dispatchManager init) ──
    let loopCoordinator!: LoopCoordinator;
    let loopStore!: LoopStore;

    // ── LSP manager references (subtask S10, assigned before extraTools) ──
    let lspClientManager!: LspClientManager;
    let lspDocManager!: LspDocumentManager;

    // ── Hook pipeline reference (assigned after the notification wiring) ──
    let piHookPipeline: Awaited<ReturnType<typeof createPiHookPipeline>> | undefined;

    // ── Shutdown hooks ──────────────────────────────────────────────────
    //
    // Register process-level handlers to clean up child processes and
    // persist notification dedup on exit/SIGINT/SIGTERM.
    const shutdownHandler = (): void => {
      log.debug("Pi extension shutdown — persisting notification dedup");
      persistNotifyDedupSync(getSentFinalNotifies());
      for (const unsub of bridgeUnsubscribers) unsub();
      // Dispose the custom-hook registry owned by the hook pipeline (fires
      // onDispose lifecycle hooks best-effort).
      void piHookPipeline?.dispose();
      // Dispose the NotificationManager: scheduler idle timers and throttle
      // prune interval are cleared synchronously at the start of dispose(),
      // then cached channels are released. Safe to call on shutdown paths.
      void getPiNotificationManager()?.dispose();
      // Dispose the LSP managers (subtask S10): close every open document
      // (didClose notifications), then shut down all language-server child
      // processes. Mirrors LspService.dispose() — best-effort, never throw
      // during teardown.
      if (lspClientManager && lspDocManager) {
        try {
          lspDocManager.closeAll(lspClientManager);
        } catch {
          // best effort — never throw during teardown
        }
        void lspClientManager.shutdownAll().catch(() => {
          // best effort — never throw during teardown
        });
      }
      // Persist loop state synchronously and dispose coordinator.
      if (loopCoordinator) {
        loopCoordinator.dispose();
      }
      if (loopStore) {
        loopStore.saveSync(loopCoordinator?.getAllLoopStates() ?? new Map());
        loopStore.dispose();
      }
    };

    process.once("SIGINT", () => {
      shutdownHandler();
      process.exit(130);
    });
    process.once("SIGTERM", () => {
      shutdownHandler();
      process.exit(143);
    });
    process.on("exit", shutdownHandler);

    // Construct DispatchManager via shared factory.
    const result = await createDispatchManager({
      sessionClient: notifyClient,
      resolvedRoles,
      storeDirectory: dirs.configDir,
    });
    const dispatchManager = result.manager;

    if (result.recoverError) {
      throw result.recoverError;
    }

    log.info("Dispatch manager initialized", {
      maxConcurrent: dispatchManager.getConfig().maxConcurrent,
      subagentKeys: subagentModelKey.size,
    });

    // ── Loop subsystem ──────────────────────────────────────────────────
    //
    // Create the loop coordinator, store, and dispatch adapter. Recover any
    // persisted loop state from disk and reconcile it against dispatch task
    // status to resume interrupted loops after a restart.

    loopStore = new LoopStore(dirs.configDir);
    const loopDispatchAdapter = new DispatchAdapter(
      dispatchManager,
      notifyClient,
      process.cwd(),
    );
    loopCoordinator = new LoopCoordinator(loopDispatchAdapter, {
      delayMs: 2000,
      persist: (loops) => {
        void loopStore.save(loops);
      },
    });

    // Recovery: load persisted loops, reconcile against dispatch task state,
    // restore into coordinator, and re-subscribe terminated listeners.
    const loadedLoops = loopStore.load();
    let reconciledCount = 0;
    if (loadedLoops && loadedLoops.size > 0) {
      const reconciled = await loopStore.reconcile(loadedLoops, async (taskId) => {
        const task = dispatchManager.getTask(taskId);
        return {
          status: task?.status ?? "unknown",
          exists: task !== undefined,
        };
      });
      for (const [id, state] of reconciled) {
        loopCoordinator.restoreState(state);
      }
      reconciledCount = reconciled.size;
      await loopCoordinator.reSubscribeListeners();
      log.info("Loop state recovered", {
        loaded: loadedLoops.size,
        restored: reconciledCount,
      });
    }

        log.info("Loop coordinator initialized");
    log.debug("Loop coordinator details", {
      delayMs: 2000,
      loadedLoops: loadedLoops?.size ?? 0,
      reconciledLoops: reconciledCount,
      activeLocks: loopCoordinator.getAdvancingLockState().activeLocks,
    });

    // ── Graph engine startup recovery ─────────────────────────────────────
    //
    // Resume any graph engine (`.rolebox/state/engine-*.json`) left
    // mid-execution by a crash. Mirrors the loop recovery above: scan the
    // store, skip already-`complete` graphs, and `recover()` the rest. A
    // single bad engine file is isolated per-graph and logged — it can never
    // block plugin startup (engine-startup.ts guarantees the sweep never
    // throws).
    //
    // Opt-out: `ROLEBOX_ENGINE_RECOVERY=off|0|false` disables the sweep.
    const graphRecoveryValue = (process.env.ROLEBOX_ENGINE_RECOVERY ?? "").trim().toLowerCase();
    const graphRecoveryEnabled =
      graphRecoveryValue !== "off" &&
      graphRecoveryValue !== "0" &&
      graphRecoveryValue !== "false";
    const graphRecoveryReport = await recoverInterruptedGraphs({
      // The engine persists under `{workspace}/.rolebox/state`, so the scan
      // root is the workspace the plugin runs in (the same `process.cwd()`
      // the loop dispatch adapter above uses for its own state store).
      directory: process.cwd(),
      manager: dispatchManager,
      stateDir: process.cwd(),
      enabled: graphRecoveryEnabled,
    });
    if (graphRecoveryReport.recovered > 0 || graphRecoveryReport.failed.length > 0) {
      log.info("Interrupted graph engines recovered", {
        enabled: graphRecoveryEnabled,
        scanned: graphRecoveryReport.scanned,
        recovered: graphRecoveryReport.recovered,
        failed: graphRecoveryReport.failed.length,
      });
    }


    // ── session.status synthesis ────────────────────────────────────────
    //
    // Synthetic busy/idle status events mapped from pi.on("agent_start") /
    // pi.on("agent_settled") and the adapter's turn_end emission. This
    // wiring only SYNTHESIZES canonical session.status events into the
    // bridge — the routing to dispatchManager.handleSessionStatus is owned
    // by the PiHookPipeline below (S6), whose session.status case keeps the
    // completion pipeline's progress-heartbeat path alive on Pi.
    const statusWiring = wirePiSessionStatusEvents({
      pi,
      eventBridge,
      dispatchManager,
    });
    bridgeUnsubscribers.push(statusWiring.unsubscribe);

    // session.deleted (loop) — clean up worker-to-origin mappings when a
    // session is deleted. Loop teardown is NOT part of handleEvent (the
    // pipeline's session.deleted case handles dispatch + notifications
    // only), so this subscription stays.
    bridgeUnsubscribers.push(
      eventBridge.onType("session.deleted", async (event) => {
        try {
          const info = event.properties.info as { id?: string } | undefined;
          const did = info?.id ?? extractSessionId(event.properties);
          if (did) {
            await loopCoordinator.cancelNow(did);
            log.debug("bridge:session.deleted (loop): cancelled loop", { sessionId: did });
          }
        } catch (err) {
          log.debug("bridge:session.deleted loop handler error", { error: formatError(err) });
        }
      }),
    );

    // ── PiEventBridge → NotificationManager wiring ─────────────────────
    //
    // Construct the shared NotificationManager (config resolution from
    // ROLEBOX_NOTIFICATIONS_CONFIG / ROLEBOX_NOTIFICATIONS_ENABLED and each
    // role's `notifications:` block) and subscribe it to the canonical
    // session lifecycle events. The instance is exposed via
    // getPiNotificationManager() and consumed by the hook pipeline below;
    // the bridge subscriptions are torn down by the shutdown handler
    // through bridgeUnsubscribers, and the manager itself is disposed there
    // too. (Its per-event subscriptions coexist with the pipeline's
    // notificationManager calls — the scheduler/throttle guards make the
    // redundant path a no-op, exactly like opencode's notification-service.)

    const notifWiring = wirePiNotifications({
      eventBridge,
      resolvedRoles,
      client: notifyClient,
      dir: process.cwd(),
    });
    bridgeUnsubscribers.push(notifWiring.unsubscribe);

    log.info("NotificationManager wired", {
      subscriptions: 4, // session.idle / session.error / session.deleted / message.updated
    });

    // ── PiHookPipeline — single handleEvent dispatch (subtask S6) ──────
    //
    // Replaces the five ad-hoc dispatchManager bridge handlers
    // (session.idle / session.status / session.error / session.deleted /
    // message.updated) that previously routed Pi lifecycle events straight
    // to dispatchManager. The pipeline assembles the full HookDeps (session
    // = notifyClient, role maps from resolvedRoles, dir = process.cwd(),
    // the live dispatchManager + LoopCoordinator, a CustomHookRegistry
    // populated from each role's `hooks.custom`, and the S3-wired
    // NotificationManager) and subscribes a single general handler that
    // funnels every canonical event through handleEvent
    // (src/hooks/event-handler.ts). handleEvent itself dispatches to
    // dispatchManager AND the notification manager, so keeping the old
    // handlers would double-handle every lifecycle event. It also wires the
    // functionRuntime / graphSessionState / sessionSignalLedger stores to
    // process.cwd() and recovers them (hook-service.ts:59-66 pattern).

    const hookPipeline = await createPiHookPipeline({
      eventBridge,
      session: notifyClient,
      resolvedRoles,
      roleFunctionsMap,
      roleGraphMap,
      dispatchManager,
      loopManager: loopCoordinator,
      notificationManager: getPiNotificationManager(),
      dir: process.cwd(),
    });
    piHookPipeline = hookPipeline;
    bridgeUnsubscribers.push(hookPipeline.unsubscribe);

    log.info("PiHookPipeline wired — single handleEvent dispatch", {
      subscriptions: bridgeUnsubscribers.length,
    });

    // ── 5. Tool registration via PiLightweightServiceStack ──────────────
    //
    // Build real dispatch CanonicalToolDefs and pass them to the service
    // stack instead of stub tools. All other tools (standalone, session,
    // asset) are built as before.

    // ── Active-agent ref (Pi "current agent" bridge) ──────────────────────
    //
    // Pi never populates `context.agent` on tool contexts. This shared ref is
    // the single source of truth for "which rolebox agent is acting", read by
    // the dispatch tool's direct-child gate and written by the role switcher.
    // In a spawned subagent process it is seeded from ROLEBOX_ACTIVE_AGENT so
    // nested dispatch can reach that subagent's own children.
    const seededAgent = process.env.ROLEBOX_ACTIVE_AGENT?.trim() || null;
    const activeAgent = createActiveAgentRef(seededAgent);
    if (seededAgent) {
      log.info("Seeded active agent from environment", { agent: seededAgent });
    }

    // ── 4b. Pi chat-message activation wiring (subtask S8) ───────────────
    //
    // Detect user messages on Pi — pi.on("message_start") events whose
    // message.role === "user", or the last JSONL user message of the
    // invoking session as a restore fallback — and run the shared opencode
    // handleChatMessage pipeline against them using the S6 hook pipeline's
    // state + deps, so function activation (|fn| parsing, auto-activation,
    // wake-event unblocking, session-agent registry) works on Pi exactly
    // like the opencode chat.message hook. Synthetic injections are skipped
    // exactly as chat-message.ts:26-29 (the shared pipeline applies the
    // predicate on live events; the JSONL replay path applies it here).
    const chatActivation = wirePiChatActivation({
      pi,
      state: hookPipeline.state,
      deps: hookPipeline.deps,
      activeAgent,
    });
    bridgeUnsubscribers.push(chatActivation.unsubscribe);

    log.info("Pi chat activation wired — message_start → handleChatMessage");

    // ── 5. Tool registration via PiLightweightServiceStack ──────────────
    //
    // Subtask 5: pass the REAL restored dispatch_*/loop_*/task_* tool sets
    // (from the shared factories) instead of empty {} so pi.registerTool
    // registers the live tools rather than Pi stub fallbacks. Each factory
    // delegates to the live DispatchManager/LoopCoordinator and reads the
    // platform active-agent ref as the context.agent fallback, since Pi
    // never populates context.agent on tool contexts.
    //
    // Degradation: PiLightweightServiceStack.init() guards each override
    // with `.length > 0` — if a factory returned empty, the built-in stub
    // dispatch tools still register (dispatch only), and loop/task are
    // simply omitted.
    //
    // graph_* tools are NOT registered by a separate tool-assembly layer:
    // buildCanonicalTools only assembles them when a dispatchManager is
    // threaded into this stack. The construction below passes the live
    // dispatchManager (gates the eight graph_* tools), notifyClient as the
    // graph-notify session client (emperor/orchestrator notifications), and
    // process.cwd() as the engine-state stateDir (`.rolebox/state`).

    // dispatch_*/loop_* tool registration DISABLED — orchestration is
    // graph-only (graph_* tools). Bare dispatch/loop calls would bypass the
    // graph engine's budget accounting, approval gates, and loop caps.
    // The DispatchManager/LoopCoordinator remain live for internal engine use.
    // const dispatchTools = createDispatchTools(
    //   dispatchManager,
    //   resolvedSubagents,
    //   subagentModelKey,
    //   () => activeAgent.get() ?? "",
    // );
    // const loopTools = createLoopTools(loopCoordinator, notifyClient, {
    //   fallbackAgent: () => activeAgent.get() ?? "primary",
    // });
    // task_retry withheld: re-dispatches outside the graph engine.
    const { task_retry: _omittedTaskRetry, ...taskTools } = createTaskTools(dispatchManager, process.cwd());

    // ── extraTools: opencode-side extras adapted for Pi ────────────────────
    //
    // Mirrors the opencode wiring at src/core/services/tool-service.ts:91-106,
    // forwarding every tool that makes sense on Pi (asset_hot_reload remains
    // opencode-only and intentionally omitted). The full lsp_* surface
    // (subtask S10) rides the same channel: Pi constructs the two
    // platform-agnostic LSP managers directly — LspClientManager(process.cwd())
    // + LspDocumentManager, exactly as LspService.init() does — rather than
    // running LspService itself (which needs a PluginCore that Pi cannot
    // execute). Merged by PiLightweightServiceStack.init() into
    // buildCanonicalTools({ extraTools }).
    lspClientManager = new LspClientManager(process.cwd());
    lspDocManager = new LspDocumentManager();

    const extraTools = {
      memory_update: createMemoryUpdateTool(),
      function_graph: createFunctionGraphTool(resolvedRoles),
      skill_compose: createSkillComposeTool(resolvedRoles),
      context_assemble: createContextAssembleTool({
        dispatchManager,
        sessionClient: notifyClient,
        resolvedRoles,
        directory: process.cwd(),
      }),
      // LSP tools: the same 30+ tool surface opencode exposes via
      // LspService.getTools() (lsp_diagnostics / lsp_hover /
      // lsp_find_references / lsp_rename / lsp_servers, …).
      ...createAllLspTools(lspClientManager, lspDocManager),
    };

    const serviceStack = new PiLightweightServiceStack(
      pi,
      resolvedRoles,
      piSessionDir,
      undefined, // dispatchTools disabled (graph-only orchestration)
      undefined, // loopTools disabled (graph_add_loop replaces loop_*)
      taskTools,
      extraTools,
      // Subtask 3: thread the live graph runtime into the stack. The
      // dispatchManager gates registration of the eight graph_* tools inside
      // buildCanonicalTools; notifyClient supplies the graph-notify session
      // client for emperor/orchestrator completion notifications; stateDir
      // (process.cwd()) persists engine state under `.rolebox/state`.
      dispatchManager,
      notifyClient,
      process.cwd(),
      // Subtask 9 (tool-execution interceptor): thread the S6 hook pipeline's
      // state + deps into the stack so every Pi tool execute runs the shared
      // handleToolBefore pipeline — strict zod validation, deprecated-tool
      // warnings, custom-hook before/after phases, and correction injection
      // into the same pendingCorrections the system-transform reads.
      { state: hookPipeline.state, deps: hookPipeline.deps },
    );
    await serviceStack.init();

    // ── 6. Event wiring ─────────────────────────────────────────────────
    //
    // Subscribe to Pi's lifecycle events and forward them through the
    // canonical event bridge. Every subscription is wrapped in a try/catch
    // to avoid crashing the Pi runtime if eventBridge.emit() fails.

    /** Wrap a Pi event handler so errors are logged but never thrown to Pi. */
    function wireEvent(piEventName: string): void {
      if (typeof pi.on !== "function") return;
      pi.on(piEventName, async (event: unknown, _ctx: unknown) => {
        try {
          const canonical = eventBridge.normalize(event);
          await eventBridge.emit(canonical);
        } catch (err) {
          log.debug("Event handler error", {
            event: piEventName,
            error: formatError(err),
          });
        }
      });
    }

    wireEvent("session_start");
    wireEvent("session_shutdown");
    wireEvent("agent_start");
    wireEvent("agent_end");
    wireEvent("tool_call");
    wireEvent("tool_result");
    wireEvent("message_start");
    wireEvent("message_update");
    wireEvent("message_end");

    log.info("Event wiring complete", { events: 9 });

    // ── /stop-loop command ─────────────────────────────────────────────
    //
    // Register a Pi slash command that cancels the active loop for the
    // current session. Uses pi.registerCommand (available since Pi 2.x).
    if (typeof pi.registerCommand === "function") {
      pi.registerCommand("stop-loop", {
        description: "Cancel the active loop for the current session",
        handler: async (_args: string, ctx: any) => {
          try {
            const sessionId = ctx?.sessionManager?.getSessionId?.();
            if (sessionId) {
              await loopCoordinator.cancelNow(sessionId);
              log.info("stop-loop: cancelled loop", { sessionId });
            }
          } catch (err) {
            log.debug("stop-loop handler error", { error: formatError(err) });
          }
        },
      });
      log.info("stop-loop command registered");
    }

    // ── Loop lifecycle Pi event handlers ───────────────────────────────
    //
    // Register Pi lifecycle event hooks that manage the loop coordinator:
    // agent_settled → re-subscribe listeners for completed workers,
    // session_shutdown → cancel active loops and dispose coordinator,
    // before_agent_start → scan for [rolebox:stop-loop] marker.

    if (typeof pi.on === "function") {
      // agent_settled: fires after agent finishes and no retry/compaction
      // is pending. Use this to recover loops whose workers completed
      // while the agent was busy streaming or processing.
      pi.on("agent_settled", async (_event: unknown, _ctx: unknown) => {
        try {
          await loopCoordinator.reSubscribeListeners();
          log.debug("agent_settled: loop listeners re-subscribed");
        } catch (err) {
          log.debug("agent_settled loop handler error", { error: formatError(err) });
        }
      });

      // session_shutdown: fires when the extension runtime is torn down
      // (quit, reload, new session, resume, fork). Cancel any active loop
      // bound to this session, then dispose the coordinator to release
      // all resources.
      pi.on("session_shutdown", async (_event: unknown, ctx: any) => {
        try {
          const sessionId = ctx?.sessionManager?.getSessionId?.();
          if (sessionId) {
            await loopCoordinator.cancelNow(sessionId);
            log.debug("session_shutdown: cancelled loop", { sessionId });
          }
          loopCoordinator.dispose();
        } catch (err) {
          log.debug("session_shutdown loop handler error", { error: formatError(err) });
        }
      });

      // before_agent_start: fires before each LLM call. Scan the system
      // prompt and user prompt for the [rolebox:stop-loop] marker. When
      // found, cancel the active loop for this session.
      pi.on("before_agent_start", async (event: any, ctx: any) => {
        try {
          const marker = "[rolebox:stop-loop]";
          const systemPrompt = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
          const userPrompt = typeof event?.prompt === "string" ? event.prompt : "";
          if (systemPrompt.includes(marker) || userPrompt.includes(marker)) {
            const sessionId = ctx?.sessionManager?.getSessionId?.();
            if (sessionId) {
              await loopCoordinator.cancelNow(sessionId);
              log.info("stop-loop detected via before_agent_start marker", { sessionId });
            }
          }
        } catch (err) {
          log.debug("before_agent_start loop handler error", { error: formatError(err) });
        }
      });

      log.info("Loop lifecycle event handlers wired");
    }

    // ── 7. Agent system prompt injection ────────────────────────────────
    //
    // Before Pi starts an agent, inject a section listing all registered
    // rolebox roles as available agents. This makes the role hierarchy
    // visible to the active agent's system prompt.

    if (typeof pi.on === "function") {
      pi.on("before_agent_start", async (event: any, ctx: unknown) => {
        try {
          const agents = registrar.getRegisteredAgents();
          if (agents.length === 0) return;

          const lines: string[] = [
            "",
            "<available_roles>",
            "The following rolebox agent roles are available for delegation.",
            "Use dispatch() to route work to a specific role.",
            "",
          ];

          for (const agent of agents) {
            const model = agent.model ?? "default";
            lines.push(`- **${agent.name}** (\`${agent.id}\`) — ${agent.description} [model: ${model}]`);
          }

          lines.push("</available_roles>", "");

          // ── Loop tool availability ────────────────────────────────────
          //
          // Tell the agent about the loop tool for multi-round iteration.
          // The loop tool runs rounds in background dispatch sessions;
          // progress is delivered via silent notification markers and
          // the agent can use /stop-loop to cancel an active loop.
          lines.push(
            "<loop_tool>",
            "The `loop_start(iterations, mode, prompt, objective?)` tool runs a task across",
            "multiple sessions. All parameters except `objective` are required:",
            "- `iterations` (1–50, default 5): number of rounds to execute.",
            '- `mode` ("inherit", default): "inherit" shares context; "fresh" starts each round clean.',
            "- `prompt`: the task to execute across every round (required).",
            "- `objective` (optional): convergence criteria for nested loops — when",
            "  the summary declares this done, the loop terminates early.",
            "Register errors (duplicate task, budget exhausted) are returned as corrective",
            "feedback. Track progress with `loop_status`, read output with `loop_output`,",
            "view history with `loop_history`. Use `/stop-loop` to cancel an active loop.",
            "</loop_tool>",
            "",
          );

          const agentSection = lines.join("\n");
          const currentPrompt = typeof event.systemPrompt === "string" ? event.systemPrompt : "";

          // ── S7: opencode system-transform pipeline (Pi adapter) ──────
          //
          // Run the shared handleSystemTransform pipeline (corrections,
          // available_functions, memory, active_functions + gate/transition
          // kernel, artifact consumption, graph-state block) against the Pi
          // event shape, using the S6 hook pipeline's state (so corrections
          // queued by handleChatMessage/tool hooks land in the next prompt)
          // and deps (the shared role maps + custom-hook registry). The
          // static role/loop guidance above is preserved as baseSection —
          // the pipeline appends its blocks AFTER it. If no session id can
          // be resolved (or the transform throws), fall back to the static
          // prompt unchanged.
          let augmentedPrompt: string | undefined;
          if (piHookPipeline) {
            augmentedPrompt = await runPiSystemTransform(
              {
                event,
                ctx: (ctx ?? undefined) as Record<string, unknown> | undefined,
                baseSection: agentSection,
                activeAgent,
              },
              piHookPipeline.state,
              piHookPipeline.deps,
            );
          }

          return {
            systemPrompt: augmentedPrompt ?? currentPrompt + agentSection,
          };
        } catch (err) {
          log.debug("before_agent_start handler error", {
            error: formatError(err),
          });
          return undefined;
        }
      });
    }

    log.info("Agent prompt injection wired");

    // ── 8. Skill path contribution ──────────────────────────────────────
    //
    // Surface rolebox skill directories to Pi's resource discovery system
    // so that Pi knows which skill files to load for each agent.

    if (typeof pi.on === "function") {
      pi.on("resources_discover", async (_event: unknown, _ctx: unknown) => {
        try {
          const skillPaths = registrar.getSkillPaths();
          return { skillPaths };
        } catch (err) {
          log.debug("resources_discover handler error", {
            error: formatError(err),
          });
          return { skillPaths: [] };
        }
      });
    }

    log.info("Skill path contribution wired");

    // ── 8b. In-session role switching (Pi-only capability) ──────────────
    //
    // Pi has no native agent picker. Surface rolebox roles as switchable
    // primary agents via `/role`, a selector, and Ctrl+Shift+R — driven by
    // the AgentDefinition registry. Gated by the `hasRoleSwitch` capability
    // so other platforms (opencode has its own picker) are unaffected.

    if (capabilities.hasRoleSwitch) {
      wireRoleSwitcher({ pi, registrar, activeAgent });
      log.info("Role switcher wired");
    }

    // ── 9. Initialization complete ─────────────────────────────────────

    const agentCount = registrar.getRegisteredAgents().length;
    log.info("Pi extension initialized", {
      rolesResolved: resolved,
      agentsRegistered: agentCount,
      skillPaths: registrar.getSkillPaths().length,
    });
  } catch (err) {
    log.error("Pi extension initialization failed", formatError(err));
    // Re-throw so Pi's extension loader sees the failure.
    throw err;
  }
}
