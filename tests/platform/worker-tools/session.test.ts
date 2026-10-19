import { describe, expect, test } from "bun:test";
import {
  createWorkerToolSession, createWorkerCapabilityTools, formatWorkerToolResult,
  type WorkerToolDescriptor,
} from "../../../src/platform/worker-tools/index.ts";
import type { CanonicalToolContext } from "../../../src/platform/types.ts";

const descriptor = (name: string, description = "Query documents", source = "mcp:docs"): WorkerToolDescriptor => ({
  name, description, source, inputSchema: { type: "object", properties: { query: { type: "string" } } },
});
const context = (sessionID = "worker-a"): CanonicalToolContext => ({
  sessionID, messageID: "message-a", agent: "worker", directory: "/path/to/project", worktree: "/path/to/project",
  abort: new AbortController().signal, metadata() {}, async ask() {},
});

describe("worker tool catalog", () => {
  test("filters by grant before searching and paginating without exposing schemas", async () => {
    const session = createWorkerToolSession({
      registry: { list: () => [descriptor("docs_lookup"), descriptor("docs_search"), descriptor("secret_read"), descriptor("graph_control")], async invoke() {} },
      allowedTools: ["docs_*", "graph_*"], presentation: { mode: "discover" },
    });
    const page = await session.list({ query: "documents", source: "mcp:docs", limit: 1 });
    expect(page).toEqual({ tools: [{ name: "docs_lookup", description: "Query documents", source: "mcp:docs" }], total: 2, offset: 0, nextOffset: 1 });
    expect((await session.list({ offset: page.nextOffset, limit: 1 })).tools[0].name).toBe("docs_search");
    expect(await session.list({ query: "secret" })).toEqual({ tools: [], offset: 0, total: 0 });
    await expect(session.describe("graph_control")).rejects.toThrow("not authorized");
  });

  test("always rejects graph namespace and ambiguous registered names", async () => {
    const session = createWorkerToolSession({
      registry: { list: () => [descriptor("graph_submit_outcome"), descriptor("graph_future"), descriptor("dup"), descriptor("dup")], async invoke() { throw new Error("must not call"); } },
      allowedTools: ["graph_*", "dup", "*"], presentation: { mode: "code" },
    });
    expect((await session.list()).tools).toEqual([]);
    await expect(session.call("graph_submit_outcome", {})).rejects.toThrow("not authorized");
    await expect(session.call("dup", {})).rejects.toThrow("not authorized");
  });

  test("rechecks both changing grants and registration on every invocation", async () => {
    let names = ["docs_search"];
    let registered = [descriptor("docs_search")];
    let invoked = 0;
    const rich = { content: [{ type: "image", data: "cGl4ZWxz", mimeType: "image/png" }], structuredContent: { count: 1 } };
    const session = createWorkerToolSession({
      registry: { list: () => registered, async invoke(_name, args, { signal }) { invoked++; expect(args).toEqual({ query: "one" }); expect(signal.aborted).toBe(false); return rich; } },
      allowedTools: () => names, presentation: { mode: "native" },
    });
    expect(await session.call("docs_search", { query: "one" })).toBe(rich);
    names = [];
    await expect(session.call("docs_search", {})).rejects.toThrow("not authorized");
    names = ["docs_search"];
    registered = [];
    await expect(session.call("docs_search", {})).rejects.toThrow("not authorized");
    expect(invoked).toBe(1);
  });

  test("honors grant revocation while the asynchronous registry is loading", async () => {
    let grant = ["docs_search"];
    let provideCatalog!: (tools: WorkerToolDescriptor[]) => void;
    const catalog = new Promise<WorkerToolDescriptor[]>(resolve => { provideCatalog = resolve; });
    let invoked = false;
    const session = createWorkerToolSession({
      registry: { list: () => catalog, async invoke() { invoked = true; } },
      allowedTools: () => grant, presentation: { mode: "discover" },
    });
    const call = session.call("docs_search", {});
    grant = [];
    provideCatalog([descriptor("docs_search")]);
    await expect(call).rejects.toThrow("not authorized");
    expect(invoked).toBe(false);
    expect((await session.list()).tools).toEqual([]);
  });

  test("description activates the original schema only in discovery mode", async () => {
    const activated: string[] = [];
    const tool = descriptor("docs_search");
    const session = createWorkerToolSession({
      registry: { list: () => [tool], async invoke() {} }, allowedTools: [tool.name], presentation: { mode: "discover" },
      activate: tools => { activated.push(...tools.map(tool => tool.name)); },
    });
    expect(await session.describe(tool.name)).toBe(tool);
    await session.describe(tool.name, { activate: false });
    await session.call(tool.name, {});
    expect(activated).toEqual([tool.name]);
    await expect(session.describe("unauthorized")).rejects.toThrow();
    expect(activated).toEqual([tool.name]);
  });

  test("an aborted session does not invoke host tools", async () => {
    const controller = new AbortController();
    controller.abort();
    let invoked = false;
    const session = createWorkerToolSession({ registry: { list: () => [descriptor("docs_search")], async invoke() { invoked = true; } }, allowedTools: ["docs_search"], presentation: { mode: "discover" }, signal: controller.signal });
    await expect(session.call("docs_search", {})).rejects.toThrow();
    expect(invoked).toBe(false);
  });
});

