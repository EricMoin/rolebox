import type { PluginService } from "../service.ts";
import type { PluginContext } from "../context.ts";
import type { EventBus } from "../event-bus.ts";
import type { Config } from "@opencode-ai/plugin";
import { normalizeOpencodeEvent } from "../../platform/adapters/opencode/event-bridge.ts";
import type { CanonicalEvent } from "../../platform/types.ts";
import type { GraphToolSet } from "../../graph/tools/index.ts";
import { graphSessionState } from "../../graph/collaboration-state.ts";
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
import type { JudgeFn } from "../../graph/termination-async.ts";
import type { ResolvedSubAgent } from "../../types.ts";
import type { DispatchService } from "./dispatch-service.ts";
import type { LoopService } from "./loop-service.ts";
import type { NotificationService } from "./notification-service.ts";
import type { RecoveryService } from "./recovery-service.ts";
import type { ExtensionService } from "./extension-service.ts";
import type { ToolService } from "./tool-service.ts";
import { withTimeout, DEFAULT_TIMEOUT_MS } from "../../utils/timeout.ts";
import { parseCopilotConfig } from "../../copilot/config.ts";
import type { CopilotConfig } from "../../copilot/types.ts";

const log = createSubLogger("hook-service");

/**
 * Canonical activity event types that refresh the owning graph node's liveness
 * heartbeat (the opencode analog of the Pi liveness relay's `heartbeatOn`
 * subscriptions in pi-extension.ts:1117-1167). Each maps genuine session
 * activity — tool-call parts, streaming part updates, message updates, a
 * finished turn — to `recordLivenessHeartbeat(nodeId, "session")` via the
 * GraphToolSet's `sessionId → nodeId` reverse index.
 */
const LIVENESS_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  "part.created",
  "part.updated",
  "message.updated",
  "session.idle",
]);

/**
 * Minimum interval (ms) between liveness heartbeats for one session. The
 * opencode `event` hook fires for every SDK event in the runtime (streaming
 * text deltas can arrive dozens of times per second); the liveness monitor
 * only needs a heartbeat within its warn window (default 60 s), so relaying
 * every event would be pure churn. Keyed off the last EMITTED timestamp, the
 * first event after any silence longer than the interval always emits
 * immediately — a long-running but active subagent keeps refreshing its node.
 */
