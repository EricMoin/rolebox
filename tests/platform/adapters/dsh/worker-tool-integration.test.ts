import { describe, expect, it } from "vitest";
import {
  DSH_GRAPH_WORKER_TOOLS, installDshGraphWorkerBoundary,
  type DshGraphWorkerRegistry, type DshWorkerAgent, type DshWorkerStartupTools,
} from "../../../../src/platform/adapters/dsh/graph-worker.ts";
import type { DshToolDefinition, DshToolRunContext } from "../../../../src/platform/adapters/dsh/tool-factory.ts";
import type { DshWorkerToolExecutor } from "../../../../src/platform/adapters/dsh/worker-executor.ts";

function createFixture(startup: DshWorkerStartupTools, executorMode: boolean) {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const definitions = new Map<string, DshToolDefinition>();
  const local = new Map<string, DshToolDefinition>();
  const hidden = new Set<string>();
  const denied = new Set<string>();
  const executions: Parameters<NonNullable<DshGraphWorkerRegistry["execute"]>>[0][] = [];
  let guard: Parameters<NonNullable<DshGraphWorkerRegistry["guard"]>>[0] = () => undefined;
  let confirmed = false;
  let grantReads = 0;
  let grantUnavailable = false;
  let scopedExecutor: DshWorkerToolExecutor | undefined;
  const toolSet = {};
  const principal = { graphId: "graph", attemptId: "attempt", executionId: "worker", workerSessionId: "worker" };
  const rich = { isError: false, value: { count: 2 }, content: [
    { type: "text", text: "Two matches" },
    { type: "image", attachment: { id: "image-1", mediaType: "image/png" } },
    { type: "resource", resource: { uri: "fixture://document", text: "Matches" } },
  ] };
  const register = (name: string) => definitions.set(name, {
    name, description: `Fixture ${name}`, parameters: { type: "object", properties: {} },
    output: { schema: {}, render: () => [] }, execute: async () => rich,
  });
  for (const name of [...DSH_GRAPH_WORKER_TOOLS, "graph_control", "custom_search", "mcp_docs_lookup", "private_lookup"]) register(name);
  const agent: DshWorkerAgent = { id: "worker", session: { id: "worker", events: [] }, ctx: { tools: {
    ...(executorMode ? { setExecutor: (executor: DshWorkerToolExecutor) => {
      scopedExecutor = executor;
      return () => { scopedExecutor = undefined; };
    } } : { presentAs: () => () => {} }),
    register: definition => { local.set(definition.name, definition); return () => { local.delete(definition.name); }; },
  } } };
  const registry: DshGraphWorkerRegistry = {
    guard: callback => { guard = callback; return () => {}; },
    schemas: () => [...definitions.values(), ...local.values()].filter(tool => !hidden.has(tool.name)),
    get: name => hidden.has(name) ? undefined : definitions.get(name) ?? local.get(name),
    execute: async execution => {
      executions.push(execution);
      const denial = guard(execution);
      if (denial) return { isError: true, error: { message: denial }, content: [{ type: "text", text: denial }] };
      execution.signal.throwIfAborted();
      if (denied.has(execution.name)) return { isError: true, error: { message: "Host approval denied", info: { code: "DENIED", name: "PolicyError" } },
        content: [{ type: "text", text: "Host approval denied" }] };
      return rich;
    },
  };
  const boundary = installDshGraphWorkerBoundary({
    workerPrincipalOf: id => confirmed && id === "worker" ? principal : undefined,
    workerDeclaredToolsOf: () => startup.declaredTools,
    workerToolPresentationOf: () => startup.toolPresentation,
    workerToolGrantOf: () => {
      grantReads++;
      if (grantUnavailable) throw new Error("worker grant unavailable");
      return startup;
    },
  }, registry, (event, listener) => { listeners.set(event, listener); return () => { listeners.delete(event); }; },
  executorMode ? () => ({ executor: { describe: tools => ({ schemas: tools }), execute: async () => undefined },
    invoke: execution => registry.execute!(execution) }) : undefined);
  const start = async () => {
    await boundary.start("attempt", async () => { await listeners.get("agent/created")!({ agent }); }, startup);
  };
  const startAfterScope = async () => {
    await boundary.start("attempt", async () => {}, startup);
    (agent.session!.events as Array<{ type: string; data: unknown }>).push({ type: "subagent/descriptor", data: { label: "attempt" } });
    await listeners.get("agent/created")!({ agent });
  };
  const assemble = async () => {
    const assembly = { ...(!executorMode ? { tools: registry.schemas!(agent) } : {}), sections: [], contexts: [], variables: {} };
    const result = await listeners.get("system-prompt/assemble")!(assembly, { scope: agent }, async () => assembly) as typeof assembly;
    return result;
  };
  const visible = async () => {
    const assembly = await assemble();
    const tools = executorMode
      ? scopedExecutor!.describe([...definitions.values(), ...local.values()].filter(tool => !hidden.has(tool.name))).schemas
      : assembly.tools!;
    return tools.map(tool => tool.name);
  };
  const call = (name: string, args: Record<string, unknown>, signal = new AbortController().signal) => {
    const execution: DshToolRunContext & { token: object } = {
      agent, callId: "call-1", rootCallId: "root-1", token: {}, toolSet, signal,
      deferContext: () => {}, concludeTurn: () => {},
    };
    return local.get(name)!.execute(args, execution);
  };
  return { start, startAfterScope, visible, assemble, registry, call, boundary, local, rich, executions, agent, register, hidden, denied, toolSet,
    confirm: () => { confirmed = true; }, guard: (name: string) => guard({ name, agent }),
    grantReads: () => grantReads, failGrant: () => { grantUnavailable = true; } };
}

