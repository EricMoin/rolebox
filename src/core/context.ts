import type { ResolvedRole, ResolvedFunction } from "../types.ts";
import type { PluginCoreLike } from "./service.ts";
import type { EventBus } from "./event-bus.ts";
import type { PlatformCapabilities } from "../platform/capabilities.ts";
import type { ISessionClient } from "../platform/ports/session-client.ts";
import type { CanonicalToolDef } from "../platform/types.ts";

/**
 * Context passed to every PluginService's init() method.
 * Carries everything a service needs to initialize, plus a reference
 * to the PluginCore itself for inter-service lookups.
 */
export interface PluginContext {
  /** Platform-agnostic session client adapter. */
  session: ISessionClient;
  /** All resolved roles. */
  resolvedRoles: ResolvedRole[];
  /** Map of roleId → resolved functions (shared with index.ts). */
  roleFunctionsMap: Map<string, ResolvedFunction[]>;
  /** The working directory as passed in (un-normalized), used for map keys. */
  rawDirectory: string;
  /** The working directory (normalized via realpath), used for file/state paths. */
  directory: string;
  /** Reference to the PluginCore for inter-service access. */
  core: PluginCoreLike;
  /** The plugin's event bus for inter-service pub/sub. */
  bus: EventBus;
  /** Rolebox role directory path (for hot-reload re-discovery). */
  roleboxDir?: string;
  /** Global skills directory path (for hot-reload skill sync). */
  globalSkillsDir?: string;
  /** OpenCode config directory path (for resolver context). */
  configDir?: string;
  /** Builtin functions directory path (for resolver context). */
  builtinDir?: string;
  /**
   * The declared-graph tool face the owning host assembled from its own
   * outcome capability layer. Absent means the host has no such layer, so no
   * `graph_*` tool is registered (src/platform/tool-assembly.ts:62-74).
   */
  outcomeGraphTools?: Record<string, CanonicalToolDef>;
  isGraphWorker?: (sessionID: string) => boolean;
  /** Platform capabilities for feature detection and graceful degradation.
   * Always present: the composition layer resolves the entry's explicit
   * declaration (or its platformId) BEFORE constructing the context, so an
   * undeclared host degrades to the minimal set instead of silently
   * claiming full opencode support. */
  capabilities: PlatformCapabilities;
}
