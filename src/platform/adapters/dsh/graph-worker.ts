import { AsyncLocalStorage } from "node:async_hooks";
import type { OutcomeHost } from "../../../graph/host/outcome-host.ts";
import {
  declaredToolsAllow,
  workerTaskToolAllowed,
  isGraphToolName,
  type GraphToolName,
  type OutcomeWorkerPrincipal,
} from "../../../graph/host/tool-binding.ts";
import { workerPresentationTools, type WorkerToolPresentation } from "../../../graph/domain/worker-tools.ts";
import { createWorkerCapabilityTools, createWorkerToolSession } from "../../worker-tools/index.ts";
import { DshToolFactory, type DshToolDefinition, type DshToolRunContext } from "./tool-factory.ts";
import type { DshContentBlock } from "./agent-registrar.ts";
import { readDshSessionEvents, type DshEventSource } from "./session-events.ts";
import type { DshWorkerExecutorFactory, DshWorkerToolExecution, DshWorkerToolExecutor } from "./worker-executor.ts";
import type { DshSystemPromptRegistry } from "./system-prompt.ts";

export const DSH_GRAPH_WORKER_GRANT: readonly GraphToolName[] = Object.freeze([
  "graph_submit_outcome",
]);

export const DSH_GRAPH_WORKER_TOOLS: readonly string[] = DSH_GRAPH_WORKER_GRANT;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface DshWorkerAgent {
  readonly id?: string;
  readonly session?: DshEventSource & { readonly id?: string };
  readonly ctx?: { readonly systemPrompt?: Pick<DshSystemPromptRegistry, "section">; readonly tools?: {
    /** Published rc3 uses presentAs; newer source hosts use setExecutor. */
    presentAs?(mode: "native"): () => void;
    setExecutor?(executor: DshWorkerToolExecutor): () => void;
    register?(definition: DshToolDefinition): () => void;
  } };
}

export interface DshWorkerToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

export interface DshGraphWorkerRegistry {
  setExecutor?(executor: DshWorkerToolExecutor): () => void;
  guard?(guard: (execution: { readonly name: string; readonly agent?: DshWorkerAgent }) => string | undefined): () => void;
  schemas?(scope?: DshWorkerAgent): readonly DshWorkerToolSchema[];
  get?(name: string, scope?: DshWorkerAgent): unknown;
  execute?(execution: {
    name: string;
    arguments: Record<string, unknown>;
    agent: DshWorkerAgent;
    callId: string;
    rootCallId?: string;
    parent?: unknown;
    toolSet?: unknown;
    signal: AbortSignal;
  }): Promise<unknown>;
}

export type DshGraphWorkerGrantHost = Pick<OutcomeHost, "workerPrincipalOf"> &
  Partial<Pick<OutcomeHost, "workerDeclaredToolsOf" | "workerToolPresentationOf" | "workerToolGrantOf">>;

export interface DshWorkerStartupTools {
  readonly agent?: string;
  readonly declaredTools?: readonly string[];
  readonly inheritedTools?: readonly string[];
  readonly toolPresentation?: WorkerToolPresentation;
}

function nativeResultContent(value: unknown): DshContentBlock[] {
  if (value === null || typeof value !== "object") return [];
  const result = value as { content?: unknown; emitted?: unknown[]; value?: unknown };
  if (Array.isArray(result.content)) {
    return result.content.filter((block): block is DshContentBlock =>
      block !== null && typeof block === "object" && typeof block.type === "string");
  }
  return [nativeResultContent(result.value), ...(result.emitted ?? []).map(nativeResultContent)].flat();
}

function nativeResultFailed(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const result = value as { isError?: unknown; metadata?: { error?: unknown } };
  return result.isError === true || result.metadata?.error === true;
}

