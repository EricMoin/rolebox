// ── Copilot Config Parsing ───────────────────────────────────────────
//
// Parses a raw (YAML-parsed) copilot config block into a validated
// `CopilotConfig`. Mirrors the parsing/defaults pattern of
// src/notifications/config.ts:43-58:
//   - frozen defaults for the top-level shape,
//   - warn-and-skip validation for malformed rules (unknown action,
//     missing id, no match criteria),
//   - field coercion where safe (string → boolean / number).

import { createSubLogger } from "../logger.ts";
import type { Logger } from "tslog";
import type { ILogObj } from "tslog";
import {
  asBoolean,
  asNumber,
  isObject,
} from "../notifications/config-parsers.ts";
import { COPILOT_ACTIONS } from "./types.ts";
import type {
  CopilotAction,
  CopilotConfig,
  CopilotLlmConfig,
  CopilotRule,
  CopilotTranscriptConfig,
} from "./types.ts";

const log: Logger<ILogObj> = createSubLogger("copilot-config");

// ── Defaults ────────────────────────────────────────────────────────

/** Frozen default transcript window config for LLM verdicts. */
export const DEFAULT_COPILOT_TRANSCRIPT_CONFIG: Readonly<CopilotTranscriptConfig> =
  Object.freeze({
    window_size: 20,
    max_chars: 8000,
    include_tools: true,
  });

/** Frozen default LLM verdict config (role is required and has no default). */
export const DEFAULT_COPILOT_LLM_CONFIG: Readonly<
  Omit<CopilotLlmConfig, "role">
> = Object.freeze({
  max_verdict_timeout_ms: 30000,
  transcript: DEFAULT_COPILOT_TRANSCRIPT_CONFIG,
});

/**
 * Frozen default copilot configuration.
 * Consumers never receive a shared mutable top-level shape; the parser
 * always returns a fresh object with freshly cloned arrays.
 */
export const DEFAULT_COPILOT_CONFIG: Readonly<CopilotConfig> = Object.freeze({
  enabled: false,
  rules: [],
  llm: undefined,
});

// ── Public API ──────────────────────────────────────────────────────

/**
 * Parse a raw (YAML-parsed) value into a validated `CopilotConfig`.
 *
 * Coerces strings to booleans/numbers where safe (e.g. `"true"` → `true`).
 * Logs warnings for invalid fields, skips malformed rules (unknown action,
 * missing id, no match criteria), and falls back to defaults for a
 * non-object input.
 *
 * @param raw - The raw (typically JSON/YAML-parsed) config value.
 * @returns A fully populated `CopilotConfig`.
 */
export function parseCopilotConfig(raw: unknown): CopilotConfig {
  if (!isObject(raw)) {
    log.warn("Copilot config is not an object; using defaults");
    return { ...DEFAULT_COPILOT_CONFIG, rules: [] };
  }

  const result: CopilotConfig = {
    enabled: false,
    rules: [],
    llm: undefined,
  };

  const enabled = asBoolean(raw.enabled);
  if (enabled !== undefined) {
    result.enabled = enabled;
  } else if (raw.enabled !== undefined) {
    log.warn(`Invalid "enabled" value; expected boolean, got ${typeof raw.enabled}`);
  }

  if (Array.isArray(raw.rules)) {
    result.rules = parseCopilotRules(raw.rules);
  } else if (raw.rules !== undefined) {
    log.warn(`Invalid "rules" value; expected array, got ${typeof raw.rules}`);
  }

  if (isObject(raw.llm)) {
    const llm = parseCopilotLlmConfig(raw.llm);
    if (llm) result.llm = llm;
  } else if (raw.llm !== undefined) {
    log.warn(`Invalid "llm" value; expected object, got ${typeof raw.llm}`);
  }

  return result;
}

// ── Sub-parsers ─────────────────────────────────────────────────────

/**
 * Parse a raw `rules` array into validated rules.
 * Malformed entries are skipped with a warning; duplicate ids are dropped
 * (id uniqueness is part of the CopilotRule contract).
 */
function parseCopilotRules(raw: unknown[]): CopilotRule[] {
  const parsed: CopilotRule[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const rule = parseCopilotRule(raw[i]);
    if (rule === null) {
      log.warn(`Skipping invalid copilot rule at index ${i}`);
      continue;
    }
    if (seenIds.has(rule.id)) {
      log.warn(`Skipping duplicate copilot rule id "${rule.id}" at index ${i}`);
      continue;
    }
    seenIds.add(rule.id);
    parsed.push(rule);
  }
  return parsed;
}

/**
 * Parse a single raw rule entry into a validated `CopilotRule`.
 * Returns `null` (caller warns) when the entry is malformed: non-object,
 * missing/blank id, unknown action, or no match criteria.
 */
