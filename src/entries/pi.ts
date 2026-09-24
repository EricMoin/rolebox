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

import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { PiLightweightServiceStack } from "../platform/adapters/pi/service-stack.ts";
import { PiEventBridge } from "../platform/adapters/pi/event-bridge.ts";
import type { PiEventType } from "../platform/adapters/pi/event-bridge.ts";
import { PiAgentRegistrar } from "../platform/adapters/pi/agent-registrar.ts";
import { createPiHookPipeline } from "../platform/adapters/pi/hook-pipeline.ts";
import {
  extractPiSessionId,
  runPiSystemTransform,
} from "../platform/adapters/pi/system-transform.ts";
import { wirePiChatActivation } from "../platform/adapters/pi/chat-activation.ts";
import {
  isPiChildProcess,
  resolveChildDispatchStoreDir,
} from "../platform/adapters/pi/child-mode.ts";
import { wireRoleSwitcher } from "../platform/adapters/pi/role-switcher.ts";
import { createActiveAgentRef } from "../platform/adapters/pi/active-agent.ts";
import type { ToolInterceptorHooks } from "../platform/adapters/pi/tool-interceptor.ts";
import type { CanonicalEventType } from "../platform/types.ts";
import { piCapabilities } from "../platform/capabilities.ts";
import { createSubLogger, formatError } from "../logger.ts";
import type {
  ResolvedFunction,
  ResolvedRole,
  ResolvedSkill,
  ResolvedSubAgent,
} from "../types.ts";
import { NotificationManager } from "../notifications/manager.ts";
import type { NotificationConfig } from "../notifications/types.ts";
import {
  DEFAULT_NOTIFICATION_CONFIG,
  parseNotificationConfig,
  resolveEnvVarsInConfig,
} from "../notifications/config.ts";
import type { ISessionClient } from "../platform/ports/session-client.ts";
import { PiProcessSessionAdapter } from "../platform/adapters/pi/process-session.ts";
import { PiNotificationSessionClient } from "../platform/adapters/pi/notification-session.ts";
import { DispatchAdapter } from "../loop/dispatch-adapter.ts";
import { LoopCoordinator } from "../loop/coordinator.ts";
import { LoopStore } from "../loop/loop-store.ts";
import { createDispatchTools } from "../dispatch/tools.ts";
import { createLoopTools } from "../loop/loop-tools.ts";
import { createTaskTools } from "../dispatch/query/task-tools.ts";
import { createMemoryUpdateTool } from "../memory/tools.ts";
import { createFunctionGraphTool } from "../function/function-graph.ts";
import { createSkillComposeTool } from "../asset/skill-compose.ts";
import { createLoadRoleSkillTool } from "../asset/skill-tool.ts";
import { createContextAssembleTool } from "../dispatch/query/context-assemble.ts";
import {
  createDispatchManager,
  buildSubagentLineage,
} from "../dispatch/factory.ts";
import {
  loadNotifyDedup,
  persistNotifyDedupSync,
} from "../platform/adapters/pi/sidecar-persister.ts";
import {
  seedSentFinalNotifies,
  getSentFinalNotifies,
  enqueueNotify,
} from "../dispatch/notification.ts";
import { resolveRoleboxDirectories, initializeRoleboxRuntime } from "../platform/factory.ts";
import {
  createGraphToolSet,
  createOutcomeGraphTools,
} from "../graph/tools/index.ts";
import {
  OutcomeHost,
  WORKER_GRANTED_GRAPH_TOOLS,
  withCancelDelivery,
} from "../graph/host/outcome-host.ts";
import { graphStoreRoot } from "../graph/store/schema.ts";
import { getDataDir } from "../cli/paths.ts";
import { PiOutcomeDelivery } from "../platform/adapters/pi/outcome-dispatch.ts";
import { assembleHostCapabilities } from "../graph/policy/acceptance-primitives.ts";
import {
  COMPLETION_POLICY_AUTHORIZATION_ENV,
  describeCompletionPolicyIssue,
} from "../graph/policy/declarations.ts";
import {
  createAllLspTools,
  LspClientManager,
  LspDocumentManager,
} from "../lsp/index.ts";

