import type { PluginInput } from "@opencode-ai/plugin";
import type { ResolvedRole, ResolvedFunction, ResolvedGraph } from "./types.ts";
import { hookState } from "./hooks/state.ts";
import { normalizeWorkspaceDir } from "./state-paths.ts";
import { graphSessionState } from "./graph/index.ts";
import { functionRuntime } from "./function/runtime-state.ts";
import { createSubLogger } from "./logger.ts";
import { PluginCore } from "./core/plugin-core.ts";
import { HotReloadService } from "./core/hot-reload-service.ts";
import { DispatchService } from "./core/dispatch-service.ts";
import { LoopService } from "./core/loop-service.ts";
import { LspService } from "./core/lsp-service.ts";
import { NotificationService } from "./core/notification-service.ts";
import { SessionService } from "./core/session-service.ts";
import { RecoveryService } from "./core/recovery-service.ts";
import { ExtensionService } from "./core/extension-service.ts";
import { ToolService } from "./core/tool-service.ts";
import { HookService } from "./core/hook-service.ts";
import { HealthMonitorService } from "./core/health-monitor-service.ts";

const log = createSubLogger("plugin-hooks");

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

export async function createPluginHooks(
  resolvedRoles: ResolvedRole[],
  client: PluginInput["client"],
  roleFunctionsMap: Map<string, ResolvedFunction[]>,
  roleGraphMap: Map<string, ResolvedGraph>,
  directory?: string,
) {
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

  await core.init({ client, resolvedRoles, roleFunctionsMap, roleGraphMap, rawDirectory: rawDir, directory: dir, core, bus: core.getBus() });

  // Register sync shutdown handlers (async disposal is fire-and-forget)
  if (!hookState.shutdownRegistered) {
    hookState.shutdownRegistered = true;
    const flushAllSync = () => {
      for (const [d, mgr] of hookState.loopManagerMap) {
        try { hookState.loopStoreMap.get(d)?.saveSync(mgr.getAllLoopStates()); } catch {}
        mgr.dispose();
      }
      core.getService<DispatchService>("dispatch-service")?.getDispatchManager().flushPersistSync();
      if (directory) { graphSessionState.flushSync(); functionRuntime.flushSync(); }
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

  return core.getService<HookService>("hook-service")!.getHandlers()!;
}
