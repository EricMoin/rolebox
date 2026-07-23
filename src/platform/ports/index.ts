/**
 * Barrel export for all port interfaces.
 */

export type { ISessionClient } from "./session-client.ts";
export type { IToolFactory, CanonicalToolContext, ToolResult } from "./tool-factory.ts";
export { defineTool } from "./tool-factory.ts";
export type { CanonicalToolDef } from "./tool-factory.ts";
export type { IEventBridge, CanonicalEventHandler } from "./event-bridge.ts";
export type { CanonicalEvent, CanonicalEventType } from "./event-bridge.ts";
export type { IAgentRegistrar, AgentDefinition } from "./agent-registrar.ts";
export type { IHookProvider } from "./hook-provider.ts";
