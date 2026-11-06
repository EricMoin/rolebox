import type { ISessionClient } from "../platform/ports/session-client.ts";
import type { ResolvedFunction, ResolvedRole } from "../types.ts";
import type { DispatchManager } from "../dispatch/core/manager.ts";
import type { LoopCoordinator } from "../loop/coordinator.ts";
import type { CustomHookRegistry } from "./custom/registry.ts";
import type { RecoveryEngine } from "../recovery/engine.ts";
import type { BuiltInHookRegistry } from "../recovery/builtin/registry.ts";
import type { NotificationManager } from "../notifications/manager.ts";
import type { ExtensionRegistry } from "../extensions/registry.ts";

export interface HookDeps {
  /** Platform-agnostic session client. */
  session: ISessionClient;
  roleFunctionsMap: Map<string, ResolvedFunction[]>;
  roleMap: Map<string, ResolvedRole>;
  /** Host-confirmed attempt sessions, including workers recovered after restart. */
  isGraphWorker?: (sessionID: string) => boolean;
  /** Tools registered by this host for the session; absence advertises no computer capabilities. */
  availableTools?: (sessionID: string) => readonly string[];
  dir: string;
  dispatchManager: DispatchManager;
  loopManager: LoopCoordinator;
  customHooks: CustomHookRegistry;
  recoveryEngine?: RecoveryEngine;
  builtInHooks?: BuiltInHookRegistry;
  notificationManager?: NotificationManager;
  extensionRegistry?: ExtensionRegistry;
  builtinConfig?: Record<string, boolean>;
  /**
   * Resolved subagent registry (subagent id → owning parent). Retained for
   * host adapters that assemble it; the turn-end pipeline no longer consumes
   * it.
   */
  resolvedSubagents?: Map<string, { parentFullId: string }>;
}
