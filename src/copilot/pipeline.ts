/**
 * Unified turn-end decision pipeline (integration subtask of the copilot
 * strategy).
 *
 * Orchestrates the three policy sources evaluated at `session.idle`, in
 * STRICT precedence order, with at most ONE injection per idle:
 *
 *   a. BUILTIN function-continuation source (src/copilot/sources/builtin.ts)
 *      — always evaluated first, semantics untouched. If it injects, STOP.
 *   b. USER heuristic rules (src/copilot/rules.ts) over the last assistant
 *      text — a match with action `skip` consumes the turn (no injection, no
 *      LLM fallthrough); a match with continue/blocked/done injects its reply
 *      text and STOPS.
 *   c. LLM role (transcript → prompt → verdict) — advance verdict injects
 *      replyText; hand_to_user (advance:false) or null (any failure) injects
 *      nothing.
 *
 * When the session's role has no copilot config, or `copilot.enabled` is
 * false, ONLY the builtin source runs — byte-identical legacy behavior.
 *
 * INVARIANT: at most ONE injection per session.idle. Each source returns as
 * soon as it injects; the next source only runs when the previous declined.
 * Copilot-sourced injections (b/c) are wrapped via `buildReminder` and MUST
 * carry COPILOT_MARKER (src/copilot/constants.ts) so they are classified as
 * synthetic on re-entry through `chat.message` (src/hooks/chat-message.ts).
 * The builtin source keeps its own existing `[auto-continue` marker.
 */

import type { ISessionClient } from "../platform/ports/session-client.ts";
import type { ResolvedFunction } from "../types.ts";
import type { ArtifactStore } from "../function/artifact-store.ts";
import type { CopilotConfig } from "./types.ts";
import { COPILOT_MARKER } from "./constants.ts";
import { evaluateBuiltinContinuation } from "./sources/builtin.ts";
import { evaluateRules, type RuleDecision } from "./rules.ts";
import { assembleTranscript } from "./transcript.ts";
import { buildVerdictPrompt } from "./prompt.ts";
import { requestVerdict } from "./llm.ts";
import { fetchLastAssistantText } from "../hooks/context.ts";
import { buildReminder } from "../prompt/reminder.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("copilot-pipeline");

// ── Types ─────────────────────────────────────────────────────────────

/** Pipeline-level dependencies (a subset of HookDeps). */
export interface TurnEndPipelineDeps {
  /** Platform session client — source of last-text/transcript reads and the
   *  injection channel for copilot-sourced replies. */
  session: ISessionClient;
  /** Workspace directory (feeds the builtin CondEnv + verdict child session). */
  dir: string;
  /**
   * Copilot config per role id, parsed at construction. Absent (or a role
   * missing from the map) → the pipeline runs ONLY the builtin source.
   */
  copilotConfigs?: Map<string, CopilotConfig>;
  /**
   * Resolved subagent registry for the LLM-role verdict source
   * (src/copilot/llm.ts). Absent → the LLM source cannot resolve its role
   * and is skipped (treated as a null verdict).
   */
  resolvedSubagents?: Map<string, { parentFullId: string }>;
}

