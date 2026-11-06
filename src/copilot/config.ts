// ── Copilot Config Parsing ───────────────────────────────────────────
//
// Parses a raw (YAML-parsed) copilot config block into a validated
// `CopilotConfig`. Mirrors the parsing/defaults pattern of
// src/notifications/config.ts:43-58:
//   - frozen defaults for the top-level shape and the `draft` block,
//   - numeric clamping for the bounded draft fields,
//   - field coercion where safe (string → boolean / number).
//
// A config can come from several precedence sources (role > project > global).
// Each source is parsed into a PARTIAL `CopilotDraftFragment` and the effective
// config is composed field by field:
//   - an absent field falls through to the next lower source,
//   - `enabled` is three-state: a present value wins, an absent one inherits,
//   - an invalid value warns once and is treated as ABSENT so a lower source
//     can still supply it.
//
// The legacy turn-end keys (`enabled`, `rules`, `llm`) were removed. When any
// of them is present on the block the parser logs ONE warning for that key and
// otherwise ignores it — legacy configs never throw.

import { createSubLogger } from "../logger.ts";
import type { Logger } from "../logger.ts";
import type { ILogObj } from "../logger.ts";
import {
  asBoolean,
  asNumber,
  isObject,
} from "../notifications/config-parsers.ts";
import type {
  CopilotConfig,
  CopilotDraftConfig,
  CopilotDraftFragment,
} from "./types.ts";

const log: Logger<ILogObj> = createSubLogger("copilot-config");

// ── Defaults ────────────────────────────────────────────────────────

/**
 * Frozen default composer draft config.
 *
 * `timeout_ms: 4000` is a ceiling, not added latency: the call returns as soon
 * as the provider answers. The earlier 1500 ms default timed out on ordinary
 * provider round-trips (measured 1.8-2.6 s under real jitter), and a timeout
 * degrades to a silent `none`, so users saw no suggestion at all. The clamp
 * still bounds a misconfigured value to 200-10000 ms.
 */
export const DEFAULT_COPILOT_DRAFT_CONFIG: Readonly<CopilotDraftConfig> =
  Object.freeze({
    enabled: false,
    timeout_ms: 4000,
    max_chars: 120,
    window_size: 8,
    transcript_max_chars: 4000,
  });

/**
 * Frozen default copilot configuration.
 * Consumers never receive a shared mutable shape; composition always returns a
 * fresh object with a freshly cloned `draft` block.
 */
export const DEFAULT_COPILOT_CONFIG: Readonly<CopilotConfig> = Object.freeze({
  draft: DEFAULT_COPILOT_DRAFT_CONFIG,
});

/** Legacy top-level keys removed in favour of `copilot.draft`. */
const LEGACY_KEYS = ["enabled", "rules", "llm"] as const;

// ── Public API ──────────────────────────────────────────────────────

/**
 * Parse a raw (YAML-parsed) value into a validated `CopilotConfig`.
 *
 * Single-block compatibility wrapper: the block is parsed into one fragment
 * and composed against the frozen defaults, so today's role-file behavior is
 * unchanged. Missing/invalid fields fall back to the documented defaults.
 *
 * @param raw - The raw (typically JSON/YAML-parsed) config value.
 * @returns A fully populated `CopilotConfig`.
 */
export function parseCopilotConfig(raw: unknown): CopilotConfig {
  return composeCopilotConfig([parseCopilotDraftFragment(raw)]);
}

/**
 * Parse one precedence source's `copilot` block into a partial fragment.
 *
 * The accepted shape is `{ draft: { ... } }` — the same shape used by role
 * `role.yaml`, project `.rolebox/config.json` and global `config.yaml`:
 *
 * ```yaml
 * copilot:
 *   draft:
 *     enabled: true
 * ```
 *
 * Only fields that are present AND valid land on the fragment. Invalid values
 * are treated as absent after one warning, so a lower-precedence source can
 * still supply that field. Legacy `enabled` / `rules` / `llm` keys on the
 * block each warn once and are ignored. Never throws.
 *
 * @param raw - The raw (typically JSON/YAML-parsed) `copilot` block.
 * @returns A partial draft config; `{}` when the block has no usable fields.
 */
export function parseCopilotDraftFragment(raw: unknown): CopilotDraftFragment {
  // An absent block is the normal case, not a misconfiguration: most roles
  // declare no `copilot` block and inherit project/global config, so stay
  // silent. Any other non-object value is still reported.
  if (raw === undefined) return {};

  if (!isObject(raw)) {
    log.warn(
      `Copilot config is not an object (got ${describeKind(raw)}); using defaults`,
    );
    return {};
  }

  warnLegacyKeys(raw);

  if (!isObject(raw.draft)) {
    if (raw.draft !== undefined) {
      log.warn(`Invalid "draft" value; expected object, got ${typeof raw.draft}`);
    }
    return {};
  }

  return parseCopilotDraftBlock(raw.draft);
}

