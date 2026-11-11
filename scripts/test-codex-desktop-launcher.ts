import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphApplication } from "../src/graph/application/graph-application.ts";
import type { OutcomeDispatchRequest, OutcomeDispatchEffectKey } from "../src/graph/outcome/dispatch-effects.ts";
import { codexRecord, CodexAppServerClient } from "../src/platform/adapters/codex/app-server/app-server.ts";
import { parseCodexDesktopLauncherConfig, prepareCodexDesktopLauncher } from "../src/platform/adapters/codex/desktop/launcher.ts";
import { CodexParentNotifications, CodexParentSocketClient } from "../src/platform/adapters/codex/graph/parent-notifications.ts";
import type { CanonicalToolContext } from "../src/platform/types.ts";
import { configureLogDirectory } from "../src/logger.ts";

if (process.platform === "win32" || typeof process.execve !== "function") throw new Error("This probe requires Unix execve and a built rolebox checkout");
// The fixture owner must expose an absolute executable name to the same parent check as the desktop.
if (process.argv0 !== process.execPath) process.execve(process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], process.env);
const repository = fileURLToPath(new URL("../", import.meta.url));
for (const moduleName of ["launcher-process", "relay-process", "launcher", "relay", "jsonl-buffer"]) {
  const relative = `platform/adapters/codex/desktop/${moduleName}`;
  const built = join(repository, "dist", `${relative}.js`);
  const source = join(repository, "src", `${relative}.ts`);
  if (!existsSync(built) || statSync(built).mtimeMs < statSync(source).mtimeMs) {
    console.error("Desktop launcher build is missing or stale; run npm run build first.");
    process.exit(1);
  }
}
const requestedCodex = process.env.ROLEBOX_CODEX_COMMAND?.trim() || "codex";
const codexPath = isAbsolute(requestedCodex) ? requestedCodex : execFileSync("which", [requestedCodex], { encoding: "utf8" }).trim();
const root = mkdtempSync("/tmp/dlw-");
let closeModel: () => Promise<void> = async () => {};
try {
  const workspace = join(root, "work");
  const codexHome = join(root, "home");
  mkdirSync(workspace); mkdirSync(codexHome);
  configureLogDirectory(root);
  const inputs: unknown[] = [];
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    inputs.push(JSON.parse(Buffer.concat(chunks).toString()));
    const index = inputs.length;
    const message = { id: `message_${index}`, type: "message", role: "assistant",
      content: [{ type: "output_text", text: `probe response ${index}` }] };
    const events = [
      { type: "response.created", response: { id: `response_${index}` } },
      { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
      { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: `probe response ${index}` },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response: { id: `response_${index}`, status: "completed",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  closeModel = async () => {
    model.closeAllConnections();
    await new Promise<void>(done => model.close(() => done()));
  };
  await new Promise<void>((done, reject) => {
    model.once("error", reject);
    model.listen(0, "127.0.0.1", () => { model.off("error", reject); done(); });
  });
  const address = model.address();
  assert(address && typeof address !== "string");
  writeFileSync(join(codexHome, "config.toml"), `model_provider = "fixture"
  model = "fixture-model"
  model_context_window = 200000
  [model_providers.fixture]
  name = "Local fixture"
  base_url = "http://127.0.0.1:${address.port}/v1"
  wire_api = "responses"
  requires_openai_auth = false
  supports_websockets = false
  request_max_retries = 0
  stream_max_retries = 0
  [features]
  plugins = false
  apps = false
  `);
  const socketPath = join(root, "s?#");
  const logPath = join(root, "events");
  const launcher = join(root, "codex");
  prepareCodexDesktopLauncher(parseCodexDesktopLauncherConfig({ codexPath,
    nodePath: process.env.ROLEBOX_CODEX_DESKTOP_NODE || process.execPath,
    desktopExecutable: process.execPath, socketPath, logPath }), launcher, {
    launcherEntry: join(repository, "dist/platform/adapters/codex/desktop/launcher-process.js"),
    relayEntry: join(repository, "dist/platform/adapters/codex/desktop/relay-process.js"),
  });
  let child: ChildProcessWithoutNullStreams | undefined;
  const desktop = new CodexAppServerClient({ command: launcher, args: ["app-server"], cwd: workspace,
    requestTimeoutMs: 15_000, spawnProcess: (command, args) => child = spawn(command, [...args], {
      cwd: workspace, stdio: "pipe", env: { PATH: process.env.PATH, HOME: homedir(), TMPDIR: process.env.TMPDIR,
        CODEX_HOME: codexHome, CODEX_SQLITE_HOME: join(root, "sqlite"), CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" },
    }) });
  const parent = new CodexParentSocketClient(socketPath);
  const channel = new CodexParentNotifications({ env: { ROLEBOX_CODEX_PARENT_SOCKET: socketPath } });
  const completed: string[] = [];
  desktop.onNotification((method, params) => {
    if (method === "turn/completed") completed.push(String(codexRecord(params.turn)?.id));
  });
  let app: GraphApplication | undefined;
  let stage = "native_startup";

  async function eventually(read: () => boolean | Promise<boolean>, hostMayExit = false): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!await read()) {
      if (!hostMayExit && child && (child.exitCode !== null || child.signalCode !== null)) throw new Error("native_host_exited");
      if (Date.now() >= deadline) throw new Error("probe_timeout");
      await new Promise(done => setTimeout(done, 25));
    }
  }

  try {
    const started = await desktop.request("thread/start", { cwd: workspace, approvalPolicy: "never", sandbox: "read-only" });
    const threadId = codexRecord(started.thread)?.id;
    assert(typeof threadId === "string");
    const inventory = await parent.request("thread/loaded/list", { limit: 10 });
    assert(Array.isArray(inventory.data) && inventory.data.includes(threadId));
    assert.equal((await channel.inspect(threadId)).available, true);
    const events = readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const handoff = events.find(event => event.event === "native_cli_exec");
    assert.equal(handoff?.pid, child?.pid);
    console.log("Original CLI PID, stdio frontend and second Unix client: PASS");

    stage = "graph_wake";
    const deliveries: { request: OutcomeDispatchRequest; effect: OutcomeDispatchEffectKey }[] = [];
    app = GraphApplication.open({ workspaceDir: workspace, storeRoot: join(root, "graph"), env: {},
      declareInvocationIdentity: false, workerSessionOf: execution => execution.executionId,
      deliver: (request, effect) => { deliveries.push({ request, effect }); },
      notifications: { send: notice => channel.send(notice) } });
    const tools = app.createTools();
    const context = (sessionID: string): CanonicalToolContext => ({ sessionID, messageID: "probe-call", agent: "orchestrator",
      directory: workspace, worktree: workspace, abort: new AbortController().signal, metadata() {}, async ask() {} });
    await tools.graph_declare!.execute({ declaration: { version: 3, name: "launcher-wake", nodes: [
      { id: "work", agent: "worker", prompt: "Finish fixture work", outcomes: [{ id: "done" }] },
    ], edges: [] } }, context(threadId));
    await desktop.request("turn/start", { threadId, input: [{ type: "text", text: "Background work continues. End this turn." }] });
    await eventually(() => completed.length === 1);
    assert.equal(inputs.length, 1);
    const delivery = deliveries[0]!;
    app.host.confirmExecution(delivery.effect, { executionId: "fixture-worker" });
    const submitted = await tools.graph_submit_outcome!.execute({ graph_id: "launcher-wake", node_id: "work", outcome_id: "done",
      credential: delivery.request.credential }, context("fixture-worker"));
    assert(typeof submitted === "string" && codexRecord(JSON.parse(submitted))?.decision === "accepted");
    await app.notifications!.flush();
    await eventually(() => completed.length === 2);
    assert.equal(inputs.length, 2);
    assert(JSON.stringify(inputs[1]).includes("[GRAPH COMPLETE]"));
    assert(JSON.stringify(inputs[1]).includes("launcher-wake"));
    parent.close(); channel.close();
    const read = await desktop.request("thread/read", { threadId, includeTurns: true });
    assert.equal(codexRecord(read.thread)?.id, threadId);
    console.log("Graph completion after parent end reached the stdio frontend's next turn: PASS");
    console.log("Notifier disconnect preserved the original shared host: PASS");
    stage = "desktop_eof";
    assert(child && typeof handoff?.relayPid === "number");
    child.stdin.end();
    await eventually(() => child!.exitCode !== null || child!.signalCode !== null, true);
    await eventually(() => { try { process.kill(handoff.relayPid, 0); return false; } catch { return true; } }, true);
    console.log("Desktop EOF reaped the original CLI and relay: PASS");
  } catch (error) {
    process.exitCode = 1;
    console.error(`Desktop launcher probe failed at ${stage}; native IPC acceptance requires the real desktop.`);
    const safeEvents = existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line).event) : [];
    console.error(JSON.stringify({ events: safeEvents, exitCode: child?.exitCode, signal: child?.signalCode,
      rpcCode: error instanceof Error ? error.message.match(/\(code (-?\d+)\)|\((-?\d+)\)/)?.[0] : undefined }));
  } finally {
    app?.close(); channel.close(); parent.close(); desktop.close();
    if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(done => {
      const timer = setTimeout(() => { child?.kill("SIGKILL"); done(); }, 2000);
      child!.once("exit", () => { clearTimeout(timer); done(); });
    });
    await new Promise(done => setTimeout(done, 200));
  }
} catch {
  process.exitCode = 1;
  console.error("Desktop launcher probe setup failed; verify the build and configured runtimes.");
} finally {
  await closeModel();
  rmSync(root, { recursive: true, force: true });
}
