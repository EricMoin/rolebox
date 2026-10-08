/** Health status of a service, returned by the optional health() method. */
export interface ServiceHealth {
  status: "healthy" | "degraded" | "unhealthy";
  detail?: string;
}

import type { PluginContext } from "./context.ts";
import type { ServiceName } from "./service-names.ts";

/**
 * A service that participates in the plugin lifecycle.
 * Each subsystem (Dispatch, Loop, Notification, etc.) implements this.
 * PluginCore topo-sorts by dependencies and calls init() in order.
 */
export interface PluginService {
  /** Unique service name from the closed SERVICE_NAMES set (e.g. "dispatch-service"). */
  name: ServiceName;
  /** Names of the services that must be initialized before this one. */
  dependencies: readonly ServiceName[];
  /** Whether this service is critical for plugin operation.
   * When true and init() fails, PluginCore.init() rejects fatally.
   * When false/undefined and init() fails, the service is marked
   * permanently_degraded and its dependents are skipped.
   * Default: false (optional).
   */
  critical?: boolean;
  /** Called after dependencies are initialized. */
  init(ctx: PluginContext): Promise<void>;
  /** Called on shutdown or hot-reload. Must be safe to call even if init failed. */
  dispose(): Promise<void>;
  /** Optional health check. When defined, HealthMonitorService polls it periodically. */
  health?(): ServiceHealth;
}

/**
 * Minimal interface that services use to look up other services.
 * This breaks circular imports — services depend on the interface, not the concrete core.
 */
export interface PluginCoreLike {
  getService<T>(name: ServiceName): T | undefined;
  getServices(): Map<ServiceName, PluginService>;
  restartService(name: ServiceName): Promise<void>;
  /** Whether a service has been permanently degraded after init failure. */
  isDegraded(name: ServiceName): boolean;
}
