/**
 * Verdict-request prompt assembly for the LLM-role copilot mode.
 *
 * This module is the PROMPT-LEVEL safety surface of the turn-end decision
 * pipeline. Per user decision 5, ALL destructive-operation and
 * human-in-the-loop (HITL) caution lives HERE as advisory guidance text for
 * the LLM role — there is deliberately NO code-level guardrail or
 * enforcement logic anywhere in the pipeline (pattern-blocking of
 * destructive ops was explicitly removed by user decision). The role acts
 * freely; the guidance is exactly that: guidance, not a gate.
 *
 * The module owns no pipeline logic and no I/O — it only assembles prompt
 * text. The transcript it embeds comes from src/copilot/transcript.ts;
 * injected replies are stamped with the COPILOT_MARKER by the injection
 * layer, not here.
 */

// ── Default advisory guidance ──────────────────────────────────────────
//
// ADVISORY by design (user decision 5): this text steers the verdict LLM
// toward handing control back to the human in risky situations, but nothing
// in code enforces it. A configured `llm.guidance` replaces this entire
// block verbatim (replace-if-present semantics — user-approved).

const DEFAULT_GUIDANCE = [
  "When the assistant is asking for human approval (HITL / approval-pending) or is about to perform a destructive operation (delete, overwrite, force-push, reset, migration), prefer hand_to_user.",
  'When the assistant is blocked on a trivial confirmation or asks "should I continue?", you may advance with a short, factual reply if you are confident.',
  "Never fabricate facts, tool results, or user intent; never answer questions that need the human's own knowledge.",
].join("\n");

/** Verdict-contract text — the machine-readable reply format for the LLM. */
const VERDICT_CONTRACT =
  'Reply with EXACTLY one JSON object, nothing else: {"advance": true|false, "replyText": "<text to inject as the user message, only if advance>"}. advance: true -> inject replyText. advance: false -> hand control to the human.';

// ── Public API ──────────────────────────────────────────────────────

export interface VerdictPromptOptions {
  /** Session id stamped into the role-identity header. */
  sid: string;
  /**
   * Assembled role-labeled transcript of the tail window
   * (src/copilot/transcript.ts); embedded verbatim in the TRANSCRIPT section.
   */
  transcript: string;
  /**
   * Custom guidance from `llm.guidance` in the copilot config. When present,
   * it REPLACES the entire default GUIDANCE block (replace-if-present
   * semantics — user-approved decision). Absent -> the default advisory
   * guidance is used. Still advisory: never enforced in code.
   */
  guidance?: string;
}

/**
 * Build the copilot verdict-request prompt for the LLM role.
 *
 * Structure:
 *   1. Role-identity header naming the session.
 *   2. GUIDANCE block — default advisory text, or the configured
 *      `llm.guidance` replacing it wholesale.
 *   3. TRANSCRIPT section embedding the assembled transcript string.
 *   4. VERDICT CONTRACT section fixing the exact JSON reply shape.
 *
 * Pure string assembly: no I/O, no side effects, no guardrails.
 */
export function buildVerdictPrompt(opts: VerdictPromptOptions): string {
  const guidance = opts.guidance ?? DEFAULT_GUIDANCE;

  const sections = [
    `[copilot-verdict-request] You are the copilot decision-maker for rolebox session ${opts.sid}. The agent finished its turn and the session is idle. Decide whether to inject a user message on the human's behalf to keep the workflow moving, or hand control back to the human.`,
    `## GUIDANCE (advisory)\n\n${guidance}`,
    `## TRANSCRIPT\n\n${opts.transcript}`,
    `## VERDICT CONTRACT\n\n${VERDICT_CONTRACT}`,
  ];

  return sections.join("\n\n");
}
