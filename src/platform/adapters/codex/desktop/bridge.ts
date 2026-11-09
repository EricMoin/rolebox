import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { codexRecord, type CodexRecord } from "../app-server.ts";
import { MCP_LATEST_PROTOCOL_VERSION, MCP_PROTOCOL_VERSIONS } from "../mcp-protocol.ts";
import type { CodexParentNotificationStatus } from "../parent-notifications.ts";
import { JsonLineBuffer, JsonLineLimitError } from "./jsonl-buffer.ts";

export const DEFAULT_DESKTOP_BRIDGE_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface CodexDesktopBinding {
  readonly pluginRoot: string;
  readonly nodePath: string;
  readonly pipePath: string;
}

export interface CodexDesktopLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface CodexDesktopBridgeOptions {
  readonly binding: CodexDesktopBinding;
  readonly threadId: string;
  readonly parent: { inspect(threadId: string): Promise<CodexParentNotificationStatus> };
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Forward only metadata supplied by the calling host, without synthesizing identities. */
  readonly hostMeta?: CodexRecord;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly signal?: AbortSignal;
  readonly peerLogPath?: string;
}

export type CodexDesktopBridgeStage = "parent" | "binding" | "initialize" | "tools/list" | "tools/call";
export type CodexDesktopBridgeCode = "verified" | "parent_unavailable" | "invalid_binding" |
  "cancelled" | "timeout" | "process_unavailable" | "transport_closed" | "invalid_protocol" |
  "ipc_closed" | "host_context_missing" | "mcp_refused" | "read_tool_unavailable" |
  "read_result_unverified" | "peer_rejected" | "response_too_large" | "invalid_timeout" |
  "invalid_response_limit" | "invalid_request" | "probe_failed";

export interface CodexDesktopBridgeResult {
  readonly status: "ready" | "blocked";
  readonly stage: CodexDesktopBridgeStage;
  readonly code: CodexDesktopBridgeCode;
  readonly toolCount: number;
  readonly readOnlyToolVerified: boolean;
  readonly mcpErrorCode?: number;
  readonly peerRejection?: { readonly reason: string; readonly timestamp: string };
}

class BridgeError extends Error {
  constructor(readonly code: CodexDesktopBridgeCode, readonly rpcCode?: number) { super(code); }
}

function stringMap(value: unknown): Record<string, string> {
  const result = codexRecord(value);
  if (!result || Object.values(result).some(item => typeof item !== "string")) throw new BridgeError("invalid_binding");
  return result as Record<string, string>;
}

