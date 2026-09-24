import { createGraphToolSet } from "../../../graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../../graph/tools/index.ts";
import { invokeGraphWorkerChannel } from "../../../graph/application/worker-channel.ts";
import { PiToolFactory } from "./tool-factory.ts";

export function registerPiGraphWorker(pi: { registerTool(tool: unknown): void }): boolean {
  const endpoint = process.env.ROLEBOX_GRAPH_WORKER_ENDPOINT;
  const token = process.env.ROLEBOX_GRAPH_WORKER_TOKEN;
  const routeFile = process.env.ROLEBOX_GRAPH_WORKER_ROUTE;
  if (!endpoint && !token) return false;
  if (!endpoint || !token) throw new Error("Incomplete graph worker channel");
  delete process.env.ROLEBOX_GRAPH_WORKER_ENDPOINT;
  delete process.env.ROLEBOX_GRAPH_WORKER_TOKEN;
  delete process.env.ROLEBOX_GRAPH_WORKER_ROUTE;
  const definitions = createOutcomeGraphTools(createGraphToolSet());
  const factory = new PiToolFactory();
  for (const name of ["graph_submit_outcome", "graph_status", "graph_audit"]) {
    const definition = definitions[name]!;
    const compiled = factory.compileAll({ [name]: {
      ...definition,
      execute: (args, context) => invokeGraphWorkerChannel({ endpoint, token, routeFile }, name, args, context?.abort),
    } });
    pi.registerTool(compiled[name]);
  }
  return true;
}