/** Keep authorization in the registry guard and filter the worker's model tool surface. */
export function installDshGraphWorkerBoundary(host: DshGraphWorkerGrantHost, tools: DshGraphWorkerRegistry,
  subscribe: (event: string, listener: (...args: unknown[]) => unknown) => (() => void) | void,
  createExecutor?: DshWorkerExecutorFactory,
  rolePromptOf?: (agent: DshWorkerAgent, startup: DshWorkerStartupTools) => string) {
  const labels = new Map<string, DshWorkerStartupTools>();
  const prepared = new WeakMap<DshWorkerAgent, { startup: DshWorkerStartupTools; activated: Set<string> }>();
  const workerSessions = new Set<string>();
  const starting = new AsyncLocalStorage<{ active: boolean; tools: DshWorkerStartupTools }>();
  const calls = new AsyncLocalStorage<DshToolRunContext & { token?: unknown }>();
  const disposers: (() => void)[] = [];
  const descriptorStartup = (agent?: DshWorkerAgent): DshWorkerStartupTools | undefined => {
    const descriptor = readDshSessionEvents(agent?.session).findLast(event => event.type === "subagent/descriptor");
    const data = descriptor?.data;
    return data !== null && typeof data === "object" && "label" in data && typeof data.label === "string"
      ? labels.get(data.label) : undefined;
  };
  const isWorker = (agent?: DshWorkerAgent) => {
    if (!agent) return false;
    if (prepared.has(agent)) return true;
    const sessionId = agent.session?.id ?? agent.id ?? "";
    if (workerSessions.has(sessionId) || host.workerPrincipalOf(sessionId)) return true;
    return descriptorStartup(agent) !== undefined;
  };
  const grantOf = (agent?: DshWorkerAgent): DshWorkerStartupTools => {
    if (!agent) return { inheritedTools: [] };
    const principal: OutcomeWorkerPrincipal | undefined = host.workerPrincipalOf(agent.session?.id ?? agent.id ?? "");
    if (!principal) return prepared.get(agent)?.startup ?? { inheritedTools: [] };
    try {
      if (host.workerToolGrantOf) return host.workerToolGrantOf(principal);
      return { toolPresentation: host.workerToolPresentationOf?.(principal) };
    } catch { return { inheritedTools: [] }; }
  };
  const grantedBy = (name: string, grant: DshWorkerStartupTools): boolean =>
    (isGraphToolName(name) && DSH_GRAPH_WORKER_GRANT.includes(name)) ||
    workerPresentationTools(grant.toolPresentation).some(tool => tool === name) ||
    workerTaskToolAllowed(name, grant.declaredTools, grant.inheritedTools);
  const grantedToWorker = (name: string, agent?: DshWorkerAgent): boolean => {
    if (isGraphToolName(name) && DSH_GRAPH_WORKER_GRANT.includes(name)) return true;
    return grantedBy(name, grantOf(agent));
  };
  const guard = tools.guard?.(execution => isWorker(execution.agent) && !grantedToWorker(execution.name, execution.agent)
    ? "Graph workers may only use parent-authorized task tools and their worker entry points; graph control and recursive dispatch remain unavailable" : undefined);
  if (guard) disposers.push(guard);
  const catalogOf = (agent: DshWorkerAgent): readonly DshWorkerToolSchema[] | undefined => {
    if (!tools.schemas) return undefined;
    try { return tools.schemas(agent); }
    catch (error) { throw new Error(`Worker tool catalog is unavailable: ${message(error)}`); }
  };
  const checkAvailability = (agent: DshWorkerAgent, grant: DshWorkerStartupTools): void => {
    const catalog = catalogOf(agent);
    if (!catalog) return;
    const names = new Set(catalog.map(tool => tool.name));
    const exact = grant.toolPresentation?.preload ?? [];
    const missing = [...new Set(exact.filter(name => !names.has(name)))];
    if (missing.length) throw new Error(`Worker preload names unavailable host tools: ${missing.join(", ")}`);
    const deniedPreloads = (grant.toolPresentation?.preload ?? []).filter(name =>
      !workerTaskToolAllowed(name, grant.declaredTools, grant.inheritedTools));
    if (deniedPreloads.length) throw new Error(`Worker preload is outside inherited authorization: ${deniedPreloads.join(", ")}`);

  };
  let subcall = 0;
  const visibleToWorker = (name: string, grant: DshWorkerStartupTools, activated?: Set<string>): boolean => {
    if (!grantedBy(name, grant)) return false;
    const presentation = grant.toolPresentation;
    return !presentation || presentation.mode === "native" || isGraphToolName(name) ||
      declaredToolsAllow(name, presentation.preload ?? []) || (presentation.mode === "discover" && activated?.has(name) === true);
  };
  const prepare = (agent?: DshWorkerAgent, admitted = false, startup: DshWorkerStartupTools = {}) => {
    if (!agent || (!admitted && !isWorker(agent)) || prepared.has(agent)) return;
    const scoped = agent.ctx?.tools;
    if (!scoped) throw new Error("Graph workers require a scoped tool registry");
    // A host may publish the child after the async start scope has already closed.
    const state = { startup: { ...descriptorStartup(agent), ...startup }, activated: new Set<string>() };
    prepared.set(agent, state);
    const sessionId = agent.session?.id ?? agent.id;
    const owned: (() => void)[] = [];
    try {
      if (rolePromptOf) {
        const registry = agent.ctx?.systemPrompt;
        if (!registry) throw new Error("Graph workers require an agent-scoped system-prompt registry");
        const rolePrompt = rolePromptOf(agent, state.startup);
        owned.push(registry.section({ name: "rolebox:role", order: 50, interpolate: false, text: () => rolePrompt }));
      }
      let invoke = tools.execute ? (execution: DshWorkerToolExecution) => tools.execute!(execution) : undefined;
      if (scoped.setExecutor) {
        if (!createExecutor) throw new Error("Graph workers require the host native tool executor");
        const worker = createExecutor(agent);
        invoke = worker.invoke;
        owned.push(scoped.setExecutor({
          describe: definitions => {
            const grant = grantOf(agent);
            return worker.executor.describe(definitions.filter(tool => visibleToWorker(tool.name, grant, state.activated)));
          },
          execute: input => worker.executor.execute(input),
        }));
      } else {
        const native = scoped.presentAs?.("native");
        if (native) owned.push(native);
      }
      if (sessionId) workerSessions.add(sessionId);
      const grant = grantOf(agent);
      checkAvailability(agent, grant);
      const presentation = grant.toolPresentation ?? { mode: "native" };
      if (presentation.mode === "native") {
        disposers.push(...owned);
        return;
      }
      if (!scoped.register || !tools.schemas || !invoke) {
        throw new Error("Worker discovery and code presentation require scoped registration, tool schemas and registry execution");
      }
      const sessionFor = (outer: DshToolRunContext & { token?: unknown }) => createWorkerToolSession({
        presentation,
        allowedTools: () => {
          const current = grantOf(agent);
          return (catalogOf(agent) ?? []).filter(tool => workerTaskToolAllowed(tool.name, current.declaredTools, current.inheritedTools))
            .map(tool => tool.name);
        },
        registry: {
          list: () => catalogOf(agent)!.map(schema => {
            const definition = tools.get?.(schema.name, agent) as { output?: { schema?: unknown } } | undefined;
            return { name: schema.name, description: schema.description, inputSchema: schema.parameters,
              ...(definition?.output?.schema === undefined ? {} : { outputSchema: definition.output.schema }),
            };
          }),
          invoke: async (name, args, context) => {
            const result = await invoke!({ name, arguments: args, agent,
              callId: `${outer.callId}:worker:${++subcall}`, rootCallId: outer.rootCallId ?? outer.callId,
              ...(outer.token === undefined ? {} : { parent: outer.token }),
              ...(outer.toolSet === undefined ? {} : { toolSet: outer.toolSet }), signal: context.signal });
            if (result !== null && typeof result === "object") {
              const delivered = result as { additionalContexts?: unknown[]; concludesTurn?: boolean };
              for (const context of delivered.additionalContexts ?? []) outer.deferContext(context);
              if (delivered.concludesTurn === true) outer.concludeTurn();
            }
            return result;
          },
        },
        activate: descriptors => { for (const descriptor of descriptors) state.activated.add(descriptor.name); },
      });
      const capabilities = new DshToolFactory().compileAll(createWorkerCapabilityTools({
        resolveSession: () => {
          const outer = calls.getStore();
          if (!outer || outer.agent !== agent) throw new Error("Worker tool invocation requires its original host execution");
          return sessionFor(outer);
        },
        formatResult: result => ({ output: JSON.stringify(result), metadata: {
          nativeResult: result, ...(nativeResultFailed(result) ? { error: true } : {}),
        } }),
      }));
      for (const name of workerPresentationTools(presentation)) {
        const compiled = capabilities[name] as DshToolDefinition;
        const execute = compiled.execute;
        const render = compiled.output.render;
        owned.push(scoped.register({ ...compiled,
          output: { ...compiled.output, render: (args, value) => {
            const raw = value !== null && typeof value === "object"
              ? (value as { metadata?: { nativeResult?: unknown } }).metadata?.nativeResult : undefined;
            const content = nativeResultContent(raw);
            if (!content.length) return render(args, value);
            return raw !== null && typeof raw === "object" && "content" in raw
              ? content : [...render(args, value), ...content];
          } },
          execute: (args, execution) => calls.run(execution, () => execute(args, execution)),
        }));
      }
      disposers.push(...owned);
    } catch (error) {
      for (const dispose of owned.reverse()) dispose();
      prepared.delete(agent);
      if (sessionId) workerSessions.delete(sessionId);
      throw error;
    }
  };
  const created = subscribe("agent/created", (...args) => {
    const scope = starting.getStore();
    prepare((args[0] as { agent?: DshWorkerAgent }).agent, scope?.active === true, scope?.tools);
  });
  if (created) disposers.push(created);
  const assemble = subscribe("system-prompt/assemble", async (...args) => {
    const assembly = await (args[2] as () => Promise<{ tools?: DshWorkerToolSchema[]; contexts?: Array<{ name: string; text: string }> }>)();
    const agent = (args[1] as { scope?: DshWorkerAgent }).scope;
    if (!isWorker(agent)) return assembly;
    prepare(agent);
    const grant = grantOf(agent);
    const activated = agent && prepared.get(agent)?.activated;
    if (agent) checkAvailability(agent, grant);
    return { ...assembly,
      // Newer hosts keep tool declarations outside the text presentation waterfall.
      ...(assembly.tools === undefined ? {} : { tools: assembly.tools.filter(tool => visibleToWorker(tool.name, grant, activated)) }),
    };
  });
  if (assemble) disposers.push(assemble);
  const stop = subscribe("agent/pre-step", async (...args) => {
    const decision = await (args[1] as () => Promise<unknown>)();
    prepare((args[0] as { agent?: DshWorkerAgent }).agent);
    return decision;
  });
  if (stop) disposers.push(stop);
  return {
    isWorker,
    toolGrantOf: grantOf,
    roleOf: (agent?: DshWorkerAgent) => agent ? prepared.get(agent)?.startup.agent : undefined,
    async start<T>(label: string, create: () => Promise<T>, startup: DshWorkerStartupTools = {}): Promise<T> {
      if (!guard) throw new Error("This dsh host cannot enforce the graph worker execution guard");
      const grant = { agent: startup.agent, declaredTools: startup.declaredTools, inheritedTools: startup.inheritedTools,
        toolPresentation: startup.toolPresentation };
      labels.set(label, grant);
      const scope = { active: true, tools: grant };
      try { return await starting.run(scope, create); }
      finally { scope.active = false; }
    },
    prepare,
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) dispose();
      labels.clear(); workerSessions.clear(); starting.disable(); calls.disable();
    },
  };
}
