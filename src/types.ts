import type {
  RoleMode,
  SkillScope,
  FunctionSource,
  ReferenceScope,
  GraphTemplate,
} from "./constants.ts";
import type { DispatchManagerConfig } from "./dispatch/config.ts";

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
 * The `subagents` field is NOT permitted on SubAgentConfig itself
 * (enforced at parse-time, not at the type level).
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
}

/**
 * A directed edge in a collaboration graph between two agent nodes.
 * Represents a flow of work from one agent to another.
 */
export interface FlowEdge {
  /** Source agent ID */
  from: string;
  /** Target agent ID */
  to: string;
  /** Optional label describing the transition condition or data flow */
  label?: string;
  /** When true, this edge exits the collaboration flow (terminal transition) */
  exit?: boolean;
}

export type { GraphTemplate } from "./constants.ts";

/**
 * Raw collaboration graph configuration as parsed from role.yaml.
 * Defines how agents coordinate in a multi-agent workflow.
 */
export interface CollaborationConfig {
  /** Optional named topology shorthand */
  topology?: GraphTemplate;
  /** List of agent IDs participating in the collaboration */
  agents?: string[];
  /** Explicit flow edges defining work transitions between agents */
  flow?: FlowEdge[];
  /** Maximum collaboration iterations before forced termination */
  max_iterations?: number;
}

/**
 * Raw dispatch configuration as parsed from role.yaml.
 * Each field is an optional number that, when set, overrides the
 * corresponding DispatchManagerConfig default for this role's sub-agent dispatch.
 */
export interface DispatchRoleConfig {
  /** Maximum concurrent background tasks (dispatch default: 5) */
  maxConcurrent?: number;
  /** Maximum queued tasks per concurrency slot (dispatch default: 10) */
  maxQueueDepth?: number;
  /** Reserved concurrency slots for synchronous dispatch (dispatch default: 1) */
  syncReservedSlots?: number;
  /** Maximum active background tasks per parent session (dispatch default: 3) */
  maxActivePerParent?: number;
  /** Delay (ms) after a dispatch failure before retry (dispatch default: 30000) */
  retryAfterMs?: number;
  /** Maximum backpressure retry attempts (dispatch default: 5) */
  backpressureMaxRetries?: number;
  /** Maximum cumulative backpressure delay (ms) (dispatch default: 60000) */
  backpressureMaxDelayMs?: number;
  /** Per-task default stale timeout (ms) for background tasks (dispatch default: 900000) */
  backgroundStaleTimeoutMs?: number;
  /** Timeout (ms) to acquire a slot for synchronous dispatch (dispatch default: 120000) */
  syncAcquireTimeoutMs?: number;
  /** Timeout (ms) for sub-agent prompt in sync mode (dispatch default: 600000) */
  syncPromptTimeoutMs?: number;
}

/**
 * Normalized internal representation of a collaboration graph.
 * Generated at build-time from CollaborationConfig by resolving
 * template expansions, deduplicating nodes, and categorizing edges.
 */
export interface ResolvedGraph {
  /** All resolved flow edges (including exit edges) */
  edges: FlowEdge[];
  /** Deduplicated list of all agent node IDs in the graph */
  nodes: string[];
  /** Maximum iterations (defaulted to a sensible value if not specified) */
  maxIterations: number;
  /** Subset of edges marked as exit transitions */
  exitEdges: FlowEdge[];
  /** The template that was expanded, if any */
  template?: GraphTemplate;
}

/**
 * Per-agent role metadata within a resolved collaboration graph.
 * Provides each agent with its connectivity context for routing decisions.
 */
export interface GraphNodeRole {
  /** Agent identifier matching a node in the graph */
  agentId: string;
  /** Agents that can send work to this agent */
  upstream: string[];
  /** Agents that this agent can send work to */
  downstream: string[];
  /** Whether this agent is an entry point for the collaboration flow */
  isEntryPoint: boolean;
  /** Whether this agent is an exit point for the collaboration flow */
  isExitPoint: boolean;
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
  /** Semantic version string for the role (e.g., "1.0.0") */
  version?: string;
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
}
