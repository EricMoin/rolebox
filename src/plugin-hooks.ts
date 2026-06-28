import type { AgentConfig, Event } from "@opencode-ai/sdk";
import type { PluginInput, Config } from "@opencode-ai/plugin";
import { applyParams } from "./function-resolver.ts";
import { parseFunctionActivation } from "./function-parser.ts";
import { functionSessionState } from "./session-state.ts";
import { graphSessionState, buildGraphStateBlock, advanceGraphForDispatch } from "./graph/index.ts";
import { buildFunctionBlock } from "./prompt-builder.ts";
import { buildAgentConfig, transformPermission } from "./prompt/agent-config.ts";
import { DispatchManager } from "./dispatch/manager.ts";
import { createDispatchTool, createDispatchOutputTool, createDispatchCancelTool, createDispatchMetricsTool } from "./dispatch/tools.ts";
import { mergeConfig, resolveEnvConfig, DEFAULT_CONFIG } from "./dispatch/config.ts";
import type { ResolvedRole, ResolvedFunction, ResolvedGraph } from "./types.ts";
import { RoleMode } from "./constants.ts";
import { createSubLogger } from "./logger.ts";
import { runToolObserve } from "./function/observe.ts";
import { functionRuntime } from "./function/runtime-state.ts";
import { evaluateGateAndTransitions } from "./function/phase-machine.ts";
import type { CondEnv } from "./function/conditions.ts";
import { ArtifactStore } from "./function/artifact-store.ts";

const log = createSubLogger("plugin-hooks");

let hooksRegistered = false;

export const managerMap = new Map<string, DispatchManager>();

export const pendingCorrections = new Map<string, string>();

export async function createPluginHooks(
  resolvedRoles: ResolvedRole[],
  client: PluginInput["client"],
  roleFunctionsMap: Map<string, ResolvedFunction[]>,
  roleGraphMap: Map<string, ResolvedGraph>,
  directory?: string,
) {
  const resolvedSubagents = new Map<string, string>();
  const subagentModelKey = new Map<string, string>();
  for (const role of resolvedRoles) {
    for (const sub of role.subagents) {
      resolvedSubagents.set(sub.id, role.id);
      const model = sub.config.model ?? role.config.model;
      const key = model ? model : "default";
      subagentModelKey.set(sub.id, key);
      log.debug("model key", { subagent: sub.id, key });
    }
  }

  const dir = directory ?? process.cwd();

  let dispatchManager = managerMap.get(dir);
  if (!dispatchManager) {
    const primaryRole = resolvedRoles.find((r) => r.config.mode === RoleMode.Primary);
    const mergedConfig = mergeConfig(
      DEFAULT_CONFIG,
      primaryRole?.dispatchConfig,
      resolveEnvConfig(),
    );
    dispatchManager = new DispatchManager(client, mergedConfig, subagentModelKey);
    dispatchManager.setStoreDirectory(dir);
    managerMap.set(dir, dispatchManager);
    await dispatchManager.recover();
  }

  if (directory) {
    graphSessionState.setStoreDirectory(directory);
  }
  graphSessionState.recover((_sessionID, agentId) => roleGraphMap.get(agentId));

  if (!hooksRegistered) {
    hooksRegistered = true;
    process.on("exit", () => {
      dispatchManager.flushPersistSync();
      if (directory) graphSessionState.flushSync();
    });
    process.on("SIGINT", () => {
      dispatchManager.flushPersistSync();
      if (directory) graphSessionState.flushSync();
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      dispatchManager.flushPersistSync();
      if (directory) graphSessionState.flushSync();
      process.exit(143);
    });
  }

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
          if (sid) await dispatchManager.handleSessionIdle(sid);
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
          if (sid) await dispatchManager.handleSessionError(sid, props?.error);
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
      for (const resolved of resolvedRoles) {
        const agentConfig = buildAgentConfig(resolved);
        config.agent ??= {};
        config.agent[resolved.id] = agentConfig;

        for (const sub of resolved.subagents) {
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

          config.agent[sub.id] = subAgentCfg as AgentConfig;
        }
      }
    },
    "chat.message": async (
      input: { agent?: string; sessionID: string },
      output: { parts: Array<{ type: string; text?: string }> },
    ) => {
      const textPartIndex = output.parts.findIndex(
        (p: { type: string; text?: string }) => p.type === "text" && "text" in p,
      );
      if (textPartIndex === -1) return;

      const part = output.parts[textPartIndex] as { type: string; text: string };
      const { functions: parsedFunctions, calls, cleanedText } = parseFunctionActivation(part.text);
      if (parsedFunctions.length === 0) return;

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

      const agentId = input.agent as string | undefined;
      if (agentId && input.sessionID && !graphSessionState.getState(input.sessionID)) {
        const graph = roleGraphMap.get(agentId);
        if (graph) {
          graphSessionState.initGraph(input.sessionID, graph);
        }
      }

      // --- function kernel: init runtime state for newly activated functions ---
      const roleFns = roleId ? roleFunctionsMap.get(roleId) : null;
      const activeFnNames = functionSessionState.getActive(input.sessionID);
      for (const fnName of activeFnNames) {
        const resolvedFn = roleFns?.find((f) => f.name === fnName);
        const sv = resolvedFn?.state_schema_version ?? 1;
        const st = functionRuntime.init(input.sessionID, fnName, sv);
        st.activatedAtTurn = st.currentTurn;
      }
      functionRuntime.markDirty();
      // Reset continuation counters because a user message just arrived:
      for (const [, st] of functionRuntime.all(input.sessionID)) {
        st.continuationCount = 0;
        st.cooldownUntilTurn = 0;
      }
    },
    "tool.execute.after": async (
      input: { sessionID?: string; tool?: string; args?: unknown },
      _output: unknown,
    ) => {
      if (!input.sessionID) return;
      if (input.tool !== "task" && input.tool !== "dispatch") return;

      const { correction } = advanceGraphForDispatch(input.sessionID, input.tool, input.args);
      if (correction) {
        pendingCorrections.set(input.sessionID, correction);
        log.debug("guardrail correction stashed", { sessionID: input.sessionID });
      }

      // --- function OBSERVE ---
      try {
        const allFns: ResolvedFunction[] = [];
        for (const funcs of roleFunctionsMap.values()) allFns.push(...funcs);
        const activeNames = functionSessionState.getActive(input.sessionID);
        const activeFns = allFns.filter((f) => activeNames.has(f.name));
        if (activeFns.length > 0 && input.tool) {
          const { ArtifactStore } = await import("./function/artifact-store.ts");
          const artifacts = new ArtifactStore(process.cwd());
          const injects = runToolObserve({
            sessionID: input.sessionID, tool: input.tool,
            activeFns, artifacts, lastAssistantText: null,
          });
          for (const inj of injects) {
            const existing = pendingCorrections.get(input.sessionID);
            pendingCorrections.set(input.sessionID, existing ? existing + "\n" + inj : inj);
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
      let userMessagedThisTurn = true; // will be refined later
      for (const [, st] of runtimeStates) {
        st.currentTurn += 1;
      }
      const artifacts = new ArtifactStore(process.cwd());
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
