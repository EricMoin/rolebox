import type { PluginService } from "../service.ts";
import type { PluginContext } from "../context.ts";
import type { EventBus } from "../event-bus.ts";
import type { AgentConfig, Event } from "@opencode-ai/sdk";
import type { Config } from "@opencode-ai/plugin";
import { graphSessionState } from "../../graph/index.ts";
import { setAdvanceJudge } from "../../graph/advance.ts";
import { functionRuntime } from "../../function/runtime-state.ts";
import { buildAgentConfig, transformPermission } from "../../prompt/agent-config.ts";
import { RoleMode } from "../../constants.ts";
import { createSubLogger } from "../../logger.ts";
import { hookState } from "../../hooks/state.ts";
import type { HookDeps } from "../../hooks/deps.ts";
import { handleEvent } from "../../hooks/event-handler.ts";
import { handleChatMessage } from "../../hooks/chat-message.ts";
import { handleToolAfter } from "../../hooks/tool-after.ts";
import { handleToolBefore } from "../../hooks/tool-before.ts";
import { handleSystemTransform } from "../../hooks/system-transform.ts";
import { handleCompacting } from "../../hooks/compaction.ts";
import { CustomHookRegistry } from "../../hooks/custom/registry.ts";
import { STOP_LOOP_COMMAND, STOP_LOOP_SIGNAL } from "../../loop/constants.ts";
import type { JudgeFn } from "../../graph/termination-async.ts";
import type { ResolvedSubAgent } from "../../types.ts";
import type { DispatchService } from "./dispatch-service.ts";
import type { LoopService } from "./loop-service.ts";
import type { NotificationService } from "./notification-service.ts";
import type { RecoveryService } from "./recovery-service.ts";
import type { ExtensionService } from "./extension-service.ts";
import type { ToolService } from "./tool-service.ts";
import { withTimeout, DEFAULT_TIMEOUT_MS } from "../../utils/timeout.ts";
import { OpencodeSessionAdapter } from "../../platform/adapters/opencode-session.ts";

const log = createSubLogger("hook-service");

export class HookService implements PluginService {
  readonly name = "hook-service";
  readonly dependencies = [
    "dispatch-service",
    "loop-service",
    "notification-service",
    "recovery-service",
    "extension-service",
    "tool-service",
  ];

  private customHookRegistry?: CustomHookRegistry;
  private deps?: HookDeps;
  private handlers?: ReturnType<typeof this.buildHandlers>;
  /**
   * Stable reference wrapper returned to opencode. On hot-reload, init()
   * replaces the methods in-place so the external reference stays valid.
   */
  private handlersWrapper: Record<string, unknown> = {};

  async init(ctx: PluginContext): Promise<void> {
    const { client, resolvedRoles, roleFunctionsMap, roleGraphMap, directory } = ctx;
    const dir = directory;

    // Graph state recovery (original lines 247-252)
    if (dir) {
      graphSessionState.setStoreDirectory(dir);
      functionRuntime.setStoreDirectory(dir);
    }
    graphSessionState.recover((_sessionID, agentId) => roleGraphMap.get(agentId));
    functionRuntime.recover();
    // Refresh hookState auto-activate and locked maps (supports hot-reload)
    hookState.roleAutoActivateMap.clear();
    hookState.roleLockedMap.clear();
    for (const resolved of resolvedRoles) {
      if (resolved.config.auto_activate?.length) {
        hookState.roleAutoActivateMap.set(resolved.id, resolved.config.auto_activate);
      }
      if (resolved.locked !== undefined) {
        hookState.roleLockedMap.set(resolved.id, resolved.locked);
      }
    }

    // Set advance judge (original line 283)

    // --- Custom Hook Registry (original lines 288-308) ---
    this.customHookRegistry = new CustomHookRegistry();

    const dispatchService = ctx.core.getService<DispatchService>("dispatch-service")!;
    const dispatchManager = dispatchService.getDispatchManager();

    this.customHookRegistry.setDeps({
      pendingCorrections: hookState.pendingCorrections,
      functionRuntime,
      dispatchManager,
      graphSessionState,
    });

    for (const role of resolvedRoles) {
      const hookConfigs = role.config.hooks?.custom;
      if (hookConfigs && hookConfigs.length > 0) {
        for (const hook of hookConfigs) {
          await this.customHookRegistry.register(hook, dir);
          log.debug("Registered custom hook for role", { role: role.id, hook: hook.name });
        }
      }
    }

    // --- Assemble HookDeps (original lines 415-428) ---
    const loopService = ctx.core.getService<LoopService>("loop-service")!;
    const recoveryService = ctx.core.getService<RecoveryService>("recovery-service");
    const extensionService = ctx.core.getService<ExtensionService>("extension-service");
    const notificationService = ctx.core.getService<NotificationService>("notification-service");

    const roleMap = new Map(resolvedRoles.map((r) => [r.id, r]));

    this.deps = {
      client,
      session: new OpencodeSessionAdapter(client),
      roleFunctionsMap,
      roleGraphMap,
      roleMap,
      dir,
      dispatchManager,
      loopManager: loopService.getLoopManager(),
      customHooks: this.customHookRegistry,
      recoveryEngine: recoveryService?.getRecoveryEngine(),
      builtInHooks: recoveryService?.getBuiltInHookRegistry(),
      notificationManager: notificationService?.getNotificationManager(),
      extensionRegistry: extensionService?.getExtensionRegistry(),
      builtinConfig: recoveryService?.getBuiltinConfig(),
    };

    // --- Build handlers ---
    const toolService = ctx.core.getService<ToolService>("tool-service")!;

    const newHandlers = this.buildHandlers(toolService.getTools(), ctx.bus, resolvedRoles);

    // Update the stable wrapper in-place so opencode's reference stays valid
    for (const key of Object.keys(this.handlersWrapper)) {
      delete this.handlersWrapper[key];
    }
    for (const [key, value] of Object.entries(newHandlers)) {
      this.handlersWrapper[key] = value;
    }
    this.handlers = newHandlers;
  }

