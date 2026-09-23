import type { PluginService } from "../service.ts";
import type { PluginContext } from "../context.ts";
import type { EventBus } from "../event-bus.ts";
import type { Config, Hooks } from "@opencode-ai/plugin";
import { normalizeOpencodeEvent } from "../../platform/adapters/opencode/event-bridge.ts";
import type { CanonicalEvent, CanonicalEventType } from "../../platform/types.ts";
import { functionRuntime } from "../../function/runtime-state.ts";
import { sessionSignalLedger } from "../../signal/session-signal-ledger.ts";
import { buildAgentConfig, transformPermission, type RoleboxAgentConfig } from "../../prompt/agent-config.ts";
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
import type { ResolvedSubAgent } from "../../types.ts";
import type { DispatchService } from "./dispatch-service.ts";
import type { LoopService } from "./loop-service.ts";
import type { NotificationService } from "./notification-service.ts";
import type { RecoveryService } from "./recovery-service.ts";
import type { ExtensionService } from "./extension-service.ts";
import type { ToolService } from "./tool-service.ts";
import { parseCopilotConfig } from "../../copilot/config.ts";
import type { CopilotConfig } from "../../copilot/types.ts";

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
   * Per-session throttle stamps for the liveness relay
   * (`sessionId → lastHeartbeatEmittedAt`). Bounded — entries older than the
   * throttle interval are pruned lazily when the map grows, so completed
   * sessions do not accumulate forever.
   */
  /**
   * Stable reference wrapper returned to opencode. On hot-reload, init()
   * replaces the methods in-place so the external reference stays valid.
   */
  private handlersWrapper: Record<string, unknown> = {};

  async init(ctx: PluginContext): Promise<void> {
    const { resolvedRoles, roleFunctionsMap, directory } = ctx;
    const dir = directory;

    if (dir) {
      functionRuntime.setStoreDirectory(dir);
      sessionSignalLedger.setStoreDirectory(dir);
    }
    functionRuntime.recover();
    sessionSignalLedger.recover();
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

    // --- Custom Hook Registry ---
    this.customHookRegistry = new CustomHookRegistry();

    const dispatchService = ctx.core.getService<DispatchService>("dispatch-service")!;
    const dispatchManager = dispatchService.getDispatchManager();

    this.customHookRegistry.setDeps({
      pendingCorrections: hookState.pendingCorrections,
      functionRuntime,
      dispatchManager,
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
    const toolService = ctx.core.getService<ToolService>("tool-service")!;

    const roleMap = new Map(resolvedRoles.map((r) => [r.id, r]));

    // Unified turn-end pipeline deps: per-role parsed copilot config + the
    // resolved-subagent registry (LLM-role verdict source). Both derived at
    // assembly so the idle path never re-parses config per event.
    const copilotConfigs = new Map<string, CopilotConfig>();
    for (const resolved of resolvedRoles) {
      copilotConfigs.set(resolved.id, parseCopilotConfig(resolved.config.copilot));
    }

    this.deps = {
      session: ctx.session,
      roleFunctionsMap,
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
      copilotConfigs,
      // Optional-call guard: dispatch services assembled before this subtask
      // (or mocks in tests) may not expose getResolvedSubagents(). Absent →
      // the LLM-role verdict source is skipped (HookDeps.resolvedSubagents is
      // optional by contract).
      resolvedSubagents: dispatchService.getResolvedSubagents?.() ?? undefined,
    };
    log.debug("HookDeps assembled", { tools: Object.keys(toolService.getTools()).length });

    // --- Build handlers ---
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

  /**
   * Extract the session id from a canonical event's properties bag, following
   * the opencode SDK property shapes: direct `sessionID` / `sessionId`, then
   * the `info` object's `sessionID` / `sessionId` / `id`.
   */
  private static extractEventSessionId(
    props: Record<string, unknown> | undefined,
  ): string | undefined {
    if (typeof props?.sessionID === "string") return props.sessionID;
    if (typeof props?.sessionId === "string") return props.sessionId;
    const info = props?.info as Record<string, unknown> | undefined;
    if (typeof info?.sessionID === "string") return info.sessionID;
    if (typeof info?.sessionId === "string") return info.sessionId;
    if (typeof info?.id === "string") return info.id;
    return undefined;
  }

  private buildHandlers(tools: Record<string, any>, bus: EventBus, resolvedRoles: any[]) {
    const deps = this.deps!;
    const handlers = {
      tool: tools,
      event: async (input: { event: unknown }) => {
        const canonical = normalizeOpencodeEvent(input.event);
        await handleEvent(canonical, hookState, deps);
        // Emit to bus for notification and other subscribers
        const props = canonical.properties;
        const sessionID = HookService.extractEventSessionId(props);
        const agent = typeof props?.agent === "string" ? props.agent : undefined;
        if (sessionID) {
          await bus.emit(`event:${canonical.type}`, { sessionID, agent, properties: props });
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
            cfg.agent[sub.id] = subAgentCfg as RoleboxAgentConfig;
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
    } satisfies Hooks;
    return handlers;
  }
}
