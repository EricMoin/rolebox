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
  /** Platform supports in-session active-role switching (Pi role switcher). */
  hasRoleSwitch: boolean;
  /** Platform identifier for logging and diagnostics. */
  platformId: string;
}

/**
 * Capabilities for the opencode platform — the reference host, where every
 * host-integration feature except in-session role switching is available.
 *
 * Deliberately NOT named "default": no host inherits this set by omission.
 */
export function opencodeCapabilities(): PlatformCapabilities {
  return {
    hasBackgroundTasks: true,
    hasSessionFork: true,
    hasSessionCreate: true,
    hasSessionAbort: true,
    hasAgentFileSync: true,
    hasMultiStepTools: true,
    hasEventStream: true,
    hasSessionStatus: true,
    hasRoleSwitch: false,
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
    hasRoleSwitch: false,
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
    hasRoleSwitch: true,
    platformId: "pi",
  };
}

/**
 * Capabilities declared for the dsh platform. Values reflect what the dsh
 * adapters actually support (session fork/create/status via the SessionStore
 * adapter; event streaming via the event bus; in-session active-role
 * switching via the DshRoleSwitcher + the `/rolebox` host routes). Currently
 * advisory — `buildCanonicalTools` documents that capabilities are "not
 * consulted in Phase 1 tool assembly" — but kept honest for future consumers.
 */
export function dshCapabilities(): PlatformCapabilities {
  return {
    platformId: "dsh",
    hasBackgroundTasks: false,
    hasSessionFork: true,
    hasSessionCreate: true,
    hasSessionAbort: false,
    hasAgentFileSync: false,
    hasMultiStepTools: true,
    hasEventStream: true,
    hasSessionStatus: true,
    hasRoleSwitch: true,
  };
}

/**
 * Capabilities for the Codex platform.
 *
 * Codex drives rolebox over MCP only — a plugin bundle registering rolebox's
 * MCP server — so every host-integration capability is absent except
 * multi-step tool execution, which the MCP tool surface provides. That is
 * exactly {@link minimalCapabilities}'s shape, so this delegates instead of
 * duplicating a block that could drift.
 */
export function codexCapabilities(): PlatformCapabilities {
  return minimalCapabilities("codex");
}

/**
 * Capabilities declared for the opencode **v2** plugin surface
 * (`@opencode/plugin@2.0.18`, consumed by `src/entries/opencode2.ts`).
 *
 * `platformId` stays `"opencode"` on purpose: v2 is the same product family —
 * the same config directory (`~/.config/opencode`), the same global skills
 * directory and the same model catalog — so a v2-specific id would silently
 * change path resolution (`resolveRoleboxDirectories`, src/platform/factory.ts:89)
 * and model resolution (`initModelResolver`, src/core/services/hot-reload-service.ts:305)
 * for no benefit. Platform paths and the capability set are resolved
 * independently, so sharing the id does not claim v1's capabilities: the entry
 * passes this set explicitly (`createPluginHooks({ capabilities })`).
 *
 * Every flag is set from the published 2.0.18 declarations, not from v1:
 *
 *  - `hasSessionFork: false` — the v2 plugin session domain is a `Pick` of the
 *    HTTP client and does not include `fork`; it lists create/get/switchAgent/
 *    switchModel/prompt/generate/command/synthetic/interrupt/update/move/wait/
 *    context only (node_modules/@opencode/plugin/dist/promise/session.d.ts:143-145).
 *  - `hasSessionStatus: false` — the same `Pick` exposes no `status` call, so a
 *    session's busy/idle state cannot be polled; `session.status` still arrives
 *    on the event stream (`hasEventStream`).
 *  - `hasAgentFileSync: false` — v2 agents are registered in-process through
 *    `ctx.agent.transform` → `AgentEditor.update(id, fn)`, and the editor has no
 *    `add` (…/promise/agent.d.ts:5-11): there is no agent FILE to write or read
 *    back, so the v1 file registrar (`OpencodeAgentRegistrar`) is not used.
 *  - `hasRoleSwitch: false` — v2 exposes no in-session role switcher surface
 *    (no host routes; `ctx.session.switchAgent` switches the running agent
 *    programmatically, it does not offer the user a role picker), so rolebox's
 *    Pi-only role switcher stays off.
 *
 * The `true` flags: `hasSessionCreate` (`session.create`, which
 * DispatchService gates on — src/core/services/dispatch-service.ts:79-86),
 * `hasSessionAbort` (`session.interrupt`), `hasBackgroundTasks` (dispatch runs
 * on rolebox's own background tasks over `session.prompt`),
 * `hasMultiStepTools` (`ctx.tool.transform` registers tools with a promise
 * `execute` — src/platform/adapters/opencode2/tool-factory.ts:120-169) and
 * `hasEventStream` (`ctx.event.subscribe()` yields an `AsyncIterable` of v2
 * events — …/promise/event.d.ts:2-3).
 */
export function opencodeV2Capabilities(): PlatformCapabilities {
  return {
    platformId: "opencode",
    hasSessionCreate: true,
    hasSessionAbort: true,
    hasBackgroundTasks: true,
    hasMultiStepTools: true,
    hasEventStream: true,
    hasSessionFork: false,
    hasSessionStatus: false,
    hasAgentFileSync: false,
    hasRoleSwitch: false,
  };
}
