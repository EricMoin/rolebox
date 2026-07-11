/**
 * PiAgentRegistrar — IAgentRegistrar adapter for Pi (plugin) platform agents.
 *
 * Maintains an in-memory registry of AgentDefinitions. Does NOT import from
 * any Pi SDK (@opencode-ai/plugin or @opencode-ai/sdk). The actual Pi API
 * hookup (pi.on("before_agent_start", ...)) happens in the extension entry
 * point, not here.
 *
 * Exports additional helper methods so the extension entry point can read
 * the current registry state when handling Pi events.
 *
 * @module
 */

import type { IAgentRegistrar } from "../../ports/agent-registrar.ts";
import type { AgentDefinition } from "../../types.ts";

// ── Deep comparison helper ─────────────────────────────────────────────────

/**
 * Compare two agent definitions by value.
 * Uses JSON serialization for a simple deep equality check.
 *
 * @param a - First agent definition.
 * @param b - Second agent definition.
 * @returns `true` if both definitions are deeply equal.
 */
function definitionsEqual(a: AgentDefinition, b: AgentDefinition): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── Adapter implementation ─────────────────────────────────────────────────

/**
 * IAgentRegistrar implementation that manages agent definitions in memory.
 *
 * Agents are keyed by their `id` field. The registrar supports batch
 * register/unregister, diff-based sync, and listing.
 *
 * The extension entry point uses the exported `getRegisteredAgents()` and
 * `getSkillPaths()` helpers to inject agent configurations into Pi's
 * `before_agent_start` and `resources_discover` events.
 */
export class PiAgentRegistrar implements IAgentRegistrar {
  /** Internal agent registry, keyed by agent ID. */
  private readonly agents: Map<string, AgentDefinition> = new Map();

  /** Skill directory paths associated with registered agents, keyed by agent ID. */
  private readonly skillPaths: Map<string, string> = new Map();

  // ── IAgentRegistrar implementation ───────────────────────────────────────

  /**
   * Register (or update) a batch of agent definitions.
   *
   * Idempotent — registering the same definition for an existing agent ID
   * has no effect.
   *
   * @param agentDefs - Agent definitions to register.
   */
  async register(agentDefs: AgentDefinition[]): Promise<void> {
    for (const def of agentDefs) {
      this.agents.set(def.id, def);
    }
  }

  /**
   * Unregister agents by their IDs.
   *
   * Removes the agent definition and its associated skill path (if any).
   * Silently skips IDs that are not currently registered.
   *
   * @param agentIds - IDs of agents to unregister.
   */
  async unregister(agentIds: string[]): Promise<void> {
    for (const id of agentIds) {
      this.agents.delete(id);
      this.skillPaths.delete(id);
    }
  }

  /**
   * Sync the registry with a new complete set of agent definitions.
   *
   * Computes the diff against the current state:
   * - **added**: IDs in the new set that are either new or whose definition changed
   * - **removed**: IDs in the current set that are absent from the new set
   * - **unchanged**: IDs present in both sets with identical definitions
   *
   * Applies the computed changes to the internal registry.
   *
   * @param agentDefs - The complete new set of agent definitions.
   * @returns A diff summary with added, removed, and unchanged IDs.
   */
  async sync(
    agentDefs: AgentDefinition[],
  ): Promise<{ added: string[]; removed: string[]; unchanged: string[] }> {
    const newIds = new Set(agentDefs.map((def) => def.id));
    const newDefs = new Map(agentDefs.map((def) => [def.id, def]));

    const added: string[] = [];
    const removed: string[] = [];
    const unchanged: string[] = [];

    // Determine which existing agents are removed or unchanged.
    for (const [id, existingDef] of this.agents) {
      if (!newIds.has(id)) {
        removed.push(id);
      } else {
        const newDef = newDefs.get(id)!;
        if (definitionsEqual(existingDef, newDef)) {
          unchanged.push(id);
        } else {
          added.push(id);
        }
      }
    }

    // Determine which agents are new (not in current registry at all).
    for (const def of agentDefs) {
      if (!this.agents.has(def.id)) {
        added.push(def.id);
      }
    }

    // Apply changes: add/update all new definitions.
    for (const def of agentDefs) {
      this.agents.set(def.id, def);
    }

    // Remove agents that are no longer present.
    for (const id of removed) {
      this.agents.delete(id);
      this.skillPaths.delete(id);
    }

    return { added, removed, unchanged };
  }

  /**
   * List currently registered agent IDs.
   *
   * @returns A sorted array of registered agent IDs.
   */
  async list(): Promise<string[]> {
    return [...this.agents.keys()].sort();
  }

  // ── Additional helpers for extension entry point ─────────────────────────

  /**
   * Retrieve all currently registered agent definitions.
   *
   * Used by the extension entry point when handling Pi's `before_agent_start`
   * event to inject agent system prompts into the Pi runtime.
   *
   * @returns An array of all currently registered AgentDefinitions.
   */
  getRegisteredAgents(): AgentDefinition[] {
    return [...this.agents.values()];
  }

  /**
   * Register a skill directory path for a specific agent.
   *
   * Skill paths are contributed to Pi's `resources_discover` event so that
   * Pi knows which skill files to load for each agent.
   *
   * @param agentId - The agent ID to associate the skill path with.
   * @param path    - The filesystem path to the skill directory.
   */
  registerSkillPath(agentId: string, path: string): void {
    this.skillPaths.set(agentId, path);
  }

  /**
   * Retrieve all registered skill directory paths.
   *
   * Used by the extension entry point when handling Pi's `resources_discover`
   * event to tell Pi which skill resources are available.
   *
   * @returns An array of filesystem paths to skill directories.
   */
  getSkillPaths(): string[] {
    return [...this.skillPaths.values()];
  }

  /**
   * Remove a previously registered skill path for a specific agent.
   *
   * @param agentId - The agent ID whose skill path should be removed.
   */
  unregisterSkillPath(agentId: string): void {
    this.skillPaths.delete(agentId);
  }
}
