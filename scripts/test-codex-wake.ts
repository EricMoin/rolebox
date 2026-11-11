import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphApplication } from "../src/graph/application/graph-application.ts";
import type { OutcomeDispatchRequest, OutcomeDispatchEffectKey } from "../src/graph/outcome/dispatch-effects.ts";
import { codexRecord } from "../src/platform/adapters/codex/app-server/app-server.ts";
import { CodexParentNotifications, CodexParentSocketClient } from "../src/platform/adapters/codex/graph/parent-notifications.ts";
import type { CanonicalToolContext } from "../src/platform/types.ts";
import { configureLogDirectory } from "../src/logger.ts";

if (process.platform === "win32") throw new Error("This probe requires a Unix socket host");
const root = mkdtempSync(join(tmpdir(), "rolebox-wake-"));
const codexHome = join(root, "home");
const workspace = join(root, "workspace");
mkdirSync(codexHome); mkdirSync(workspace);
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
await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
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
const socketPath = join(root, "control.sock");
const child = spawn(process.env.ROLEBOX_CODEX_COMMAND?.trim() || "codex", ["app-server", "--listen", `unix://${socketPath}`], {
  cwd: workspace, env: { ...process.env, CODEX_HOME: codexHome }, stdio: "ignore",
});
let startupError: Error | undefined;
child.on("error", error => { startupError = error; });
const parent = new CodexParentSocketClient(socketPath);
const channel = new CodexParentNotifications({ env: { ROLEBOX_CODEX_PARENT_SOCKET: socketPath } });
let app: GraphApplication | undefined;

async function eventually(read: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!await read()) {
    if (startupError || child.exitCode !== null) throw new Error("Codex app-server could not start");
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

try {
  await eventually(() => existsSync(socketPath), "the shared host");
  const started = await parent.request("thread/start", { cwd: workspace, approvalPolicy: "never", sandbox: "read-only" });
  const threadId = codexRecord(started.thread)?.id;
  assert.equal(typeof threadId, "string");
  assert(typeof threadId === "string");
  assert.equal((await channel.inspect(threadId)).available, true);
  const deliveries: { request: OutcomeDispatchRequest; effect: OutcomeDispatchEffectKey }[] = [];
  app = GraphApplication.open({ workspaceDir: workspace, storeRoot: join(root, "graph"), env: {},
    declareInvocationIdentity: false, workerSessionOf: execution => execution.executionId,
    deliver: (request, effect) => { deliveries.push({ request, effect }); },
    notifications: { send: notice => channel.send(notice) } });
  const tools = app.createTools();
  const context = (sessionID: string): CanonicalToolContext => ({ sessionID, messageID: "probe-call", agent: "orchestrator",
    directory: workspace, worktree: workspace, abort: new AbortController().signal, metadata() {}, async ask() {} });
  await tools.graph_declare!.execute({ declaration: { version: 3, name: "wake-probe", nodes: [
    { id: "work", agent: "worker", prompt: "Finish fixture work", outcomes: [{ id: "done" }] },
  ], edges: [] } }, context(threadId));
  await parent.request("turn/start", { threadId, input: [{ type: "text", text: "Work is running in the background. End this turn." }] });
  const completedTurns = async () => {
    const result = await parent.request("thread/read", { threadId, includeTurns: true });
    const turns = codexRecord(result.thread)?.turns;
    assert(Array.isArray(turns));
    return turns.filter(item => codexRecord(item)?.status === "completed").length;
  };
  await eventually(async () => await completedTurns() === 1, "the initial parent turn to end");
  assert.equal(inputs.length, 1);
  console.log("Initial parent turn ended while graph work remained in flight: PASS");

  const delivery = deliveries[0]!;
  app.host.confirmExecution(delivery.effect, { executionId: "fixture-worker" });
  const submitted = await tools.graph_submit_outcome!.execute({ graph_id: "wake-probe", node_id: "work", outcome_id: "done",
    credential: delivery.request.credential }, context("fixture-worker"));
  assert.equal(typeof submitted, "string");
  assert(typeof submitted === "string");
  assert.equal(codexRecord(JSON.parse(submitted))?.decision, "accepted");
  await app.notifications!.flush();
  await eventually(async () => await completedTurns() === 2, "the graph notification's new parent turn");
  assert.equal(inputs.length, 2);
  assert(JSON.stringify(inputs[1]).includes("[GRAPH COMPLETE]"));
  assert(JSON.stringify(inputs[1]).includes("wake-probe"));
  channel.close();
  assert.equal(await completedTurns(), 2);
  console.log("Committed graph completion automatically woke the same parent session: PASS");
  console.log("Notification reached the model and disconnect preserved the shared host: PASS");
} finally {
  app?.close(); channel.close(); parent.close();
  child.kill("SIGTERM");
  await new Promise<void>(resolve => {
    if (child.exitCode !== null || startupError) { resolve(); return; }
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  await new Promise<void>(resolve => model.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
