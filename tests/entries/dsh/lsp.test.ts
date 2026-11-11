import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Context, Service } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import roleboxPlugin, { type DshPluginDisposer } from "../../../src/entries/dsh.ts";
import { isServerAvailable, LANGUAGE_SERVER_REGISTRY } from "../../../src/lsp/servers.ts";
import type { DshSubagentProvider } from "../../../src/platform/adapters/dsh/roles/agent-registrar.ts";
import { DshLspService } from "../../../src/platform/adapters/dsh/tools/lsp.ts";
import { LspClientManager } from "../../../src/lsp/client-manager.ts";

class Sessions extends Service {
  readonly entries = new Map<string, { id: string; header: { cwd: string }; events: { type: string; data?: unknown }[] }>();
  constructor(ctx: Context) { super(ctx, "sessions"); }
  get(id: string) { return this.entries.get(id); }
  list() { return [...this.entries.values()]; }
}

class Subagents extends Service {
  constructor(ctx: Context) { super(ctx, "subagents"); }
  registerProvider(_provider: DshSubagentProvider) { return () => {}; }
  getProvider() { return undefined; }
  list() { return []; }
}

class WorkingDirectory extends Service {
  readonly roots = new Map<string, string>();
  constructor(ctx: Context) { super(ctx, "workingDirectory"); }
  get(session: { id: string }) { return this.roots.get(session.id); }
}

