import type { AgentConfig, Event } from "@opencode-ai/sdk";
import type { PluginInput, Config } from "@opencode-ai/plugin";
import { graphSessionState } from "./graph/index.ts";
import { setAdvanceJudge } from "./graph/advance.ts";
import { functionRuntime } from "./function/runtime-state.ts";
import { buildAgentConfig, transformPermission } from "./prompt/agent-config.ts";
import { DispatchManager } from "./dispatch/manager.ts";
import { createDispatchTool, createDispatchOutputTool, createDispatchCancelTool, createDispatchMetricsTool } from "./dispatch/tools.ts";
import { mergeConfig, resolveEnvConfig, DEFAULT_CONFIG } from "./dispatch/config.ts";
import type { ResolvedRole, ResolvedSubAgent, ResolvedFunction, ResolvedGraph } from "./types.ts";
import { RoleMode } from "./constants.ts";
import { normalizeWorkspaceDir } from "./state-paths.ts";
import { createSubLogger } from "./logger.ts";
import { SessionClientWrapper } from "./session/client.ts";
import {
  createSessionListTool,
  createSessionReadTool,
  createSessionSearchTool,
  createSessionInfoTool,
  createSessionDiffTool,
  createSessionForkTool,
} from "./session/tools.ts";
import { LspClientManager } from "./lsp/client-manager.ts";
import { LspDocumentManager } from "./lsp/document-manager.ts";
import { createAllLspTools } from "./lsp/index.ts";
import { createHashlineReadTool } from "./hashline/hashline-read.ts";
import { createHashlineEditTool } from "./hashline/hashline-edit.ts";
import { LoopCoordinator } from "./loop/coordinator.ts";
import { DispatchAdapter } from "./loop/dispatch-adapter.ts";
import { LoopStore } from "./loop/loop-store.ts";
import { INTER_ROUND_DELAY_MS, STOP_LOOP_COMMAND, STOP_LOOP_SIGNAL } from "./loop/constants.ts";
import type { JudgeFn } from "./graph/termination-async.ts";
import { hookState } from "./hooks/state.ts";
import type { HookDeps } from "./hooks/deps.ts";
import { handleEvent } from "./hooks/event-handler.ts";
import { handleChatMessage } from "./hooks/chat-message.ts";
import { handleToolAfter } from "./hooks/tool-after.ts";
import { handleToolBefore, registerToolSchema } from "./hooks/tool-before.ts";
import { handleSystemTransform } from "./hooks/system-transform.ts";
import { CustomHookRegistry } from "./hooks/custom/registry.ts";
import { RecoveryEngine } from "./recovery/engine.ts";
import { RecoveryStateStore } from "./recovery/state.ts";
import { BuiltInHookRegistry } from "./recovery/builtin/registry.ts";
import { registerBuiltinHooks } from "./recovery/builtin/index.ts";
import { parseRecoveryConfig, mergeBuiltinFlags, DEFAULT_RECOVERY_CONFIG } from "./recovery/config.ts";
import { NotificationManager } from "./notifications/manager.ts";
import type { NotificationConfig } from "./notifications/types.ts";
import { parseNotificationConfig, mergeNotificationConfigs, resolveEnvVarsInConfig, DEFAULT_NOTIFICATION_CONFIG } from "./notifications/config.ts";
import { createNotificationHook } from "./notifications/hook.ts";
import { readFileSync, existsSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { ExtensionRegistry } from "./extensions/index.ts";

const log = createSubLogger("plugin-hooks");

export const managerMap = hookState.managerMap;
export const loopManagerMap = hookState.loopManagerMap;
export const pendingCorrections = hookState.pendingCorrections;
export const userMessagedSessions = hookState.userMessagedSessions;
export const sessionAgentRegistry = hookState.sessionAgentRegistry;
export const autoActivatedSessions = hookState.autoActivatedSessions;
export const roleAutoActivateMap = hookState.roleAutoActivateMap;
export const roleLockedMap = hookState.roleLockedMap;
export let activeLoopManager = hookState.activeLoopManager;

function createJudgeFn(client: PluginInput["client"]): JudgeFn {
  return async (nlCondition: string, context: string): Promise<boolean> => {
    try {
      const createResult = await client.session.create({});
      if ((createResult as { error?: unknown }).error) return false;

      const sessionId = ((createResult as { data?: { id?: string } }).data)?.id;
      if (!sessionId) return false;

      try {
        const promptResult = await client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [{
              type: "text",
              text: `Judge: "${nlCondition}"\n\nContext:\n${context}\n\nAnswer "YES" or "NO".`,
            }],
          },
        });

        if ((promptResult as { error?: unknown }).error) return false;

        const data = (promptResult as {
          data?: { parts: Array<{ type: string; text?: string }> };
        }).data;
        const text = data?.parts
          ?.filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text!)
          .join("") ?? "";

        return /^\s*YES\b/mi.test(text);
      } finally {
        client.session.delete({ path: { id: sessionId } }).catch(() => {});
      }
    } catch {
      return false;
    }
  };
}

