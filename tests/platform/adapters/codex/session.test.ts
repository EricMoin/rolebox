import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { z } from "zod";
import type { CanonicalToolContext, CanonicalToolDef } from "../../../../src/platform/types.ts";
import { defineTool } from "../../../../src/platform/ports/tool-factory.ts";
import type { ResolvedRole, ResolvedSubAgent } from "../../../../src/types.ts";
import {
  type CodexLaunchAuthority,
  type CodexRecord,
  type CodexRpc,
} from "../../../../src/platform/adapters/codex/app-server/app-server.ts";
import { CodexSessionAdapter } from "../../../../src/platform/adapters/codex/session.ts";

const WORKSPACE = resolve("/path/to/project");
const OTHER_WORKSPACE = resolve("/path/to/other-project");
const adapters: CodexSessionAdapter[] = [];

class MemoryRpc implements CodexRpc {
  readonly calls: Array<{ method: string; params: CodexRecord }> = [];
  readonly responses = new Map<string, (params: CodexRecord) => CodexRecord | Promise<CodexRecord>>();
  readonly listeners = new Set<(method: string, params: CodexRecord) => void>();
  handler?: (method: string, params: CodexRecord) => Promise<unknown>;
  closeCount = 0;

  async request(method: string, params: CodexRecord = {}): Promise<CodexRecord> {
    this.calls.push({ method, params: structuredClone(params) });
    const response = this.responses.get(method);
    if (!response) throw new Error(`Unexpected fixture request: ${method}`);
    return structuredClone(await response(params));
  }

  onNotification(listener: (method: string, params: CodexRecord) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  setRequestHandler(handler: (method: string, params: CodexRecord) => Promise<unknown>): void {
    this.handler = handler;
  }

  emit(method: string, params: CodexRecord): void {
    for (const listener of this.listeners) listener(method, params);
  }

  async callback(params: CodexRecord): Promise<unknown> {
    if (!this.handler) throw new Error("No dynamic-tool callback installed");
    return this.handler("item/tool/call", params);
  }

  close(): void { this.closeCount++; }
}

function thread(id: string, extra: CodexRecord = {}): CodexRecord {
  return {
    id, cwd: WORKSPACE, preview: `${id} preview`, createdAt: 100, updatedAt: 102,
    cliVersion: "fixture-version", model: "parent-model", modelProvider: "example-provider",
    status: { type: "idle" }, ...extra,
  };
}

function roles(): ResolvedRole[] {
  const researcher: ResolvedSubAgent = {
    id: "reviewer--researcher",
    config: {
      name: "Researcher", description: "Finds evidence.", prompt: "Research the question.",
      model: "example-provider/child-model", variant: "high",
    },
    prompt: "Research the question.", skills: [], functions: [], references: [], subagents: [],
    parentId: "reviewer", inheritedFrom: {},
  };
  return [{
    id: "reviewer",
    config: { name: "Reviewer", description: "Reviews changes.", prompt: "Review with evidence.", model: "native-review-model" },
    prompt: "Review with evidence.", skills: [], functions: [], references: [], subagents: [researcher],
  }];
}

function metadata(threadId = "parent"): CodexRecord {
  return {
    threadId,
    "codex/sandbox-launcher": { codexExecutable: process.execPath },
    "codex/sandbox-state": {
      permissionProfile: { type: "workspaceWrite", writableRoots: [WORKSPACE] },
      futurePolicy: { enabled: false, allowed: ["local"] },
    },
  };
}

function fixture(configuredRoles: ResolvedRole[] = roles(), workerMcpServers: CodexRecord[] = []) {
  const threads = new Map<string, CodexRecord>([["parent", thread("parent", { agentRole: "rolebox--reviewer" })]]);
  const reader = new MemoryRpc();
  const connections: Array<{ authority: CodexLaunchAuthority; rpc: MemoryRpc }> = [];
  let created = 0;
  let turns = 0;
  function read(params: CodexRecord): CodexRecord {
    const found = threads.get(String(params.threadId));
    return found ? { thread: found } : {};
  }
  reader.responses.set("thread/read", read);
  reader.responses.set("config/read", () => ({ config: {
    mcp_servers: { rolebox: { enabled: true }, docs: { enabled: true }, disabled: { enabled: false } },
  } }));
  reader.responses.set("thread/list", () => ({ data: [...threads.values()], nextCursor: null }));
  const adapter = new CodexSessionAdapter({
    directory: WORKSPACE,
    roles: configuredRoles,
    rpcFactory(authority) {
      if (!authority) return reader;
      const rpc = new MemoryRpc();
      connections.push({ authority, rpc });
      rpc.responses.set("thread/read", read);
      rpc.responses.set("mcpServerStatus/list", () => ({ data: workerMcpServers }));
      rpc.responses.set("thread/start", params => {
        const value = thread(`worker-${++created}`, { cwd: params.cwd, model: params.model, modelProvider: params.modelProvider });
        threads.set(String(value.id), value);
        return { thread: value };
      });
      rpc.responses.set("thread/fork", params => {
        const value = thread(`fork-${++created}`, { cwd: params.cwd, forkedFromId: params.threadId });
        threads.set(String(value.id), value);
        return { thread: value };
      });
      rpc.responses.set("turn/start", () => ({ turn: { id: `turn-${++turns}`, status: "inProgress" } }));
      rpc.responses.set("turn/interrupt", () => ({}));
      rpc.responses.set("thread/compact/start", () => ({}));
      return rpc;
    },
  });
  adapters.push(adapter);
  async function create(agent = "reviewer--researcher") {
    adapter.rememberInvocation("parent", metadata());
    const session = await adapter.inSession("parent", () => adapter.create({ directory: WORKSPACE, parentID: "parent", agent }));
    if (!session) throw new Error("Fixture worker was not created");
    return { session, rpc: connections.at(-1)!.rpc };
  }
  return { adapter, reader, threads, connections, create };
}

afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.close();
  vi.restoreAllMocks();
});

