import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import type { OutcomeHost } from "../../../graph/host/outcome-host.ts";
import {
  declaredToolsAllow,
  workerTaskToolAllowed,
  isGraphToolName,
  type GraphToolName,
  type OutcomeWorkerPrincipal,
} from "../../../graph/host/tool-binding.ts";
import type { CanonicalToolContext, CanonicalToolDef } from "../../types.ts";
import { workerPresentationTools, type WorkerToolPresentation } from "../../../graph/domain/worker-tools.ts";
import { createWorkerCapabilityTools, createWorkerToolSession } from "../../worker-tools/index.ts";
import { DshToolFactory, type DshToolDefinition, type DshToolRunContext } from "./tool-factory.ts";
import type { DshContentBlock } from "./agent-registrar.ts";
import { executeGraphWorkerCommand } from "../../sandbox/worker-exec.ts";
import { disposableEnvironmentHint, getSystem } from "../../system/index.ts";
import { readDshSessionEvents, type DshEventSource } from "./session-events.ts";
import type { DshWorkerExecutorFactory, DshWorkerToolExecution, DshWorkerToolExecutor } from "./worker-executor.ts";

/**
 * THE GRAPH FACE A DSH WORKER'S OWN CALLS ARE JUDGED BY: the delivery channel
 * every dispatched worker holds plus dsh's worker command entry, which this
 * host ships inside the reserved `graph_` namespace. Typed by the closed
 * vocabulary ({@link GraphToolName}), so a misspelled or renamed entry is a
 * compile error instead of a guard that silently stops admitting the worker's
 * only delivery channel.
 *
 * THE MEMBERSHIP DIVERGES FROM THE IN-PROCESS BASELINE ON PURPOSE:
 * `graph_worker_exec` is dsh's own command tool and belongs to no other host.
 */
export const DSH_GRAPH_WORKER_GRANT: readonly GraphToolName[] = Object.freeze([
  "graph_submit_outcome",
  "graph_worker_exec",
]);

/**
 * THE SAME ARRAY, WIDENED for the callers that compare these names against a
 * HOST tool name they only know as a `string`: the dsh entry's collision probe
 * (`src/entries/dsh.ts`) and the dispatch request's baseline both read this
 * binding, and neither can be narrowed where it sits. It cannot drift from the
 * typed membership above — it IS that array — so the widening buys a caller
 * nothing but the parameter type it already needs.
 */
export const DSH_GRAPH_WORKER_TOOLS: readonly string[] = DSH_GRAPH_WORKER_GRANT;

/**
 * The host's process-confinement seam (`@deepseek-ai/dsh-sandbox`), consumed
 * structurally so rolebox never imports the package. `confine` carries the
 * policy PER CALL and answers the argv to spawn, the enforcement the host
 * achieved, and — for a partial enforcement — the denial signatures its backend
 * produces.
 */
export interface DshSandboxService {
  confine(
    argv: readonly string[],
    policy: { mode: "read-only" | "workspace-write"; workspaceRoot: string; sessionId?: string },
    signal?: AbortSignal,
  ): Promise<{ argv: string[]; enforcement: "full" | "partial"; denialSignatures: readonly string[] }>;
}

/**
 * The host's policy resolver (`@deepseek-ai/dsh-sandbox-policy`), consumed
 * structurally. It is synchronous because the host answers it from in-memory
 * session state, with the precedence: an explicitly approved mode, else the
 * session's last `sandbox/mode` event, else the deployment default.
 * `danger-full-access` is NOT a confined mode: it carries no profile to apply,
 * and rolebox must not silently narrow it.
 */
export interface DshSandboxPolicyService {
  resolve(request?: { session?: unknown }): {
    mode: "read-only" | "workspace-write" | "danger-full-access";
    workspaceRoot: string;
    sessionId?: string;
  };
}

export type DshWorkerCommandMode = "read-only" | "workspace-write" | "danger-full-access";