/** Uses the original bundled launcher and its environment whitelist. It never opens the private pipe itself. */
export function codexDesktopLaunch(binding: CodexDesktopBinding, env = process.env): CodexDesktopLaunch {
  try {
    if (process.platform === "win32" || ![binding.pluginRoot, binding.nodePath, binding.pipePath].every(isAbsolute)) {
      throw new BridgeError("invalid_binding");
    }
    const pipe = lstatSync(binding.pipePath);
    if (!pipe.isSocket() || pipe.uid !== process.getuid?.() || (pipe.mode & 0o077) !== 0) throw new BridgeError("invalid_binding");
    if (!statSync(binding.nodePath).isFile()) throw new BridgeError("invalid_binding");
    accessSync(binding.nodePath, constants.X_OK);
    const root = realpathSync(binding.pluginRoot);
    const manifest = codexRecord(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")));
    const server = codexRecord(codexRecord(manifest?.mcpServers)?.codex_app);
    if (!server || typeof server.command !== "string" || server.url !== undefined ||
      !Array.isArray(server.args) || server.args.some(arg => typeof arg !== "string") ||
      (server.cwd !== undefined && typeof server.cwd !== "string") ||
      !Array.isArray(server.env_vars) || server.env_vars.some(name => typeof name !== "string")) {
      throw new BridgeError("invalid_binding");
    }
    const command = realpathSync(resolve(root, server.command));
    const cwd = realpathSync(resolve(root, typeof server.cwd === "string" ? server.cwd : "."));
    if ([command, cwd].some(path => { const rel = relative(root, path); return rel === ".." || rel.startsWith("../") || isAbsolute(rel); })) {
      throw new BridgeError("invalid_binding");
    }
    const forwarded: Record<string, string> = {};
    for (const key of server.env_vars as string[]) if (env[key] !== undefined) forwarded[key] = env[key]!;
    return { command, args: server.args as string[], cwd, env: {
      ...forwarded, ...stringMap(server.env ?? {}),
      CODEX_APP_TOOLS_PIPE_PATH: binding.pipePath, CODEX_MCP_NODE_PATH: binding.nodePath,
    } };
  } catch { throw new BridgeError("invalid_binding"); }
}

class DesktopMcpClient {
  private child?: ChildProcessWithoutNullStreams;
  private readonly buffer: JsonLineBuffer;
  private nextId = 0;
  private failure?: BridgeError;
  private readonly deadline: number;
  private readonly pending = new Map<number, { resolve(value: CodexRecord): void; reject(error: BridgeError): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly abort = () => this.fail(new BridgeError("cancelled"));

  constructor(private readonly launch: CodexDesktopLaunch, timeoutMs: number, maxResponseBytes: number, private readonly signal?: AbortSignal) {
    this.deadline = Date.now() + timeoutMs;
    this.buffer = new JsonLineBuffer(maxResponseBytes);
  }

  async initialize(): Promise<void> {
    if (this.signal?.aborted) throw new BridgeError("cancelled");
    this.child = spawn(this.launch.command, [...this.launch.args], { cwd: this.launch.cwd, env: { ...this.launch.env }, stdio: "pipe" });
    this.child.on("error", () => this.fail(new BridgeError("process_unavailable")));
    this.child.on("exit", () => this.fail(new BridgeError("transport_closed")));
    this.child.stdin.on("error", () => this.fail(new BridgeError("transport_closed")));
    this.child.stdout.on("data", chunk => this.receive(Buffer.from(chunk)));
    this.child.stderr.resume();
    this.signal?.addEventListener("abort", this.abort, { once: true });
    const result = await this.request("initialize", { protocolVersion: MCP_LATEST_PROTOCOL_VERSION,
      capabilities: {}, clientInfo: { name: "rolebox_desktop_bridge", version: "1.0.0" } });
    if (!(MCP_PROTOCOL_VERSIONS as readonly unknown[]).includes(result.protocolVersion)) throw new BridgeError("invalid_protocol");
    this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  request(method: string, params: CodexRecord): Promise<CodexRecord> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new BridgeError("timeout")), Math.max(1, this.deadline - Date.now()));
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async close(): Promise<void> {
    this.signal?.removeEventListener("abort", this.abort);
    this.fail(new BridgeError("transport_closed"));
    const child = this.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 500);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.once("error", () => { clearTimeout(timer); resolve(); });
    });
  }

  private write(message: CodexRecord): void {
    let text: string;
    try { text = `${JSON.stringify(message)}\n`; }
    catch { this.fail(new BridgeError("invalid_request")); return; }
    try { this.child!.stdin.write(text); }
    catch { this.fail(new BridgeError("transport_closed")); }
  }

  private receive(chunk: Buffer): void {
    if (this.failure) return;
    try { this.buffer.write(chunk, bytes => {
      if (this.failure) return false;
      const line = bytes.toString("utf8");
      if (!line.trim()) return;
      try {
        const message = codexRecord(JSON.parse(line));
        if (!message || message.jsonrpc !== "2.0") throw new BridgeError("invalid_protocol");
        if (typeof message.method === "string") {
          if (message.id !== undefined) this.write({ jsonrpc: "2.0", id: message.id,
            ...(message.method === "ping" ? { result: {} } : { error: { code: -32601, message: "Desktop bridge probe cannot grant interactive requests" } }) });
          return;
        }
        if (typeof message.id !== "number") throw new BridgeError("invalid_protocol");
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        const error = codexRecord(message.error);
        const result = codexRecord(message.result);
        if (error) {
          const detail = typeof error.message === "string" ? error.message : "";
          const code = /(?:pipe|IPC|socket|connection).*clos/i.test(detail) ? "ipc_closed" :
            /missing.*(thread|turn|call|context)|did not provide.*(thread|turn|context)/i.test(detail) ? "host_context_missing" : "mcp_refused";
          pending.reject(new BridgeError(code, typeof error.code === "number" ? error.code : undefined));
        } else if (result) pending.resolve(result);
        else pending.reject(new BridgeError("invalid_protocol"));
      } catch { this.fail(new BridgeError("invalid_protocol")); return false; }
    }); } catch (error) { this.fail(new BridgeError(error instanceof JsonLineLimitError ? "response_too_large" : "invalid_protocol")); }
  }

  private fail(error: BridgeError): void {
    this.failure ??= error;
    this.buffer.clear();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.failure); }
    this.pending.clear();
    this.child?.kill("SIGTERM");
  }
}