export async function createPluginHooks(
  resolvedRoles: ResolvedRole[],
  client: PluginInput["client"],
  roleFunctionsMap: Map<string, ResolvedFunction[]>,
  roleGraphMap: Map<string, ResolvedGraph>,
  directory?: string,
) {
  const resolvedSubagents = new Map<string, { parentFullId: string }>();
  const subagentModelKey = new Map<string, string>();

  function registerSubagentLineage(
    subagents: ResolvedSubAgent[],
    parentFullId: string,
    parentModel: string | undefined,
  ): void {
    for (const sub of subagents) {
      resolvedSubagents.set(sub.id, { parentFullId });
      const model = sub.config.model ?? parentModel;
      const key = model ? model : "default";
      subagentModelKey.set(sub.id, key);
      log.debug("model key", { subagent: sub.id, key, parentFullId });
      if (sub.subagents.length > 0) {
        registerSubagentLineage(sub.subagents, sub.id, model);
      }
    }
  }

  for (const role of resolvedRoles) {
    registerSubagentLineage(role.subagents, role.id, role.config.model);
  }

  for (const resolved of resolvedRoles) {
    if (resolved.config.auto_activate?.length) {
      hookState.roleAutoActivateMap.set(resolved.id, resolved.config.auto_activate);
    }
    if (resolved.locked !== undefined) {
      hookState.roleLockedMap.set(resolved.id, resolved.locked);
    }
  }

  const rawDir = directory ?? process.cwd();
  const dir = normalizeWorkspaceDir(rawDir);

  let dispatchManager = hookState.managerMap.get(rawDir);
  if (!dispatchManager) {
    const primaryRole = resolvedRoles.find((r) => r.config.mode === RoleMode.Primary);
    const mergedConfig = mergeConfig(
      DEFAULT_CONFIG,
      primaryRole?.dispatchConfig,
      resolveEnvConfig(),
    );
    dispatchManager = new DispatchManager(client, mergedConfig, subagentModelKey);
    dispatchManager.setStoreDirectory(dir);
    hookState.managerMap.set(rawDir, dispatchManager);
    await dispatchManager.recover();
  }

  let loopManager = hookState.loopManagerMap.get(rawDir);
  if (!loopManager) {
    const adapter = new DispatchAdapter(dispatchManager, client);
    const store = new LoopStore(dir);
    const coordinator = new LoopCoordinator(adapter, {
      delayMs: INTER_ROUND_DELAY_MS,
      persist: (loops) => {
        void store.save(loops);
      },
    });

    // Recovery: reconcile persisted loops with dispatch state
    const loaded = store.load();
    if (loaded) {
      const reconciled = await store.reconcile(loaded, async (taskId) => {
        try {
          const task = dispatchManager.getTask(taskId);
          if (task) return { status: task.status, exists: true };
        } catch {
          // Fall through to unknown
        }
        return { status: "unknown", exists: false };
      });
      for (const [, state] of reconciled) {
        coordinator.restoreState(state);
      }
    }

    loopManager = coordinator;
    hookState.loopManagerMap.set(rawDir, loopManager);
    hookState.loopStoreMap.set(rawDir, store);
  }
  hookState.activeLoopManager = loopManager;
  activeLoopManager = loopManager;

  // Notification manager
  let notificationManager = hookState.notificationManager;
  if (!notificationManager) {
    // Parse global config from env var ROLEBOX_NOTIFICATIONS_CONFIG (path to YAML file)
    let globalNotifConfig: NotificationConfig = { ...DEFAULT_NOTIFICATION_CONFIG };
    const notifConfigPath = process.env.ROLEBOX_NOTIFICATIONS_CONFIG;
    if (notifConfigPath && existsSync(notifConfigPath)) {
      try {
        const raw = readFileSync(notifConfigPath, "utf-8");
        const parsed = loadYaml(raw);
        globalNotifConfig = resolveEnvVarsInConfig(parseNotificationConfig(parsed));
      } catch (e) {
        log.warn("Failed to parse notification config file", { path: notifConfigPath, error: e instanceof Error ? e.message : String(e) });
      }
    }
    // Also check env var to enable/disable
    if (process.env.ROLEBOX_NOTIFICATIONS_ENABLED === "false" || process.env.ROLEBOX_NOTIFICATIONS_ENABLED === "0") {
      globalNotifConfig = { ...globalNotifConfig, enabled: false };
    }

    // Collect per-role notification configs from resolved roles
    const roleNotifConfigs = new Map<string, NotificationConfig>();
    for (const role of resolvedRoles) {
      if (role.config.notifications) {
        const parsed = parseNotificationConfig(role.config.notifications);
        const resolved = resolveEnvVarsInConfig(parsed);
        roleNotifConfigs.set(role.id, resolved);
      }
    }

    notificationManager = new NotificationManager({
      globalConfig: globalNotifConfig,
      roleConfigs: roleNotifConfigs,
      client,
      dir,
    });
    hookState.notificationManager = notificationManager;
  }

  // LSP managers
  const lspClientManager = new LspClientManager(dir);
  const lspDocManager = new LspDocumentManager();

  if (directory) {
    graphSessionState.setStoreDirectory(dir);
    functionRuntime.setStoreDirectory(dir);
  }
  graphSessionState.recover((_sessionID, agentId) => roleGraphMap.get(agentId));
  functionRuntime.recover();

  if (!hookState.shutdownRegistered) {
    hookState.shutdownRegistered = true;
    const flushAllSync = () => {
      for (const [d, mgr] of hookState.loopManagerMap) {
        try {
          hookState.loopStoreMap.get(d)?.saveSync(mgr.getAllLoopStates());
        } catch {}
        mgr.dispose();
      }
      dispatchManager.flushPersistSync();
      if (directory) graphSessionState.flushSync();
      if (directory) functionRuntime.flushSync();
      try { lspDocManager.closeAll(lspClientManager); } catch {}
      hookState.recoveryEngine?.dispose().catch(() => {});
      try { void lspClientManager.shutdownAll(); } catch {}
    };
    process.on("exit", () => {
      flushAllSync();
    });
    process.on("SIGINT", () => {
      flushAllSync();
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      flushAllSync();
      process.exit(143);
    });
  }

  setAdvanceJudge(createJudgeFn(client));

  const sessionClient = new SessionClientWrapper(client);

  // --- Custom Hook Registry ---
  const customHookRegistry = new CustomHookRegistry();
  hookState.customHookRegistry = customHookRegistry;
  customHookRegistry.setDeps({
    pendingCorrections: hookState.pendingCorrections,
    functionRuntime,
    dispatchManager,
    graphSessionState,
  });

  for (const role of resolvedRoles) {
    const hookConfigs = role.config.hooks?.custom;
    if (hookConfigs && hookConfigs.length > 0) {
      for (const hook of hookConfigs) {
        await customHookRegistry.register(hook, dir);
        log.debug("Registered custom hook for role", {
          role: role.id,
          hook: hook.name,
        });
      }
    }
  }
  // --- Extension Registry ---
  const extensionRegistry = new ExtensionRegistry();
  hookState.extensionRegistry = extensionRegistry;
  // --- Recovery Engine ---
  const builtinFlagsList: Record<string, boolean>[] = [];
  const recoveryConfigsList: unknown[] = [];

  for (const role of resolvedRoles) {
    if (role.config.hooks) {
      if (role.config.hooks.builtin) {
        builtinFlagsList.push(role.config.hooks.builtin);
      }
      if (role.config.hooks.recovery) {
        recoveryConfigsList.push(role.config.hooks.recovery);
      }
    }
  }

  const builtinConfig = mergeBuiltinFlags(builtinFlagsList);

  // Tiered defaults: error recovery hooks default ON, guard hooks default OFF
  const ERROR_RECOVERY_HOOKS = [
    "session_error",
    "edit_error",
    "json_error",
    "context_window",
    "empty_response",
  ];
  const GUARD_HOOKS = [
    "tool_pair_validation",
    "write_existing_file_guard",
    "bash_file_read_guard",
    "webfetch_redirect_guard",
  ];

  // Apply tiered defaults only when user hasn't explicitly set a value
  for (const key of ERROR_RECOVERY_HOOKS) {
    if (builtinConfig[key] === undefined) {
      builtinConfig[key] = true;
    }
  }
  for (const key of GUARD_HOOKS) {
    if (builtinConfig[key] === undefined) {
      builtinConfig[key] = false;
    }
  }

  // Master recovery toggle defaults to true so the engine is created
  if (builtinConfig.recovery === undefined) {
    builtinConfig.recovery = true;
  }

  hookState.builtinConfig = builtinConfig;

  const recoveryConfig = recoveryConfigsList.length > 0
    ? parseRecoveryConfig(recoveryConfigsList[0])
    : DEFAULT_RECOVERY_CONFIG;

  let recoveryEngine: RecoveryEngine | undefined;
  let builtInHookRegistry: BuiltInHookRegistry | undefined;

  if (builtinConfig.recovery === true) {
    const recoveryStateStore = new RecoveryStateStore(dir);
    recoveryEngine = new RecoveryEngine(recoveryConfig, recoveryStateStore, {
      pendingCorrections: hookState.pendingCorrections,
      client,
    });
    builtInHookRegistry = new BuiltInHookRegistry();
    registerBuiltinHooks(builtInHookRegistry, recoveryEngine);

    hookState.recoveryEngine = recoveryEngine;
    hookState.builtInHookRegistry = builtInHookRegistry;
  }

  // --- Load Extension Modules (after RecoveryEngine creation) ---
  for (const role of resolvedRoles) {
    if (role.config.extensions) {
      try {
        await extensionRegistry.loadExtensions(role.config.extensions, dir);
        log.debug("Loaded extensions for role", { role: role.id });
      } catch (err) {
        log.warn("Failed to load extensions for role", {
          role: role.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Register custom recovery strategies/patterns into the engine
  if (recoveryEngine) {
    for (const [name, mod] of extensionRegistry.getLoadedStrategies()) {
      recoveryEngine.registerStrategy({ name, execute: mod.execute } as import("./recovery/types.ts").RecoveryStrategy);
    }
    for (const [name, mod] of extensionRegistry.getLoadedPatterns()) {
      recoveryEngine.registerErrorPattern({ name, category: mod.category, match: mod.match } as unknown as import("./recovery/types.ts").ErrorPattern);
    }
  }

  // Bridge recovery metrics into the persisted metrics pipeline.
  // DispatchManager's MetricsPersister will call the provider during
  // serialization to include recovery data in the metrics-*.json file.
  if (recoveryEngine) {
    dispatchManager.setRecoverySnapshotProvider(() => recoveryEngine.getMetrics());
  }
  const deps: HookDeps = {
    client,
    roleFunctionsMap,
    roleGraphMap,
    dir,
    dispatchManager,
    loopManager,
    customHooks: customHookRegistry,
    recoveryEngine,
    builtInHooks: builtInHookRegistry,
    notificationManager,
    extensionRegistry,
  };

  const tools = {
    dispatch: createDispatchTool(dispatchManager, resolvedSubagents, subagentModelKey),
    dispatch_output: createDispatchOutputTool(dispatchManager),
    dispatch_cancel: createDispatchCancelTool(dispatchManager),
    dispatch_metrics: createDispatchMetricsTool(),
    session_list: createSessionListTool(sessionClient),
    session_read: createSessionReadTool(sessionClient),
    session_search: createSessionSearchTool(sessionClient),
    session_info: createSessionInfoTool(sessionClient),
    session_diff: createSessionDiffTool(sessionClient),
    session_fork: createSessionForkTool(sessionClient),
    // Alternative names to avoid built-in tool name conflicts
    session_inspect: createSessionInfoTool(sessionClient),
    session_changes: createSessionDiffTool(sessionClient),
    session_branch: createSessionForkTool(sessionClient),
    ...createAllLspTools(lspClientManager, lspDocManager),
    hashline_read: createHashlineReadTool(),
    hashline_edit: createHashlineEditTool(),
  };

  // Register tool schemas for tool.execute.before validation
  for (const [name, def] of Object.entries(tools)) {
    registerToolSchema(name, def.args);
  }

  const notifHook = notificationManager ? createNotificationHook(notificationManager) : null;

  return {
    tool: tools,
    event: async (input: { event: Event }) => {
      await handleEvent(input.event, hookState, deps);
      if (notifHook) {
        try { await notifHook.event(input); } catch {}
      }
    },
    config: async (config: Config) => {
      function registerSubAgentConfigs(subagents: ResolvedSubAgent[], cfg: Config): void {
        for (const sub of subagents) {
          const subAgentCfg: Record<string, unknown> = {
            prompt: sub.prompt,
            mode: RoleMode.Subagent,
            hidden: true,
          };
          if (sub.config.description) subAgentCfg.description = sub.config.description;
          if (sub.config.model) subAgentCfg.model = sub.config.model;
          if (sub.config.color) subAgentCfg.color = sub.config.color;
          if (sub.config.variant) subAgentCfg.variant = sub.config.variant;
          if (sub.config.temperature !== undefined) subAgentCfg.temperature = sub.config.temperature;
          if (sub.config.top_p !== undefined) subAgentCfg.top_p = sub.config.top_p;
          if (sub.config.tools) subAgentCfg.tools = sub.config.tools;
          if (sub.config.permission) subAgentCfg.permission = transformPermission(sub.config.permission);

          cfg.agent ??= {};
          cfg.agent[sub.id] = subAgentCfg as AgentConfig;
          if (sub.subagents.length > 0) {
            registerSubAgentConfigs(sub.subagents, cfg);
          }
        }
      }

      for (const resolved of resolvedRoles) {
        const agentConfig = buildAgentConfig(resolved);
        config.agent ??= {};
        config.agent[resolved.id] = agentConfig;

        registerSubAgentConfigs(resolved.subagents, config);
      }

      // Register /stop-loop command so users can explicitly cancel a running loop
      (config as Record<string, unknown>).command ??= {};
      const commands = (config as Record<string, unknown>).command as Record<string, unknown>;
      if (!commands[STOP_LOOP_COMMAND]) {
        commands[STOP_LOOP_COMMAND] = {
          template: STOP_LOOP_SIGNAL,
          description: "Stop the active loop",
        };
      }
    },
    "chat.message": async (
      input: { agent?: string; sessionID: string },
      output: { parts: Array<{ type: string; text?: string }> },
    ) => {
      await handleChatMessage(input, output, hookState, deps);
      if (notifHook) {
        try { notifHook.chatMessage(input); } catch {}
      }
    },
    "tool.execute.after": async (
      input: { sessionID?: string; tool?: string; args?: unknown },
      output: unknown,
    ) => {
      await handleToolAfter(input, output, hookState, deps);
    },
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: any },
    ) => {
      await handleToolBefore(input, output, hookState, deps);
      if (notifHook) {
        try { notifHook.toolBefore({ tool: input.tool, sessionID: input.sessionID, callID: input.callID, args: output.args }); } catch {}
      }
    },
    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = (input as any).agent as string | undefined;
      await handleSystemTransform({ sessionID: input.sessionID, agent }, output, hookState, deps);
    },
    dispose: async () => {
      try { await notificationManager?.dispose(); } catch {}
      try { await customHookRegistry.dispose(); } catch {}
      try { lspDocManager.closeAll(lspClientManager); } catch {}
      try { await lspClientManager.shutdownAll(); } catch {}
      try { await deps.recoveryEngine?.dispose(); } catch {}
    },
  };
}
