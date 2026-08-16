/**
 * dsh (DeepSeek Harness) platform adapters — barrel export.
 */

export { DshAgentRegistrar, DshSpawnNotWiredError } from "./agent-registrar.ts";
export { DshEventBridge, mapDshEventType } from "./event-bridge.ts";
export { DshDispatchAdapter } from "./dispatch.ts";
export { DshRoleSwitcher } from "./role-switcher.ts";
export type { DshRoleSwitcherOptions } from "./role-switcher.ts";
export { ACTIVE_ROLE_EVENT, createActiveRoleRef } from "./role-switcher.ts";
export type { ActiveRoleRef } from "./role-switcher.ts";
export {
  DshRoleSwitchWebRoute,
  ROLE_SWITCH_ROUTE_PREFIX,
} from "./web-role-switch-route.ts";
export type {
  DshRoleSwitchRouteOptions,
  DshWebRouteLike,
  DshWebServerRouteRegistrar,
} from "./web-role-switch-route.ts";
export type {
  DshDispatchAdapterOptions,
  DshSubagentDispatchRuntime,
  DshSubagentResult,
} from "./dispatch.ts";
export type {
  DshAgentRegistrarOptions,
  DshActiveRoleLookup,
  DshAgentOptions,
  DshContentBlock,
  DshSpawnContextProvider,
  DshSpawnDelegate,
  DshSubagentCapabilities,
  DshSubagentProvider,
  DshSubagentRun,
  DshSubagentRuntime,
  DshSubagentStartRequest,
  DshToolRestriction,
} from "./agent-registrar.ts";
export type { DshCordisContext } from "./event-bridge.ts";