// ── Shared state maps ─────────────────────────────────────────────────────

const roleFunctionsMap: Map<string, ResolvedFunction[]> = new Map();

// ── Pi subagent tool allowlist ────────────────────────────────────────────
//
// Deterministic toolset for spawned subagent children. Pi built-ins first,
// then the rolebox gate tools a subagent needs for role/skill resolution,
// memory, LSP, sessions, graph orchestration, and dispatch queries. Spawned
// children get EXACTLY this list — never the full host toolset — so child
// behavior is deterministic regardless of which role/agent spawned it.
// The skill-loading tool is `load_role_skill` (Pi-only; opencode has its own
// native skill tool), NOT `skill`.

export const PI_SUBAGENT_TOOLS: string[] = [
  // pi built-ins
  "read", "bash", "write", "edit", "grep", "find", "ls",
  // rolebox gate tools
  "load_role_skill", "skill_compose", "reference_search",
  "asset_search", "asset_inspect", "asset_validate",
  "hashline_read", "hashline_edit",
  "memory_recall", "memory_list", "memory_write",
  "lsp_diagnostics", "lsp_hover", "lsp_find_references",
  "lsp_goto_definition", "lsp_servers",
  "session_read", "session_list", "session_info",
  "context_assemble",
  "signal",
  // THE WORKER HALF OF THE OUTCOME RUN PATH'S TOOL FACE (A21 / plan §3.3).
  // A spawned child is a WORKER: it settles its own attempt's outcome through
  // graph_submit_outcome and nothing else of the graph face. Declaring or
  // mutating a graph definition (graph_declare), reading the authoritative
  // store (graph_audit / graph_status) belong to the declaring/operating
  // principal — the session that declared the graph, which on Pi is never a
  // spawned child. The list is the SAME grant the host's own tool boundary
  // enforces (src/graph/host/outcome-host.ts), so the face a child is handed
  // and the face its calls are judged by cannot drift. The legacy
  // construction/execution entries are retired and are NOT granted.
  ...WORKER_GRANTED_GRAPH_TOOLS,
  "task_search", "task_budget", "task_graph",
];

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
    pi.on("agent_start" satisfies PiEventType, onAgentStart);

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
    pi.on("agent_settled" satisfies PiEventType, onAgentSettled);
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
      platformId: "pi",
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
    // (verified live: `Error: Model "openrouter-dev/anthropic/claude-haiku-4" not
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
          tools: PI_SUBAGENT_TOOLS,
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
    //
    // storeDirectory MUST be the workspace (process.cwd()), NOT dirs.configDir
    // (the pi home, ~/.pi/agent). The shared dispatch pipeline materializes
    // task results via writeResultSidecar(taskId, fullText, d.directory) and
    // persists checkpoints/progress under the same directory — pointing it at
    // the pi home made `.rolebox/state/results|checkpoints|progress` vanish
    // from the project (only the graph engine's `state/engine-*.json`, which
    // uses process.cwd(), survived). This matches opencode (ctx.directory) and
    // dsh (process.cwd()).
    //
    // Child-process mode (subtask S5): a spawned Pi subagent boots the same
    // entry point and must NOT share the host's `.rolebox/state` — its store
    // is isolated per-pid under `<tmpdir>/rolebox-dispatch/<pid>` via
    // resolveChildDispatchStoreDir, preventing host/child state collision.
    const result = await createDispatchManager({
      sessionClient: notifyClient,
      resolvedRoles,
      storeDirectory: resolveChildDispatchStoreDir(process.pid, isPiChildProcess()),
    });
    const dispatchManager = result.manager;

    // Graceful degradation: recover() failure → log error + use empty state.
    // Mirrors the opencode path (dispatch-service.ts:120-126) so a pre-fix lock
    // EPERM throw (or any recover() failure) no longer aborts Pi initialization.
    if (result.recoverError) {
      log.error("DispatchManager.recover() failed, continuing with empty state", {
        error: result.recoverError.message,
      });
    }

    log.info("Dispatch manager initialized", {
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

    // ── Outcome run path: host layer + boot recovery ───────────────────────
    //
    // A declared graph is dispatched by the host capability layer
    // (`src/graph/host/outcome-host.ts`), never by a legacy engine: the
    // `PiOutcomeDelivery` starts one dispatch-manager task per attempt (the
    // credential travels in that worker's prompt — the one channel it belongs
    // to), and the `OutcomeHost` holds the credential vault, the durable
    // execution index, the invocation identity (D9) and the completion bridge
    // that settles a finished attempt through `settleNatural`. The vault keeps
    // the `durableCredentialStore: "none"` default: no durable artifact holds a
    // credential value, and a crash-window attempt whose value is gone is
    // reported as unsettled rather than re-delivered with an invented one.
    //
    // The store root is a host directory beside the workspace state (workers are
    // not handed its path): see `credential-vault.ts` for what that can and
    // cannot isolate on a same-account platform.
    let outcomeHost: OutcomeHost | undefined;
    const outcomeDelivery = new PiOutcomeDelivery({
      manager: dispatchManager,
      directory: process.cwd(),
      onStartFailed: (_request, effect, reason) => {
        outcomeHost?.reportDeliveryFailure(effect, reason);
      },
      onStarted: (_request, effect, execution) => {
        // The platform named the dispatch task it created: the host records the
        // FACT, which is what lets a restart reconcile the effect instead of
        // reporting it as an unknown create.
        outcomeHost?.confirmExecution(effect, execution);
      },
      onSettled: (settlement) => {
        const { request } = settlement;
        if (settlement.kind === "failed") {
          log.warn("Pi outcome dispatch: attempt did not complete", {
            graphId: request.graphId,
            nodeId: request.nodeId,
            attemptId: request.attemptId,
            reason: settlement.reason,
          });
          return;
        }
        void outcomeHost
          ?.complete(request.graphId, request.attemptId)
          .then((report) => {
            log.debug("Pi outcome completion settled", {
              graphId: request.graphId,
              attemptId: request.attemptId,
              kind: report.kind,
            });
          })
          .catch((err: unknown) => {
            log.warn("Pi outcome completion failed", {
              graphId: request.graphId,
              attemptId: request.attemptId,
              error: formatError(err),
            });
          });
      },
    });
    // TWO DIFFERENT SUBJECTS, TWO DIFFERENT DECISIONS.
    //
    // D9 IS NOT DECLARED. The runtime's dispatch-identity capability binds an
    // attempt to the invocation that ARMED it — the declaring parent. That is
    // attribution: the platform attributes a dispatched worker's own tool call
    // to the WORKER's session (the dispatch task is a separate invocation), so
    // a check against the declaring invocation would refuse exactly the
    // submission the delivery handoff asks the worker to make
    // (host-identity-mismatch), and a parent session is not the worker's
    // identity.
    //
    // THE WORKER BINDING IS DECLARED, because this host CAN substantiate it:
    // the dispatch task carries `sessionId` — the session the sub-agent runs
    // in, which is the session its own tool calls arrive from — and the
    // dispatch manager can answer for the task the platform confirmed. The
    // host therefore answers "the worker of attempt X is child session Y" from
    // its durable execution record plus the platform's own task record, and
    // the submission ingress refuses a call that arrives from any other
    // session. The bearer credential still binds the submission to its
    // attempt: the worker binding is an ADDITIONAL constraint, never a
    // replacement.
    // THE HOST'S OWN STATE ROOT IS NOT THE WORKSPACE. A dispatched worker runs
    // with the workspace as its root, so keeping the store under
    // `<workspace>/.rolebox/state` handed every worker the directory. This is
    // the one path-shaped part of the boundary — `credential-vault.ts` states
    // why it is not isolation by itself and what the vault does NOT put on
    // disk.
    const outcomeStoreRoot = graphStoreRoot(getDataDir(), process.cwd());
    // THE SHIPPED CAPABILITY SET IS BUILT ONCE AND SHARED (P4 items 1, 3, 4).
    //
    // ONE validator registry and ONE completion-policy registry are handed to
    // the HOST (the run path) and to the TOOLSET (graph_declare's compile
    // step), so compile and run resolve against the same source of truth: a
    // plan can only pin a registration this process will look up at acceptance,
    // and a natural mapping can only be authorized by a policy revision this
    // process installed.
    //
    // WHY THE ENVIRONMENT IS THE AUTHORIZATION SURFACE. Completion policies are
    // declarations in reviewed source; the operator who launches the host
    // authorizes exact `id@revision` pairs through
    // `ROLEBOX_GRAPH_COMPLETION_POLICIES` (see
    // `src/graph/policy/declarations.ts`, which documents the JSON document).
    // Nothing in a graph declaration, a workspace file or a worker submission
    // can add an authorization: the loader recomputes each digest from the
    // reviewed or operator-declared body and installs nothing else. With no
    // configuration the registry is EMPTY and a natural mapping that requests
    // an `id@revision` is refused as `completion-policy-unknown` (the id is
    // not installed); `completion-policy-unavailable` names the other two
    // shapes — a natural mapping with no `completion_policy` request at all,
    // or a compile with no policy registry handed to it. Never silently
    // downgraded to explicit.
    //
    // THE TRUSTED COMMAND POLICY, when an operator configures one, is what a
    // `command-exit` acceptance requirement is judged by; it is host
    // configuration keyed by (graph, node, outcome), so a worker can neither
    // author nor select the command.
    const hostCapabilities = assembleHostCapabilities({
      artifactRoot: process.cwd(),
      storeRoot: outcomeStoreRoot,
      env: process.env,
    });
    for (const issue of hostCapabilities.completionPolicyIssues) {
      log.warn("Pi outcome graph: completion-policy configuration", {
        issue: describeCompletionPolicyIssue(issue),
      });
    }
    for (const issue of hostCapabilities.commandPolicyIssues) {
      log.warn("Pi outcome graph: trusted command policy", {
        index: issue.index,
        issue: issue.message,
      });
    }
    log.info("Pi outcome graph capabilities installed", {
      validators: hostCapabilities.validatorIds.join(","),
      commandBindings: hostCapabilities.commandBindings,
      completionPolicies: hostCapabilities.authorizedCompletionPolicies
        .map((ref) => ref.id + "@" + ref.revision)
        .join(","),
      completionPolicyEnv: COMPLETION_POLICY_AUTHORIZATION_ENV,
    });
    const shippedValidators = hostCapabilities.validators;
    outcomeHost = OutcomeHost.open({
      workspaceDir: process.cwd(),
      storeRoot: outcomeStoreRoot,
      deliver: outcomeDelivery.deliver,
      // THE SHIPPED ACCEPTANCE PRIMITIVES (P4 items 2 and 4): schema, artifact,
      // command exit and human approval are installed here, each with a real
      // implementation, and the SAME registry is handed to the toolset below so
      // a declaration is compiled against exactly what the run path can check.
      validators: shippedValidators,
      // Natural completion is authorized by the operator's configuration, and
      // the run path corroborates a plan's pinned revision against the same
      // registry graph_declare compiled with.
      completionPolicies: hostCapabilities.completionPolicies,
      declareInvocationIdentity: false,
      // The platform's own child-session fact, read back from the task the
      // delivery started: `DispatchTask.sessionId` is the session the
      // sub-agent runs in. A task the manager no longer knows (a restart it
      // could not reconcile) answers NOTHING, and the attempt is then unbound
      // and refuses a worker submission rather than accepting one on its
      // credential alone.
      workerSessionOf: (execution) =>
        dispatchManager.getTask(execution.executionId)?.sessionId,
      // THE PLATFORM PORTS (P2 part 2 / F3). The dispatch adapter's own question
      // — "does an execution already exist for this stable effect id, and which
      // one?" — is answered from the manager's own task records by the stable
      // key the create carried as the task description; the boot sweep's
      // terminal read is the task's status (with a completion separated from an
      // end that is not one), and its re-subscribe is
      // `onTaskTerminated`, which fires immediately for a task that is already
      // terminal.
      query: outcomeDelivery.executionQuery,
      observeExecution: outcomeDelivery.observeExecution,
      // THE PLATFORM CANCEL PORT (P3): a trusted cancel command's durable
      // intents are handed to the Pi dispatch manager through it. Only the
      // manager's OWN task record reading `cancelled` is a confirmation; a
      // reported transition without that record is a request, and every other
      // answer leaves the execution visible.
      cancelExecution: outcomeDelivery.cancelExecution,
      watchCompletion: outcomeDelivery.watchCompletion,
    });

    // Boot recovery for DECLARED graphs: a graph interrupted by the previous
    // process is continued from its persisted state, and one that was declared
    // but never started gets its first execution — through the same runtime
    // entry the declaration seam uses. Opt-out: `ROLEBOX_ENGINE_RECOVERY`.
    const graphRecoveryValue = (process.env.ROLEBOX_ENGINE_RECOVERY ?? "").trim().toLowerCase();
    const graphRecoveryEnabled =
      graphRecoveryValue !== "off" &&
      graphRecoveryValue !== "0" &&
      graphRecoveryValue !== "false";
    // The sweep names each graph's RECORDED declaring invocation (the host's
    // own per-graph fact, in memory and on disk). The boot session is
    // deliberately NOT substituted for it: a graph declared by another
    // invocation would then be attributed to whichever session happens to be
    // current, and a dispatch it arms would run under a parent it never had.
    // A graph with no recorded origin re-arms nothing and says so in the
    // report's per-effect refusals.
    if (graphRecoveryEnabled) {
      try {
        const outcomeRecovery = await outcomeHost.recoverDeclaredGraphs();
        if (
          outcomeRecovery.started.length > 0 ||
          outcomeRecovery.resumed.length > 0 ||
          outcomeRecovery.refused.length > 0 ||
          outcomeRecovery.effectRefusals.length > 0 ||
          outcomeRecovery.divergences.length > 0 ||
          // A controlled run is reported in `resumed` too, but it is named here
          // so the gate cannot depend on that staying true (P3 item 1).
          outcomeRecovery.controlled.length > 0 ||
          outcomeRecovery.unconfirmedExecutions.length > 0 ||
          outcomeRecovery.cancellations.length > 0 ||
          outcomeRecovery.cancelBlocked.length > 0
        ) {
          log.info("Declared outcome graphs recovered", {
            started: outcomeRecovery.started,
            resumed: outcomeRecovery.resumed,
            refused: outcomeRecovery.refused,
            // Per-effect facts a visited graph still owes: an effect the resume
            // would not launch, and a row the host's fact contradicted.
            effectRefusals: outcomeRecovery.effectRefusals.map(
              (refusal) => refusal.graphId + ":" + refusal.code,
            ),
            divergences: outcomeRecovery.divergences.map(
              (divergence) =>
                divergence.graphId +
                ":" +
                divergence.effectId +
                ":" +
                divergence.local +
                "->" +
                divergence.host,
            ),
            // WHAT A TRUSTED CONTROL COMMAND STOPPED (P3 item 1): `graph:command`
            // for every run a failure / timeout / cancel ended. The values are
            // computed by the sweep, and logging them here is what keeps a
            // restart from presenting a stopped run as merely `resumed`.
            controlled: outcomeRecovery.controlled,
            // WHAT THE SWEEP'S CANCEL DELIVERIES ESTABLISHED (P3): confirmed /
            // requested / unsupported / blocked, per attempt. Only `confirmed`
            // is the platform's own substantiation; everything else leaves the
            // execution visible and unsettled.
            cancellations: outcomeRecovery.cancellations.map(
              (entry) =>
                entry.graphId + ":" + entry.attemptId + ":" + entry.state,
            ),
            cancelBlocked: outcomeRecovery.cancelBlocked,
            // THE EXTERNAL WORK A STOP LEFT UNCONFIRMED (P3 item 1): every
            // `pending` / `creating` execution behind a controlled run, as
            // `graph:attempt:state`. A `creating` row may name a task the
            // platform really started, so it is REPORTED here rather than
            // hidden; this runs AFTER the cancel deliveries above, so an
            // execution the platform has since confirmed is no longer
            // unconfirmed.
            unconfirmedExecutions: outcomeRecovery.unconfirmedExecutions.map(
              (entry) =>
                entry.graphId + ":" + entry.attemptId + ":" + entry.state,
            ),
          });
        }
        // THE AWAITING INVENTORY IS CONSUMED, NOT JUST PRINTED (F4). Every
        // confirmed execution the sweep is still waiting on is handed back to
        // the platform adapter: Pi re-subscribes through
        // `dispatchManager.onTaskTerminated` — which fires immediately for a
        // task that is already terminal, so an end that happened while nobody
        // was listening is applied through the SAME completion bridge — and any
        // execution the manager cannot name is reported as unwatched rather
        // than silently awaited.
        const watching = await outcomeHost.retainAwaitingCompletions(
          outcomeRecovery.awaitingCompletion,
        );
        if (
          watching.watched.length > 0 ||
          watching.settled.length > 0 ||
          watching.unwatched.length > 0
        ) {
          log.info("Declared outcome graph observation re-established", {
            watched: watching.watched,
            settled: watching.settled,
            unwatched: watching.unwatched.map(
              (entry) =>
                entry.graphId + ":" + entry.attemptId + ":" + entry.executionId,
            ),
          });
        }
      } catch (err) {
        log.warn("Declared outcome graph recovery failed", {
          error: formatError(err),
        });
      }
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
      // load_role_skill is Pi-only (opencode has its own native skill tool).
      load_role_skill: createLoadRoleSkillTool(resolvedRoles),
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

    // ── Active-agent ref (Pi "current agent" bridge) ──────────────────────
    //
    // Pi never populates `context.agent` on tool contexts. This shared ref is
    // the single source of truth for "which rolebox agent is acting", read by
    // the graph tool's getEffectiveAgent resolver (forwarded into the injected
    // `<system-reminder>` so the orchestrator resumes as its real role instead
    // of default_agent) and written by the role switcher. In a spawned subagent
    // process it is seeded from ROLEBOX_ACTIVE_AGENT so nested dispatch can
    // reach that subagent's own children. Created BEFORE the service stack so
    // the graph tool resolver closure can capture it.
    const seededAgent = process.env.ROLEBOX_ACTIVE_AGENT?.trim() || null;
    const activeAgent = createActiveAgentRef(seededAgent);
    if (seededAgent) {
      log.info("Seeded active agent from environment", { agent: seededAgent });
    }

    // Subtask S9: the stack receives a mutable carrier populated with the hook
    // pipeline's state + deps right after the pipeline is built (before init()
    // compiles the tools).
    const interceptorHooks: ToolInterceptorHooks = {};

    // ── The outcome run path's tool face ──────────────────────────────────
    //
    // The Pi entry owns the host layer (constructed above): the toolset is
    // built with the outcome deps and WITHOUT a legacy manager/dispatch seam,
    // and `graph_declare` starts (or resumes) the declared graph through the
    // host's own runtime entry. Only the four declared-graph entries are
    // registered — the legacy construction tools are not assembled.
    const outcomeToolset = createGraphToolSet({
      directory: process.cwd(),
      stateDir: process.cwd(),
      credentialIsolation: outcomeHost.credentialIsolation,
      // THE WORKER-IDENTITY CAPABILITY, not the D9 one: the identity option
      // carries whichever shape the host declared, and this shape names the
      // child session the platform created for the attempt's worker. Without
      // it the session a submission arrives from would not be an
      // authentication factor at all.
      hostIdentity: outcomeHost.workerIdentity,
      outcomeDispatch: outcomeHost.dispatch,
      // THE ONE CAPABILITY SET (P4 item 1): the registry the host installed
      // above. `graph_declare` derives its compile-time set from this, so a
      // caller's supported_validators can only narrow what this process can
      // actually resolve and enforce at acceptance.
      outcomeValidators: shippedValidators,
      // THE CONCRETE capability from the SAME assembly (A22) — see dsh.ts.
      outcomeAcceptanceCapabilities: hostCapabilities.capabilities,
      // The HOST's completion-policy capability, never a tool argument: the
      // same registry the run path corroborates against (D6).
      completionPolicies: hostCapabilities.completionPolicies,
      outcomeArtifactRoot: process.cwd(),
      onGraphDeclared: (graphId, invokingSessionId, agent) => {
        // The declaring invocation is handed to the HOST, which records it per
        // graph and re-supplies it on every dispatch window — the entry attempt
        // here, and every successor a later acceptance arms (a worker's
        // submission, an observed completion, the boot sweep). The delivery seam
        // is stateless about invocations, so no window's end can lose the
        // attribution. The acting-agent fallback the entry already applied is
        // recorded with it, so a restored origin carries the same attribution.
        void outcomeHost
          .startDeclaredGraph(graphId, {
            sessionId: invokingSessionId,
            agent: agent ?? activeAgent.get() ?? "",
          })
          .then((result) => {
            if (result.kind === "refused") {
              log.warn("Pi outcome graph start refused", {
                graphId,
                refusals: result.refusals.map((r) => r.code).join(","),
              });
              return;
            }
            log.info("Pi outcome graph started", {
              graphId,
              kind: result.kind,
              dispatched: result.dispatched.length,
              // The effects this window could NOT launch (and the rows a host
              // fact contradicted) are named, never folded into "started".
              ...(result.refusals.length === 0
                ? {}
                : { refusals: result.refusals.map((r) => r.code).join(",") }),
              ...(result.divergences.length === 0
                ? {}
                : { divergences: result.divergences.length }),
            });
          })
          .catch((err: unknown) => {
            log.warn("Pi outcome graph start failed", {
              graphId,
              error: formatError(err),
            });
          });
      },
    });
    const outcomeGraphTools = outcomeHost.bindTools(
      // THE CANCEL DELIVERY IS WIRED TO THE CONTROL ENTRY (P3). After a
      // `graph_control` call returns — the trusted command is durable by then —
      // the host hands the graph's cancel intents to the platform port above.
      // The wrapper runs INSIDE `bindTools`, so the worker boundary refuses a
      // dispatched child's call before the tool body and before this delivery.
      withCancelDelivery(
        createOutcomeGraphTools(outcomeToolset, {
          getEffectiveAgent: () => activeAgent.get() ?? "",
        }),
        outcomeHost,
      ),
      () => activeAgent.get() ?? "",
    );

    const serviceStack = new PiLightweightServiceStack(
      pi,
      resolvedRoles,
      piSessionDir,
      undefined, // dispatchTools disabled (graph-only orchestration)
      undefined, // loop tools disabled (a loop group is declared inside a graph)
      taskTools,
      extraTools,
      dispatchManager,
      notifyClient,
      process.cwd(),
      interceptorHooks,
      // The OUTCOME run path's tool face (host layer above). Absent → the
      // stack registers no graph tools.
      outcomeGraphTools,
    );

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
    // functionRuntime / sessionSignalLedger stores to
    // process.cwd() and recovers them (hook-service.ts:59-66 pattern).

    const hookPipeline = await createPiHookPipeline({
      eventBridge,
      session: notifyClient,
      resolvedRoles,
      roleFunctionsMap,
      dispatchManager,
      loopManager: loopCoordinator,
      notificationManager: getPiNotificationManager(),
      // Copilot LLM-role verdict source: the subagent lineage built above
      // (line 540) — the configured llm.role must be a key of this map.
      resolvedSubagents,
      dir: process.cwd(),
    });
    piHookPipeline = hookPipeline;
    bridgeUnsubscribers.push(hookPipeline.unsubscribe);

    log.info("PiHookPipeline wired — single handleEvent dispatch", {
      subscriptions: bridgeUnsubscribers.length,
    });

    // Subtask 9: populate the stack's interceptor-hooks carrier now that the
    // pipeline exists (the stack was constructed before it so the interceptor
    // hooks carrier exists). init() below compiles the tools with
    // these — every Pi tool execute runs the shared handleToolBefore pipeline.
    interceptorHooks.state = hookPipeline.state;
    interceptorHooks.deps = hookPipeline.deps;

    // ── 5. Tool registration via PiLightweightServiceStack ──────────────
    //
    // Build real dispatch CanonicalToolDefs and pass them to the service
    // stack instead of stub tools. All other tools (standalone, session,
    // asset) are built as before.

    // ── Child-process mode guard (subtask S2) ─────────────────────────────
    //
    // A spawned Pi subagent (process-session.ts) is seeded with
    // ROLEBOX_ACTIVE_AGENT and receives its dispatch prompt via
    // --append-system-prompt. In that process the parent-side prompt /
    // function machinery must NOT re-run on top of the appended prompt, so
    // the chat activation wiring, the loop lifecycle event handlers, and
    // the before_agent_start system-prompt injection are all skipped below
    // (guarded by `isChildProcess`). Everything a nested dispatch needs is
    // kept: tool registration via serviceStack.init(), the dispatchManager,
    // the hook pipeline, event wiring, resources_discover, LSP managers,
    // and the activeAgent seeding above.
    const isChildProcess = isPiChildProcess();
    if (isChildProcess) {
      log.info("Pi extension in child-process mode — parent-side wiring skipped", {
        agent: seededAgent,
      });
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
    //
    // Skipped entirely in child-process mode (subtask S2): a spawned Pi
    // subagent must not re-run handleChatMessage on top of the
    // --append-system-prompt it already received — its parent already ran
    // the pipeline against the originating user message.
    if (!isChildProcess) {
      const chatActivation = wirePiChatActivation({
        pi,
        state: hookPipeline.state,
        deps: hookPipeline.deps,
        activeAgent,
      });
      bridgeUnsubscribers.push(chatActivation.unsubscribe);

      log.info("Pi chat activation wired — message_start → handleChatMessage");
    }

    await serviceStack.init();

    // ── 6. Event wiring ─────────────────────────────────────────────────
    //
    // Subscribe to Pi's lifecycle events and forward them through the
    // canonical event bridge. Every subscription is wrapped in a try/catch
    // to avoid crashing the Pi runtime if eventBridge.emit() fails.

    /** Wrap a Pi event handler so errors are logged but never thrown to Pi. */
    function wireEvent(piEventName: PiEventType): void {
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

    // ── 6b. Node-liveness relay: REMOVED with the legacy graph runtime ────
    //
    // The relay resolved a live session to its owning graph node through the
    // legacy GraphToolSet's engine-level reverse index. The outcome run path has
    // no such in-memory node index — attempts live in the acceptance ledger and
    // a completion is settled through the host's completion bridge — so there is
    // nothing here to relay into. A future slice may add an outcome-backed
    // liveness query; until then a worker's session activity is not mirrored
    // into graph state.

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
    //
    // Skipped entirely in child-process mode (subtask S2): a spawned Pi
    // subagent owns a fresh LoopCoordinator with no parent loops to manage —
    // wiring these handlers would re-run parent-side loop lifecycle
    // machinery on top of the --append-system-prompt it already received.
    if (!isChildProcess && typeof pi.on === "function") {
      // agent_settled: fires after agent finishes and no retry/compaction
      // is pending. Use this to recover loops whose workers completed
      // while the agent was busy streaming or processing.
      pi.on("agent_settled" satisfies PiEventType, async (_event: unknown, _ctx: unknown) => {
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
      pi.on("session_shutdown" satisfies PiEventType, async (_event: unknown, ctx: any) => {
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
      pi.on("before_agent_start" satisfies PiEventType, async (event: any, ctx: any) => {
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
    //
    // Skipped entirely in child-process mode (subtask S2): the spawned
    // subagent already received its dispatch prompt via
    // --append-system-prompt — re-injecting available_roles / loop_tool /
    // available_functions on top of it would duplicate the parent-side
    // prompt machinery.
    if (!isChildProcess && typeof pi.on === "function") {
      pi.on("before_agent_start" satisfies PiEventType, async (event: any, ctx: unknown) => {
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

      log.info("Agent prompt injection wired");
    }

    // ── 8. Skill path contribution ──────────────────────────────────────
    //
    // Surface rolebox skill directories to Pi's resource discovery system
    // so that Pi knows which skill files to load for each agent.

    if (typeof pi.on === "function") {
      pi.on("resources_discover" satisfies PiEventType, async (_event: unknown, _ctx: unknown) => {
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
