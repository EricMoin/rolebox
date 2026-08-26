// ── Builtin policy source (source #1 of the unified turn-end pipeline) ──
//
// Byte-identical extraction of the function-continuation phase that previously
// lived inline in src/hooks/event-handler.ts (session.idle, lines ~147-256).
// Pure extraction refactor — NO behavior change: same gates, same decision
// inputs, same prompt injection, same rollback semantics.
//
// The unified turn-end decision pipeline (wired in a later subtask) evaluates
// policy sources in order; this builtin source is the incumbent continuation
// policy and must remain behaviorally equivalent to the code it replaced.
// Keep this module in sync with the caller contract in event-handler.ts.

import type { ISessionClient } from "../../platform/ports/session-client.ts";
import type { ResolvedFunction } from "../../types.ts";
import type { ArtifactStore } from "../../function/artifact-store.ts";
import { FunctionContext } from "../../function/context.ts";
import { evaluateCondition, type CondEnv } from "../../function/conditions.ts";
import { decideContinuation } from "../../function/continuation.ts";
import { loadHandlers, safeCall } from "../../function/handlers-loader.ts";
import { functionRuntime } from "../../function/runtime-state.ts";
import { functionSessionState } from "../../function/session-state.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("copilot-source:builtin");

/** Inputs the builtin continuation source needs from the session.idle handler. */
export interface BuiltinContinuationContext {
  /** The session being evaluated. */
  sessionID: string;
  /**
   * Active function names to evaluate, iterated in insertion order — the SAME
   * Set the caller computed (iteration order decides which fn wins the ONE
   * continuation-per-idle race).
   */
  activeSet: Set<string>;
  /** All resolved functions for the session's roles — resolves each name. */
  allFns: ResolvedFunction[];
  /** Whether any active fn declares Tier-2 handlers (precomputed by caller). */
  hasHandlers: boolean;
  /** Last assistant text (precomputed by the caller; may be null). */
  lastText: string | null;
  artifacts: ArtifactStore;
  /** Workspace directory — feeds CondEnv.workspaceDir. */
  workspaceDir: string;
  /** Hook-owned session→agent registry (sessionAgentRegistry). */
  sessionAgentRegistry: Map<string, string>;
  /** Platform session client used to inject the continuation reminder. */
  session: ISessionClient;
}

/**
 * Builtin continuation policy — ONE continuation per idle event.
 *
 * Encapsulates the exact logic extracted from event-handler.ts session.idle:
 * per-function loop over `functionRuntime.all(sid)`, gated-unblock backstop
 * (120s default), requires_evidence gate, declarative continue_until + additive
 * shouldContinue, the unmodified decideContinuation call (cfg
 * `{ globalMaxTurns: 25, perFnMax: fn.continue_max ?? 5 }` — DEFAULT_COOLDOWN_RULES
 * applies inside decideContinuation when cfg.cooldownRules is absent), prompt
 * injection via `session.prompt` with the [auto-continue N/M for fn] reminder,
 * and prompt-failure rollback of continuationCount + cooldownUntilTurn.
 *
 * @returns true when a continuation prompt was successfully sent.
 */
