import { parseFunctionActivation } from "../function-parser.ts";
import { functionSessionState } from "../session-state.ts";
import { graphSessionState } from "../graph/index.ts";
import { functionRuntime } from "../function/runtime-state.ts";
import { runActivateObserve, runMessageObserve } from "../function/observe.ts";
import { collectAllFunctions, appendCorrection } from "./context.ts";
import { isDispatchNotification } from "../dispatch/notification.ts";
import { parseLoopParams } from "../loop/params.ts";
import { LOOP_PROGRESS_MARKER, LOOP_FUNCTION_NAME } from "../loop/constants.ts";
import { createSubLogger } from "../logger.ts";
import type { HookState } from "./state.ts";
import type { HookDeps } from "./deps.ts";

const log = createSubLogger("hook-chat-msg");

export async function handleChatMessage(
  input: { agent?: string; sessionID: string },
  output: { parts: Array<{ type: string; text?: string }> },
  state: HookState,
  deps: HookDeps,
): Promise<void> {
  const firstText = output.parts.find(
    (p: { type: string; text?: string }) => p.type === "text" && typeof p.text === "string",
  ) as { text?: string } | undefined;
  const firstTextStr = firstText?.text ?? "";
  const isSyntheticInjection =
    firstTextStr.includes("[auto-continue") ||
    firstTextStr.includes(LOOP_PROGRESS_MARKER) ||
    isDispatchNotification(firstTextStr);
  if (input.sessionID && !isSyntheticInjection) {
    state.userMessagedSessions.add(input.sessionID);
    if (state.activeLoopManager?.shouldCancelOnUserMessage(input.sessionID, firstTextStr)) {
      await state.activeLoopManager.cancelNow(input.sessionID);
    }
  }

  const textPartIndex = output.parts.findIndex(
    (p: { type: string; text?: string }) => p.type === "text" && "text" in p,
  );
  if (textPartIndex === -1) return;

  const part = output.parts[textPartIndex] as { type: string; text: string };
  const agentId = input.agent as string | undefined;

  if (agentId && input.sessionID) {
    state.sessionAgentRegistry.set(input.sessionID, agentId);
  }

  if (agentId && input.sessionID && !state.autoActivatedSessions.has(input.sessionID)) {
    const autoFns = state.roleAutoActivateMap.get(agentId);
    if (autoFns && autoFns.length > 0) {
      const lockedNames = state.roleLockedMap.get(agentId) ? autoFns : undefined;
      functionSessionState.activateDefaults(input.sessionID, autoFns, lockedNames);
      state.autoActivatedSessions.add(input.sessionID);

      const autoActiveFns = collectAllFunctions(deps.roleFunctionsMap).filter((f) => autoFns.includes(f.name));

      // Init runtime state for auto-activated functions before firing on:activate
      for (const fn of autoActiveFns) {
        functionRuntime.init(input.sessionID, fn.name, fn.state_schema_version ?? 1);
      }

      if (autoActiveFns.length > 0) {
        const activateInjects = runActivateObserve({
          sessionID: input.sessionID,
          activeFns: autoActiveFns,
        });
        for (const inj of activateInjects) {
          appendCorrection(state.pendingCorrections, input.sessionID, inj);
        }
      }
    }
  }

  const { functions: parsedFunctions, calls, cleanedText } = parseFunctionActivation(part.text);

  if (parsedFunctions.length > 0) {
    part.text = cleanedText;

    const roleId = input.agent;
    const roleFunctions = roleId ? deps.roleFunctionsMap.get(roleId) : null;

    if (roleFunctions) {
      const validNames = new Set(roleFunctions.map((f) => f.name));
      const validFunctions = parsedFunctions.filter((fn) => validNames.has(fn));
      const validCalls = calls.filter((c) => validNames.has(c.name));
      functionSessionState.activate(input.sessionID, validFunctions, validCalls);
    } else {
      functionSessionState.activate(input.sessionID, parsedFunctions, calls);
    }

    if (agentId && input.sessionID && !graphSessionState.getState(input.sessionID)) {
      const graph = deps.roleGraphMap.get(agentId);
      if (graph) {
        graphSessionState.initGraph(input.sessionID, graph);
      }
    }
  }

  // Loop function activation
  if (parsedFunctions.includes(LOOP_FUNCTION_NAME) && agentId) {
    const loopCall = calls.find(c => c.name === LOOP_FUNCTION_NAME);
    if (loopCall && state.activeLoopManager) {
      // Recursion block: reject nested loops
      if (state.activeLoopManager.isLoopSession(input.sessionID)) {
        appendCorrection(state.pendingCorrections, input.sessionID, "Nested loops are not supported");
      } else {
        const result = parseLoopParams(loopCall);
        if (!result.valid) {
          appendCorrection(state.pendingCorrections, input.sessionID, `Invalid loop params: ${result.reason}`);
        } else {
          const clamped = result.clamped ? ` (clamped to ${result.iterations})` : "";
          const warn = result.warning ? ` (${result.warning})` : "";
          if (result.clamped || result.warning) {
            appendCorrection(state.pendingCorrections, input.sessionID, `Loop: ${result.iterations} iterations${clamped}${warn}`);
          }
          state.activeLoopManager.register({
            originSessionId: input.sessionID,
            agent: agentId,
            prompt: cleanedText,
            mode: result.mode,
            iterations: result.iterations,
          });
          // Activation acknowledgment is handled by the orchestrator prompt (T3)
        }
      }
    }
  }

  // --- function kernel: init runtime state for newly activated functions ---
  const roleId = input.agent;
  const roleFns = roleId ? deps.roleFunctionsMap.get(roleId) : null;
  const activeFnNames = functionSessionState.getActive(input.sessionID);
  for (const fnName of activeFnNames) {
    const resolvedFn = roleFns?.find((f) => f.name === fnName);
    const sv = resolvedFn?.state_schema_version ?? 1;
    const st = functionRuntime.init(input.sessionID, fnName, sv);
    st.activatedAtTurn = st.currentTurn;
  }
  functionRuntime.markDirty();
  const isAutoContinue = (firstText?.text ?? "").includes("[auto-continue");
  // Reset only on genuine user turns. Auto-continue, loop-progress, and
  // dispatch-completion reminders all re-enter through this hook; resetting
  // on them pins the counter at "1/N" so the caps never fire (unbounded
  // auto-continue spin).
  if (!isSyntheticInjection) {
    for (const [, st] of functionRuntime.all(input.sessionID)) {
      st.continuationCount = 0;
      st.cooldownUntilTurn = 0;
    }
  }

  // Loop recovery notification on restart: detect interrupted loops
  if (input.sessionID && state.activeLoopManager && !isSyntheticInjection) {
    const loopState = state.activeLoopManager.getLoopState(input.sessionID);
    if (loopState) {
      const interrupted = loopState.phase === "interrupted" || (loopState as any).status === "interrupted";
      if (interrupted) {
        loopState.phase = "cancelled";
        appendCorrection(state.pendingCorrections, input.sessionID,
          `${LOOP_PROGRESS_MARKER} loop interrupted by restart at round ${loopState.current}/${loopState.total}]`);
      }
    }
  }

  if (!isAutoContinue && agentId) {
    try {
      const activeNames = functionSessionState.getActive(input.sessionID);
      if (activeNames.size > 0) {
        const activeFns = collectAllFunctions(deps.roleFunctionsMap).filter((f) => activeNames.has(f.name));
        if (activeFns.length > 0) {
          const messageInjects = runMessageObserve({
            sessionID: input.sessionID,
            activeFns,
          });
          for (const inj of messageInjects) {
            appendCorrection(state.pendingCorrections, input.sessionID, inj);
          }
        }
      }
    } catch (err) {
      log.debug("chat.message observe error", { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
