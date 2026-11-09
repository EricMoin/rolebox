import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { createConnection, createServer as createSocketServer } from "node:net";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopSharedArguments, parseCodexDesktopLauncherConfig, prepareCodexDesktopLauncher } from "../../../../../src/platform/adapters/codex/desktop/launcher.ts";

const roots: string[] = [];
const closes: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const context = { desktopParent: true, originator: "Codex Desktop" };
describe("desktop launcher argument selection", () => {
  it("preserves opaque argument values while replacing the desktop stdio transport", () => {
    const args = ["-c", 'private.value="app-server"', "app-server", "--analytics-default-enabled", "--listen", "stdio://", "-c", 'value="--listen"'];
    expect(desktopSharedArguments(args, "/path/to/shared.sock", context)).toEqual([
      "-c", 'private.value="app-server"', "app-server", "--analytics-default-enabled", "-c", 'value="--listen"', "--listen", "unix:///path/to/shared.sock",
    ]);
    expect(desktopSharedArguments(["app-server", "--stdio"], "/path/to/shared.sock", context)).toEqual(["app-server", "--listen", "unix:///path/to/shared.sock"]);
  });

  it.each([
    ["--version"], ["app-server", "--help"], ["app-server", "daemon", "start"],
    ["app-server", "generate-ts"], ["exec-server"], ["app-server", "--listen", "unix://"],
    ["app-server", "--listen=ws://127.0.0.1:4500"], ["app-server", "--print-startup-config"],
  ])("passes through inspection, worker and explicit transport invocation %j", (...args) => {
    expect(desktopSharedArguments(args as string[], "/path/to/shared.sock", context)).toBeUndefined();
  });

  it("requires the actual configured desktop parent and desktop originator", () => {
    expect(desktopSharedArguments(["app-server"], "/path/to/shared.sock", { ...context, desktopParent: false })).toBeUndefined();
    expect(desktopSharedArguments(["app-server"], "/path/to/shared.sock", { ...context, originator: "preview" })).toBeUndefined();
  });

  it("validates paths and resource limits", () => {
    expect(() => parseCodexDesktopLauncherConfig({})).toThrow("invalid_config");
    expect(() => parseCodexDesktopLauncherConfig({ codexPath: "relative" })).toThrow("invalid_config");
  });
});

const require = createRequire(import.meta.url);
const wsModule = pathToFileURL(require.resolve("ws")).href;
const fakeSource = `
import {appendFileSync,readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import ws from ${JSON.stringify(wsModule)};
const {WebSocketServer}=ws;
const args=process.argv.slice(2);
const trace=value=>appendFileSync(process.env.LAUNCH_TEST_TRACE,JSON.stringify(value)+'\\n');
trace({pid:process.pid,ppid:process.ppid,args,parentSocket:process.env.ROLEBOX_CODEX_PARENT_SOCKET,launcherEnv:process.env.ROLEBOX_CODEX_DESKTOP_LAUNCHER_CONFIG});
const index=args.indexOf('--listen');
if(index<0||!args[index+1]?.startsWith('unix://')){process.stdout.write('native-passthrough\\n');process.exit(0);}
if(process.env.LAUNCH_TEST_MODE==='exit'){process.exit(7);}
const socketPath=args[index+1].slice('unix://'.length);
const server=createServer();const sockets=new WebSocketServer({server});
sockets.on('connection',socket=>socket.on('message',data=>{
 const m=JSON.parse(data.toString());trace({received:m});
 if(m.method==='initialized')return;
 if(m.method===undefined){socket.send(JSON.stringify({method:'serverRequest/resolved',params:{id:m.id}}));return;}
 socket.send(JSON.stringify({id:m.id,result:{pid:process.pid,ppid:process.ppid,request:m,parentSocket:process.env.ROLEBOX_CODEX_PARENT_SOCKET}}));
 if(m.method==='initialize')socket.send(JSON.stringify({id:'server-request',method:'item/tool/call',params:{opaque:'server-context'}}));
}));
server.listen(socketPath,()=>trace({listening:true}));
process.on('SIGTERM',()=>{if(process.env.LAUNCH_TEST_MODE==='ignore-term'){trace({ignoredSigterm:true});return;}for(const socket of sockets.clients)socket.terminate();sockets.close(()=>server.close(()=>process.exit(0)));});
`;

