import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, resolve } from "node:path";
import type { ISessionClient } from "../../ports/session-client.ts";
import type { FileDiff, Message, SessionInfo, SessionStatus, Todo, CanonicalToolDef } from "../../types.ts";
import type { ResolvedRole } from "../../../types.ts";
import { collectCodexAgentDescriptors, type CodexAgentDescriptor } from "./installation/agents.ts";
import {
  CodexAppServerClient, codexAppServerOptions, codexLaunchAuthority, codexRecord,
  type CodexLaunchAuthority, type CodexRecord, type CodexRpc,
} from "./app-server/app-server.ts";
import { CodexMcpToolFactory } from "./mcp/tool-factory.ts";
import { codexRoleToolAllowed } from "./tool-policy.ts";

const RESOURCE_TOOLS = new Set([
  "load_role_skill", "load_reference", "reference_search", "asset_search", "asset_inspect", "asset_validate",
]);
const WORKER_TOOLS = new Set(["graph_submit_outcome", ...RESOURCE_TOOLS]);

export interface CodexSessionOptions {
  directory: string;
  roles: readonly ResolvedRole[];
  rpcFactory?: (authority?: CodexLaunchAuthority) => CodexRpc;
}

interface ManagedThread {
  rpc: CodexRpc;
  role: string;
  parentID?: string;
  thread: CodexRecord;
  turnId?: string;
  starting?: boolean;
  interruptRequested?: boolean;
  interrupts?: Map<string, Promise<void>>;
  connectionLost?: boolean;
  outcome?: "completed" | "failed" | "interrupted";
  failureReason?: string;
  abort: AbortController;
  waiters: Set<() => void>;
}

