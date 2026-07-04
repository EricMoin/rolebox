import type { PluginContext } from "./context.ts";

/**
 * A service that participates in the plugin lifecycle.
 * Each subsystem (Dispatch, Loop, Notification, etc.) implements this.
 * PluginCore topo-sorts by dependencies and calls init() in order.
 */
export interface PluginService {
  /** Unique service name (e.g. "dispatch-service"). */
  name: string;
  /** Names of services that must init before this one. */
  dependencies: string[];
  /** Called after dependencies are initialized. */
  init(ctx: PluginContext): Promise<void>;
  /** Called on shutdown or hot-reload. Must be safe to call even if init failed. */
  dispose(): Promise<void>;
}

/**
 * Minimal interface that services use to look up other services.
 * This breaks circular imports — services depend on the interface, not the concrete core.
 */
export interface PluginCoreLike {
  getService<T>(name: string): T | undefined;
  getServices(): Map<string, PluginService>;
}