describe.each(["presentation switch", "scoped executor"])("dsh worker capability integration with %s", mode => {
  const fixture = (startup: DshWorkerStartupTools) => createFixture(startup, mode === "scoped executor");
  it("uses native command and rolebox tools without discovery despite legacy empty lists", async () => {
    const inheritedTools = ["bash", "hashline_read", "hashline_edit", "load_role_skill", "load_reference",
      "reference_search", "memory_recall", "memory_write", "browse_open", "computer_screenshot"];
    const f = fixture({ declaredTools: [], inheritedTools });
    for (const name of inheritedTools) f.register(name);
    try {
      await f.start();
      expect(await f.visible()).toEqual([...DSH_GRAPH_WORKER_TOOLS, ...inheritedTools]);
      expect(f.local.has("graph_worker_tools")).toBe(false);
      for (const name of inheritedTools) {
        const result = await f.registry.execute!({ name, arguments: {}, agent: f.agent, callId: name,
          signal: new AbortController().signal });
        expect(result).toBe(f.rich);
      }
      expect(f.executions.map(execution => execution.name)).toEqual(inheritedTools);
      for (const name of ["graph_declare", "dispatch", "task", "team_create", "loop_start"]) {
        expect(f.guard(name)).toContain("Graph workers may only");
      }
      expect(f.guard("graph_control")).toContain("Graph workers may only");
    } finally { f.boundary.dispose(); }
  });

  it.each(["discover", "code"] as const)("inherits parent capabilities through %s without expanding schemas", async presentation => {
    const f = fixture({ inheritedTools: ["custom_search", "mcp_docs_lookup"], toolPresentation: { mode: presentation } });
    try {
      await f.start();
      expect(await f.visible()).not.toContain("custom_search");
      const list = await f.call("graph_worker_tools", { action: "list" });
      expect(JSON.stringify(list)).toContain("custom_search");
      expect(JSON.stringify(list)).not.toContain("private_lookup");
      if (presentation === "discover") {
        await f.call("graph_worker_tools", { action: "describe", name: "custom_search" });
        expect(await f.visible()).toContain("custom_search");
      } else {
        expect(JSON.stringify(await f.call("graph_worker_code", { source: 'return await tools.call("custom_search", {})' })))
          .toContain("Two matches");
        expect(await f.visible()).not.toContain("custom_search");
      }
      expect(f.guard("private_lookup")).toContain("Graph workers may only");
      expect(f.guard("dispatch")).toContain("Graph workers may only");
    } finally { f.boundary.dispose(); }
  });
  it("recovers startup grants from the descriptor when publication leaves the async start scope", async () => {
    const f = fixture({ agent: "worker-role", declaredTools: ["custom_*"], toolPresentation: { mode: "discover" } });
    try {
      await f.startAfterScope();
      expect(f.boundary.roleOf(f.agent)).toBe("worker-role");
      expect(await f.visible()).toEqual([...DSH_GRAPH_WORKER_TOOLS, "graph_worker_tools"]);
      expect(f.guard("custom_search")).toBeUndefined();
    } finally { f.boundary.dispose(); }
  });
  it("reads one coherent grant for the entire catalog and rechecks it for each invocation", async () => {
    const startup = { declaredTools: ["custom_*"], inheritedTools: ["custom_search", ...Array.from({ length: 100 }, (_, i) => "custom_" + i)] };
    const f = fixture(startup);
    try {
      await f.start();
      f.confirm();
      for (let i = 0; i < 100; i++) f.register("custom_" + i);
      const before = f.grantReads();
      const visible = await f.visible();
      expect(visible).toContain("custom_99");
      expect(visible).not.toContain("private_lookup");
      expect(f.grantReads() - before).toBe(mode === "scoped executor" ? 2 : 1);
      expect(f.guard("custom_search")).toBeUndefined();
      startup.declaredTools = [];
      expect(f.guard("custom_search")).toBeUndefined();
      startup.inheritedTools = [];
      expect(f.guard("custom_search")).toContain("Graph workers may only");
      expect(await f.visible()).toEqual([...DSH_GRAPH_WORKER_TOOLS]);
    } finally { f.boundary.dispose(); }
  });

  it("keeps a confirmed worker on baseline when the merged authorization read fails", async () => {
    const f = fixture({ declaredTools: ["custom_*"] });
    try {
      await f.start();
      f.confirm();
      expect(f.guard("custom_search")).toBeUndefined();
      f.failGrant();
      expect(f.guard("custom_search")).toContain("Graph workers may only");
      expect(f.guard("graph_submit_outcome")).toBeUndefined();
      expect(await f.visible()).toEqual([...DSH_GRAPH_WORKER_TOOLS]);
    } finally { f.boundary.dispose(); }
  });

  it("presents and authorizes custom and MCP tools before and after worker confirmation", async () => {
    const f = fixture({ declaredTools: ["custom_*", "mcp_docs_*"], inheritedTools: ["custom_search", "mcp_docs_lookup", "mcp_docs_recent"] });
    try {
      await f.start();
      expect(await f.visible()).toEqual([...DSH_GRAPH_WORKER_TOOLS, "custom_search", "mcp_docs_lookup"]);
      expect(f.guard("mcp_docs_lookup")).toBeUndefined();
      expect(f.guard("private_lookup")).toContain("Graph workers may only");
      expect(f.guard("graph_control")).toContain("Graph workers may only");
      f.confirm();
      expect(f.guard("custom_search")).toBeUndefined();
      f.register("mcp_docs_recent");
      expect(await f.visible()).toContain("mcp_docs_recent");
    } finally { f.boundary.dispose(); }
  });

  it("discovers only authorized capabilities and activates their native schemas", async () => {
    const f = fixture({ declaredTools: ["custom_*", "mcp_docs_*"], inheritedTools: ["custom_search", "mcp_docs_lookup"], toolPresentation: { mode: "discover", preload: ["custom_search"] } });
    try {
      await f.start();
      expect(await f.visible()).toEqual([...DSH_GRAPH_WORKER_TOOLS, "custom_search", "graph_worker_tools"]);
      const listed = await f.call("graph_worker_tools", { action: "list" });
      expect(JSON.stringify(listed)).toContain("mcp_docs_lookup");
      expect(JSON.stringify(listed)).not.toContain("private_lookup");
      await f.call("graph_worker_tools", { action: "describe", name: "mcp_docs_lookup" });
      expect(await f.visible()).toContain("mcp_docs_lookup");
      expect(JSON.stringify(await f.call("graph_worker_tools", { action: "call", name: "private_lookup", arguments: {} }))).toContain("not authorized");
      expect(f.executions).toHaveLength(0);
      const result = await f.call("graph_worker_tools", { action: "call", name: "mcp_docs_lookup", arguments: {} });
      const execution = f.executions[0]!;
      expect(execution.agent).toBe(f.agent);
      expect(execution.rootCallId).toBe("root-1");
      expect(execution.parent).toBeDefined();
      expect(execution.toolSet).toBe(f.toolSet);
      expect(f.local.get("graph_worker_tools")!.output.render({}, result)).toEqual(f.rich.content);
      f.confirm();
      expect(f.guard("graph_worker_tools")).toBeUndefined();
      expect(f.guard("graph_worker_code")).toContain("Graph workers may only");
    } finally { f.boundary.dispose(); }
  });

  it("executes code against the original worker and preserves emitted rich results", async () => {
    const f = fixture({ declaredTools: ["mcp_docs_*"], toolPresentation: { mode: "code" } });
    try {
      await f.start();
      const result = await f.call("graph_worker_code", {
        source: 'const result = await tools.call("mcp_docs_lookup", {}); emit(result); return result.value.count;',
      });
      expect(result).toMatchObject({ metadata: { nativeResult: { value: 2 } } });
      expect(f.executions).toHaveLength(1);
      expect(f.executions[0]!.agent).toBe(f.agent);
      const content = f.local.get("graph_worker_code")!.output.render({}, result);
      expect(content).toContainEqual(f.rich.content[1]);
      expect(content).toContainEqual(f.rich.content[2]);
      expect(await f.visible()).toEqual([...DSH_GRAPH_WORKER_TOOLS, "graph_worker_tools", "graph_worker_code"]);
      expect(JSON.stringify(await f.call("graph_worker_code", { source: 'return await tools.call("graph_control", {});' }))).toContain("not authorized");
      expect(f.executions).toHaveLength(1);
    } finally { f.boundary.dispose(); }
  });

  it("respects host visibility and preserves policy denial results", async () => {
    const f = fixture({ declaredTools: ["custom_*", "mcp_docs_*"], toolPresentation: { mode: "discover" } });
    try {
      f.hidden.add("custom_search");
      f.denied.add("mcp_docs_lookup");
      await f.start();
      const listed = await f.call("graph_worker_tools", { action: "list" });
      expect(JSON.stringify(listed)).not.toContain("custom_search");
      const described = await f.call("graph_worker_tools", { action: "describe", name: "mcp_docs_lookup" });
      expect(described).toHaveProperty("metadata.nativeResult.outputSchema");
      const result = await f.call("graph_worker_tools", { action: "call", name: "mcp_docs_lookup", arguments: {} });
      expect(result).toMatchObject({ metadata: { nativeResult: { isError: true, error: { info: { code: "DENIED" } } } } });
      expect(f.local.get("graph_worker_tools")!.output.render({}, result)).toEqual([{ type: "text", text: "Host approval denied" }]);
      expect(f.executions).toHaveLength(1);
    } finally { f.boundary.dispose(); }
  });

  it("preserves rich native error flags without failing code that handles an emitted error", async () => {
    const f = fixture({ declaredTools: ["mcp_docs_*"], toolPresentation: { mode: "code" } });
    try {
      await f.start();
      for (const native of [{ ...f.rich, isError: true }, { ...f.rich, metadata: { error: true } }]) {
        f.registry.execute = async () => native;
        const result = await f.call("graph_worker_tools", { action: "call", name: "mcp_docs_lookup" });
        expect(result).toMatchObject({ metadata: { error: true, nativeResult: native } });
        expect(f.local.get("graph_worker_tools")!.output.render({}, result)).toEqual(native.content);
      }
      const handled = await f.call("graph_worker_code", {
        source: 'emit(await tools.call("mcp_docs_lookup", {})); return "handled";',
      });
      expect(handled).toMatchObject({ metadata: { nativeResult: { value: "handled", emitted: [{ metadata: { error: true } }] } } });
      expect(handled).not.toHaveProperty("metadata.error");
      expect(f.local.get("graph_worker_code")!.output.render({}, handled)).toContainEqual(f.rich.content[1]);
    } finally { f.boundary.dispose(); }
  });

  it("ignores unavailable legacy node entries without availability warnings", async () => {
    const missing = fixture({ declaredTools: ["missing_lookup"] });
    try { await expect(missing.start()).resolves.toBeUndefined(); }
    finally { missing.boundary.dispose(); }
    const deferred = fixture({ declaredTools: ["future_*"] });
    try {
      await deferred.start();
      expect((await deferred.assemble()).contexts).toEqual([]);
      deferred.register("future_lookup");
      expect((await deferred.assemble()).contexts).toEqual([]);
      expect(await deferred.visible()).toContain("future_lookup");
    } finally { deferred.boundary.dispose(); }
  });

  it("fails clearly when a supported host catalog cannot be read", async () => {
    const f = fixture({ declaredTools: ["mcp_docs_*"] });
    f.registry.schemas = () => { throw new Error("provider disconnected"); };
    try { await expect(f.start()).rejects.toThrow("Worker tool catalog is unavailable: provider disconnected"); }
    finally { f.boundary.dispose(); }
  });

  it("forwards cancellation to the ordinary registry execution", async () => {
    const f = fixture({ declaredTools: ["mcp_docs_*"], toolPresentation: { mode: "discover" } });
    try {
      await f.start();
      const controller = new AbortController();
      await f.call("graph_worker_tools", { action: "call", name: "mcp_docs_lookup", arguments: {} }, controller.signal);
      controller.abort();
      expect(f.executions[0]!.signal.aborted).toBe(true);
      await expect(f.call("graph_worker_tools", { action: "call", name: "mcp_docs_lookup", arguments: {} }, controller.signal)).rejects.toThrow();
      expect(f.executions).toHaveLength(1);
    } finally { f.boundary.dispose(); }
  });
});
