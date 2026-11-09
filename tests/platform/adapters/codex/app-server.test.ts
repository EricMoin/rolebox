import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexAppServerClient,
  codexAppServerOptions,
  codexLaunchAuthority,
  type CodexRecord,
  type CodexLaunchAuthority,
} from "../../../../src/platform/adapters/codex/app-server.ts";

const clients: CodexAppServerClient[] = [];
const directories: string[] = [];
const processes: Array<{ child: ChildProcessWithoutNullStreams; closed: Promise<void> }> = [];

const FIXTURE = String.raw`
const { createInterface } = require("node:readline");
const { spawn } = require("node:child_process");
const input = createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const replies = new Map();
const reverse = [];
let initialized = false;
let initializeCount = 0;
let handshake;
let descendant;
let executor;
process.on("SIGTERM", () => {
  if (!descendant || descendant.exitCode !== null || descendant.signalCode !== null) process.exit(0);
  descendant.once("exit", () => process.exit(0));
});
input.on("line", line => {
  const message = JSON.parse(line);
  if (!message.method) {
    const requestId = replies.get(message.id);
    if (requestId !== undefined) {
      replies.delete(message.id);
      send({ id: requestId, result: { reply: message } });
    }
    return;
  }
  if (message.method === "initialize") {
    initializeCount += 1;
    handshake = message.params;
    if (process.argv.includes("--hang-initialize")) return;
    send({ id: message.id, result: { userAgent: "rolebox-fixture" } });
    return;
  }
  if (message.method === "initialized") {
    initialized = true;
    return;
  }
  if (!initialized) {
    send({ id: message.id, error: { code: -32000, message: "Missing initialized notification" } });
    return;
  }
  const params = message.params || {};
  switch (message.method) {
    case "environment/add":
      executor = params;
      send({ id: message.id, result: {} });
      break;
    case "thread/start":
      send({ id: message.id, result: { thread: { id: "worker", cwd: params.cwd,
        environments: params.invalidEnvironment ? [{ environmentId: "local" }] : params.environments,
      } } });
      break;
    case "thread/fork":
    case "turn/start":
      send({ id: message.id, result: params });
      break;
    case "fixture/executor":
      send({ id: message.id, result: { environmentId: executor?.environmentId, authSupplied: !!executor?.authBearerToken } });
      break;
    case "fixture/handshake":
      send({ id: message.id, result: { initialized, initializeCount, handshake } });
      break;
    case "fixture/echo":
      send({ id: message.id, result: params });
      break;
    case "fixture/reverse":
      reverse.push(message);
      if (reverse.length === 2) {
        for (const request of reverse.reverse()) send({ id: request.id, result: request.params });
      }
      break;
    case "fixture/callback": {
      const id = "server-request-" + message.id;
      replies.set(id, message.id);
      send({ id, method: params.method || "item/tool/call", params: params.call || {} });
      break;
    }
    case "fixture/notify":
      send({ method: "turn/completed", params });
      send({ id: message.id, result: { sent: true } });
      break;
    case "fixture/chunks": {
      const bytes = Buffer.from(JSON.stringify({ id: message.id, result: params }) + "\n");
      const split = bytes.findIndex(byte => byte >= 0x80) + 1;
      process.stdout.write("\n");
      process.stdout.write(bytes.subarray(0, split));
      setImmediate(() => process.stdout.write(bytes.subarray(split)));
      break;
    }
    case "fixture/reject":
      send({ id: message.id, error: { code: -32602, message: "fixture refused this request" } });
      break;
    case "fixture/hang":
      send({ method: "fixture/waiting", params: { id: message.id } });
      break;
    case "fixture/spawn-child":
      descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      send({ id: message.id, result: { parentPid: process.pid, childPid: descendant.pid } });
      break;
    case "fixture/late":
      setTimeout(() => {
        send({ id: message.id, result: { late: true } });
        send({ method: "fixture/late-response", params: {} });
      }, params.delay);
      break;
    case "fixture/exit":
      process.exit(9);
      break;
    case "fixture/invalid":
      process.stdout.write(params.line + "\n");
      break;
    case "fixture/invalid-response":
      send({ id: message.id, ...params });
      break;
  }
});
`;

