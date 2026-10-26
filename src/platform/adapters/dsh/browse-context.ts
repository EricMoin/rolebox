import { buildBrowseContext } from "../../../browse/context.ts";
import { BROWSE_TOOL_NAMES, decideBrowseToolGrant } from "../../../loader/browse-grants.ts";
import { workerTaskToolAllowed } from "../../../graph/host/tool-binding.ts";
import { resolveDshSessionContext, type DshContextAgent, type DshContextOptions } from "./session-context.ts";
import type { DshWorkerStartupTools } from "./graph-worker.ts";

/**
 * The browse workflow block for one dsh session — the `browse_*` counterpart of
 * `createDshComputerContext`.
 *
 * A name is advertised only when the host actually registered it (under
 * whatever alias the collision probe gave it), the acting role's `tools:` map
 * grants it, and — for a graph worker — the node's declared grant admits it.
 * The rendered block is then rewritten to the registered aliases, so the prompt
 * names the tool the model must call.
 */
export function createDshBrowseContext(options: DshContextOptions) {
  return (agent: DshContextAgent, roleOverride?: string, workerOverride?: DshWorkerStartupTools): string => {
    const { requestedRoleId, worker } = resolveDshSessionContext(options, agent, roleOverride, workerOverride);
    const registered = new Set(options.tools(agent));
    const names = options.names?.();
    const actual = (name: string) => names?.get(name) ?? name;
    const tools = BROWSE_TOOL_NAMES.filter(name => registered.has(actual(name)) &&
      decideBrowseToolGrant({ toolName: name, roleId: requestedRoleId, roles: options.roles() }).granted &&
      (worker === undefined || workerTaskToolAllowed(actual(name), worker.declaredTools, worker.inheritedTools)));
    return buildBrowseContext({ tools, presentation: worker?.toolPresentation?.mode, discoverInvocation: "call" })
      .replace(/\bbrowse_[a-z_]+\b/g, actual);
  };
}
