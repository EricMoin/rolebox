import type {
  RoleMode,
  SkillScope,
  FunctionSource,
  ReferenceScope,
} from "./constants.ts";
import type { DispatchManagerConfig } from "./dispatch/config.ts";
import type { HooksBlock } from "./hooks/custom/types.ts";
import type { NotificationConfig } from "./notifications/types.ts";
import type { ExtensionConfig } from "./extensions/types.ts";
import type {
  ResolvedGraph,
  CollaborationConfig,
  Condition,
  ObserveSpec,
  TransitionSpec,
} from "./types.graph.ts";
import type { DispatchRoleConfig } from "./types.dispatch.ts";

/**
 * Permission configuration, mirroring opencode's PermissionConfig structure.
 * Controls which tools a role is allowed or denied from using.
 */
export interface PermissionConfig {
  /** Tool names the role is explicitly allowed to use */
  allow?: string[];
  /** Tool names the role is explicitly denied from using */
  deny?: string[];
}

/**
 * Configuration for a sub-agent within a role.
 * Sub-agents are child agents that the parent role can delegate tasks to.
 * Fields here override the parent's defaults for the sub-agent.
 * The `subagents` field allows recursive nesting of sub-agents within sub-agents.
 * Nested subagent parsing is bounded by a max-depth guard (default: 3).
 */
export interface SubAgentConfig {
  /** Sub-agent name (used for display and delegation routing) */
  name: string;
  /** Brief description of the sub-agent's purpose and capabilities */
  description: string;
  /** System prompt text for the sub-agent (mutually exclusive with prompt_file) */
  prompt: string;
  /** Path to a file containing the system prompt (mutually exclusive with prompt) */
  prompt_file?: string;
  /** LLM model override for this sub-agent */
  model?: string;
  /** Display color override */
  color?: string;
  /** Model variant / configuration flavor override */
  variant?: string;
  /** Sampling temperature override (0.0 - 2.0) */
  temperature?: number;
  /** Top-p nucleus sampling parameter override (0.0 - 1.0) */
  top_p?: number;
  /** Permission overrides for tool access */
  permission?: PermissionConfig;
  /** Map of tool names to enabled/disabled state override */
  tools?: Record<string, boolean>;
  /** Names of rolebox-local skills to load for this sub-agent */
  skills?: string[];
  /** Names of opencode-global skills to load for this sub-agent */
  opencode_skills?: string[];
  /** Names of functions available to this sub-agent */
  functions?: string[];
  /** Names of default functions to disable for this sub-agent */
  disable_functions?: string[];
  /** Function names to auto-activate at session start. These functions become active without requiring |name| syntax. */
  auto_activate?: string[];
  /** When true, auto-activated functions cannot be deactivated by transition or user. Prevents accidental deactivation of critical functions. */
  locked?: boolean;
  /** Nested sub-agent definitions (recursive, max depth 3) */
  subagents?: SubAgentConfig[];
}

/**
 * Raw role configuration as parsed from a role's YAML file (role.yaml).
 * Contains user-facing settings before any environment variable resolution
 * or file-based prompt loading has occurred.
 */
export interface RoleConfig {
  /** Human-readable name for the role */
  name: string;
  /** Brief description of the role's purpose */
  description: string;
  /** LLM model identifier (e.g., "gpt-4", "claude-3-sonnet") */
  model?: string;
  /** Role mode: "primary" (default), "subagent", or "all" */
  mode?: RoleMode;
  /** Display color for the role in the UI */
  color?: string;
  /** Model variant / configuration flavor */
  variant?: string;
  /** System prompt text (mutually exclusive with prompt_file) */
  prompt: string;
  /** Path to a file containing the system prompt (mutually exclusive with prompt) */
  prompt_file?: string;
  /** Names of rolebox-local skills to load */
  skills?: string[];
  /** Names of opencode-global skills to load */
  opencode_skills?: string[];
  /** Permission controls for tool access */
  permission?: PermissionConfig;
  /** Sub-agent definitions for task delegation within this role */
  subagents?: SubAgentConfig[];
  /** Map of tool names to enabled/disabled state */
  tools?: Record<string, boolean>;
  /** Sampling temperature for the LLM (0.0 - 2.0) */
  temperature?: number;
  /** Top-p nucleus sampling parameter (0.0 - 1.0) */
  top_p?: number;
  /** Names of functions this role supports */
  functions?: string[];
  /** Names of default functions to disable */
  disable_functions?: string[];
  /** Explicit reference declarations with optional descriptions */
  references?: Record<string, string | ReferenceEntry>;
  /** Collaboration graph configuration for multi-agent workflows */
  collaboration?: CollaborationConfig;
  /** Dispatch subsystem overrides for sub-agent queueing and concurrency */
  dispatch?: DispatchRoleConfig;
  /** Function names to auto-activate at session start. These functions become active without requiring |name| syntax. */
  auto_activate?: string[];
  /** When true, auto-activated functions cannot be deactivated by transition or user. Prevents accidental deactivation of critical functions. */
  locked?: boolean;
  /** Semantic version string for the role (e.g., "1.0.0") */
  version?: string;
  /** Notification configuration for session lifecycle events */
  notifications?: NotificationConfig;
  /** Custom hook declarations for lifecycle event hooks */
  hooks?: HooksBlock;
  /** Extension modules to register custom conditions, topologies, channels, etc. */
  extensions?: ExtensionConfig;
  /** Memory configuration for role-level memory persistence and injection */
  memory?: MemoryConfig;
}

