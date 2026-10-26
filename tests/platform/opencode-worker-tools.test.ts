import { describe, expect, it } from "vitest";
import { OpencodeWorkerTools } from "../../src/platform/adapters/opencode/worker-tools.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";
import type { CanonicalToolContext } from "../../src/platform/types.ts";

function request(mode: "native" | "discover" | "code", grants = ["custom_lookup"]): OutcomeDispatchRequest {
  return { graphId: "graph", planRevision: "revision", nodeId: "node", attemptId: "attempt", agent: "worker", prompt: "Task", credential: "fixture", declaredTools: grants, toolPresentation: { mode } };
}
const context: CanonicalToolContext = {
  sessionID: "worker", messageID: "message", agent: "worker", directory: "/workspace", worktree: "/workspace",
  abort: new AbortController().signal, metadata() {}, async ask() {},
};

describe("OpenCode graph tool presentation", () => {
  it("inherits the parent's context catalog and activates schemas only after discovery", async () => {
    const controller = new OpencodeWorkerTools({ host: () => undefined, nativeActivation: true, contextCatalogOnly: true,
      catalog: async () => [] });
    controller.filterContext("parent", { mcp_lookup: { description: "MCP lookup", input: {} },
      dispatch: { description: "Dispatch", input: {} } });
    const { declaredTools: _restriction, ...inherited } = request("discover");
    controller.bind("worker", { ...inherited, inheritedTools: controller.inheritedTools!("parent") });
    const fresh = () => Object.fromEntries(["bash", "graph_worker_tools", "mcp_lookup", "private_lookup", "dispatch", "rb_graph_control"]
      .map(name => [name, { description: name, input: {} }]));
    const first = fresh(); controller.filterContext("worker", first);
    expect(Object.keys(first)).toEqual(["bash", "graph_worker_tools"]);
    const described = await controller.createTools().graph_worker_tools!.execute({ action: "describe", name: "mcp_lookup" }, context);
    expect(JSON.stringify(described)).toContain("mcp_lookup");
    const next = fresh(); controller.filterContext("worker", next);
    expect(next.mcp_lookup).toBeDefined();
    expect(next.private_lookup).toBeUndefined();
    for (const name of ["private_lookup", "dispatch", "rb_graph_control"]) {
      expect(() => controller.assertAllowed("worker", name)).toThrow("not granted");
    }
  });

  it("withholds independent team execution from graph workers even with wildcard grants", () => {
    const controller = new OpencodeWorkerTools({ host: () => undefined, nativeActivation: true, catalog: async () => [] });
    const { toolPresentation: _presentation, ...legacy } = request("native", ["*"]);
    controller.bind("worker", legacy);
    for (const tool of ["team_create", "team_add", "team_send_event", "team_resume"]) {
      expect(() => controller.assertAllowed("worker", tool)).toThrow("not granted");
    }
    const catalog = { team_create: { description: "Create a team", input: {} }, bash: { description: "Shell", input: {} } };
    controller.filterContext("worker", catalog);
    expect(Object.keys(catalog)).toEqual(["bash"]);
    expect(() => controller.assertAllowed("creator", "team_create")).not.toThrow();
  });

  it("uses the complete model context catalog for MCP discovery and validates before model use", async () => {
    const controller = new OpencodeWorkerTools({ host: () => undefined, nativeActivation: true,
      contextCatalogOnly: true, catalog: async () => { throw new Error("Incomplete registry must not be used"); } });
    const req = request("discover", ["mcp_lookup"]);
    await controller.prepare(req);
    controller.bind("worker", req);
    const fresh = () => ({ bash: { description: "Shell", input: {} }, mcp_lookup: { description: "MCP", input: {} } });
    const first = fresh(); controller.filterContext("worker", first);
    expect(Object.keys(first)).toEqual(["bash"]);
    const tools = controller.createTools();
    const found = await tools.graph_worker_tools!.execute({ action: "describe", name: "mcp_lookup" }, context);
    expect(JSON.stringify(found)).toContain("mcp_lookup");
    const next = fresh(); controller.filterContext("worker", next);
    expect(next.mcp_lookup).toBeDefined();
    const removed = { bash: { description: "Shell", input: {} } };
    expect(() => controller.filterContext("worker", removed)).toThrow("matches no registered tool");
    expect(Object.keys(removed)).toEqual([]);
  });

  it("keeps v1 default MCP nodes and refuses explicit presentation without changing host permissions", async () => {
    const controller = new OpencodeWorkerTools({ host: () => undefined, nativeActivation: false,
      supportsPresentation: false, catalog: async () => { throw new Error("Incomplete catalog must not be used"); } });
    const { toolPresentation: _presentation, ...legacy } = request("native", ["external_service_lookup"]);
    await expect(controller.prepare(legacy)).resolves.toBeUndefined();
    await expect(controller.prepare(request("native"))).rejects.toThrow("independently of host permissions");
  });
  it("activates discovered native tools and keeps graph control and unrelated tools unavailable", async () => {
    const descriptor = { name: "custom_lookup", description: "Look up data", inputSchema: { type: "object" } };
    const controller = new OpencodeWorkerTools({ host: () => undefined, nativeActivation: true, catalog: async () => [descriptor] });
    const req = request("discover");
    await controller.prepare(req);
    controller.bind("worker", req);
    const fresh = () => Object.fromEntries(["bash", "graph_submit_outcome", "graph_worker_tools", "custom_lookup", "unrelated", "graph_control"].map(name => [name, { description: name, input: {} }]));
    const first = fresh(); controller.filterContext("worker", first);
    expect(Object.keys(first).sort()).toEqual(["bash", "graph_submit_outcome", "graph_worker_tools"]);
    await controller.createTools().graph_worker_tools!.execute({ action: "describe", name: "custom_lookup" }, context);
    const next = fresh(); controller.filterContext("worker", next);
    expect(next.custom_lookup).toBeDefined();
    expect(next.unrelated).toBeUndefined();
    expect(() => controller.assertAllowed("worker", "graph_control")).toThrow("not granted");
  });

  it("refuses unsupported code grants before a worker starts", async () => {
    const controller = new OpencodeWorkerTools({ host: () => undefined, nativeActivation: true,
      catalog: async () => [{ name: "mcp_lookup", description: "MCP", inputSchema: {} }] });
    await expect(controller.prepare(request("code", ["mcp_*"]))).rejects.toThrow("code presentation is unsupported");
  });

  it("never bypasses a host rejection through a capability call", async () => {
    let nativeCalls = 0;
    const nativeTool = async () => { nativeCalls++; throw new Error("Extension denied the tool"); };
    const controller = new OpencodeWorkerTools({ host: () => undefined, nativeActivation: true,
      catalog: async () => [{ name: "custom_lookup", description: "Lookup", inputSchema: {} }],
    });
    controller.bind("worker", request("discover"));
    const tools = controller.createTools();
    await tools.graph_worker_tools!.execute({ action: "describe", name: "custom_lookup" }, context);
    await expect(nativeTool()).rejects.toThrow("Extension denied");
    const bypass = await tools.graph_worker_tools!.execute({ action: "call", name: "custom_lookup", arguments: {} }, context);
    expect(JSON.stringify(bypass)).toContain("complete host permission and execution hooks");
    expect(nativeCalls).toBe(1);
  });

  it("rechecks removed tools and blocks startup when enforcement hooks failed", async () => {
    let registered = true;
    const controller = new OpencodeWorkerTools({ host: () => undefined, nativeActivation: true,
      ready: () => false,
      catalog: async () => registered ? [{ name: "custom_lookup", description: "Lookup", inputSchema: {} }] : [],
    });
    await expect(controller.prepare(request("native"))).rejects.toThrow("enforcement hooks are unavailable");
    controller.bind("worker", request("discover"));
    registered = false;
    const result = await controller.createTools().graph_worker_tools!.execute({ action: "describe", name: "custom_lookup" }, context);
    expect(JSON.stringify(result)).toContain("unavailable or not authorized");
  });

  it("does not restore canonical tools omitted from the host's context", async () => {
    const controller = new OpencodeWorkerTools({ host: () => undefined, nativeActivation: true,
      catalog: async () => [{ name: "custom_lookup", description: "Lookup", inputSchema: {} }] });
    controller.bind("worker", request("discover")); controller.filterContext("worker", {});
    const result = await controller.createTools().graph_worker_tools!.execute({ action: "describe", name: "custom_lookup" }, context);
    expect(JSON.stringify(result)).toContain("unavailable or not authorized");
  });
});

