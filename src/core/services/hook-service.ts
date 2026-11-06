import type { PluginService, ServiceHealth } from "../service.ts";
import { SERVICE_NAMES, type ServiceName } from "../service-names.ts";
import type { PluginContext } from "../context.ts";
import type { EventBus } from "../event-bus.ts";
import type { CanonicalEvent, CanonicalEventType } from "../../platform/types.ts";
import { functionRuntime } from "../../function/runtime-state.ts";
import { sessionSignalLedger } from "../../signal/session-signal-ledger.ts";
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
import type { DispatchService } from "./dispatch-service.ts";
import type { LoopService } from "./loop-service.ts";
import type { NotificationService } from "./notification-service.ts";
import type { RecoveryService } from "./recovery-service.ts";
import type { ExtensionService } from "./extension-service.ts";
import type { ToolService } from "./tool-service.ts";

const log = createSubLogger(SERVICE_NAMES.hook);

export class HookService implements PluginService {
  readonly name: ServiceName = SERVICE_NAMES.hook;
  readonly dependencies: readonly ServiceName[] = [
    SERVICE_NAMES.dispatch,
    SERVICE_NAMES.loop,
    SERVICE_NAMES.notification,
    SERVICE_NAMES.recovery,
    SERVICE_NAMES.extension,
    SERVICE_NAMES.tool,
  ];

  private customHookRegistry?: CustomHookRegistry;
  private deps?: HookDeps;
  private handlers?: Record<string, unknown>;
  /** The context of the last init(), read by the event handler (normalizer). */
  private ctx?: PluginContext;
  /** One-time warning flag for a host that supplied no event normalizer. */
  private warnedMissingNormalizer = false;
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
    this.ctx = ctx;

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

    const dispatchService = ctx.core.getService<DispatchService>(SERVICE_NAMES.dispatch)!;
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
    const loopService = ctx.core.getService<LoopService>(SERVICE_NAMES.loop)!;
    const recoveryService = ctx.core.getService<RecoveryService>(SERVICE_NAMES.recovery);
    const extensionService = ctx.core.getService<ExtensionService>(SERVICE_NAMES.extension);
    const notificationService = ctx.core.getService<NotificationService>(SERVICE_NAMES.notification);
    const toolService = ctx.core.getService<ToolService>(SERVICE_NAMES.tool)!;

    const roleMap = new Map(resolvedRoles.map((r) => [r.id, r]));

    this.deps = {
      session: ctx.session,
      roleFunctionsMap,
      roleMap,
      isGraphWorker: ctx.isGraphWorker,
      dir,
      dispatchManager,
      loopManager: loopService.getLoopManager(),
      customHooks: this.customHookRegistry,
      recoveryEngine: recoveryService?.getRecoveryEngine(),
      builtInHooks: recoveryService?.getBuiltInHookRegistry(),
      notificationManager: notificationService?.getNotificationManager(),
      extensionRegistry: extensionService?.getExtensionRegistry(),
      builtinConfig: recoveryService?.getBuiltinConfig(),
      // Resolved subagent registry retained for host adapters that assemble
      // it; the turn-end pipeline no longer consumes it.
      resolvedSubagents: dispatchService.getResolvedSubagents?.() ?? undefined,
    };
    log.debug("HookDeps assembled", { tools: Object.keys(toolService.getTools()).length });

    // --- Build handlers ---
    const newHandlers = this.buildHandlers(toolService.getTools(), ctx.bus);

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

  getHandlers(): Record<string, unknown> {
    return this.handlersWrapper;
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

  private buildHandlers(tools: Record<string, any>, bus: EventBus) {
    const deps = this.deps!;
    const handlers = {
      tool: tools,
      event: async (input: { event: unknown }) => {
        // The host owns the native→canonical event vocabulary and supplies it
        // through the context. Without it there is no truthful translation, so
        // skip the event instead of inventing one; one warning is enough for
        // the whole stream.
        const normalize = this.ctx?.normalizeEvent;
        if (!normalize) {
          if (!this.warnedMissingNormalizer) {
            this.warnedMissingNormalizer = true;
            log.warn("Host supplied no event normalizer — skipping hook event handling");
          }
          return;
        }
        const canonical = normalize(input.event);
        await handleEvent(canonical, hookState, deps);
        // Emit to bus for notification and other subscribers
        const props = canonical.properties;
        const sessionID = HookService.extractEventSessionId(props);
        const agent = typeof props?.agent === "string" ? props.agent : undefined;
        if (sessionID) {
          await bus.emit(`event:${canonical.type}`, { sessionID, agent, properties: props });
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

  health(): ServiceHealth {
    // opencode drives this service only through the stable handlers wrapper
    // (getHandlers()), so an empty wrapper means the whole hook surface is inert.
    if (!this.deps || Object.keys(this.handlersWrapper).length === 0) {
      return { status: "unhealthy", detail: "hook handlers not assembled" };
    }
    return { status: "healthy" };
  }
}
