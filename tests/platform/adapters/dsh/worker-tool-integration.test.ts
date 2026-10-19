import { describe, expect, it } from "bun:test";
import {
  DSH_GRAPH_WORKER_TOOLS, installDshGraphWorkerBoundary,
  type DshGraphWorkerRegistry, type DshWorkerAgent, type DshWorkerStartupTools,
} from "../../../../src/platform/adapters/dsh/graph-worker.ts";
import type { DshToolDefinition, DshToolRunContext } from "../../../../src/platform/adapters/dsh/tool-factory.ts";

function fixture(startup: DshWorkerStartupTools) {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const definitions = new Map<string, DshToolDefinition>();
  const local = new Map<string, DshToolDefinition>();
  const hidden = new Set<string>();
  const denied = new Set<string>();
  const executions: Parameters<NonNullable<DshGraphWorkerRegistry["execute"]>>[0][] = [];
  let guard: Parameters<NonNullable<DshGraphWorkerRegistry["guard"]>>[0] = () => undefined;
  let confirmed = false;
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
    presentAs: () => () => {},
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
  }, registry, (event, listener) => { listeners.set(event, listener); return () => { listeners.delete(event); }; });
  const start = async () => {
    await boundary.start("attempt", async () => { await listeners.get("agent/created")!({ agent }); }, startup);
  };
  const assemble = async () => {
    const assembly = { tools: registry.schemas!(agent), sections: [], contexts: [], variables: {} };
    const result = await listeners.get("system-prompt/assemble")!(assembly, { scope: agent }, async () => assembly) as typeof assembly;
    return result;
  };
  const visible = async () => (await assemble()).tools.map(tool => tool.name);
  const call = (name: string, args: Record<string, unknown>, signal = new AbortController().signal) => {
    const execution: DshToolRunContext & { token: object } = {
      agent, callId: "call-1", rootCallId: "root-1", token: {}, signal,
      deferContext: () => {}, concludeTurn: () => {},
    };
    return local.get(name)!.execute(args, execution);
  };
  return { start, visible, assemble, registry, call, boundary, local, rich, executions, agent, register, hidden, denied,
    confirm: () => { confirmed = true; }, guard: (name: string) => guard({ name, agent }) };
}

describe("dsh worker capability integration", () => {
  it("presents and authorizes custom and MCP tools before and after worker confirmation", async () => {
    const f = fixture({ declaredTools: ["custom_*", "mcp_docs_*"] });
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
    const f = fixture({ declaredTools: ["custom_*", "mcp_docs_*"], toolPresentation: { mode: "discover", preload: ["custom_search"] } });
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

  it("rejects unavailable exact grants and reports unmatched dynamic prefixes", async () => {
    const missing = fixture({ declaredTools: ["missing_lookup"] });
    try { await expect(missing.start()).rejects.toThrow("unavailable host tools: missing_lookup"); }
    finally { missing.boundary.dispose(); }
    const deferred = fixture({ declaredTools: ["future_*"] });
    try {
      await deferred.start();
      expect(JSON.stringify((await deferred.assemble()).contexts)).toContain("future_*");
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
