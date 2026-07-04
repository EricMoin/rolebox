import type { PluginInput } from "@opencode-ai/plugin";
import type { ResolvedRole, ResolvedFunction, ResolvedGraph } from "../types.ts";
import type { PluginCoreLike } from "./service.ts";
import type { EventBus } from "./event-bus.ts";

/**
 * Context passed to every PluginService's init() method.
 * Carries everything a service needs to initialize, plus a reference
 * to the PluginCore itself for inter-service lookups.
 */
export interface PluginContext {
  /** The opencode plugin client. */
  client: PluginInput["client"];
  /** All resolved roles. */
  resolvedRoles: ResolvedRole[];
  /** Map of roleId → resolved functions (shared with index.ts). */
  roleFunctionsMap: Map<string, ResolvedFunction[]>;
  /** Map of roleId → resolved collaboration graph. */
  roleGraphMap: Map<string, ResolvedGraph>;
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
}
