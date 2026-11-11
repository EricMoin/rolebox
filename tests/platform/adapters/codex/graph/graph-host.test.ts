import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedRole, ResolvedSubAgent } from "../../../../../src/types.ts";
import type { CanonicalToolContext } from "../../../../../src/platform/types.ts";
import type { GraphDeclarationV3 } from "../../../../../src/graph/compiler/declaration-v3.ts";
import { graphStoreFilePath, graphStoreRoot } from "../../../../../src/graph/store/schema.ts";
import type { InputViewManifest } from "../../../../../src/graph/host/input-view.ts";
import {
  type CodexLaunchAuthority,
  type CodexRecord,
  type CodexRpc,
} from "../../../../../src/platform/adapters/codex/app-server/app-server.ts";
import { CodexGraphHost } from "../../../../../src/platform/adapters/codex/graph/graph-host.ts";
import { CodexSessionAdapter } from "../../../../../src/platform/adapters/codex/session.ts";
import { createCodexMcpServer } from "../../../../../src/platform/adapters/codex/mcp/server.ts";
import { CodexParentNotifications } from "../../../../../src/platform/adapters/codex/graph/parent-notifications.ts";

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
    if (!this.handler) throw new Error("No dynamic tool handler installed");
    return this.handler("item/tool/call", params);
  }

  close(): void { this.closeCount++; }
}

interface Prompt {
  threadId: string;
  turnId: string;
  text: string;
  rpc: MemoryRpc;
}

interface Delivery extends Prompt {
  graphId: string;
  nodeId: string;
  credential: string;
}

interface Status {
  graph_id: string;
  phase: string;
  nodes: Array<{ node_id: string; status: string; attemptId?: string; outcomeId?: string }>;
  decisions: Array<{ command: string; nodeId?: string; attemptId?: string; reason: string }>;
  unsettled_effects: Array<{ effectId: string; status: string }>;
  attempts: Array<{ attemptId: string; result?: { proposal: { data?: unknown } } }>;
}

const roots: string[] = [];
const runtimes: Array<{ host: CodexGraphHost; sessions: CodexSessionAdapter }> = [];

function role(id: string, subagents: ResolvedSubAgent[] = []): ResolvedRole {
  return {
    id,
    config: { name: id, description: `${id} role`, prompt: `Act as ${id}.` },
    prompt: `Act as ${id}.`,
    skills: [], functions: [], references: [], subagents,
  };
}

function configuredRoles(): ResolvedRole[] {
  const researcher: ResolvedSubAgent = {
    ...role("reviewer--researcher"), parentId: "reviewer", inheritedFrom: {},
    config: {
      name: "Researcher", description: "Research the requested evidence.",
      prompt: "Use the private research instructions.",
      model: "example-provider/private-worker-model", variant: "high",
    },
    prompt: "Use the private research instructions.",
  };
  const builder: ResolvedSubAgent = {
    ...role("builder--executor"), parentId: "builder", inheritedFrom: {},
  };
  return [role("reviewer", [researcher]), role("builder", [builder])];
}

function node(id: string, agent = "reviewer--researcher"): GraphDeclarationV3["nodes"][number] {
  return {
    id, agent, prompt: `Complete the ${id} task.`,
    outcomes: [
      { id: "done", data: { schema: "json-object", version: 1 }, acceptance: [{ validator: "schema", version: 1 }] },
      { id: "failed" },
    ],
    completion: { mode: "explicit" }, budget: { timeout_ms: 60_000 },
  };
}

function declaration(name = "codex.graph.single"): GraphDeclarationV3 {
  return { version: 3, name, budget: { max_executions: 8 }, nodes: [node("work")], edges: [] };
}

async function eventually<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, label: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(0);
      await new Promise(resolve => setImmediate(resolve));
    } else await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function context(sessionID: string, agent: string, directory: string): CanonicalToolContext {
  return {
    sessionID, messageID: "parent-call", agent, directory, worktree: directory,
    abort: new AbortController().signal, metadata() {}, async ask() {},
  };
}

