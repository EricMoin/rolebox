/**
 * PlatformCapabilities — declares what the host platform supports.
 *
 * Used for graceful degradation: features check capabilities before
 * attempting operations the platform may not support.
 */

export interface PlatformCapabilities {
  /** Platform supports background/async task dispatch. */
  hasBackgroundTasks: boolean;
  /** Platform supports session forking/branching. */
  hasSessionFork: boolean;
  /** Platform supports session creation (spawning new sessions). */
  hasSessionCreate: boolean;
  /** Platform supports session abort. */
  hasSessionAbort: boolean;
  /** Platform supports persistent agent file registration. */
  hasAgentFileSync: boolean;
  /** Platform supports multi-step tool execution (tool chaining). */
  hasMultiStepTools: boolean;
  /** Platform supports event streaming. */
  hasEventStream: boolean;
  /** Platform supports session status polling. */
  hasSessionStatus: boolean;
  /** Platform identifier for logging and diagnostics. */
  platformId: string;
}

/**
 * Default capabilities for the opencode platform.
 * All features are supported.
 */
export function defaultCapabilities(): PlatformCapabilities {
  return {
    hasBackgroundTasks: true,
    hasSessionFork: true,
    hasSessionCreate: true,
    hasSessionAbort: true,
    hasAgentFileSync: true,
    hasMultiStepTools: true,
    hasEventStream: true,
    hasSessionStatus: true,
    platformId: "opencode",
  };
}

/**
 * Minimal capabilities for platforms with limited support.
 * Use as a starting point for new platform adapters.
 */
export function minimalCapabilities(platformId: string): PlatformCapabilities {
  return {
    hasBackgroundTasks: false,
    hasSessionFork: false,
    hasSessionCreate: false,
    hasSessionAbort: false,
    hasAgentFileSync: false,
    hasMultiStepTools: true,
    hasEventStream: false,
    hasSessionStatus: false,
    platformId,
  };
}

/**
 * Capabilities for the Pi coding agent platform (pi.dev).
 * Supports event streaming and multi-step tools, but not background
 * dispatch, session management, or agent file sync.
 */
export function piCapabilities(): PlatformCapabilities {
  return {
    hasBackgroundTasks: true,
    hasSessionFork: false,
    hasSessionCreate: false,
    hasSessionAbort: true,
    hasAgentFileSync: false,
    hasMultiStepTools: true,
    hasEventStream: true,
    hasSessionStatus: true,
    platformId: "pi",
  };
}
