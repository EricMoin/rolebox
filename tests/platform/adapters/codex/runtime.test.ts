import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { startCodexMcpServer, resolveCodexSessionId } from "../../../../src/entries/codex.ts";
import type { CodexMcpServer } from "../../../../src/platform/adapters/codex/server.ts";
import type { CodexRecord, CodexRpc } from "../../../../src/platform/adapters/codex/app-server.ts";

const environment = ["CODEX_HOME", "ROLEBOX_DATA_DIR", "ROLEBOX_CONFIG_DIR", "ROLEBOX_SESSION_ID"];
let saved: Array<[string, string | undefined]>;
let root: string;
let directory: string;
const servers: CodexMcpServer[] = [];

beforeEach(() => {
  saved = environment.map(name => [name, process.env[name]]);
  root = mkdtempSync(join(tmpdir(), "rolebox-codex-runtime-"));
  directory = join(root, "workspace");
  mkdirSync(directory);
  process.env.CODEX_HOME = join(root, "codex");
  process.env.ROLEBOX_DATA_DIR = join(root, "data");
  process.env.ROLEBOX_CONFIG_DIR = join(root, "config");
  delete process.env.ROLEBOX_SESSION_ID;
});

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function installRole(project = false): void {
  const roles = join(project ? directory : process.env.CODEX_HOME!, "rolebox", "reviewer");
  mkdirSync(roles, { recursive: true });
  writeFileSync(join(roles, "role.yaml"), [
    "name: Reviewer", "description: Reviews changes.", "prompt: Review with evidence.",
    "model: native-review-model", "tools:", "  hashline_read: false", "",
  ].join("\n"));
}

async function boot(options: { project?: boolean; actor?: string; computerUse?: boolean; browseUse?: boolean } = {}) {
  const output = new PassThrough();
  let raw = "";
  output.on("data", chunk => { raw += String(chunk); });
  const calls: string[] = [];
  let closed = false;
  const rpc: CodexRpc = {
    async request(method, params) {
      calls.push(method);
      if (method === "thread/read") return { thread: {
        id: params!.threadId, cwd: directory, agentRole: options.actor ?? "rolebox--reviewer",
        createdAt: 10, updatedAt: 20, status: { type: "notLoaded" },
      } };
      if (method === "thread/list") return { data: [], nextCursor: null };
      throw new Error("Unexpected app-server request");
    },
    onNotification() { return () => {}; },
    setRequestHandler() {},
    close() { closed = true; },
  };
  const server = await startCodexMcpServer({
    directory, output, computerUse: options.computerUse ?? false, browseUse: options.browseUse ?? false,
    rpcFactory: () => rpc,
  });
  servers.push(server);
  let id = 0;
  return {
    server, calls, closed: () => closed,
    async request(method: string, params: CodexRecord = {}) {
      const requestId = ++id;
      await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
      const response = raw.split("\n").filter(Boolean).map(line => JSON.parse(line) as CodexRecord).find(message => message.id === requestId)!;
      return response.result as { capabilities?: CodexRecord; tools?: Array<{ name: string; inputSchema: CodexRecord }>; instructions?: string; content: Array<{ text: string }>; isError?: boolean };
    },
  };
}

describe("Codex MCP runtime integration", () => {
  it("boots without starting Codex and exposes the complete session and graph schemas", async () => {
    const harness = await boot();
    expect(harness.calls).toEqual([]);
    const initialized = await harness.request("initialize", { protocolVersion: "2025-06-18" });
    expect(initialized.capabilities).toEqual({ tools: { listChanged: false }, experimental: { "codex/sandbox-state": {} } });
    expect(initialized.instructions).toContain("do not assume this capability without parent_notification.available=true");
    const listed = (await harness.request("tools/list")).tools!;
    expect(listed).toHaveLength(30);
    expect(listed.filter(tool => tool.name.startsWith("session_")).map(tool => tool.name).sort()).toEqual([
      "session_diff", "session_fork", "session_info", "session_list", "session_read", "session_search",
    ]);
    expect(listed.filter(tool => tool.name.startsWith("graph_")).map(tool => tool.name).sort()).toEqual([
      "graph_audit", "graph_control", "graph_declare", "graph_status", "graph_submit_outcome", "graph_wait",
    ]);
    expect(listed.every(tool => tool.inputSchema.type === "object")).toBe(true);
    expect(harness.calls).toEqual([]);
  });

  it("adds both optional tool families without replacing the runtime tools", async () => {
    const harness = await boot({ computerUse: true, browseUse: true });
    const listed = (await harness.request("tools/list")).tools!;
    expect(listed).toHaveLength(65);
    expect(listed.filter(tool => tool.name.startsWith("computer_"))).toHaveLength(12);
    expect(listed.filter(tool => tool.name.startsWith("browse_"))).toHaveLength(23);
  });

  it.each([false, true])("writes native roles into the effective global/project Codex layer (project=%s)", async project => {
    installRole(project);
    const harness = await boot();
    expect(harness.calls).toEqual([]);
    const agentDir = join(project ? join(directory, ".codex") : process.env.CODEX_HOME!, "agents");
    expect(readdirSync(agentDir)).toEqual(["rolebox--reviewer.toml"]);
    expect(readFileSync(join(agentDir, "rolebox--reviewer.toml"), "utf8")).toContain("Review with evidence.");
  });

  it("attributes trusted per-call thread IDs and enforces the acting role's MCP tool denials", async () => {
    installRole();
    const harness = await boot();
    const result = await harness.request("tools/call", {
      name: "hashline_read", arguments: { filePath: "not-needed.txt", agent: "other", session_id: "forged" },
      _meta: { threadId: "native-review-thread", sessionId: "shared-root" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("policy disables hashline_read");
    expect(harness.calls).toEqual(["thread/read"]);
  });

  it("rejects graph execution without trusted metadata before any app-server launch", async () => {
    const harness = await boot();
    const result = await harness.request("tools/call", { name: "graph_declare", arguments: { declaration: "{}" } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("_meta.threadId");
    expect(harness.calls).toEqual([]);
  });

  it("rejects a stale native role rather than falling back to unattributed resource access", async () => {
    installRole();
    const harness = await boot({ actor: "rolebox--missing" });
    const result = await harness.request("tools/call", {
      name: "asset_search", arguments: { query: "review" }, _meta: { threadId: "stale-native" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no longer present");
  });

  it("releases a lazy app-server connection when the MCP server closes", async () => {
    const harness = await boot();
    await harness.request("tools/call", { name: "session_list", arguments: {} });
    expect(harness.closed()).toBe(false);
    harness.server.close();
    expect(harness.closed()).toBe(true);
  });

  it("uses per-call threadId ahead of legacy environment and shared session IDs", () => {
    process.env.ROLEBOX_SESSION_ID = "legacy-session";
    expect(resolveCodexSessionId({ sessionId: "handshake-session" }, { threadId: "actual-thread", sessionId: "shared-root" })).toBe("actual-thread");
    expect(resolveCodexSessionId(undefined, { sessionId: "shared-root" })).toBe("legacy-session");
  });
});
