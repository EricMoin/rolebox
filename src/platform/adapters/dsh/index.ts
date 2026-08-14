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
export { DshRoleSwitchWebServer } from "./web-role-switch-server.ts";
export type {
  DshRoleSwitchWebServerOptions,
  RoleSwitchRoleDto,
  RoleSwitchErrorBody,
} from "./web-role-switch-server.ts";
export {
  ROLE_SWITCH_DEFAULT_SESSION,
  ROLE_SWITCH_DEFAULT_HOST,
  ROLE_SWITCH_DEFAULT_MAX_BODY_BYTES,
} from "./web-role-switch-server.ts";
export type {
  DshDispatchAdapterOptions,
  DshSubagentDispatchRuntime,
  DshSubagentResult,
} from "./dispatch.ts";
export type {
  DshAgentRegistrarOptions,
  DshAgentOptions,
  DshContentBlock,
  DshSpawnDelegate,
  DshSubagentCapabilities,
  DshSubagentProvider,
  DshSubagentRun,
  DshSubagentRuntime,
  DshSubagentStartRequest,
  DshToolRestriction,
} from "./agent-registrar.ts";
export type { DshCordisContext } from "./event-bridge.ts";
