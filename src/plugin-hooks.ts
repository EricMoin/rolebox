import type { AgentConfig } from "@opencode-ai/sdk";
import type { PluginInput, Config } from "@opencode-ai/plugin";
import { applyParams } from "./function-resolver.js";
import { parseFunctionActivation } from "./function-parser.js";
import { functionSessionState } from "./session-state.js";
import { graphSessionState, buildGraphStateBlock } from "./graph/index.js";
import { buildFunctionBlock } from "./prompt-builder.js";
import { buildAgentConfig } from "./prompt/agent-config.js";
import { DispatchManager } from "./dispatch/manager.js";
import { createDispatchTool, createDispatchOutputTool, createDispatchCancelTool } from "./dispatch/tools.js";
import type { ResolvedRole, ResolvedFunction, ResolvedGraph } from "./types.js";
import { RoleMode } from "./constants.js";

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
          if (sub.config.permission) subAgentCfg.permission = sub.config.permission;

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
        agentMatch = args.match(/subagent_type\s*=\s*["']([^"']+)["']/);
      } else {
        agentMatch = args.match(/subagent\s*=\s*["']([^"']+)["']/);
      }
      if (!agentMatch) return;

      graphSessionState.advanceStep(input.sessionID, agentMatch[1]);
    },
    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ) => {
      if (!input.sessionID) return;

      const activeNames = functionSessionState.getActive(input.sessionID);
      if (activeNames.size === 0) return;

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

      if (activeFunctions.length === 0) return;

      const block = buildFunctionBlock(activeFunctions);
      output.system.push(block);

      const graphState = graphSessionState.getState(input.sessionID);
      if (graphState) {
        const graph = graphSessionState.getGraph(input.sessionID);
        if (graph) {
          const stateBlock = buildGraphStateBlock(graphState, graph);
          output.system.push(stateBlock);
        }
      }
    },
  };
}
