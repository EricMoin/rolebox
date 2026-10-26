import { createGraphToolSet } from "../../../graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../../graph/tools/index.ts";
import { invokeGraphWorkerChannel, WORKER_CHANNEL_GRAPH_TOOLS } from "../../../graph/application/worker-channel.ts";
import type { CanonicalToolDef } from "../../types.ts";
import { PiToolFactory, toPiResult } from "./tool-factory.ts";
import { createWorkerCapabilityTools, createWorkerToolSession } from "../../worker-tools/index.ts";
import { workerPresentationTools } from "../../../graph/domain/worker-tools.ts";
import { parsePiWorkerToolConfig, piWorkerToolAllowed, validatePiWorkerTools } from "./worker-tools.ts";

interface PiWorkerApi {
  registerTool(tool: unknown): void;
  getAllTools?(): readonly { name: string; description: string; parameters: unknown }[];
  setActiveTools?(names: string[]): void;
  on?(event: string, listener: (event: { toolName?: string }, context: { shutdown(): void }) => unknown): unknown;
}

export function registerPiGraphWorker(pi: PiWorkerApi): boolean {
  const endpoint = process.env.ROLEBOX_GRAPH_WORKER_ENDPOINT;
  const token = process.env.ROLEBOX_GRAPH_WORKER_TOKEN;
  const routeFile = process.env.ROLEBOX_GRAPH_WORKER_ROUTE;
  const configuration = process.env.ROLEBOX_GRAPH_WORKER_TOOLS;
  if (!endpoint && !token) return false;
  if (!endpoint || !token) throw new Error("Incomplete graph worker channel");
  delete process.env.ROLEBOX_GRAPH_WORKER_ENDPOINT;
  delete process.env.ROLEBOX_GRAPH_WORKER_TOKEN;
  delete process.env.ROLEBOX_GRAPH_WORKER_ROUTE;
  delete process.env.ROLEBOX_GRAPH_WORKER_TOOLS;
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
  if (configuration !== undefined) {
    if (!pi.getAllTools || !pi.setActiveTools || !pi.on) {
      throw new Error("Pi graph tool presentation requires getAllTools, setActiveTools and lifecycle hooks");
    }
    const config = parsePiWorkerToolConfig(configuration);
    const proxies = new Set(config.proxies.map(tool => tool.name));
    const capabilityNames = workerPresentationTools(config.presentation);
    const visible = new Set<string>([...config.baseline, ...capabilityNames, ...(config.presentation?.preload ?? [])]);
    for (const tool of config.proxies) {
      pi.registerTool({ name: tool.name, label: tool.name, description: tool.description, parameters: tool.inputSchema,
        execute: async (_callId: string, args: Record<string, unknown>, signal?: AbortSignal) =>
          toPiResult(await invokeGraphWorkerChannel({ endpoint, token, routeFile }, tool.name, args, signal)),
      });
    }
    const runtime = createWorkerToolSession({
      presentation: config.presentation ?? { mode: "native" },
      allowedTools: () => pi.getAllTools!().filter(tool => piWorkerToolAllowed(tool.name, config)).map(tool => tool.name),
      registry: {
        list: () => pi.getAllTools!().map(tool => ({ name: tool.name, description: tool.description,
          inputSchema: tool.parameters, source: proxies.has(tool.name) ? "rolebox" : "pi" })),
        invoke: async name => { throw new Error(`Pi cannot broker ${name} through the complete host tool_call hooks. Describe it, then use the activated native tool.`); },
      },
      activate: tools => {
        for (const tool of tools) visible.add(tool.name);
        pi.setActiveTools!([...visible].filter(name => piWorkerToolAllowed(name, config) || capabilityNames.includes(name as never)));
      },
    });
    const definitions = createWorkerCapabilityTools({ resolveSession: () => runtime });
    const discovery = definitions.graph_worker_tools;
    if (discovery) discovery.description = "List, search, or describe tools granted to this worker. Describing a tool activates its native tool for the next model turn; call that native tool to execute it through host tool_call hooks. The call action is unsupported on Pi.";
    const capabilities = factory.compileAll(definitions);
    for (const name of capabilityNames) pi.registerTool(capabilities[name]);
    let failed = false;
    const prepare = (_event: unknown, context: { shutdown(): void }) => {
      try {
        const available = pi.getAllTools!();
        validatePiWorkerTools(config, available);
        const names = available.filter(tool => piWorkerToolAllowed(tool.name, config) || capabilityNames.includes(tool.name as never))
          .filter(tool => config.presentation === undefined || config.presentation.mode === "native" || visible.has(tool.name))
          .map(tool => tool.name);
        pi.setActiveTools!(names);
      } catch (error) {
        failed = true;
        pi.setActiveTools!([]);
        context.shutdown();
        throw error;
      }
    };
    pi.on("session_start", prepare);
    pi.on("before_agent_start", prepare);
    pi.on("tool_call", event => {
      const name = event.toolName ?? "";
      if (failed || (!piWorkerToolAllowed(name, config) && !capabilityNames.includes(name as never))) {
        return { block: true, reason: `Tool ${name} is not granted to this graph worker` };
      }
    });
  }
  return true;
}
