import { closeSync, writeSync } from "node:fs";
import { createConnection } from "node:net";
import { WebSocket } from "ws";
import { desktopLauncherEvent, readPreparedCodexDesktopLauncher, type PreparedCodexDesktopLauncher } from "./launcher.ts";
import { JsonLineBuffer, JsonLineLimitError } from "./jsonl-buffer.ts";

/** Wait for every frame's write callback before queueing another fragment. */
export async function sendDesktopMessage(socket: Pick<WebSocket, "send">, message: Buffer): Promise<void> {
  const frameBytes = 1024 * 1024;
  for (let offset = 0; offset < message.length; offset += frameBytes) {
    await new Promise<void>((resolve, reject) => socket.send(message.subarray(offset, offset + frameBytes),
      { binary: false, fin: offset + frameBytes >= message.length }, error => error ? reject(error) : resolve()));
  }
}

/** Relays only app-server protocol bytes; desktop IPC and MCP remain in the original host. */
export async function runCodexDesktopRelay(configPath: string, parentPid: number): Promise<void> {
  const config = readPreparedCodexDesktopLauncher(configPath);
  if (!Number.isSafeInteger(parentPid) || parentPid <= 1 || process.ppid !== parentPid) throw new Error("invalid_relay_parent");
  await new DesktopRelay(config, parentPid).run();
}

class DesktopRelay {
  private readonly config: PreparedCodexDesktopLauncher;
  private readonly parentPid: number;
  private socket?: WebSocket;
  private readonly input: JsonLineBuffer;
  private lines: Buffer[] = [];
  private flushing = false;
  private stopped = false;
  private connected = false;
  private ready = false;
  private resolveDone?: () => void;
  private retry?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  private readonly deadline: number;
  private readonly inputData = (chunk: Buffer) => this.receiveInput(chunk);
  private readonly inputEnd = () => this.stop("desktop_input_ended", true);
  private readonly inputError = () => this.stop("desktop_input_error", true);
  private readonly outputError = () => this.stop("desktop_output_error", true);
  private readonly outputDrain = () => this.socket?.resume();
  private readonly terminate = () => this.stop("relay_terminated", true);
  private readonly fatal = () => this.stop(this.ready ? "relay_runtime_failed" : "relay_startup_failed", this.ready);

  constructor(config: PreparedCodexDesktopLauncher, parentPid: number) {
    this.config = config; this.parentPid = parentPid;
    this.input = new JsonLineBuffer(config.maxMessageBytes);
    this.deadline = Date.now() + config.startupTimeoutMs;
  }

  async run(): Promise<void> {
    process.stdin.pause();
    process.stdin.on("data", this.inputData); process.stdin.on("end", this.inputEnd); process.stdin.on("error", this.inputError);
    process.stdout.on("error", this.outputError); process.stdout.on("drain", this.outputDrain);
    process.on("SIGTERM", this.terminate); process.on("SIGINT", this.terminate);
    process.on("uncaughtException", this.fatal); process.on("unhandledRejection", this.fatal);
    try {
      await new Promise<void>(resolve => {
        this.resolveDone = resolve;
        try {
          writeSync(3, "ready\n"); closeSync(3); this.ready = true;
          this.watchdog = setInterval(() => {
            if (process.ppid !== this.parentPid) this.stop("native_parent_exited", false);
            else if (!this.connected && Date.now() >= this.deadline) this.stop("host_startup_timeout", true);
          }, 100);
          this.connect();
        } catch { this.fatal(); }
      });
    } finally {
      process.stdin.off("data", this.inputData); process.stdin.off("end", this.inputEnd); process.stdin.off("error", this.inputError);
      process.stdout.off("error", this.outputError); process.stdout.off("drain", this.outputDrain);
      process.off("SIGTERM", this.terminate); process.off("SIGINT", this.terminate);
      process.off("uncaughtException", this.fatal); process.off("unhandledRejection", this.fatal);
      process.stdin.destroy();
    }
  }

  private connect(): void {
    if (this.stopped) return;
    if (Date.now() >= this.deadline) { this.stop("host_startup_timeout", true); return; }
    let socket: WebSocket;
    try {
      socket = this.socket = new WebSocket("ws://localhost/", { createConnection: () => createConnection(this.config.socketPath),
        perMessageDeflate: false, handshakeTimeout: Math.max(1, this.deadline - Date.now()), maxPayload: this.config.maxMessageBytes });
    } catch { this.fatal(); return; }
    let opened = false;
    socket.on("open", () => {
      if (this.stopped) { socket.terminate(); return; }
      opened = true; this.connected = true;
      desktopLauncherEvent(this.config, "relay_connected", { pid: process.pid, hostPid: this.parentPid });
      void this.flushInput();
    });
    socket.on("message", (data, binary) => {
      if (this.stopped) return;
      if (binary) { this.stop("unexpected_binary_message", true); return; }
      try { if (!process.stdout.write(`${data.toString()}\n`)) socket.pause(); }
      catch { this.fatal(); }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.stopped) return;
      if (opened) this.stop("host_connection_closed", true);
      else this.retry = setTimeout(() => this.connect(), 50);
    });
  }

  private receiveInput(chunk: Buffer): void {
    if (this.stopped) return;
    process.stdin.pause();
    try {
      this.input.write(chunk, line => {
        if (!line.every(byte => byte === 32 || byte === 9 || byte === 13)) this.lines.push(line);
      });
    } catch (error) {
      this.stop(error instanceof JsonLineLimitError ? "desktop_input_limit" : "relay_runtime_failed", true); return;
    }
    void this.flushInput();
  }

  private async flushInput(): Promise<void> {
    const socket = this.socket;
    if (this.stopped || this.flushing || !socket || socket.readyState !== WebSocket.OPEN) return;
    this.flushing = true;
    try {
      for (const line of this.lines) {
        if (this.stopped) return;
        await sendDesktopMessage(socket, line);
      }
      this.lines = [];
    } catch { this.stop("host_send_failed", true); }
    finally {
      this.flushing = false;
      if (!this.stopped) process.stdin.resume();
    }
  }

  private stop(event: string, stopParent: boolean): void {
    if (this.stopped) return;
    this.stopped = true;
    desktopLauncherEvent(this.config, event, { pid: process.pid, hostPid: this.parentPid });
    if (this.retry) clearTimeout(this.retry);
    if (this.watchdog) clearInterval(this.watchdog);
    this.input.clear(); this.lines = [];
    process.stdin.destroy(); this.socket?.terminate();
    if (!["desktop_input_ended", "relay_terminated", "native_parent_exited"].includes(event)) process.exitCode = 1;
    if (stopParent && process.ppid === this.parentPid) {
      try { process.kill(this.parentPid, "SIGTERM"); } catch { this.resolveDone?.(); return; }
      const killTimer = setTimeout(() => {
        if (process.ppid !== this.parentPid) return;
        try {
          process.kill(this.parentPid, "SIGKILL");
          desktopLauncherEvent(this.config, "host_sigkill", { hostPid: this.parentPid });
        } catch { /* The original host may have already exited. */ }
      }, 500);
      const ended = setInterval(() => {
        if (process.ppid === this.parentPid) return;
        clearTimeout(killTimer); clearInterval(ended); this.resolveDone?.();
      }, 25);
    } else this.resolveDone?.();
  }
}