async function fixture(options: {
  root?: string;
  threads?: Map<string, CodexRecord>;
  parentRole?: string;
  metadata?: "complete" | "identity-only" | "missing";
  start?: (params: CodexRecord) => Promise<CodexRecord>;
  turnStart?: (params: CodexRecord) => Promise<CodexRecord>;
  parentNotifications?: CodexParentNotifications;
} = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "rolebox-codex-graph-"));
  if (!options.root) roots.push(root);
  const directory = join(root, "workspace");
  mkdirSync(directory, { recursive: true });
  const dataDir = join(root, "data");
  vi.stubEnv("ROLEBOX_DATA_DIR", dataDir);
  const storeRoot = graphStoreRoot(dataDir, directory);
  const roles = configuredRoles();
  const parentRole = options.parentRole ?? "reviewer";
  const threads = options.threads ?? new Map<string, CodexRecord>();
  threads.set("parent", {
    id: "parent", cwd: directory, modelProvider: "example-provider", model: "parent-model",
    agentRole: parentRole ? `rolebox--${parentRole}` : "default", createdAt: 1, updatedAt: 1,
    status: { type: "idle" },
  });
  const reader = new MemoryRpc();
  const connections: Array<{ authority: CodexLaunchAuthority; rpc: MemoryRpc }> = [];
  const prompts: Prompt[] = [];
  let sequence = 0;
  const read = (params: CodexRecord) => ({ thread: threads.get(String(params.threadId)) });
  reader.responses.set("thread/read", read);
  reader.responses.set("config/read", () => ({ config: { mcp_servers: { rolebox: {}, docs: {} } } }));
  reader.responses.set("thread/list", () => ({ data: [...threads.values()], nextCursor: null }));
  const sessions = new CodexSessionAdapter({
    directory, roles,
    rpcFactory(authority) {
      if (!authority) return reader;
      const rpc = new MemoryRpc();
      connections.push({ authority, rpc });
      rpc.responses.set("thread/read", read);
      rpc.responses.set("mcpServerStatus/list", () => ({ data: [] }));
      rpc.responses.set("thread/start", async params => {
        if (options.start) return options.start(params);
        const thread = {
          id: `worker-${++sequence}`, cwd: directory, modelProvider: params.modelProvider,
          model: params.model, createdAt: 2, updatedAt: 2, status: { type: "idle" },
        };
        threads.set(thread.id, thread);
        return { thread };
      });
      rpc.responses.set("turn/start", async params => {
        if (options.turnStart) return options.turnStart(params);
        const threadId = String(params.threadId);
        const turnId = `turn-${threadId}`;
        const input = params.input as Array<{ text: string }>;
        prompts.push({ threadId, turnId, text: input.map(part => part.text).join("\n"), rpc });
        return { turn: { id: turnId, status: "inProgress" } };
      });
      rpc.responses.set("turn/interrupt", () => ({}));
      return rpc;
    },
  });
  if (options.metadata !== "missing") sessions.rememberInvocation("parent", {
    threadId: "parent",
    ...(options.metadata === "identity-only" ? {} : {
      "codex/sandbox-launcher": { codexExecutable: process.execPath },
      "codex/sandbox-state": { permissionProfile: { type: "workspaceWrite", writableRoots: [directory] }, futureField: { exact: true } },
    }),
  });
  await sessions.resolveAgent("parent");
  const host = new CodexGraphHost({ directory, storeRoot, roles, sessions, env: {}, parentNotifications: options.parentNotifications });
  runtimes.push({ host, sessions });
  const tools = host.createTools();
  sessions.setTools(tools);
  const parent = context("parent", sessions.agentOf("parent"), directory);
  async function call(name: string, args: CodexRecord, actor = parent): Promise<string> {
    const tool = tools[name];
    if (!tool) throw new Error(`Fixture tool not registered: ${name}`);
    const result = await sessions.inSession(actor.sessionID, () => tool.execute(args, actor));
    return typeof result === "string" ? result : result.output;
  }
  async function declare(graph: GraphDeclarationV3 = declaration()) {
    return JSON.parse(await call("graph_declare", { declaration: graph })) as {
      persisted: boolean; graph_id: string; start: { kind: string };
    };
  }
  async function delivered(index = 0): Promise<Delivery> {
    const prompt = await eventually(
      () => prompts[index],
      value => value !== undefined && sessions.executionState(value.threadId).kind === "running",
      "the worker turn acknowledgement",
    );
    const credential = /credential: (\S+)/.exec(prompt!.text)?.[1];
    const graphId = /graph_id:\s+(\S+)/.exec(prompt!.text)?.[1];
    const nodeId = /node_id:\s+(\S+)/.exec(prompt!.text)?.[1];
    if (!credential || !graphId || !nodeId) throw new Error("The fixture worker did not receive a complete attempt handoff");
    return { ...prompt!, credential, graphId, nodeId };
  }
  async function status(graphId = "codex.graph.single"): Promise<Status> {
    return JSON.parse(await call("graph_status", { graph_id: graphId, format: "json", include_output: true, include_history: true })) as Status;
  }
  function close(): void { host.close(); sessions.close(); }
  return { root, directory, storeRoot, roles, threads, reader, sessions, host, tools, parent, connections, prompts, call, declare, delivered, status, close };
}