function records(value: unknown): CodexRecord[] {
  return Array.isArray(value) ? value.map(codexRecord).filter((entry): entry is CodexRecord => entry !== undefined) : [];
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function seconds(value: unknown): number { return typeof value === "number" ? value * 1000 : 0; }

export class CodexSessionAdapter implements ISessionClient {
  private reader?: CodexRpc;
  private readerExecutable?: string;
  private readonly connections = new Map<string, CodexRpc>();
  private readonly managed = new Map<string, ManagedThread>();
  private readonly authorities = new Map<string, CodexLaunchAuthority>();
  private readonly actors = new Map<string, string>();
  private readonly trustedThreads = new Set<string>();
  private readonly caller = new AsyncLocalStorage<string>();
  private readonly plans = new Map<string, Todo[]>();
  private readonly factory = new CodexMcpToolFactory();
  private descriptors: ReturnType<CodexMcpToolFactory["compileAll"]> = {};
  private closed = false;

  constructor(private readonly options: CodexSessionOptions) {}

  rememberInvocation(threadId: string, meta: CodexRecord | undefined): void {
    if (meta?.threadId === threadId) this.trustedThreads.add(threadId);
    const executable = codexRecord(meta?.["codex/sandbox-launcher"])?.codexExecutable;
    if (typeof executable === "string" && isAbsolute(executable)) this.readerExecutable = executable;
    const authority = codexLaunchAuthority(meta);
    if (authority && authority.threadId === threadId) this.authorities.set(threadId, authority);
    else this.authorities.delete(threadId);
  }

  inSession<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    return this.caller.run(threadId, operation);
  }

  setTools(tools: Record<string, CanonicalToolDef>): void {
    this.descriptors = this.factory.compileAll(tools);
  }

  agentOf(threadId?: string): string { return threadId ? this.actors.get(threadId) ?? "" : ""; }

  hasThreadIdentity(threadId: string): boolean {
    return this.trustedThreads.has(threadId) || this.managed.has(threadId);
  }

  async resolveAgent(threadId: string): Promise<string> {
    const known = this.actors.get(threadId);
    if (known !== undefined) return known;
    const thread = await this.readThread(threadId);
    const role = collectCodexAgentDescriptors(this.options.roles).agents.find(
      agent => agent.parentId === undefined && agent.nativeName === thread.agentRole,
    )?.roleId ?? "";
    if (!role && typeof thread.agentRole === "string" && thread.agentRole.startsWith("rolebox--")) {
      throw new Error("This native Codex rolebox agent is no longer present in the resolved role tree. Sync and restart Codex.");
    }
    this.actors.set(threadId, role);
    return role;
  }

  assertLaunchable(threadId?: string): CodexLaunchAuthority {
    const authority = threadId ? this.authorities.get(threadId) : undefined;
    if (!authority) throw new Error("Delegated Codex execution requires host-supplied threadId, codex/sandbox-state and codex/sandbox-launcher metadata. Update Codex and restart the rolebox MCP server.");
    return authority;
  }

  executionState(id: string): { kind: "running" | "completed" | "failed" | "unknown"; reason?: string } {
    const managed = this.managed.get(id);
    if (!managed) return { kind: "unknown", reason: "This app-server does not own the execution" };
    if (managed.connectionLost && !managed.outcome) return { kind: "unknown", reason: "Codex connection lost before a terminal turn event" };
    if (managed.outcome === "completed") return { kind: "completed" };
    if (managed.outcome) return { kind: "failed", reason: managed.failureReason ?? `Codex turn ${managed.outcome}` };
    if (managed.turnId) return { kind: "running" };
    return { kind: "unknown", reason: "No Codex turn has been accepted" };
  }

  wasInterrupted(id: string): boolean { return this.managed.get(id)?.outcome === "interrupted"; }

  async wait(id: string): Promise<void> {
    const managed = this.managed.get(id);
    if (!managed) throw new Error("Cannot watch a Codex thread owned by another app-server");
    if (managed.outcome || managed.connectionLost) return;
    await new Promise<void>(resolveWait => managed.waiters.add(resolveWait));
  }

  async list(directory?: string): Promise<SessionInfo[]> {
    const rows = await this.pages(this.readRpc(), "thread/list", {
      limit: 100, modelProviders: [],
      sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent"],
      ...(directory ? { cwd: resolve(directory) } : {}),
    });
    return rows.filter(row => typeof row.id === "string" && typeof row.cwd === "string")
      .filter(row => !directory || resolve(text(row.cwd)) === resolve(directory))
      .map(row => this.projectThread(row));
  }

  async get(id: string, directory?: string): Promise<SessionInfo | null> {
    const thread = await this.readThread(id);
    return this.matchesDirectory(thread, directory) ? this.projectThread(thread) : null;
  }

  async messages(id: string, options?: { directory?: string; limit?: number }): Promise<Message[]> {
    const thread = await this.readThread(id);
    if (!this.matchesDirectory(thread, options?.directory)) return [];
    const turns = await this.turns(id, thread);
    const result = turns.flatMap(turn => records(turn.items).map(item => this.projectMessage(thread, turn, item)).filter(
      (message): message is Message => message !== undefined,
    ));
    return options?.limit === undefined ? result : result.slice(0, options.limit);
  }

  async children(id: string, directory?: string): Promise<SessionInfo[]> {
    return (await this.list(directory)).filter(thread => thread.parentID === id || this.managed.get(thread.id)?.parentID === id);
  }

  async todo(id: string, directory?: string): Promise<Todo[]> {
    if (await this.get(id, directory) === null) return [];
    return this.plans.get(id) ?? [];
  }

  async patches(id: string, options?: { directory?: string; messageID?: string }): Promise<Array<FileDiff & { patch: string }>> {
    const thread = await this.readThread(id);
    if (!this.matchesDirectory(thread, options?.directory)) return [];
    const turns = await this.turns(id, thread);
    let selected = turns;
    if (options?.messageID) {
      const index = turns.findIndex(turn => turn.id === options.messageID || records(turn.items).some(item => item.id === options.messageID));
      if (index < 0) throw new Error("The Codex message or turn ID was not found");
      selected = turns.slice(0, index + 1);
    }
    return selected.flatMap(turn => records(turn.items).filter(item => item.type === "fileChange").flatMap(item =>
      records(item.changes).map(change => {
        const patch = text(change.diff);
        const lines = patch.split("\n");
        return {
          file: text(change.path), before: "", after: "", patch,
          additions: lines.filter(line => line.startsWith("+") && !line.startsWith("+++")).length,
          deletions: lines.filter(line => line.startsWith("-") && !line.startsWith("---")).length,
        };
      }),
    ));
  }

  async diff(id: string, options?: { directory?: string; messageID?: string }): Promise<FileDiff[]> {
    return this.patches(id, options);
  }

  async fork(id: string, options?: { directory?: string; messageID?: string }): Promise<SessionInfo | null> {
    const thread = await this.readThread(id);
    if (!this.matchesDirectory(thread, options?.directory)) return null;
    const origin = this.caller.getStore() ?? id;
    const rpc = this.executionRpc(origin);
    let lastTurnId: string | undefined;
    if (options?.messageID) {
      const turns = await this.turns(id, thread);
      const turn = turns.find(candidate => candidate.id === options.messageID || records(candidate.items).some(item => item.id === options.messageID));
      if (!turn) throw new Error("The Codex message or turn ID was not found");
      if (turn.status === "inProgress") throw new Error("Codex cannot fork an in-progress turn");
      if (turn.id !== options.messageID && records(turn.items).at(-1)?.id !== options.messageID) {
        throw new Error("Codex forks at completed turn boundaries. Use the turn ID or its final message ID.");
      }
      lastTurnId = text(turn.id);
    }
    const result = await rpc.request("thread/fork", {
      threadId: id, cwd: text(thread.cwd), excludeTurns: true,
      config: await this.workerConfig(), ...(lastTurnId ? { lastTurnId } : {}),
    });
    const forked = this.requireThread(result);
    await this.verifyWorkerTools(rpc, text(forked.id));
    this.rememberManaged(forked, rpc, this.agentOf(id), id);
    return this.projectThread(forked);
  }

  async status(id: string, directory?: string): Promise<SessionStatus | null> {
    const thread = await this.readThread(id);
    if (!this.matchesDirectory(thread, directory)) return null;
    const state = codexRecord(thread.status)?.type;
    if (state === "active") return { type: "busy" };
    if (state === "idle") return { type: "idle" };
    return null;
  }

  async prompt(id: string, options: Parameters<ISessionClient["prompt"]>[1]): Promise<{ id: string } | null> {
    const managed = this.managed.get(id);
    if (!managed) throw new Error("rolebox only prompts Codex threads it created; an external UI thread cannot be resumed through a separate app-server");
    if (managed.connectionLost) throw new Error("The owning Codex app-server connection was lost");
    if (options.noReply) throw new Error("Codex has no silent prompt equivalent in this adapter");
    if (managed.starting) throw new Error("The Codex thread is already starting a turn");
    if (managed.turnId && !managed.outcome) throw new Error("The Codex thread already has a running turn");
    managed.starting = true;
    managed.interruptRequested = false;
    let result: CodexRecord;
    try {
      result = await managed.rpc.request("turn/start", {
        threadId: id,
        input: options.parts.map(part => ({ type: "text", text: part.text, text_elements: [] })),
      });
    } finally { managed.starting = false; }
    const turnId = codexRecord(result.turn)?.id;
    if (typeof turnId !== "string") throw new Error("Codex did not acknowledge a turn ID");
    if (managed.turnId !== turnId) {
      managed.turnId = turnId;
      managed.outcome = undefined;
      managed.failureReason = undefined;
      managed.abort = new AbortController();
    }
    if (managed.interruptRequested && !managed.outcome) await this.deliverInterrupt(id, managed);
    return { id: turnId };
  }

  async promptSync(id: string, options: Parameters<ISessionClient["promptSync"]>[1]): Promise<{ parts: Array<{ type: string; text?: string }> } | null> {
    if (options.signal?.aborted) throw options.signal.reason;
    const onAbort = () => { void this.abort(id).catch(() => {}); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await this.prompt(id, options);
      if (options.signal?.aborted) onAbort();
      await this.wait(id);
      const state = this.executionState(id);
      if (state.kind === "failed") throw new Error(state.reason);
      const messages = await this.messages(id);
      return { parts: messages.filter(message => message.info.role === "assistant").at(-1)?.parts.map(part =>
        ({ type: part.type, ...("text" in part && typeof part.text === "string" ? { text: part.text } : {}) }),
      ) ?? [] };
    } finally { options.signal?.removeEventListener("abort", onAbort); }
  }

  async create(options: Parameters<ISessionClient["create"]>[0]): Promise<SessionInfo | null> {
    const origin = options.parentID ?? this.caller.getStore();
    const rpc = this.executionRpc(origin);
    const parent = origin ? await this.readThread(origin) : undefined;
    const descriptor = this.descriptor(options.agent, text(parent?.modelProvider) || undefined);
    const result = await rpc.request("thread/start", {
      cwd: options.directory,
      config: await this.workerConfig(descriptor, text(parent?.reasoningEffort) || undefined),
      ...(descriptor ? { developerInstructions: descriptor.developerInstructions } : {}),
      ...(descriptor?.model ?? parent?.model ? { model: descriptor?.model ?? parent?.model } : {}),
      ...(parent?.modelProvider ? { modelProvider: parent.modelProvider } : {}),
      dynamicTools: this.workerDescriptors(descriptor?.roleId),
    });
    const thread = this.requireThread(result);
    await this.verifyWorkerTools(rpc, text(thread.id));
    this.rememberManaged(thread, rpc, options.agent ?? "", options.parentID);
    return this.projectThread(thread);
  }

  async abort(id: string): Promise<boolean> {
    const managed = this.managed.get(id);
    if (managed?.starting && (!managed.turnId || managed.outcome)) {
      managed.interruptRequested = true;
      return true;
    }
    if (!managed?.turnId || managed.outcome) return false;
    managed.interruptRequested = true;
    await this.deliverInterrupt(id, managed);
    return true;
  }

  private async deliverInterrupt(id: string, managed: ManagedThread): Promise<void> {
    if (!managed.turnId || managed.outcome) return;
    const turnId = managed.turnId;
    const requests = managed.interrupts ??= new Map();
    let pending = requests.get(turnId);
    if (!pending) {
      pending = managed.rpc.request("turn/interrupt", { threadId: id, turnId }).then(() => {
        if (managed.turnId === turnId) managed.interruptRequested = false;
      }).catch(error => { requests.delete(turnId); throw error; });
      requests.set(turnId, pending);
    }
    await pending;
  }

  async compact(id: string): Promise<boolean> {
    const managed = this.managed.get(id);
    if (!managed) return false;
    await managed.rpc.request("thread/compact/start", { threadId: id });
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reader?.close();
    for (const rpc of this.connections.values()) rpc.close();
    for (const managed of this.managed.values()) {
      managed.connectionLost = true;
      managed.abort.abort(new Error("Codex session runtime closed"));
      for (const waiter of managed.waiters) waiter();
    }
    this.connections.clear();
    this.authorities.clear();
  }

  private readRpc(): CodexRpc {
    if (this.closed) throw new Error("Codex session runtime closed");
    if (!this.reader) {
      const options = codexAppServerOptions(this.options.directory);
      if (!process.env.ROLEBOX_CODEX_COMMAND?.trim() && this.readerExecutable) options.command = this.readerExecutable;
      this.reader = this.options.rpcFactory?.() ?? new CodexAppServerClient(options);
    }
    return this.reader;
  }

  private executionRpc(origin?: string): CodexRpc {
    if (this.closed) throw new Error("Codex session runtime closed");
    const authority = this.assertLaunchable(origin);
    let rpc = this.connections.get(authority.key);
    if (!rpc) {
      rpc = this.options.rpcFactory?.(authority) ?? new CodexAppServerClient(codexAppServerOptions(this.options.directory, authority));
      rpc.onNotification((method, params) => this.notification(method, params, rpc));
      rpc.setRequestHandler((_method, params) => this.dynamicCall(params, rpc));
      this.connections.set(authority.key, rpc);
    }
    return rpc;
  }

  private async readThread(id: string): Promise<CodexRecord> {
    const result = await (this.managed.get(id)?.rpc ?? this.readRpc()).request("thread/read", { threadId: id, includeTurns: false });
    const thread = this.requireThread(result);
    if (thread.id !== id) throw new Error("Codex returned a different thread identity");
    return thread;
  }

  private requireThread(result: CodexRecord): CodexRecord {
    const thread = codexRecord(result.thread);
    if (!thread || typeof thread.id !== "string" || typeof thread.cwd !== "string") throw new Error("Codex returned invalid thread metadata");
    return thread;
  }

  private matchesDirectory(thread: CodexRecord, directory?: string): boolean {
    return directory === undefined || resolve(text(thread.cwd)) === resolve(directory);
  }

  private projectThread(thread: CodexRecord): SessionInfo {
    const parentID = this.managed.get(text(thread.id))?.parentID ?? thread.parentThreadId ?? thread.forkedFromId;
    return {
      id: text(thread.id), directory: text(thread.cwd), projectID: text(thread.projectId) || text(thread.cwd),
      title: text(thread.name) || text(thread.preview) || "Codex thread", version: text(thread.cliVersion),
      ...(typeof parentID === "string" ? { parentID } : {}),
      time: { created: seconds(thread.createdAt), updated: seconds(thread.updatedAt) },
    };
  }

  private async pages(rpc: CodexRpc, method: string, params: CodexRecord): Promise<CodexRecord[]> {
    const result: CodexRecord[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await rpc.request(method, { ...params, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page.data)) throw new Error(`Codex returned invalid pagination data for ${method}`);
      result.push(...records(page.data));
      cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
      if (cursor && seen.has(cursor)) throw new Error("Codex returned a repeated pagination cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return result;
  }

  private async turns(id: string, thread: CodexRecord): Promise<CodexRecord[]> {
    const rpc = this.managed.get(id)?.rpc ?? this.readRpc();
    if (thread.historyMode === "paginated") {
      const turns = await this.pages(rpc, "thread/turns/list", { threadId: id, limit: 100, sortDirection: "asc", itemsView: "full" });
      for (const turn of turns) {
        if (turn.itemsView !== undefined && turn.itemsView !== "full") {
          const entries = await this.pages(rpc, "thread/items/list", { threadId: id, turnId: turn.id, limit: 100, sortDirection: "asc" });
          turn.items = entries.map(entry => entry.item);
        }
      }
      return turns;
    }
    return records(this.requireThread(await rpc.request("thread/read", { threadId: id, includeTurns: true })).turns);
  }

  private projectMessage(thread: CodexRecord, turn: CodexRecord, item: CodexRecord): Message | undefined {
    const sessionID = text(thread.id);
    const id = text(item.id);
    const created = typeof item.startedAtMs === "number" ? item.startedAtMs : seconds(turn.startedAt ?? thread.createdAt);
    const completed = typeof item.completedAtMs === "number" ? item.completedAtMs : seconds(turn.completedAt);
    const common = { id: `${id}:part`, sessionID, messageID: id };
    const role = item.type === "userMessage" ? "user" : "assistant";
    const message: Message = { info: { id, sessionID, role, time: { created, ...(completed ? { completed } : {}) },
      ...(this.agentOf(sessionID) ? { agent: this.agentOf(sessionID) } : {}),
      ...(typeof thread.model === "string" ? { model: { modelID: thread.model, providerID: text(thread.modelProvider) } } : {}),
    }, parts: [] };
    if (item.type === "userMessage") {
      message.parts = records(item.content).filter(part => part.type === "text").map((part, index) =>
        ({ ...common, id: `${id}:${index}`, type: "text", text: text(part.text) }));
    } else if (item.type === "agentMessage" || item.type === "plan") {
      message.parts = [{ ...common, type: "text", text: text(item.text) }];
    } else if (item.type === "reasoning") {
      message.parts = [{ ...common, type: "reasoning", text: [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])].join("\n"), time: { start: created, ...(completed ? { end: completed } : {}) } }];
    } else if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(text(item.type))) {
      const output = item.type === "commandExecution" ? text(item.aggregatedOutput) :
        item.type === "fileChange" ? records(item.changes).map(change => text(change.diff)).join("\n") :
          records(item.contentItems ?? codexRecord(item.result)?.content).map(part => text(part.text)).join("\n");
      const tool = item.type === "commandExecution" ? "shell" : item.type === "fileChange" ? "apply_patch" : text(item.tool);
      const status = item.status === "inProgress" ? "running" : item.status === "failed" ? "error" : "completed";
      message.parts = [{ ...common, type: "tool", callID: id, tool, state:
        status === "running" ? { status, input: codexRecord(item.arguments) ?? {} } :
        status === "error" ? { status, error: text(codexRecord(item.error)?.message) || output, time: { start: created, end: completed || created } } :
        { status, input: codexRecord(item.arguments) ?? (item.command ? { command: item.command } : {}), output, title: tool, metadata: {}, time: { start: created, end: completed || created } },
      }];
    } else return undefined;
    return message;
  }

  private descriptor(id?: string, modelProvider?: string): CodexAgentDescriptor | undefined {
    if (!id) return undefined;
    const descriptor = collectCodexAgentDescriptors(this.options.roles, { modelProvider }).agents.find(agent => agent.roleId === id);
    if (!descriptor) throw new Error("The requested Codex rolebox agent is not installed");
    return descriptor;
  }

  private async workerConfig(descriptor?: CodexAgentDescriptor, parentReasoningEffort?: string): Promise<CodexRecord> {
    const effective = codexRecord((await this.readRpc().request("config/read", { includeLayers: false, cwd: this.options.directory })).config) ?? {};
    const servers = codexRecord(effective.mcp_servers) ?? {};
    return {
      "features.plugins": false, "agents.enabled": false, "features.multi_agent": false,
      "features.multi_agent_v2": false, "features.request_permissions_tool": false,
      "features.apps": false, "features.hooks": false, "features.image_generation": false,
      "features.memories": false,
      "features.shell_snapshot": false, "features.shell_snapshot_v2": false,
      "features.goals": false, "web_search": "disabled", notify: [],
      mcp_servers: Object.fromEntries(Object.keys(servers).map(name => [name, { enabled: false }])),
      ...(descriptor?.reasoningEffort ?? parentReasoningEffort
        ? { model_reasoning_effort: descriptor?.reasoningEffort ?? parentReasoningEffort } : {}),
      ...Object.fromEntries(Object.keys(descriptor?.features ?? {}).map(feature => [`features.${feature}`, false])),
    };
  }

  private async verifyWorkerTools(rpc: CodexRpc, threadId: string): Promise<void> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const inventory = await rpc.request("mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly", ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(inventory.data) || inventory.data.some(value => {
        const server = codexRecord(value);
        return server?.runtimeStatus !== "disabled" || !codexRecord(server.tools) || Object.keys(server.tools as CodexRecord).length > 0 ||
          !Array.isArray(server.resources) || server.resources.length > 0 || !Array.isArray(server.resourceTemplates) || server.resourceTemplates.length > 0;
      })) throw new Error("Codex worker MCP tools could not be disabled; execution was refused before starting the model");
      cursor = typeof inventory.nextCursor === "string" && inventory.nextCursor ? inventory.nextCursor : undefined;
      if (cursor && seen.has(cursor)) throw new Error("Codex returned repeated worker tool inventory pages");
      if (cursor) seen.add(cursor);
    } while (cursor);
  }

  private workerDescriptors(roleId?: string): CodexRecord[] {
    return Object.entries(this.descriptors).filter(([name]) => WORKER_TOOLS.has(name) && this.toolAllowed(roleId, name)).map(
      ([name, descriptor]) => ({ type: "function", name, description: descriptor.description, inputSchema: descriptor.inputSchema }),
    );
  }

  private toolAllowed(roleId: string | undefined, name: string): boolean {
    if (name === "graph_submit_outcome") return true;
    const role = roleId ? this.descriptor(roleId) : undefined;
    return role !== undefined && RESOURCE_TOOLS.has(name) && codexRoleToolAllowed(this.options.roles, roleId!, name);
  }

  private rememberManaged(thread: CodexRecord, rpc: CodexRpc, role: string, parentID?: string): void {
    const id = text(thread.id);
    this.managed.set(id, { rpc, role, parentID, thread, abort: new AbortController(), waiters: new Set() });
    this.actors.set(id, role);
  }

  private async dynamicCall(params: CodexRecord, rpc?: CodexRpc): Promise<unknown> {
    const id = text(params.threadId);
    const managed = this.managed.get(id);
    const name = text(params.tool);
    if (!managed || managed.rpc !== rpc || managed.connectionLost || !managed.turnId || managed.outcome || !WORKER_TOOLS.has(name) || !this.toolAllowed(managed.role, name) ||
      (params.namespace !== null && params.namespace !== undefined && params.namespace !== "") ||
      params.turnId !== managed.turnId) {
      return { success: false, contentItems: [{ type: "inputText", text: "This tool call is not bound to an authorized rolebox worker" }] };
    }
    const result = await this.inSession(id, () => this.factory.call(name, params.arguments, {
      sessionID: id, messageID: text(params.callId), agent: managed.role,
      directory: text(managed.thread.cwd), worktree: text(managed.thread.cwd), abort: managed.abort.signal,
      metadata() {}, async ask() { throw new Error("Interactive approval is unavailable for Codex graph workers"); },
    }));
    return { success: !result.isError, contentItems: result.content.map(block => block.type === "text"
      ? { type: "inputText", text: block.text } : { type: "inputImage", imageUrl: `data:${block.mimeType};base64,${block.data}` }) };
  }

  private notification(method: string, params: CodexRecord, rpc?: CodexRpc): void {
    if (method === "rolebox/connectionClosed") {
      for (const entry of this.managed.values()) {
        if (entry.rpc !== rpc || entry.outcome) continue;
        entry.connectionLost = true;
        entry.abort.abort(new Error("Codex app-server connection lost"));
        for (const waiter of entry.waiters) waiter();
        entry.waiters.clear();
      }
      return;
    }
    const managed = this.managed.get(text(params.threadId));
    if (!managed || managed.rpc !== rpc) return;
    if (method === "turn/started") {
      const turnId = text(codexRecord(params.turn)?.id);
      if (turnId && turnId !== managed.turnId) {
        managed.turnId = turnId;
        managed.outcome = undefined;
        managed.failureReason = undefined;
        managed.abort = new AbortController();
        if (managed.interruptRequested) void this.deliverInterrupt(text(params.threadId), managed).catch(() => {});
      }
    } else if (method === "turn/completed") {
      const turn = codexRecord(params.turn);
      if (managed.turnId && turn?.id !== managed.turnId) return;
      const status = turn?.status;
      managed.outcome = status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed";
      const message = codexRecord(turn?.error)?.message;
      if (managed.outcome === "failed" && typeof message === "string") managed.failureReason = message;
      managed.abort.abort(new Error(`Codex turn ${managed.outcome}`));
      for (const waiter of managed.waiters) waiter();
      managed.waiters.clear();
    } else if (method === "turn/plan/updated") {
      this.plans.set(text(params.threadId), records(params.plan).map((step, index) => ({
        id: String(index), content: text(step.step), status: text(step.status), priority: "medium",
      })));
    }
  }
}
