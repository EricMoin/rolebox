/**
 * opencode v2 platform adapters — barrel export.
 */

export { Opencode2SessionAdapter } from "./session.ts";
export type {
  Opencode2CreateInput,
  Opencode2HostContent,
  Opencode2HostMessage,
  Opencode2InboxUser,
  Opencode2PromptInput,
  Opencode2RequestOptions,
  Opencode2SessionAdapterOptions,
  Opencode2SessionApi,
  Opencode2SessionInfo,
} from "./session.ts";
export { Opencode2ToolFactory } from "./tool-factory.ts";
export type {
  Opencode2CompiledTool,
  Opencode2ToolFactoryOptions,
} from "./tool-factory.ts";
export {
  applyOpencode2AgentPatch,
  applyOpencode2Agents,
  collectOpencode2AgentModels,
  collectOpencode2AgentRegistrations,
  mapPermissionRuleset,
  mapResolvedRoleToAgent,
  mapResolvedSubAgentToAgent,
  mapToolRuleset,
  registerOpencode2Agents,
} from "./agents.ts";
export type {
  Opencode2AgentDomain,
  Opencode2AgentEditor,
  Opencode2AgentMode,
  Opencode2AgentModelRef,
  Opencode2AgentPatch,
  Opencode2AgentProviderRequestBody,
  Opencode2AgentRegistration,
  Opencode2HostMutableAgentInfo,
  Opencode2MutableAgentInfo,
  Opencode2PermissionEffect,
  Opencode2PermissionRule,
} from "./agents.ts";
export {
  MAX_OPENCODE2_SKILL_CONTENT_CHARS,
  applyOpencode2Skills,
  collectOpencode2Skills,
  registerOpencode2Skills,
} from "./skills.ts";
export type {
  Opencode2SkillDomain,
  Opencode2SkillEditor,
  Opencode2SkillInfo,
  Opencode2SkillOptions,
} from "./skills.ts";
export {
  STOP_LOOP_COMMAND_DESCRIPTION,
  createStopLoopCommand,
  registerOpencode2Commands,
} from "./commands.ts";
export type {
  Opencode2CommandDefinition,
  Opencode2CommandDelivery,
  Opencode2CommandDomain,
  Opencode2CommandEditor,
  Opencode2CommandInvocation,
  Opencode2CommandPromptInput,
  Opencode2CommandSession,
} from "./commands.ts";
export {
  OPENCODE2_EVENT_TYPE_MAP,
  mapOpencode2EventType,
  normalizeOpencode2Event,
} from "./event-bridge.ts";
export { openOpencode2GraphHost } from "./graph-host.ts";
export type { OpencodeGraphHost } from "../opencode/graph-host.ts";
