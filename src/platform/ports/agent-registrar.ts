/**
 * IAgentRegistrar — port interface for registering agent definitions
 * with the host platform.
 *
 * Platform adapters implement this to translate AgentDefinitions into
 * whatever format the host expects (e.g. opencode agent files, MCP
 * tool declarations, in-memory registrations).
 *
 * Must NOT import from @opencode-ai/plugin or @opencode-ai/sdk.
 */

import type { AgentDefinition } from "../types.ts";

export type { AgentDefinition };

/**
 * Port interface for agent registration.
 *
 * The registrar handles the platform-specific mechanics of making
 * agents available to the host (filesystem sync, API calls, etc.).
 */
export interface IAgentRegistrar {
  /**
   * Register (or update) a batch of agent definitions.
   * Implementations are idempotent — re-registering the same agent
   * with the same definition is a no-op.
   */
  register(agents: AgentDefinition[]): Promise<void>;

  /**
   * Unregister agents that are no longer resolved.
   * Implementations clean up any platform-specific artifacts.
   */
  unregister(agentIds: string[]): Promise<void>;

  /**
   * Sync registered agents with a new complete set.
   * Equivalent to: register new/changed, unregister removed.
   * Returns the IDs that were added and removed.
   */
  sync(agents: AgentDefinition[]): Promise<{
    added: string[];
    removed: string[];
    unchanged: string[];
  }>;

  /**
   * List currently registered agent IDs.
   */
  list(): Promise<string[]>;
}
