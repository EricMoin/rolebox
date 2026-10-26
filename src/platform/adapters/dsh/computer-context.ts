import { buildComputerContext } from "../../../computer/context.ts";
import { COMPUTER_TOOL_NAMES, decideComputerToolGrant } from "../../../loader/computer-grants.ts";
import { workerTaskToolAllowed } from "../../../graph/host/tool-binding.ts";
import { resolveDshSessionContext, type DshContextAgent, type DshContextOptions } from "./session-context.ts";
import type { DshWorkerStartupTools } from "./graph-worker.ts";

export function createDshComputerContext(options: DshContextOptions) {
  return (agent: DshContextAgent, roleOverride?: string, workerOverride?: DshWorkerStartupTools): string => {
    const { requestedRoleId, worker } = resolveDshSessionContext(options, agent, roleOverride, workerOverride);
    const registered = new Set(options.tools(agent));
    const names = options.names?.();
    const actual = (name: string) => names?.get(name) ?? name;
    const tools = COMPUTER_TOOL_NAMES.filter(name => registered.has(actual(name)) &&
      decideComputerToolGrant({ toolName: name, roleId: requestedRoleId, roles: options.roles() }).granted &&
      (worker === undefined || workerTaskToolAllowed(actual(name), worker.declaredTools, worker.inheritedTools)));
    return buildComputerContext({ tools, presentation: worker?.toolPresentation?.mode, discoverInvocation: "call" })
      .replace(/\bcomputer_[a-z_]+\b/g, actual);
  };
}
