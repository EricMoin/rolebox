/**
 * PlatformContext — the single injection point for all platform dependencies.
 *
 * Services receive PlatformContext instead of raw SDK clients.
 * Each field is a port interface backed by a platform-specific adapter.
 */

import type { ISessionClient } from "./ports/session-client.ts";
import type { IToolFactory } from "./ports/tool-factory.ts";
import type { IEventBridge } from "./ports/event-bridge.ts";
import type { IAgentRegistrar } from "./ports/agent-registrar.ts";
import type { PlatformCapabilities } from "./capabilities.ts";

/**
 * The unified platform context carrying all port adapters.
 *
 * This replaces direct SDK client references throughout the codebase.
 * Services access platform functionality exclusively through this context.
 */
export interface PlatformContext {
  /** Session operations (list, get, messages, fork, prompt, etc.). */
  session: ISessionClient;
  /** Tool definition compilation for the target platform. */
  tools: IToolFactory;
  /** Event normalization and subscription bridge. */
  events: IEventBridge;
  /** Agent registration and lifecycle. */
  agents: IAgentRegistrar;
  /** Feature capability flags for graceful degradation. */
  capabilities: PlatformCapabilities;
}