/**
 * Compose the effective config from precedence-ordered fragments.
 *
 * Earlier fragments win field by field; a missing field falls through to the
 * next fragment, and fields absent from every fragment keep the frozen
 * defaults. The result is always a fresh object (never the frozen defaults).
 *
 * @param fragments - Role, project, global (and any future) fragments, in
 *                    precedence order (highest first).
 * @returns A fully populated `CopilotConfig`.
 */
export function composeCopilotConfig(
  fragments: readonly (CopilotDraftFragment | undefined)[],
): CopilotConfig {
  const draft: CopilotDraftConfig = { ...DEFAULT_COPILOT_DRAFT_CONFIG };

  // Walk lowest-to-highest so an earlier (higher-precedence) fragment
  // overwrites a field a later fragment already supplied.
  for (let index = fragments.length - 1; index >= 0; index -= 1) {
    const fragment = fragments[index];
    if (fragment === undefined) continue;
    if (fragment.enabled !== undefined) draft.enabled = fragment.enabled;
    if (fragment.provider !== undefined) draft.provider = fragment.provider;
    if (fragment.model !== undefined) draft.model = fragment.model;
    if (fragment.timeout_ms !== undefined) draft.timeout_ms = fragment.timeout_ms;
    if (fragment.max_chars !== undefined) draft.max_chars = fragment.max_chars;
    if (fragment.window_size !== undefined) draft.window_size = fragment.window_size;
    if (fragment.transcript_max_chars !== undefined) {
      draft.transcript_max_chars = fragment.transcript_max_chars;
    }
  }

  return { draft };
}

// ── Sub-parsers ─────────────────────────────────────────────────────

/**
 * Parse the `draft` sub-block into a partial fragment.
 * `draft: {}` is valid and yields an empty fragment. Numeric fields are
 * clamped to their documented bounds; an invalid (non-numeric) value warns and
 * is omitted (treated as absent).
 */
function parseCopilotDraftBlock(
  raw: Record<string, unknown>,
): CopilotDraftFragment {
  const fragment: CopilotDraftFragment = {};

  const enabled = asBoolean(raw.enabled);
  if (enabled !== undefined) {
    fragment.enabled = enabled;
  } else if (raw.enabled !== undefined) {
    log.warn(`Invalid "enabled" value; expected boolean, got ${typeof raw.enabled}`);
  }

  const provider = parseOptionalString(raw.provider, "provider");
  if (provider !== undefined) fragment.provider = provider;

  const model = parseOptionalString(raw.model, "model");
  if (model !== undefined) fragment.model = model;

  const timeoutMs = parseOptionalBoundedNumber(raw.timeout_ms, "timeout_ms", 200, 10_000);
  if (timeoutMs !== undefined) fragment.timeout_ms = timeoutMs;

  const maxChars = parseOptionalBoundedNumber(raw.max_chars, "max_chars", 16, 500);
  if (maxChars !== undefined) fragment.max_chars = maxChars;

  const windowSize = parseOptionalBoundedNumber(raw.window_size, "window_size", 2, 40);
  if (windowSize !== undefined) fragment.window_size = windowSize;

  const transcriptMaxChars = parseOptionalBoundedNumber(
    raw.transcript_max_chars,
    "transcript_max_chars",
    500,
    20_000,
  );
  if (transcriptMaxChars !== undefined) {
    fragment.transcript_max_chars = transcriptMaxChars;
  }

  return fragment;
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Human-readable kind of a non-object config value. `typeof null` is
 * misleadingly `"object"`, so null and arrays are named explicitly.
 */
function describeKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/**
 * Warn once for every removed top-level key present on the raw block.
 * Legacy keys are otherwise ignored; parsing never throws.
 */
function warnLegacyKeys(raw: Record<string, unknown>): void {
  for (const key of LEGACY_KEYS) {
    if (raw[key] !== undefined) {
      log.warn(`copilot.${key} was removed; use copilot.draft`);
    }
  }
}

/**
 * Parse an optional non-empty string field. A present but invalid value warns
 * and is omitted (the field stays absent so a lower source can supply it).
 */
function parseOptionalString(
  value: unknown,
  key: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim() !== "") return value;
  log.warn(`Invalid "${key}" value; expected non-empty string, got ${typeof value}`);
  return undefined;
}

/**
 * Parse an optional bounded numeric field. Non-numeric values warn and are
 * omitted (absent); numeric values (including numeric strings) are clamped to
 * `[min, max]`.
 */
function parseOptionalBoundedNumber(
  value: unknown,
  key: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = asNumber(value);
  if (parsed === undefined || !Number.isFinite(parsed)) {
    log.warn(`Invalid "${key}" value; expected number, got ${typeof value}`);
    return undefined;
  }
  return Math.min(max, Math.max(min, parsed));
}
