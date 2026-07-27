import type { CanonicalEvent } from "../platform/types.ts";
import { functionSessionState } from "../function/session-state.ts";
import { functionRuntime } from "../function/runtime-state.ts";
import { ArtifactStore } from "../function/artifact-store.ts";
import { loadHandlers, safeCall } from "../function/handlers-loader.ts";
import { FunctionContext } from "../function/context.ts";
import { evaluateCondition, type CondEnv } from "../function/conditions.ts";
import { decideContinuation } from "../function/continuation.ts";
import { runTextCapture } from "../function/observe.ts";
import { collectAllFunctions, fetchLastAssistantText, appendCorrection } from "./context.ts";
import { drainHandlerContext } from "./drain-handler.ts";
import { createSubLogger } from "../logger.ts";
import type { LoopCoordinator } from "../loop/coordinator.ts";
import type { HookState } from "./state.ts";
import type { HookDeps } from "./deps.ts";

const log = createSubLogger("hook-event");

export async function handleEvent(
  event: CanonicalEvent,
  state: HookState,
  deps: HookDeps,
): Promise<void> {
  const props = event.properties as Record<string, unknown> | undefined;

  // Built-in hooks: before phase (runs before custom hooks)
  await deps.builtInHooks?.runHooks(
    "event",
    "before",
    () => ({
      hookName: "[builtin.before]",
      config: undefined,
      sessionID: typeof props?.sessionID === "string" ? props.sessionID : undefined,
      inject: (text: string) => {
        const sid = typeof props?.sessionID === "string" ? props.sessionID : undefined;
        if (sid) appendCorrection(state.pendingCorrections, sid, text);
      },
      log: createSubLogger("hook:builtin-before"),
    }),
    { type: event.type, properties: props },
    deps.builtinConfig ?? {},
  );

  // Custom hooks: before phase
  await deps.customHooks.runHooks(
    "event",
    "before",
    () => ({
      hookName: "[custom.before]",
      config: undefined,
      sessionID: typeof props?.sessionID === "string" ? props.sessionID : undefined,
      inject: (text: string) => {
        const sid = typeof props?.sessionID === "string" ? props.sessionID : undefined;
        if (sid) appendCorrection(state.pendingCorrections, sid, text);
      },
      log: createSubLogger("hook:custom-before"),
    }),
    { type: event.type, properties: props },
  );

  switch (event.type) {
    case "session.idle": {
      const sid = (props as { sessionID?: string } | undefined)?.sessionID;
      if (!sid) break;
      await deps.dispatchManager.handleSessionIdle(sid);
      deps.notificationManager?.scheduleIdle(sid);
      // --- function CONTINUE ---
      // Skip continuation for sync dispatch sessions: promptAsync would
      // prevent session.prompt() from resolving, causing an infinite hang.
      if (deps.dispatchManager.isSyncSession(sid)) {
        log.debug("skipping function continuation for sync session", { sessionID: sid });
        break;
      }

      // Invariant: while awaiting in-flight dispatches, the completion
      // <system-reminder> wakes the parent — auto-continue must NOT (it would
      // spin-poll an unsatisfiable continue_until until results arrive).
      const inflight = deps.dispatchManager.getInflightCount(sid);
      if (inflight > 0) {
        log.debug("suppressing auto-continue: parent awaiting in-flight dispatch", {
          sessionID: sid,
          inflight,
        });
        break;
      }
      // Suppress function continuation for active loop origins during loop-owned
      // phases (summarizing, activating, finalizing). Worker continuation is
      // unaffected. NOTE: we use a flag instead of `break` so that the loop
      let suppressLoopContinuation = false;
      if (deps.loopManager?.isActiveLoopOrigin(sid)) {
        const loopState = deps.loopManager.getLoopState(sid);
        if (loopState && (loopState.phase === "summarizing" || loopState.phase === "activating" || loopState.phase === "finalizing")) {
          log.debug("suppressing auto-continue: origin session in loop-owned phase", {
            sessionID: sid, phase: loopState.phase,
          });
          suppressLoopContinuation = true;
        }
      }
      const activeSet = functionSessionState.getActive(sid);
      if (activeSet.size === 0) break;

      const allFns = collectAllFunctions(deps.roleFunctionsMap);
      const artifacts = new ArtifactStore(deps.dir);

      const activeFns = allFns.filter((f) => activeSet.has(f.name));

      // Fetch last assistant text (needed for text capture + handler context)
      const hasCapture = activeFns.some((f) =>
        (f.observe ?? []).some((s) => s.on === "tool_after" && s.capture_artifact),
      );
      const hasHandlers = activeFns.some((f) => !!f.handlers);
      const lastText = (hasCapture || hasHandlers)
        ? await fetchLastAssistantText(deps.session, sid)
        : null;
      if (hasCapture && lastText) {
        runTextCapture({ sessionID: sid, activeFns, artifacts, assistantText: lastText });
      }

      // --- Tier-2 handlers: onIdle (Phase 1 — side-effects for all handler fns) ---
      if (hasHandlers) {
        for (const fn of activeFns) {
          if (!fn.handlers) continue;
          const mod = await loadHandlers(fn.filePath, fn.handlers);
          if (!mod?.onIdle) continue;
          const ctx = new FunctionContext(
            sid, fn.name, functionRuntime, artifacts,
            lastText, fn.state_schema_version ?? 1,
          );
          await safeCall(() => mod.onIdle!(ctx));
          drainHandlerContext(ctx, sid, fn.name, state.pendingCorrections, functionSessionState, functionRuntime, allFns);
        }
        functionRuntime.markDirty();
      }

      // --- Continuation (Phase 2 — ONE continuation per idle) ---
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
            requiredEvidence, userMessagedThisTurn: false, workspaceDir: deps.dir };
          if (evaluateCondition(fn.continue_until, env)) {
            st.phase = "complete"; functionRuntime.markDirty(); continue;
          }
          wantsContinue = true;
        }

        // Imperative: shouldContinue (additive — can request but cannot veto declarative)
        if (fn.handlers && hasHandlers) {
          const mod = await loadHandlers(fn.filePath, fn.handlers);
          if (mod?.shouldContinue) {
            const ctx = new FunctionContext(
              sid, fn.name, functionRuntime, artifacts,
              lastText, fn.state_schema_version ?? 1,
            );
            const handlerWants = await safeCall(() => mod.shouldContinue!(ctx));
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

        const decision = decideContinuation({
          fnName: name, st, reason,
          cfg: { globalMaxTurns: 25, perFnMax: fn.continue_max ?? 5 },
          totalContinuationsThisBurst: burst,
        });
        if (decision.shouldContinue && decision.reminder) {
          const sessionAgent = state.sessionAgentRegistry.get(sid);
          try {
            await deps.session.prompt(sid, {
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
            // Do NOT mark dirty — no state change to persist on failure
          }
        }
      }
      break;
    }
    case "session.status": {
      const sid = (props as { sessionID?: string } | undefined)?.sessionID;
      if (sid) {
        // NOTE: status field shape varies by SDK version. Using raw property access.
        const statusVal = props?.status;
        const statusType = typeof statusVal === "object" && statusVal !== null
          ? ((statusVal as { type?: string }).type ?? String(statusVal))
          : String(statusVal ?? "");
        deps.dispatchManager.handleSessionStatus(sid, statusType);
      }
      break;
    }
    case "session.error": {
      const sid = (props as { sessionID?: string } | undefined)?.sessionID;
      if (sid) {
        await deps.dispatchManager.handleSessionError(sid, props?.error);
        const coord = deps.loopManager as LoopCoordinator | undefined;
        if (coord?.isLoopSession(sid)) {
          const loopState = coord.getLoopState(sid);
          if (loopState && loopState.phase !== "error" && loopState.phase !== "complete" && loopState.phase !== "cancelled") {
            await coord.failSession(sid, typeof props?.error === "string" ? props.error : "Session error");
          }
        }
        deps.notificationManager?.handleSessionError(sid);
      }
      break;
    }
    case "session.deleted": {
      const info = props?.info as { id?: string } | undefined;
      const did = info?.id;
      if (did) {
        await deps.dispatchManager.handleSessionDeleted(did);
        deps.notificationManager?.handleSessionDeleted(did);
      }
      break;
    }
    case "message.updated": {
      const info = props?.info as { sessionID?: string } | undefined;
      const msid = info?.sessionID;
      if (msid) {
        deps.dispatchManager.handleMessageUpdated(msid);
        deps.notificationManager?.handleMessageUpdated(msid);
      }
      break;
    }
  }

  // Custom hooks: after phase
  await deps.customHooks.runHooks(
    "event",
    "after",
    () => ({
      hookName: "[custom.after]",
      config: undefined,
      sessionID: typeof props?.sessionID === "string" ? props.sessionID : undefined,
      inject: (text: string) => {
        const sid = typeof props?.sessionID === "string" ? props.sessionID : undefined;
        if (sid) appendCorrection(state.pendingCorrections, sid, text);
      },
      log: createSubLogger("hook:custom-after"),
    }),
    { type: event.type, properties: props },
  );

  // Built-in hooks: after phase (runs after custom hooks)
  await deps.builtInHooks?.runHooks(
    "event",
    "after",
    () => ({
      hookName: "[builtin.after]",
      config: undefined,
      sessionID: typeof props?.sessionID === "string" ? props.sessionID : undefined,
      inject: (text: string) => {
        const sid = typeof props?.sessionID === "string" ? props.sessionID : undefined;
        if (sid) appendCorrection(state.pendingCorrections, sid, text);
      },
      log: createSubLogger("hook:builtin-after"),
    }),
    { type: event.type, properties: props },
    deps.builtinConfig ?? {},
  );
}
