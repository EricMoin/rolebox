import { resolveDshSessionContext, type DshContextAgent as DshMemoryAgent, type DshContextOptions as DshMemoryOptions } from "./session-context.ts";
import { isAbsolute } from "node:path";
import { buildMemoryContext } from "../../../memory/context.ts";
import { MemoryStore } from "../../../memory/store.ts";
import { MEMORY_TOOL_NAMES, memoryToolEnabled } from "../../../memory/tool-policy.ts";
import { workerTaskToolAllowed } from "../../../graph/host/tool-binding.ts";
import type { DshWorkerStartupTools } from "./graph-worker.ts";
import { createSubLogger } from "../../../logger.ts";

const log = createSubLogger("dsh-memory");
export const DSH_MEMORY_WORKFLOW_TOOLS = [...MEMORY_TOOL_NAMES, "session_list", "session_read"] as const;

export type { DshContextAgent as DshMemoryAgent, DshContextOptions as DshMemoryOptions } from "./session-context.ts";

export function createDshMemoryContext(options: DshMemoryOptions) {
  const resolve = (agent: DshMemoryAgent, roleOverride?: string, workerOverride?: DshWorkerStartupTools) =>
    resolveDshSessionContext(options, agent, roleOverride, workerOverride);

  return {
    forTool(agent: DshMemoryAgent, name: string) {
      const { role, roleId, directory } = resolve(agent);
      if (!memoryToolEnabled(name, role?.config.tools)) throw new Error(`Memory tool ${name} is disabled for the active role`);
      if (!directory || !isAbsolute(directory)) throw new Error("Memory tools require a session with an absolute workspace directory");
      return { agent: roleId, directory, worktree: directory };
    },
    render(agent: DshMemoryAgent, roleOverride?: string, workerOverride?: DshWorkerStartupTools): string {
      const { role, roleId, directory, worker } = resolve(agent, roleOverride, workerOverride);
      const registered = new Set(options.tools(agent));
      const names = options.names?.();
      const actual = (name: string) => names?.get(name) ?? name;
      const tools = DSH_MEMORY_WORKFLOW_TOOLS.filter(name => registered.has(actual(name)) && memoryToolEnabled(name, role?.config.tools) &&
        (worker === undefined || workerTaskToolAllowed(actual(name), worker.declaredTools, worker.inheritedTools)));
      const context = { roleId, config: role?.config.memory, tools, presentation: worker?.toolPresentation?.mode,
        discoverInvocation: "call" as const };
      const render = (store?: MemoryStore) => {
        const text = buildMemoryContext({ ...context, store });
        const split = text.indexOf("\n\n## Available memory");
        const end = split < 0 ? text.length : split;
        return text.slice(0, end).replace(/\b(?:memory_(?:recall|read|list|write|update)|session_(?:list|read))\b/g, actual) + text.slice(end);
      };
      let store: MemoryStore | undefined;
      try {
        if (tools.length && directory && isAbsolute(directory) && context.config?.inject !== false && context.config?.max_inject !== 0 &&
          tools.some(name => name === "memory_read" || name === "memory_recall" || name === "memory_list")) {
          store = MemoryStore.open(directory);
        }
        return render(store);
      } catch (error) {
        log.warn("Memory context unavailable", { error: error instanceof Error ? error.message : String(error) });
        return render();
      } finally {
        store?.close();
      }
    },
  };
}
