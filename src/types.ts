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
  mode?: "primary" | "subagent" | "all";
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
  scope: "rolebox" | "opencode";
  /** Absolute filesystem path to the SKILL.md file */
  filePath: string;
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
  source: "role-local" | "global" | "built-in";
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
}
