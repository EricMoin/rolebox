import { approvalPolicy, controlScenarios, eventually, assertRestored, verifyHostProcessRestart } from "./scenarios.ts";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import rolebox from "../../src/entries/pi.ts";
import { queryGraphs } from "../../src/graph/query/graph-query.ts";
import { graphStoreRoot } from "../../src/graph/store/schema.ts";

const originalDirectory = process.cwd();
const restoreRoot = process.env.ROLEBOX_SMOKE_RESTORE_ROOT;
const root = restoreRoot ?? mkdtempSync(join(tmpdir(), "rolebox-pi-smoke-"));
const agentDir = join(root, "pi-agent");
const dataDir = join(root, "data");
const previous = new Map<string, string | undefined>();
for (const [key, value] of Object.entries({ PI_CODING_AGENT_DIR: agentDir, ROLEBOX_DATA_DIR: dataDir, ROLEBOX_ENGINE_RECOVERY: restoreRoot ? "on" : "off", ROLEBOX_GRAPH_COMPLETION_POLICIES: JSON.stringify({ declare: [{ id: "smoke", revision: "1", body: { version: 1, default: "deny", rules: ["pi.natural", "pi.restart-natural"].map(graphId => ({ graphId, nodeId: "work", outcome: "done", decision: "allow" })) } }], authorize: ["smoke@1"] }) })) {
  previous.set(key, process.env[key]); process.env[key] = value;
}
let other: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
try {
  process.chdir(root);
  mkdirSync(join(root, "rolebox", "smoke"), { recursive: true });
  writeFileSync(join(root, "rolebox", "smoke", "role.yaml"), "name: Smoke\ndescription: Deterministic host verification\nprompt: Verify the local graph.\nsubagents:\n  - name: Worker\n    description: Deterministic worker\n    prompt: Complete the fixture.\n    model: example-worker/deterministic\n");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  const providerModule = import.meta.resolve("@earendil-works/pi-ai/providers/faux");
  const entryModule = new URL("../../src/entries/pi.ts", import.meta.url).href;
  writeFileSync(join(agentDir, "extensions", "fixture.ts"), `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(providerModule)};
import rolebox from ${JSON.stringify(entryModule)};
export default async function (pi) {
  const core = createFauxCore({ provider: "example-worker", models: [{ id: "deterministic" }] });
  pi.registerProvider("example-worker", { api: core.api, apiKey: "fixture-only", models: core.models,
    streamSimple(model, context, options) {
      const messages = context.messages ?? [];
      const texts = messages.flatMap(message => typeof message.content === "string" ? [message.content] : (message.content ?? []).filter(block => block.type === "text").map(block => block.text)).join("\\n");
      const graphId = texts.match(/graph_id:\\s+([^\\s]+)/)?.[1];
      const nodeId = texts.match(/node_id:\\s+([^\\s]+)/)?.[1];
      const credential = texts.match(/credential:\\s+([^\\s]+)/)?.[1];
      if (graphId === "pi.explicit" && nodeId === "review") {
        const manifestPath = texts.match(/manifest:\\s+([^\\n]+)/)?.[1];
        const input = JSON.parse(readFileSync(manifestPath, "utf8")).inputs[0];
        if (input.from !== "work" || input.payload.value.marker !== "accepted-upstream") throw new Error("Downstream input did not preserve accepted data");
        writeFileSync("pi.explicit.consumed", "verified");
      }
      const submitted = messages.some(message => message.role === "toolResult" && message.toolName === "graph_submit_outcome");
      let response = graphId && credential && !submitted && !texts.includes("NATURAL_FIXTURE")
        ? fauxAssistantMessage(fauxToolCall("graph_submit_outcome", { graph_id: graphId, node_id: nodeId, outcome_id: "done", credential, ...(graphId === "pi.explicit" && nodeId === "work" ? { data: { marker: "accepted-upstream" } } : {}) }), { stopReason: "toolUse" })
        : fauxAssistantMessage("worker complete");
      core.setResponses([async () => {
        if (graphId) writeFileSync(graphId + ".ready", "ready");
        if (texts.includes("FAIL_FIXTURE") && !existsSync(graphId + ".failed")) {
          writeFileSync(graphId + ".failed", "failed");
          return fauxAssistantMessage("fixture failed", { stopReason: "error", errorMessage: "fixture failure" });
        }
        while (texts.includes("WAIT_FIXTURE") && !existsSync(graphId + ".release")) {
          options?.signal?.throwIfAborted();
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return response;
      }]);
      return core.streamSimple(model, context, options);
    },
  });
  if (process.env.ROLEBOX_ACTIVE_AGENT) await rolebox(pi);
}
`);

  const faux = fauxProvider({ provider: "example-provider", models: [{ id: "deterministic" }] });
  const model = faux.getModel();
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), modelNetworkEnabled: false });
  runtime.registerNativeProvider(faux.provider);
  const manager = SessionManager.create(root, join(root, "sessions"));
  const otherManager = SessionManager.create(root, join(root, "sessions"));
  previous.set("ROLEBOX_GRAPH_APPROVAL_POLICY", process.env.ROLEBOX_GRAPH_APPROVAL_POLICY);
  process.env.ROLEBOX_GRAPH_APPROVAL_POLICY = approvalPolicy("pi", otherManager.getSessionId());
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, extensionFactories: [rolebox], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const created = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model, resourceLoader: loader, sessionManager: manager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }), tools: ["graph_declare", "graph_status", "graph_audit", "graph_control"] });
  session = created.session;
  assert.equal(created.extensionsResult.errors.length, 0, JSON.stringify(created.extensionsResult.errors));
  if (restoreRoot) {
    faux.setResponses([fauxAssistantMessage(fauxToolCall("graph_status", { scope: "all", format: "json" }), { stopReason: "toolUse" }), fauxAssistantMessage("restored")]);
    await session.prompt("Read the restored graphs through the registered tool.");
    assert.ok(session.messages.some(message => message.role === "toolResult" && message.toolName === "graph_status"));
    assertRestored(root, queryGraphs(graphStoreRoot(dataDir, root)).graphs);
    console.log(JSON.stringify({ host: "pi", processRecovery: "verified" }));
  } else {
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("graph_declare", { declaration: { version: 3, name: "pi.smoke", budget: { max_executions: 0 }, nodes: [{ id: "work", agent: "smoke", prompt: "Verify", outcomes: [{ id: "done" }] }], edges: [] } }), { stopReason: "toolUse" }),
    fauxAssistantMessage("declaration recorded"),
  ]);
  await session.prompt("Declare the deterministic graph smoke fixture.");
  const graph = queryGraphs(graphStoreRoot(dataDir, root)).graphs[0];
  assert.equal(graph?.graphId, "pi.smoke", "registered tool was not called by the real Pi session");
  assert.equal(graph.phase, "ready");
  assert.ok(manager.getSessionId(), "missing real host session identity");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("graph_declare", { declaration: { version: 3, name: "pi.explicit", nodes: [
      { id: "work", agent: "smoke--worker", prompt: "Produce.", outcomes: [{ id: "done" }] },
      { id: "review", agent: "smoke--worker", prompt: "Consume.", inputs: [{ from: "work", outcome: "done" }], outcomes: [{ id: "done" }] },
    ], edges: [{ from: "work", to: "review", outcome: "done" }] } }), { stopReason: "toolUse" }),
    fauxAssistantMessage("execution started"),
    fauxAssistantMessage("graph completion received"),
  ]);
  await session.prompt("Execute the explicit graph fixture.");
  const deadline = Date.now() + 20_000;
  let explicit;
  while (Date.now() < deadline) {
    explicit = queryGraphs(graphStoreRoot(dataDir, root)).graphs.find(item => item.graphId === "pi.explicit");
    if (explicit?.phase === "complete") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(explicit?.phase, "complete", "real Pi child execution did not complete");
  assert.equal(explicit.current?.attempts.length, 2);
  assert.ok(existsSync(join(root, "pi.explicit.consumed")), "Real Pi consumer did not read the accepted input manifest");
  await eventually(() => session!.messages.some(message => message.role === "custom" &&
    typeof message.content === "string" && message.content.includes("[GRAPH COMPLETE]") && message.content.includes('"graph_id":"pi.explicit"')),
  notified => notified, "Real Pi parent did not receive graph completion");
  await eventually(() => session!.isStreaming, streaming => !streaming, "Pi parent did not finish its notification turn");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("graph_declare", { declaration: { version: 3, name: "pi.natural",
      completion_policy: { id: "smoke", revision: "1" },
      nodes: [{ id: "work", agent: "smoke--worker", prompt: "NATURAL_FIXTURE", completion: { mode: "natural", outcome: "done" }, outcomes: [{ id: "done" }] }], edges: [] } }), { stopReason: "toolUse" }),
    fauxAssistantMessage("natural execution started"),
    fauxAssistantMessage("natural graph completion received"),
  ]);
  await session.prompt("Execute the natural completion fixture.");
  let natural;
  const naturalDeadline = Date.now() + 20_000;
  while (Date.now() < naturalDeadline) {
    natural = queryGraphs(graphStoreRoot(dataDir, root)).graphs.find(item => item.graphId === "pi.natural");
    if (natural?.phase === "complete") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(natural?.phase, "complete", "Real Pi natural completion did not settle");
  await eventually(() => session!.messages.some(message => message.role === "custom" &&
    typeof message.content === "string" && message.content.includes("[GRAPH COMPLETE]") && message.content.includes('"graph_id":"pi.natural"')),
  notified => notified, "Real Pi parent did not receive natural graph completion");
  await eventually(() => session!.isStreaming, streaming => !streaming, "Pi parent did not finish its natural notification turn");
  other = (await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model, resourceLoader: loader, sessionManager: otherManager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }), tools: ["graph_declare", "graph_status", "graph_audit", "graph_control"] })).session;
  const controls = await controlScenarios({ host: "pi", workspace: root, approver: otherManager.getSessionId(),
    read: id => queryGraphs(graphStoreRoot(dataDir, root)).graphs.find(graph => graph.graphId === id),
    async call(tool, args, actor = "owner") {
      const target = actor === "owner" ? session! : other!;
      faux.setResponses([fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" }), fauxAssistantMessage("command complete")]);
      await target.prompt("Execute the next verification command.");
      const result = [...target.messages].reverse().find(message => message.role === "toolResult" && message.toolName === tool);
      assert.ok(result && "content" in result);
      const content = result.content as { type: string; text?: string }[];
      return JSON.parse(content.filter(block => block.type === "text").map(block => block.text).join(""));
    },
  });
  for (const natural of [false, true]) {
    const name = natural ? "pi.restart-natural" : "pi.restart";
    const declaration = { version: 3, name,
      ...(natural ? { completion_policy: { id: "smoke", revision: "1" } } : {}),
      nodes: [{ id: "work", agent: "smoke--worker", prompt: natural ? "WAIT_FIXTURE NATURAL_FIXTURE" : "WAIT_FIXTURE",
        ...(natural ? { completion: { mode: "natural", outcome: "done" } } : {}), outcomes: [{ id: "done" }] }], edges: [] };
    faux.setResponses([fauxAssistantMessage(fauxToolCall("graph_declare", { declaration }), { stopReason: "toolUse" }), fauxAssistantMessage("restart fixture declared")]);
    await session.prompt("Start the restart fixture.");
    await eventually(() => existsSync(join(root, name + ".ready")), ready => ready, "Pi child did not become ready before reload");
  }
  other.dispose(); other = undefined;
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
  session.dispose(); session = undefined;
  delete process.env.ROLEBOX_ENGINE_RECOVERY;
  const restoredLoader = new DefaultResourceLoader({ cwd: root, agentDir, extensionFactories: [rolebox], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await restoredLoader.reload();
  session = (await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model, resourceLoader: restoredLoader, sessionManager: manager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }), tools: ["graph_status"] })).session;
  for (const name of ["pi.restart", "pi.restart-natural"]) {
    writeFileSync(join(root, name + ".release"), "ready");
    const restarted = await eventually(() => queryGraphs(graphStoreRoot(dataDir, root)).graphs.find(graph => graph.graphId === name), graph => graph?.phase === "complete", name + " failed to finish after host reload");
    assert.equal(restarted?.current?.attempts.length, 1);
  }
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose(); session = undefined;
  await verifyHostProcessRestart(import.meta.path, root, queryGraphs(graphStoreRoot(dataDir, root)).graphs);
  console.log(JSON.stringify({ host: "pi", mode: "real-sdk-scripted-provider", declaration: "persisted", budgetRefusal: true, sessionIdentity: true, explicitChain: "complete", downstreamInput: "verified", natural: "complete", ...controls, hostReload: "reattached", naturalAfterReload: "complete", processRecovery: "verified" }));

  }
} finally {
  other?.dispose();
  await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session?.dispose();
  process.chdir(originalDirectory);
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  if (!restoreRoot && !process.env.ROLEBOX_SMOKE_KEEP) rmSync(root, { recursive: true, force: true });
}
