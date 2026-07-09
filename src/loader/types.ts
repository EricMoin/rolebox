/**
 * Loader/resolver-domain metadata types extracted from types.core.ts.
 * These are YAML frontmatter schemas used during skill/function parsing.
 * Consumers continue importing via the top-level types.ts barrel.
 */

import type { Condition, ObserveSpec, TransitionSpec } from "../types.graph.ts";
import type { ReferenceEntry } from "../types.core.ts";

/**
 * YAML frontmatter metadata parsed from SKILL.md files.
 * Fields follow the standard opencode skill frontmatter schema.
 */
export interface SkillMetadata {
  /** Skill name */
  name?: string;
  /** Human-readable description */
  description?: string;
  /** Recommended model for this skill */
  model?: string;
  /** Software license identifier */
  license?: string;
  /** Tool compatibility declaration (e.g., "claude-code opencode") */
  compatibility?: string;
  /** Allowed tools, either as a comma-separated string or an array */
  "allowed-tools"?: string | string[];
  /** Explicit reference declarations for the skill */
  references?: Record<string, string | ReferenceEntry>;
}

/**
 * YAML frontmatter metadata parsed from function files.
 * Fields follow a simpler subset of the skill frontmatter schema.
 */
export interface FunctionMetadata {
  /** Function name */
  name?: string;
  /** Human-readable description */
  description?: string;
  /** Parameter declarations: name → default value or description */
  params?: Record<string, string>;
  phase?: string;
  priority?: number;
  requires?: string[];
  produces?: string;
  consumes?: string;
  gate?: Condition;
  continue_until?: Condition;
  requires_evidence?: string[];
  observe?: ObserveSpec[];
  transitions?: TransitionSpec[];
  state_schema_version?: number;
  continue_max?: number;
  handlers?: string;
}
