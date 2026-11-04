import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { LspServerState } from "../../src/lsp/types.ts";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => ({ ...await vi.importActual<typeof import("node:child_process")>("node:child_process"), spawn }));
import { LspClientManager } from "../../src/lsp/client-manager.ts";

function child(options: { initialize?: "fail" | "hang"; ignoreTerm?: boolean; hangRequests?: boolean } = {}) {
  const process = Object.assign(new EventEmitter(), {
    pid: 12345, exitCode: null as number | null, signalCode: null as string | null,
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: { write: vi.fn<(text: string) => void>() },
    kill: vi.fn<(signal?: string) => boolean>(),
  });
  function response(id: number, result: unknown, error?: object) {
    queueMicrotask(() => {
      const body = JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) });
      process.stdout.emit("data", Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
    });
  }
  process.stdin.write.mockImplementation(text => {
    const message = JSON.parse(text.split("\r\n\r\n")[1]!) as { id?: number; method: string };
    if (message.id === undefined) return;
    if (message.method === "initialize") {
      if (options.initialize === "hang") return;
      if (options.initialize === "fail") response(message.id, null, { code: -32000, message: "Initialization failed" });
      else response(message.id, { capabilities: { hoverProvider: true } });
    } else if (message.method === "shutdown" || !options.hangRequests) response(message.id, null);
  });
  process.kill.mockImplementation((signal = "SIGTERM") => {
    if (options.ignoreTerm && signal === "SIGTERM") return true;
    process.signalCode = signal;
    process.emit("exit", null, signal);
    return true;
  });
  return process;
}

