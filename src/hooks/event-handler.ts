import type { Event } from "@opencode-ai/sdk";
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

// `awaiting_worker` bridges to onWorkerCompleted: when inflight hits 0 the worker
// already finished and re-prompted, so no separate coordinator event will fire.
//
// IMPORTANT: This function loops until the state machine reaches a stable waiting
// phase (awaiting_worker, dispatching) or a terminal phase. Without the loop,
// calling onWorkerCompleted() transitions to "summarizing" but nobody calls
// onOriginIdle() to advance further — deadlocking the loop until an external
// event (potentially minutes later) fires another session.idle for the origin.
async function bridgeLoopAdvance(
  coord: LoopCoordinator,
  sid: string,
): Promise<void> {
  // Safety cap prevents infinite loops if state transitions cycle unexpectedly
  const MAX_ADVANCES = 5;
  for (let i = 0; i < MAX_ADVANCES; i++) {
    const loopState = coord.getLoopState(sid);
    if (!loopState) return;

    const prevPhase = loopState.phase;

    if (loopState.phase === "activating" || loopState.phase === "summarizing") {
      await coord.onOriginIdle(sid);
    } else if (loopState.phase === "awaiting_worker" && loopState.activeWorkerTaskId) {
      await coord.onWorkerCompleted(loopState.activeWorkerTaskId);
    } else {
      // Terminal or dispatching — nothing more to advance synchronously
      return;
    }

    // Re-read state after the transition
    const newState = coord.getLoopState(sid);
    if (!newState) return;

    // If phase didn't change, the transition was a no-op — bail to avoid livelock
    if (newState.phase === prevPhase) return;

    // If we entered a phase that requires waiting for external input, stop
    if (newState.phase === "awaiting_worker" || newState.phase === "dispatching") return;
  }
}

export async function handleEvent(
  event: Event,
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
      // advance logic further down can still execute.
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
      if (activeSet.size === 0 || suppressLoopContinuation) {
        // Loop advance: handle phase transitions when no continuation is needed
        if (deps.loopManager && deps.dispatchManager.getInflightCount(sid) === 0) {
          const coord = deps.loopManager as LoopCoordinator | undefined;
          if (coord && coord.isActiveLoopOrigin(sid)) {
            await bridgeLoopAdvance(coord, sid);
            break;
          }
        }
        if (activeSet.size === 0) break;
      }
      if (suppressLoopContinuation) break;

      const allFns = collectAllFunctions(deps.roleFunctionsMap);
      const artifacts = new ArtifactStore(deps.dir);

      const activeFns = allFns.filter((f) => activeSet.has(f.name));

      // Fetch last assistant text (needed for text capture + handler context)
      const hasCapture = activeFns.some((f) =>
        (f.observe ?? []).some((s) => s.on === "tool_after" && s.capture_artifact),
      );
      const hasHandlers = activeFns.some((f) => !!f.handlers);
      const lastText = (hasCapture || hasHandlers)
        ? await fetchLastAssistantText(deps.client, sid)
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
            requiredEvidence, userMessagedThisTurn: false };
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
        functionRuntime.markDirty();
        if (decision.shouldContinue && decision.reminder) {
          const sessionAgent = state.sessionAgentRegistry.get(sid);
          await deps.client.session.promptAsync({
            path: { id: sid },
            body: {
              ...sessionAgent ? { agent: sessionAgent } : {},
              parts: [{ type: "text", text: decision.reminder }],
            },
          }).catch((err) => {
            log.warn("Failed to send continuation prompt", { sessionID: sid, err });
          });
          sentContinuation = true;
          break; // ONE continuation per idle event
        }
      }
      // --- LOOP ADVANCE: advance a loop session on terminal idle ---
      if (!sentContinuation && deps.dispatchManager.getInflightCount(sid) === 0) {
        const coord = deps.loopManager as LoopCoordinator | undefined;
        if (coord && coord.isActiveLoopOrigin(sid)) {
          await bridgeLoopAdvance(coord, sid);
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