describe("canonical capability tools", () => {
  test("binds capability lookup to the calling context and refuses missing/native sessions", async () => {
    const session = createWorkerToolSession({ registry: { list: () => [descriptor("docs_search")], async invoke() { return "answer"; } }, allowedTools: ["docs_search"], presentation: { mode: "discover" } });
    const tools = createWorkerCapabilityTools({ resolveSession: context => context.sessionID === "worker-a" ? session : undefined });
    const result = await tools.graph_worker_tools.execute({ action: "call", name: "docs_search", arguments: {}, sessionID: "worker-a" }, context("worker-b"));
    expect(result).toMatchObject({ metadata: { error: true } });
    expect(await tools.graph_worker_tools.execute({ action: "call", name: "docs_search" }, context())).toMatchObject({ output: "answer", metadata: { nativeResult: "answer" } });
    expect(await tools.graph_worker_code.execute({ source: "return 1" }, context())).toMatchObject({ metadata: { error: true } });
    const native = createWorkerCapabilityTools({ resolveSession: () => createWorkerToolSession({ registry: { list: () => [], async invoke() {} }, allowedTools: [], presentation: { mode: "native" } }) });
    expect(await native.graph_worker_tools.execute({ action: "list" }, context())).toMatchObject({ metadata: { error: true } });
  });

  test("preserves MCP and native failure state in canonical metadata", () => {
    const mcpFailure = { isError: true, content: [{ type: "text", text: "Lookup failed" }] };
    const nativeFailure = { output: "Lookup failed", metadata: { error: true, code: "unavailable" } };
    expect(formatWorkerToolResult(mcpFailure)).toMatchObject({ metadata: { error: true, nativeResult: mcpFailure } });
    expect(formatWorkerToolResult(nativeFailure)).toMatchObject({ metadata: { error: true, nativeResult: nativeFailure } });
    const handled = formatWorkerToolResult({ value: { recovered: true }, emitted: [mcpFailure, nativeFailure], calls: 2 });
    expect(handled).toMatchObject({ metadata: { nativeResult: { emitted: [mcpFailure, nativeFailure] } } });
    expect(typeof handled === "string" ? undefined : handled.metadata?.error).toBeUndefined();
    const success = formatWorkerToolResult({ isError: false, metadata: { error: false }, content: [] });
    expect(typeof success === "string" ? undefined : success.metadata?.error).toBeUndefined();
  });

  test("preserves native image/resource payloads and portable media attachments", () => {
    const rich = { content: [
      { type: "image", mimeType: "image/png", data: "cGl4ZWxz" },
      { type: "audio", mimeType: "audio/wav", data: "YXVkaW8=" },
      { type: "resource", resource: { uri: "memory://report", mimeType: "application/pdf", blob: "cGRm" } },
    ], structuredContent: { records: [1, 2] }, isError: false };
    const result = formatWorkerToolResult({ value: null, emitted: [rich], calls: 1 });
    expect(result).toMatchObject({ metadata: { nativeResult: { emitted: [rich] } }, attachments: [
      { type: "file", mime: "image/png", url: "data:image/png;base64,cGl4ZWxz" },
      { type: "file", mime: "audio/wav", url: "data:audio/wav;base64,YXVkaW8=" },
      { type: "file", mime: "application/pdf", url: "data:application/pdf;base64,cGRm" },
    ] });
  });
});
