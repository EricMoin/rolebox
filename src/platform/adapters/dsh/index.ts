/**
 * dsh (DeepSeek Harness) platform adapters — barrel export.
 */

export { DshAgentRegistrar, DshSpawnNotWiredError } from "./roles/agent-registrar.ts";
export { DSH_IMAGE_MEDIA_TYPES, isDshImageMediaType } from "./tools/attachment.ts";
export type {
  DshAttachmentService,
  DshImageAttachmentRef,
  DshImageMediaType,
} from "./tools/attachment.ts";
export type { DshToolFactoryOptions } from "./tools/tool-factory.ts";
export { DshEventBridge, mapDshEventType } from "./hooks/event-bridge.ts";
export { DshDispatchAdapter } from "./execution/dispatch.ts";
export { DshRoleSwitcher } from "./roles/role-switcher.ts";
export type { DshRoleSwitcherOptions } from "./roles/role-switcher.ts";
export { createActiveRoleRef } from "./roles/role-switcher.ts";
export type {
  ActiveRolePersistence,
  ActiveRoleRef,
} from "./roles/role-switcher.ts";
export {
  DshRoleSwitchWebRoute,
  ROLE_SWITCH_ROUTE_PREFIX,
} from "./web/routes/web-role-switch-route.ts";
export type {
  DshRoleSwitchRouteOptions,
  DshWebRouteLike,
  DshWebServerRouteRegistrar,
} from "./web/routes/web-role-switch-route.ts";
export type {
  DshDispatchAdapterOptions,
  DshSubagentDispatchRuntime,
  DshSubagentResult,
} from "./execution/dispatch.ts";
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
} from "./roles/agent-registrar.ts";
export type { DshCordisContext } from "./hooks/event-bridge.ts";
export {
  DshSkillProvider,
  createDshSkillProviderFactory,
  ROLEBOX_SKILL_PROVIDER,
  ROLEBOX_SKILL_SOURCE,
  ROLEBOX_SKILL_RANK,
} from "./roles/skill-provider.ts";
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
} from "./roles/skill-provider.ts";