async function fixture(extra: { mode?: string; desktopParent?: boolean; maxMessageBytes?: number; fatalRelay?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dl-")); roots.push(root);
  const codexPath = join(root, "native"); const serverPath = join(root, "native.mjs");
  writeFileSync(serverPath, fakeSource);
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  writeFileSync(codexPath, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(serverPath)} "$@"\n`, { mode: 0o700 });
  const output = join(root, "codex");
  const config = parseCodexDesktopLauncherConfig({ codexPath, nodePath: process.execPath,
    desktopExecutable: extra.desktopParent === false ? "/bin/sh" : process.execPath,
    socketPath: join(root, "s"), logPath: join(root, "events"), startupTimeoutMs: 10_000,
    maxMessageBytes: extra.maxMessageBytes ?? 5 * 1024 * 1024 });
  const entries = { launcherEntry: fileURLToPath(new URL("../../../../../src/platform/adapters/codex/desktop/launcher-process.ts", import.meta.url)),
    relayEntry: fileURLToPath(new URL("../../../../../src/platform/adapters/codex/desktop/relay-process.ts", import.meta.url)) };
  if (extra.fatalRelay) {
    entries.relayEntry = join(root, "fatal-relay.mjs");
    const module = new URL("../../../../../src/platform/adapters/codex/desktop/relay.ts", import.meta.url).href;
    writeFileSync(entries.relayEntry, `import {runCodexDesktopRelay} from ${JSON.stringify(module)};\nconst running=runCodexDesktopRelay(process.argv[2],Number(process.argv[3]));\nsetTimeout(()=>{throw new Error('private-runtime-detail')},250);\nawait running;\n`);
  }
  prepareCodexDesktopLauncher(config, output, entries);
  const tracePath = join(root, "trace");
  const processes: ChildProcessWithoutNullStreams[] = [];
  const launch = (args: string[]) => {
    const child = spawn(output, args, { env: { ...process.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop",
      LAUNCH_TEST_TRACE: tracePath, LAUNCH_TEST_MODE: extra.mode ?? "ok" }, stdio: "pipe" });
    child.stderr.resume(); processes.push(child); return child;
  };
  const trace = () => readFileSync(tracePath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const events = () => existsSync(config.logPath) ? readFileSync(config.logPath, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  closes.push(async () => {
    for (const child of processes) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>(resolveExit => {
          const timer = setTimeout(() => { child.kill("SIGKILL"); resolveExit(); }, 1000); timer.unref();
          child.once("exit", () => { clearTimeout(timer); resolveExit(); });
        });
      }
    }
    for (const event of events()) if (event.relayPid) { try { process.kill(event.relayPid, "SIGTERM"); } catch {} }
  });
  return { root, output, config, entries, trace, events, launch };
}

function lines(child: ChildProcessWithoutNullStreams) {
  let buffer = ""; const messages: Record<string, any>[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", data => {
    buffer += data.toString(); let end;
    while ((end = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line) messages.push(JSON.parse(line)); }
  });
  return messages;
}

describe.skipIf(process.platform === "win32" || typeof process.execve !== "function")("desktop-owned shared process", () => {
  it("hands the same PID to the original CLI and forwards both directions without changing context", async () => {
    const f = await fixture(); const child = f.launch(["-c", 'private.value="argument-marker"', "app-server"]);
    const messages = lines(child);
    const request = { id: 11, method: "initialize", params: { clientInfo: { name: "desktop-fixture" }, opaque: "中文🐋-context" } };
    const bytes = Buffer.from(`${JSON.stringify(request)}\n`); child.stdin.write(bytes.subarray(0, bytes.length - 8)); child.stdin.write(bytes.subarray(bytes.length - 8));
    await vi.waitFor(() => expect(messages.some(m => m.id === 11)).toBe(true), { timeout: 10_000 });
    expect(messages.find(m => m.id === 11)!.result).toMatchObject({ pid: child.pid, ppid: process.pid, request, parentSocket: f.config.socketPath });
    await vi.waitFor(() => expect(messages.some(m => m.id === "server-request")).toBe(true), { timeout: 5000 });
    child.stdin.write(`${JSON.stringify({ id: "server-request", result: { accepted: false, opaque: "desktop-response" } })}\n`);
    await vi.waitFor(() => expect(messages.some(m => m.method === "serverRequest/resolved")).toBe(true), { timeout: 5000 });
    expect(f.trace()[0].launcherEnv).toBeUndefined();
    expect(readFileSync(f.config.logPath, "utf8")).not.toContain("argument-marker");
    child.stdin.end();
    await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 4000 });
    const relayPid = f.events().find(e => e.event === "native_cli_exec").relayPid;
    await vi.waitFor(() => expect(() => process.kill(relayPid, 0)).toThrow(), { timeout: 4000 });
  });

  it("allows a second Unix client to use the same host without mixing response IDs", async () => {
    const f = await fixture(); const child = f.launch(["app-server"]); const desktop = lines(child);
    child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: {} })}\n`);
    await vi.waitFor(() => expect(desktop.some(m => m.id === 1)).toBe(true), { timeout: 5000 });
    const socket = new WebSocket("ws://localhost/", { createConnection: () => createConnection(f.config.socketPath) });
    closes.push(() => socket.terminate());
    const response = await new Promise<any>((resolveMessage, reject) => {
      socket.once("error", reject); socket.once("open", () => socket.send(JSON.stringify({ id: 1, method: "thread/loaded/list", params: {} })));
      socket.once("message", data => resolveMessage(JSON.parse(data.toString())));
    });
    expect(response.result.pid).toBe(child.pid);
    expect(response.result.request.method).toBe("thread/loaded/list");
    expect(desktop.find(m => m.id === 1)!.result.request.method).toBe("initialize");
  });

  it("forwards a fragmented large message as one unchanged JSON-RPC request", async () => {
    const f = await fixture(); const child = f.launch(["app-server"]); const messages = lines(child);
    const request = { id: 8, method: "thread/resume", params: { context: "大".repeat(800_000) } };
    child.stdin.write(`${JSON.stringify(request)}\n`);
    await vi.waitFor(() => expect(messages.some(m => m.id === 8)).toBe(true), { timeout: 5000 });
    expect(JSON.stringify(messages.find(m => m.id === 8)!.result.request) === JSON.stringify(request)).toBe(true);
  });

  it("stops its own host on input overflow without logging the payload", async () => {
    const f = await fixture({ maxMessageBytes: 1024 }); const child = f.launch(["app-server"]); const messages = lines(child);
    child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: {} })}\n`);
    await vi.waitFor(() => expect(messages.some(m => m.id === 1)).toBe(true), { timeout: 5000 });
    child.stdin.write(`private-payload-marker${"x".repeat(1100)}`);
    await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 4000 });
    expect(f.events().map(e => e.event)).toContain("desktop_input_limit");
    expect(readFileSync(f.config.logPath, "utf8")).not.toContain("private-payload-marker");
  });

  it("passes inspection and non-desktop worker invocations to the original CLI", async () => {
    for (const desktopParent of [true, false]) {
      const f = await fixture({ desktopParent }); const child = f.launch(desktopParent ? ["--version"] : ["app-server", "--listen", "stdio://"]);
      let output = ""; child.stdout.on("data", data => { output += data.toString(); });
      await vi.waitFor(() => expect({ exit: child.exitCode, signal: child.signalCode, output,
        events: f.events().map(event => event.event) }).toMatchObject({ exit: 0, signal: null }), { timeout: 5000 });
      expect(output).toBe("native-passthrough\n");
      expect(f.events().some(e => e.event === "native_cli_exec")).toBe(false);
      expect(f.trace()[0].pid).toBe(child.pid);
    }
  });

  it("refuses an existing socket without removing or attaching to it", async () => {
    const f = await fixture(); const server = createSocketServer(socket => socket.end("still-owned"));
    await new Promise<void>(resolveListen => server.listen(f.config.socketPath, resolveListen));
    closes.push(() => new Promise<void>(resolveClose => server.close(() => resolveClose())));
    const child = f.launch(["app-server"]); let error = ""; child.stderr.on("data", data => { error += data.toString(); });
    await vi.waitFor(() => expect(child.exitCode).toBe(1), { timeout: 5000 });
    expect(error).toContain("socket_already_exists");
    const response = await new Promise<string>((resolveRead, reject) => {
      const socket = createConnection(f.config.socketPath); socket.once("data", data => resolveRead(data.toString())); socket.once("error", reject);
    });
    expect(response).toBe("still-owned");
    expect(f.events().some(e => e.event === "native_cli_exec")).toBe(false);
  });

  it("releases the relay when the original host exits before binding its listener", async () => {
    const f = await fixture({ mode: "exit" }); const child = f.launch(["app-server"]); child.stdout.resume();
    await vi.waitFor(() => expect(child.exitCode).toBe(7), { timeout: 5000 });
    const relayPid = f.events().find(e => e.event === "native_cli_exec").relayPid;
    await vi.waitFor(() => expect(() => process.kill(relayPid, 0)).toThrow(), { timeout: 4000 });
  });

  it("escalates termination for its own host when SIGTERM is ignored", async () => {
    const f = await fixture({ mode: "ignore-term" }); const child = f.launch(["app-server"]); const messages = lines(child);
    child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: {} })}\n`);
    await vi.waitFor(() => expect(messages.some(m => m.id === 1)).toBe(true), { timeout: 5000 });
    child.stdin.end();
    await vi.waitFor(() => expect(child.signalCode).toBe("SIGKILL"), { timeout: 5000 });
    expect(f.events().map(e => e.event)).toContain("host_sigkill");
    const relayPid = f.events().find(e => e.event === "native_cli_exec").relayPid;
    await vi.waitFor(() => expect(() => process.kill(relayPid, 0)).toThrow(), { timeout: 5000 });
  });

  it("logs a fatal error after readiness and stops only its own host", async () => {
    const f = await fixture({ fatalRelay: true }); const child = f.launch(["app-server"]); child.stdout.resume();
    await vi.waitFor(() => expect(child.exitCode !== null || child.signalCode !== null).toBe(true), { timeout: 5000 });
    expect(f.events().map(e => e.event)).toContain("relay_runtime_failed");
    expect(readFileSync(f.config.logPath, "utf8")).not.toContain("private-runtime-detail");
  });

  it("refuses a non-private socket directory without creating a listener", async () => {
    const f = await fixture(); const directory = join(f.root, "public"); mkdirSync(directory, { mode: 0o755 });
    const prepared = `${f.output}.json`; const value = JSON.parse(readFileSync(prepared, "utf8"));
    value.socketPath = join(directory, "socket"); writeFileSync(prepared, JSON.stringify(value));
    const child = f.launch(["app-server"]); let diagnostic = ""; child.stderr.on("data", data => { diagnostic += data.toString(); });
    await vi.waitFor(() => expect(child.exitCode).toBe(1), { timeout: 5000 });
    expect(diagnostic).toContain("socket_directory_not_private");
    expect(existsSync(value.socketPath)).toBe(false);
    expect(f.events().some(e => e.event === "native_cli_exec")).toBe(false);
  });

  it("does not replace an existing output or its configuration", async () => {
    const f = await fixture(); const before = readFileSync(f.output, "utf8");
    expect(() => prepareCodexDesktopLauncher(f.config, f.output, f.entries)).toThrow("output_exists");
    expect(readFileSync(f.output, "utf8")).toBe(before);
  });
});
