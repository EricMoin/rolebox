import type { ResolvedRole, ResolvedFunction, ResolvedGraph } from "../types.ts";
import type { ISessionClient } from "../platform/ports/session-client.ts";
import { hookState } from "../hooks/state.ts";
import { normalizeWorkspaceDir } from "../utils/state-paths.ts";
import { graphSessionState } from "../graph/collaboration-state.ts";
import { functionRuntime } from "../function/runtime-state.ts";
import { sessionSignalLedger } from "../signal/session-signal-ledger.ts";
import { createSubLogger } from "../logger.ts";
import { PluginCore } from "./plugin-core.ts";
import { HotReloadService } from "./services/hot-reload-service.ts";
import { DispatchService } from "./services/dispatch-service.ts";
import { LoopService } from "./services/loop-service.ts";
import { LspService } from "./services/lsp-service.ts";
import { NotificationService } from "./services/notification-service.ts";
import { SessionService } from "./services/session-service.ts";
import { RecoveryService } from "./services/recovery-service.ts";
import { ExtensionService } from "./services/extension-service.ts";
import { ToolService } from "./services/tool-service.ts";
import { HookService } from "./services/hook-service.ts";
import { HealthMonitorService } from "./services/health-monitor-service.ts";

const log = createSubLogger("plugin-hooks");

/**
 * List the names of every service PluginCore marked as degraded during init.
 * A service lands here when it declares a degraded dependency or its optional
 * init threw — see PluginCore.init (src/core/plugin-core.ts:78-105).
 */
function listDegradedServices(core: PluginCore): string[] {
  const degraded: string[] = [];
  for (const name of core.getServices().keys()) {
    if (core.isDegraded(name)) degraded.push(name);
  }
  return degraded;
}

/**
 * Minimal no-op hook handlers returned when HookService is unavailable (never
 * initialized because a dependency was degraded, or its handler assembly was
 * skipped). Keeping opencode alive beats a hard crash on startup; the genuine
 * diagnostic is the error log emitted by the caller, not a thrown Error that
 * would take the whole plugin (and server) down. Never return undefined —
 * opencode iterates the handler map, so absent keys must be real no-ops and
 * `tool` must be a usable (empty) tool map.
 */
function buildNoOpHandlers(): Record<string, unknown> {
  const noop = async () => {};
  return {
    tool: {},
    event: noop,
    config: noop,
    "chat.message": noop,
    "tool.execute.after": noop,
    "tool.execute.before": noop,
    "experimental.chat.system.transform": noop,
    "experimental.session.compacting": noop,
    dispose: noop,
  };
}

// Re-exports backed by hookState (unchanged — consumers import these directly)
export const managerMap = hookState.managerMap;
export const loopManagerMap = hookState.loopManagerMap;
export const pendingCorrections = hookState.pendingCorrections;
export const userMessagedSessions = hookState.userMessagedSessions;
export const sessionAgentRegistry = hookState.sessionAgentRegistry;
export const autoActivatedSessions = hookState.autoActivatedSessions;
export const roleAutoActivateMap = hookState.roleAutoActivateMap;
export const roleLockedMap = hookState.roleLockedMap;
export let activeLoopManager = hookState.activeLoopManager;

/**
 * Configuration for creating plugin hooks.
 * Groups all initialization parameters into a single named object.
 */
export interface CreatePluginHooksConfig {
  resolvedRoles: ResolvedRole[];
  session: ISessionClient;
  roleFunctionsMap: Map<string, ResolvedFunction[]>;
  roleGraphMap: Map<string, ResolvedGraph>;
  directory?: string;
  roleboxDir?: string;
  globalSkillsDir?: string;
  configDir?: string;
  builtinDir?: string;
}

export async function createPluginHooks(config: CreatePluginHooksConfig) {
  const { resolvedRoles, session, roleFunctionsMap, roleGraphMap, directory, roleboxDir, globalSkillsDir, configDir, builtinDir } = config;
  const rawDir = directory ?? process.cwd();
  const dir = normalizeWorkspaceDir(rawDir);

  for (const resolved of resolvedRoles) {
    if (resolved.config.auto_activate?.length) {
      hookState.roleAutoActivateMap.set(resolved.id, resolved.config.auto_activate);
    }
    if (resolved.locked !== undefined) {
      hookState.roleLockedMap.set(resolved.id, resolved.locked);
    }
  }

  const core = new PluginCore();
  core.registerService(new HotReloadService());
  core.registerService(new DispatchService());
  core.registerService(new LoopService());
  core.registerService(new LspService());
  core.registerService(new NotificationService());
  core.registerService(new SessionService());
  core.registerService(new RecoveryService());
  core.registerService(new ExtensionService());
  core.registerService(new ToolService());
  core.registerService(new HookService());
  core.registerService(new HealthMonitorService());

  await core.init({ session, resolvedRoles, roleFunctionsMap, roleGraphMap, rawDirectory: rawDir, directory: dir, core, bus: core.getBus(), roleboxDir, globalSkillsDir, configDir, builtinDir });

  // Register sync shutdown handlers (async disposal is fire-and-forget)
  if (!hookState.shutdownRegistered) {
    hookState.shutdownRegistered = true;
    const flushAllSync = () => {
      for (const [d, mgr] of hookState.loopManagerMap) {
        try { hookState.loopStoreMap.get(d)?.saveSync(mgr.getAllLoopStates()); } catch (err) { log.warn("flushAllSync saveSync failed for directory", d, err); }
        mgr.dispose();
      }
      core.getService<DispatchService>("dispatch-service")?.getDispatchManager().flushPersistSync();
      if (directory) { graphSessionState.flushSync(); functionRuntime.flushSync(); sessionSignalLedger.flushSync(); }
      void core.dispose(); // fire-and-forget for async service disposal
    };
    process.on("exit", () => flushAllSync());
    process.on("SIGINT", () => { flushAllSync(); process.exit(130); });
    process.on("SIGTERM", () => { flushAllSync(); process.exit(143); });
  }

  const loopService = core.getService<LoopService>("loop-service");
  if (loopService) {
    hookState.activeLoopManager = loopService.getLoopManager();
    activeLoopManager = loopService.getLoopManager();
  }

  const hookService = core.getService<HookService>("hook-service");
  if (!hookService) {
    // hook-service was never registered — unexpected in this composition (it is
    // always registered), but never return undefined to opencode.
    log.error(
      "hook-service unavailable (not registered); returning no-op handlers to keep opencode alive",
      { degradedServices: listDegradedServices(core) },
    );
    return buildNoOpHandlers();
  }

  const handlers = hookService.getHandlers();
  if (!handlers || Object.keys(handlers).length === 0) {
    // hook-service was skipped or degraded (init never ran, so its handler
    // wrapper is empty). Log the degraded service chain and fall back to no-op
    // handlers — never return undefined, which would break opencode's hook
    // registration.
    log.error(
      "hook-service unavailable: handlers not initialized (degraded or skipped init); returning no-op handlers to keep opencode alive",
      {
        degradedServices: listDegradedServices(core),
        failedServiceChain: ["hook-service", ...listDegradedServices(core)],
      },
    );
    return buildNoOpHandlers();
  }

  return handlers;
}
