/**
 * Platform abstraction layer — public API.
 *
 * This barrel exports all types, interfaces, and utilities needed by
 * consumers building against the rolebox platform abstraction.
 *
 * Import paths:
 *   - Internal (within rolebox):  import { ... } from "../platform/index.ts"
 *   - External (package export):  import { ... } from "rolebox/platform"
 */

// ── Port interfaces ──────────────────────────────────────────────────────────
export type { ISessionClient } from "./ports/session-client.ts";
export type { IToolFactory } from "./ports/tool-factory.ts";
export type { IEventBridge, CanonicalEventHandler } from "./ports/event-bridge.ts";
export type { IAgentRegistrar } from "./ports/agent-registrar.ts";

// ── Canonical types ──────────────────────────────────────────────────────────
export type {
  CanonicalToolDef,
  CanonicalToolContext,
  ToolResult,
  ToolAttachment,
  CanonicalEvent,
  CanonicalEventType,
  AgentDefinition,
} from "./types.ts";

// ── Context and capabilities ─────────────────────────────────────────────────
export type { PlatformContext } from "./context.ts";
export type { PlatformCapabilities } from "./capabilities.ts";
export { defaultCapabilities, minimalCapabilities } from "./capabilities.ts";

// ── Factory ──────────────────────────────────────────────────────────────────
export { defineTool } from "./ports/tool-factory.ts";