function parseCopilotRule(raw: unknown): CopilotRule | null {
  if (!isObject(raw)) return null;

  const id = raw.id;
  if (typeof id !== "string" || id.trim() === "") {
    log.warn(`Copilot rule missing required string "id"; skipping`);
    return null;
  }

  const action = raw.action;
  if (
    typeof action !== "string" ||
    !(COPILOT_ACTIONS as readonly string[]).includes(action)
  ) {
    log.warn(`Copilot rule "${id}" has unknown action "${String(action)}"; skipping`);
    return null;
  }

  const match = parseCopilotRuleMatch(raw.match);
  if (match === null) {
    log.warn(
      `Copilot rule "${id}" has no match criteria (need "pattern" and/or "contains"); skipping`,
    );
    return null;
  }

  const result: CopilotRule = {
    id,
    match,
    action: action as CopilotAction,
  };
  if (typeof raw.reply === "string") {
    result.reply = raw.reply;
  }
  return result;
}

/**
 * Parse the `match` sub-block of a rule.
 * Returns `null` when it is not an object or has neither `pattern` nor
 * `contains` (at least one is required).
 */
function parseCopilotRuleMatch(raw: unknown): CopilotRule["match"] | null {
  if (!isObject(raw)) return null;
  const match: CopilotRule["match"] = {};
  if (typeof raw.pattern === "string" && raw.pattern !== "") {
    match.pattern = raw.pattern;
  }
  if (typeof raw.contains === "string" && raw.contains !== "") {
    match.contains = raw.contains;
  }
  if (match.pattern === undefined && match.contains === undefined) {
    return null;
  }
  return match;
}

/**
 * Parse the optional `llm` block into a validated `CopilotLlmConfig`.
 * Returns `undefined` when the block is not an object or lacks the required
 * `role` string; all other fields fall back to frozen defaults.
 */
function parseCopilotLlmConfig(raw: unknown): CopilotLlmConfig | undefined {
  if (!isObject(raw)) return undefined;

  const role = raw.role;
  if (typeof role !== "string" || role.trim() === "") {
    log.warn(`Copilot llm config missing required string "role"; ignoring llm block`);
    return undefined;
  }

  const result: CopilotLlmConfig = {
    role,
    max_verdict_timeout_ms: DEFAULT_COPILOT_LLM_CONFIG.max_verdict_timeout_ms,
    transcript: { ...DEFAULT_COPILOT_TRANSCRIPT_CONFIG },
  };

  const timeout = asNumber(raw.max_verdict_timeout_ms);
  if (timeout !== undefined) {
    result.max_verdict_timeout_ms = timeout;
  } else if (raw.max_verdict_timeout_ms !== undefined) {
    log.warn(
      `Invalid "max_verdict_timeout_ms" value; expected number, got ${typeof raw.max_verdict_timeout_ms}`,
    );
  }

  if (typeof raw.guidance === "string") {
    result.guidance = raw.guidance;
  }

  if (isObject(raw.transcript)) {
    const transcript = parseCopilotTranscriptConfig(raw.transcript);
    if (transcript) result.transcript = transcript;
  } else if (raw.transcript !== undefined) {
    log.warn(`Invalid "transcript" value; expected object, got ${typeof raw.transcript}`);
  }

  return result;
}

/**
 * Parse the `transcript` sub-block into a validated `CopilotTranscriptConfig`.
 * Every field falls back to a frozen default; `transcript: {}` is valid and
 * yields all defaults.
 */
function parseCopilotTranscriptConfig(raw: unknown): CopilotTranscriptConfig | undefined {
  if (!isObject(raw)) return undefined;

  const result: CopilotTranscriptConfig = { ...DEFAULT_COPILOT_TRANSCRIPT_CONFIG };

  const windowSize = asNumber(raw.window_size);
  if (windowSize !== undefined) {
    result.window_size = windowSize;
  } else if (raw.window_size !== undefined) {
    log.warn(`Invalid "window_size" value; expected number, got ${typeof raw.window_size}`);
  }

  const maxChars = asNumber(raw.max_chars);
  if (maxChars !== undefined) {
    result.max_chars = maxChars;
  } else if (raw.max_chars !== undefined) {
    log.warn(`Invalid "max_chars" value; expected number, got ${typeof raw.max_chars}`);
  }

  const includeTools = asBoolean(raw.include_tools);
  if (includeTools !== undefined) {
    result.include_tools = includeTools;
  } else if (raw.include_tools !== undefined) {
    log.warn(`Invalid "include_tools" value; expected boolean, got ${typeof raw.include_tools}`);
  }

  return result;
}
