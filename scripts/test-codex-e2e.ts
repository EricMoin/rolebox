import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dump } from "js-yaml";
import { CodexAppServerClient, codexRecord, type CodexRecord } from "../src/platform/adapters/codex/app-server/app-server.ts";
import { GraphStore } from "../src/graph/store/graph-store.ts";
import { graphStoreRoot } from "../src/graph/store/schema.ts";
import { decodeStoredDefinition, readStoredRunStateOf } from "../src/graph/persistence/declared-record.ts";

if (process.env.ROLEBOX_CODEX_LIVE !== "1") throw new Error("Set ROLEBOX_CODEX_LIVE=1 to run authenticated Codex model tasks.");
const sandbox = process.env.ROLEBOX_CODEX_E2E_SANDBOX?.trim() || "workspace-write";
if (sandbox && !["read-only", "workspace-write", "danger-full-access"].includes(sandbox)) throw new Error("Unsupported live-test sandbox mode");

const repository = resolve(import.meta.dirname, "..");
const reportPath = join(repository, ".rolebox", "evidence", "codex-live-e2e.json");
const originalHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "rolebox-codex-live-")));
const workspace = join(scratch, "workspace");
const isolatedHome = join(scratch, "codex");
const roleboxData = join(scratch, "data");
const roleId = "codex-e2e-director";
const childId = `${roleId}--private-worker`;
const nativeName = `rolebox--${roleId}`;
const graphId = `codex-live-${randomUUID()}`;
const directorMarker = `DIRECTOR_${randomUUID()}`;
const privateMarker = `PRIVATE_${randomUUID()}`;
const deniedDirectory = sandbox === "workspace-write" ? realpathSync(mkdtempSync(join(homedir(), ".rolebox-codex-denied-"))) : undefined;
const deniedFile = deniedDirectory ? join(deniedDirectory, "guard.txt") : undefined;
let networkCanaryConnections = 0;
const networkCanary = createServer(socket => { networkCanaryConnections++; socket.on("error", () => {}); socket.end("reachable"); });
let probeDigest: string | undefined;
let blockedNativePatchObserved = false;
let sandboxProbeExecuted = false;
const startedAt = Date.now();
const evidence: Record<string, unknown> = { authenticatedModelTurns: true };
let passed = false;
let stopping = false;
const stop = () => { stopping = true; };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const originalEnvironment = new Map(["CODEX_HOME", "ROLEBOX_DATA_DIR", "ROLEBOX_CONFIG_DIR"].map(name => [name, process.env[name]]));
const authPath = join(originalHome, "auth.json");
const authDigest = existsSync(authPath) ? createHash("sha256").update(readFileSync(authPath)).digest("hex") : undefined;
let stage = "prepare";
let rpc: CodexAppServerClient | undefined;
let rootThreadId: string | undefined;
let rootTurnId: string | undefined;
let rootTerminal: CodexRecord | undefined;
let latestNativeError: string | undefined;
let nativeChildCount = 0;
const nativeCandidates = new Set<string>();
const events: Record<string, number> = {};
const completedItems: Record<string, number> = {};
let rootReply = "";
let forkResult = "";
let outerProcess: ChildProcessWithoutNullStreams | undefined;
let diagnostics = "";
const privateValues = new Set<string>([directorMarker, privateMarker]);

function safeText(value: unknown): string {
  let result = String(value);
  for (const privateValue of privateValues) result = result.replaceAll(privateValue, "<configured-value>");
  return result.replace(/https?:\/\/\S+|\S*\/\S*/g, "<path>").replace(/\b[a-f0-9]{48,}\b/gi, "<token>")
    .replace(/'[^']*'|"[^"]*"/g, "<value>").slice(0, 2000);
}

function progress(step: string, detail: Record<string, unknown> = {}): void {
  process.stdout.write(JSON.stringify({ stage: step, elapsedMs: Date.now() - startedAt, ...detail }) + "\n");
}

function graphReading() {
  const store = GraphStore.openFile(graphStoreRoot(roleboxData, workspace));
  try {
    const definition = store.readDefinition(graphId);
    if (!definition) return undefined;
    const decoded = decodeStoredDefinition(definition);
    if (decoded.kind !== "ok") throw new Error("The live graph definition is unreadable");
    const state = readStoredRunStateOf(store, decoded.declared);
    return {
      phase: state.kind === "recorded" ? state.state.phase : state.kind,
      accepted: store.acceptedEvents(graphId), origin: store.readInvocationOrigin(graphId),
    };
  } finally { store.close(); }
}

