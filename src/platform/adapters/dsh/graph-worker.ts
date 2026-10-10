import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import type { OutcomeHost } from "../../../graph/host/outcome-host.ts";
import {
  declaredToolsAllow,
  type OutcomeWorkerPrincipal,
} from "../../../graph/host/tool-binding.ts";
import type { CanonicalToolContext, CanonicalToolDef } from "../../types.ts";
import { executeGraphWorkerCommand } from "../../sandbox/worker-exec.ts";
import { disposableEnvironmentHint, getSystem } from "../../system/index.ts";

export const DSH_GRAPH_WORKER_TOOLS = ["graph_submit_outcome", "graph_worker_exec"];

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
    return { ...result, mode, enforcement: "unconfined", denialSignatures: [] };
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
  return { ...result, mode, enforcement: confined.enforcement,
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

interface WorkerAgent {
  readonly id?: string;
  readonly session?: { readonly id?: string; readonly events?: readonly { type: string; data?: unknown }[] };
  readonly ctx?: { readonly tools?: { presentAs(mode: "native"): () => void } };
}

export interface DshGraphWorkerRegistry {
  guard?(guard: (execution: { readonly name: string; readonly agent?: WorkerAgent }) => string | undefined): () => void;
}

/**
 * The host facts this boundary judges a worker's tool NAME by: which session is a
 * worker, and the HOST tools the executing node declared beyond the baseline.
 *
 * `workerDeclaredToolsOf` is OPTIONAL BY DESIGN. A host that cannot resolve a
 * node's declared grant (an older assembly, a store this process cannot read)
 * leaves every worker at the baseline rather than allowing a name it cannot
 * substantiate, and a host that never declares extra tools is unaffected.
 */
export type DshGraphWorkerGrantHost = Pick<OutcomeHost, "workerPrincipalOf"> &
  Partial<Pick<OutcomeHost, "workerDeclaredToolsOf">>;

/** Protect the execution pipeline too: Code Mode transports are outside toolFilter. */
export function installDshGraphWorkerBoundary(host: DshGraphWorkerGrantHost, tools: DshGraphWorkerRegistry,
  subscribe: (event: string, listener: (...args: unknown[]) => unknown) => (() => void) | void) {
  const labels = new Set<string>();
  const presentations = new WeakSet<object>();
  const workerSessions = new Set<string>();
  const starting = new AsyncLocalStorage<{ active: boolean; prompt?: string }>();
  const disposers: (() => void)[] = [];
  const isWorker = (agent?: WorkerAgent) => {
    if (!agent) return false;
    if (presentations.has(agent)) return true;
    const sessionId = agent.session?.id ?? agent.id ?? "";
    if (workerSessions.has(sessionId) || host.workerPrincipalOf(sessionId)) return true;
    return agent.session?.events?.some(event => event.type === "subagent/descriptor" && event.data !== null && typeof event.data === "object" &&
      "label" in event.data && typeof event.data.label === "string" && labels.has(event.data.label)) ?? false;
  };
  /**
   * The declared HOST tools of the node THIS agent's worker executes, or
   * `undefined`.
   *
   * Resolved through the worker PRINCIPAL the host bound the session as, exactly
   * like {@link isWorker} — never from the tool name, a caller argument or a
   * process-wide setting. FAIL CLOSED: an unbound session, a host without the
   * accessor, a throwing accessor and a value that is not an array all answer
   * `undefined`, which the predicate below reads as baseline only.
   */
  const declaredToolsOf = (agent?: WorkerAgent): readonly string[] | undefined => {
    if (!agent) return undefined;
    const sessionId = agent.session?.id ?? agent.id ?? "";
    if (sessionId.length === 0) return undefined;
    const principal: OutcomeWorkerPrincipal | undefined = host.workerPrincipalOf(sessionId);
    if (principal === undefined) return undefined;
    const lookup = host.workerDeclaredToolsOf;
    if (lookup === undefined) return undefined;
    try {
      const declared = lookup(principal);
      return Array.isArray(declared) ? declared : undefined;
    } catch {
      return undefined;
    }
  };
  /**
   * THE GRANT: the two baseline tools, or a name the executing node declared —
   * an exact name or a trailing-star prefix such as `computer_*`. The baseline
   * check runs FIRST, so a baseline call never reaches the store, and every
   * unresolved grant answers "not granted".
   */
  const grantedToWorker = (execution: { readonly name: string; readonly agent?: WorkerAgent }): boolean => {
    if (DSH_GRAPH_WORKER_TOOLS.includes(execution.name)) return true;
    return declaredToolsAllow(execution.name, declaredToolsOf(execution.agent));
  };
  const guard = tools.guard?.(execution => isWorker(execution.agent) && !grantedToWorker(execution)
    ? "Graph workers may only use their node's granted tools: the baseline graph_submit_outcome and graph_worker_exec, plus any host tools the node declares" : undefined);
  if (guard) disposers.push(guard);
  const prepare = (agent?: WorkerAgent, admitted = false) => {
    if (agent && (admitted || isWorker(agent)) && !presentations.has(agent)) {
      const scoped = agent.ctx?.tools;
      if (!scoped?.presentAs) throw new Error("Graph workers require native scoped tool presentation");
      disposers.push(scoped.presentAs("native"));
      presentations.add(agent);
      const sessionId = agent.session?.id ?? agent.id;
      if (sessionId) workerSessions.add(sessionId);
    }
  };
  // Prompt assembly precedes pre-step, and the child's descriptor is appended
  // during pre-step. The host's start scope identifies it before either occurs.
  const created = subscribe("agent/created", (...args) => {
    prepare((args[0] as { agent?: WorkerAgent }).agent, starting.getStore()?.active === true);
  });
  if (created) disposers.push(created);
  const stop = subscribe("agent/pre-step", async (...args) => {
    const decision = await (args[1] as () => Promise<unknown>)();
    prepare((args[0] as { agent?: WorkerAgent }).agent);
    return decision;
  });
  if (stop) disposers.push(stop);
  return {
    prompt() { const scope = starting.getStore(); return scope?.active ? scope.prompt : undefined; },
    isWorker,
    async start<T>(label: string, create: () => Promise<T>, prompt?: string): Promise<T> {
      if (!guard) throw new Error("This dsh host cannot enforce the graph worker execution guard");
      labels.add(label);
      const scope = { active: true, prompt };
      try { return await starting.run(scope, create); }
      finally { scope.active = false; }
    },
    prepare,
    dispose() { for (const dispose of disposers.splice(0).reverse()) dispose(); labels.clear(); workerSessions.clear(); starting.disable(); },
  };
}
