import { approvalPolicy, controlScenarios, eventually, assertRestored, verifyHostProcessRestart } from "./scenarios.ts";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
const hostRequire = createRequire(import.meta.resolve("@deepseek-ai/dsh-agent-loop"));
const hostModule = (name: string) => import(hostRequire.resolve("@deepseek-ai/" + name));
const { Context } = await hostModule("cordis");
const { default: SessionStore, SessionId } = await hostModule("dsh-session");
const { default: AgentRegistry } = await hostModule("dsh-agent");
const { default: AgentLoop } = await hostModule("dsh-agent-loop");
const { default: SystemPrompt } = await hostModule("dsh-system-prompt");
const { default: ToolRegistry } = await hostModule("dsh-tools");
const { default: LlmService, LlmAdapter } = await hostModule("dsh-llm");
const { default: SubagentService } = await hostModule("dsh-subagent");
const spawn = await hostModule("dsh-subagent-spawn");
import * as rolebox from "../../src/entries/dsh.ts";
import { queryGraphs } from "../../src/graph/query/graph-query.ts";
import { graphStoreRoot } from "../../src/graph/store/schema.ts";

const original = process.cwd();
const restoreRoot = process.env.ROLEBOX_SMOKE_RESTORE_ROOT;
const root = restoreRoot ?? mkdtempSync(join(tmpdir(), "rolebox-dsh-smoke-"));
const previousData = process.env.ROLEBOX_DATA_DIR;
const previousRecovery = process.env.ROLEBOX_ENGINE_RECOVERY;
const previousApproval = process.env.ROLEBOX_GRAPH_APPROVAL_POLICY;
process.env.ROLEBOX_GRAPH_APPROVAL_POLICY = approvalPolicy("dsh", "dsh-other");
const previousPolicies = process.env.ROLEBOX_GRAPH_COMPLETION_POLICIES;
const data = join(root, "data");
process.env.ROLEBOX_DATA_DIR = data;
process.env.ROLEBOX_ENGINE_RECOVERY = restoreRoot ? "on" : "off";
process.env.ROLEBOX_GRAPH_COMPLETION_POLICIES = JSON.stringify({ declare: [{ id: "smoke", revision: "1", body: { version: 1, default: "deny", rules: ["dsh.natural", "dsh.restart-natural"].map(graphId => ({ graphId, nodeId: "work", outcome: "done", decision: "allow" })) } }], authorize: ["smoke@1"] });
let parentDeclaration: unknown = { version: 3, name: "dsh.smoke", budget: { max_executions: 0 },
  nodes: [{ id: "work", agent: "smoke", prompt: "Verify.", outcomes: [{ id: "done" }] }], edges: [] };