function tool(execute: (context: CanonicalToolContext) => Promise<string>): CanonicalToolDef {
  return defineTool({ description: "Fixture role resource.", args: { value: z.string().optional() }, execute: async (_input, context) => execute(context) });
}

describe("Codex session discovery and history", () => {
  it("refuses to prompt a worker with an external MCP server that is not confirmed disabled", async () => {
    const { create, connections, adapter } = fixture(roles(), [{ name: "required-external", tools: {} }]);
    await expect(create()).rejects.toThrow("MCP tools could not be disabled");
    expect(connections[0].rpc.calls.some(call => call.method === "turn/start")).toBe(false);
    expect(adapter.executionState("worker-1").kind).toBe("unknown");
    const config = connections[0].rpc.calls.find(call => call.method === "thread/start")!.params.config as CodexRecord;
    expect(config).toMatchObject({ "features.hooks": false, "features.apps": false, web_search: "disabled", notify: [] });
  });

  it("accepts empty tool catalogs only for explicitly disabled MCP servers", async () => {
    const { create } = fixture(roles(), [{ runtimeStatus: "disabled", tools: {}, resources: [], resourceTemplates: [] }]);
    expect((await create()).session.id).toBe("worker-1");
  });
  it("resolves a native agentRole to the canonical role without treating an unknown native actor as a role", async () => {
    const { adapter, reader, threads } = fixture();
    expect(await adapter.resolveAgent("parent")).toBe("reviewer");
    expect(adapter.agentOf("parent")).toBe("reviewer");
    expect(reader.calls.filter(call => call.method === "thread/read")).toHaveLength(1);
    expect(await adapter.resolveAgent("parent")).toBe("reviewer");
    expect(reader.calls.filter(call => call.method === "thread/read")).toHaveLength(1);
    threads.set("external", thread("external", { agentRole: "explorer" }));
    expect(await adapter.resolveAgent("external")).toBe("");
  });

  it("rejects private or stale native role names instead of granting them role-scoped resources", async () => {
    const { adapter, threads } = fixture();
    threads.set("external-private", thread("external-private", { agentRole: "rolebox--reviewer--researcher" }));
    threads.set("external-stale", thread("external-stale", { agentRole: "rolebox--missing-role" }));
    await expect(adapter.resolveAgent("external-private")).rejects.toThrow(/native|rolebox agent/i);
    await expect(adapter.resolveAgent("external-stale")).rejects.toThrow(/native|rolebox agent/i);
    expect(adapter.agentOf("external-private")).toBe("");
  });

  it("paginates discovery and enforces directory scope even when the server returns extra rows", async () => {
    const { adapter, reader } = fixture();
    reader.responses.set("thread/list", params => params.cursor
      ? { data: [thread("two"), thread("other", { cwd: OTHER_WORKSPACE })], nextCursor: null }
      : { data: [thread("one"), null, { id: "missing-cwd" }], nextCursor: "next-page" });
    const sessions = await adapter.list(WORKSPACE);
    expect(sessions.map(session => session.id)).toEqual(["one", "two"]);
    expect(sessions[0]).toMatchObject({
      directory: WORKSPACE, title: "one preview", version: "fixture-version", time: { created: 100_000, updated: 102_000 },
    });
    expect(reader.calls.filter(call => call.method === "thread/list").map(call => call.params)).toEqual([
      { limit: 100, modelProviders: [], sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent"], cwd: WORKSPACE },
      { limit: 100, modelProviders: [], sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent"], cwd: WORKSPACE, cursor: "next-page" },
    ]);
  });

  it("hydrates paginated turns and item pages and projects user, assistant, reasoning and tool content", async () => {
    const { adapter, reader, threads } = fixture();
    threads.set("parent", thread("parent", { historyMode: "paginated" }));
    reader.responses.set("thread/turns/list", params => params.cursor ? {
      data: [{ id: "second-turn", status: "completed", itemsView: "full", items: [
        { id: "answer", type: "agentMessage", text: "Final answer." },
      ] }], nextCursor: null,
    } : {
      data: [{ id: "first-turn", status: "completed", startedAt: 101, completedAt: 102, itemsView: "summary", items: [] }], nextCursor: "turn-page",
    });
    reader.responses.set("thread/items/list", params => params.cursor ? {
      data: [
        { item: { id: "command", type: "commandExecution", command: "echo fixture", status: "completed", aggregatedOutput: "command output" } },
        { item: { id: "mcp", type: "mcpToolCall", tool: "lookup", status: "completed", result: { content: [{ type: "text", text: "MCP output" }] } } },
        { item: { id: "dynamic", type: "dynamicToolCall", tool: "asset_search", status: "completed", contentItems: [{ type: "inputText", text: "dynamic output" }] } },
        { item: { id: "unknown", type: "futureItem" } },
      ], nextCursor: null,
    } : {
      data: [
        { item: { id: "question", type: "userMessage", content: [{ type: "text", text: "Question?" }, { type: "image", imageUrl: "ignored" }] } },
        { item: { id: "reasoning", type: "reasoning", summary: ["Summary."], content: ["Reasoning detail."] } },
      ], nextCursor: "item-page",
    });

    const messages = await adapter.messages("parent");
    expect(messages.map(message => message.info.id)).toEqual(["question", "reasoning", "command", "mcp", "dynamic", "answer"]);
    expect(messages[0]).toMatchObject({ info: { role: "user", time: { created: 101_000, completed: 102_000 } }, parts: [{ type: "text", text: "Question?" }] });
    expect(messages[1].parts).toMatchObject([{ type: "reasoning", text: "Summary.\nReasoning detail." }]);
    expect(messages[2].parts).toMatchObject([{ type: "tool", tool: "shell", state: { status: "completed", input: { command: "echo fixture" }, output: "command output" } }]);
    expect(messages[3].parts).toMatchObject([{ state: { output: "MCP output" } }]);
    expect(messages[4].parts).toMatchObject([{ state: { output: "dynamic output" } }]);
    expect(messages[5]).toMatchObject({ info: { role: "assistant", model: { modelID: "parent-model", providerID: "example-provider" } }, parts: [{ type: "text", text: "Final answer." }] });
    expect(reader.calls.filter(call => call.method === "thread/items/list").map(call => call.params.cursor)).toEqual([undefined, "item-page"]);
    expect((await adapter.messages("parent", { limit: 2 })).map(message => message.info.id)).toEqual(["question", "reasoning"]);
  });

  it("returns no history or patches outside the requested workspace", async () => {
    const { adapter, reader } = fixture();
    expect(await adapter.get("parent", OTHER_WORKSPACE)).toBeNull();
    expect(await adapter.messages("parent", { directory: OTHER_WORKSPACE })).toEqual([]);
    expect(await adapter.diff("parent", { directory: OTHER_WORKSPACE })).toEqual([]);
    expect(await adapter.todo("parent", OTHER_WORKSPACE)).toEqual([]);
    expect(reader.calls.every(call => call.method === "thread/read" && call.params.includeTurns === false)).toBe(true);
  });

  it("extracts patches through the selected turn and counts changed lines without diff headers", async () => {
    const { adapter, reader } = fixture();
    const firstPatch = "--- a/src/one.ts\n+++ b/src/one.ts\n-old\n+new\n+another\n";
    reader.responses.set("thread/read", params => ({ thread: thread("parent", params.includeTurns ? { turns: [
      { id: "first", items: [{ id: "change-one", type: "fileChange", status: "completed", changes: [{ path: "src/one.ts", diff: firstPatch }] }] },
      { id: "second", items: [{ id: "change-two", type: "fileChange", changes: [{ path: "src/two.ts", diff: "+second\n" }] }] },
    ] } : {}) }));
    expect(await adapter.patches("parent", { messageID: "change-one" })).toEqual([
      { file: "src/one.ts", before: "", after: "", patch: firstPatch, additions: 2, deletions: 1 },
    ]);
    expect((await adapter.diff("parent")).map(diff => diff.file)).toEqual(["src/one.ts", "src/two.ts"]);
    await expect(adapter.patches("parent", { messageID: "missing" })).rejects.toThrow("not found");
  });

  it("reports malformed thread metadata, mismatched identities and broken pagination", async () => {
    const { adapter, reader } = fixture();
    reader.responses.set("thread/read", () => ({ thread: { id: "parent" } }));
    await expect(adapter.get("parent")).rejects.toThrow("invalid thread metadata");
    reader.responses.set("thread/read", () => ({ thread: thread("another") }));
    await expect(adapter.get("parent")).rejects.toThrow("different thread identity");
    reader.responses.set("thread/list", () => ({ data: {} }));
    await expect(adapter.list()).rejects.toThrow("invalid pagination data");
    reader.responses.set("thread/list", () => ({ data: [], nextCursor: "same" }));
    await expect(adapter.list()).rejects.toThrow("repeated pagination cursor");
  });
});

describe("Codex worker launch authority and native role mapping", () => {
  it("requires current authority from the calling thread and preserves its complete opaque policy", async () => {
    const { adapter, connections } = fixture();
    await expect(adapter.create({ directory: WORKSPACE, agent: "reviewer", parentID: "parent" })).rejects.toThrow("host-supplied");
    const meta = metadata();
    adapter.rememberInvocation("parent", meta);
    const original = structuredClone(meta["codex/sandbox-state"]);
    (meta["codex/sandbox-state"] as CodexRecord).futurePolicy = "changed later";
    await adapter.inSession("parent", () => adapter.create({ directory: WORKSPACE, agent: "reviewer" }));
    expect(JSON.parse(connections[0].authority.sandboxState)).toEqual(original);
    expect(connections[0].authority.executable).toBe(process.execPath);
    adapter.rememberInvocation("parent", { threadId: "different-thread", ...metadata("different-thread") });
    expect(() => adapter.assertLaunchable("parent")).toThrow("host-supplied");
    adapter.rememberInvocation("parent", metadata());
    adapter.rememberInvocation("parent", undefined);
    expect(() => adapter.assertLaunchable("parent")).toThrow("host-supplied");
  });

  it("uses resolved private-child instructions and matching provider model while disabling recursive and MCP execution", async () => {
    const { adapter, reader, create, connections } = fixture();
    const { session, rpc } = await create();
    expect(adapter.agentOf(session.id)).toBe("reviewer--researcher");
    expect(session.parentID).toBe("parent");
    expect(rpc.calls.find(call => call.method === "thread/start")?.params).toMatchObject({
      cwd: WORKSPACE, model: "child-model", modelProvider: "example-provider",
      developerInstructions: expect.stringContaining("Research the question."),
      config: {
        "features.plugins": false,
        "agents.enabled": false,
        "features.multi_agent": false,
        "features.multi_agent_v2": false,
        "features.request_permissions_tool": false,
        model_reasoning_effort: "high",
        mcp_servers: { rolebox: { enabled: false }, docs: { enabled: false }, disabled: { enabled: false } },
      },
    });
    expect(reader.calls).toContainEqual({ method: "config/read", params: { includeLayers: false, cwd: WORKSPACE } });
    await create("reviewer");
    expect(connections).toHaveLength(1);
    expect(rpc.calls.filter(call => call.method === "thread/start").at(-1)?.params.model).toBe("native-review-model");
  });

  it("refuses uninstalled actors and inherits parent model when a provider-qualified role cannot be mapped", async () => {
    const configured = roles();
    configured[0].config.model = "different-provider/another-model";
    const { adapter, create, connections } = fixture(configured);
    await expect(create("missing-role")).rejects.toThrow("not installed");
    await create("reviewer");
    expect(connections[0].rpc.calls.find(call => call.method === "thread/start")?.params.model).toBe("parent-model");
    expect(adapter.executionState("not-owned")).toMatchObject({ kind: "unknown" });
  });

  it("inherits the caller's effective reasoning effort unless the target role overrides it", async () => {
    const { create, threads, connections } = fixture();
    threads.get("parent")!.reasoningEffort = "ultra";
    await create("reviewer");
    await create("reviewer--researcher");
    const launches = connections[0].rpc.calls.filter(call => call.method === "thread/start");
    expect(launches[0].params.config).toMatchObject({ model_reasoning_effort: "ultra" });
    expect(launches[1].params.config).toMatchObject({ model_reasoning_effort: "high" });
  });

  it("partitions execution connections by updated caller policy", async () => {
    const { adapter, create, connections } = fixture();
    await create();
    const changed = metadata();
    (changed["codex/sandbox-state"] as CodexRecord).futurePolicy = { enabled: true };
    adapter.rememberInvocation("parent", changed);
    await adapter.inSession("parent", () => adapter.create({ directory: WORKSPACE, agent: "reviewer" }));
    expect(connections).toHaveLength(2);
    expect(connections[0].authority.key).not.toBe(connections[1].authority.key);
  });

  it("forks only at a completed turn boundary and refuses a missing, intermediate or in-progress item", async () => {
    const { adapter, reader, connections } = fixture();
    reader.responses.set("thread/read", params => ({ thread: thread("parent", params.includeTurns ? { turns: [
      { id: "finished", status: "completed", items: [
        { id: "question", type: "userMessage", content: [] },
        { id: "final-answer", type: "agentMessage", text: "Done." },
      ] },
      { id: "live", status: "inProgress", items: [{ id: "partial", type: "agentMessage", text: "Thinking." }] },
    ] } : {}) }));
    adapter.rememberInvocation("parent", metadata());
    const fork = await adapter.inSession("parent", () => adapter.fork("parent", { messageID: "final-answer" }));
    expect(fork?.parentID).toBe("parent");
    expect(connections[0].rpc.calls.find(call => call.method === "thread/fork")?.params).toMatchObject({
      threadId: "parent", cwd: WORKSPACE, excludeTurns: true, lastTurnId: "finished",
    });
    await expect(adapter.fork("parent", { messageID: "question" })).rejects.toThrow("completed turn boundaries");
    await expect(adapter.fork("parent", { messageID: "live" })).rejects.toThrow("in-progress");
    await expect(adapter.fork("parent", { messageID: "missing" })).rejects.toThrow("not found");
    expect(connections[0].rpc.calls.filter(call => call.method === "thread/fork")).toHaveLength(1);
  });
});

describe("Codex dynamic worker tools", () => {
  it("rejects callbacks and lifecycle notifications arriving through another worker's app-server", async () => {
    const { adapter, create, connections } = fixture();
    const actors: string[] = [];
    adapter.setTools({ asset_search: tool(async context => { actors.push(context.agent); return "private resource"; }) });
    const first = await create();
    await adapter.prompt(first.session.id, { parts: [{ type: "text", text: "First worker." }] });
    const changed = metadata();
    (changed["codex/sandbox-state"] as CodexRecord).futurePolicy = { isolated: true };
    adapter.rememberInvocation("parent", changed);
    const second = await adapter.inSession("parent", () => adapter.create({ directory: WORKSPACE, agent: "reviewer" }));
    const secondRpc = connections[1].rpc;
    await adapter.prompt(second!.id, { parts: [{ type: "text", text: "Second worker." }] });
    const firstCall = { threadId: first.session.id, turnId: "turn-1", callId: "call", tool: "asset_search", arguments: {} };

    expect(await secondRpc.callback(firstCall)).toMatchObject({ success: false });
    secondRpc.emit("turn/started", { threadId: first.session.id, turn: { id: "forged-turn", status: "inProgress" } });
    secondRpc.emit("turn/completed", { threadId: first.session.id, turn: { id: "turn-1", status: "completed" } });
    expect(adapter.executionState(first.session.id)).toEqual({ kind: "running" });
    expect(await first.rpc.callback(firstCall)).toMatchObject({ success: true });
    expect(actors).toEqual(["reviewer--researcher"]);

    const waiting = adapter.wait(first.session.id);
    first.rpc.emit("turn/completed", { threadId: first.session.id, turn: { id: "turn-1", status: "completed" } });
    await waiting;
    expect(adapter.executionState(first.session.id)).toEqual({ kind: "completed" });
    expect(adapter.executionState(second!.id)).toEqual({ kind: "running" });
  });

  it("advertises only outcome and scoped resource tools and attributes callbacks to the exact worker", async () => {
    const { adapter, create } = fixture();
    const contexts: CanonicalToolContext[] = [];
    const execute = async (context: CanonicalToolContext) => { contexts.push(context); return "accepted"; };
    adapter.setTools(Object.fromEntries([
      "graph_submit_outcome", "asset_search", "load_role_skill", "load_reference", "reference_search", "asset_inspect", "asset_validate",
      "graph_declare", "graph_control", "hashline_edit", "hashline_read", "interactive_terminal", "shell", "memory_write",
    ].map(name => [name, tool(execute)])));
    const { session, rpc } = await create();
    const dynamic = rpc.calls.find(call => call.method === "thread/start")!.params.dynamicTools as CodexRecord[];
    expect(dynamic.map(item => item.name).sort()).toEqual([
      "asset_inspect", "asset_search", "asset_validate", "graph_submit_outcome", "load_reference", "load_role_skill", "reference_search",
    ]);
    await adapter.prompt(session.id, { parts: [{ type: "text", text: "Find evidence." }] });
    expect(await rpc.callback({ threadId: session.id, turnId: "turn-1", callId: "call-1", tool: "asset_search", arguments: {} })).toEqual({
      success: true, contentItems: [{ type: "inputText", text: "accepted" }],
    });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      sessionID: session.id, messageID: "call-1", agent: "reviewer--researcher", directory: WORKSPACE, worktree: WORKSPACE,
    });
    await expect(contexts[0].ask({ permission: "shell", patterns: [], always: [], metadata: {} })).rejects.toThrow("Interactive approval");
    for (const invalid of [
      { threadId: "forged", turnId: "turn-1", tool: "asset_search" },
      { threadId: session.id, turnId: "wrong-turn", tool: "asset_search" },
      { threadId: session.id, turnId: "turn-1", namespace: "another-server", tool: "asset_search" },
      { threadId: session.id, turnId: "turn-1", tool: "hashline_edit" },
      { threadId: session.id, turnId: "turn-1", tool: "graph_control" },
      { threadId: session.id, turnId: "turn-1", tool: "shell" },
    ]) expect(await rpc.callback({ callId: "rejected", arguments: {}, ...invalid })).toMatchObject({ success: false });
    expect(contexts).toHaveLength(1);
  });

  it("refuses callbacks before a turn is accepted and after it has finished", async () => {
    const { adapter, create } = fixture();
    const execute = vi.fn(async () => "accepted");
    adapter.setTools({ asset_search: tool(execute) });
    const { session, rpc } = await create();
    const callback = { threadId: session.id, turnId: "turn-1", callId: "call-1", tool: "asset_search", arguments: {} };
    expect(await rpc.callback(callback)).toMatchObject({ success: false });
    await adapter.prompt(session.id, { parts: [{ type: "text", text: "Inspect resources." }] });
    expect(await rpc.callback(callback)).toMatchObject({ success: true });
    rpc.emit("turn/completed", { threadId: session.id, turn: { id: "turn-1", status: "completed" } });
    expect(await rpc.callback(callback)).toMatchObject({ success: false });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("keeps resource-tool denials out of the worker catalog and enforces the same rule at invocation", async () => {
    const configured = roles();
    configured[0].subagents[0].config.tools = { asset_search: false };
    const { adapter, create } = fixture(configured);
    const execute = vi.fn(async () => "accepted");
    adapter.setTools({ asset_search: tool(execute), load_role_skill: tool(execute), graph_submit_outcome: tool(execute) });
    const { session, rpc } = await create();
    const dynamic = rpc.calls.find(call => call.method === "thread/start")!.params.dynamicTools as CodexRecord[];
    expect(dynamic.map(item => item.name)).not.toContain("asset_search");
    await adapter.prompt(session.id, { parts: [{ type: "text", text: "Inspect resources." }] });
    expect(await rpc.callback({ threadId: session.id, turnId: "turn-1", callId: "call", tool: "asset_search", arguments: {} })).toMatchObject({ success: false });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("Codex managed execution lifecycle", () => {
  it("retains completion when started/completed notifications arrive before turn/start is acknowledged", async () => {
    const { adapter, create } = fixture();
    const { session, rpc } = await create();
    rpc.responses.set("turn/start", () => {
      rpc.emit("turn/started", { threadId: session.id, turn: { id: "fast-turn", status: "inProgress" } });
      rpc.emit("turn/completed", { threadId: session.id, turn: { id: "fast-turn", status: "completed" } });
      return { turn: { id: "fast-turn", status: "completed" } };
    });
    expect(await adapter.prompt(session.id, { parts: [{ type: "text", text: "Fast work." }] })).toEqual({ id: "fast-turn" });
    expect(adapter.executionState(session.id)).toEqual({ kind: "completed" });
    await adapter.wait(session.id);
  });

  it("returns the final assistant response from synchronous execution and releases its abort listener", async () => {
    const { adapter, create, threads } = fixture();
    const { session, rpc } = await create();
    const accepted = Promise.withResolvers<void>();
    rpc.responses.set("turn/start", () => {
      rpc.emit("turn/started", { threadId: session.id, turn: { id: "sync-turn", status: "inProgress" } });
      accepted.resolve();
      return { turn: { id: "sync-turn", status: "inProgress" } };
    });
    threads.get(session.id)!.turns = [{ id: "sync-turn", status: "completed", items: [
      { id: "question", type: "userMessage", content: [{ type: "text", text: "Question." }] },
      { id: "answer", type: "agentMessage", text: "Verified answer." },
    ] }];
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = adapter.promptSync(session.id, { parts: [{ type: "text", text: "Question." }], signal: controller.signal });
    await accepted.promise;
    rpc.emit("turn/completed", { threadId: session.id, turn: { id: "sync-turn", status: "completed" } });
    expect(await result).toEqual({ parts: [{ type: "text", text: "Verified answer." }] });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("rejects missing turn acknowledgements without inventing a running execution", async () => {
    const { adapter, create } = fixture();
    const { session, rpc } = await create();
    rpc.responses.set("turn/start", () => ({ turn: { status: "inProgress" } }));
    await expect(adapter.prompt(session.id, { parts: [{ type: "text", text: "Work." }] })).rejects.toThrow("acknowledge a turn ID");
    expect(adapter.executionState(session.id).kind).toBe("unknown");
  });

  it.each(["completed", "interrupted", "failed"])("settles a watcher from the matching %s turn notification", async status => {
    const { adapter, create } = fixture();
    const { session, rpc } = await create();
    expect(adapter.executionState(session.id).kind).toBe("unknown");
    expect(await adapter.prompt(session.id, { parts: [{ type: "text", text: "Work." }] })).toEqual({ id: "turn-1" });
    expect(adapter.executionState(session.id)).toEqual({ kind: "running" });
    let settled = false;
    const waiting = adapter.wait(session.id).then(() => { settled = true; });
    rpc.emit("turn/completed", { threadId: session.id, turn: { id: "another-turn", status: "completed" } });
    await Promise.resolve();
    expect(settled).toBe(false);
    rpc.emit("turn/completed", { threadId: session.id, turn: { id: "turn-1", status } });
    await waiting;
    expect(adapter.executionState(session.id)).toMatchObject({ kind: status === "completed" ? "completed" : "failed" });
    if (status !== "completed") expect(adapter.executionState(session.id).reason).toContain(status);
  });

  it("does not turn an interrupt acknowledgement into successful completion", async () => {
    const { adapter, create } = fixture();
    const { session, rpc } = await create();
    await adapter.prompt(session.id, { parts: [{ type: "text", text: "Work." }] });
    expect(await adapter.abort(session.id)).toBe(true);
    expect(rpc.calls).toContainEqual({ method: "turn/interrupt", params: { threadId: session.id, turnId: "turn-1" } });
    expect(adapter.executionState(session.id)).toEqual({ kind: "running" });
    rpc.emit("turn/completed", { threadId: session.id, turn: { id: "turn-1", status: "interrupted" } });
    expect(adapter.executionState(session.id)).toMatchObject({ kind: "failed", reason: expect.stringContaining("interrupted") });
    expect(await adapter.abort(session.id)).toBe(false);
  });

  it.each(["turn/started", "acknowledgment"])("queues launch cancellation until a turn ID is available through %s", async signal => {
    const { adapter, create } = fixture();
    const { session, rpc } = await create();
    const entered = Promise.withResolvers<void>();
    const acknowledged = Promise.withResolvers<CodexRecord>();
    rpc.responses.set("turn/start", () => {
      entered.resolve();
      return acknowledged.promise;
    });
    const prompt = adapter.prompt(session.id, { parts: [{ type: "text", text: "Work pending launch." }] });
    await entered.promise;

    expect(await adapter.abort(session.id)).toBe(true);
    expect(adapter.wasInterrupted(session.id)).toBe(false);
    expect(rpc.calls.filter(call => call.method === "turn/interrupt")).toEqual([]);
    if (signal === "turn/started") {
      rpc.emit("turn/started", { threadId: session.id, turn: { id: "queued-turn", status: "inProgress" } });
      expect(rpc.calls).toContainEqual({ method: "turn/interrupt", params: { threadId: session.id, turnId: "queued-turn" } });
      await Promise.resolve();
      await Promise.resolve();
    }
    acknowledged.resolve({ turn: { id: "queued-turn", status: "inProgress" } });
    await prompt;
    expect(rpc.calls.filter(call => call.method === "turn/interrupt")).toEqual([
      { method: "turn/interrupt", params: { threadId: session.id, turnId: "queued-turn" } },
    ]);
    expect(adapter.executionState(session.id)).toEqual({ kind: "running" });
    expect(adapter.wasInterrupted(session.id)).toBe(false);
    rpc.emit("turn/completed", { threadId: session.id, turn: { id: "queued-turn", status: "interrupted" } });
    expect(adapter.wasInterrupted(session.id)).toBe(true);
    expect(adapter.executionState(session.id)).toMatchObject({ kind: "failed" });
  });

  it("retains the terminal native failure reason and clears it for a new turn", async () => {
    const { adapter, create } = fixture();
    const { session, rpc } = await create();
    await adapter.prompt(session.id, { parts: [{ type: "text", text: "Work." }] });
    rpc.emit("turn/completed", { threadId: session.id, turn: {
      id: "turn-1", status: "failed", error: { message: "The model rejected the worker's tool schema" },
    } });
    expect(adapter.executionState(session.id)).toEqual({ kind: "failed", reason: "The model rejected the worker's tool schema" });
    await adapter.prompt(session.id, { parts: [{ type: "text", text: "Retry explicitly." }] });
    expect(adapter.executionState(session.id)).toEqual({ kind: "running" });
    rpc.emit("turn/completed", { threadId: session.id, turn: { id: "turn-2", status: "failed" } });
    expect(adapter.executionState(session.id)).toEqual({ kind: "failed", reason: "Codex turn failed" });
  });

  it("projects live plan updates, explicit busy status and managed parent relationships", async () => {
    const { adapter, create, threads } = fixture();
    const { session, rpc } = await create();
    threads.get(session.id)!.status = { type: "active", activeFlags: [] };
    rpc.emit("turn/plan/updated", { threadId: session.id, plan: [{ step: "Inspect source", status: "inProgress" }] });
    expect(await adapter.status(session.id)).toEqual({ type: "busy" });
    expect(await adapter.todo(session.id)).toEqual([{ id: "0", content: "Inspect source", status: "inProgress", priority: "medium" }]);
    expect((await adapter.children("parent", WORKSPACE)).map(child => child.id)).toEqual([session.id]);
  });

  it("refuses to prompt external threads or synthesize a silent prompt", async () => {
    const { adapter, create } = fixture();
    await expect(adapter.prompt("parent", { parts: [{ type: "text", text: "Wake." }] })).rejects.toThrow("only prompts Codex threads it created");
    const { session } = await create();
    await expect(adapter.prompt(session.id, { parts: [{ type: "text", text: "Note." }], noReply: true })).rejects.toThrow("no silent prompt equivalent");
    await expect(adapter.wait("parent")).rejects.toThrow("owned by another app-server");
  });

  it("settles outstanding waiters and closes each connection once when the runtime closes", async () => {
    const { adapter, reader, create } = fixture();
    const execute = vi.fn(async () => "accepted");
    adapter.setTools({ asset_search: tool(execute) });
    const { session, rpc } = await create();
    await adapter.prompt(session.id, { parts: [{ type: "text", text: "Work." }] });
    const first = adapter.wait(session.id);
    const second = adapter.wait(session.id);
    adapter.close();
    await Promise.all([first, second]);
    expect(adapter.executionState(session.id)).toMatchObject({ kind: "unknown", reason: expect.stringContaining("connection lost") });
    expect(adapter.wasInterrupted(session.id)).toBe(false);
    expect(await rpc.callback({ threadId: session.id, turnId: "turn-1", callId: "late", tool: "asset_search", arguments: {} })).toMatchObject({ success: false });
    expect(execute).not.toHaveBeenCalled();
    expect(reader.closeCount).toBe(1);
    expect(rpc.closeCount).toBe(1);
    adapter.close();
    expect(reader.closeCount).toBe(1);
    expect(rpc.closeCount).toBe(1);
    await expect(adapter.list()).rejects.toThrow("runtime closed");
  });

  it("releases watchers on a lost connection without claiming termination or affecting another connection", async () => {
    const { adapter, create, connections } = fixture();
    const execute = vi.fn(async () => "accepted");
    adapter.setTools({ asset_search: tool(execute) });
    const first = await create();
    await adapter.prompt(first.session.id, { parts: [{ type: "text", text: "First worker." }] });
    const changed = metadata();
    (changed["codex/sandbox-state"] as CodexRecord).futurePolicy = { isolated: true };
    adapter.rememberInvocation("parent", changed);
    const second = await adapter.inSession("parent", () => adapter.create({ directory: WORKSPACE, agent: "reviewer" }));
    await adapter.prompt(second!.id, { parts: [{ type: "text", text: "Second worker." }] });
    const firstWait = adapter.wait(first.session.id);
    first.rpc.emit("rolebox/connectionClosed", {});
    await firstWait;
    expect(adapter.executionState(first.session.id)).toMatchObject({ kind: "unknown", reason: expect.stringContaining("connection lost") });
    expect(adapter.wasInterrupted(first.session.id)).toBe(false);
    expect(await first.rpc.callback({ threadId: first.session.id, turnId: "turn-1", callId: "late", tool: "asset_search", arguments: {} })).toMatchObject({ success: false });
    expect(execute).not.toHaveBeenCalled();
    expect(adapter.executionState(second!.id)).toEqual({ kind: "running" });
    expect(connections).toHaveLength(2);
  });

  it.each(["completed", "interrupted", "failed"])("preserves an observed %s terminal outcome when the connection later closes", async status => {
    const { adapter, create } = fixture();
    const { session, rpc } = await create();
    await adapter.prompt(session.id, { parts: [{ type: "text", text: "Work." }] });
    rpc.emit("turn/completed", { threadId: session.id, turn: { id: "turn-1", status } });
    const before = adapter.executionState(session.id);
    rpc.emit("rolebox/connectionClosed", {});
    expect(adapter.executionState(session.id)).toEqual(before);
    adapter.close();
    expect(adapter.executionState(session.id)).toEqual(before);
    expect(adapter.wasInterrupted(session.id)).toBe(status === "interrupted");
  });

  it("retains a known completed state when the next turn/start fails before acknowledgement", async () => {
    const { adapter, create } = fixture();
    const { session, rpc } = await create();
    await adapter.prompt(session.id, { parts: [{ type: "text", text: "First turn." }] });
    rpc.emit("turn/completed", { threadId: session.id, turn: { id: "turn-1", status: "completed" } });
    rpc.responses.set("turn/start", () => { throw new Error("turn start refused"); });
    await expect(adapter.prompt(session.id, { parts: [{ type: "text", text: "Second turn." }] })).rejects.toThrow("turn start refused");
    expect(adapter.executionState(session.id)).toEqual({ kind: "completed" });
  });
});