/** Per-idle context precomputed by the session.idle handler. */
export interface TurnEndPipelineContext {
  /** Active function names in insertion order (builtin iteration order). */
  activeSet: Set<string>;
  /** All resolved functions for the session's roles. */
  allFns: ResolvedFunction[];
  /** Whether any active fn declares Tier-2 handlers. */
  hasHandlers: boolean;
  /** Last assistant text (may be null when no capture/handler needed it). */
  lastText: string | null;
  /** Function artifact store (builtin source). */
  artifacts: ArtifactStore;
  /** Hook-owned session→agent registry (sessionAgentRegistry). */
  sessionAgentRegistry: Map<string, string>;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Run the unified turn-end decision pipeline for one `session.idle`.
 *
 * @returns true when an injection was successfully sent; false otherwise
 *          (no source decided to inject, or the only source that decided
 *          failed to deliver). The return value is informational — the
 *          at-most-one-injection invariant is structural.
 */
export async function runTurnEndPipeline(
  deps: TurnEndPipelineDeps,
  sid: string,
  ctx: TurnEndPipelineContext,
): Promise<boolean> {
  const roleId = ctx.sessionAgentRegistry.get(sid);
  const config = roleId ? deps.copilotConfigs?.get(roleId) : undefined;

  // ── Source a: BUILTIN — always first, untouched semantics ────────────
  const builtinInjected = await evaluateBuiltinContinuation({
    sessionID: sid,
    activeSet: ctx.activeSet,
    allFns: ctx.allFns,
    hasHandlers: ctx.hasHandlers,
    lastText: ctx.lastText,
    artifacts: ctx.artifacts,
    workspaceDir: deps.dir,
    sessionAgentRegistry: ctx.sessionAgentRegistry,
    session: deps.session,
  });
  if (builtinInjected) return true;

  // Copilot absent or disabled → byte-identical legacy behavior (builtin only).
  if (!config || !config.enabled) return false;

  // ── Source b: USER heuristic rules over the last assistant text ──────
  if (config.rules.length > 0) {
    const lastText = await resolveLastText(deps, sid, ctx);
    const decision = evaluateRules(config.rules, lastText);
    if (decision !== null) {
      if (decision.action === "skip") {
        // Consumed — no injection AND no LLM fallthrough.
        log.debug("copilot rule consumed the turn (skip)", {
          sessionID: sid,
          ruleId: decision.ruleId,
        });
        return false;
      }
      // continue / blocked / done → inject the reply text, STOP.
      return injectCopilotReply(deps, sid, roleId, `rule:${decision.ruleId}`, decision);
    }
  }

  // ── Source c: LLM role verdict ───────────────────────────────────────
  if (config.llm) {
    const transcript = await assembleTranscript(deps.session, sid, config.llm.transcript);
    if (transcript !== null) {
      const prompt = buildVerdictPrompt({
        sid,
        transcript,
        guidance: config.llm.guidance,
      });
      const verdict = await requestVerdict(
        {
          client: deps.session,
          resolvedSubagents: deps.resolvedSubagents ?? new Map(),
          directory: deps.dir,
        },
        {
          sid,
          roleId: config.llm.role,
          prompt,
          timeoutMs: config.llm.max_verdict_timeout_ms,
        },
      );
      if (verdict && verdict.advance) {
        return injectCopilotReply(deps, sid, roleId, "llm", {
          reply: verdict.replyText,
        } as RuleDecision);
      }
      // advance:false (hand control back) or null (failure) → no injection.
    }
  }

  return false;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Resolve the last assistant text for rules evaluation. Reuses the
 * handler-precomputed value when present; otherwise fetches it lazily so the
 * legacy idle path (no copilot) never pays for an extra messages read.
 */
async function resolveLastText(
  deps: TurnEndPipelineDeps,
  sid: string,
  ctx: TurnEndPipelineContext,
): Promise<string> {
  if (ctx.lastText !== null && ctx.lastText !== undefined) return ctx.lastText;
  return (await fetchLastAssistantText(deps.session, sid)) ?? "";
}

/**
 * Inject a copilot-sourced reply into the session, wrapped via `buildReminder`
 * and stamped with COPILOT_MARKER so the re-entry through `chat.message` is
 * classified synthetic (does NOT reset continuation caps, does NOT enter
 * userMessagedSessions, does NOT cancel loops).
 *
 * @param source Marker payload naming the source (e.g. `rule:<id>` / `llm`).
 * @returns true when the prompt was accepted; false on failure (logged).
 */
async function injectCopilotReply(
  deps: TurnEndPipelineDeps,
  sid: string,
  roleId: string | undefined,
  source: string,
  decision: { reply: string },
): Promise<boolean> {
  const reminder = buildReminder({
    marker: `${COPILOT_MARKER} ${source}]`,
    body: decision.reply,
  });
  try {
    await deps.session.prompt(sid, {
      parts: [{ type: "text", text: reminder }],
      agent: roleId || undefined,
    });
    log.debug("copilot reply injected", { sessionID: sid, source });
    return true;
  } catch (err) {
    log.warn("Failed to inject copilot reply", {
      sessionID: sid,
      source,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
