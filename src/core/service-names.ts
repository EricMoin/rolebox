/**
 * The closed set of service names the plugin service graph is keyed by.
 *
 * This module is the single source of truth for the service-name strings:
 * declarations (`PluginService.name`, `PluginService.dependencies`) and every
 * lookup (`PluginCoreLike.getService`, `getServices`, `restartService`,
 * `isDegraded`) take `ServiceName`, so a misspelled service name is a compile
 * error instead of a silently ignored dependency or a failed lookup.
 */
export const SERVICE_NAMES = {
  hotReload: "hot-reload-service",
  dispatch: "dispatch-service",
  loop: "loop-service",
  lsp: "lsp-service",
  notification: "notification-service",
  session: "session-service",
  recovery: "recovery-service",
  extension: "extension-service",
  tool: "tool-service",
  hook: "hook-service",
  healthMonitor: "health-monitor-service",
} as const;

export type ServiceName = (typeof SERVICE_NAMES)[keyof typeof SERVICE_NAMES];
