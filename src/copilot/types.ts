// ── Copilot Actions ──────────────────────────────────────────────────

/** Valid copilot rule actions. */
export const COPILOT_ACTIONS = ["continue", "skip", "blocked", "done"] as const;

/** Union of valid copilot rule actions. */
export type CopilotAction = (typeof COPILOT_ACTIONS)[number];

// ── Rule Match Criteria ───────────────────────────────────────────────

export interface CopilotRuleMatch {
  /** Regex pattern matched against the model's tail message text. */
  pattern?: string;
  /** Plain substring matched against the model's tail message text. */
  contains?: string;
}

// ── Rule ──────────────────────────────────────────────────────────────

export interface CopilotRule {
  /** Unique rule identifier (required). */
  id: string;
  /**
   * Match criteria — at least one of `pattern` / `contains` must be set.
   * Rules are evaluated in order; the first match wins.
   */
  match: CopilotRuleMatch;
  /** Action to take when the rule matches. */
  action: CopilotAction;
  /** Optional reply text injected for "continue" actions. */
  reply?: string;
}

// ── LLM Verdict Config ────────────────────────────────────────────────

export interface CopilotTranscriptConfig {
  /** Number of recent transcript messages fed to the verdict LLM (default 20). */
  window_size: number;
  /** Max characters of transcript text fed to the verdict LLM (default 8000). */
  max_chars: number;
  /** Whether tool-call entries are included in the transcript (default true). */
  include_tools: boolean;
}

export interface CopilotLlmConfig {
  /** Role/id of the LLM agent used for turn-end verdicts (required). */
  role: string;
  /** Max milliseconds to wait for an LLM verdict (default 30000). */
  max_verdict_timeout_ms: number;
  /** Optional guidance prompt appended to the verdict request. */
  guidance?: string;
  /** Transcript window config for verdict requests. */
  transcript: CopilotTranscriptConfig;
}

// ── Top-Level Config ──────────────────────────────────────────────────

export interface CopilotConfig {
  /** Master toggle for the copilot subsystem (default false). */
  enabled: boolean;
  /** Ordered rule list; first matching rule wins. */
  rules: CopilotRule[];
  /** Optional LLM verdict config. Absent = heuristic-only decision path. */
  llm?: CopilotLlmConfig;
}