async function dynamic(delivery: Delivery, tool: string, args: CodexRecord, identity: CodexRecord = {}) {
  const response = await delivery.rpc.callback({
    threadId: delivery.threadId, turnId: delivery.turnId, callId: "worker-call", namespace: null,
    tool, arguments: args, ...identity,
  }) as { success: boolean; contentItems: Array<{ type: string; text?: string }> };
  const text = response.contentItems.map(item => item.text ?? "").join("\n");
  let value: CodexRecord = {};
  try { value = JSON.parse(text) as CodexRecord; } catch { /* Refusals at the transport boundary are plain text. */ }
  return { success: response.success, text, value };
}

async function submit(delivery: Delivery, args: CodexRecord = {}) {
  return dynamic(delivery, "graph_submit_outcome", {
    graph_id: delivery.graphId, node_id: delivery.nodeId, outcome_id: "done",
    credential: delivery.credential, data: { summary: "Work completed." }, ...args,
  });
}

function finish(delivery: Delivery, status: "completed" | "failed" | "interrupted"): void {
  delivery.rpc.emit("turn/completed", { threadId: delivery.threadId, turn: { id: delivery.turnId, status } });
}

afterEach(async () => {
  for (const { host, sessions } of runtimes.splice(0).reverse()) { host.close(); sessions.close(); }
  await new Promise(resolve => setImmediate(resolve));
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex graph host integration", () => {
  it("reports a verified wake channel and sends graph completion through its durable notifier", async () => {
    const calls: Array<{ method: string; params: CodexRecord }> = [];
    const channel = new CodexParentNotifications({ env: { ROLEBOX_CODEX_PARENT_SOCKET: "/path/to/host.sock" },
      rpcFactory: () => ({ async request(method, params) {
        calls.push({ method, params });
        return method === "thread/loaded/list" ? { data: ["parent"] } : { turn: { id: "woken-turn" } };
      }, close() {} }) });
    const runtime = await fixture({ parentNotifications: channel });
    const declared = await runtime.declare();
    expect(declared).toMatchObject({ parent_notification: { available: true } });
    const delivery = await runtime.delivered();
    expect(calls.some(call => call.method === "turn/start")).toBe(false);
    await submit(delivery);
    await runtime.host.application.notifications!.flush();
    expect(calls.filter(call => call.method === "turn/start")).toHaveLength(1);
    expect(JSON.stringify(calls.find(call => call.method === "turn/start")?.params.toolOutput)).toContain("[GRAPH COMPLETE]");
    finish(delivery, "completed");
  });

  it("reports the wait fallback without promising an unsupported wake-up", async () => {
    const runtime = await fixture();
    expect(await runtime.declare()).toMatchObject({ parent_notification: { available: false } });
  });

  it("waits for an accepted worker outcome and returns its committed snapshot", async () => {
    const runtime = await fixture();
    await runtime.declare();
    const delivery = await runtime.delivered();
    const waiting = runtime.call("graph_wait", { graph_id: delivery.graphId });
    expect((await submit(delivery)).value.decision).toBe("accepted");
    const result = JSON.parse(await waiting);
    expect(result.status).toBe("complete");
    expect(result.graph.nodes[0].outcomeId).toBe("done");
    expect(result.graph.attempts[0].result.payload).toEqual({ kind: "value", value: { summary: "Work completed." } });
    expect(JSON.stringify(result)).not.toContain(delivery.credential);
    finish(delivery, "completed");
  });

  it("keeps graph_wait unavailable to a bound worker", async () => {
    const runtime = await fixture(); await runtime.declare();
    const delivery = await runtime.delivered();
    const result = JSON.parse(await runtime.call("graph_wait", { graph_id: delivery.graphId },
      context(delivery.threadId, "reviewer--researcher", runtime.directory)));
    expect(result.code).toBe("worker-tool-forbidden");
    expect((await dynamic(delivery, "graph_wait", { graph_id: delivery.graphId })).success).toBe(false);
  });

  it("accepts a real graph_control over MCP while graph_wait is pending", async () => {
    const runtime = await fixture(); await runtime.declare(); await runtime.delivered();
    const input = new PassThrough();
    const output = new PassThrough();
    const messages: Array<{ id: number; result: { content: Array<{ text: string }> } }> = [];
    output.on("data", chunk => {
      for (const line of String(chunk).trim().split("\n")) messages.push(JSON.parse(line));
    });
    let started = () => {};
    const waitStarted = new Promise<void>(resolve => { started = resolve; });
    const server = createCodexMcpServer({ tools: runtime.tools, input, output, serverVersion: "test",
      contextFactory(info, signal) {
        if (info.name === "graph_wait") started();
        return { ...runtime.parent, abort: signal };
      } });
    const serving = server.serve();
    try {
      input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "graph_wait", arguments: { graph_id: "codex.graph.single" },
      } }) + "\n");
      await waitStarted;
      input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "graph_control", arguments: { graph_id: "codex.graph.single", command: "cancel", reason: "Stop while waiting" },
      } }) + "\n");
      await eventually(() => messages.length, count => count === 2, "both MCP replies");
      const waited = JSON.parse(messages.find(message => message.id === 1)!.result.content[0]!.text);
      const controlled = JSON.parse(messages.find(message => message.id === 2)!.result.content[0]!.text);
      expect(controlled.kind).toBe("applied");
      expect(waited.status).toBe("stopped");
      expect(waited.graph.control.reason).toBe("Stop while waiting");
    } finally { server.close(); input.end(); await serving; }
  });

  it("starts a private role with its native model and settles a real SQLite graph through the bound callback", async () => {
    const runtime = await fixture();
    const result = await runtime.declare();
    expect(result.persisted).toBe(true);
    expect(result.start.kind).toBe("started");
    const delivery = await runtime.delivered();
    const start = runtime.connections[0]!.rpc.calls.find(call => call.method === "thread/start")!.params;
    expect(start.model).toBe("private-worker-model");
    expect(start.modelProvider).toBe("example-provider");
    expect(String(start.developerInstructions).includes("Use the private research instructions.")).toBe(true);
    expect((start.config as CodexRecord).model_reasoning_effort).toBe("high");
    expect((start.config as CodexRecord).mcp_servers).toEqual({
      rolebox: { enabled: false }, docs: { enabled: false },
    });
    const dynamicNames = (start.dynamicTools as CodexRecord[]).map(tool => tool.name);
    expect(dynamicNames).toEqual(["graph_submit_outcome"]);
    expect(delivery.text.includes("Complete the work task.")).toBe(true);
    expect(delivery.text.includes("Use native Codex tools for file and shell operations.")).toBe(true);
    expect(runtime.host.host.workerPrincipalOf(delivery.threadId)?.attemptId).toBe("work#1");
    expect(existsSync(graphStoreFilePath(runtime.storeRoot))).toBe(true);
    expect(runtime.storeRoot.startsWith(runtime.directory)).toBe(false);

    const submitted = await submit(delivery);
    expect(submitted.success).toBe(true);
    expect(submitted.value.decision).toBe("accepted");
    expect(submitted.value.verdict).toBe("committed");
    const status = await runtime.status();
    expect(status.phase).toBe("complete");
    expect(status.nodes[0]?.outcomeId).toBe("done");
    expect(submitted.text.includes(delivery.credential)).toBe(false);
    expect(JSON.stringify(status).includes(delivery.credential)).toBe(false);
    finish(delivery, "completed");
  });

  it("delivers accepted upstream data and its immutable manifest before releasing a dependent worker", async () => {
    const runtime = await fixture();
    const graph = declaration("codex.graph.sequential");
    graph.nodes = [node("research"), { ...node("review"), inputs: [{ from: "research", outcome: "done" }] }];
    graph.edges = [{ from: "research", to: "review", outcome: "done" }];
    await runtime.declare(graph);
    const first = await runtime.delivered();
    expect(runtime.prompts.length).toBe(1);
    const data = { summary: "Evidence collected.", files: ["src/example.ts"], limitations: [] };
    expect((await submit(first, { data })).value.decision).toBe("accepted");
    const second = await runtime.delivered(1);
    expect(second.nodeId).toBe("review");
    expect(second.text.includes("## Accepted upstream results")).toBe(true);
    expect(second.text.includes('Producer: "research"; outcome: "done"; attempt: "research#1"')).toBe(true);
    const manifestLiteral = /Full results manifest: ("[^\n]+")/.exec(second.text)?.[1];
    if (!manifestLiteral) throw new Error("The dependent worker received no results manifest");
    const manifestPath = JSON.parse(manifestLiteral) as string;
    const manifestText = readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(manifestText) as InputViewManifest;
    expect(manifest.graphId).toBe(graph.name);
    expect(manifest.inputs[0]?.from).toBe("research");
    expect(manifest.inputs[0]?.payload).toEqual({ kind: "value", value: data });
    expect(manifestText.includes(first.credential)).toBe(false);
    expect(second.text.includes(first.credential)).toBe(false);
    expect(runtime.connections.length).toBe(1);
    expect(runtime.connections[0]?.authority.threadId).toBe("parent");
    expect((await submit(second)).value.decision).toBe("accepted");
    expect((await runtime.status(graph.name)).phase).toBe("complete");
    finish(first, "completed");
    finish(second, "completed");
  });

  it("refuses another worker's attempt even when its real credential was supplied", async () => {
    const runtime = await fixture();
    const graph = declaration("codex.graph.parallel");
    graph.nodes = [node("left"), node("right")];
    await runtime.declare(graph);
    const left = await runtime.delivered();
    const right = await runtime.delivered(1);
    const crossWorker = await dynamic(right, "graph_submit_outcome", {
      graph_id: graph.name, node_id: left.nodeId, outcome_id: "done", credential: left.credential, data: {},
    });
    expect(crossWorker.value.decision === "accepted").toBe(false);
    const crossAttempt = await submit(left, { node_id: right.nodeId, credential: right.credential });
    expect(crossAttempt.value.decision === "accepted").toBe(false);
    const wrongThread = await dynamic(left, "graph_submit_outcome", {}, { threadId: "unowned-thread" });
    const wrongTurn = await dynamic(left, "graph_submit_outcome", {}, { turnId: "unowned-turn" });
    expect(wrongThread.success).toBe(false);
    expect(wrongTurn.success).toBe(false);
    expect((await runtime.status(graph.name)).nodes.every(node => node.status === "dispatched")).toBe(true);
    expect((await submit(left)).value.decision).toBe("accepted");
    expect((await submit(right)).value.decision).toBe("accepted");
    expect((await runtime.status(graph.name)).phase).toBe("complete");
  });

  it("denies graph control both in the dynamic worker catalog and at the bound host entry", async () => {
    const runtime = await fixture();
    await runtime.declare();
    const delivery = await runtime.delivered();
    const denied = await dynamic(delivery, "graph_control", { graph_id: delivery.graphId, command: "cancel", reason: "worker request" });
    expect(denied.success).toBe(false);
    const bound = JSON.parse(await runtime.call("graph_control", {
      graph_id: delivery.graphId, command: "cancel", reason: "worker request",
    }, context(delivery.threadId, "reviewer--researcher", runtime.directory))) as CodexRecord;
    expect(bound.code).toBe("worker-tool-forbidden");
    expect(bound.refused).toBe(true);
    expect(delivery.rpc.calls.filter(call => call.method === "turn/interrupt")).toHaveLength(0);
    expect((await submit(delivery)).value.decision).toBe("accepted");
  });

  it.each(["", "builder"])("keeps reviewer private children unavailable to native actor %j", async parentRole => {
    const runtime = await fixture({ parentRole });
    await expect(runtime.declare()).rejects.toThrow("direct private child of the acting role");
    expect(runtime.connections.length).toBe(0);
  });

  it("allows an unattributed native root to target a public role", async () => {
    const runtime = await fixture({ parentRole: "" });
    const graph = declaration();
    graph.nodes[0]!.agent = "reviewer";
    await runtime.declare(graph);
    const delivery = await runtime.delivered();
    expect(runtime.sessions.agentOf(delivery.threadId)).toBe("reviewer");
    expect((await submit(delivery)).value.decision).toBe("accepted");
  });

  it.each(["discover", "code"] as const)("rejects %s presentation before creating a thread", async mode => {
    const runtime = await fixture();
    const graph = declaration();
    graph.nodes[0]!.toolPresentation = { mode };
    await expect(runtime.declare(graph)).rejects.toThrow("native tool presentation only");
    expect(runtime.connections.length).toBe(0);
  });

  it.each(["max_input_tokens", "max_output_tokens", "max_cost_usd"] as const)(
    "refuses an unmeasured %s budget before launching a worker",
    async limit => {
      const runtime = await fixture();
      const graph = declaration();
      graph.nodes[0]!.budget = { ...graph.nodes[0]!.budget, [limit]: 100 };
      await expect(runtime.declare(graph)).rejects.toThrow("measured token/cost usage");
      expect(runtime.connections.length).toBe(0);
      expect(runtime.prompts.length).toBe(0);
    },
  );

  it.each(["missing", "identity-only"] as const)("refuses %s launch metadata before any execution request", async metadata => {
    const runtime = await fixture({ metadata });
    await expect(runtime.declare()).rejects.toThrow(/host-supplied/);
    expect(runtime.connections.length).toBe(0);
    expect(runtime.prompts.length).toBe(0);
  });

  it("does not infer an accepted outcome from an ordinary completed Codex turn", async () => {
    const runtime = await fixture();
    await runtime.declare();
    const delivery = await runtime.delivered();
    finish(delivery, "completed");
    await new Promise(resolve => setImmediate(resolve));
    const status = await runtime.status();
    expect(status.phase === "complete").toBe(false);
    expect(status.nodes[0]?.status).toBe("dispatched");
    expect(status.nodes[0]?.outcomeId).toBeUndefined();
    expect(status.decisions.filter(decision => decision.command === "failure")).toEqual([]);
    const waited = JSON.parse(await runtime.call("graph_wait", { graph_id: delivery.graphId, timeout_ms: 2_000 }));
    expect(waited.status).toBe("attention");
    expect(waited.reason).toContain("no outcome was settled");
  });

  it.each(["failed", "interrupted"] as const)("records a %s turn as a failure without an accepted graph outcome", async terminal => {
    const runtime = await fixture();
    await runtime.declare();
    const delivery = await runtime.delivered();
    finish(delivery, terminal);
    const status = await eventually(runtime.status, value => value.decisions.some(decision => decision.command === "failure"), "a durable failure decision");
    expect(status.phase === "complete").toBe(false);
    expect(status.nodes[0]?.outcomeId).toBeUndefined();
    expect(status.decisions.some(decision => decision.reason.includes(terminal))).toBe(true);
  });

  it("retains the create claim after a lost acknowledgement and refuses blind duplicate creates", async () => {
    const runtime = await fixture({ start: async () => { throw new Error("Codex app-server request timed out: thread/start"); } });
    await runtime.declare();
    await eventually(() => runtime.connections[0]?.rpc.calls.filter(call => call.method === "thread/start").length ?? 0,
      count => count === 1, "the first thread creation request");
    await new Promise(resolve => setImmediate(resolve));
    await runtime.host.host.startDeclaredGraph("codex.graph.single", { sessionId: "parent", agent: "reviewer" });
    await runtime.host.host.startDeclaredGraph("codex.graph.single", { sessionId: "parent", agent: "reviewer" });
    const status = await runtime.status();
    expect(runtime.connections[0]?.rpc.calls.filter(call => call.method === "thread/start")).toHaveLength(1);
    expect(runtime.prompts.length).toBe(0);
    expect(status.nodes[0]?.outcomeId).toBeUndefined();
    expect(status.unsettled_effects.some(effect => effect.effectId === "dispatch:work#1")).toBe(true);
  });

  it("retains a confirmed worker after turn delivery fails instead of creating a second worker", async () => {
    const runtime = await fixture({ turnStart: async () => { throw new Error("turn delivery was not acknowledged"); } });
    await runtime.declare();
    await eventually(() => runtime.connections[0]?.rpc.calls.filter(call => call.method === "turn/start").length ?? 0,
      count => count === 1, "the worker turn request");
    await new Promise(resolve => setImmediate(resolve));
    await runtime.host.host.startDeclaredGraph("codex.graph.single", { sessionId: "parent", agent: "reviewer" });
    expect(runtime.connections[0]?.rpc.calls.filter(call => call.method === "thread/start")).toHaveLength(1);
    expect(runtime.host.host.workerPrincipalOf("worker-1")?.attemptId).toBe("work#1");
    const status = await runtime.status();
    expect(status.nodes[0]?.outcomeId).toBeUndefined();
    expect(status.unsettled_effects.some(effect => effect.effectId === "dispatch:work#1")).toBe(true);
  });

  it("reports cancellation requested until Codex supplies an interrupted terminal event", async () => {
    const runtime = await fixture();
    await runtime.declare();
    const delivery = await runtime.delivered();
    const controlled = JSON.parse(await runtime.call("graph_control", {
      graph_id: delivery.graphId, command: "cancel", reason: "Operator stopped the run.",
    })) as CodexRecord;
    expect(controlled.kind).toBe("applied");
    const pending = await runtime.host.host.deliverCancelIntents(delivery.graphId);
    expect(pending.entries[0]?.state).toBe("requested");
    expect(runtime.sessions.wasInterrupted(delivery.threadId)).toBe(false);
    finish(delivery, "interrupted");
    const completed = await runtime.host.host.deliverCancelIntents(delivery.graphId);
    expect(completed.entries[0]?.state).toBe("confirmed");
    const status = await runtime.status();
    expect(status.nodes[0]?.outcomeId).toBeUndefined();
    expect(status.phase === "complete").toBe(false);
  });

  it.each(["cancel", "budget-stop", "failure", "timeout"])("does not start a late-created worker after %s", async command => {
    const created = Promise.withResolvers<CodexRecord>();
    const runtime = await fixture({ start: () => created.promise });
    await runtime.declare();
    await eventually(() => runtime.connections[0]?.rpc.calls.filter(call => call.method === "thread/start").length ?? 0,
      count => count === 1, "the pending worker creation");
    const result = JSON.parse(await runtime.call("graph_control", {
      graph_id: "codex.graph.single", command, reason: "Stop before the worker starts.",
      ...(["failure", "timeout"].includes(command) ? { node_id: "work", attempt_id: "work#1" } : {}),
    })) as CodexRecord;
    expect(result.kind).toBe("applied");
    created.resolve({ thread: { id: "late-worker", cwd: runtime.directory } });
    await eventually(() => runtime.sessions.agentOf("late-worker"), value => value === "reviewer--researcher", "the late worker acknowledgment");
    await new Promise(resolve => setImmediate(resolve));
    expect(runtime.connections[0]!.rpc.calls.filter(call => call.method === "turn/start")).toHaveLength(0);
    expect((await runtime.status()).nodes[0]?.outcomeId).toBeUndefined();
  });

  it("records an expired running attempt and requests interruption without inventing completion", async () => {
    const runtime = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const graph = declaration();
    graph.nodes[0]!.budget = { timeout_ms: 100 };
    await runtime.declare(graph);
    await vi.advanceTimersByTimeAsync(0);
    const delivery = await runtime.delivered();
    await vi.advanceTimersByTimeAsync(101);
    const status = await runtime.status();
    const timeout = status.decisions.find(decision => decision.command === "timeout");
    expect(timeout?.attemptId).toBe("work#1");
    expect(delivery.rpc.calls.filter(call => call.method === "turn/interrupt").length).toBe(1);
    expect(status.nodes[0]?.outcomeId).toBeUndefined();
    expect(runtime.sessions.executionState(delivery.threadId).kind).toBe("running");
    finish(delivery, "interrupted");
  });

  it("records a deadline during pending creation and never prompts the late-created thread", async () => {
    const created = Promise.withResolvers<CodexRecord>();
    const runtime = await fixture({ start: () => created.promise });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const graph = declaration();
    graph.nodes[0]!.budget = { timeout_ms: 100 };
    await runtime.declare(graph);
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.connections[0]!.rpc.calls.filter(call => call.method === "thread/start").length).toBe(1);
    await vi.advanceTimersByTimeAsync(101);
    expect((await runtime.status()).decisions.some(decision => decision.command === "timeout")).toBe(true);
    created.resolve({ thread: { id: "late-worker", cwd: runtime.directory } });
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.connections[0]!.rpc.calls.filter(call => call.method === "turn/start").length).toBe(0);
    expect(runtime.prompts.length).toBe(0);
    expect((await runtime.status()).nodes[0]?.outcomeId).toBeUndefined();
  });

  it("delivers an elapsed timeout once a pending turn start is acknowledged", async () => {
    const started = Promise.withResolvers<CodexRecord>();
    const runtime = await fixture({ turnStart: () => started.promise });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const graph = declaration();
    graph.nodes[0]!.budget = { timeout_ms: 100 };
    await runtime.declare(graph);
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.connections[0]!.rpc.calls.filter(call => call.method === "turn/start").length).toBe(1);
    await vi.advanceTimersByTimeAsync(101);
    expect((await runtime.status()).decisions.some(decision => decision.command === "timeout")).toBe(true);
    started.resolve({ turn: { id: "late-turn", status: "inProgress" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.connections[0]!.rpc.calls.filter(call => call.method === "turn/interrupt").length).toBe(1);
    runtime.connections[0]!.rpc.emit("turn/completed", { threadId: "worker-1", turn: { id: "late-turn", status: "interrupted" } });
  });

  it("treats zero timeout as no deadline while still accepting the worker's explicit result", async () => {
    const runtime = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const graph = declaration();
    graph.nodes[0]!.budget = { timeout_ms: 0 };
    await runtime.declare(graph);
    await vi.advanceTimersByTimeAsync(0);
    const delivery = await runtime.delivered();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect((await runtime.status()).decisions.some(decision => decision.command === "timeout")).toBe(false);
    expect(delivery.rpc.calls.filter(call => call.method === "turn/interrupt").length).toBe(0);
    expect((await submit(delivery)).value.decision).toBe("accepted");
    finish(delivery, "completed");
  });

  it("does not apply a stale deadline to an already accepted attempt", async () => {
    const runtime = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const graph = declaration();
    graph.nodes[0]!.budget = { timeout_ms: 100 };
    await runtime.declare(graph);
    await vi.advanceTimersByTimeAsync(0);
    const delivery = await runtime.delivered();
    expect((await submit(delivery)).value.decision).toBe("accepted");
    await vi.advanceTimersByTimeAsync(1_000);
    const status = await runtime.status();
    expect(status.phase).toBe("complete");
    expect(status.decisions.some(decision => decision.command === "timeout")).toBe(false);
    expect(delivery.rpc.calls.filter(call => call.method === "turn/interrupt").length).toBe(0);
    finish(delivery, "completed");
  });

  it("clears the deadline on close without writing a later timeout into the persisted graph", async () => {
    const runtime = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const graph = declaration();
    graph.nodes[0]!.budget = { timeout_ms: 100 };
    await runtime.declare(graph);
    await vi.advanceTimersByTimeAsync(0);
    const delivery = await runtime.delivered();
    runtime.close();
    await vi.advanceTimersByTimeAsync(1_000);
    const reopened = await fixture({ root: runtime.root, threads: runtime.threads });
    expect((await reopened.status()).decisions.some(decision => decision.command === "timeout")).toBe(false);
    expect(delivery.rpc.calls.filter(call => call.method === "turn/interrupt").length).toBe(0);
  });

  it("reads persisted graph state in a new host without redispatching existing work", async () => {
    const original = await fixture();
    await original.declare();
    const delivery = await original.delivered();
    const before = await original.status();
    original.close();

    const reopened = await fixture({ root: original.root, threads: original.threads });
    const after = await reopened.status();
    expect(after.graph_id).toBe(before.graph_id);
    expect(after.nodes[0]?.attemptId).toBe(before.nodes[0]?.attemptId);
    expect(after.nodes[0]?.outcomeId).toBeUndefined();
    expect(reopened.connections.length).toBe(0);
    expect(reopened.prompts.length).toBe(0);
    expect(JSON.stringify(after).includes(delivery.credential)).toBe(false);
  });

  it("releases runtime watchers and connections when the host and sessions close", async () => {
    const runtime = await fixture();
    await runtime.declare();
    const delivery = await runtime.delivered();
    const waiting = runtime.sessions.wait(delivery.threadId);
    runtime.close();
    await waiting;
    expect(runtime.reader.closeCount).toBe(1);
    expect(delivery.rpc.closeCount).toBe(1);
    await expect(runtime.sessions.create({ directory: runtime.directory, agent: "reviewer", parentID: "parent" })).rejects.toThrow("runtime closed");
    await expect(runtime.declare(declaration("after-close"))).rejects.toThrow();
    expect(runtime.connections[0]?.rpc.calls.filter(call => call.method === "thread/start")).toHaveLength(1);
  });
});
