import type { AgentConfig, Event } from "@opencode-ai/sdk";
import type { PluginInput, Config } from "@opencode-ai/plugin";
import { applyParams } from "./function-resolver.ts";
import { parseFunctionActivation } from "./function-parser.ts";
import { functionSessionState } from "./session-state.ts";
import { graphSessionState, buildGraphStateBlock } from "./graph/index.ts";
import { buildFunctionBlock } from "./prompt-builder.ts";
import { buildAgentConfig, transformPermission } from "./prompt/agent-config.ts";
import { DispatchManager } from "./dispatch/manager.ts";
import { createDispatchTool, createDispatchOutputTool, createDispatchCancelTool } from "./dispatch/tools.ts";
import type { ResolvedRole, ResolvedFunction, ResolvedGraph } from "./types.ts";
import { RoleMode } from "./constants.ts";
import { createSubLogger } from "./logger.ts";

const log = createSubLogger("plugin-hooks");

export function createPluginHooks(
  resolvedRoles: ResolvedRole[],
  client: PluginInput["client"],
  roleFunctionsMap: Map<string, ResolvedFunction[]>,
  roleGraphMap: Map<string, ResolvedGraph>,
) {
  const resolvedSubagents = new Map<string, string>();
  for (const role of resolvedRoles) {
    for (const sub of role.subagents) {
      resolvedSubagents.set(sub.id, role.id);
    }
  }

  const dispatchManager = new DispatchManager(client);

  return {
    tool: {
      dispatch: createDispatchTool(dispatchManager, resolvedSubagents),
      dispatch_output: createDispatchOutputTool(dispatchManager),
      dispatch_cancel: createDispatchCancelTool(dispatchManager),
    },
    event: async (input: { event: Event }) => {
      if (input.event.type === "session.idle") {
        const sessionId = (input.event.properties as { sessionID?: string })?.sessionID;
        if (sessionId) {
          await dispatchManager.handleSessionIdle(sessionId);
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
    },
    "tool.execute.after": async (
      input: { sessionID?: string; tool?: string; args?: unknown },
      _output: unknown,
    ) => {
      if (!input.sessionID) return;
      if (input.tool !== "task" && input.tool !== "dispatch") return;

      const state = graphSessionState.getState(input.sessionID);
      if (!state || state.status !== "active") return;

      const args = typeof input.args === "string" ? input.args : JSON.stringify(input.args ?? {});
      let agentMatch: RegExpMatchArray | null = null;
      if (input.tool === "task") {
        agentMatch = args.match(/subagent_type\s*=\s*["']([^"']+)["']/)
                   ?? args.match(/subagent_type\s*=\s*([^\s,}\])]+)/);
      } else {
        agentMatch = args.match(/subagent\s*=\s*["']([^"']+)["']/)
                   ?? args.match(/subagent\s*=\s*([^\s,}\])]+)/);
      }
      if (!agentMatch) return;

      graphSessionState.advanceStep(input.sessionID, agentMatch[1]);
    },
    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ) => {
      if (!input.sessionID) return;

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

      if (activeFunctions.length === 0) {
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

      const block = buildFunctionBlock(activeFunctions);
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
      log.debug("System prompt augmented", { totalChars, addedFunctions: activeFunctions.length, hasGraphBlock: !!graphState });
    },
  };
}
