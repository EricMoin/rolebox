import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { CodexExecutor } from "../../../../../src/platform/adapters/codex/app-server/executor.ts";
import { codexLaunchAuthority } from "../../../../../src/platform/adapters/codex/app-server/app-server.ts";

const executors: CodexExecutor[] = [];
const sockets: WebSocket[] = [];
const directories: string[] = [];
const processes: Promise<void>[] = [];

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "rolebox-executor-test-"));
  directories.push(cwd);
  const file = join(cwd, "executor.cjs");
  writeFileSync(file, `
    const input = require("node:readline").createInterface({ input: process.stdin });
    input.on("line", line => {
      const message = JSON.parse(line);
      if (message.method === "exit") process.exit(0);
      process.stdout.write(JSON.stringify({ id: message.id, result: message.params }) + "\\n");
    });
  `);
  const authority = codexLaunchAuthority({ threadId: "parent", "codex/sandbox-launcher": { codexExecutable: process.execPath },
    "codex/sandbox-state": { permissionProfile: { type: "workspaceWrite", networkAccess: false }, future: { exact: [true, null] } },
  })!;
  const failure = vi.fn();
  const spawned: Array<{ command: string; args: readonly string[]; child: ChildProcessWithoutNullStreams }> = [];
  const executor = new CodexExecutor({ cwd, authority, onFailure: failure,
    spawnProcess(command, args, options) {
      const child = spawn(process.execPath, [file], { ...options, stdio: "pipe", env: { ...process.env, NODE_OPTIONS: "" } });
      processes.push(new Promise(resolve => child.once("close", () => resolve())));
      spawned.push({ command, args, child });
      return child;
    },
  });
  executors.push(executor);
  return { executor, authority, failure, spawned };
}

function connect(url: string, token?: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  sockets.push(socket);
  return new Promise((resolve, reject) => { socket.once("open", () => resolve(socket)); socket.once("error", reject); });
}

function reply(socket: WebSocket, value: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once("message", data => resolve(JSON.parse(data.toString())));
    socket.once("close", () => reject(new Error("Executor closed")));
    socket.send(JSON.stringify(value));
  });
}

afterEach(async () => {
  for (const executor of executors.splice(0)) executor.close();
  for (const socket of sockets.splice(0)) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  await Promise.all(processes.splice(0));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Codex sandboxed execution transport", () => {
  it("starts only after authentication and forwards the original opaque state to exec-server", async () => {
    const { executor, authority, spawned } = fixture();
    const url = await executor.listen();
    expect(spawned).toHaveLength(0);
    const socket = await connect(url, executor.token);
    expect(await reply(socket, { id: 1, method: "filesystem/readFile", params: { path: "資料.txt" } })).toEqual({ id: 1, result: { path: "資料.txt" } });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].command).toBe(authority.executable);
    expect(spawned[0].args).toEqual([
      "sandbox", "--sandbox-state-json", authority.sandboxState, "--", authority.executable, "exec-server", "--listen", "stdio",
    ]);
    expect(JSON.parse(spawned[0].args[2])).toHaveProperty("future.exact", [true, null]);
  });

  it("rejects unauthenticated peers without launching a process or consuming the connection", async () => {
    const { executor, spawned, failure } = fixture();
    const url = await executor.listen();
    await expect(connect(url)).rejects.toThrow("403");
    await expect(connect(url, "incorrect")).rejects.toThrow("403");
    expect(spawned).toHaveLength(0);
    expect(failure).not.toHaveBeenCalled();
    const socket = await connect(url, executor.token);
    expect(await reply(socket, { id: 2, params: { ok: true } })).toEqual({ id: 2, result: { ok: true } });
  });

  it("allows only one peer and refuses to restart an executor after disconnect", async () => {
    const { executor, spawned, failure } = fixture();
    const url = await executor.listen();
    const socket = await connect(url, executor.token);
    await expect(connect(url, executor.token)).rejects.toThrow("403");
    expect(await reply(socket, { id: 1, params: {} })).toEqual({ id: 1, result: {} });
    socket.close();
    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
    await expect(connect(url, executor.token)).rejects.toThrow();
    expect(spawned).toHaveLength(1);
  });

  it("accepts the native executor client's binary JSON framing", async () => {
    const { executor } = fixture();
    const socket = await connect(await executor.listen(), executor.token);
    const response = new Promise(resolve => socket.once("message", data => resolve(JSON.parse(data.toString()))));
    socket.send(Buffer.from(JSON.stringify({ id: 7, params: { kind: "binary" } })));
    expect(await response).toEqual({ id: 7, result: { kind: "binary" } });
  });

  it.each([false, true])("fails closed for malformed JSON framing (binary=%s)", async binary => {
    const { executor, failure } = fixture();
    const socket = await connect(await executor.listen(), executor.token);
    socket.send('{"id":1}\n{"id":2}', { binary });
    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
    // fail() terminates the server side, but the client's close event arrives asynchronously;
    // the bounded wait still fails if the socket never reaches CLOSED.
    await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED), { timeout: 5000 });
  });

  it("revokes the relay when its execution process exits", async () => {
    const { executor, failure, spawned } = fixture();
    const socket = await connect(await executor.listen(), executor.token);
    socket.send(JSON.stringify({ method: "exit" }));
    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
    expect(spawned).toHaveLength(1);
    // The relay's server-side terminate/close propagates to the client asynchronously,
    // so observe CLOSED with a bounded wait that still fails if it never arrives.
    await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED), { timeout: 5000 });
  });

  it("closes its owned process without reporting a spurious failure", async () => {
    const { executor, failure, spawned } = fixture();
    await connect(await executor.listen(), executor.token);
    executor.close();
    await vi.waitFor(() => expect(spawned[0].child.exitCode !== null || spawned[0].child.signalCode !== null).toBe(true));
    expect(failure).not.toHaveBeenCalled();
  });
});
