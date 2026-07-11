/**
 * Pi Extension Entry Point — `src/pi-extension.ts`
 *
 * This file is the entry point for Pi's extension system. Pi loads it as a
 * TypeScript module (via jiti) and calls the default export with its
 * ExtensionAPI object.
 *
 * It initializes rolebox on the Pi platform by: discovering roles, resolving
 * them, creating platform adapters, syncing agents in-memory, wiring events,
 * injecting agent context, and surfacing skill resources.
 *
 * @module
 */

import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { discoverRoles } from "./loader/role-loader.ts";
import { resolveAllRoles } from "./resolver/orchestrator.ts";
import { PiLightweightServiceStack } from "./platform/adapters/pi/service-stack.ts";
import { PiEventBridge } from "./platform/adapters/pi/event-bridge.ts";
import { PiAgentRegistrar } from "./platform/adapters/pi/agent-registrar.ts";
import { syncAllAgents } from "./sync/agent-files.ts";
import { piCapabilities } from "./platform/capabilities.ts";
import { createSubLogger, formatError } from "./logger.ts";
import type { ResolvedFunction, ResolvedGraph, ResolvedSubAgent } from "./types.ts";
import { PiProcessSessionAdapter } from "./platform/adapters/pi/process-session.ts";
import { PiNotificationSessionClient } from "./platform/adapters/pi/notification-session.ts";
import {
  createDispatchTool,
  createDispatchOutputTool,
  createDispatchCancelTool,
  createDispatchMetricsTool,
  createDispatchBudgetTool,
} from "./dispatch/tools.ts";
import { createDispatchStatusTool } from "./dispatch/query/task-status.ts";
import type { CanonicalToolDef } from "./platform/index.ts";
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

// ── Shared state maps (same pattern as index.ts) ──────────────────────────

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
    // ── 1. Determine directories ────────────────────────────────────────
    //
    // Match the same logic as src/index.ts but without opencode's configDir
    // helper (we cannot import @opencode-ai/plugin here).
    const configDir = path.join(os.homedir(), ".config", "opencode");
    const cwdRoleboxDir = path.join(process.cwd(), "rolebox");
    const roleboxDir = existsSync(cwdRoleboxDir)
      ? cwdRoleboxDir
      : path.join(configDir, "rolebox");
    const globalSkillsDir = path.join(configDir, "skills");
    const builtinDir = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "functions",
    );

    log.info("Pi extension starting", {
      roleboxDir,
      globalSkillsDir,
      configDir,
    });

    // ── 2. Role discovery & resolution ──────────────────────────────────

    const roles = await discoverRoles(roleboxDir);
    log.info("Roles discovered", { count: roles.size });

    if (roles.size === 0) {
      log.info("No roles found — Pi extension has nothing to register");
      return;
    }

    const resolvedRoles = await resolveAllRoles(roles, {
      roleboxDir,
      globalSkillsDir,
      configDir,
      builtinDir,
      roleFunctionsMap,
      roleGraphMap,
    });

    const discovered = roles.size;
    const resolved = resolvedRoles.length;
    const skipped = discovered - resolved;
    log.info("Roles resolved", { discovered, resolved, skipped });

    if (resolved === 0 && discovered > 0) {
      log.warn("All discovered roles failed to resolve — check role.yaml files");
      return;
    }

    // ── 3. Create platform adapters ─────────────────────────────────────

    const eventBridge = new PiEventBridge();
    const registrar = new PiAgentRegistrar();
    // Pass sessionDir from Pi extension context if available.
    const piSessionDir = (pi as any)?.ctx?.sessionDir ?? (pi as any)?.sessionDir;
    const capabilities = piCapabilities();

    log.info("Platform adapters created", {
      events: "PiEventBridge",
      agents: "PiAgentRegistrar",
      sessionDir: piSessionDir ?? "default",
      capabilities: capabilities.platformId,
    });

    // ── 4. Sync agents into in-memory registry ─────────────────────────

    await syncAllAgents(resolvedRoles, registrar);
    log.info("Agent registry synced");

    // ── 5. Initialize real dispatch pipeline ──────────────────────────────
    //
    // Create a PiProcessSessionAdapter backed by child process spawning,
    // construct a DispatchManager with real multi-agent orchestration,
    // and wire parent notification through Pi's API when available.

    const sessionAdapter = new PiProcessSessionAdapter(undefined, piSessionDir);

    // Recover orphaned Pi sessions from sidecar files.
    const recoveredSessions = await sessionAdapter.recoverOrphanedSessions();
    if (recoveredSessions > 0) {
      log.info("Recovered orphaned Pi sessions", { count: recoveredSessions });
    }

    // Build subagent maps from shared factory.
    const { resolvedSubagents, subagentModelKey } =
      buildSubagentLineage(resolvedRoles);

    // Pi-specific: register agent configs on the process adapter.
    function registerPiAgentConfigs(
      subagents: ResolvedSubAgent[],
      parentModel: string | undefined,
    ): void {
      for (const sub of subagents) {
        const model = sub.config.model ?? parentModel;
        const key = model ? model : "default";
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
    const notifyClient = new PiNotificationSessionClient(sessionAdapter, pi, log);

    // Seed notification dedup from persistent storage to prevent duplicates after restart.
    const dedup = loadNotifyDedup();
    if (dedup.size > 0) {
      seedSentFinalNotifies(dedup);
      log.debug("Loaded notification dedup from disk", { count: dedup.size });
    }

    // ── Shutdown hooks ──────────────────────────────────────────────────
    //
    // Register process-level handlers to clean up child processes and
    // persist notification dedup on exit/SIGINT/SIGTERM.
    const shutdownHandler = (): void => {
      log.debug("Pi extension shutdown — persisting notification dedup");
      persistNotifyDedupSync(getSentFinalNotifies());
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
      storeDirectory: configDir,
    });
    const dispatchManager = result.manager;

    if (result.recoverError) {
      throw result.recoverError;
    }

    log.info("Dispatch manager initialized", {
      maxConcurrent: dispatchManager.getConfig().maxConcurrent,
      subagentKeys: subagentModelKey.size,
    });

    // ── 6. Tool registration via PiLightweightServiceStack ──────────────
    //
    // Build real dispatch CanonicalToolDefs and pass them to the service
    // stack instead of stub tools. All other tools (standalone, session,
    // asset) are built as before.

    const dispatchTools: Record<string, CanonicalToolDef> = {
      dispatch: createDispatchTool(dispatchManager, resolvedSubagents, subagentModelKey),
      dispatch_output: createDispatchOutputTool(dispatchManager),
      dispatch_cancel: createDispatchCancelTool(dispatchManager),
      dispatch_metrics: createDispatchMetricsTool(),
      dispatch_status: createDispatchStatusTool(dispatchManager),
      dispatch_budget: createDispatchBudgetTool(dispatchManager),
    };

    const loopTools: Record<string, CanonicalToolDef> = {};

    const serviceStack = new PiLightweightServiceStack(
      pi,
      resolvedRoles,
      piSessionDir,
      dispatchTools,
      loopTools,
    );
    const registeredCount = await serviceStack.init();

    log.info("Tool registration complete", { registeredCount });

    // ── 7. Event wiring ─────────────────────────────────────────────────
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

    // ── 8. Agent system prompt injection ────────────────────────────────
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

    // ── 9. Skill path contribution ──────────────────────────────────────
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

    // ── 10. Initialization complete ─────────────────────────────────────

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
