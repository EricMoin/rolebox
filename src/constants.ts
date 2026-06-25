// ── Role Mode ──────────────────────────────────────────────────────────

export const RoleMode = {
  Primary: "primary",
  Subagent: "subagent",
  All: "all",
} as const;

export type RoleMode = (typeof RoleMode)[keyof typeof RoleMode];

/** All valid RoleMode values, for runtime validation. */
export const ROLE_MODE_VALUES: readonly RoleMode[] = Object.values(RoleMode);

// ── Skill Scope ────────────────────────────────────────────────────────

/** Where a skill was resolved from. */
export const SkillScope = {
  Rolebox: "rolebox",
  Opencode: "opencode",
} as const;

export type SkillScope = (typeof SkillScope)[keyof typeof SkillScope];

// ── Function Source ────────────────────────────────────────────────────

/** Where a function was resolved from (resolution priority order). */
export const FunctionSource = {
  RoleLocal: "role-local",
  Global: "global",
  BuiltIn: "built-in",
} as const;

export type FunctionSource = (typeof FunctionSource)[keyof typeof FunctionSource];

// ── Reference Scope ────────────────────────────────────────────────────

/** Where a reference document was discovered. */
export const ReferenceScope = {
  Role: "role",
  Skill: "skill",
} as const;

export type ReferenceScope = (typeof ReferenceScope)[keyof typeof ReferenceScope];

// ── Graph Template (Topology) ──────────────────────────────────────────

/** Pre-defined collaboration graph topologies. */
export const GraphTemplate = {
  Pipeline: "pipeline",
  ReviewLoop: "review-loop",
  Star: "star",
} as const;

export type GraphTemplate = (typeof GraphTemplate)[keyof typeof GraphTemplate];

/** All valid GraphTemplate values, for runtime validation. */
export const GRAPH_TEMPLATE_VALUES: ReadonlySet<string> = new Set(
  Object.values(GraphTemplate),
);

// ── Graph Sentinel ─────────────────────────────────────────────────────

/** Reserved node name for the parent/orchestrator in collaboration graphs. */
export const PARENT_NODE = "parent";

// ── Default Functions ──────────────────────────────────────────────────

/** Functions loaded by default when no explicit `functions:` field is set. */
export const DEFAULT_FUNCTIONS: readonly string[] = ["plan", "execute"];

// ── Sync Targets ───────────────────────────────────────────────────────

/** Supported sync targets for the CLI `sync` command. */
export const SyncTarget = {
  Opencode: "opencode",
} as const;

export type SyncTarget = (typeof SyncTarget)[keyof typeof SyncTarget];

// ── Naming Conventions ─────────────────────────────────────────────────

/** Separator between parent and child IDs in subagent naming. */
export const SUBAGENT_ID_SEPARATOR = "--";

/** Prefix for rolebox-managed skill symlinks in the global skills directory. */
export const ROLEBOX_SKILL_PREFIX = "rolebox--";

/** Marker comment embedded in rolebox-managed agent .md files. */
export const ROLEBOX_AGENT_MARKER = "<!-- rolebox-managed -->";

/** Plugin identifier. */
export const PLUGIN_ID = "rolebox";
