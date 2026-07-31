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

import { PiLightweightServiceStack } from "./platform/adapters/pi/service-stack.ts";
import { PiEventBridge } from "./platform/adapters/pi/event-bridge.ts";
import { PiAgentRegistrar } from "./platform/adapters/pi/agent-registrar.ts";
import { wireRoleSwitcher } from "./platform/adapters/pi/role-switcher.ts";
import { createActiveAgentRef } from "./platform/adapters/pi/active-agent.ts";
import { piCapabilities } from "./platform/capabilities.ts";
import { createSubLogger, formatError } from "./logger.ts";
import type { ResolvedFunction, ResolvedGraph, ResolvedSubAgent } from "./types.ts";
import { PiProcessSessionAdapter } from "./platform/adapters/pi/process-session.ts";
import { PiNotificationSessionClient } from "./platform/adapters/pi/notification-session.ts";
import { DispatchAdapter } from "./loop/dispatch-adapter.ts";
import { LoopCoordinator } from "./loop/coordinator.ts";
import { LoopStore } from "./loop/loop-store.ts";
import { createDispatchTools } from "./dispatch/tools.ts";
import { createLoopTools } from "./loop/loop-tools.ts";
import { createTaskTools } from "./dispatch/query/task-tools.ts";
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

// ── Shared state maps ─────────────────────────────────────────────────────

const roleFunctionsMap: Map<string, ResolvedFunction[]> = new Map();
const roleGraphMap: Map<string, ResolvedGraph> = new Map();

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
  const log = createSubLogger("pi-extension");

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

    // ── Shutdown hooks ──────────────────────────────────────────────────
    //
    // Register process-level handlers to clean up child processes and
    // persist notification dedup on exit/SIGINT/SIGTERM.
    const shutdownHandler = (): void => {
      log.debug("Pi extension shutdown — persisting notification dedup");
      persistNotifyDedupSync(getSentFinalNotifies());
      for (const unsub of bridgeUnsubscribers) unsub();
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


    // ── PiEventBridge → DispatchManager wiring ──────────────────────────
    //
    // Subscribe to canonical Pi session lifecycle events and route them
    // to dispatchManager handlers so Pi process sessions (spawned by
    // PiProcessSessionAdapter) feed into the completion pipeline. Mirrors
    // the pattern in hook-service.ts / hooks/event-handler.ts for opencode.

    /** Extract session ID from canonical event properties with fallback chain. */
    function extractSessionId(props: Record<string, unknown>): string | undefined {
      if (typeof props.sessionID === "string") return props.sessionID;
      if (typeof props.sessionId === "string") return props.sessionId;
      const info = props.info as Record<string, unknown> | undefined;
      if (typeof info?.sessionID === "string") return info.sessionID;
      if (typeof info?.sessionId === "string") return info.sessionId;
      if (typeof info?.id === "string") return info.id;
      return undefined;
    }

    // session.idle — emitted by PiProcessSessionAdapter on process exit (subtask 1)
    bridgeUnsubscribers.push(
      eventBridge.onType("session.idle", async (event) => {
        try {
          const sid = extractSessionId(event.properties);
          if (sid) await dispatchManager.handleSessionIdle(sid);
        } catch (err) {
          log.debug("bridge:session.idle handler error", { error: formatError(err) });
        }
      }),
    );

    // session.status — session state changes (busy/idle)
    bridgeUnsubscribers.push(
      eventBridge.onType("session.status", (event) => {
        try {
          const sid = extractSessionId(event.properties);
          if (sid) {
            const props = event.properties;
            const statusVal = props.status;
            const statusType =
              typeof statusVal === "object" && statusVal !== null
                ? ((statusVal as { type?: string }).type ?? String(statusVal))
                : String(statusVal ?? "");
            dispatchManager.handleSessionStatus(sid, statusType);
          }
        } catch (err) {
          log.debug("bridge:session.status handler error", { error: formatError(err) });
        }
      }),
    );

    // message.updated — triggers inflight debounce resets
    bridgeUnsubscribers.push(
      eventBridge.onType("message.updated", (event) => {
        try {
          const sid = extractSessionId(event.properties);
          if (sid) dispatchManager.handleMessageUpdated(sid);
        } catch (err) {
          log.debug("bridge:message.updated handler error", { error: formatError(err) });
        }
      }),
    );

    // session.error — session crash or notification failure
    bridgeUnsubscribers.push(
      eventBridge.onType("session.error", async (event) => {
        try {
          const sid = extractSessionId(event.properties);
          if (sid) await dispatchManager.handleSessionError(sid, event.properties.error);
        } catch (err) {
          log.debug("bridge:session.error handler error", { error: formatError(err) });
        }
      }),
    );

    // session.deleted — session teardown (e.g., Pi session_shutdown)
    bridgeUnsubscribers.push(
      eventBridge.onType("session.deleted", async (event) => {
        try {
          const info = event.properties.info as { id?: string } | undefined;
          const did = info?.id ?? extractSessionId(event.properties);
          if (did) await dispatchManager.handleSessionDeleted(did);
        } catch (err) {
          log.debug("bridge:session.deleted handler error", { error: formatError(err) });
        }
      }),
    );

    // session.deleted (loop) — clean up worker-to-origin mappings when a
    // session is deleted. Mirrors the dispatch cleanup handler above but
    // targets the loop coordinator's internal tracking.
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

    log.debug("PiEventBridge → DispatchManager wiring complete", {
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

    const serviceStack = new PiLightweightServiceStack(
      pi,
      resolvedRoles,
      piSessionDir,
      undefined, // dispatchTools disabled (graph-only orchestration)
      undefined, // loopTools disabled (graph_add_loop replaces loop_*)
      taskTools,
      // Subtask 3: thread the live graph runtime into the stack. The
      // dispatchManager gates registration of the eight graph_* tools inside
      // buildCanonicalTools; notifyClient supplies the graph-notify session
      // client for emperor/orchestrator completion notifications; stateDir
      // (process.cwd()) persists engine state under `.rolebox/state`.
      dispatchManager,
      notifyClient,
      process.cwd(),
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
      pi.on("before_agent_start", async (event: any, _ctx: unknown) => {
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

          return { systemPrompt: currentPrompt + agentSection };
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
