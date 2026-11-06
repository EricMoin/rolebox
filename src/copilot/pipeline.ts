/**
 * Turn-end decision pipeline.
 *
 * Runs exactly ONE policy source at `session.idle`: the builtin
 * function-continuation source (src/copilot/sources/builtin.ts). Its call
 * arguments and return semantics are unchanged from the original extraction —
 * when it injects a continuation, this pipeline returns true; otherwise it
 * returns false.
 *
 * The former user heuristic-rule source (src/copilot/rules.ts), LLM-role
 * verdict source (src/copilot/llm.ts) and verdict prompt builder
 * (src/copilot/prompt.ts) were removed with the turn-end copilot decision
 * modes. Copilot is now a composer draft suggester; the builtin continuation
 * policy is independent of it.
 */

import type { ISessionClient } from "../platform/ports/session-client.ts";
import type { ResolvedFunction } from "../types.ts";
import type { ArtifactStore } from "../function/artifact-store.ts";
import { evaluateBuiltinContinuation } from "./sources/builtin.ts";

// ── Types ─────────────────────────────────────────────────────────────

/** Pipeline-level dependencies (a subset of HookDeps). */
export interface TurnEndPipelineDeps {
  /** Platform session client — the injection channel for the continuation
   *  reminder. */
  session: ISessionClient;
  /** Workspace directory (feeds the builtin CondEnv). */
  dir: string;
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
 * Run the builtin turn-end continuation for one `session.idle`.
 *
 * @returns true when a continuation prompt was successfully sent; false
 *          otherwise (the builtin source declined or its send failed).
 */
export async function runTurnEndPipeline(
  deps: TurnEndPipelineDeps,
  sid: string,
  ctx: TurnEndPipelineContext,
): Promise<boolean> {
  return evaluateBuiltinContinuation({
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
}
