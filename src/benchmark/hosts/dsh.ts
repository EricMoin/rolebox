import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DshPluginContext, DshPluginDisposer } from "../../entries/dsh.ts";
import { getDataDir } from "../../cli/paths.ts";
import { queryGraphs } from "../../graph/query/graph-query.ts";
import { graphStoreRoot } from "../../graph/store/schema.ts";
import { isTerminalPhase } from "../../loop/loop-store.ts";
import type { BenchmarkWorkerRequest, BenchmarkWorkerResult } from "../types.ts";

const corePackages = [
  "cordis", "dsh-session", "dsh-agent", "dsh-llm", "dsh-system-prompt",
  "dsh-tools", "dsh-subagent", "dsh-agent-loop", "dsh-skill", "dsh-tool-skill", "dsh-subagent-spawn",
  "dsh-fs-local", "dsh-working-directory", "dsh-session-projection",
] as const;

export interface DshRuntime {
  anchor: string;
  modules: Record<(typeof corePackages)[number], string>;
  version: string;
}

class DshRuntimeError extends Error {}

export function resolveDshRuntime(moduleRoot?: string): DshRuntime {
  try {
    const base = moduleRoot ? createRequire(join(resolve(moduleRoot), "package.json")) : createRequire(import.meta.url);
    const anchor = base.resolve("@deepseek-ai/dsh-agent-loop");
    const hostRequire = createRequire(anchor);
    const modules = Object.fromEntries(corePackages.map(name => {
      if (name === "dsh-subagent-spawn") {
        try { return [name, hostRequire.resolve("@deepseek-ai/dsh-subagent-spawn-in-process")]; }
        catch { return [name, hostRequire.resolve("@deepseek-ai/dsh-subagent-spawn")]; }
      }
      return [name, hostRequire.resolve(`@deepseek-ai/${name}`)];
    })) as DshRuntime["modules"];
    const packageInfo = JSON.parse(readFileSync(join(dirname(anchor), "../package.json"), "utf8")) as { version?: string };
    const version = packageInfo.version;
    if (!version || !/^\d+\.\d+\.\d+/.test(version)) throw new DshRuntimeError("The dsh runtime does not declare a valid version.");
    for (const name of corePackages.filter(name => name !== "cordis")) {
      const manifest = JSON.parse(readFileSync(join(dirname(modules[name]), "../package.json"), "utf8")) as { version?: string };
      if (manifest.version !== version) throw new DshRuntimeError("The resolved dsh packages mix incompatible release versions; configure one complete runtime.");
    }
    const declarations = readFileSync(join(dirname(modules["dsh-subagent"]), "types/index.d.ts"), "utf8");
    if (!/\bstartActivation\s*\(/.test(declarations)) {
      throw new DshRuntimeError("The dsh runtime lacks the required subagent activation API; update the complete runtime.");
    }
    return { anchor, modules, version };
  } catch (error) {
    if (error instanceof DshRuntimeError) throw error;
    throw new DshRuntimeError("A complete compatible dsh runtime could not be resolved; configure host.moduleRoot.");
  }
}

export function doctorDshRuntime(moduleRoot?: string): { available: boolean; version?: string; diagnostic?: string } {
  try {
    return { available: true, version: resolveDshRuntime(moduleRoot).version };
  } catch (error) {
    return { available: false, diagnostic: error instanceof DshRuntimeError ? error.message : "DSH runtime inspection failed." };
  }
}

interface Fiber { await(): Promise<unknown>; dispose(): void | Promise<void> }
interface Agent {
  id: string;
  status: string;
  followup(message: unknown): void;
  whenIdle(): Promise<void>;
  cancel(cause: { kind: "user" | "disposed" }): void;
}
interface Handle { agent: Agent; dispose(): Promise<void> }
interface StreamOptions {
  provider: string;
  model: string;
  sessionId?: string;
  purpose?: string;
  system?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
}
interface HostContext {
  plugin(plugin: unknown, config?: unknown): Fiber;
  on(name: "session/event", listener: (session: { id: string }, event: { type: string; data: Record<string, unknown> }) => void): () => void;
  on(name: "llm/stream", listener: (options: StreamOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>): () => void;
  agents: { create(options: unknown): Promise<Handle>; list(): Agent[] };
  llm: { listProviders(): Array<{ id: string }> };
}
interface StreamChunk { type: string; usage?: Record<string, unknown> }

class BenchmarkHostError extends Error {
  constructor(readonly status: "invalid" | "infra_error", message: string) { super(message); }
}

function resolvePluginConfig(value: unknown, allowedEnv: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map(item => resolvePluginConfig(item, allowedEnv));
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if ("$env" in object) {
    if (Object.keys(object).length !== 1 || typeof object.$env !== "string" || !allowedEnv.has(object.$env)) {
      throw new BenchmarkHostError("invalid", "Plugin environment reference must name an explicitly allowed host.env variable.");
    }
    const secret = process.env[object.$env];
    if (secret === undefined) throw new BenchmarkHostError("invalid", "An explicitly requested plugin environment variable is unavailable.");
    return secret;
  }
  return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, resolvePluginConfig(child, allowedEnv)]));
}

