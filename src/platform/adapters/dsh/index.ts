/**
 * dsh (DeepSeek Harness) platform adapters — barrel export.
 */

export { DshAgentRegistrar, DshSpawnNotWiredError } from "./agent-registrar.ts";
export { DshEventBridge, mapDshEventType } from "./event-bridge.ts";
export { DshDispatchAdapter } from "./dispatch.ts";
export { DshRoleSwitcher } from "./role-switcher.ts";
export type { DshRoleSwitcherOptions } from "./role-switcher.ts";
export { createActiveRoleRef } from "./role-switcher.ts";
export type {
  ActiveRolePersistence,
  ActiveRoleRef,
} from "./role-switcher.ts";
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
  DshContinuableCreateRequest,
  DshContinuableCreateSpec,
  DshSpawnContextProvider,
  DshSpawnDelegate,
  DshResolvedSubagentStartRequest,
  DshSubagentCapabilities,
  DshSubagentProvider,
  DshSubagentRun,
  DshSubagentRuntime,
  DshSubagentStartRequest,
  DshToolRestriction,
} from "./agent-registrar.ts";
export type { DshCordisContext } from "./event-bridge.ts";
export {
  DshSkillProvider,
  createDshSkillProviderFactory,
  ROLEBOX_SKILL_PROVIDER,
  ROLEBOX_SKILL_SOURCE,
  ROLEBOX_SKILL_RANK,
} from "./skill-provider.ts";
export type {
  DshActiveRoleSnapshot,
  DshSkillCandidate,
  DshSkillDefinition,
  DshSkillInvocationPolicy,
  DshSkillLookupOptions,
  DshSkillProviderControl,
  DshSkillProviderDeps,
  DshSkillProviderLike,
  DshSkillResourceBaseDirectory,
} from "./skill-provider.ts";