function peerAudit(path: string | undefined) {
  const empty = { read: (): CodexDesktopBridgeResult["peerRejection"] => undefined, close() {} };
  if (!path) return empty;
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return empty; }
  try {
    const initial = fstatSync(fd, { bigint: true });
    if (!initial.isFile()) throw new Error();
    let offset = Number(initial.size);
    const lines = new JsonLineBuffer(DEFAULT_DESKTOP_BRIDGE_RESPONSE_BYTES);
    let found: CodexDesktopBridgeResult["peerRejection"];
    return {
      read() {
        try {
          const info = fstatSync(fd, { bigint: true });
          if (info.dev !== initial.dev || info.ino !== initial.ino || Number(info.size) < offset) return;
          const buffer = Buffer.alloc(Math.min(Number(info.size) - offset, 1024 * 1024));
          const count = readSync(fd, buffer, 0, buffer.length, offset); offset += count;
          lines.write(buffer.subarray(0, count), bytes => {
            const line = bytes.toString("utf8");
            if (!line.includes("dynamic_app_tools_peer_rejected")) return;
            const reason = /\breason="?([a-zA-Z0-9_-]{1,120})(?=["\s]|$)/.exec(line)?.[1];
            const timestamp = /^\d{4}-\d\d-\d\dT[\d:.]+Z/.exec(line)?.[0];
            if (reason && timestamp) found ??= { reason, timestamp };
          });
          return found;
        } catch { return; }
      },
      close() { closeSync(fd); },
    };
  } catch { closeSync(fd); return empty; }
}

function readThreadVerified(result: CodexRecord, threadId: string): boolean {
  if (result.isError === true) return false;
  if (codexRecord(codexRecord(result.structuredContent)?.thread)?.id === threadId) return true;
  if (!Array.isArray(result.content)) return false;
  return result.content.some(item => {
    const content = codexRecord(item);
    if (content?.type !== "text" || typeof content.text !== "string") return false;
    try { return codexRecord(codexRecord(JSON.parse(content.text))?.thread)?.id === threadId; }
    catch { return false; }
  });
}

/** Proves the original desktop MCP can read this loaded chat before any host configuration is changed. */
export async function probeCodexDesktopBridge(options: CodexDesktopBridgeOptions): Promise<CodexDesktopBridgeResult> {
  let stage: CodexDesktopBridgeStage = "parent";
  let toolCount = 0;
  let client: DesktopMcpClient | undefined;
  let result: CodexDesktopBridgeResult;
  let audit: ReturnType<typeof peerAudit> | undefined;
  try {
    if (!options.threadId || !(await options.parent.inspect(options.threadId)).available) throw new BridgeError("parent_unavailable");
    if (options.signal?.aborted) throw new BridgeError("cancelled");
    stage = "binding";
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new BridgeError("invalid_timeout");
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_DESKTOP_BRIDGE_RESPONSE_BYTES;
    if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 100 * 1024 * 1024) {
      throw new BridgeError("invalid_response_limit");
    }
    client = new DesktopMcpClient(codexDesktopLaunch(options.binding, options.env), timeoutMs, maxResponseBytes, options.signal);
    stage = "initialize";
    audit = peerAudit(options.peerLogPath);
    await client.initialize();
    stage = "tools/list";
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let readTool: CodexRecord | undefined;
    do {
      const page = await client.request("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(page.tools) || page.tools.some(tool => typeof codexRecord(tool)?.name !== "string")) throw new BridgeError("invalid_protocol");
      toolCount += page.tools.length;
      readTool ??= page.tools.map(codexRecord).find(tool => tool?.name === "read_thread");
      if (page.nextCursor != null && typeof page.nextCursor !== "string") throw new BridgeError("invalid_protocol");
      cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
      if (cursor && (cursors.has(cursor) || cursors.size >= 64)) throw new BridgeError("invalid_protocol");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (!readTool) throw new BridgeError("read_tool_unavailable");
    stage = "tools/call";
    const properties = codexRecord(codexRecord(readTool.inputSchema)?.properties);
    if (!properties?.threadId) throw new BridgeError("read_tool_unavailable");
    const arguments_: CodexRecord = { threadId: options.threadId,
      ...(properties.turnLimit ? { turnLimit: 1 } : {}), ...(properties.includeOutputs ? { includeOutputs: false } : {}) };
    const response = await client.request("tools/call", { name: "read_thread", arguments: arguments_,
      ...(options.hostMeta ? { _meta: options.hostMeta } : {}) });
    if (!readThreadVerified(response, options.threadId)) throw new BridgeError("read_result_unverified");
    result = { status: "ready", stage, code: "verified", toolCount, readOnlyToolVerified: true };
  } catch (error) {
    const failure = error instanceof BridgeError ? error : new BridgeError(stage === "parent" ? "parent_unavailable" : "probe_failed");
    result = { status: "blocked", stage, code: failure.code, toolCount, readOnlyToolVerified: false,
      ...(failure.rpcCode !== undefined ? { mcpErrorCode: failure.rpcCode } : {}) };
  } finally { await client?.close(); }
  try {
    if (audit && result.status === "blocked" && ["initialize", "tools/list"].includes(stage) &&
      ["ipc_closed", "transport_closed", "mcp_refused"].includes(result.code)) {
      const deadline = Date.now() + 500;
      do {
        const peerRejection = audit.read();
        if (peerRejection) return { ...result, code: "peer_rejected", peerRejection };
        if (options.signal?.aborted) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
    }
    return result;
  } finally { audit?.close(); }
}
