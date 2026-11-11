import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { CodexExecutor } from "./executor.ts";

export type CodexRecord = Record<string, unknown>;

export function codexRecord(value: unknown): CodexRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as CodexRecord : undefined;
}

export interface CodexLaunchAuthority {
  readonly threadId: string;
  readonly executable: string;
  readonly sandboxState: string;
  readonly key: string;
}

/** Preserve the host's opaque sandbox state, including fields this version does not know. */
export function codexLaunchAuthority(meta: CodexRecord | undefined): CodexLaunchAuthority | undefined {
  const threadId = meta?.threadId;
  const executable = codexRecord(meta?.["codex/sandbox-launcher"])?.codexExecutable;
  const state = meta?.["codex/sandbox-state"];
  if (typeof threadId !== "string" || !threadId || typeof executable !== "string" ||
    !isAbsolute(executable) || codexRecord(state) === undefined) return undefined;
  const sandboxState = JSON.stringify(state);
  return {
    threadId, executable, sandboxState,
    key: createHash("sha256").update(JSON.stringify([threadId, executable, sandboxState])).digest("hex"),
  };
}

export interface CodexRpc {
  request(method: string, params?: CodexRecord): Promise<CodexRecord>;
  onNotification(listener: (method: string, params: CodexRecord) => void): () => void;
  setRequestHandler(handler: (method: string, params: CodexRecord) => Promise<unknown>): void;
  close(): void;
}

export interface CodexAppServerOptions {
  command?: string;
  args?: readonly string[];
  cwd: string;
  requestTimeoutMs?: number;
  handleElicitation?: (params: CodexRecord) => Promise<CodexRecord>;
  launchAuthority?: CodexLaunchAuthority;
  spawnProcess?: (command: string, args: readonly string[], options: { cwd: string }) => ChildProcessWithoutNullStreams;
}

const ISOLATION_ARGS = ["-c", "features.plugins=false"];

export function codexAppServerOptions(cwd: string, authority?: CodexLaunchAuthority): CodexAppServerOptions {
  const command = authority?.executable ?? (process.env.ROLEBOX_CODEX_COMMAND?.trim() || "codex");
  const appServer = ["app-server", "--listen", "stdio://", ...ISOLATION_ARGS];
  return {
    cwd, command,
    args: appServer,
    ...(authority ? { launchAuthority: authority } : {}),
  };
}

interface PendingRequest {
  resolve(value: CodexRecord): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** A lazy stdio connection. A lost connection is never silently restarted during a dispatch. */
export class CodexAppServerClient implements CodexRpc {
  private process?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private failure?: Error;
  private nextId = 0;
  private buffer = "";
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(method: string, params: CodexRecord) => void>();
  private handler?: (method: string, params: CodexRecord) => Promise<unknown>;
  private stopping = false;
  private executor?: CodexExecutor;

  constructor(private readonly options: CodexAppServerOptions) {}