/** `unconfined` is the `danger-full-access` outcome; the host never confines it. */
export type DshWorkerCommandEnforcement = "full" | "partial" | "unconfined";

/** What a `graph_worker_exec` call reports besides the command's own result. */
export interface DshWorkerCommandResult {
  exitCode: number | null;
  output: string;
  /** The directory the command actually ran in: the attempt's worker workspace. */
  cwd: string;
  mode: DshWorkerCommandMode;
  enforcement: DshWorkerCommandEnforcement;
  denialSignatures: readonly string[];
}

/**
 * The boundary an attempt runs under, as prompt material — resolved WITHOUT
 * running a command, while each command's own result states what that command
 * actually got.
 */
export type DshWorkerCommandBoundary =
  | { readonly kind: "confined"; readonly mode: "read-only" | "workspace-write"; readonly workspaceRoot: string }
  | { readonly kind: "unconfined"; readonly mode: "danger-full-access" }
  | { readonly kind: "refused"; readonly reason: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The three modes the host's policy vocabulary defines; anything else is refused. */
function resolvedMode(value: unknown): DshWorkerCommandMode | undefined {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access" ? value : undefined;
}

/** Describe the mode the host resolves for an attempt so the worker prompt can state it. */
export function resolveDshWorkerCommandBoundary(
  sandboxPolicy: DshSandboxPolicyService | undefined,
  sandbox: DshSandboxService | undefined,
  session?: unknown,
): DshWorkerCommandBoundary {
  if (!sandboxPolicy) {
    return { kind: "refused", reason: "this host exposes no sandbox policy service" };
  }
  let resolved: ReturnType<DshSandboxPolicyService["resolve"]>;
  try {
    resolved = sandboxPolicy.resolve({ session });
  } catch (error) {
    return { kind: "refused", reason: `sandbox policy resolution failed: ${message(error)}` };
  }
  const mode = resolvedMode(resolved?.mode);
  if (!mode) return { kind: "refused", reason: "the sandbox policy service resolved no recognized mode" };
  if (mode === "danger-full-access") return { kind: "unconfined", mode };
  if (!sandbox) return { kind: "refused", reason: "this host exposes no confinement service" };
  if (typeof resolved.workspaceRoot !== "string" || resolved.workspaceRoot.length === 0) {
    return { kind: "refused", reason: "the sandbox policy service resolved no workspace root" };
  }
  return { kind: "confined", mode, workspaceRoot: resolved.workspaceRoot };
}

/**
 * Confine one worker command through the host's services, then run it.
 *
 * FAIL CLOSED: a missing resolver, a missing confinement service, a rejected
 * `confine` call, an unrecognized enforcement or a malformed argv refuses the
 * command with an error naming the service. rolebox never falls back to an
 * unconfined spawn for a confined mode; only `danger-full-access` — the mode the
 * user actually authorized — spawns the command unconfined.
 */
export async function executeDshWorkerCommand(options: {
  command: string;
  workspace: string;
  sandbox?: DshSandboxService;
  sandboxPolicy?: DshSandboxPolicyService;
  session?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<DshWorkerCommandResult> {
  const { sandbox, sandboxPolicy } = options;
  if (!sandboxPolicy) {
    throw new Error("Graph worker commands require the host's sandbox policy service (@deepseek-ai/dsh-sandbox-policy); rolebox does not confine worker commands itself and refuses to run one unconfined.");
  }
  let resolved: ReturnType<DshSandboxPolicyService["resolve"]>;
  try {
    resolved = sandboxPolicy.resolve({ session: options.session });
  } catch (error) {
    throw new Error(`The host sandbox policy service failed to resolve this session's mode: ${message(error)}`);
  }
  const mode = resolvedMode(resolved?.mode);
  if (!mode) {
    throw new Error("The host sandbox policy service resolved no recognized mode; refusing to run the command.");
  }
  // The command shell is a per-OS fact: /bin/sh -c on the POSIX family,
  // cmd.exe /d /s /c on Windows.
  const argv = getSystem().commandShell(options.command, process.env);
  if (mode === "danger-full-access") {
    const result = await executeGraphWorkerCommand({ argv, workspace: options.workspace,
      signal: options.signal, timeoutMs: options.timeoutMs });
    return { ...result, cwd: options.workspace, mode, enforcement: "unconfined", denialSignatures: [] };
  }
  if (!sandbox) {
    throw new Error(`Graph worker commands require the host's confinement service (@deepseek-ai/dsh-sandbox) for a ${mode} session; refusing to run the command unconfined.`);
  }
  if (typeof resolved.workspaceRoot !== "string" || resolved.workspaceRoot.length === 0) {
    throw new Error(`The host sandbox policy service resolved a ${mode} session without a workspace root; refusing to run the command.`);
  }
  let confined: Awaited<ReturnType<DshSandboxService["confine"]>>;
  try {
    confined = await sandbox.confine(argv, { mode, workspaceRoot: resolved.workspaceRoot,
      ...(resolved.sessionId === undefined ? {} : { sessionId: resolved.sessionId }) }, options.signal);
  } catch (error) {
    throw new Error(`The host confinement service failed to confine a ${mode} command: ${message(error)}`);
  }
  if (!Array.isArray(confined?.argv) || confined.argv.length === 0 ||
      confined.argv.some(part => typeof part !== "string" || part.length === 0)) {
    throw new Error(`The host confinement service returned no usable spawn argv for a ${mode} command; refusing to run it.`);
  }
  if (confined.enforcement !== "full" && confined.enforcement !== "partial") {
    throw new Error("The host confinement service reported an unknown enforcement level; refusing to run the command.");
  }
  const result = await executeGraphWorkerCommand({ argv: confined.argv, workspace: options.workspace,
    signal: options.signal, timeoutMs: options.timeoutMs });
  return { ...result, cwd: options.workspace, mode, enforcement: confined.enforcement,
    denialSignatures: confined.enforcement === "partial" && Array.isArray(confined.denialSignatures)
      ? [...confined.denialSignatures] : [] };
}

/** The graph runtime a worker session's tools are bound to. */
export interface DshGraphWorkerRuntime {
  host: OutcomeHost;
  workspace: string;
  storeRoot: string;
  /** The host's confinement seam, when this host exposes it. */
  sandbox?: DshSandboxService;
  /** The host's policy resolver, when this host exposes it. */
  sandboxPolicy?: DshSandboxPolicyService;
  /** The live session a command runs for: the resolver reads its `sandbox/mode` events. */
  sessionOf?(sessionId: string): unknown;
}

/** The host's tool registry authenticates the caller; each command runs under the host's resolved session policy. */
export function createDshGraphWorkerTools(resolve: (context: CanonicalToolContext) => DshGraphWorkerRuntime): Record<string, CanonicalToolDef> {
  // The shell and the disposable variable names are derived from the detected
  // system descriptor, so this description cannot drift from what the runner
  // actually applies.
  const system = getSystem();
  return {
    graph_worker_exec: {
      description: `Run a shell command in this graph worker's workspace sandbox. Use this for reading, editing, builds, tests and browser automation. The host applies this session's resolved sandbox policy to every command and rolebox adds no boundary of its own: a 'read-only' or 'workspace-write' session is confined by the host's confinement service, while a 'danger-full-access' session runs commands unconfined because rolebox never narrows the authorized mode. Each result reports the effective mode, the enforcement ('full', 'partial' or 'unconfined') and, when enforcement is 'partial', the denial signatures the backend produced, so a boundary denial is distinguishable from a command failure. ${disposableEnvironmentHint(system)} are disposable per-command directories without credentials, so a command needing real credentials or host state cannot succeed. ${system.shellHint} Installed applications and Playwright/Puppeteer browser caches stay discoverable, subject to the host policy. Where a confinement is in effect, macOS cannot nest Chromium's own sandbox inside it: use Playwright's default chromiumSandbox: false or Puppeteer args: ['--no-sandbox'].`,
      args: { command: z.string(), timeout_ms: z.number().int().min(1).max(300_000).optional() },
      async execute(args, context) {
        const { host, workspace, sandbox, sandboxPolicy, sessionOf } = resolve(context);
        const worker = host.workerPrincipalOf(context?.sessionID ?? "");
        if (!worker) throw new Error("This tool requires a confirmed graph worker session");
        const result = await executeDshWorkerCommand({ command: args.command as string, workspace,
          sandbox, sandboxPolicy, session: sessionOf?.(context?.sessionID ?? ""),
          signal: context?.abort, timeoutMs: args.timeout_ms as number | undefined });
        return JSON.stringify(result);
      },
    },
  };
}

export interface DshWorkerAgent {
  readonly id?: string;
  readonly session?: DshEventSource & { readonly id?: string };
  readonly ctx?: { readonly tools?: {
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
  createExecutor?: DshWorkerExecutorFactory) {
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
    if (!agent) return { declaredTools: [] };
    const principal: OutcomeWorkerPrincipal | undefined = host.workerPrincipalOf(agent.session?.id ?? agent.id ?? "");
    if (!principal) return prepared.get(agent)?.startup ?? { declaredTools: [] };
    try {
      if (host.workerToolGrantOf) return host.workerToolGrantOf(principal);
      if (!host.workerDeclaredToolsOf) return { declaredTools: [] };
      const declared = host.workerDeclaredToolsOf(principal);
      return {
        declaredTools: declared === undefined ? undefined : Array.isArray(declared) &&
          declared.every(name => typeof name === "string" && name.length > 0) ? declared : [],
        toolPresentation: host.workerToolPresentationOf?.(principal),
      };
    } catch { return { declaredTools: [] }; }
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
    ? "Graph workers may only use inherited authorized task tools within the node's tools restriction, plus their worker entry points" : undefined);
  if (guard) disposers.push(guard);
  const catalogOf = (agent: DshWorkerAgent): readonly DshWorkerToolSchema[] | undefined => {
    if (!tools.schemas) return undefined;
    try { return tools.schemas(agent); }
    catch (error) { throw new Error(`Worker tool catalog is unavailable: ${message(error)}`); }
  };
  const checkAvailability = (agent: DshWorkerAgent, grant: DshWorkerStartupTools): string[] => {
    const catalog = catalogOf(agent);
    if (!catalog) return [];
    const names = new Set(catalog.map(tool => tool.name));
    const exact = [...(grant.declaredTools ?? []).filter(name => !name.endsWith("*")), ...(grant.toolPresentation?.preload ?? [])];
    const missing = [...new Set(exact.filter(name => !names.has(name)))];
    if (missing.length) throw new Error(`Worker tool grant names unavailable host tools: ${missing.join(", ")}`);
    const deniedPreloads = (grant.toolPresentation?.preload ?? []).filter(name =>
      !workerTaskToolAllowed(name, grant.declaredTools, grant.inheritedTools));
    if (deniedPreloads.length) throw new Error(`Worker preload is outside inherited authorization: ${deniedPreloads.join(", ")}`);
    return (grant.declaredTools ?? []).filter(pattern => pattern.endsWith("*") &&
      !catalog.some(tool => declaredToolsAllow(tool.name, [pattern])));
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
    const unmatched = agent ? checkAvailability(agent, grant) : [];
    return { ...assembly,
      ...(unmatched.length ? { contexts: [...(assembly.contexts ?? []), {
        name: "rolebox:worker-tool-availability",
        text: `No currently available host tool matches these granted prefixes: ${unmatched.join(", ")}. Search the catalog again if a provider becomes available; these grants do not create tools.`,
      }] } : {}),
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