function fixture(options: { requestTimeoutMs?: number; hangInitialize?: boolean; nativeSpawn?: boolean;
  launchAuthority?: CodexLaunchAuthority;
  handleElicitation?: (params: CodexRecord) => Promise<CodexRecord> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "rolebox-codex-transport-"));
  directories.push(directory);
  const script = join(directory, "server.cjs");
  writeFileSync(script, FIXTURE);
  const spawned: ChildProcessWithoutNullStreams[] = [];
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [script, ...(options.hangInitialize ? ["--hang-initialize"] : [])],
    cwd: directory,
    requestTimeoutMs: options.requestTimeoutMs ?? 2_000,
    handleElicitation: options.handleElicitation,
    launchAuthority: options.launchAuthority,
    spawnProcess: options.nativeSpawn ? undefined : (command, args, processOptions) => {
      const child = spawn(command, [...args], {
        ...processOptions,
        stdio: "pipe",
        env: { ...process.env, NODE_OPTIONS: "" },
      });
      spawned.push(child);
      processes.push({ child, closed: new Promise(resolve => { child.once("close", () => resolve()); }) });
      return child;
    },
  });
  clients.push(client);
  return { client, spawned };
}

function notification(client: CodexAppServerClient, name: string): Promise<CodexRecord> {
  return new Promise(resolve => {
    const off = client.onNotification((method, params) => {
      if (method !== name) return;
      off();
      resolve(params);
    });
  });
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.all(processes.splice(0).map(process => process.closed));
  // Windows can briefly keep a directory locked after a terminated descendant
  // closes, which surfaces as EPERM on an immediate recursive removal.
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  vi.unstubAllEnvs();
});