async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("DSH_TIMEOUT")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block: unknown) => {
    if (!block || typeof block !== "object") return [];
    const item = block as Record<string, unknown>;
    return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n");
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export async function executeDshBenchmark(request: BenchmarkWorkerRequest): Promise<BenchmarkWorkerResult> {
  const started = Date.now();
  const result: BenchmarkWorkerResult = {
    protocolVersion: 1, status: "infra_error", output: "",
    usage: { inputTokens: null, outputTokens: null, costUsd: null, source: "unavailable" },
    durationMs: 0, terminationConfirmed: false,
  };
  const fibers: Fiber[] = [];
  const listeners: Array<() => void> = [];
  let context: HostContext | undefined;
  let rolebox: DshPluginDisposer | undefined;
  let handle: Handle | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let calls = 0;
  let accountedCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let terminal: string | undefined;
  let rolePrompt = "";
  let activationProblem: string | undefined;
  const sessionId = `benchmark-${randomUUID()}`;

  try {
    const runtime = resolveDshRuntime(request.host.moduleRoot);
    const packageInfo = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string };
    result.runtime = { dshVersion: runtime.version, roleboxVersion: packageInfo.version };
    const hostRequire = createRequire(runtime.anchor);
    const modules = Object.fromEntries(await Promise.all(corePackages.map(async name => [name, await import(pathToFileURL(runtime.modules[name]).href)]))) as Record<string, Record<string, unknown>>;
    const Context = modules.cordis!.Context as new () => HostContext;
    context = new Context();
    const ctx = context;
    const mount = (plugin: unknown, config?: unknown): void => { fibers.push(ctx.plugin(plugin, config)); };
    for (const name of ["dsh-session", "dsh-agent", "dsh-llm", "dsh-system-prompt", "dsh-subagent", "dsh-skill", "dsh-session-projection"]) mount(modules[name]!.default);
    mount(modules["dsh-fs-local"]!.default, { cwd: request.workspace });
    mount(modules["dsh-working-directory"]!.default, { defaultDirectory: request.workspace });
    mount(modules["dsh-tools"]!.default, { mode: "native" });
    mount(modules["dsh-agent-loop"]!.default, { agents: [], maxParallelToolCalls: 1 });
    mount(modules["dsh-subagent-spawn"]!.default ?? modules["dsh-subagent-spawn"], { providerName: "spawn" });
    mount(modules["dsh-tool-skill"]!.default ?? modules["dsh-tool-skill"], {});
    await bounded(Promise.all(fibers.map(fiber => fiber.await())), Math.min(10_000, request.timeoutMs));

    for (const plugin of request.host.plugins) {
      const config = resolvePluginConfig(plugin.config, new Set(request.host.env));
      let modulePath: string;
      try { modulePath = hostRequire.resolve(plugin.module); }
      catch { throw new BenchmarkHostError("infra_error", "An explicitly configured dsh plugin could not be resolved."); }
      const verifySource = (): void => {
        if (plugin.sourceDigest === undefined) return;
        let digest: string;
        try { digest = createHash("sha256").update(readFileSync(modulePath, "utf8")).digest("hex"); }
        catch { throw new BenchmarkHostError("invalid", "A benchmark plugin entry could not be checked against its source snapshot."); }
        if (digest !== plugin.sourceDigest) {
          throw new BenchmarkHostError("invalid", "A benchmark plugin entry changed after its source snapshot was recorded.");
        }
      };
      verifySource();
      let imported: Record<string, unknown>;
      try { imported = await import(pathToFileURL(modulePath).href); }
      catch { throw new BenchmarkHostError("infra_error", "An explicitly configured dsh plugin could not be loaded."); }
      verifySource();
      mount(imported.default ?? imported, config);
    }
    await bounded(Promise.all(fibers.map(fiber => fiber.await())), Math.min(10_000, request.timeoutMs));
    if (!ctx.llm.listProviders().some(provider => provider.id === request.provider)) {
      throw new BenchmarkHostError("invalid", "The configured provider route has no registered dsh adapter.");
    }
    const entry = await import("../../entries/dsh.ts");
    rolebox = await entry.apply(ctx as unknown as DshPluginContext, entry.Config.parse({
      roleboxDir: request.rolesDirectory, defaultRole: request.roleId,
    }));
    const role = rolebox.stats.resolvedRoles.find(candidate => candidate.id === request.roleId);
    if (!role) throw new BenchmarkHostError("invalid", "The target role did not resolve.");
    const declaredModel = role.config.model;
    if (declaredModel && declaredModel !== request.model && declaredModel !== `${request.provider}/${request.model}`) {
      throw new BenchmarkHostError("invalid", "The role model conflicts with the benchmark's fixed provider/model condition.");
    }
    rolePrompt = role.prompt.trim();
    if (!rolePrompt) throw new BenchmarkHostError("invalid", "The target role has no resolved prompt to verify.");

    listeners.push(ctx.on("session/event", (session, event) => {
      if (session.id !== sessionId) return;
      if (event.type === "turn/end") {
        const reason = event.data.reason as { kind?: unknown } | undefined;
        terminal = typeof reason?.kind === "string" ? reason.kind : "unknown";
      }
      if (event.type === "assistant/message") {
        const message = event.data.message as { content?: unknown } | undefined;
        result.output = textContent(message?.content);
      }
    }));
    listeners.push(ctx.on("llm/stream", async function* (options, next) {
      calls++;
      if (options.sessionId === sessionId && options.purpose === undefined) {
        const prompt = [options.system ?? "", ...(options.messages ?? [])
          .filter(message => message.role === "system")
          .map(message => textContent(message.content))].filter(Boolean).join("\n");
        if (options.provider !== request.provider || options.model !== request.model) {
          activationProblem = "The actual dsh request route differs from the fixed benchmark condition.";
        } else if (!prompt.includes(rolePrompt)) {
          activationProblem = "The actual dsh system prompt does not contain the resolved active role prompt.";
        } else if (!result.activation) {
          result.activation = { roleId: request.roleId, provider: options.provider, model: options.model,
            promptDigest: createHash("sha256").update(prompt).digest("hex") };
        }
        if (activationProblem) throw new BenchmarkHostError("invalid", activationProblem);
      }
      let usage: Record<string, unknown> | undefined;
      try {
        for await (const chunk of next()) {
          if (chunk.type === "usage") usage = chunk.usage;
          yield chunk;
        }
      } finally {
        if (usage) {
          const input = count(usage.inputTokens);
          const output = count(usage.outputTokens);
          const cacheRead = usage.cacheReadTokens === undefined ? 0 : count(usage.cacheReadTokens);
          const cacheWrite = usage.cacheWriteTokens === undefined ? 0 : count(usage.cacheWriteTokens);
          if (input !== undefined && output !== undefined && cacheRead !== undefined && cacheWrite !== undefined) {
            accountedCalls++;
            inputTokens += input + cacheRead + cacheWrite;
            outputTokens += output;
          }
        }
      }
    }));
    handle = await ctx.agents.create({ sessionId, meta: { cwd: request.workspace },
      agentOptions: { provider: request.provider, model: request.model },
      setup: (scope: { tools: { presentAs(mode: string): void } }) => { scope.tools.presentAs("native"); },
    });
    const activated = await rolebox.activateRole(request.roleId, sessionId);
    if (!activated.ok || rolebox.getActiveRole(sessionId) !== request.roleId) {
      throw new BenchmarkHostError("invalid", "The target role could not be activated on the primary dsh session.");
    }
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      for (const agent of ctx.agents.list()) agent.cancel({ kind: "user" });
    }, request.timeoutMs);
    handle.agent.followup({ role: "user", source: { kind: "user" }, id: randomUUID(), content: [{ type: "text", text: request.prompt }] });
    await bounded(handle.agent.whenIdle(), request.timeoutMs + 1_000);
    let quietObservations = 0;
    let graphFailure = false;
    let unsuccessfulLoopPhases: string[] = [];
    while (!timedOut && quietObservations < 2) {
      const inventory = queryGraphs(graphStoreRoot(getDataDir(), request.workspace));
      if (inventory.blocked || inventory.refused.length > 0) {
        throw new BenchmarkHostError("infra_error", "The graph ledger could not establish the trial's terminal state.");
      }
      const graphsSettled = inventory.graphs.every(graph =>
        ["complete", "stopped"].includes(graph.phase) &&
        (graph.current?.unsettledEffects.length ?? 0) === 0);
      graphFailure = inventory.graphs.some(graph => graph.phase === "stopped");
      const loopPhases = rolebox.getLoopPhases();
      const loopsSettled = loopPhases.every(isTerminalPhase);
      unsuccessfulLoopPhases = [...new Set(loopPhases.filter(phase => isTerminalPhase(phase) && phase !== "complete"))];
      const agentsIdle = ctx.agents.list().every(agent => agent.status === "idle");
      quietObservations = graphsSettled && loopsSettled && agentsIdle ? quietObservations + 1 : 0;
      if (quietObservations < 2) await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (timedOut) {
      result.status = "task_timeout";
      result.diagnostic = "The primary session exceeded its execution deadline.";
    } else if (activationProblem || !result.activation) {
      result.status = "invalid";
      result.diagnostic = activationProblem ?? "No verified primary model request was observed.";
    } else if (unsuccessfulLoopPhases.length > 0) {
      result.status = "infra_error";
      result.diagnostic = `The native dsh loop ended in an unsuccessful terminal state (${unsuccessfulLoopPhases.join(", ")}).`;
    } else if (terminal === "completed") {
      result.status = graphFailure ? "task_failure" : "completed";
      if (graphFailure) result.diagnostic = "A graph run stopped before completing.";
    } else {
      result.status = terminal === "aborted" ? "cancelled" : ["blocked", "max-tokens"].includes(terminal ?? "") ? "task_failure" : "infra_error";
      result.diagnostic = `The primary dsh turn did not complete successfully (${terminal ?? "missing terminal event"}).`;
    }
  } catch (error) {
    result.status = timedOut ? "task_timeout" : error instanceof BenchmarkHostError ? error.status : "infra_error";
    result.diagnostic = error instanceof BenchmarkHostError || error instanceof DshRuntimeError
      ? error.message : "DSH execution failed during runtime initialization or execution.";
  } finally {
    clearTimeout(deadlineTimer);
    let teardownFailed = false;
    try { rolebox?.(); } catch { teardownFailed = true; }
    try {
      const agents = context?.agents.list() ?? [];
      for (const agent of agents) agent.cancel({ kind: "disposed" });
      await bounded(Promise.all(agents.map(agent => agent.whenIdle())), 1_500);
      if (handle) await bounded(handle.dispose(), 1_500);
    } catch { teardownFailed = true; }
    for (const fiber of fibers.reverse()) {
      try { await bounded(Promise.resolve(fiber.dispose()), 1_500); } catch { teardownFailed = true; }
    }
    for (const detach of listeners) { try { detach(); } catch { teardownFailed = true; } }
    result.terminationConfirmed = !teardownFailed;
    if (teardownFailed && result.status === "completed") {
      result.status = "infra_error";
      result.diagnostic = "DSH teardown did not confirm that all agents stopped.";
    }
    if (calls > 0 && calls === accountedCalls) {
      result.usage = { inputTokens, outputTokens, costUsd: null, source: "host" };
    }
    result.durationMs = Date.now() - started;
  }
  return result;
}
