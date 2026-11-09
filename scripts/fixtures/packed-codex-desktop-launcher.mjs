import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const root = mkdtempSync("/tmp/rbp-");
const cli = join(process.cwd(), "node_modules/rolebox/dist/cli/main.js");
const output = join(root, "codex");
const socketPath = join(root, "s");
const logPath = join(root, "events");
let child;
let childClosed;
let side;
let relayPid;
let reader;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(test) {
  const deadline = Date.now() + 10000;
  while (!test()) { assert(Date.now() < deadline, "Packed desktop relay timed out"); await sleep(25); }
}

try {
  const native = join(root, "native");
  const source = join(root, "native.mjs");
  const wsModule = pathToFileURL(require.resolve("ws")).href;
  writeFileSync(source, `
    import {createServer} from 'node:http';
    import ws from ${JSON.stringify(wsModule)};
    const args=process.argv.slice(2), index=args.indexOf('--listen');
    const server=createServer(), sockets=new ws.WebSocketServer({server});
    sockets.on('connection',socket=>socket.on('message',bytes=>{
      const request=JSON.parse(bytes.toString());
      socket.send(JSON.stringify({id:request.id,result:{request,pid:process.pid,ppid:process.ppid}}));
    }));
    server.listen(args[index+1].slice('unix://'.length));
    process.on('SIGTERM',()=>{for(const socket of sockets.clients)socket.terminate();sockets.close(()=>server.close(()=>process.exit(0)));});
  `);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(native, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(source)} "$@"\n`, { mode: 0o700 });
  const input = join(root, "input.json");
  writeFileSync(input, JSON.stringify({ codexPath: native, nodePath: process.execPath,
    desktopExecutable: process.execPath, socketPath, logPath }));
  const prepared = spawnSync(process.execPath, [cli, "host", "codex", "desktop", "prepare", "--config", input, "--output", output], { encoding: "utf8" });
  assert.equal(prepared.status, 0, "Packed CLI could not prepare the desktop adapter");
  child = spawn(output, ["app-server"], { env: { ...process.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" }, stdio: "pipe" });
  childClosed = new Promise(resolve => child.once("close", resolve));
  child.stderr.resume();
  const messages = [];
  reader = createInterface({ input: child.stdout });
  reader.on("line", line => messages.push(JSON.parse(line)));
  const request = { id: 1, method: "initialize", params: { opaque: "packed-relay-中文🐋" } };
  child.stdin.write(JSON.stringify(request) + "\n");
  await eventually(() => messages.length > 0);
  assert.deepEqual(messages[0].result.request, request);
  assert.equal(messages[0].result.pid, child.pid);
  assert.equal(messages[0].result.ppid, process.pid);
  const events = readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  relayPid = events.find(event => event.event === "native_cli_exec").relayPid;
  assert(events.some(event => event.event === "relay_connected"), "Packed relay entry did not run");
  side = new WebSocket("ws://localhost/", { createConnection: () => createConnection(socketPath) });
  const response = await new Promise((resolve, reject) => {
    side.once("error", reject);
    side.once("open", () => side.send(JSON.stringify({ id: 1, method: "thread/loaded/list" })));
    side.once("message", bytes => resolve(JSON.parse(bytes.toString())));
  });
  assert.equal(response.result.pid, child.pid);
  assert.equal(response.result.request.method, "thread/loaded/list");
  side.terminate(); side = undefined;
  child.stdin.end();
  await eventually(() => child.exitCode === 0);
  await eventually(() => !alive(relayPid));
  console.log("packed desktop relay, original PID, second client and EOF cleanup: PASS");
} finally {
  side?.terminate(); reader?.close();
  child?.stdout.resume();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  if (!relayPid && existsSync(logPath)) {
    const events = readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    relayPid = events.find(event => event.event === "native_cli_exec")?.relayPid;
  }
  if (relayPid && alive(relayPid)) {
    process.kill(relayPid, "SIGTERM");
    await eventually(() => !alive(relayPid));
  }
  await childClosed;
  rmSync(root, { recursive: true, force: true });
}
