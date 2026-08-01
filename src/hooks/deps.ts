import type { ISessionClient } from "../platform/ports/session-client.ts";
import type { ResolvedFunction, ResolvedGraph, ResolvedRole } from "../types.ts";
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
  roleGraphMap: Map<string, ResolvedGraph>;
  roleMap: Map<string, ResolvedRole>;
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
   * Optional graph-toolset query surface (subtask 2): lets idle/continue
   * handlers ask whether the invoking session still owns in-flight graphs
   * before auto-continuing. Backed by the SAME GraphToolSet instance that
   * powers the `graph_*` tools (assembled by tool-service on opencode /
   * PiLightweightServiceStack on Pi). Optional for backward compatibility —
   * absent on platforms/setups that do not assemble graph tools.
   */
  graphTools?: { hasInflightGraphsForSession(sessionID: string): boolean };
}