describe("CodexAppServerClient stdio", () => {
  it("pins every worker turn to the sandboxed executor and rejects caller-selected local execution", async () => {
    const authority = codexLaunchAuthority({ threadId: "parent", "codex/sandbox-launcher": { codexExecutable: process.execPath },
      "codex/sandbox-state": { original: { network: false } } })!;
    const { client } = fixture({ launchAuthority: authority });
    const result = await client.request("thread/start", { cwd: "/path/to/project", environments: [{ environmentId: "local" }] });
    const selected = (result.thread as CodexRecord).environments as CodexRecord[];
    expect(selected).toHaveLength(1);
    expect(selected[0].environmentId).toMatch(/^rolebox-/);
    const metadata = await client.request("fixture/executor");
    expect(metadata).toEqual({ environmentId: selected[0].environmentId, authSupplied: true });
    const turn = await client.request("turn/start", { threadId: "worker", environments: [] });
    expect(turn.environments).toEqual(selected);
    expect(turn.sandboxPolicy).toEqual({ type: "externalSandbox", networkAccess: "restricted" });
    const fork = await client.request("thread/fork", { threadId: "parent", deferGoalContinuation: false });
    expect(fork.deferGoalContinuation).toBe(true);
  });

  it("closes the runtime if Codex does not acknowledge its selected executor", async () => {
    const authority = codexLaunchAuthority({ threadId: "parent", "codex/sandbox-launcher": { codexExecutable: process.execPath },
      "codex/sandbox-state": { original: true } })!;
    const { client } = fixture({ launchAuthority: authority });
    await expect(client.request("thread/start", { invalidEnvironment: true })).rejects.toThrow("did not bind");
    await expect(client.request("fixture/echo")).rejects.toThrow("did not bind");
  });

  it("starts lazily and completes one initialize/initialized handshake before requests", async () => {
    const { client, spawned } = fixture();
    expect(spawned).toHaveLength(0);

    const result = await client.request("fixture/handshake");
    expect(result).toMatchObject({
      initialized: true,
      initializeCount: 1,
      handshake: {
        clientInfo: { name: "rolebox" },
        capabilities: { experimentalApi: true },
      },
    });
    await client.request("fixture/handshake");
    expect(spawned).toHaveLength(1);
  });

  it("cannot start a process after being closed before its first request", async () => {
    const { client, spawned } = fixture();
    client.close();
    await expect(client.request("thread/list")).rejects.toThrow("connection closed");
    expect(spawned).toHaveLength(0);
  });

  it("correlates concurrent requests when the server replies in reverse order", async () => {
    const { client } = fixture();
    const finished: string[] = [];
    const first = client.request("fixture/reverse", { label: "first" }).then(result => {
      finished.push(String(result.label));
      return result;
    });
    const second = client.request("fixture/reverse", { label: "second" }).then(result => {
      finished.push(String(result.label));
      return result;
    });

    expect(await Promise.all([first, second])).toEqual([{ label: "first" }, { label: "second" }]);
    expect(finished).toEqual(["second", "first"]);
  });

  it("routes dynamic calls with the server's thread and turn identity and returns content", async () => {
    const { client } = fixture();
    const call = {
      threadId: "worker-thread",
      turnId: "worker-turn",
      callId: "worker-call",
      namespace: "rolebox",
      tool: "graph_submit_outcome",
      arguments: { outcome: "done" },
    };
    const handler = vi.fn(async (method: string, params: CodexRecord) => {
      expect(method).toBe("item/tool/call");
      expect(params).toEqual(call);
      return { success: true, contentItems: [{ type: "inputText", text: "accepted" }] };
    });
    client.setRequestHandler(handler);

    const result = await client.request("fixture/callback", { call });
    expect(result).toMatchObject({
      reply: { result: { success: true, contentItems: [{ type: "inputText", text: "accepted" }] } },
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/requestUserInput",
    "mcpServer/elicitation/request",
  ])("rejects interactive %s without invoking the dynamic handler", async method => {
    const { client } = fixture();
    const handler = vi.fn(async () => ({ decision: "accept" }));
    client.setRequestHandler(handler);

    const result = await client.request("fixture/callback", { method, call: { threadId: "worker" } });
    expect(result).toMatchObject({ reply: { error: { code: -32601 } } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("routes MCP elicitation only to an explicitly supplied outer-client handler", async () => {
    const handleElicitation = vi.fn(async (params: CodexRecord) => ({
      action: params.serverName === "fixture" ? "accept" : "decline", content: {}, _meta: null,
    }));
    const { client } = fixture({ handleElicitation });
    const call = { serverName: "fixture", mode: "form", requestedSchema: { type: "object", properties: {} } };
    const result = await client.request("fixture/callback", { method: "mcpServer/elicitation/request", call });
    expect(result).toMatchObject({ reply: { result: { action: "accept", content: {}, _meta: null } } });
    expect(handleElicitation).toHaveBeenCalledExactlyOnceWith(call);
    const rejected = await client.request("fixture/callback", { method: "item/permissions/requestApproval", call });
    expect(rejected).toMatchObject({ reply: { error: { code: -32601 } } });
    expect(handleElicitation).toHaveBeenCalledOnce();
  });

  it("returns a protocol error for a dynamic call when no handler was installed", async () => {
    const { client } = fixture();
    const result = await client.request("fixture/callback");
    expect(result).toMatchObject({ reply: { error: { code: -32601 } } });
  });

  it("contains a rejected dynamic handler and continues serving subsequent requests", async () => {
    const { client } = fixture();
    client.setRequestHandler(async () => { throw new Error("private handler detail"); });

    const result = await client.request("fixture/callback");
    expect(result).toMatchObject({ reply: { error: { code: -32603 } } });
    expect(JSON.stringify(result)).not.toContain("private handler detail");
    expect(await client.request("fixture/echo", { healthy: true })).toEqual({ healthy: true });
  });

  it("isolates throwing notification listeners and honors listener removal", async () => {
    const { client } = fixture();
    const observed: CodexRecord[] = [];
    const removed = vi.fn();
    client.onNotification(() => { throw new Error("observer failure"); });
    client.onNotification((_method, params) => observed.push(params));
    const off = client.onNotification(removed);
    off();

    expect(await client.request("fixture/notify", { threadId: "thread", turn: { status: "completed" } })).toEqual({ sent: true });
    expect(observed).toEqual([{ threadId: "thread", turn: { status: "completed" } }]);
    expect(removed).not.toHaveBeenCalled();
  });

  it("reassembles split UTF-8 JSON messages and tolerates empty lines", async () => {
    const { client } = fixture();
    const expected = { text: "分片 😀 transport", nested: { complete: true } };
    expect(await client.request("fixture/chunks", expected)).toEqual(expected);
  });

  it("propagates a server request error without poisoning the connection", async () => {
    const { client } = fixture();
    await expect(client.request("fixture/reject")).rejects.toThrow("-32602");
    expect(await client.request("fixture/echo", { next: "request" })).toEqual({ next: "request" });
  });

  it("rejects every pending request and terminates the child when closed", async () => {
    const { client, spawned } = fixture();
    const waiting = notification(client, "fixture/waiting");
    const first = expect(client.request("fixture/hang")).rejects.toThrow("connection closed");
    const second = expect(client.request("fixture/hang")).rejects.toThrow("connection closed");
    await waiting;

    client.close();
    await Promise.all([first, second]);
    await expect(client.request("fixture/echo")).rejects.toThrow("connection closed");
    expect(spawned).toHaveLength(1);
    await processes.find(process => process.child === spawned[0])!.closed;
    expect(spawned[0]!.exitCode !== null || spawned[0]!.signalCode !== null).toBe(true);
  });

  it("settles an in-flight callback during close without an unhandled late reply", async () => {
    const { client } = fixture();
    const entered = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<unknown>();
    client.setRequestHandler(async () => {
      entered.resolve();
      return reply.promise;
    });
    const pending = expect(client.request("fixture/callback")).rejects.toThrow("connection closed");
    await entered.promise;

    client.close();
    reply.resolve({ success: true, contentItems: [] });
    await pending;
  });

  it("reports process exit to all pending callers and never silently restarts", async () => {
    const { client, spawned } = fixture();
    const waiting = notification(client, "fixture/waiting");
    const pending = expect(client.request("fixture/hang")).rejects.toThrow("exited");
    await waiting;

    await expect(client.request("fixture/exit")).rejects.toThrow("9");
    await pending;
    await expect(client.request("fixture/echo")).rejects.toThrow("exited");
    expect(spawned).toHaveLength(1);
  });

  it("times out a request and ignores its late response without corrupting later requests", async () => {
    const { client } = fixture({ requestTimeoutMs: 500 });
    await client.request("fixture/handshake");
    const late = notification(client, "fixture/late-response");
    await expect(client.request("fixture/late", { delay: 650 })).rejects.toThrow("timed out");

    expect(await client.request("fixture/echo", { sequence: 1 })).toEqual({ sequence: 1 });
    await late;
    expect(await client.request("fixture/echo", { sequence: 2 })).toEqual({ sequence: 2 });
  });

  it("fails all callers waiting on an initialize timeout and does not retry startup", async () => {
    const { client, spawned } = fixture({ requestTimeoutMs: 500, hangInitialize: true });
    const closed = vi.fn();
    client.onNotification(method => { if (method === "rolebox/connectionClosed") closed(); });
    await expect(Promise.all([
      client.request("fixture/echo"),
      client.request("fixture/handshake"),
    ])).rejects.toThrow("timed out: initialize");
    await expect(client.request("fixture/echo")).rejects.toThrow("timed out: initialize");
    expect(spawned).toHaveLength(1);
    expect(closed).toHaveBeenCalledTimes(1);
    await processes.find(process => process.child === spawned[0])!.closed;
  });

  it("rejects requests after a failed executable launch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rolebox-codex-missing-"));
    directories.push(directory);
    const client = new CodexAppServerClient({ command: join(directory, "missing-codex"), cwd: directory });
    clients.push(client);
    await expect(client.request("thread/list")).rejects.toThrow("Could not start Codex app-server");
    await expect(client.request("thread/list")).rejects.toThrow("Could not start Codex app-server");
  });

  it.each([
    ["invalid JSON", "{broken"],
    ["a primitive", "null"],
    ["an array", "[]"],
  ])("rejects pending requests when the server returns %s", async (_label, line) => {
    const { client } = fixture();
    await expect(client.request("fixture/invalid", { line })).rejects.toThrow(/invalid (JSON|message)/);
    await expect(client.request("fixture/echo")).rejects.toThrow(/invalid (JSON|message)/);
  });

  it("terminates the real process and its descendant after fatal protocol corruption", async () => {
    const { client } = fixture({ nativeSpawn: true });
    const tree = await client.request("fixture/spawn-child");
    const pids = [Number(tree.parentPid), Number(tree.childPid)];
    const alive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    };
    try {
      await expect(client.request("fixture/invalid", { line: "{broken" })).rejects.toThrow("invalid JSON");
      for (let attempt = 0; attempt < 300 && pids.some(alive); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(pids.some(alive)).toBe(false);
    } finally {
      client.close();
      for (const pid of pids) {
        try { if (alive(pid)) process.kill(pid, "SIGKILL"); } catch { /* The fixture already exited. */ }
      }
    }
  });

  it.each([
    ["neither a result nor an error", {}],
    ["both a result and an error", { result: {}, error: { code: -32603, message: "ambiguous" } }],
    ["an array result", { result: [] }],
    ["a malformed error", { error: "invalid" }],
  ])("rejects a response with %s", async (_label, response) => {
    const { client } = fixture();
    await expect(client.request("fixture/invalid-response", response)).rejects.toThrow(/invalid|result|response/);
  });
});

describe("Codex launch authority", () => {
  function metadata(): CodexRecord {
    return {
      threadId: "parent-thread",
      sessionId: "shared-session-root",
      "codex/sandbox-launcher": { codexExecutable: process.execPath },
      "codex/sandbox-state": {
        permissionProfile: { type: "workspaceWrite", writableRoots: ["/path/to/project"] },
        unknownFutureField: { exact: [true, null, { network: "restricted" }] },
      },
    };
  }

  it("snapshots opaque policy fields and retains the issuing thread and verified launcher", () => {
    const meta = metadata();
    const authority = codexLaunchAuthority(meta)!;
    expect(authority.threadId).toBe("parent-thread");
    expect(authority.executable).toBe(process.execPath);
    expect(JSON.parse(authority.sandboxState)).toEqual(meta["codex/sandbox-state"]);

    (meta["codex/sandbox-state"] as CodexRecord).unknownFutureField = "changed after the call";
    expect(JSON.parse(authority.sandboxState).unknownFutureField).toEqual({ exact: [true, null, { network: "restricted" }] });
  });

  it.each([
    undefined,
    {},
    { threadId: "thread" },
    { threadId: "thread", "codex/sandbox-state": {} },
    { threadId: "", "codex/sandbox-state": {}, "codex/sandbox-launcher": { codexExecutable: process.execPath } },
    { threadId: "thread", "codex/sandbox-state": [], "codex/sandbox-launcher": { codexExecutable: process.execPath } },
    { threadId: "thread", "codex/sandbox-state": {}, "codex/sandbox-launcher": { codexExecutable: "codex" } },
  ])("refuses incomplete or unverified authority metadata %#", meta => {
    expect(codexLaunchAuthority(meta)).toBeUndefined();
  });

  it("partitions long-lived connections by thread, executable, and the complete policy", () => {
    const first = metadata();
    const changed = metadata();
    (changed["codex/sandbox-state"] as CodexRecord).unknownFutureField = { exact: false };
    const keys = [
      first,
      changed,
      { ...first, threadId: "another-thread" },
      { ...first, "codex/sandbox-launcher": { codexExecutable: join(tmpdir(), "another-codex") } },
    ].map(meta => codexLaunchAuthority(meta)!.key);
    expect(new Set(keys).size).toBe(4);
    expect(codexLaunchAuthority(metadata())!.key).toBe(keys[0]);
  });

  it("retains opaque launch authority while keeping model transport outside the executor sandbox", () => {
    vi.stubEnv("ROLEBOX_CODEX_COMMAND", "unverified-command");
    const authority = codexLaunchAuthority(metadata())!;
    const options = codexAppServerOptions("/path/to/project", authority);
    expect(options.command).toBe(process.execPath);
    expect(options.args?.slice(0, 3)).toEqual(["app-server", "--listen", "stdio://"]);
    expect(options.launchAuthority).toBe(authority);
    expect(JSON.parse(options.launchAuthority!.sandboxState)).toEqual(metadata()["codex/sandbox-state"]);
    expect(options.args).toContain("features.plugins=false");
    expect(options.args).not.toContain("mcp_servers.rolebox.enabled=false");
  });
});
