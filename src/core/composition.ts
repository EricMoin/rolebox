import type { Hooks } from "@opencode-ai/plugin";
import type { ResolvedRole, ResolvedFunction } from "../types.ts";
import type { ISessionClient } from "../platform/ports/session-client.ts";
import type { PlatformCapabilities } from "../platform/capabilities.ts";
import type { CanonicalToolDef } from "../platform/types.ts";
import { resolvePlatformCapabilities } from "../platform/registry.ts";
import { hookState } from "../hooks/state.ts";
import { normalizeWorkspaceDir } from "../utils/state-paths.ts";
import { functionRuntime } from "../function/runtime-state.ts";
import { sessionSignalLedger } from "../signal/session-signal-ledger.ts";
import { createSubLogger } from "../logger.ts";
import { logEvent } from "../log/index.ts";
import { PluginCore } from "./plugin-core.ts";
import { SERVICE_NAMES } from "./service-names.ts";
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
import { ProcessFatalReporter } from "./process-fatal-reporter.ts";

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
 * `tool` must be a usable (empty) tool map. The key set is checked against the
 * host's `Hooks` contract (`satisfies Hooks`), so a renamed or removed
 * opencode hook key fails the build instead of silently degrading to a no-op.
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
  } satisfies Hooks;
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
  directory?: string;
  roleboxDir?: string;
  globalSkillsDir?: string;
  configDir?: string;
  builtinDir?: string;
  /**
   * Explicit capability declaration for the host that owns this entry.
   * Preferred over `platformId`: the entry knows what its platform supports.
   */
  capabilities?: PlatformCapabilities;
  /**
   * Platform id used to resolve `capabilities` when they are not declared.
   * An unknown or omitted id resolves to the minimal set (with a warning) —
   * never to opencode's.
   */
  platformId?: string;
  /**
   * Declared-graph tool face assembled by the host's own outcome capability
   * layer. Forwarded to the context so the tool service registers `graph_*`
   * tools; absent means the host has no such layer and registers none.
   */
  outcomeGraphTools?: Record<string, CanonicalToolDef>;
  isGraphWorker?: (sessionID: string) => boolean;
}

export async function createPluginHooks(config: CreatePluginHooksConfig) {
  const { resolvedRoles, session, roleFunctionsMap, directory, roleboxDir, globalSkillsDir, configDir, builtinDir, outcomeGraphTools } = config;
  const rawDir = directory ?? process.cwd();
  const dir = normalizeWorkspaceDir(rawDir);
  const capabilities =
    config.capabilities ?? resolvePlatformCapabilities(config.platformId);

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

  await core.init({ session, resolvedRoles, roleFunctionsMap, rawDirectory: rawDir, directory: dir, capabilities, outcomeGraphTools, isGraphWorker: config.isGraphWorker, core, bus: core.getBus(), roleboxDir, globalSkillsDir, configDir, builtinDir });

  // Register sync shutdown handlers (async disposal is fire-and-forget). The
  // flush is hoisted out of the guard so the process-fatal reporter below
  // reuses exactly the same synchronous path.
  const flushAllSync = () => {
    for (const [d, mgr] of hookState.loopManagerMap) {
      try { hookState.loopStoreMap.get(d)?.saveSync(mgr.getAllLoopStates()); } catch (err) { log.warn("flushAllSync saveSync failed for directory", d, err); }
      mgr.dispose();
    }
    core.getService<DispatchService>(SERVICE_NAMES.dispatch)?.flushPersistSync();
    if (directory) { functionRuntime.flushSync(); sessionSignalLedger.flushSync(); }
    void core.dispose(); // fire-and-forget for async service disposal
  };
  if (!hookState.shutdownRegistered) {
    hookState.shutdownRegistered = true;
    process.on("exit", () => flushAllSync());
    process.on("SIGINT", () => { flushAllSync(); process.exit(130); });
    process.on("SIGTERM", () => { flushAllSync(); process.exit(143); });
    // Process-fatal reporter: on uncaughtException/unhandledRejection it flushes
    // rolebox state and writes ONE log entry. An `unhandledRejection` is
    // observe-only by default; a SOLE-OWNER `uncaughtException` additionally
    // exits 1 — the status the runtime itself would have used, and the one this
    // listener would otherwise have suppressed, so a crashed process cannot keep
    // running. Installed once per process; see ProcessFatalReporter for the
    // listener-count rule and the opt-outs.
    new ProcessFatalReporter({ flush: flushAllSync }).install();
  }

  const loopService = core.getService<LoopService>(SERVICE_NAMES.loop);
  if (loopService) {
    hookState.activeLoopManager = loopService.getLoopManager();
    activeLoopManager = loopService.getLoopManager();
  }

  const hookService = core.getService<HookService>(SERVICE_NAMES.hook);
  if (!hookService) {
    // hook-service was never registered — unexpected in this composition (it is
    // always registered), but never return undefined to opencode.
    logEvent("plugin-hooks.hook-service-unavailable", {
      degradedServices: listDegradedServices(core),
    });
    return buildNoOpHandlers();
  }

  const handlers = hookService.getHandlers();
  if (!handlers || Object.keys(handlers).length === 0) {
    // hook-service was skipped or degraded (init never ran, so its handler
    // wrapper is empty). Log the degraded service chain and fall back to no-op
    // handlers — never return undefined, which would break opencode's hook
    // registration.
    logEvent("plugin-hooks.handlers-uninitialized", {
      degradedServices: listDegradedServices(core),
      failedServiceChain: [SERVICE_NAMES.hook, ...listDegradedServices(core)],
    });
    return buildNoOpHandlers();
  }

  return handlers;
}