let directory: string;
let originalEnvironment: Record<"DSH_HOME" | "ROLEBOX_DATA_DIR", string | undefined>;
const cleanups: Array<() => void | Promise<void>> = [];
const originalServers = LANGUAGE_SERVER_REGISTRY.typescript;
const hasTypeScriptServer = isServerAvailable("typescript");
beforeEach(() => {
  originalEnvironment = { DSH_HOME: process.env.DSH_HOME, ROLEBOX_DATA_DIR: process.env.ROLEBOX_DATA_DIR };
  directory = mkdtempSync(join(tmpdir(), "dsh-lsp-"));
  for (const name of ["roles", "skills", "host", "data"]) mkdirSync(join(directory, name));
  process.env.DSH_HOME = join(directory, "host");
  process.env.ROLEBOX_DATA_DIR = join(directory, "data");
  LANGUAGE_SERVER_REGISTRY.typescript = [{
    ...originalServers![0]!, command: process.execPath,
    args: [fileURLToPath(new URL("../../lsp/fixtures/server.mjs", import.meta.url)), "--trace-file", join(directory, "trace.jsonl")],
  }];
});
afterEach(async () => {
  try {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup(); }
      catch (error) { errors.push(error); }
    }
    try { expect(trace().filter(entry => entry.event === "spawn" && alive(entry.pid))).toEqual([]); }
    catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "LSP test cleanup failed");
  }
  finally {
    LANGUAGE_SERVER_REGISTRY.typescript = originalServers!;
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

function trace() {
  const file = join(directory, "trace.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
    .map(line => JSON.parse(line) as { event: string; pid: number; method?: string; id?: number; uri?: string; diagnostics?: number }) : [];
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function fixture(takenHover = false) {
  const ctx = new Context();
  for (const plugin of [SystemPrompt, ToolRuntime]) {
    const fiber = await ctx.plugin(plugin, {});
    cleanups.push(() => fiber.dispose());
  }
  const sessions = new Sessions(ctx);
  const workingDirectory = new WorkingDirectory(ctx);
  new Subagents(ctx);
  if (takenHover) cleanups.push(ctx.tools.register({
    name: "lsp_hover", description: "Host hover", parameters: { type: "object" },
    output: { schema: {}, render: () => [] }, execute: async () => "host",
  }));
  let disposer: DshPluginDisposer | undefined;
  const fiber = await ctx.plugin({
    ...roleboxPlugin,
    async apply(c: unknown, config: unknown) {
      disposer = await roleboxPlugin.apply(c as never, config as never);
      return disposer;
    },
  }, {
    roleboxDir: join(directory, "roles"), skillsDir: join(directory, "skills"),
    computerUse: false, browseUse: false, enabledNamespaces: ["lsp"],
  });
  cleanups.push(async () => { await fiber.dispose(); await disposer?.whenDisposed(); });
  await expect.poll(() => disposer).toBeDefined();

  function session(id: string, root: string) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.ts"), 'export const answer: number = "bad";\n');
    const value = { id, header: { cwd: root }, events: [] as { type: string; data?: unknown }[] };
    sessions.entries.set(id, value);
    return { id, session: value } as unknown as Agent;
  }
  let sequence = 0;
  async function call(name: string, args: Record<string, unknown>, agent: Agent, signal = new AbortController().signal) {
    const result = await ctx.tools.execute({ name, arguments: args, agent, signal, callId: `lsp-${++sequence}` as ToolCallId });
    expect(result.isError, JSON.stringify(result)).toBe(false);
    const text = result.content.map(block => block.type === "text" ? block.text : "").join("\n");
    expect(text).not.toMatch(/^(Error\b|Request timed out|invalid arguments|This language server does not support)/);
    return text;
  }
  function changeWorkspace(agent: Agent, root: string) {
    const value = sessions.get(String(agent.id))!;
    const event = { type: "working-directory/change", data: { cwd: root } };
    value.events.push(event);
    ctx.emit("session/event", value as never, event as never);
  }
  function disposeSession(agent: Agent) {
    const value = sessions.get(String(agent.id))!;
    sessions.entries.delete(String(agent.id));
    ctx.emit("session/disposed", value as never);
  }
  return { ctx, session, call, changeWorkspace, disposeSession, workingDirectory, disposer: disposer!, fiber };
}

describe("DSH LSP through the installed tool runtime and a stdio server", () => {
  it.each(["--fail-initialize", "--hang-initialize"])("reaps a server that ignores SIGTERM after %s", async mode => {
    LANGUAGE_SERVER_REGISTRY.typescript![0]!.args!.push(mode, "--ignore-sigterm");
    const manager = new LspClientManager(directory);
    cleanups.push(() => manager.shutdownAll());
    const request = manager.request.bind(manager);
    const override = vi.spyOn(manager, "request").mockImplementation((method, params, languageId, timeout) =>
      request(method, params, languageId, method === "initialize" ? 1500 : timeout));
    cleanups.push(() => override.mockRestore());
    await expect(manager.startServer("typescript")).rejects.toThrow(mode === "--hang-initialize" ? "timed out" : "initialization failed");
    const spawned = trace().filter(entry => entry.event === "spawn");
    expect(spawned).toHaveLength(1);
    expect(alive(spawned[0]!.pid)).toBe(false);
    expect(manager.servers.size).toBe(0);
  }, 10000);

  it("uses fresh diagnostics as quickfix context after edits", async () => {
    LANGUAGE_SERVER_REGISTRY.typescript![0]!.args!.push("--require-diagnostic-context", "--slow-diagnostics");
    const f = await fixture();
    const root = join(directory, "quickfix & + $ , ; = @");
    const agent = f.session("main", root);
    const filePath = join(root, "index.ts");
    const range = { filePath, startLine: 0, startChar: 0, endLine: 0, endChar: 34 };
    writeFileSync(filePath, "export const answer: number = 42;\n");
    await f.call("lsp_document_symbols", { filePath }, agent);
    writeFileSync(filePath, 'export const answer: number = "bad";\n');
    expect(await f.call("lsp_code_actions", range, agent)).toContain("Fixture fix");
    writeFileSync(filePath, "export const answer: number = 42;\n");
    await f.call("lsp_document_symbols", { filePath }, agent);
    writeFileSync(filePath, 'export const answer: number = "bad";\n');
    expect(await f.call("lsp_execute_code_action", { ...range, title: "Fixture fix" }, agent)).toContain("## Code Action:");
    expect(readFileSync(filePath, "utf8")).toContain("const fixed:");
    expect(trace().filter(entry => entry.method === "textDocument/codeAction").map(entry => entry.diagnostics)).toEqual([1, 1]);
  });

  it("returns pending diagnostics without repeatedly waiting for a silent server", async () => {
    LANGUAGE_SERVER_REGISTRY.typescript![0]!.args!.push("--no-diagnostics");
    const waits = vi.spyOn(LspClientManager.prototype, "waitForDiagnostics");
    cleanups.push(() => waits.mockRestore());
    const f = await fixture();
    const root = join(directory, "project");
    const agent = f.session("main", root);
    const filePath = join(root, "index.ts");
    expect(await f.call("lsp_diagnostics", { filePath }, agent)).toContain("Diagnostics are not available yet");
    expect(await f.call("lsp_diagnostics", { filePath }, agent)).toContain("Diagnostics are not available yet");
    expect(waits).toHaveBeenCalledTimes(1);
  });

  it("observes background retirement failures and retries their cleanup on unload", async () => {
    const shutdown = vi.spyOn(LspClientManager.prototype, "shutdownAll").mockRejectedValueOnce(new Error("Temporary shutdown failure"));
    cleanups.push(() => shutdown.mockRestore());
    const f = await fixture();
    const first = join(directory, "first");
    const second = join(directory, "second");
    const agent = f.session("main", first);
    f.session("target", second);
    await f.call("lsp_hover", { filePath: join(first, "index.ts"), line: 0, character: 14 }, agent);
    const pid = trace().find(entry => entry.event === "spawn")!.pid;
    f.changeWorkspace(agent, second);
    await expect.poll(() => shutdown.mock.calls.length).toBe(1);
    expect(alive(pid)).toBe(true);
    await f.fiber.dispose();
    await f.disposer.whenDisposed();
    expect(alive(pid)).toBe(false);
  });

  it("uses advertised pull diagnostics when the server does not publish", async () => {
    LANGUAGE_SERVER_REGISTRY.typescript![0]!.args!.push("--no-diagnostics", "--pull-diagnostics");
    const f = await fixture();
    const root = join(directory, "project");
    const agent = f.session("main", root);
    expect(await f.call("lsp_diagnostics", { filePath: join(root, "index.ts") }, agent)).toContain("Expected a number");
    expect(trace().some(entry => entry.method === "textDocument/diagnostic")).toBe(true);
  });

  it("closes an abandoned workspace on cwd change without waiting for another tool call", async () => {
    const f = await fixture();
    const first = join(directory, "first");
    const second = join(directory, "second");
    const agent = f.session("main", first);
    f.session("target", second);
    await f.call("lsp_hover", { filePath: join(first, "index.ts"), line: 0, character: 14 }, agent);
    const pid = trace().find(entry => entry.event === "spawn")!.pid;
    f.changeWorkspace(agent, second);
    await expect.poll(() => alive(pid)).toBe(false);
    expect(await f.call("lsp_hover", { filePath: join(second, "index.ts"), line: 0, character: 14 }, agent))
      .toContain(pathToFileURL(second).href);
  });

  it("keeps a shared workspace until its final session is disposed", async () => {
    const f = await fixture();
    const root = join(directory, "shared");
    const a = f.session("a", root);
    const b = f.session("b", root);
    const args = { filePath: join(root, "index.ts"), line: 0, character: 14 };
    await f.call("lsp_hover", args, a);
    await f.call("lsp_hover", args, b);
    const pid = trace().find(entry => entry.event === "spawn")!.pid;
    f.disposeSession(a);
    expect(alive(pid)).toBe(true);
    await f.call("lsp_hover", args, b);
    expect(trace().filter(entry => entry.event === "spawn")).toHaveLength(1);
    f.disposeSession(b);
    await expect.poll(() => alive(pid)).toBe(false);
  });

  it("keeps other sessions' server when one session changes workspace", async () => {
    const f = await fixture();
    const first = join(directory, "first");
    const second = join(directory, "second");
    const a = f.session("a", first);
    const b = f.session("b", first);
    f.session("target", second);
    const args = { filePath: join(first, "index.ts"), line: 0, character: 14 };
    await f.call("lsp_hover", args, a);
    await f.call("lsp_hover", args, b);
    const pid = trace().find(entry => entry.event === "spawn")!.pid;
    f.changeWorkspace(a, second);
    await f.call("lsp_hover", args, b);
    expect(alive(pid)).toBe(true);
    expect(trace().filter(entry => entry.event === "spawn")).toHaveLength(1);
    f.disposeSession(b);
    await expect.poll(() => alive(pid)).toBe(false);
  });

  it("keeps a returning session's replacement generation while the old one drains", async () => {
    LANGUAGE_SERVER_REGISTRY.typescript![0]!.args!.push("--slow-hover");
    const f = await fixture();
    const first = join(directory, "first");
    const second = join(directory, "second");
    const agent = f.session("main", first);
    f.session("target", second);
    const args = { filePath: join(first, "index.ts"), line: 0, character: 14 };
    const firstCall = f.call("lsp_hover", args, agent);
    await expect.poll(() => trace().some(entry => entry.method === "textDocument/hover")).toBe(true);
    const oldPid = trace().find(entry => entry.event === "spawn")!.pid;
    f.changeWorkspace(agent, second);
    f.changeWorkspace(agent, first);
    const nextCall = f.call("lsp_hover", args, agent);
    await expect.poll(() => trace().filter(entry => entry.event === "spawn").length).toBe(2);
    const newPid = trace().filter(entry => entry.event === "spawn")[1]!.pid;
    expect(newPid).not.toBe(oldPid);
    await firstCall;
    await nextCall;
    await expect.poll(() => alive(oldPid)).toBe(false);
    expect(alive(newPid)).toBe(true);
    expect(await f.call("lsp_hover", args, agent)).toContain(pathToFileURL(first).href);
    expect(trace().filter(entry => entry.event === "spawn")).toHaveLength(2);
  });

  it("drains calls in a retired workspace after its session changes directory", async () => {
    LANGUAGE_SERVER_REGISTRY.typescript![0]!.args!.push("--slow-hover");
    const f = await fixture();
    const first = join(directory, "first");
    const second = join(directory, "second");
    const agent = f.session("main", first);
    f.session("target", second);
    const hover = f.call("lsp_hover", { filePath: join(first, "index.ts"), line: 0, character: 14 }, agent);
    await expect.poll(() => trace().some(entry => entry.method === "textDocument/hover")).toBe(true);
    const pid = trace().find(entry => entry.event === "spawn")!.pid;
    f.changeWorkspace(agent, second);
    expect(alive(pid)).toBe(true);
    expect(await hover).toContain(pathToFileURL(first).href);
    await expect.poll(() => alive(pid)).toBe(false);
    expect(await f.call("lsp_hover", { filePath: join(second, "index.ts"), line: 0, character: 14 }, agent))
      .toContain(pathToFileURL(second).href);
  });

  it("bounds shutdown when the server does not acknowledge it", async () => {
    LANGUAGE_SERVER_REGISTRY.typescript![0]!.args!.push("--ignore-shutdown");
    const f = await fixture();
    const root = join(directory, "project");
    const agent = f.session("main", root);
    await f.call("lsp_hover", { filePath: join(root, "index.ts"), line: 0, character: 14 }, agent);
    const pid = trace().find(entry => entry.event === "spawn")!.pid;
    const started = performance.now();
    await f.fiber.dispose();
    await f.disposer.whenDisposed();
    expect(performance.now() - started).toBeLessThan(5000);
    expect(trace().some(entry => entry.method === "shutdown")).toBe(true);
    expect(alive(pid)).toBe(false);
  }, 8000);

  it("rejects cancellation at the canonical LSP wrapper before acquiring a workspace", async () => {
    let resolved = 0;
    const service = new DshLspService(directory, () => { resolved++; return { directory, sessionID: "main" }; });
    cleanups.push(() => service.dispose());
    const controller = new AbortController();
    const reason = new Error("LSP request cancelled");
    controller.abort(reason);
    await expect(service.tools.lsp_hover!.execute({ filePath: join(directory, "index.ts"), line: 0, character: 0 }, {
      sessionID: "main", messageID: "cancelled", agent: "main", directory, worktree: directory,
      abort: controller.signal, metadata() {}, async ask() {},
    })).rejects.toBe(reason);
    expect(resolved).toBe(0);
    expect(trace()).toEqual([]);
  });

  it("calls all 32 tools, including cold-start hover, diagnostics, rename and hierarchy", async () => {
    const f = await fixture();
    const root = join(directory, "project & + $ , ; = @");
    const agent = f.session("main", root);
    const filePath = join(root, "index.ts");
    const names = f.ctx.tools.schemas().map(tool => tool.name);
    expect(names).toHaveLength(32);
    const detected = await f.call("lsp_servers", {}, agent);
    expect(detected).toContain("### Detected (Not Started)");
    expect(detected).toContain("- typescript");
    expect(detected).not.toContain("### Running");
    expect(trace()).toEqual([]);

    expect(await f.call("lsp_hover", { filePath, line: 0, character: 14 }, agent)).toContain(pathToFileURL(root).href);
    const item = { name: "answer", kind: 13, uri: pathToFileURL(filePath).href,
      range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
      selectionRange: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } } };
    const cases: Array<[string, string, string[]]> = [
      ["lsp_code_actions", "## Code Actions (1)", ["textDocument/codeAction"]],
      ["lsp_code_lens", "## Code Lenses (1)", ["textDocument/codeLens"]],
      ["lsp_completion", "## Completion Items (showing 1 of 1)", ["textDocument/completion"]],
      ["lsp_diagnostics", "Expected a number", []],
      ["lsp_document_colors", "## Document Colors (1)", ["textDocument/documentColor"]],
      ["lsp_document_highlights", "## Document Highlights (1)", ["textDocument/documentHighlight"]],
      ["lsp_document_links", "## Document Links (1)", ["textDocument/documentLink"]],
      ["lsp_document_symbols", "## Document Symbols", ["textDocument/documentSymbol"]],
      ["lsp_execute_code_action", '## Code Action: "Fixture fix"', ["textDocument/codeAction"]],
      ["lsp_find_references", "## References (1)", ["textDocument/references"]],
      ["lsp_folding_ranges", "## Folding Ranges (1)", ["textDocument/foldingRange"]],
      ["lsp_format_document", "## Format Complete", ["textDocument/formatting"]],
      ["lsp_format_range", "## Range Format Complete", ["textDocument/rangeFormatting"]],
      ["lsp_goto_declaration", "## Declarations", ["textDocument/declaration"]],
      ["lsp_goto_definition", "## Definitions", ["textDocument/definition"]],
      ["lsp_goto_implementation", "## Implementations", ["textDocument/implementation"]],
      ["lsp_goto_type_definition", "## Type Definitions", ["textDocument/typeDefinition"]],
      ["lsp_incoming_calls", "## Incoming Calls (1)", ["callHierarchy/incomingCalls"]],
      ["lsp_inlay_hints", "## Inlay Hints (1)", ["textDocument/inlayHint"]],
      ["lsp_outgoing_calls", "## Outgoing Calls (1)", ["callHierarchy/outgoingCalls"]],
      ["lsp_prepare_call_hierarchy", "## Call Hierarchy — 1 item(s)", ["textDocument/prepareCallHierarchy"]],
      ["lsp_prepare_rename", "**Current name:** `answer`", ["textDocument/prepareRename"]],
      ["lsp_rename", "## Rename to `renamed`", ["textDocument/rename"]],
      ["lsp_selection_ranges", "## Selection Ranges (1 position(s))", ["textDocument/selectionRange"]],
      ["lsp_semantic_tokens", "## Semantic Tokens (1)", ["textDocument/semanticTokens/full"]],
      ["lsp_signature_help", "## Signature Help", ["textDocument/signatureHelp"]],
      ["lsp_type_hierarchy_subtypes", "## Subtypes (1)", ["textDocument/prepareTypeHierarchy", "typeHierarchy/subtypes"]],
      ["lsp_type_hierarchy_supertypes", "## Supertypes (1)", ["textDocument/prepareTypeHierarchy", "typeHierarchy/supertypes"]],
      ["lsp_workspace_symbols", '## Workspace Symbols matching "answer"', ["workspace/symbol"]],
    ];
    expect([...cases.map(([name]) => name), "lsp_servers", "lsp_hover", "lsp_restart_server"].sort()).toEqual([...names].sort());
    for (const [name, success, methods] of cases) {
      writeFileSync(filePath, 'export const answer: number = "bad";\n');
      const before = trace().length;
      const result = await f.call(name, {
        filePath, line: 0, character: 14, startLine: 0, startChar: 0, endLine: 0, endChar: 34,
        positions: [{ line: 0, character: 14 }], newName: "renamed", query: "answer", title: "Fixture fix", item,
      }, agent);
      expect(result, name).toContain(success);
      expect(trace().slice(before).filter(entry => entry.id !== undefined).map(entry => entry.method), name).toEqual(methods);
      if (name === "lsp_execute_code_action") expect(readFileSync(filePath, "utf8")).toContain("const fixed:");
      if (name === "lsp_format_document") expect(readFileSync(filePath, "utf8")).toStartWith("// formatted\n");
      if (name === "lsp_format_range") expect(readFileSync(filePath, "utf8")).toStartWith("// range formatted\n");
    }
    const previousPid = trace().find(entry => entry.event === "spawn")!.pid;
    const restarted = await f.call("lsp_restart_server", { languageId: "typescript" }, agent);
    expect(restarted).toContain("Status: running");
    const newPid = Number(restarted.match(/PID: (\d+)/)![1]);
    expect(newPid).not.toBe(previousPid);
    expect(alive(previousPid)).toBe(false);
    expect(await f.call("lsp_hover", { filePath, line: 0, character: 14 }, agent)).toContain("export const answer");
    expect(trace().filter(entry => entry.pid === newPid && entry.method === "textDocument/didOpen")).toHaveLength(1);
  });

  it("starts once for concurrent first calls and refreshes diagnostics after an edit", async () => {
    const f = await fixture();
    const root = join(directory, "project");
    const agent = f.session("main", root);
    const filePath = join(root, "index.ts");
    const [hover, diagnostics] = await Promise.all([
      f.call("lsp_hover", { filePath, line: 0, character: 14 }, agent),
      f.call("lsp_diagnostics", { filePath }, agent),
    ]);
    expect(hover).toContain("export const answer");
    expect(diagnostics).toContain("Expected a number");
    const servers = await f.call("lsp_servers", {}, agent);
    expect(servers.match(/\| typescript \|/g)).toHaveLength(1);
    expect(trace().filter(entry => entry.event === "spawn")).toHaveLength(1);
    writeFileSync(filePath, "export const answer: number = 42;\n");
    expect(await f.call("lsp_diagnostics", { filePath }, agent)).toContain("No diagnostics found");
    expect(await f.call("lsp_hover", { filePath, line: 0, character: 14 }, agent)).toContain("= 42");
  });

  it("accepts a prepare-rename response containing only a range", async () => {
    LANGUAGE_SERVER_REGISTRY.typescript![0]!.args!.push("--range-rename");
    const f = await fixture();
    const agent = f.session("main", join(directory, "project"));
    const result = await f.call("lsp_prepare_rename", { filePath: join(directory, "project", "index.ts"), line: 0, character: 14 }, agent);
    expect(result).toContain("Current name:** `answer`");
  });

  it("isolates session workspaces and follows working-directory changes", async () => {
    const f = await fixture();
    const first = join(directory, "first");
    const second = join(directory, "second");
    const a = f.session("a", first);
    const b = f.session("b", second);
    expect(await f.call("lsp_hover", { filePath: join(first, "index.ts"), line: 0, character: 14 }, a))
      .toContain(pathToFileURL(first).href);
    expect(await f.call("lsp_servers", {}, b)).not.toContain("### Running");
    expect(await f.call("lsp_hover", { filePath: join(second, "index.ts"), line: 0, character: 14 }, b))
      .toContain(pathToFileURL(second).href);
    const changed = join(directory, "changed");
    f.session("changed", changed);
    (a.session as unknown as { events: unknown[] }).events.push({ type: "working-directory/change", data: { cwd: changed } });
    expect(await f.call("lsp_hover", { filePath: join(changed, "index.ts"), line: 0, character: 14 }, a))
      .toContain(pathToFileURL(changed).href);
  });

  it("prefers the workingDirectory service over header and directory-change events", async () => {
    const f = await fixture();
    const header = join(directory, "header");
    const changed = join(directory, "event");
    const serviceRoot = join(directory, "service");
    const agent = f.session("main", header);
    f.session("service-target", serviceRoot);
    f.workingDirectory.roots.set(String(agent.id), serviceRoot);
    f.changeWorkspace(agent, changed);
    expect(await f.call("lsp_hover", { filePath: join(serviceRoot, "index.ts"), line: 0, character: 14 }, agent))
      .toContain(pathToFileURL(serviceRoot).href);
    const pid = trace().find(entry => entry.event === "spawn")!.pid;
    f.changeWorkspace(agent, changed);
    await f.call("lsp_hover", { filePath: join(serviceRoot, "index.ts"), line: 0, character: 14 }, agent);
    expect(trace().filter(entry => entry.event === "spawn")).toHaveLength(1);
    expect(alive(pid)).toBe(true);
  });

  it("uses the collision fallback and shuts down the child on plugin unload", async () => {
    const f = await fixture(true);
    const root = join(directory, "project");
    const agent = f.session("main", root);
    const filePath = join(root, "index.ts");
    expect(await f.call("rb_lsp_hover", { filePath, line: 0, character: 14 }, agent)).toContain("export const answer");
    const servers = await f.call("lsp_servers", {}, agent);
    const pid = Number(servers.match(/\| typescript \| (\d+) \| running/)![1]);
    expect(pid).toBeGreaterThan(0);
    await f.fiber.dispose();
    await f.disposer.whenDisposed();
    expect(f.ctx.tools.get("rb_lsp_hover")).toBeUndefined();
    expect(f.ctx.tools.get("lsp_hover")).toBeDefined();
    await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
  });

  it("drains an accepted call before unloading its server", async () => {
    LANGUAGE_SERVER_REGISTRY.typescript![0]!.args!.push("--slow-hover");
    const f = await fixture();
    const agent = f.session("main", join(directory, "project"));
    const hover = f.call("lsp_hover", { filePath: join(directory, "project", "index.ts"), line: 0, character: 14 }, agent);
    let servers = "";
    await expect.poll(async () => {
      servers = await f.call("lsp_servers", {}, agent);
      return servers.includes("| running |");
    }).toBe(true);
    const pid = Number(servers.match(/\| typescript \| (\d+) \| running/)![1]);
    await f.fiber.dispose();
    await f.disposer.whenDisposed();
    expect(await hover).toContain("export const answer");
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("reports an unavailable server and rejects an already cancelled call", async () => {
    LANGUAGE_SERVER_REGISTRY.typescript = [{ ...originalServers![0]!, command: "rolebox-missing-language-server" }];
    const f = await fixture();
    const agent = f.session("main", join(directory, "project"));
    const result = await f.ctx.tools.execute({ name: "lsp_hover", callId: "missing" as ToolCallId,
      arguments: { filePath: join(directory, "project", "index.ts"), line: 0, character: 14 },
      agent, signal: new AbortController().signal });
    expect(JSON.stringify(result.content)).toContain("ENOENT");
    const controller = new AbortController();
    controller.abort();
    const aborted = await f.ctx.tools.execute({ name: "lsp_servers", callId: "aborted" as ToolCallId,
      arguments: {}, agent, signal: controller.signal });
    expect(aborted).toMatchObject({ isError: true, error: {
      message: "tool call aborted before dispatch", info: { code: "ABORTED_BEFORE_DISPATCH" },
    } });
  });

  it.skipIf(!hasTypeScriptServer)("calls the installed TypeScript language server through DSH", async () => {
    LANGUAGE_SERVER_REGISTRY.typescript = originalServers!;
    const f = await fixture();
    const root = join(directory, "typescript & + $ , ; = @");
    const agent = f.session("typescript", root);
    const filePath = join(root, "index # %.ts");
    writeFileSync(join(root, "index.ts"), "export {};\n");
    const definitionPath = join(root, "math.ts");
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", module: "commonjs", types: [] }, include: ["*.ts"],
    }));
    writeFileSync(definitionPath, "export function double(value: number): number { return value * 2; }\n");
    writeFileSync(filePath, 'import { double } from "./math";\nexport const answer = double(21);\nexport const broken: number = "wrong";\n');

    // Wait for project analysis before asserting a type inferred from an import.
    expect(await f.call("lsp_diagnostics", { filePath }, agent)).toContain("not assignable to type 'number'");
    expect(await f.call("lsp_hover", { filePath, line: 1, character: 14 }, agent)).toContain("number");
    expect(await f.call("lsp_goto_definition", { filePath, line: 1, character: 23 }, agent)).toContain("math.ts");
    expect(await f.call("lsp_document_symbols", { filePath }, agent)).toContain("broken");
    expect(await f.call("lsp_find_references", { filePath: definitionPath, line: 0, character: 17 }, agent)).toContain("index%20%23%20%25.ts");
    expect(await f.call("lsp_diagnostics", { filePath: definitionPath }, agent)).toContain("No diagnostics found");
    expect(await f.call("lsp_prepare_rename", { filePath, line: 1, character: 23 }, agent)).toContain("double");
    expect(await f.call("lsp_rename", { filePath, line: 1, character: 23, newName: "twice" }, agent)).toContain("twice");
    expect(await f.call("lsp_workspace_symbols", { query: "double" }, agent)).toContain("double");
    expect(await f.call("lsp_signature_help", { filePath, line: 1, character: 30 }, agent)).toContain("value: number");
  });
});
