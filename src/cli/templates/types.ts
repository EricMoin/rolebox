/**
 * Template type definitions for the `rolebox init` command.
 *
 * @module
 */

/** Supported scaffold template identifiers. */
export type TemplateType = 'minimal' | 'standard' | 'subagents' | 'collaboration';

/**
 * A single file within a template.
 *
 * The `content` field can be either a static string or a function that
 * receives the user's init configuration and returns a string. This
 * allows dynamic content (e.g. subagent names interpolated into prompts).
 */
export interface TemplateFile {
  /** Relative path from the role root directory (e.g. `role.yaml`). */
  relativePath: string;
  /**
   * File content — either a literal string or a function that derives
   * content from the init configuration.
   */
  content: string | ((config: InitConfig) => string);
}

/** A complete scaffold template with metadata and its file list. */
export interface Template {
  /** Template identifier. */
  type: TemplateType;
  /** Human-readable label shown in the CLI prompt. */
  label: string;
  /** Short description explaining what the template produces. */
  description: string;
  /** Ordered list of files to be created. */
  files: TemplateFile[];
}

/**
 * Configuration values collected during the interactive `init` flow.
 * These are passed to template content functions so that file content can
 * be customised per-user (e.g. substituting role names, subagent names).
 */
export interface InitConfig {
  /** Human-readable role name (e.g. "Code Reviewer"). */
  name: string;
  /** Role identifier used for directory names and symlinks. */
  roleId: string;
  /** One-line description of the role's purpose. */
  description: string;
  /** LLM model override (optional). */
  model?: string;
  /** Sampling temperature (optional, 0.0 – 2.0). */
  temperature?: number;
  /** Names of sub-agents when the template includes subagent scaffolding. */
  subagentNames?: string[];
  /** Collaboration topology identifier (e.g. "pipeline", "review-loop"). */
  topology?: string;
}