  async request(method: string, params: CodexRecord = {}): Promise<CodexRecord> {
    await (this.ready ??= this.start());
    const execute = this.executor && (method === "thread/start" || method === "turn/start");
    const result = await this.send(method, execute ? {
      ...params, environments: [{ environmentId: this.executor!.id, cwd: this.options.cwd }],
      ...(method === "turn/start" ? { sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" } } : {}),
    } : method === "thread/fork" && this.executor ? { ...params, deferGoalContinuation: true } : params);
    if (method === "thread/start" && this.executor) {
      const environments = codexRecord(result.thread)?.environments;
      if (!Array.isArray(environments) || environments.length !== 1 || codexRecord(environments[0])?.environmentId !== this.executor.id) {
        this.fail(new Error("Codex did not bind the worker to its sandboxed executor"));
        throw this.failure;
      }
    }
    return result;
  }

  onNotification(listener: (method: string, params: CodexRecord) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  setRequestHandler(handler: (method: string, params: CodexRecord) => Promise<unknown>): void {
    this.handler = handler;
  }

  close(): void {
    this.fail(new Error("Codex app-server connection closed"));
    this.listeners.clear();
    this.process?.stdin.end();
    this.executor?.close();
    this.stopChild();
  }

  private stopChild(): void {
    if (this.stopping) return;
    this.stopping = true;
    const child = this.process;
    if (child && child.exitCode === null) {
      this.signalChild(child, "SIGTERM");
      const timer = setTimeout(() => { this.signalChild(child, "SIGKILL"); }, 1000);
      timer.unref();
      if (process.platform === "win32" || this.options.spawnProcess) child.once("exit", () => clearTimeout(timer));
    }
  }

  private signalChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    if (process.platform === "win32" && !this.options.spawnProcess && child.pid) {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on("error", () => { if (child.exitCode === null) child.kill(signal); });
      return;
    }
    if (process.platform !== "win32" && !this.options.spawnProcess && child.pid) {
      try { process.kill(-child.pid, signal); return; } catch { /* The process group may already have exited. */ }
    }
    if (child.exitCode === null) child.kill(signal);
  }

  private async start(): Promise<void> {
    if (this.failure) throw this.failure;
    const command = this.options.command ?? "codex";
    const args = this.options.args ?? ["app-server", "--listen", "stdio://", ...ISOLATION_ARGS];
    const child = this.options.spawnProcess?.(command, args, { cwd: this.options.cwd }) ??
      spawn(command, [...args], { cwd: this.options.cwd, stdio: "pipe", windowsHide: true, detached: process.platform !== "win32" });
    this.process = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.stderr.resume();
    child.stdin.on("error", () => this.fail(new Error("Codex app-server input closed")));
    child.on("error", () => this.fail(new Error("Could not start Codex app-server. Install a current Codex CLI or set ROLEBOX_CODEX_COMMAND.")));
    child.on("exit", (code, signal) => this.fail(new Error(`Codex app-server exited (${signal ?? code ?? "unknown"})`)));
    try {
      await this.send("initialize", {
        clientInfo: { name: "rolebox", title: "rolebox", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
      this.write({ method: "initialized" });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("Codex app-server initialization failed"));
      throw this.failure;
    }
    if (this.options.launchAuthority) {
      this.executor = new CodexExecutor({ cwd: this.options.cwd, authority: this.options.launchAuthority,
        onFailure: () => this.fail(new Error("Codex sandboxed executor connection lost")),
      });
      try {
        const url = await this.executor.listen();
        await this.send("environment/add", { environmentId: this.executor.id, execServerUrl: url, authBearerToken: this.executor.token });
      } catch {
        this.fail(new Error("Could not initialize Codex's sandboxed executor. Update Codex; local execution fallback is disabled."));
        throw this.failure;
      }
    }
  }

  private send(method: string, params: CodexRecord): Promise<CodexRecord> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.options.requestTimeoutMs ?? 30_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch { this.fail(new Error("Codex app-server input unavailable")); }
    });
  }

  private write(message: CodexRecord): void {
    if (this.failure) throw this.failure;
    if (!this.process?.stdin.writable) throw new Error("Codex app-server input unavailable");
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }

  private receive(chunk: string): void {
    if (this.failure) return;
    this.buffer += chunk;
    if (this.buffer.length > 16 * 1024 * 1024) {
      this.fail(new Error("Codex app-server message exceeded the transport limit"));
      this.process?.kill();
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message: CodexRecord | undefined;
      try { message = codexRecord(JSON.parse(line)); }
      catch { this.fail(new Error("Codex app-server returned invalid JSON")); return; }
      if (!message) { this.fail(new Error("Codex app-server returned an invalid message")); return; }
      if (typeof message.method === "string") {
        const params = codexRecord(message.params) ?? {};
        if (message.id !== undefined) void this.answer(message.id, message.method, params);
        else for (const listener of this.listeners) {
          try { listener(message.method, params); } catch { /* An observer cannot break the transport. */ }
        }
      } else if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        const error = codexRecord(message.error);
        const result = codexRecord(message.result);
        if (("error" in message) === ("result" in message) || (!error && !result)) {
          pending.reject(new Error("Codex app-server returned an invalid response envelope"));
        } else if (error) pending.reject(new Error(`Codex app-server rejected the request (${String(error.code ?? "unknown")}): ${String(error.message ?? "request failed")}`));
        else pending.resolve(result!);
      }
    }
  }

  private async answer(id: unknown, method: string, params: CodexRecord): Promise<void> {
    try {
      if (method === "mcpServer/elicitation/request" && this.options.handleElicitation) {
        this.write({ id, result: await this.options.handleElicitation(params) });
        return;
      }
      if (method !== "item/tool/call" || !this.handler) {
        this.write({ id, error: { code: -32601, message: "rolebox cannot approve or answer this interactive request" } });
        return;
      }
      const result = await this.handler(method, params);
      this.write({ id, result });
    } catch {
      try { this.write({ id, error: { code: -32603, message: "rolebox dynamic tool call failed" } }); } catch { /* Connection already closed. */ }
    }
  }

  private fail(error: Error): void {
    const firstFailure = this.failure === undefined;
    this.failure ??= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
    if (firstFailure) for (const listener of this.listeners) {
      try { listener("rolebox/connectionClosed", {}); } catch { /* An observer cannot prevent cleanup. */ }
    }
    if (firstFailure) this.stopChild();
    if (firstFailure) this.executor?.close();
  }
}
