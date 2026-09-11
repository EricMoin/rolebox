/**
 * ISkillSurface — port interface for publishing the active role's skills
 * to the host platform's skill registry.
 *
 * Platform adapters implement this to translate canonical skill entries
 * into whatever registration mechanism the host expects (e.g. dsh's
 * `ctx.skills` SkillProvider registry, Pi's `resources_discover` skill
 * paths, or opencode's filesystem skill sync).
 *
 * Must NOT import from @deepseek-ai/* or @opencode-ai/*.
 */

import type { SkillScope } from "../../constants.ts";

/**
 * A platform-agnostic skill entry to publish to the host.
 *
 * This is the canonical shape an adapter needs in order to surface a
 * skill: enough metadata for the host to list it, and the absolute paths
 * the host reads to load it. It intentionally carries no platform-native
 * fields — adapters derive those (e.g. a registry key or provider object)
 * from this entry.
 */
export interface CanonicalSkillEntry {
  /** Skill name (matches the directory or frontmatter name). */
  name: string;
  /** Human-readable description from SKILL.md frontmatter. */
  description: string;
  /** Where the skill was resolved from (rolebox-local vs. global). */
  scope: SkillScope;
  /** Absolute filesystem path to the SKILL.md file. */
  filePath: string;
  /**
   * Absolute filesystem path to the skill's resource directory
   * (the directory containing SKILL.md and its `references/`).
   */
  resourceDir: string;
  /** ID of the role that owns the skill (e.g. "emperor"). */
  roleId: string;
  /**
   * Full ID of the owning agent, which may be a role ID or a nested
   * subagent ID (e.g. "emperor--chancellor").
   */
  ownerAgentId: string;
}

/**
 * Port interface for skill surfacing.
 *
 * A skill surface publishes the active role's skills to the host so the
 * runtime can discover and load them. The core resolution logic produces
 * CanonicalSkillEntry values; each platform adapter implements `publish`
 * against its native registry.
 */
export interface ISkillSurface {
  /**
   * Publish (or update) a batch of skill entries to the host.
   *
   * Implementations are idempotent — re-publishing an unchanged entry
   * set is a no-op.
   *
   * Returns a disposer that removes the entries published by this call.
   * Calling the disposer more than once is a no-op.
   */
  publish(entries: CanonicalSkillEntry[]): () => void;
}