/**
 * A resolved skill reference after locating the corresponding SKILL.md file
 * in either the role's local skills directory or the opencode global skills directory.
 */
export interface ResolvedSkill {
  /** Skill name (matches the directory or frontmatter name) */
  name: string;
  /** Human-readable description from SKILL.md frontmatter */
  description: string;
  /** Scope indicating where the skill was found */
  scope: SkillScope;
  /** Absolute filesystem path to the SKILL.md file */
  filePath: string;
  /** Resolved references discovered in the skill's references/ directory */
  references: ResolvedReference[];
}

/**
 * A resolved function reference after locating the corresponding function file
 * in either the role's local functions directory or a global functions directory.
 */
export interface ResolvedFunction {
  /** Function name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Raw function content (the actual system message / tool definition) */
  content: string;
  /** Absolute filesystem path to the function file */
  filePath: string;
  /** Source indicating where the function was found */
  source: FunctionSource;
  /** Parameter declarations from frontmatter (name → default value) */
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

/**
 * A single reference entry as declared in role.yaml `references:` field.
 * Allows explicit metadata (description) for auto-discovered reference files.
 */
export interface ReferenceEntry {
  /** Relative path from the role/skill directory to the reference file */
  path: string;
  /** Human-readable description surfaced in <available_references> */
  description?: string;
}

/**
 * A fully resolved reference file with absolute path and metadata.
 * References are deep-knowledge documents that agents can read on demand.
 */
export interface ResolvedReference {
  /** Identifier derived from file path (e.g., "theory/psychology") */
  name: string;
  /** Absolute filesystem path to the reference file */
  filePath: string;
  /** Human-readable description (from frontmatter, role.yaml, or auto-generated) */
  description: string;
  /** Where the reference was found */
  scope: ReferenceScope;
  /** Relative path from the owning directory (for display) */
  relativePath: string;
}

export interface ResolvedSubAgent {
  id: string;
  config: SubAgentConfig;
  prompt: string;
  skills: ResolvedSkill[];
  functions: ResolvedFunction[];
  references: ResolvedReference[];
  subagents: ResolvedSubAgent[];
  parentId: string;
  inheritedFrom: Partial<Record<string, unknown>>;
  /** Function names to auto-activate at session start (passthrough from config). */
  auto_activate?: string[];
  /** When true, auto-activated functions cannot be deactivated by transition or user (passthrough from config). */
  locked?: boolean;
}

/**
 * A fully resolved role with all configuration materialized.
 * Environment variables have been substituted, prompt_file content has been
 * loaded into the prompt field, and all skill references have been resolved
 * to their actual file locations.
 */
export interface ResolvedRole {
  /** Unique identifier for the role (typically the directory name) */
  id: string;
  /** Original role configuration (raw YAML data) */
  config: RoleConfig;
  /** Final system prompt string (after prompt_file resolution) */
  prompt: string;
  /** Resolved skill references */
  skills: ResolvedSkill[];
  /** Resolved function references */
  functions: ResolvedFunction[];
  /** Resolved reference documents (role-level + aggregated from skills) */
  references: ResolvedReference[];
  /** Resolved sub-agent definitions (defaults to empty array) */
  subagents: ResolvedSubAgent[];
  /** Resolved collaboration graph for multi-agent workflows (set when collaboration config is present) */
  graph?: ResolvedGraph;
  /** Resolved dispatch configuration overrides from role.yaml dispatch: block */
  dispatchConfig?: Partial<DispatchManagerConfig>;
  /** Function names to auto-activate at session start (passthrough from config). */
  auto_activate?: string[];
  /** When true, auto-activated functions cannot be deactivated by transition or user (passthrough from config). */
  locked?: boolean;
}

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

/**
 * Memory configuration in role.yaml.
 * Controls how memories are injected into the system prompt.
 */
export interface MemoryConfig {
  /** Whether to auto-inject <available_memory> block at session start (default: true) */
  inject?: boolean;
  /** Max memory summaries to inject into system prompt (default: 10) */
  max_inject?: number;
  /** Minimum relevance level to inject: "high" | "medium" | "low" (default: "medium") */
  min_relevance?: string;
  /** Which scope to inject: "role" | "workspace" | "both" (default: "both") */
  scope?: string;
}

/**
 * A memory entry returned by list/search/store.read.
 */
export interface MemoryEntry {
  id: string;
  scope: string;
  role_id: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  relevance: string;
  created_at: string;
  updated_at: string;
  accessed_at: string | null;
  access_count: number;
  session_id: string | null;
  source_sessions: string[];
}

/**
 * A memory summary for injection (lighter weight — no full content).
 */
export interface MemorySummary {
  id: string;
  title: string;
  category: string;
  relevance: string;
  updated_at: string;
}
