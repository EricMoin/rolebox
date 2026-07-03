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
import { handleSystemTransform } from "./hooks/system-transform.ts";

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

  const deps: HookDeps = {
    client,
    roleFunctionsMap,
    roleGraphMap,
    dir,
    dispatchManager,
    loopManager,
  };

  return {
    tool: {
      dispatch: createDispatchTool(dispatchManager, resolvedSubagents, subagentModelKey),
      dispatch_output: createDispatchOutputTool(dispatchManager),
      dispatch_cancel: createDispatchCancelTool(dispatchManager),
      dispatch_metrics: createDispatchMetricsTool(),
    },
    event: async (input: { event: Event }) => {
      await handleEvent(input.event, hookState, deps);
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
    },
    "tool.execute.after": async (
      input: { sessionID?: string; tool?: string; args?: unknown },
      _output: unknown,
    ) => {
      await handleToolAfter(input, _output, hookState, deps);
    },
    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = (input as any).agent as string | undefined;
      await handleSystemTransform({ sessionID: input.sessionID, agent }, output, hookState, deps);
    },
  };
}
