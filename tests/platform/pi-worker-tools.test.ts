import { afterEach, describe, expect, it } from "vitest";
import { registerPiGraphWorker } from "../../src/platform/adapters/pi/graph-worker.ts";
import { piWorkerToolConfig, validatePiWorkerTools } from "../../src/platform/adapters/pi/worker-tools.ts";

const keys = ["ROLEBOX_GRAPH_WORKER_ENDPOINT", "ROLEBOX_GRAPH_WORKER_TOKEN", "ROLEBOX_GRAPH_WORKER_ROUTE", "ROLEBOX_GRAPH_WORKER_TOOLS"];
const original = new Map(keys.map(key => [key, process.env[key]]));
afterEach(() => { for (const [key, value] of original) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

function setup(mode: "native" | "discover" | "code") {
  const tools = new Map<string, any>(["bash", "mcp_lookup", "unrelated", "graph_status"].map(name => [name, { name, description: name, parameters: { type: "object" } }]));
  const hooks = new Map<string, (...args: any[]) => any>();
  let active: string[] = [];
  let shutdown = false;
  process.env.ROLEBOX_GRAPH_WORKER_ENDPOINT = "http://127.0.0.1:9/invoke";
  process.env.ROLEBOX_GRAPH_WORKER_TOKEN = "fixture-token";
  delete process.env.ROLEBOX_GRAPH_WORKER_ROUTE;
  process.env.ROLEBOX_GRAPH_WORKER_TOOLS = JSON.stringify({ ...piWorkerToolConfig(["bash", "unrelated"], ["mcp_*"], { mode: "native" }, {}), presentation: { mode } });
  registerPiGraphWorker({
    registerTool(tool: any) { tools.set(tool.name, tool); },
    getAllTools: () => [...tools.values()],
    setActiveTools(names) { active = names; },
    on(event, handler) { hooks.set(event, handler); },
  });
  const start = () => hooks.get("session_start")!({}, { shutdown() { shutdown = true; } });
  return { tools, hooks, start, active: () => active, shutdown: () => shutdown };
}

describe("Pi graph tool presentation", () => {
  it("uses the child's loaded custom/MCP catalog and limits native calls to the node grant", () => {
    const fixture = setup("native");
    fixture.start();
    expect(fixture.active().sort()).toEqual(["bash", "graph_submit_outcome", "mcp_lookup"]);
    expect(fixture.hooks.get("tool_call")!({ toolName: "unrelated" })).toMatchObject({ block: true });
    expect(fixture.hooks.get("tool_call")!({ toolName: "graph_status" })).toMatchObject({ block: true });
    expect(fixture.hooks.get("tool_call")!({ toolName: "mcp_lookup" })).toBeUndefined();
  });

  it("describes and activates the actual native external tool without widening other grants", async () => {
    const fixture = setup("discover");
    fixture.start();
    expect(fixture.active()).not.toContain("mcp_lookup");
    const result = await fixture.tools.get("graph_worker_tools").execute("call", { action: "describe", name: "mcp_lookup" }, new AbortController().signal, () => {}, { sessionID: "worker" });
    expect(result.content[0].text).toContain("mcp_lookup");
    expect(fixture.active()).toContain("mcp_lookup");
    expect(fixture.active()).not.toContain("unrelated");
  });

  it("stops before an agent turn when code requests an external tool without an invocation API", () => {
    const fixture = setup("code");
    expect(fixture.start).toThrow("Pi code presentation is unsupported");
    expect(fixture.shutdown()).toBe(true);
    expect(fixture.active()).toEqual([]);
    expect(fixture.hooks.get("tool_call")!({ toolName: "bash" })).toMatchObject({ block: true });
  });

  it("rejects grants that exist only in the parent's catalog", () => {
    const config = piWorkerToolConfig(["bash"], ["mcp_missing"], { mode: "native" }, {});
    expect(() => validatePiWorkerTools(config, [{ name: "bash" }])).toThrow("matches no loaded tool");
  });

  it("cannot bypass a native extension denial through the discovery call action", async () => {
    const { ExtensionRunner } = await import("@earendil-works/pi-coding-agent");
    const fixture = setup("discover"); fixture.start();
    let executed = 0;
    fixture.tools.get("mcp_lookup").execute = async () => { executed++; return "never"; };
    // Exercise the installed SDK's actual blocking dispatcher with a fixture context.
    const runner = Object.create(ExtensionRunner.prototype) as InstanceType<typeof ExtensionRunner>;
    Object.assign(runner, { createContext: () => ({}), extensions: [{ handlers: new Map([["tool_call", [
      (event: { toolName: string }) => event.toolName === "mcp_lookup" ? { block: true, reason: "Extension denied lookup" } : undefined,
    ]]]) }] });
    const native = await runner.emitToolCall({ type: "tool_call", toolName: "mcp_lookup", toolCallId: "native", input: {} });
    expect(native).toMatchObject({ block: true, reason: "Extension denied lookup" });
    const capability = fixture.tools.get("graph_worker_tools");
    const bypass = await capability.execute("broker", { action: "call", name: "mcp_lookup", arguments: {} }, new AbortController().signal, () => {}, { sessionID: "worker" });
    expect(JSON.stringify(bypass)).toContain("complete host tool_call hooks");
    expect(executed).toBe(0);
  });
});
