import { createGraphToolSet } from "../../../graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../../graph/tools/index.ts";
import { invokeGraphWorkerChannel, WORKER_CHANNEL_GRAPH_TOOLS } from "../../../graph/application/worker-channel.ts";
import type { CanonicalToolDef } from "../../types.ts";
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
  // THE FACE IS THE CHANNEL'S OWN (one declaration, not a second literal): the
  // names this process registers and the names the channel will serve are the
  // same list, typed by the closed vocabulary.
  for (const name of WORKER_CHANNEL_GRAPH_TOOLS) {
    // A CHECKED LOOKUP: the surface is a `Record<string, …>`, so the definition
    // may be absent and is refused by name rather than asserted present. A
    // missing definition means this build would hand the worker a tool it
    // cannot serve, so it fails the registration loudly.
    const definition: CanonicalToolDef | undefined = definitions[name];
    if (definition === undefined) {
      throw new Error(`This build ships no ${name} definition, so the graph worker channel cannot expose it`);
    }
    const compiled = factory.compileAll({ [name]: {
      ...definition,
      execute: (args, context) => invokeGraphWorkerChannel({ endpoint, token, routeFile }, name, args, context?.abort),
    } });
    pi.registerTool(compiled[name]);
  }
  return true;
}
