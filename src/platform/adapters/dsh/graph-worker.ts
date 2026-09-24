import { z } from "zod";
import { join } from "node:path";
import { getDataDir } from "../../../cli/paths.ts";
import { INPUT_DELIVERY_DIR, inputConsumerDirectory } from "../../../graph/host/input-view.ts";
import type { OutcomeHost } from "../../../graph/host/outcome-host.ts";
import type { CanonicalToolDef } from "../../types.ts";
import { executeGraphWorkerCommand } from "../../sandbox/worker-exec.ts";

export const DSH_GRAPH_WORKER_TOOLS = ["graph_submit_outcome", "graph_worker_exec"];

/** The host's tool registry authenticates the caller; its shell runs in a separate OS sandbox. */
export function createDshGraphWorkerTools(host: OutcomeHost, workspace: string, storeRoot: string): Record<string, CanonicalToolDef> {
  return {
    graph_worker_exec: {
      description: "Run a shell command in this graph worker's workspace sandbox. Use this for reading, editing, builds and tests.",
      args: { command: z.string(), timeout_ms: z.number().int().min(1).max(300_000).optional() },
      async execute(args, context) {
        const worker = host.workerPrincipalOf(context?.sessionID ?? "");
        if (!worker) throw new Error("This tool requires a confirmed graph worker session");
        const inputRoot = inputConsumerDirectory(join(storeRoot, INPUT_DELIVERY_DIR), worker.graphId, worker.attemptId);
        const result = await executeGraphWorkerCommand({ command: args.command as string, workspace,
          dataDirectory: getDataDir(), inputPaths: [inputRoot], signal: context?.abort,
          timeoutMs: args.timeout_ms as number | undefined });
        return JSON.stringify(result);
      },
    },
  };
}

interface WorkerAgent {
  readonly id?: string;
  readonly session?: { readonly id?: string; readonly events?: readonly { type: string; data?: unknown }[] };
  readonly ctx?: { readonly tools?: { presentAs(mode: "native"): () => void } };
}

export interface DshGraphWorkerRegistry {
  guard?(guard: (execution: { readonly name: string; readonly agent?: WorkerAgent }) => string | undefined): () => void;
}

/** Protect the execution pipeline too: Code Mode transports are outside toolFilter. */
export function installDshGraphWorkerBoundary(host: OutcomeHost, tools: DshGraphWorkerRegistry,
  subscribe: (event: string, listener: (...args: unknown[]) => unknown) => (() => void) | void) {
  const labels = new Set<string>();
  const presentations = new WeakSet<object>();
  const disposers: (() => void)[] = [];
  const isWorker = (agent?: WorkerAgent) => {
    if (!agent) return false;
    if (host.workerPrincipalOf(agent.session?.id ?? agent.id ?? "")) return true;
    return agent.session?.events?.some(event => event.type === "subagent/descriptor" && event.data !== null && typeof event.data === "object" &&
      "label" in event.data && typeof event.data.label === "string" && labels.has(event.data.label)) ?? false;
  };
  const guard = tools.guard?.(execution => isWorker(execution.agent) && !DSH_GRAPH_WORKER_TOOLS.includes(execution.name)
    ? "Graph workers may only submit their own outcome or use the sandbox command tool" : undefined);
  if (guard) disposers.push(guard);
  const stop = subscribe("agent/pre-step", async (...args) => {
    const step = args[0] as { agent?: WorkerAgent };
    const next = args[1] as () => Promise<unknown>;
    const decision = await next();
    const agent = step.agent;
    if (agent && isWorker(agent) && !presentations.has(agent)) {
      const scoped = agent.ctx?.tools;
      if (!scoped?.presentAs) throw new Error("Graph workers require native scoped tool presentation");
      disposers.push(scoped.presentAs("native"));
      presentations.add(agent);
    }
    return decision;
  });
  if (stop) disposers.push(stop);
  return {
    admit(label: string) {
      if (!guard) throw new Error("This dsh host cannot enforce the graph worker execution guard");
      labels.add(label);
    },
    dispose() { for (const dispose of disposers.splice(0).reverse()) dispose(); labels.clear(); },
  };
}
