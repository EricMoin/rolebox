import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { CodexLaunchAuthority } from "./app-server.ts";

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export interface CodexExecutorOptions {
  cwd: string;
  authority: CodexLaunchAuthority;
  onFailure(): void;
  spawnProcess?: (command: string, args: readonly string[], options: { cwd: string }) => ChildProcessWithoutNullStreams;
}

/** Only execution/filesystem RPCs cross this relay; the model connection stays in app-server. */
export class CodexExecutor {
  readonly id: string;
  readonly token = randomBytes(32).toString("base64url");
  private readonly server = createServer((_request, response) => { response.writeHead(404).end(); });
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  private child?: ChildProcessWithoutNullStreams;
  private socket?: WebSocket;
  private claimed = false;
  private closed = false;

  constructor(private readonly options: CodexExecutorOptions) {
    this.id = `rolebox-${options.authority.key.slice(0, 32)}`;
    this.server.on("error", () => this.fail());
    this.sockets.on("error", () => this.fail());
    this.server.on("upgrade", (request, socket, head) => {
      socket.on("error", () => socket.destroy());
      const supplied = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${this.token}`);
      if (this.closed || this.claimed || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      this.claimed = true;
      this.sockets.handleUpgrade(request, socket, head, client => this.connect(client));
    });
  }

  async listen(): Promise<string> {
    if (this.closed) throw new Error("Codex executor closed");
    await new Promise<void>((resolveListen, reject) => {
      const onError = () => reject(new Error("Could not start the Codex executor relay"));
      this.server.once("error", onError);
      this.server.listen(0, "127.0.0.1", () => { this.server.removeListener("error", onError); resolveListen(); });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Codex executor has no loopback address");
    return `ws://127.0.0.1:${address.port}`;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket?.terminate();
    this.sockets.close();
    this.server.close();
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    const signal = (value: NodeJS.Signals) => {
      if (process.platform !== "win32" && !this.options.spawnProcess && child.pid) {
        try { process.kill(-child.pid, value); return; } catch { /* The process group already exited. */ }
      }
      if (process.platform === "win32" && !this.options.spawnProcess && child.pid) {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill(value));
      } else if (child.exitCode === null) child.kill(value);
    };
    signal("SIGTERM");
    const timer = setTimeout(() => signal("SIGKILL"), 1000);
    if (process.platform === "win32" || this.options.spawnProcess) child.once("exit", () => clearTimeout(timer));
  }

  private connect(socket: WebSocket): void {
    this.socket = socket;
    const { authority, cwd } = this.options;
    const args = ["sandbox", "--sandbox-state-json", authority.sandboxState, "--", authority.executable, "exec-server", "--listen", "stdio"];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.options.spawnProcess?.(authority.executable, args, { cwd }) ??
        spawn(authority.executable, args, { cwd, stdio: "pipe", windowsHide: true, detached: process.platform !== "win32" });
    } catch { this.fail(); return; }
    this.child = child;
    child.stderr.resume();
    child.on("error", () => this.fail());
    child.on("exit", () => this.fail());
    child.stdin.on("error", () => this.fail());
    socket.on("error", () => this.fail());
    socket.on("close", () => this.fail());
    socket.on("message", data => {
      try {
        if (child.stdin.writableLength > MAX_MESSAGE_BYTES) throw new Error("Invalid executor frame");
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid executor message");
        if (!child.stdin.write(JSON.stringify(value) + "\n")) socket.pause();
      } catch { this.fail(); }
    });
    child.stdin.on("drain", () => socket.resume());
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) { this.fail(); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_MESSAGE_BYTES) { this.fail(); return; }
        socket.send(line, error => {
          if (error) this.fail();
          else if (socket.bufferedAmount < 1024 * 1024) child.stdout.resume();
        });
        if (socket.bufferedAmount >= 1024 * 1024) child.stdout.pause();
      }
    });
  }

  private fail(): void {
    if (this.closed) return;
    this.close();
    this.options.onFailure();
  }
}
