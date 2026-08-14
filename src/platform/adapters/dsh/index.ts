/**
 * dsh (DeepSeek Harness) platform adapters — barrel export.
 */

export { DshAgentRegistrar, DshSpawnNotWiredError } from "./agent-registrar.ts";
export { DshEventBridge, mapDshEventType } from "./event-bridge.ts";
export { DshDispatchAdapter } from "./dispatch.ts";
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
