import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createConnection } from "node:net";
import { WebSocket } from "ws";
import { graphNotificationText, type GraphNotification } from "../../../graph/application/graph-notifications.ts";
import { codexRecord, type CodexRecord } from "./app-server.ts";

export interface CodexParentNotificationStatus {
  readonly available: boolean;
  readonly reason: string;
}

export interface CodexParentNotificationRpc {
  request(method: string, params: CodexRecord): Promise<CodexRecord>;
  close(): void;
}

export interface CodexParentNotificationOptions {
  readonly codexHome?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly rpcFactory?: (socketPath: string) => CodexParentNotificationRpc;
}

/** Connects to an existing host only; it cannot start or resume another copy of a parent thread. */
export class CodexParentNotifications {
  readonly socketPath: string | undefined;
  private client?: CodexParentNotificationRpc;
  private closed = false;

  constructor(private readonly options: CodexParentNotificationOptions = {}) {
    const env = options.env ?? process.env;
    const configured = env.ROLEBOX_CODEX_PARENT_SOCKET?.trim();
    if (configured === "off") return;
    if (configured) {
      if (!isAbsolute(configured)) throw new Error("ROLEBOX_CODEX_PARENT_SOCKET must be an absolute socket path or off");
      this.socketPath = configured;
    } else {
      const root = options.codexHome ?? (env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
      const candidate = join(root, "app-server-control", "app-server-control.sock");
      if (existsSync(candidate)) this.socketPath = candidate;
    }
  }

  get configured(): boolean { return this.socketPath !== undefined; }

  async inspect(sessionId: string): Promise<CodexParentNotificationStatus> {
    if (this.closed || !this.socketPath || !sessionId) {
      return { available: false, reason: "No shared parent app-server connection is configured; use graph_wait." };
    }
    try {
      const client = this.client ??= this.options.rpcFactory?.(this.socketPath) ?? new CodexParentSocketClient(this.socketPath);
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = await client.request("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(result.data) || result.data.some(id => typeof id !== "string")) throw new Error("Invalid loaded thread inventory");
        if (result.data.includes(sessionId)) return { available: true, reason: "The parent is loaded in the shared app-server; graph notifications can start a new turn." };
        cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
        if (cursor && cursors.has(cursor)) throw new Error("Repeated loaded thread cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return { available: false, reason: "The shared app-server does not own this loaded parent thread; use graph_wait." };
    } catch {
      this.client?.close();
      this.client = undefined;
      return { available: false, reason: "The shared parent app-server is unavailable; use graph_wait." };
    }
  }

  async send(notification: GraphNotification): Promise<boolean> {
    if (!(await this.inspect(notification.sessionId)).available || !this.client) return false;
    try {
      const result = await this.client.request("turn/start", {
        threadId: notification.sessionId,
        input: [],
        toolOutput: { name: "graph_notification", namespace: "rolebox", output: graphNotificationText(notification) },
      });
      const turnId = codexRecord(result.turn)?.id;
      return typeof turnId === "string" && turnId.length > 0;
    } catch { return false; }
  }

  close(): void {
    this.closed = true;
    this.client?.close();
    this.client = undefined;
  }
}

/** JSON-RPC over the host's Unix WebSocket; closing it never shuts down the shared host. */
export class CodexParentSocketClient implements CodexParentNotificationRpc {
  private socket?: WebSocket;
  private ready?: Promise<void>;
  private failure?: Error;
  private nextId = 0;
  private readonly pending = new Map<number, {
    method: string;
    resolve(value: CodexRecord): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly socketPath: string, private readonly timeoutMs = 5_000) {}

  async request(method: string, params: CodexRecord): Promise<CodexRecord> {
    await (this.ready ??= this.connect());
    return this.send(method, params);
  }

  close(): void { this.fail(new Error("Parent app-server connection closed")); }

  private async connect(): Promise<void> {
    if (this.failure) throw this.failure;
    const socket = this.socket = new WebSocket("ws://localhost/", {
      createConnection: () => createConnection({ path: this.socketPath }),
      handshakeTimeout: this.timeoutMs, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false,
    });
    socket.on("message", data => this.receive(data.toString()));
    socket.on("error", () => this.fail(new Error("Parent app-server connection failed")));
    socket.on("close", () => this.fail(new Error("Parent app-server connection closed")));
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
        socket.once("close", () => reject(new Error("Parent app-server closed before initialization")));
      });
      await this.send("initialize", { clientInfo: { name: "rolebox_notifications", version: "1.0.0" }, capabilities: { experimentalApi: true } });
      socket.send(JSON.stringify({ method: "initialized" }));
    } catch {
      this.fail(new Error("Parent app-server initialization failed"));
      throw this.failure;
    }
  }

  private send(method: string, params: CodexRecord): Promise<CodexRecord> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Parent app-server request timed out"));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.socket!.send(JSON.stringify({ id, method, params })); }
      catch { this.fail(new Error("Parent app-server input unavailable")); }
    });
  }

  private receive(text: string): void {
    try {
      const message = codexRecord(JSON.parse(text));
      if (!message) throw new Error("Invalid parent app-server message");
      if (typeof message.method === "string") {
        if (message.id !== undefined) this.socket?.send(JSON.stringify({ id: message.id,
          error: { code: -32601, message: "rolebox notifications cannot answer interactive requests" } }));
        return;
      }
      if (typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      const result = codexRecord(message.result);
      if (result && message.error === undefined) pending.resolve(result);
      else pending.reject(new Error(`Parent app-server refused ${pending.method} (code ${String(codexRecord(message.error)?.code ?? "unknown")})`));
    } catch { this.fail(new Error("Invalid parent app-server response")); }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(this.failure); }
    this.pending.clear();
    this.socket?.terminate();
  }
}
