import type { DispatchManager } from "../dispatch/manager.ts";
import type { LoopManager } from "../loop/manager.ts";
import type { LoopCoordinator } from "../loop/coordinator.ts";

export class HookState {
  // Keyed by raw directory path
  readonly managerMap = new Map<string, DispatchManager>();
  readonly loopManagerMap = new Map<string, LoopManager | LoopCoordinator>();

  activeLoopManager: LoopManager | LoopCoordinator | undefined;

  // Keyed by sessionID
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