beforeEach(() => { vi.useFakeTimers(); spawn.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("LSP process lifecycle failures", () => {
  it("clears a spawn error and ignores the failed child's late output after recovery", async () => {
    const failed = child({ initialize: "hang" });
    failed.pid = 0;
    spawn.mockImplementationOnce(() => {
      queueMicrotask(() => failed.emit("error", new Error("ENOENT")));
      return failed;
    });
    const manager = new LspClientManager("/tmp");
    await expect(manager.startServer("typescript")).rejects.toThrow("ENOENT");
    expect(manager.servers.size).toBe(0);
    spawn.mockReturnValue(child());
    await manager.startServer("typescript");
    const body = JSON.stringify({ method: "textDocument/publishDiagnostics", params: { uri: "file:///late.ts", diagnostics: [] } });
    failed.stdout.emit("data", Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
    expect(manager.getAllDiagnostics().size).toBe(0);
    expect(manager.servers.get("typescript")!.restartCount).toBe(0);
    await manager.shutdownAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for SIGKILL when initialize fails and SIGTERM is ignored", async () => {
    const process = child({ initialize: "fail", ignoreTerm: true });
    spawn.mockReturnValue(process);
    const manager = new LspClientManager("/tmp");
    const failed = expect(manager.startServer("typescript")).rejects.toThrow("Initialization failed");
    await vi.advanceTimersByTimeAsync(0);
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    expect(manager.servers.size).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    await failed;
    expect(process.kill).toHaveBeenCalledWith("SIGKILL");
    expect(manager.servers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("terminates and clears a server whose initialize request times out", async () => {
    const process = child({ initialize: "hang", ignoreTerm: true });
    spawn.mockReturnValue(process);
    const manager = new LspClientManager("/tmp");
    const failed = expect(manager.startServer("typescript")).rejects.toThrow("Request timed out");
    await vi.advanceTimersByTimeAsync(30000);
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(2000);
    await failed;
    expect(process.kill).toHaveBeenCalledWith("SIGKILL");
    expect(manager.getRunningServers()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears bookkeeping and termination listeners when kill throws", async () => {
    const process = child();
    spawn.mockReturnValue(process);
    const manager = new LspClientManager("/tmp");
    await manager.startServer("typescript");
    const failure = new Error("Cannot signal process");
    process.kill.mockImplementation(() => { throw failure; });
    await expect(manager.shutdown("typescript")).rejects.toBe(failure);
    expect(manager.servers.size).toBe(0);
    expect(process.listenerCount("exit")).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not accumulate crashes across successful initializations", async () => {
    spawn.mockImplementation(() => child());
    const manager = new LspClientManager("/tmp");
    for (let index = 0; index < 5; index++) {
      await manager.startServer("typescript");
      const state = manager.servers.get("typescript")!;
      expect(state.restartCount).toBe(0);
      state.process.exitCode = 1;
      state.process.emit("exit", 1, null);
    }
    expect(spawn).toHaveBeenCalledTimes(5);
    await manager.shutdownAll();
  });

  it("limits consecutive startup failures and permits an explicit restart", async () => {
    spawn.mockImplementation(() => child({ initialize: "fail" }));
    const manager = new LspClientManager("/tmp");
    for (let index = 0; index < 3; index++) await expect(manager.startServer("typescript")).rejects.toThrow("Initialization failed");
    await expect(manager.startServer("typescript")).rejects.toThrow("exceeded max restart attempts");
    expect(spawn).toHaveBeenCalledTimes(3);
    spawn.mockImplementation(() => child());
    await manager.restartServer("typescript");
    expect(manager.servers.get("typescript")!.restartCount).toBe(0);
    await manager.shutdownAll();
  });

  it("joins shutdown during initialization and prevents a replacement spawn until cleanup completes", async () => {
    const process = child({ initialize: "hang", ignoreTerm: true });
    spawn.mockReturnValue(process);
    const manager = new LspClientManager("/tmp");
    const start = expect(manager.startServer("typescript")).rejects.toThrow("shutting down");
    const stop = manager.shutdown("typescript");
    expect(manager.shutdown("typescript")).toBe(stop);
    await expect(manager.startServer("typescript")).rejects.toThrow("shutting down");
    await vi.advanceTimersByTimeAsync(2000);
    await stop;
    await start;
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(manager.servers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels in-flight requests and refuses new requests during shutdown", async () => {
    spawn.mockReturnValue(child({ hangRequests: true, ignoreTerm: true }));
    const manager = new LspClientManager("/tmp");
    await manager.startServer("typescript");
    const request = expect(manager.request("test/hang", {}, "typescript")).rejects.toThrow("shutting down");
    const stop = manager.shutdown("typescript");
    await expect(manager.request("test/new", {}, "typescript")).rejects.toThrow("shutting down");
    await vi.advanceTimersByTimeAsync(2000);
    await request;
    await stop;
    expect(manager.servers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("diagnostic availability", () => {
  function fixture(capabilities: object = {}) {
    const manager = new LspClientManager("/tmp");
    const state: LspServerState = { languageId: "typescript", process: null, capabilities, status: "running",
      startedAt: new Date(), pendingRequests: new Map(), diagnosticCache: new Map(), documentVersions: new Map([["file:///file.ts", 1]]), restartCount: 0 };
    manager.servers.set("typescript", state);
    return { manager, state, uri: "file:///file.ts" };
  }

  it("returns unavailable and suppresses repeated waits for the same version", async () => {
    const { manager, state, uri } = fixture();
    const wait = vi.spyOn(manager, "waitForDiagnostics");
    const first = manager.readDiagnostics(uri, "typescript", 10);
    await vi.advanceTimersByTimeAsync(10);
    await expect(first).resolves.toBeUndefined();
    await expect(manager.readDiagnostics(uri, "typescript", 10)).resolves.toBeUndefined();
    expect(wait).toHaveBeenCalledTimes(1);
    state.diagnosticCache.set(uri, []);
    await expect(manager.readDiagnostics(uri, "typescript")).resolves.toEqual([]);
  });

  it("retries after the document version changes or the cooldown expires", async () => {
    const { manager, state, uri } = fixture();
    const wait = vi.spyOn(manager, "waitForDiagnostics");
    let pending = manager.readDiagnostics(uri, "typescript", 10);
    await vi.advanceTimersByTimeAsync(10); await pending;
    state.documentVersions!.set(uri, 2);
    pending = manager.readDiagnostics(uri, "typescript", 10);
    await vi.advanceTimersByTimeAsync(10); await pending;
    await vi.advanceTimersByTimeAsync(30000);
    pending = manager.readDiagnostics(uri, "typescript", 10);
    await vi.advanceTimersByTimeAsync(10); await pending;
    expect(wait).toHaveBeenCalledTimes(3);
  });

  it("uses pull diagnostics when advertised and retains an explicitly empty result", async () => {
    const { manager, uri } = fixture({ diagnosticProvider: {} });
    const request = vi.spyOn(manager, "request").mockResolvedValue({ kind: "full", items: [] });
    await expect(manager.readDiagnostics(uri, "typescript")).resolves.toEqual([]);
    expect(request).toHaveBeenCalledWith("textDocument/diagnostic", { textDocument: { uri } }, "typescript", 5000);
    await expect(manager.readDiagnostics(uri, "typescript")).resolves.toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("drops closed documents from aggregate diagnostics and ignores late publications", async () => {
    const { manager, state, uri } = fixture();
    state.closedDocuments = new Set();
    state.diagnosticCache.set(uri, []);
    manager.forgetDocument(uri);
    expect(manager.getAllDiagnostics().size).toBe(0);
    expect(state.documentVersions!.has(uri)).toBe(false);
    expect(state.closedDocuments.has(uri)).toBe(true);
  });
});
