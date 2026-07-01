import type { AgentConfig, Event } from "@opencode-ai/sdk";
import type { PluginInput, Config } from "@opencode-ai/plugin";
import { applyParams } from "./function-resolver.ts";
import { parseFunctionActivation } from "./function-parser.ts";
import { functionSessionState } from "./session-state.ts";
import { graphSessionState, buildGraphStateBlock, advanceGraphForDispatch } from "./graph/index.ts";
import { setAdvanceJudge, extractDispatchTarget } from "./graph/advance.ts";
import { extractResultBlock, normalizeResult, hashResult } from "./graph/result-capture.ts";
import type { JudgeFn } from "./graph/termination-async.ts";
import { buildFunctionBlock, buildActiveArtifactBlock } from "./prompt-builder.ts";
import { buildAgentConfig, transformPermission } from "./prompt/agent-config.ts";
import { DispatchManager } from "./dispatch/manager.ts";
import { createDispatchTool, createDispatchOutputTool, createDispatchCancelTool, createDispatchMetricsTool } from "./dispatch/tools.ts";
import { mergeConfig, resolveEnvConfig, DEFAULT_CONFIG } from "./dispatch/config.ts";
import type { ResolvedRole, ResolvedSubAgent, ResolvedFunction, ResolvedGraph } from "./types.ts";
import { RoleMode } from "./constants.ts";
import { normalizeWorkspaceDir } from "./state-paths.ts";
import { createSubLogger } from "./logger.ts";
import { runToolObserve, runTextCapture, runMessageObserve, runActivateObserve } from "./function/observe.ts";
import { functionRuntime } from "./function/runtime-state.ts";
import { evaluateGateAndTransitions } from "./function/phase-machine.ts";
import { evaluateCondition, type CondEnv } from "./function/conditions.ts";
import { decideContinuation } from "./function/continuation.ts";
import { ArtifactStore } from "./function/artifact-store.ts";
import { LoopManager } from "./loop/manager.ts";
import { parseLoopParams } from "./loop/params.ts";
import { LOOP_PROGRESS_MARKER, LOOP_FUNCTION_NAME } from "./loop/constants.ts";

const log = createSubLogger("plugin-hooks");

let hooksRegistered = false;

export const managerMap = new Map<string, DispatchManager>();

export const loopManagerMap = new Map<string, LoopManager>();

export let activeLoopManager: LoopManager | undefined;

export const pendingCorrections = new Map<string, string>();

// Sessions that received a genuine user message this turn (drives the user_approval
// gate). Auto-continuation prompts are excluded so they never count as approval.
export const userMessagedSessions = new Set<string>();

export const roleAutoActivateMap = new Map<string, string[]>();
export const roleLockedMap = new Map<string, boolean>();
export const autoActivatedSessions = new Set<string>();

async function fetchLastAssistantText(
  client: PluginInput["client"],
  sessionID: string,
): Promise<string | null> {
  try {
    const res = await client.session.messages({ path: { id: sessionID } });
    if ((res as { error?: unknown }).error !== undefined) return null;
    const msgs = ((res as { data?: unknown }).data ?? []) as Array<{
      info: { role: string };
      parts: Array<{ type: string; text?: string }>;
    }>;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].info.role !== "assistant") continue;
      const text = msgs[i].parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("");
      return text.length > 0 ? text : null;
    }
    return null;
  } catch {
    return null;
  }
}

function needsResultCapture(config: { any_of?: unknown[]; all_of?: unknown[] }): boolean {
  const check = (arr: unknown[] | undefined): boolean =>
    arr?.some(
      (c) =>
        typeof c === "object" && c !== null &&
        ("converged" in c || "result_matches" in c || "stuck" in c),
    ) ?? false;
  return check(config.any_of) || check(config.all_of);
}

function isDispatchError(output: unknown): boolean {
  if (typeof output === "object" && output !== null) {
    const obj = output as Record<string, unknown>;
    return "error" in obj || "failure" in obj;
  }
  return false;
}