try {
  mkdirSync(workspace);
  mkdirSync(isolatedHome);
  if (deniedFile) {
    writeFileSync(deniedFile, "UNCHANGED\n", { mode: 0o600 });
    await new Promise<void>(resolveListen => networkCanary.listen(0, "127.0.0.1", resolveListen));
    const address = networkCanary.address();
    assert(address && typeof address !== "string");
    await new Promise<void>((resolveConnection, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: address.port });
      socket.resume();
      socket.on("error", reject);
      socket.on("close", () => resolveConnection());
    });
    networkCanaryConnections = 0;
    const probe = [
      'import { writeFileSync } from "node:fs";',
      'import { createConnection } from "node:net";',
      'let outsideWriteDenied = false;',
      `try { writeFileSync(${JSON.stringify(deniedFile)}, "FORBIDDEN"); } catch (error) { outsideWriteDenied = ["EPERM", "EACCES", "EROFS"].includes(error.code); }`,
      'const networkDenied = await new Promise(resolve => {',
      `  const socket = createConnection({ host: "127.0.0.1", port: ${address.port} });`,
      '  const timer = setTimeout(() => { socket.destroy(); resolve(true); }, 2000);',
      '  socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(false); });',
      '  socket.once("error", () => { clearTimeout(timer); resolve(true); });',
      '});',
      'const result = { marker: process.argv[2], outsideWriteDenied, networkDenied };',
      'writeFileSync("sandbox-probe.json", JSON.stringify(result));',
      'console.log(JSON.stringify(result));',
      'if (!outsideWriteDenied || !networkDenied) process.exitCode = 1;',
    ].join("\n");
    writeFileSync(join(workspace, "sandbox-probe.mjs"), probe, { mode: 0o444 });
    probeDigest = createHash("sha256").update(probe).digest("hex");
  }
  const configPath = join(originalHome, "config.toml");
  assert(existsSync(configPath), "Sync rolebox to Codex before running live acceptance");
  const bundle = JSON.parse(readFileSync(join(originalHome, "rolebox-marketplace", "plugins", "rolebox", ".mcp.json"), "utf8"));
  const serverEntry = join(repository, "dist", "entries", "codex.js");
  assert.deepEqual(bundle.mcpServers.rolebox.args, [serverEntry], "Sync this build's CLI to Codex before live acceptance");
  evidence.builtServerSha256 = createHash("sha256").update(readFileSync(serverEntry)).digest("hex");
  copyFileSync(configPath, join(isolatedHome, "config.toml"));
  appendFileSync(join(isolatedHome, "config.toml"), `\n[projects.${JSON.stringify(workspace)}]\ntrust_level="trusted"\n`);
  chmodSync(join(isolatedHome, "config.toml"), 0o600);
  if (existsSync(authPath)) symlinkSync(authPath, join(isolatedHome, "auth.json"));
  const roleDir = join(workspace, "rolebox", roleId);
  mkdirSync(roleDir, { recursive: true });
  mkdirSync(join(workspace, ".rolebox"));
  writeFileSync(join(workspace, ".rolebox", "config.json"), JSON.stringify({ computerUse: false, browseUse: false }));
  const declaration = {
    version: 3, name: graphId, budget: { max_executions: 2 },
    nodes: [
      { id: "produce", agent: childId, prompt: [
        ...(deniedFile ? [
          `First use native apply_patch once with this exact patch:\n*** Begin Patch\n*** Update File: ${deniedFile}\n@@\n-UNCHANGED\n+FORBIDDEN\n*** End Patch\nThis owned test canary is outside your allowed writable roots; the patch must fail. Do not request expanded permissions.`,
          "Next run the existing sandbox-probe.mjs using native exec_command, with your private marker as its sole argument, from the workspace. Do not edit the probe. It must report outsideWriteDenied=true and networkDenied=true. Stop and report any unexpected success.",
        ] : []),
        "Write private-produced.txt containing exactly your private marker. Submit done with evidence_refs naming that file and a short data.summary.",
      ].join("\n\n"), completion: { mode: "explicit" }, budget: { timeout_ms: 180000 }, outcomes: [{ id: "done" }] },
      { id: "verify", agent: childId, prompt: "Read the accepted upstream manifest supplied in the handoff. Read its retained private-produced.txt artifact and check it equals your private marker. Write private-verified.txt with that exact value. Submit done with that file as evidence and a short data.summary.", inputs: [{ from: "produce", outcome: "done" }], completion: { mode: "explicit" }, budget: { timeout_ms: 180000 }, outcomes: [{ id: "done" }] },
    ], edges: [{ from: "produce", to: "verify", outcome: "done" }],
  };
  writeFileSync(join(roleDir, "role.yaml"), dump({
    name: "Codex E2E Director", description: "Runs the requested rolebox native-agent integration check.",
    prompt: [
      "You are the live rolebox integration director. Follow these exact steps; do not delegate with native spawn_agent from this role.",
      `First use native Codex file tools to create native-role.txt containing exactly ${directorMarker}.`,
      "Next call the registered rolebox graph_declare with the following complete declaration (JSON object or JSON string as its schema requires):",
      JSON.stringify(declaration),
      "Use graph_status to collect the graph until its phase is complete and both nodes have accepted outcomes. Do not stop after graph_declare returns started.",
      "Do not perform the private worker's task yourself, reveal its instructions, or recreate a graph if it fails. Report errors as observed.",
      "After graph_status proves complete, return DIRECTOR_VERIFIED. Leave native agent cleanup to the test harness.",
    ].join("\n\n"),
    subagents: [{
      name: "Private Worker", description: "Produces or verifies one assigned integration artifact.",
      prompt: [
        `Your private marker is ${privateMarker}. It must come from these private role instructions.`,
        "Perform only your assigned produce or verify task. Use native Codex file/shell tools inside the inherited sandbox.",
        "Use the actual credential and identities from the host's handoff in graph_submit_outcome. Submit outcome_id done only after the file checks succeed.",
        "Pass data as an object with summary and evidence_refs as the assigned existing artifact paths. Stop after an accepted submission. Never write the credential to a file.",
      ].join("\n\n"),
    }],
  }));
  process.env.CODEX_HOME = isolatedHome;
  process.env.ROLEBOX_DATA_DIR = roleboxData;
  process.env.ROLEBOX_CONFIG_DIR = join(scratch, "rolebox-config");

  stage = "native-file-generation";
  const built = await import(pathToFileURL(join(repository, "dist", "entries", "codex.js")).href);
  const preparation = await built.startCodexMcpServer({ directory: workspace, computerUse: false, browseUse: false });
  preparation.close();
  const nativeFiles = readdirSync(join(workspace, ".codex", "agents"));
  assert.deepEqual(nativeFiles, [`${nativeName}.toml`]);
  const nativeContents = readFileSync(join(workspace, ".codex", "agents", nativeFiles[0]), "utf8");
  assert(nativeContents.includes(directorMarker));
  assert(!nativeContents.includes(privateMarker));
  evidence.nativeRoleExported = true;
  evidence.privateChildNotNativeDiscoverable = true;
  progress(stage, { publicNativeFiles: nativeFiles.length, privateChildPublished: false });

  stage = "codex-startup";
  rpc = new CodexAppServerClient({
    cwd: workspace, requestTimeoutMs: 60000,
    args: ["app-server", "--listen", "stdio://", "-c", `projects.${JSON.stringify(workspace)}.trust_level="trusted"`],
    async handleElicitation(params) {
      const tool = typeof params.message === "string" ? /run tool ["'](graph_declare|graph_status|session_list|session_read|session_info|session_diff|session_search|session_fork)["']\?/.exec(params.message)?.[1] : undefined;
      const schema = codexRecord(params.requestedSchema);
      const allowed = params.serverName === "rolebox" && params.mode === "form" && Boolean(tool) &&
        schema?.type === "object" && Object.keys(codexRecord(schema.properties) ?? {}).length === 0;
      progress("approval-request", { tool, authorizedFixtureTool: allowed });
      return { action: allowed ? "accept" : "decline", content: allowed ? {} : null, _meta: null };
    },
    spawnProcess(command, args, options) {
      outerProcess = spawn(command, [...args], { ...options, stdio: "pipe", detached: process.platform !== "win32",
        env: { ...process.env, RUST_LOG: "warn,codex_rmcp_client=info,codex_core::mcp_connection_manager=debug" } });
      outerProcess.stderr.on("data", chunk => { diagnostics = (diagnostics + String(chunk)).slice(-32000); });
      return outerProcess;
    },
  });
  rpc.onNotification((method, params) => {
    events[method] = (events[method] ?? 0) + 1;
    const item = codexRecord(params.item);
    if (method === "item/completed" && params.threadId === rootThreadId) {
      if (item?.type === "subAgentActivity" && typeof item.agentThreadId === "string") nativeCandidates.add(item.agentThreadId);
      if (item?.type === "collabAgentToolCall" && Array.isArray(item.receiverThreadIds)) {
        for (const id of item.receiverThreadIds) if (typeof id === "string") nativeCandidates.add(id);
      }
    }
    if (method === "warning" || method === "configWarning") {
      progress("codex-warning", { message: safeText(params.message ?? params.summary ?? "Startup warning") });
    }
    if (method === "item/completed" && typeof item?.type === "string") {
      completedItems[item.type] = (completedItems[item.type] ?? 0) + 1;
      if (params.threadId === rootThreadId && item.type === "agentMessage") rootReply += String(item.text ?? "");
      if (params.threadId === rootThreadId && item.type === "mcpToolCall" && item.tool === "session_fork") {
        const content = codexRecord(item.result)?.content;
        if (Array.isArray(content)) forkResult = content.map(part => String(codexRecord(part)?.text ?? "")).join("\n");
      }
    }
    if (method === "item/completed" && item?.type === "collabAgentToolCall") {
      progress("native-delegation-event", { tool: item.tool, status: item.status });
    }
    if (method === "item/completed" && item?.type === "mcpToolCall" && typeof item.tool === "string" && item.tool.startsWith("graph_")) {
      progress("graph-tool-event", { tool: item.tool, status: item.status });
    }
    if (method === "thread/started" && codexRecord(params.thread)?.agentRole === nativeName) nativeChildCount++;
    if (method === "turn/completed" && params.threadId === rootThreadId) rootTerminal = codexRecord(params.turn);
    if (method === "error") latestNativeError = String(codexRecord(params.error)?.message ?? "Codex execution error");
  });
  const effective = codexRecord((await rpc.request("config/read", { cwd: workspace, includeLayers: false })).config) ?? {};
  for (const value of [effective.model, effective.model_provider, ...Object.keys(codexRecord(effective.model_providers) ?? {})]) {
    if (typeof value === "string" && value) privateValues.add(value);
  }
  const catalogs = await rpc.request("plugin/list", { cwds: [workspace], marketplaceKinds: ["local"] });
  progress("plugin-catalog", { responseKeys: Object.keys(catalogs), localCatalogHasRolebox: JSON.stringify(catalogs).includes('"rolebox"') });
  const marketplace = (catalogs.marketplaces as CodexRecord[]).find(item => item.name === "rolebox");
  progress("rolebox-marketplace", { found: Boolean(marketplace), keys: Object.keys(marketplace ?? {}) });
  await rpc.request("plugin/install", { marketplacePath: marketplace?.path ?? join(originalHome, "rolebox-marketplace", ".agents", "plugins", "marketplace.json"), pluginName: "rolebox" });
  progress("plugin-installed", { localBundle: true });
  const plugins = codexRecord(effective.plugins) ?? {};
  const servers = codexRecord(effective.mcp_servers) ?? {};
  const thread = await rpc.request("thread/start", {
    cwd: workspace, ephemeral: false,
    ...(sandbox ? { sandbox } : {}),
    config: {
      "features.plugins": true, "agents.enabled": true, "agents.max_concurrent_threads_per_session": 2,
      "features.multi_agent": true, "features.multi_agent_v2": false,
      "skills.include_instructions": false, "skills.bundled.enabled": false, "features.memories": false,
      plugins: Object.fromEntries(Object.keys(plugins).map(name => [name, { enabled: name === "rolebox@rolebox" }])),
      mcp_servers: Object.fromEntries(Object.keys(servers).map(name => [name, { enabled: false }])),
    },
  });
  rootThreadId = String(codexRecord(thread.thread)?.id ?? "");
  assert(rootThreadId, "Codex did not create the live root thread");
  const inventory = await rpc.request("mcpServerStatus/list", { threadId: rootThreadId, detail: "toolsAndAuthOnly" });
  progress("mcp-inventory", { servers: (inventory.data as CodexRecord[]).map(server => ({
    rolebox: String(server.name).includes("rolebox"), toolCount: Object.keys(codexRecord(server.tools) ?? {}).length,
    graphTools: Object.keys(codexRecord(server.tools) ?? {}).filter(name => name.includes("graph_")).map(name => name.split("__").at(-1)),
    discoveryError: Boolean(server.toolsError),
    ...(String(server.name).includes("rolebox") && server.toolsError ? { error: safeText(server.toolsError) } : {}),
  })) });
  const rolebox = (inventory.data as CodexRecord[]).find(server => Object.keys(codexRecord(server.tools) ?? {}).some(name => name === "graph_declare" || name.endsWith("__graph_declare")));
  assert(rolebox, "The synced rolebox plugin was not loaded by Codex");
  assert(codexRecord(codexRecord(rolebox.serverCapabilities)?.experimental)?.["codex/sandbox-state"] !== undefined, "The live rolebox server did not advertise sandbox inheritance");
  evidence.syncedPluginLoaded = true;
  evidence.registeredRoleboxTools = Object.keys(codexRecord(rolebox.tools) ?? {}).length;
  evidence.permissionMode = codexRecord(thread.sandbox)?.type;
  if (deniedFile) {
    assert.equal(evidence.permissionMode, "workspaceWrite");
    assert.equal(codexRecord(thread.sandbox)?.networkAccess, false, "The live parent must retain default network restrictions");
    const roots = codexRecord(thread.sandbox)?.writableRoots;
    assert(Array.isArray(roots) && !roots.some(root => typeof root === "string" && (deniedFile === root || deniedFile.startsWith(root + "/"))), "The canary must lie outside the parent's writable roots");
    evidence.parentNetworkRestricted = true;
  }
  progress(stage, { tools: evidence.registeredRoleboxTools, sandboxExtension: true, permissionMode: codexRecord(thread.sandbox)?.type });

  stage = "native-model-task";
  const turn = await rpc.request("turn/start", {
    threadId: rootThreadId,
    input: [{ type: "text", text: [
      "This is an explicitly authorized live integration test of rolebox's Codex adapter.",
      `Use Codex's native spawn_agent delegation with agent_type ${JSON.stringify(nativeName)} to select that custom agent's configuration. Spawn exactly one such agent, with no model/provider overrides.`,
      "Ask it to perform the verification defined by its own role instructions. Wait for its result. Do not read or perform the director or private worker's instructions yourself.",
      "The director must actually run its graph and await accepted outcomes. Leave completed agents open so the harness can inspect their native metadata.",
      "Use no external services other than the existing model connection. Return ROOT_VERIFIED only after the director reports success; otherwise report the observed problem.",
    ].join("\n\n"), text_elements: [] }],
  });
  rootTurnId = String(codexRecord(turn.turn)?.id ?? "");
  const deadline = Date.now() + 480000;
  let previousAccepted = -1;
  while (Date.now() < deadline) {
    assert(!stopping, "Live acceptance was interrupted");
    const reading = graphReading();
    if (reading && reading.accepted.length !== previousAccepted) {
      previousAccepted = reading.accepted.length;
      progress("ledger-progress", { phase: reading.phase, acceptedOutcomes: reading.accepted.length });
    }
    if (rootTerminal) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 1000));
  }
  assert(rootTerminal, "The live Codex model task exceeded its deadline");
  assert.equal(rootTerminal.status, "completed", "The live root turn did not complete normally");
  const listed = await rpc.request("thread/list", { cwd: workspace, modelProviders: [], sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther"], limit: 100 });
  progress("thread-observation", { threads: (listed.data as CodexRecord[]).map(row => ({
    nativeDirector: row.agentRole === nativeName, rolePresent: typeof row.agentRole === "string", parentIsRoot: row.parentThreadId === rootThreadId,
  })) });
  const children = await Promise.all([...nativeCandidates].map(async id => codexRecord((await rpc!.request("thread/read", { threadId: id, includeTurns: false })).thread)));
  const director = [...(listed.data as CodexRecord[]), ...children].find(row => row?.agentRole === nativeName && row.parentThreadId === rootThreadId);
  assert(director, "No real native custom-agent child was recorded");
  for (const row of listed.data as CodexRecord[]) {
    const result = await rpc.request("thread/read", { threadId: row.id, includeTurns: true });
    if (deniedFile) {
      const turns = codexRecord(result.thread)?.turns as CodexRecord[] ?? [];
      for (const turn of turns) for (const item of (turn.items as CodexRecord[] ?? [])) {
        if (item.type === "commandExecution" && String(item.command).includes("sandbox-probe.mjs") && item.exitCode === 0 && item.status === "completed") sandboxProbeExecuted = true;
        if ((item.type === "fileChange" || (item.type === "commandExecution" && String(item.command).includes("apply_patch"))) &&
          JSON.stringify(item).includes(deniedFile)) blockedNativePatchObserved = true;
      }
    }
    const errors = ((codexRecord(result.thread)?.turns ?? []) as CodexRecord[]).filter(turn => turn.status === "failed")
      .map(turn => safeText(codexRecord(turn.error)?.message ?? "Native turn failed without an error message"));
    if (errors.length) progress("native-turn-errors", { messages: errors });
  }
  assert.equal(readFileSync(join(workspace, "native-role.txt"), "utf8").trim(), directorMarker, "The native role prompt marker was not applied");
  assert.equal(readFileSync(join(workspace, "private-produced.txt"), "utf8").trim(), privateMarker, "The private role prompt marker was not applied");
  assert.equal(readFileSync(join(workspace, "private-verified.txt"), "utf8").trim(), privateMarker, "The sequential worker did not verify its retained upstream artifact");
  const reading = graphReading();
  assert(reading, "The real graph did not reach the acceptance ledger");
  assert.equal(reading.phase, "complete", "The real graph did not complete");
  assert.equal(reading.accepted.length, 2, "Both real workers must submit accepted outcomes");
  assert.equal(reading.origin?.sessionId, director.id, "Graph origin must be the native director's actual thread ID");
  if (deniedFile) {
    assert.equal(readFileSync(deniedFile, "utf8"), "UNCHANGED\n", "A worker escaped its inherited write restrictions");
    const probe = JSON.parse(readFileSync(join(workspace, "sandbox-probe.json"), "utf8"));
    assert.equal(probe.marker, privateMarker);
    assert.equal(probe.outsideWriteDenied, true);
    assert.equal(probe.networkDenied, true);
    assert(sandboxProbeExecuted, "The sandbox probe was not executed successfully through a native command tool");
    assert.equal(networkCanaryConnections, 0, "A worker escaped its inherited network restrictions");
    assert.equal(createHash("sha256").update(readFileSync(join(workspace, "sandbox-probe.mjs"))).digest("hex"), probeDigest);
    evidence.outsideWriteDenied = true;
    assert(blockedNativePatchObserved, "The native outside-workspace patch attempt was not recorded");
    evidence.nativePatchOutsideWriteDenied = blockedNativePatchObserved;
    evidence.workerNetworkDenied = true;
    evidence.nativeSandboxProbeExecuted = sandboxProbeExecuted;
  }
  stage = "session-tools";
  const invoke = async (tool: string, args: CodexRecord): Promise<string> => {
    const result = await rpc!.request("mcpServer/tool/call", { threadId: rootThreadId, server: rolebox.name, tool, arguments: args });
    if (result.isError) progress("session-tool-error", { tool, message: safeText(JSON.stringify(result.content)) });
    assert(!result.isError, `The live ${tool} call failed`);
    return (result.content as CodexRecord[]).filter(part => part.type === "text").map(part => part.text).join("\n");
  };
  assert((await invoke("session_list", { limit: 20 })).includes(rootThreadId.slice(0, 8)));
  const transcript = await invoke("session_read", { session_id: rootThreadId });
  assert(transcript.includes(rootThreadId) && transcript.includes("explicitly authorized live integration test"));
  assert((await invoke("session_info", { session_id: rootThreadId })).includes(rootThreadId));
  assert((await invoke("session_diff", { session_id: director.id })).length > 0);
  const matches = JSON.parse(await invoke("session_search", { session_id: rootThreadId, query: "ROOT_VERIFIED", format: "json" }));
  assert(Array.isArray(matches) ? matches.length > 0 : JSON.stringify(matches).includes("ROOT_VERIFIED"));
  const completedTurnId = rootTurnId;
  rootTerminal = undefined;
  const forkTurn = await rpc.request("turn/start", { threadId: rootThreadId, input: [{ type: "text", text:
    `Continue the authorized temporary integration test: call rolebox session_fork with session_id ${JSON.stringify(rootThreadId)} and message_id ${JSON.stringify(completedTurnId)}. ` +
    "This completed turn is the fork boundary. Use the actual MCP tool during this turn so Codex supplies execution authority. Do not run the new fork. Return FORK_VERIFIED only if the tool reports Session Forked Successfully; otherwise quote its error.",
    text_elements: [] }] });
  rootTurnId = String(codexRecord(forkTurn.turn)?.id ?? "");
  const forkDeadline = Date.now() + 90000;
  while (!rootTerminal && Date.now() < forkDeadline) {
    assert(!stopping, "Live acceptance was interrupted");
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  assert.equal(codexRecord(rootTerminal)?.status, "completed", "The native fork verification turn did not complete");
  assert(forkResult.includes("Session Forked Successfully"), "The native session_fork call did not create a fork");
  evidence.verifiedSessionTools = 6;
  evidence.nativeRoleSelected = true;
  evidence.nativeRolePromptApplied = true;
  evidence.privateRolePromptApplied = true;
  evidence.acceptedOutcomes = reading.accepted.length;
  evidence.sequentialArtifactVerified = true;
  evidence.nativeThreadAttribution = true;
  evidence.graphPhase = reading.phase;
  evidence.nativeDelegationEvents = Math.max(nativeChildCount, nativeCandidates.size);
  passed = true;
  progress("passed", evidence);
} catch (error) {
  const safe = error instanceof assert.AssertionError ? error.message.split(":")[0] : error instanceof Error ? safeText(error.message) : "Unknown error";
  progress("failed", { failedStage: stage, error: safe, nativeRuntimeErrorObserved: latestNativeError !== undefined,
    rootReportedUnavailable: /unavailable|not available|not exposed|cannot.*spawn|can't.*spawn/i.test(rootReply), rootReply: safeText(rootReply), completedItems, events });
  const relevantDiagnostics = diagnostics.split("\n").filter(line => /rolebox|uncaught|ERR_MODULE|ENOENT|TypeError|SyntaxError/i.test(line));
  if (relevantDiagnostics.length) progress("diagnostics", { messages: relevantDiagnostics.slice(-8).map(line => {
    try { const parsed = JSON.parse(line); return Object.fromEntries(Object.entries(parsed.fields ?? { message: parsed.message }).map(([key, value]) => [key, safeText(value)])); }
    catch { return safeText(line); }
  }) });
  const nativeErrors: string[] = [];
  const inspectRollouts = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) inspectRollouts(path);
      else if (entry.name.endsWith(".jsonl")) {
        for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
          try {
            const record = JSON.parse(line);
            if (record.type === "event_msg" && record.payload?.type === "error") nativeErrors.push(safeText(record.payload.message));
          } catch { /* A live rollout may have an incomplete final record. */ }
        }
      }
    }
  };
  inspectRollouts(join(isolatedHome, "sessions"));
  if (nativeErrors.length) progress("native-errors", { messages: nativeErrors.slice(-5) });
  process.exitCode = 1;
} finally {
  if (rpc && rootThreadId && rootTurnId && !rootTerminal) {
    try { await rpc.request("turn/interrupt", { threadId: rootThreadId, turnId: rootTurnId }); } catch { /* The transport may already have closed. */ }
  }
  rpc?.close();
  if (process.platform !== "win32" && outerProcess?.pid) {
    try { process.kill(-outerProcess.pid, "SIGTERM"); } catch { /* The group already exited. */ }
  }
  await new Promise(resolveWait => setTimeout(resolveWait, 1500));
  if (process.platform !== "win32" && outerProcess?.pid) {
    try { process.kill(-outerProcess.pid, "SIGKILL"); } catch { /* The group already exited. */ }
  }
  const temporaryAuth = join(isolatedHome, "auth.json");
  if (authDigest && existsSync(authPath) && existsSync(temporaryAuth) && !lstatSync(temporaryAuth).isSymbolicLink() &&
    createHash("sha256").update(readFileSync(authPath)).digest("hex") === authDigest) {
    copyFileSync(temporaryAuth, authPath);
    chmodSync(authPath, 0o600);
  }
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  networkCanary.close();
  if (deniedDirectory) rmSync(deniedDirectory, { recursive: true, force: true });
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  mkdirSync(join(repository, ".rolebox", "evidence"), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({ result: passed ? "passed" : "failed", checkedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt, ...evidence, temporaryWorkspaceRemoved: true }, null, 2) + "\n", { mode: 0o600 });
  progress("cleanup", { temporaryWorkspaceRemoved: true });
}