let parentAction: { tool: string; args: unknown } | undefined;
const results = new Map<string, any>();
const ctx = new Context();
const fibers: any[] = [];
let unsafeCalls = 0;
let sandboxProbes = 0;
let deniedProbes = 0;
let consumedInputs = 0;
class ScriptedAdapter extends LlmAdapter {
  async *stream(options: any): AsyncIterable<any> {
    const texts = options.messages.flatMap((message: any) => (message.content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text)).join("\n");
    const last = JSON.stringify(options.messages.at(-1));
    const graphId = texts.match(/graph_id:\s+([^\s]+)/)?.[1];
    const nodeId = texts.match(/node_id:\s+([^\s]+)/)?.[1];
    const credential = texts.match(/credential:\s+([^\s]+)/)?.[1];
    const history = JSON.stringify(options.messages);
    if (graphId) writeFileSync(join(root, graphId + ".ready"), "ready");
    if (graphId && texts.includes("FAIL_FIXTURE") && !existsSync(join(root, graphId + ".failed"))) {
      writeFileSync(join(root, graphId + ".failed"), "failed");
      yield { type: "finish", reason: { kind: "error", failure: { message: "fixture failure", code: "UNKNOWN" } } };
      return;
    }
    while (graphId && texts.includes("WAIT_FIXTURE") && !existsSync(join(root, graphId + ".release"))) {
      options.signal?.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (graphId && last.includes("probe-okay")) sandboxProbes++;
    if (nodeId === "review" && last.includes("accepted-upstream")) consumedInputs++;
    if (!texts.includes("NATURAL_FIXTURE") && ((graphId && !history.includes('"name":"graph_submit_outcome"')) || !last.includes('"tool-result"'))) {
      let tool = graphId ? "graph_submit_outcome" : parentAction?.tool ?? "graph_declare";
      let args: unknown = graphId ? { graph_id: graphId, node_id: nodeId, outcome_id: "done", credential, ...(graphId === "dsh.explicit" && nodeId === "work" ? { data: { marker: "accepted-upstream" } } : {}) } : parentAction?.args ?? { declaration: parentDeclaration };
      if (graphId && !history.includes('"name":"graph_worker_exec"')) {
        tool = "graph_worker_exec";
        const manifestPath = nodeId === "review" ? texts.match(/manifest:\s+([^\n]+)/)?.[1] : undefined;
        const readInput = manifestPath ? "cat '" + manifestPath.replaceAll("'", "'\\''") + "'; " : "";
        args = { command: readInput + "if cat data/protected >/dev/null 2>&1; then exit 40; fi; if (echo modified > data/protected) 2>/dev/null; then exit 41; fi; echo probe-okay" };
      } else if (graphId && !history.includes('"name":"unsafe_probe"')) {
        tool = "unsafe_probe"; args = {};
      }
      const block = { type: "tool-call" as const, id: randomUUID(), name: tool, arguments: JSON.stringify(args) };
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "block-end", index: 0, block };
      yield { type: "finish", reason: { kind: "tool-calls" } };
    } else {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "fixture complete" } };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }
}
try {
  process.chdir(root);
  mkdirSync(join(root, "rolebox", "smoke"), { recursive: true });
  writeFileSync(join(root, "rolebox", "smoke", "role.yaml"), "name: Smoke\ndescription: Host verification\nprompt: Verify the graph.\nmodel: example-provider/deterministic\nsubagents:\n  - name: Worker\n    description: Deterministic worker\n    prompt: Complete the fixture.\n    model: example-provider/deterministic\n");
  for (const plugin of [SessionStore, AgentRegistry, LlmService, SystemPrompt, ToolRegistry, SubagentService]) fibers.push(ctx.plugin(plugin));
  fibers.push(ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 }));
  fibers.push(ctx.plugin(spawn, { providerName: "spawn" }));

  let mountTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.all(fibers.map(fiber => fiber.await())), new Promise((_, reject) => {
      mountTimer = setTimeout(() => reject(new Error("Host services failed to mount")), 3000);
    })]);
  } finally { clearTimeout(mountTimer); }
  ctx.llm.registerAdapter(["example-provider"], new ScriptedAdapter());
  mkdirSync(data, { recursive: true }); writeFileSync(join(data, "protected"), "host-state");
  ctx.on("tools/result", (execution: any, result: any) => { if (execution.name === "unsafe_probe" && result.isError) deniedProbes++; if (execution.name.startsWith("graph_")) results.set(execution.agent?.id + ":" + execution.name, result.value); });
  ctx.tools.register({ name: "unsafe_probe", description: "A forbidden worker fixture", parameters: { type: "object", properties: {} },
    output: { schema: {}, render: () => [{ type: "text", text: "unsafe" }] }, execute: async () => { unsafeCalls++; return "unsafe"; } });
  let dispose = await rolebox.apply(ctx as unknown as rolebox.DshPluginContext, rolebox.Config.parse({ roleboxDir: join(root, "rolebox") }));
  const handle = await ctx.agents.create({ sessionId: SessionId("dsh-parent"), meta: { cwd: root }, agentOptions: { provider: "example-provider", model: "deterministic" } });
  if (restoreRoot) {
    parentAction = { tool: "graph_status", args: { scope: "all", format: "json" } };
    handle.agent.followup({ role: "user", id: randomUUID(), content: [{ type: "text", text: "Read restored graphs." }] });
    await handle.agent.whenIdle();
    assert.ok(results.has(handle.agent.id + ":graph_status"));
    assertRestored(root, queryGraphs(graphStoreRoot(data, root)).graphs);
    console.log(JSON.stringify({ host: "dsh", processRecovery: "verified" }));
    await handle.dispose(); await dispose();
  } else {
  handle.agent.followup({ role: "user", id: randomUUID(), content: [{ type: "text", text: "Declare the graph fixture." }] });
  await handle.agent.whenIdle();
  const graph = queryGraphs(graphStoreRoot(data, root)).graphs[0];
  assert.equal(graph?.graphId, "dsh.smoke");
  assert.equal(graph.phase, "ready");
  parentDeclaration = { version: 3, name: "dsh.explicit", nodes: [
    { id: "work", agent: "smoke--worker", prompt: "Produce.", outcomes: [{ id: "done" }] },
    { id: "review", agent: "smoke--worker", prompt: "Consume.", inputs: [{ from: "work", outcome: "done" }], outcomes: [{ id: "done" }] },
  ], edges: [{ from: "work", to: "review", outcome: "done" }] };
  handle.agent.followup({ role: "user", id: randomUUID(), content: [{ type: "text", text: "Execute the graph chain." }] });
  await handle.agent.whenIdle();
  let explicit;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    explicit = queryGraphs(graphStoreRoot(data, root)).graphs.find(item => item.graphId === "dsh.explicit");
    if (explicit?.phase === "complete") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(explicit?.phase, "complete", "Real dsh child execution did not complete");
  assert.equal(explicit.current.attempts.length, 2);
  assert.equal(consumedInputs, 1, "Real dsh consumer did not read its accepted input manifest");
  assert.equal(unsafeCalls, 0, "Worker reached an unfiltered host tool");
  assert.equal(sandboxProbes, 2, "Worker sandbox probe did not run through the real registry");
  assert.equal(deniedProbes, 2, "Host did not report denial of the forbidden tool");
  parentDeclaration = { version: 3, name: "dsh.natural", completion_policy: { id: "smoke", revision: "1" },
    nodes: [{ id: "work", agent: "smoke--worker", prompt: "NATURAL_FIXTURE", completion: { mode: "natural", outcome: "done" }, outcomes: [{ id: "done" }] }], edges: [] };
  handle.agent.followup({ role: "user", id: randomUUID(), content: [{ type: "text", text: "Execute natural completion." }] });
  await handle.agent.whenIdle();
  let natural;
  const naturalDeadline = Date.now() + 10_000;
  while (Date.now() < naturalDeadline) {
    natural = queryGraphs(graphStoreRoot(data, root)).graphs.find(item => item.graphId === "dsh.natural");
    if (natural?.phase === "complete") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(natural?.phase, "complete", "Real dsh natural completion did not settle");
  const other = await ctx.agents.create({ sessionId: SessionId("dsh-other"), meta: { cwd: root }, agentOptions: { provider: "example-provider", model: "deterministic" } });
  const controls = await controlScenarios({ host: "dsh", workspace: root, approver: "dsh-other",
    read: id => queryGraphs(graphStoreRoot(data, root)).graphs.find(graph => graph.graphId === id),
    async call(tool, args, actor = "owner") {
      parentAction = { tool, args };
      const target = actor === "owner" ? handle : other;
      target.agent.followup({ role: "user", id: randomUUID(), content: [{ type: "text", text: "Execute the next verification command." }] });
      await target.agent.whenIdle();
      const result = results.get(target.agent.id + ":" + tool);
      return typeof result === "string" ? JSON.parse(result) : result;
    },
  });
  await other.dispose();
  for (const natural of [false, true]) {
    const name = natural ? "dsh.restart-natural" : "dsh.restart";
    const declaration = { version: 3, name,
      ...(natural ? { completion_policy: { id: "smoke", revision: "1" } } : {}),
      nodes: [{ id: "work", agent: "smoke--worker", prompt: natural ? "WAIT_FIXTURE NATURAL_FIXTURE" : "WAIT_FIXTURE",
        ...(natural ? { completion: { mode: "natural", outcome: "done" } } : {}), outcomes: [{ id: "done" }] }], edges: [] };
    parentAction = { tool: "graph_declare", args: { declaration } };
    handle.agent.followup({ role: "user", id: randomUUID(), content: [{ type: "text", text: "Declare restart fixture." }] });
    await handle.agent.whenIdle();
    await eventually(() => existsSync(join(root, name + ".ready")), ready => ready, "dsh child did not become ready before reload");
  }
  await dispose();
  delete process.env.ROLEBOX_ENGINE_RECOVERY;
  dispose = await rolebox.apply(ctx as unknown as rolebox.DshPluginContext, rolebox.Config.parse({ roleboxDir: join(root, "rolebox") }));
  for (const name of ["dsh.restart", "dsh.restart-natural"]) {
    writeFileSync(join(root, name + ".release"), "ready");
    const restarted = await eventually(() => queryGraphs(graphStoreRoot(data, root)).graphs.find(graph => graph.graphId === name), graph => graph?.phase === "complete", name + " failed to finish after host reload");
    assert.equal(restarted?.current?.attempts.length, 1);
  }
  await handle.dispose();
  await dispose();
  await verifyHostProcessRestart(import.meta.path, root, queryGraphs(graphStoreRoot(data, root)).graphs);
  console.log(JSON.stringify({ host: "dsh", mode: "real-sdk-scripted-provider", declaration: "persisted", budgetRefusal: true, explicitChain: "complete", downstreamInput: "verified", natural: "complete", sandbox: "enforced", ...controls, hostReload: "reattached", naturalAfterReload: "complete", processRecovery: "verified" }));
  }
} catch (error) { console.error(error); throw error; } finally {
  for (const fiber of fibers.reverse()) await fiber.dispose();
  process.chdir(original);
  if (previousData === undefined) delete process.env.ROLEBOX_DATA_DIR; else process.env.ROLEBOX_DATA_DIR = previousData;
  if (previousRecovery === undefined) delete process.env.ROLEBOX_ENGINE_RECOVERY; else process.env.ROLEBOX_ENGINE_RECOVERY = previousRecovery;
  if (previousPolicies === undefined) delete process.env.ROLEBOX_GRAPH_COMPLETION_POLICIES; else process.env.ROLEBOX_GRAPH_COMPLETION_POLICIES = previousPolicies;
  if (previousApproval === undefined) delete process.env.ROLEBOX_GRAPH_APPROVAL_POLICY; else process.env.ROLEBOX_GRAPH_APPROVAL_POLICY = previousApproval;
  if (!restoreRoot) rmSync(root, { recursive: true, force: true });
}
