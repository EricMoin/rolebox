/**
 * Pi platform adapters — barrel export.
 */

export { PiAgentRegistrar } from "./roles/agent-registrar.ts";
export { PiEventBridge } from "./hooks/event-bridge.ts";
export { PiNotificationSessionClient } from "./session/notification-session.ts";
export { PiProcessSessionAdapter } from "./session/process-session.ts";
export { PiLightweightServiceStack } from "./service-stack.ts";
export { wireRoleSwitcher } from "./roles/role-switcher.ts";
export type { RoleSwitcherOptions } from "./roles/role-switcher.ts";
export { createActiveAgentRef } from "./roles/active-agent.ts";
export type { ActiveAgentRef } from "./roles/active-agent.ts";
export { PiSessionAdapter } from "./session/session.ts";
export {
  appendEvent,
  readSession,
  cleanup,
  scanOrphanedSessions,
  loadNotifyDedup,
  persistNotifyDedup,
  persistNotifyDedupSync,
  pruneSidecars,
  MAX_RETAINED_SIDECARS,
  writeSystemPrompt,
  getSystemPromptPath,
} from "./session/sidecar-persister.ts";
export { PiToolFactory } from "./tools/tool-factory.ts";
