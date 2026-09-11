/**
 * Rule evaluation for the copilot turn-end decision pipeline.
 *
 * Pure, deterministic evaluator over `CopilotRule` config. This module
 * owns NO session access, NO injection, and no side effects beyond an
 * occasional log line — the decision pipeline (the next stage of the
 * pipeline) consumes the returned `RuleDecision` and performs the actual
 * reply injection / turn-end handling.
 *
 * Semantics:
 * - Rules are evaluated in config order; the FIRST match wins.
 * - `match.pattern` is a regex tested against the last assistant text.
 * - `match.contains` is a case-insensitive substring check.
 * - When both are set, BOTH must match (AND).
 * - Invalid regexes are warned about and the offending rule is skipped —
 *   evaluation never throws.
 * - A match returns a `RuleDecision`. No match returns `null`, and the
 *   pipeline falls through to the next decision source.
 * - The `skip` action is represented as a real `RuleDecision` (distinct
 *   from `null`): it means "consume the turn — no injection AND do not
 *   fall through to the LLM source".
 */

import type { CopilotAction, CopilotRule } from "./types.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("copilot-rules");

/** Default reply text per action, used when a matching rule has no custom `reply`. */
export const DEFAULT_RULE_REPLIES: Record<CopilotAction, string> = {
  continue: "Continue.",
  // "skip" consumes the decision — its reply is never injected. Empty by
  // default so the pipeline can treat `reply` as unused for skip.
  skip: "",
  blocked: "Blocked — end turn.",
  done: "Produce final output now.",
};

/** A single rule match decision. */
export interface RuleDecision {
  /** Id of the rule that matched. */
  ruleId: string;
  /** Action the pipeline must take for this turn. */
  action: CopilotAction;
  /** Reply text: the rule's custom `reply`, or the per-action default. */
  reply: string;
}

/**
 * Evaluate `rules` against the last assistant text.
 *
 * Returns the first matching rule's decision, or `null` when no rule
 * matches (the pipeline then falls through to the next decision source).
 * A `skip` match still returns a decision object — it is NOT `null`.
 */
export function evaluateRules(
  rules: CopilotRule[],
  lastAssistantText: string,
): RuleDecision | null {
  const list = Array.isArray(rules) ? rules : [];
  const text = typeof lastAssistantText === "string" ? lastAssistantText : "";

  for (const rule of list) {
    if (!ruleMatches(rule, text)) continue;
    return {
      ruleId: rule.id,
      action: rule.action,
      reply: rule.reply !== undefined ? rule.reply : DEFAULT_RULE_REPLIES[rule.action],
    };
  }
  return null;
}

/**
 * Whether a single rule matches the text. Degenerate criteria (no match
 * criteria at all, or an invalid/empty criterion) never match and are
 * warned about — the rule is skipped, matching the config parser's
 * warn-and-drop philosophy.
 */
function ruleMatches(rule: CopilotRule, text: string): boolean {
  const match = rule.match;
  if (match.pattern === undefined && match.contains === undefined) {
    log.warn(`Copilot rule "${rule.id}" has no match criteria; ignoring`);
    return false;
  }

  if (match.pattern !== undefined) {
    const re = compilePattern(rule.id, match.pattern);
    if (re === null) return false;
    // Defensive: regexes with /g or /y flags keep a stateful lastIndex.
    re.lastIndex = 0;
    if (!re.test(text)) return false;
  }

  if (match.contains !== undefined) {
    if (match.contains.length === 0) {
      log.warn(`Copilot rule "${rule.id}" has empty "contains"; ignoring`);
      return false;
    }
    if (!text.toLowerCase().includes(match.contains.toLowerCase())) return false;
  }

  return true;
}

/**
 * Compile a rule's regex pattern defensively.
 * Returns `null` (and warns) on an invalid pattern — evaluation never throws.
 */
function compilePattern(ruleId: string, pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    log.warn(`Copilot rule "${ruleId}" has invalid regex "${pattern}"; skipping`);
    return null;
  }
}
