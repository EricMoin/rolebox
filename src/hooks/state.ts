import type { DispatchManager } from "../dispatch/manager.ts";
import type { LoopCoordinator } from "../loop/coordinator.ts";
import type { LoopStore } from "../loop/loop-store.ts";

export class HookState {
  // Keyed by raw directory path — kept for backward compat (backed by service static caches)
  readonly managerMap = new Map<string, DispatchManager>();
  readonly loopManagerMap = new Map<string, LoopCoordinator>();
  readonly loopStoreMap = new Map<string, LoopStore>();

  activeLoopManager: LoopCoordinator | undefined;

  // Keyed by sessionID — hook-owned session state
  readonly pendingCorrections = new Map<string, string>();
  readonly userMessagedSessions = new Set<string>();
  readonly sessionAgentRegistry = new Map<string, string>();

  // Keyed by roleId
  readonly roleAutoActivateMap = new Map<string, string[]>();
  readonly roleLockedMap = new Map<string, boolean>();

  readonly autoActivatedSessions = new Set<string>();
  shutdownRegistered = false;
}

export const hookState = new HookState();