export async function evaluateBuiltinContinuation(
  ctx: BuiltinContinuationContext,
): Promise<boolean> {
  const { sessionID: sid, activeSet, allFns, artifacts, hasHandlers, lastText } = ctx;
  let sentContinuation = false;
  let burst = 0;
  for (const st of functionRuntime.all(sid).values()) burst += st.continuationCount;
  for (const name of activeSet) {
    // Re-check active (onIdle may have deactivated)
    if (!functionSessionState.getActive(sid).has(name)) continue;
    const fn = allFns.find((f) => f.name === name);
    if (!fn) continue;
    const st = functionRuntime.get(sid, name);
    if (!st || st.phase === "complete") continue;
    if (st.phase === "gated") {
      // Bounded backstop: if blockedAt is set and the wall-clock timeout
      // has expired, force-unblock so the next idle cycle re-evaluates
      // continue_until rather than parking the orchestrator forever.
      if (
        st.blockedAt != null &&
        Date.now() - st.blockedAt > (st.blockedTimeoutMs ?? 120_000)
      ) {
        st.phase = "active";
        st.evidenceObserved["paused"] = false;
        st.blockedAt = undefined;
        functionRuntime.markDirty();
        log.info("force-unblocked gated function (blocked timeout)", {
          sessionID: sid,
          fnName: name,
        });
        // fall through to continuation logic below
      } else {
        continue; // still gated, skip continuation
      }
    }

    // Skip continuation entirely if requires_evidence is declared but not yet met.
    // This prevents e.g. synthesize from auto-continuing on DIRECT-path responses
    // where dispatch_output was never called and evidence was never observed.
    const requiredEvidence = fn.requires_evidence ?? [];
    if (requiredEvidence.length > 0) {
      const allMet = requiredEvidence.every((t) => st.evidenceObserved[t] === true);
      if (!allMet) continue;
    }

    let wantsContinue = false;
    let reason = "completion condition not yet met";

    // Declarative: continue_until
    if (fn.continue_until) {
      const env: CondEnv = { sessionID: sid, fnName: name, state: st, artifacts,
        requiredEvidence, userMessagedThisTurn: false, workspaceDir: ctx.workspaceDir };
      if (evaluateCondition(fn.continue_until, env)) {
        st.phase = "complete"; functionRuntime.markDirty(); continue;
      }
      wantsContinue = true;
    }

    // Imperative: shouldContinue (additive — can request but cannot veto declarative)
    if (fn.handlers && hasHandlers) {
      const mod = await loadHandlers(fn.filePath, fn.handlers);
      if (mod?.shouldContinue) {
        const hctx = new FunctionContext(
          sid, fn.name, functionRuntime, artifacts,
          lastText, fn.state_schema_version ?? 1,
        );
        const handlerWants = await safeCall(() => mod.shouldContinue!(hctx));
        if (handlerWants === true) {
          wantsContinue = true;
          const stashed = (st.kv.__pendingContinuationReasons as string[]) ?? [];
          reason = stashed.length > 0 ? stashed.join("; ") : "handler requested continuation";
        } else if (handlerWants === false && !fn.continue_until) {
          st.phase = "complete"; functionRuntime.markDirty(); continue;
        }
      }
    }

    delete st.kv.__pendingContinuationReasons;
    if (!wantsContinue) continue;

    // Snapshot cooldown before decideContinuation so a failed prompt send
    // can roll back BOTH of its mutations (continuationCount increment and
    // a possible cooldownUntilTurn arming) atomically.
    const cooldownBeforeDecision = st.cooldownUntilTurn;
    const decision = decideContinuation({
      fnName: name, st, reason,
      cfg: { globalMaxTurns: 25, perFnMax: fn.continue_max ?? 5 },
      totalContinuationsThisBurst: burst,
    });
    if (decision.shouldContinue && decision.reminder) {
      const sessionAgent = ctx.sessionAgentRegistry.get(sid);
      try {
        await ctx.session.prompt(sid, {
          parts: [{ type: "text", text: decision.reminder }],
          agent: sessionAgent || undefined,
        });
        // Only persist and mark as sent on success
        functionRuntime.markDirty();
        sentContinuation = true;
        break; // ONE continuation per idle event
      } catch (err) {
        log.warn("Failed to send continuation prompt", { sessionID: sid, err });
        // Rollback the continuation count that decideContinuation incremented
        st.continuationCount -= 1;
        // Restore the cooldown snapshot: decideContinuation may have armed a
        // cooldown rule at the (now rolled-back) count. A transient prompt
        // failure must not leave a stale cooldown that suppresses future
        // continuations — keep continuationCount and cooldownUntilTurn consistent.
        st.cooldownUntilTurn = cooldownBeforeDecision;
        // Do NOT mark dirty — no state change to persist on failure
      }
    }
  }
  return sentContinuation;
}
