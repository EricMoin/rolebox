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
export const GRAPH_TEMPLATE_VALUES: Set<string> = new Set(
  Object.values(GraphTemplate),
);

/**
 * Register a custom graph template value at runtime.
 */
export function addGraphTemplateValue(name: string): void {
  GRAPH_TEMPLATE_VALUES.add(name);
}

// ── Graph Sentinel ─────────────────────────────────────────────────────

/** Reserved node name for the parent/orchestrator in collaboration graphs. */
export const PARENT_NODE = "parent";

// ── Default Functions ──────────────────────────────────────────────────

/** Functions loaded by default when no explicit `functions:` field is set. */
export const DEFAULT_FUNCTIONS: readonly string[] = ["plan", "execute", "loop"];

// ── Sync Targets ───────────────────────────────────────────────────────

/** Supported sync targets for the CLI `sync` command. */
export const SyncTarget = {
  Opencode: "opencode",
  Pi: "pi",
  Dsh: "dsh",
} as const;

/** All valid SyncTarget values, for runtime validation and cleanup sweeps. */
export const SYNC_TARGET_VALUES: readonly SyncTarget[] = Object.values(SyncTarget);

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

// ── Well-Known File Names ──────────────────────────────────────────────

export const ROLE_YAML = "role.yaml";
export const SKILL_MD = "SKILL.md";
export const PROMPT_MD = "PROMPT.md";

// ── GitHub Defaults ───────────────────────────────────────────────────

export const DEFAULT_GIT_BRANCH = "main";

// ── Registry ──────────────────────────────────────────────────────────

export const REGISTRY_CACHE_TTL_MS = 5 * 60 * 1000;

// ── Inheritable Fields ─────────────────────────────────────────────────

/**
 * Fields that a child SubAgentConfig inherits from its parent RoleConfig
 * when the child does not set them explicitly. Used by `applyInheritance`.
 *
 * Keep in sync with the "Config inheritance" table in README.md.
 */
export const INHERITABLE_FIELDS: readonly string[] = [
  "model",
  "color",
  "variant",
  "temperature",
  "top_p",
  "permission",
  "tools",
] as const;

// ── Notification defaults ──────────────────────────────────────────────
export const DEFAULT_NOTIFICATION_IDLE_DELAY_MS = 1500;
export const DEFAULT_NOTIFICATION_THROTTLE_WINDOW_MS = 3000;
export const DEFAULT_NOTIFICATION_MAX_PER_WINDOW = 3;
export const DEFAULT_NOTIFICATION_ACTIVITY_GRACE_MS = 100;
export const DEFAULT_NOTIFICATION_MAX_TRACKED_SESSIONS = 100;
export const DEFAULT_QUESTION_TOOL_NAMES = ["question", "ask_user_question", "askuserquestion"];

// ── Graph Engine v2: Join Strategy ──────────────────────────────────────

export const JoinStrategy = {
  All: "all",
  Any: "any",
  Quorum: "quorum",
} as const;

export type JoinStrategy = (typeof JoinStrategy)[keyof typeof JoinStrategy];

/** All valid JoinStrategy values, for runtime validation. */
export const JOIN_STRATEGY_VALUES: readonly JoinStrategy[] = Object.values(JoinStrategy);

// ── Graph Engine v2: Engine Phase ───────────────────────────────────────

export const EnginePhase = {
  Idle: "idle",
  Executing: "executing",
  Complete: "complete",
} as const;

export type EnginePhase = (typeof EnginePhase)[keyof typeof EnginePhase];

/** All valid EnginePhase values, for runtime validation. */
export const ENGINE_PHASE_VALUES: readonly EnginePhase[] = Object.values(EnginePhase);

// ── Graph Engine v2: Node Status ────────────────────────────────────────

/**
 * Generic node lifecycle status for the graph execution engine.
 *
 * Normal path: pending → ready → running → completed → done
 * Pause path:  running → blocked (needs_approval) → completed/ready
 * Error paths: running → escalate → done
 *              running → timeout → done (or ready, if retry)
 * Cancel path: pending/ready → cancelled → done
 *
 * TODO(Phase 3): blocked status mechanics for needs_approval pause.
 * The `blocked` state is reserved for human-in-the-loop approval;
 * full engine-advancement pausing for approval nodes will be
 * implemented in Phase 3.
 */
export const NodeStatus = {
  Pending: "pending",
  Ready: "ready",
  Running: "running",
  Completed: "completed",
  Blocked: "blocked",
  Timeout: "timeout",
  Escalate: "escalate",
  Cancelled: "cancelled",
  Done: "done",
} as const;

export type NodeStatus = (typeof NodeStatus)[keyof typeof NodeStatus];

/** All valid NodeStatus values, for runtime validation. */
export const NODE_STATUS_VALUES: readonly NodeStatus[] = Object.values(NodeStatus);