function createJudgeFn(client: PluginInput["client"]): JudgeFn {
  return async (nlCondition: string, context: string): Promise<boolean> => {
    try {
      const createResult = await client.session.create({});
      if ((createResult as { error?: unknown }).error) return false;

      const sessionId = ((createResult as { data?: { id?: string } }).data)?.id;
      if (!sessionId) return false;

      try {
        const promptResult = await client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [{
              type: "text",
              text: `Judge: "${nlCondition}"\n\nContext:\n${context}\n\nAnswer "YES" or "NO".`,
            }],
          },
        });

        if ((promptResult as { error?: unknown }).error) return false;

        const data = (promptResult as {
          data?: { parts: Array<{ type: string; text?: string }> };
        }).data;
        const text = data?.parts
          ?.filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text!)
          .join("") ?? "";

        return /^\s*YES\b/mi.test(text);
      } finally {
        client.session.delete({ path: { id: sessionId } }).catch(() => {});
      }
    } catch {
      return false;
    }
  };
}

export async function createPluginHooks(
  resolvedRoles: ResolvedRole[],
  client: PluginInput["client"],
  roleFunctionsMap: Map<string, ResolvedFunction[]>,
  roleGraphMap: Map<string, ResolvedGraph>,
  directory?: string,
) {
  const resolvedSubagents = new Map<string, { parentFullId: string }>();
  const subagentModelKey = new Map<string, string>();

  function registerSubagentLineage(
    subagents: ResolvedSubAgent[],
    parentFullId: string,
    parentModel: string | undefined,
  ): void {
    for (const sub of subagents) {
      resolvedSubagents.set(sub.id, { parentFullId });
      const model = sub.config.model ?? parentModel;
      const key = model ? model : "default";
      subagentModelKey.set(sub.id, key);
      log.debug("model key", { subagent: sub.id, key, parentFullId });
      if (sub.subagents.length > 0) {
        registerSubagentLineage(sub.subagents, sub.id, model);
      }
    }
  }

  for (const role of resolvedRoles) {
    registerSubagentLineage(role.subagents, role.id, role.config.model);
  }

  for (const resolved of resolvedRoles) {
    if (resolved.config.auto_activate?.length) {
      roleAutoActivateMap.set(resolved.id, resolved.config.auto_activate);
    }
    if (resolved.locked !== undefined) {
      roleLockedMap.set(resolved.id, resolved.locked);
    }
  }

  // Key the in-memory manager cache by the directory opencode handed us (stable
  // across a session); persist all state under the normalized path so the
  // `monitor` CLI, resolving the same project independently, reads the same files.
  const rawDir = directory ?? process.cwd();
  const dir = normalizeWorkspaceDir(rawDir);

  let dispatchManager = managerMap.get(rawDir);
  if (!dispatchManager) {
    const primaryRole = resolvedRoles.find((r) => r.config.mode === RoleMode.Primary);
    const mergedConfig = mergeConfig(
      DEFAULT_CONFIG,
      primaryRole?.dispatchConfig,
      resolveEnvConfig(),
    );
    dispatchManager = new DispatchManager(client, mergedConfig, subagentModelKey);
    dispatchManager.setStoreDirectory(dir);
    managerMap.set(rawDir, dispatchManager);
    await dispatchManager.recover();
  }

  let loopManager = loopManagerMap.get(rawDir);
  if (!loopManager) {
    loopManager = new LoopManager(client);
    loopManager.setStoreDirectory(dir);
    loopManagerMap.set(rawDir, loopManager);
    loopManager.recover();
  }
  activeLoopManager = loopManager;

  if (directory) {
    graphSessionState.setStoreDirectory(dir);
    functionRuntime.setStoreDirectory(dir);
  }
  graphSessionState.recover((_sessionID, agentId) => roleGraphMap.get(agentId));
  functionRuntime.recover();

  if (!hooksRegistered) {
    hooksRegistered = true;
    process.on("exit", () => {
      loopManager.dispose();
      dispatchManager.flushPersistSync();
      if (directory) graphSessionState.flushSync();
      if (directory) functionRuntime.flushSync();
    });
    process.on("SIGINT", () => {
      loopManager.dispose();
      dispatchManager.flushPersistSync();
      if (directory) graphSessionState.flushSync();
      if (directory) functionRuntime.flushSync();
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      loopManager.dispose();
      dispatchManager.flushPersistSync();
      if (directory) graphSessionState.flushSync();
      if (directory) functionRuntime.flushSync();
      process.exit(143);
    });
  }

  setAdvanceJudge(createJudgeFn(client));

  return {
    tool: {
      dispatch: createDispatchTool(dispatchManager, resolvedSubagents, subagentModelKey),
      dispatch_output: createDispatchOutputTool(dispatchManager),
      dispatch_cancel: createDispatchCancelTool(dispatchManager),
      dispatch_metrics: createDispatchMetricsTool(),
    },
    event: async (input: { event: Event }) => {
      const e = input.event;
      const props = e.properties as Record<string, unknown> | undefined;

      switch (e.type) {
        case "session.idle": {
          const sid = (props as { sessionID?: string } | undefined)?.sessionID;
          if (!sid) break;
          await dispatchManager.handleSessionIdle(sid);
          // --- function CONTINUE ---
          // Skip continuation for sync dispatch sessions: promptAsync would
          // prevent session.prompt() from resolving, causing an infinite hang.
          if (dispatchManager.isSyncSession(sid)) {
            log.debug("skipping function continuation for sync session", { sessionID: sid });
            break;
          }
          // Invariant: while awaiting in-flight dispatches, the completion
          // <system-reminder> wakes the parent — auto-continue must NOT (it would
          // spin-poll an unsatisfiable continue_until until results arrive).
          const inflight = dispatchManager.getInflightCount(sid);
          if (inflight > 0) {
            log.debug("suppressing auto-continue: parent awaiting in-flight dispatch", {
              sessionID: sid,
              inflight,
            });
            break;
          }
          const activeSet = functionSessionState.getActive(sid);
          if (activeSet.size === 0) {
            // Loop advance for sessions with no active functions (e.g., fresh child sessions)
            if (activeLoopManager && dispatchManager.getInflightCount(sid) === 0) {
              const loop = activeLoopManager.getByActiveSession(sid);
              if (loop && loop.status === "running") {
                await activeLoopManager.onRoundComplete(sid);
              }
            }
            break;
          }
          const allFns: ResolvedFunction[] = [];
          for (const funcs of roleFunctionsMap.values()) allFns.push(...funcs);
          const { ArtifactStore } = await import("./function/artifact-store.ts");
          const artifacts = new ArtifactStore(dir);

          const activeFns = allFns.filter((f) => activeSet.has(f.name));

          // Fetch last assistant text (needed for text capture + handler context)
          const hasCapture = activeFns.some((f) =>
            (f.observe ?? []).some((s) => s.on === "tool_after" && s.capture_artifact),
          );
          const hasHandlers = activeFns.some((f) => !!f.handlers);
          const lastText = (hasCapture || hasHandlers)
            ? await fetchLastAssistantText(client, sid)
            : null;
          if (hasCapture && lastText) {
            runTextCapture({ sessionID: sid, activeFns, artifacts, assistantText: lastText });
          }

          // --- Tier-2 handlers: onIdle (Phase 1 — side-effects for all handler fns) ---
          if (hasHandlers) {
            const { loadHandlers, safeCall } = await import("./function/handlers-loader.ts");
            const { FunctionContext } = await import("./function/context.ts");
            for (const fn of activeFns) {
              if (!fn.handlers) continue;
              const mod = await loadHandlers(fn.filePath, fn.handlers);
              if (!mod?.onIdle) continue;
              const ctx = new FunctionContext(
                sid, fn.name, functionRuntime, artifacts,
                lastText, fn.state_schema_version ?? 1,
              );
              await safeCall(() => mod.onIdle!(ctx));
              let injBytes = 0;
              for (const inj of ctx.injects) {
                injBytes += inj.length;
                if (injBytes > 4096) { log.warn("handler inject cap reached", { fn: fn.name }); break; }
                const ex = pendingCorrections.get(sid);
                pendingCorrections.set(sid, ex ? ex + "\n" + inj : inj);
              }
              let actCount = 0;
              for (const name of ctx.pendingActivations.activate) {
                if (++actCount > 3) { log.warn("handler activation cap reached", { fn: fn.name }); break; }
                functionSessionState.activate(sid, [name]);
                const resolved = allFns.find((f) => f.name === name);
                functionRuntime.init(sid, name, resolved?.state_schema_version ?? 1);
              }
              for (const name of ctx.pendingActivations.deactivate) {
                if (name === fn.name) functionSessionState.deactivate(sid, name);
              }
              if (ctx.continuationReasons.length > 0) {
                const st = functionRuntime.get(sid, fn.name);
                if (st) {
                  const existing = (st.kv.__pendingContinuationReasons as string[]) ?? [];
                  st.kv.__pendingContinuationReasons = [...existing, ...ctx.continuationReasons];
                }
              }
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

            let wantsContinue = false;
            let reason = "completion condition not yet met";

            // Declarative: continue_until
            if (fn.continue_until) {
              const env: CondEnv = { sessionID: sid, fnName: name, state: st, artifacts,
                requiredEvidence: fn.requires_evidence ?? [], userMessagedThisTurn: false };
              if (evaluateCondition(fn.continue_until, env)) {
                st.phase = "complete"; functionRuntime.markDirty(); continue;
              }
              wantsContinue = true;
            }

            // Imperative: shouldContinue (additive — can request but cannot veto declarative)
            if (fn.handlers && hasHandlers) {
              const { loadHandlers, safeCall } = await import("./function/handlers-loader.ts");
              const { FunctionContext } = await import("./function/context.ts");
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
              await client.session.promptAsync({
                path: { id: sid },
                body: { parts: [{ type: "text", text: decision.reminder }] },
              }).catch(() => {});
              sentContinuation = true;
              break; // ONE continuation per idle event
            }
          }
          // --- LOOP ADVANCE: advance a loop session on terminal idle ---
          if (!sentContinuation && dispatchManager.getInflightCount(sid) === 0) {
            const loop = activeLoopManager?.getByActiveSession(sid);
            if (loop && loop.status === "running") {
              await activeLoopManager!.onRoundComplete(sid);
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
            dispatchManager.handleSessionStatus(sid, statusType);
          }
          break;
        }
        case "session.error": {
          const sid = (props as { sessionID?: string } | undefined)?.sessionID;
          if (sid) {
            await dispatchManager.handleSessionError(sid, props?.error);
            if (activeLoopManager?.isLoopSession(sid)) {
              activeLoopManager.handleSessionError(sid, props?.error as string | undefined);
            }
          }
          break;
        }
        case "session.deleted": {
          const info = props?.info as { id?: string } | undefined;
          const did = info?.id;
          if (did) await dispatchManager.handleSessionDeleted(did);
          break;
        }
        case "message.updated": {
          const info = props?.info as { sessionID?: string } | undefined;
          const msid = info?.sessionID;
          if (msid) dispatchManager.handleMessageUpdated(msid);
          break;
        }
      }
    },
    config: async (config: Config) => {
      function registerSubAgentConfigs(subagents: ResolvedSubAgent[], cfg: Config): void {
        for (const sub of subagents) {
          const subAgentCfg: Record<string, unknown> = {
            prompt: sub.prompt,
            mode: RoleMode.Subagent,
            hidden: true,
          };
          if (sub.config.description) subAgentCfg.description = sub.config.description;
          if (sub.config.model) subAgentCfg.model = sub.config.model;
          if (sub.config.color) subAgentCfg.color = sub.config.color;
          if (sub.config.variant) subAgentCfg.variant = sub.config.variant;
          if (sub.config.temperature !== undefined) subAgentCfg.temperature = sub.config.temperature;
          if (sub.config.top_p !== undefined) subAgentCfg.top_p = sub.config.top_p;
          if (sub.config.tools) subAgentCfg.tools = sub.config.tools;
          if (sub.config.permission) subAgentCfg.permission = transformPermission(sub.config.permission);

          cfg.agent ??= {};
          cfg.agent[sub.id] = subAgentCfg as AgentConfig;
          if (sub.subagents.length > 0) {
            registerSubAgentConfigs(sub.subagents, cfg);
          }
        }
      }

      for (const resolved of resolvedRoles) {
        const agentConfig = buildAgentConfig(resolved);
        config.agent ??= {};
        config.agent[resolved.id] = agentConfig;

        registerSubAgentConfigs(resolved.subagents, config);
      }
    },
    "chat.message": async (
      input: { agent?: string; sessionID: string },
      output: { parts: Array<{ type: string; text?: string }> },
    ) => {
      const firstText = output.parts.find(
        (p: { type: string; text?: string }) => p.type === "text" && typeof p.text === "string",
      ) as { text?: string } | undefined;
      const firstTextStr = firstText?.text ?? "";
      if (input.sessionID && !firstTextStr.includes("[auto-continue") && !firstTextStr.includes(LOOP_PROGRESS_MARKER)) {
        userMessagedSessions.add(input.sessionID);
        // Loop cancel: genuine user message to a looping origin cancels remaining rounds
        if (activeLoopManager?.isLoopOrigin(input.sessionID)) {
          activeLoopManager.requestCancel(input.sessionID, "user message");
        }
      }

      const textPartIndex = output.parts.findIndex(
        (p: { type: string; text?: string }) => p.type === "text" && "text" in p,
      );
      if (textPartIndex === -1) return;

      const part = output.parts[textPartIndex] as { type: string; text: string };
      const agentId = input.agent as string | undefined;

      if (agentId && input.sessionID && !autoActivatedSessions.has(input.sessionID)) {
        const autoFns = roleAutoActivateMap.get(agentId);
        if (autoFns && autoFns.length > 0) {
          const lockedNames = roleLockedMap.get(agentId) ? autoFns : undefined;
          functionSessionState.activateDefaults(input.sessionID, autoFns, lockedNames);
          autoActivatedSessions.add(input.sessionID);

          const allFns: ResolvedFunction[] = [];
          for (const funcs of roleFunctionsMap.values()) allFns.push(...funcs);
          const autoActiveFns = allFns.filter((f) => autoFns.includes(f.name));

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
              const existing = pendingCorrections.get(input.sessionID);
              pendingCorrections.set(input.sessionID, existing ? existing + "\n" + inj : inj);
            }
          }
        }
      }

      const { functions: parsedFunctions, calls, cleanedText } = parseFunctionActivation(part.text);

      if (parsedFunctions.length > 0) {
        part.text = cleanedText;

        const roleId = input.agent;
        const roleFunctions = roleId ? roleFunctionsMap.get(roleId) : null;

        if (roleFunctions) {
          const validNames = new Set(roleFunctions.map((f) => f.name));
          const validFunctions = parsedFunctions.filter((fn) => validNames.has(fn));
          const validCalls = calls.filter((c) => validNames.has(c.name));
          functionSessionState.activate(input.sessionID, validFunctions, validCalls);
        } else {
          functionSessionState.activate(input.sessionID, parsedFunctions, calls);
        }

        if (agentId && input.sessionID && !graphSessionState.getState(input.sessionID)) {
          const graph = roleGraphMap.get(agentId);
          if (graph) {
            graphSessionState.initGraph(input.sessionID, graph);
          }
        }
      }

      // Loop function activation
      if (parsedFunctions.includes(LOOP_FUNCTION_NAME) && agentId) {
        const loopCall = calls.find(c => c.name === LOOP_FUNCTION_NAME);
        if (loopCall && activeLoopManager) {
          // Recursion block: reject nested loops
          if (activeLoopManager.isLoopSession(input.sessionID)) {
            const existing = pendingCorrections.get(input.sessionID);
            pendingCorrections.set(input.sessionID, (existing ? existing + "\n" : "") + "Nested loops are not supported");
          } else {
            const result = parseLoopParams(loopCall);
            if (!result.valid) {
              const existing = pendingCorrections.get(input.sessionID);
              pendingCorrections.set(input.sessionID, (existing ? existing + "\n" : "") + `Invalid loop params: ${result.reason}`);
            } else {
              const clamped = result.clamped ? ` (clamped to ${result.iterations})` : "";
              const warn = result.warning ? ` (${result.warning})` : "";
              if (result.clamped || result.warning) {
                const existing = pendingCorrections.get(input.sessionID);
                pendingCorrections.set(input.sessionID, (existing ? existing + "\n" : "") + `Loop: ${result.iterations} iterations${clamped}${warn}`);
              }
              activeLoopManager.register({
                originSessionId: input.sessionID,
                agent: agentId,
                prompt: cleanedText,
                mode: result.mode,
                iterations: result.iterations,
              });
            }
          }
        }
      }

      // --- function kernel: init runtime state for newly activated functions ---
      const roleId = input.agent;
      const roleFns = roleId ? roleFunctionsMap.get(roleId) : null;
      const activeFnNames = functionSessionState.getActive(input.sessionID);
      for (const fnName of activeFnNames) {
        const resolvedFn = roleFns?.find((f) => f.name === fnName);
        const sv = resolvedFn?.state_schema_version ?? 1;
        const st = functionRuntime.init(input.sessionID, fnName, sv);
        st.activatedAtTurn = st.currentTurn;
      }
      functionRuntime.markDirty();
      const isAutoContinue = (firstText?.text ?? "").includes("[auto-continue");
      const isLoopProgress = (firstText?.text ?? "").includes(LOOP_PROGRESS_MARKER);
      // Reset only on genuine user turns. Auto-continue and loop-progress
      // prompts re-enter through this hook; resetting on them pins the counter
      // at "1/N" so the caps never fire (unbounded auto-continue spin).
      if (!isAutoContinue && !isLoopProgress) {
        for (const [, st] of functionRuntime.all(input.sessionID)) {
          st.continuationCount = 0;
          st.cooldownUntilTurn = 0;
        }
      }

      // Loop recovery notification on restart: detect interrupted loops
      if (input.sessionID && activeLoopManager && !isAutoContinue && !isLoopProgress) {
        const loopState = activeLoopManager.getLoopState(input.sessionID);
        if (loopState && loopState.status === "interrupted") {
          loopState.status = "cancelled";
          const existing = pendingCorrections.get(input.sessionID);
          pendingCorrections.set(input.sessionID,
            (existing ? existing + "\n" : "") +
            `${LOOP_PROGRESS_MARKER} loop interrupted by restart at round ${loopState.current}/${loopState.total}]`);
        }
      }

      if (!isAutoContinue && agentId) {
        try {
          const activeNames = functionSessionState.getActive(input.sessionID);
          if (activeNames.size > 0) {
            const allFns2: ResolvedFunction[] = [];
            for (const funcs of roleFunctionsMap.values()) allFns2.push(...funcs);
            const activeFns = allFns2.filter((f) => activeNames.has(f.name));
            if (activeFns.length > 0) {
              const messageInjects = runMessageObserve({
                sessionID: input.sessionID,
                activeFns,
              });
              for (const inj of messageInjects) {
                const existing = pendingCorrections.get(input.sessionID);
                pendingCorrections.set(input.sessionID, existing ? existing + "\n" + inj : inj);
              }
            }
          }
        } catch {}
      }
    },
    "tool.execute.after": async (
      input: { sessionID?: string; tool?: string; args?: unknown },
      _output: unknown,
    ) => {
      if (!input.sessionID || !input.tool) return;

      if (input.tool === "task" || input.tool === "dispatch") {
        if (isDispatchError(_output)) {
          log.debug("skipping advance: dispatch failed", { sessionID: input.sessionID });
          return;
        }

        const gs = graphSessionState.getState(input.sessionID);
        const graph = graphSessionState.getGraph(input.sessionID);
        if (gs && graph?.termination?.config && needsResultCapture(graph.termination.config)) {
          const target = extractDispatchTarget(input.tool, input.args);
          if (target) {
            const lastText = await fetchLastAssistantText(client, input.sessionID);
            if (lastText) {
              const resultBlock = extractResultBlock(lastText);
              const normalized = normalizeResult(resultBlock);
              const hash = hashResult(normalized);
              if (!gs.lastResults) gs.lastResults = {};
              gs.lastResults[target] = { hash, text: normalized };
            }
          }
        }

        const { correction } = advanceGraphForDispatch(input.sessionID, input.tool, input.args);
        if (correction) {
          pendingCorrections.set(input.sessionID, correction);
          log.debug("guardrail correction stashed", { sessionID: input.sessionID });
        }
      }

      // --- function OBSERVE ---
      try {
        const activeNames = functionSessionState.getActive(input.sessionID);
        if (activeNames.size === 0) return;
        const allFns: ResolvedFunction[] = [];
        for (const funcs of roleFunctionsMap.values()) allFns.push(...funcs);
        const activeFns = allFns.filter((f) => activeNames.has(f.name));
        if (activeFns.length === 0) return;

        const artifacts = new ArtifactStore(dir);
        const needsText = activeFns.some((f) =>
          (f.observe ?? []).some(
            (s) => s.on === "tool_after" && s.capture_artifact && (!s.tool || s.tool === input.tool),
          ),
        );
        const lastAssistantText = needsText
          ? await fetchLastAssistantText(client, input.sessionID)
          : null;
        const injects = runToolObserve({
          sessionID: input.sessionID, tool: input.tool,
          activeFns, artifacts, lastAssistantText,
          toolArgs: input.args,
        });
        for (const inj of injects) {
          const existing = pendingCorrections.get(input.sessionID);
          pendingCorrections.set(input.sessionID, existing ? existing + "\n" + inj : inj);
        }

        // --- Tier-2 handlers: onToolAfter ---
        const { loadHandlers, safeCall } = await import("./function/handlers-loader.ts");
        const { FunctionContext } = await import("./function/context.ts");
        for (const fn of activeFns) {
          if (!fn.handlers) continue;
          const mod = await loadHandlers(fn.filePath, fn.handlers);
          if (!mod?.onToolAfter) continue;
          const ctx = new FunctionContext(
            input.sessionID, fn.name, functionRuntime, artifacts,
            lastAssistantText, fn.state_schema_version ?? 1,
          );
          await safeCall(() => mod.onToolAfter!(ctx, { tool: input.tool!, args: input.args }));
          // Drain injects (cap 4KB per fn per invocation)
          let injBytes = 0;
          for (const handlerInj of ctx.injects) {
            injBytes += handlerInj.length;
            if (injBytes > 4096) { log.warn("handler inject cap reached", { fn: fn.name }); break; }
            const ex = pendingCorrections.get(input.sessionID);
            pendingCorrections.set(input.sessionID, ex ? ex + "\n" + handlerInj : handlerInj);
          }
          // Drain activations (cap 3 per invocation, enforce self-deactivate)
          let actCount = 0;
          for (const name of ctx.pendingActivations.activate) {
            if (++actCount > 3) { log.warn("handler activation cap reached", { fn: fn.name }); break; }
            functionSessionState.activate(input.sessionID, [name]);
            const resolved = allFns.find((f) => f.name === name);
            functionRuntime.init(input.sessionID, name, resolved?.state_schema_version ?? 1);
          }
          for (const name of ctx.pendingActivations.deactivate) {
            if (name === fn.name) functionSessionState.deactivate(input.sessionID, name);
          }
          // Stash continuation reasons for session.idle to consume
          if (ctx.continuationReasons.length > 0) {
            const st = functionRuntime.get(input.sessionID, fn.name);
            if (st) { st.kv.__pendingContinuationReasons = ctx.continuationReasons; functionRuntime.markDirty(); }
          }
        }
      } catch {}
    },
    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ) => {
      if (!input.sessionID) return;

      const correction = pendingCorrections.get(input.sessionID);
      if (correction) {
        output.system.push(correction);
        pendingCorrections.delete(input.sessionID);
        log.debug("guardrail correction injected", { sessionID: input.sessionID });
      }

      // Lazy-init graph state if not yet initialized (system.transform fires before chat.message on first turn)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const maybeAgent = (input as any).agent as string | undefined;
      const agentId = maybeAgent;
      let graphState = graphSessionState.getState(input.sessionID);
      if (!graphState && agentId) {
        const graph = roleGraphMap.get(agentId);
        if (graph) {
          graphSessionState.initGraph(input.sessionID, graph);
          graphState = graphSessionState.getState(input.sessionID);
        }
      }

      const activeNames = functionSessionState.getActive(input.sessionID);
      if (activeNames.size === 0) {
        // Still inject graph state block even without active functions
        if (graphState) {
          const graph = graphSessionState.getGraph(input.sessionID);
          if (graph) {
            const stateBlock = buildGraphStateBlock(graphState, graph);
            output.system.push(stateBlock);
          }
        }
        const totalChars = output.system.reduce((sum, s) => sum + s.length, 0);
        log.debug("System prompt augmented", { totalChars, addedFunctions: 0, hasGraphBlock: !!graphState });
        return;
      }

      const allFunctions: ResolvedFunction[] = [];
      for (const funcs of roleFunctionsMap.values()) {
        allFunctions.push(...funcs);
      }

      const seen = new Set<string>();
      const activeFunctions: ResolvedFunction[] = [];
      for (const fn of allFunctions) {
        if (activeNames.has(fn.name) && !seen.has(fn.name)) {
          const call = functionSessionState.getCall(input.sessionID, fn.name);
          if (call && fn.params && Object.keys(call.args).length > 0) {
            activeFunctions.push({ ...fn, content: applyParams(fn, call) });
          } else {
            activeFunctions.push(fn);
          }
          seen.add(fn.name);
        }
      }

      // --- function kernel: increment turns, evaluate gates + transitions ---
      const runtimeStates = functionRuntime.all(input.sessionID);
      const userMessagedThisTurn = userMessagedSessions.has(input.sessionID);
      userMessagedSessions.delete(input.sessionID);
      for (const [, st] of runtimeStates) {
        st.currentTurn += 1;
      }
      const artifacts = new ArtifactStore(dir);
      for (const fn of activeFunctions) {
        const st = functionRuntime.get(input.sessionID, fn.name);
        if (!st) continue;
        const env: CondEnv = {
          sessionID: input.sessionID,
          fnName: fn.name,
          state: st,
          artifacts,
          requiredEvidence: fn.requires_evidence ?? [],
          userMessagedThisTurn,
        };
        const tr = evaluateGateAndTransitions(fn, env);
        // Collect transitions (applied atomically after loop)
        for (const name of tr.activate) {
          functionSessionState.activate(input.sessionID, [name]);
          const resolved = allFunctions.find((f) => f.name === name);
          const st2 = functionRuntime.init(
            input.sessionID,
            name,
            resolved?.state_schema_version ?? 1,
          );
          st2.activatedAtTurn = st2.currentTurn;
        }
        for (const name of tr.deactivate) {
          // Self-deactivation rule: a function can only deactivate itself
          if (name === fn.name) {
            functionSessionState.deactivate(input.sessionID, name);
          }
        }
      }
      functionRuntime.markDirty();

      // Priority-ordered injection + requires dependency guard
      const activeSet = functionSessionState.getActive(input.sessionID);
      const guarded: ResolvedFunction[] = [];
      for (const fn of activeFunctions) {
        const missing = (fn.requires ?? []).filter((d) => !activeSet.has(d));
        if (missing.length > 0) {
          output.system.push(`<system-reminder>Function '${fn.name}' requires ${missing.map((m) => `'${m}'`).join(", ")} active first.</system-reminder>`);
          continue;
        }
        guarded.push(fn);
      }
      guarded.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));

      if (guarded.length === 0) {
        // Inject graph state block even when functions are active but empty
        if (graphState) {
          const graph = graphSessionState.getGraph(input.sessionID);
          if (graph) {
            const stateBlock = buildGraphStateBlock(graphState, graph);
            output.system.push(stateBlock);
          }
        }
        const totalChars = output.system.reduce((sum, s) => sum + s.length, 0);
        log.debug("System prompt augmented", { totalChars, addedFunctions: 0, hasGraphBlock: !!graphState });
        return;
      }

      const block = buildFunctionBlock(guarded);
      output.system.push(block);

      // --- function kernel: inject consumed artifacts ---
      for (const fn of guarded) {
        if (fn.consumes) {
          const content = artifacts.read(input.sessionID, fn.consumes);
          if (content) output.system.push(buildActiveArtifactBlock(fn.consumes, content));
        }
      }

      // graphState already resolved above
      if (graphState) {
        const graph = graphSessionState.getGraph(input.sessionID);
        if (graph) {
          const stateBlock = buildGraphStateBlock(graphState, graph);
          output.system.push(stateBlock);
        }
      }

      const totalChars = output.system.reduce((sum, s) => sum + s.length, 0);
      log.debug("System prompt augmented", { totalChars, addedFunctions: guarded.length, hasGraphBlock: !!graphState });
    },
  };
}
