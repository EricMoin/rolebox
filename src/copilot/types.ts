// ── Draft Config ──────────────────────────────────────────────────────

/**
 * Composer draft-suggestion config for a role.
 *
 * A draft request asks the configured provider/model for a short text the
 * composer can offer before the user starts typing. The numeric fields have
 * frozen defaults and are clamped by `parseCopilotConfig`; `provider` and
 * `model` are optional overrides.
 */
export interface CopilotDraftConfig {
  /** Master toggle for composer draft suggestions (default false). */
  enabled: boolean;
  /** Optional provider id used for draft requests (non-empty when set). */
  provider?: string;
  /** Optional model id used for draft requests (non-empty when set). */
  model?: string;
  /** Max milliseconds to wait for one draft response (default 4000). */
  timeout_ms: number;
  /** Max characters in the suggested draft (default 120). */
  max_chars: number;
  /** Number of recent transcript messages fed to the draft request (default 8). */
  window_size: number;
  /** Max characters of transcript text fed to the draft request (default 4000). */
  transcript_max_chars: number;
}

/**
 * Partial composer draft config contributed by one precedence source.
 *
 * Role `copilot`, project `.rolebox/config.json` and global `config.yaml` each
 * contribute a fragment; {@link composeCopilotConfig} merges them field by
 * field. Every field is optional and keeps the same name as its
 * {@link CopilotDraftConfig} counterpart:
 *
 *   - an absent field falls through to the next lower-precedence source;
 *   - `enabled` is three-state: a present `true`/`false` wins, an absent value
 *     inherits;
 *   - an invalid value is treated as absent (after one warning), so a lower
 *     source can still supply it.
 */
export interface CopilotDraftFragment {
  /** Master toggle; absent inherits from a lower-precedence source. */
  enabled?: boolean;
  /** Optional provider id used for draft requests. */
  provider?: string;
  /** Optional model id used for draft requests. */
  model?: string;
  /** Max milliseconds to wait for one draft response. */
  timeout_ms?: number;
  /** Max characters in the suggested draft. */
  max_chars?: number;
  /** Number of recent transcript messages fed to the draft request. */
  window_size?: number;
  /** Max characters of transcript text fed to the draft request. */
  transcript_max_chars?: number;
}

// ── Top-Level Config ──────────────────────────────────────────────────

/** Top-level copilot block configured per role. */
export interface CopilotConfig {
  /** Composer draft-suggestion config. */
  draft: CopilotDraftConfig;
}