const LIVENESS_HEARTBEAT_INTERVAL_MS = 1_000;

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
  private readonly livenessHeartbeatAt = new Map<string, number>();
  /**
   * Stable reference wrapper returned to opencode. On hot-reload, init()
   * replaces the methods in-place so the external reference stays valid.
   */
  private handlersWrapper: Record<string, unknown> = {};

  async init(ctx: PluginContext): Promise<void> {
    const { resolvedRoles, roleFunctionsMap, roleGraphMap, directory } = ctx;
    const dir = directory;

    // Graph state recovery (original lines 247-252)
    if (dir) {
      graphSessionState.setStoreDirectory(dir);
      functionRuntime.setStoreDirectory(dir);
      sessionSignalLedger.setStoreDirectory(dir);
    }
    graphSessionState.recover((_sessionID, agentId) => roleGraphMap.get(agentId));
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
    // Subtask 2: tool-service owns the single GraphToolSet backing the graph_*
    // tools; its getter supplies the HookDeps `graphTools` in-flight query so
    // the auto-continue path can ask whether the invoking session still owns
    // executing graphs before continuing (same registry as graph_run).
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
      graphTools: toolService.getGraphToolSet(),
      copilotConfigs,
      // Optional-call guard: dispatch services assembled before this subtask
      // (or mocks in tests) may not expose getResolvedSubagents(). Absent →
      // the LLM-role verdict source is skipped (HookDeps.resolvedSubagents is
      // optional by contract).
      resolvedSubagents: dispatchService.getResolvedSubagents?.() ?? undefined,
    };
    log.debug("HookDeps assembled", { graphTools: Boolean(this.deps.graphTools) });

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

  /**
   * Relay genuine session activity into the graph engine's node-liveness
   * machinery (false-positive regression fix for the opencode platform).
   *
   * A graph node dispatches its subagent through the opencode SDK
   * (`session.create`), and that subagent's events — `part.created` /
   * `part.updated` / `message.updated` / `session.idle` — arrive here through
   * the plugin's `event` hook. For each, resolve the owning graph node via
   * the GraphToolSet's `sessionId → nodeId` reverse index (populated at
   * launch when a liveness feed is wired onto the engine — see tool-service)
   * and refresh its heartbeat through the public EngineRuntime surface.
   *
   * Without this relay, `lastActivityAt` freezes at the launch-time
   * `dispatch` heartbeat, so the engine's NodeLivenessMonitor hard-stalls
   * (escalate/timeout) every node whose subagent works longer than the
   * warn+grace deadline (~90 s default) — the confirmed false positive this
   * fixes.
   *
   * The relay is throttled per session (1 s) and fully contained: an unknown
   * session, a detached node, an absent toolset, or a throwing runtime all
   * no-op / log at debug — the hook pipeline must never break on a relay
   * defect.
   */
  private relayLivenessHeartbeat(canonical: CanonicalEvent): void {
    if (!LIVENESS_ACTIVITY_TYPES.has(canonical.type)) return;
    const sessionID = HookService.extractEventSessionId(canonical.properties);
    if (!sessionID) return;
    // The deps contract exposes only the in-flight query surface; the real
    // value is the full GraphToolSet (tool-service threads it). Widen for the
    // liveness owner resolution — safe: the liveness surface is optional on
    // the cast, so a stub toolset (no resolveSessionOwner) no-ops.
    const toolset = this.deps?.graphTools as
      | (GraphToolSet & { hasInflightGraphsForSession(sessionID: string): boolean })
      | undefined;
    if (!toolset?.resolveSessionOwner) return;

    // Per-session throttle (see LIVENESS_HEARTBEAT_INTERVAL_MS). Lazy prune
    // when the map grows so completed sessions cannot accumulate unboundedly.
    const now = Date.now();
    const last = this.livenessHeartbeatAt.get(sessionID) ?? 0;
    if (now - last < LIVENESS_HEARTBEAT_INTERVAL_MS) return;
    if (this.livenessHeartbeatAt.size > 512) {
      for (const [sid, ts] of this.livenessHeartbeatAt) {
        if (now - ts >= LIVENESS_HEARTBEAT_INTERVAL_MS) {
          this.livenessHeartbeatAt.delete(sid);
        }
      }
    }
    this.livenessHeartbeatAt.set(sessionID, now);

    try {
      const owner = toolset.resolveSessionOwner(sessionID);
      if (!owner) return; // unknown / detached session — nothing to heartbeat
      owner.runtime.recordLivenessHeartbeat(owner.nodeId, "session");
    } catch (err) {
      log.debug("liveness: relay error", {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private buildHandlers(tools: Record<string, any>, bus: EventBus, resolvedRoles: any[]) {
    const deps = this.deps!;
    const handlers = {
      tool: tools,
      event: async (input: { event: unknown }) => {
        const canonical = normalizeOpencodeEvent(input.event);
        await handleEvent(canonical, hookState, deps);
        // Node-liveness relay (opencode analog of the Pi relay in
        // pi-extension.ts): genuine subagent session activity refreshes the
        // owning graph node's heartbeat. Without this, a graph node's
        // dispatched subagent would freeze at its launch-time `dispatch`
        // heartbeat and be falsely hard-stalled (escalate/timeout) once it
        // runs past the liveness deadline — opencode subagent sessions ARE
        // observable through this event hook (same server runtime), unlike
        // Pi's separate child processes, so this is the correct intake.
        this.relayLivenessHeartbeat(canonical);
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
