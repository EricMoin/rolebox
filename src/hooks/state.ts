import type { DispatchManager } from "../dispatch/manager.ts";
import type { LoopCoordinator } from "../loop/coordinator.ts";
import type { LoopStore } from "../loop/loop-store.ts";
import type { CustomHookRegistry } from "./custom/registry.ts";
import type { RecoveryEngine } from "../recovery/engine.ts";
import type { BuiltInHookRegistry } from "../recovery/builtin/registry.ts";
import type { NotificationManager } from "../notifications/manager.ts";

export class HookState {
  // Keyed by raw directory path
  readonly managerMap = new Map<string, DispatchManager>();
  readonly loopManagerMap = new Map<string, LoopCoordinator>();
  readonly loopStoreMap = new Map<string, LoopStore>();

  activeLoopManager: LoopCoordinator | undefined;

  // Keyed by sessionID
  readonly pendingCorrections = new Map<string, string>();
  readonly userMessagedSessions = new Set<string>();
  readonly sessionAgentRegistry = new Map<string, string>();

  // Keyed by roleId
  readonly roleAutoActivateMap = new Map<string, string[]>();
  readonly roleLockedMap = new Map<string, boolean>();

  readonly autoActivatedSessions = new Set<string>();
  shutdownRegistered = false;

  customHookRegistry: CustomHookRegistry | undefined;
  recoveryEngine?: RecoveryEngine;
  builtInHookRegistry?: BuiltInHookRegistry;
  notificationManager?: NotificationManager;
  builtinConfig?: Record<string, boolean>;
}

export const hookState = new HookState();