  async dispose(): Promise<void> {
    try { await this.customHookRegistry?.dispose(); } catch { /* best effort */ }
  }

  getHandlers() {
    return this.handlersWrapper as ReturnType<typeof this.buildHandlers>;
  }

  private buildHandlers(tools: Record<string, any>, bus: EventBus, resolvedRoles: any[]) {
    const deps = this.deps!;
    const handlers = {
      tool: tools,
      event: async (input: { event: Event }) => {
        await handleEvent(input.event, hookState, deps);
        // Emit to bus for notification and other subscribers
        const props = input.event.properties as Record<string, unknown> | undefined;
        const sessionID = typeof props?.sessionID === "string" ? props.sessionID
          : typeof props?.sessionId === "string" ? props.sessionId
          : (props?.info as any)?.sessionID ?? (props?.info as any)?.sessionId ?? (props?.info as any)?.id;
        const agent = typeof props?.agent === "string" ? props.agent : undefined;
        if (sessionID) {
          await bus.emit(`event:${input.event.type}`, { sessionID, agent, properties: props });
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
        await bus.emit("hook:chat.message", { sessionID: input.sessionID, agent: input.agent });
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
        await bus.emit("hook:tool.execute.before", { tool: input.tool, sessionID: input.sessionID, callID: input.callID, args: output.args });
      },
      "experimental.chat.system.transform": async (
        input: { sessionID?: string },
        output: { system: string[] },
      ) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const agent = (input as any).agent as string | undefined;
        await handleSystemTransform({ sessionID: input.sessionID, agent }, output, hookState, deps);
      },
      "experimental.session.compacting": async (
        input: { sessionID: string },
        output: { context: string[]; prompt?: string },
      ) => {
        await handleCompacting(input, output, deps.dir);
      },
      dispose: async () => {
        try { await this.customHookRegistry?.dispose(); } catch { /* best effort */ }
      },
    };
    return handlers;
  }

  private createJudgeFn(client: any): JudgeFn {
    return async (nlCondition: string, context: string): Promise<boolean> => {
      try {
        const createResult = await withTimeout(
          client.session.create({}),
          DEFAULT_TIMEOUT_MS,
          "judge.session.create",
          log,
        );
        if (createResult === null) return false;
        if ((createResult as { error?: unknown }).error) return false;

        const sessionId = ((createResult as { data?: { id?: string } }).data)?.id;
        if (!sessionId) return false;

        try {
          const promptResult = await withTimeout(
            client.session.prompt({
              path: { id: sessionId },
              body: {
                parts: [{
                  type: "text",
                  text: `Judge: "${nlCondition}"\n\nContext:\n${context}\n\nAnswer "YES" or "NO".`,
                }],
              },
            }),
            DEFAULT_TIMEOUT_MS,
            "judge.session.prompt",
            log,
          );

          if (promptResult === null) return false;
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
          client.session.delete({ path: { id: sessionId } }).catch((err: unknown) => {
            log.warn("Failed to delete judge session", { err });
          });
        }
      } catch {
        return false;
      }
    };
  }
}
