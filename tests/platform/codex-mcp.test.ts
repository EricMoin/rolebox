/// <reference types="bun-types" />

import { describe, expect, it, spyOn } from "bun:test";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { createLoadRoleSkillTool } from "../../src/asset/skill-tool.ts";
import { codexCapabilities } from "../../src/platform/capabilities.ts";
import { defineTool } from "../../src/platform/ports/tool-factory.ts";
import { buildCanonicalTools } from "../../src/platform/tool-assembly.ts";
import type { CanonicalToolContext, CanonicalToolDef } from "../../src/platform/types.ts";
import {
  JsonRpcErrorCode,
  JSONRPC_VERSION,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSIONS,
  negotiateProtocolVersion,
  parseMessageLine,
  serializeMessage,
} from "../../src/platform/adapters/codex/mcp-protocol.ts";
import {
  CodexMcpServer,
  createCodexMcpServer,
} from "../../src/platform/adapters/codex/server.ts";
import { CodexMcpToolFactory } from "../../src/platform/adapters/codex/tool-factory.ts";

// Every server in this file runs in-process over PassThrough streams: no
// subprocess, no real stdin/stdout, nothing written outside the harness. The
// entry-point test at the bottom dynamically imports src/entries/codex.ts and
// asserts that importing it starts nothing.

type AnyMessage = Record<string, any>;

// ── Tool fixtures ────────────────────────────────────────────────────────────

function makeTools(): Record<string, CanonicalToolDef> {
  return {
    echo: defineTool({
      description: "Echo the provided text back.",
      args: { text: z.string().min(1).describe("Text to echo back") },
      async execute(input) {
        return "echo:" + input.text;
      },
    }),
    counted: defineTool({
      description: "Return a structured result.",
      args: { count: z.number().int().min(1).describe("How many to count") },
      async execute(input) {
        return {
          output: "count=" + input.count,
          metadata: { internal: "never model-visible" },
        };
      },
    }),
    exploding: defineTool({
      description: "Always throws.",
      args: {},
      async execute() {
        throw new Error("kaboom");
      },
    }),
    legacy: defineTool({
      description: "An old tool.",
      deprecated: { since: "1.0.0", message: "Use echo instead." },
      args: { text: z.string() },
      async execute(input) {
        return input.text;
      },
    }),
  };
}

const context: CanonicalToolContext = {
  sessionID: "test-session",
  messageID: "test-message",
  agent: "",
  directory: process.cwd(),
  worktree: process.cwd(),
  abort: new AbortController().signal,
  metadata() {},
  async ask() {},
};

// ── PassThrough harness ──────────────────────────────────────────────────────

interface Harness {
  server: CodexMcpServer;
  input: PassThrough;
  output: PassThrough;
  errors: string[];
  rawText(): string;
  messages(): AnyMessage[];
}

function createHarness(
  tools: Record<string, CanonicalToolDef> = makeTools(),
  options: {
    contextFactory?: (info: {
      name: string;
      args: Record<string, unknown>;
    }) => CanonicalToolContext | Promise<CanonicalToolContext>;
    instructions?: string;
  } = {},
): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors: string[] = [];
  let raw = "";

  output.on("data", (chunk: Buffer | string) => {
    raw += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });

  const server = createCodexMcpServer({
    tools,
    serverVersion: "9.9.9-test",
    serverName: "rolebox-test",
    input,
    output,
    onError: (message) => errors.push(message),
    ...options,
  });

  return {
    server,
    input,
    output,
    errors,
    rawText: () => raw,
    messages: () =>
      raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as AnyMessage),
  };
}

async function waitForMessages(harness: Harness, count: number): Promise<AnyMessage[]> {
  for (let i = 0; i < 200 && harness.messages().length < count; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return harness.messages();
}

function request(id: number, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, method, params });
}

function notify(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: JSONRPC_VERSION, method, params });
}

// ── The real Codex tool surface ──────────────────────────────────────────────

const EXPECTED_CODEX_TOOL_NAMES = [
  "asset_inspect",
  "asset_search",
  "asset_validate",
  "hashline_edit",
  "hashline_read",
  "interactive_terminal",
  "load_role_skill",
  "memory_list",
  "memory_recall",
  "memory_write",
  "reference_search",
  "signal",
  "web_fetch",
  "web_read",
  "web_search",
];

function realCodexTools(): Record<string, CanonicalToolDef> {
  return buildCanonicalTools({
    resolvedRoles: [],
    directory: process.cwd(),
    capabilities: codexCapabilities(),
    extraTools: { load_role_skill: createLoadRoleSkillTool([]) },
  });
}

// ── Protocol primitives ──────────────────────────────────────────────────────

describe("mcp-protocol", () => {
  it("declares the supported protocol versions and the latest", () => {
    expect([...MCP_PROTOCOL_VERSIONS]).toEqual([
      "2025-06-18",
      "2025-03-26",
      "2024-11-05",
    ]);
    expect(MCP_LATEST_PROTOCOL_VERSION).toBe("2025-06-18");
  });

  it("echoes a supported protocol version", () => {
    for (const version of MCP_PROTOCOL_VERSIONS) {
      expect(negotiateProtocolVersion(version)).toBe(version);
    }
  });

  it("falls back to the latest version for unsupported or missing input", () => {
    expect(negotiateProtocolVersion("1999-01-01")).toBe(MCP_LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(undefined)).toBe(MCP_LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(null)).toBe(MCP_LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(42)).toBe(MCP_LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion({ protocolVersion: "2025-03-26" })).toBe(
      MCP_LATEST_PROTOCOL_VERSION,
    );
  });

  it("serializes one newline-terminated JSON line", () => {
    const line = serializeMessage({ jsonrpc: JSONRPC_VERSION, id: 1, result: {} });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n").length).toBe(2);
    expect(JSON.parse(line)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("parses a request with a numeric or string id", () => {
    const numeric = parseMessageLine(request(7, "ping"));
    expect(numeric.ok).toBe(true);
    if (!numeric.ok) return;
    expect(numeric.value).toEqual({ kind: "request", id: 7, method: "ping", params: undefined });

    const text = parseMessageLine(
      JSON.stringify({ jsonrpc: "2.0", id: "abc", method: "tools/list", params: {} }),
    );
    expect(text.ok).toBe(true);
    if (!text.ok) return;
    expect(text.value.kind).toBe("request");
    if (text.value.kind !== "request") return;
    expect(text.value.id).toBe("abc");
    expect(text.value.params).toEqual({});
  });

  it("parses a request without an id as a notification and strips CRLF", () => {
    const parsed = parseMessageLine(notify("notifications/initialized") + "\r\n");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      kind: "notification",
      method: "notifications/initialized",
      params: undefined,
    });
  });

  it("maps unparsable JSON to ParseError", () => {
    const parsed = parseMessageLine('{"jsonrpc":"2.0","id":1,');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe(JsonRpcErrorCode.ParseError);
    expect(parsed.error.code).toBe(-32700);
  });

  it("maps non-object, wrong-version, missing-method and bad-id requests to InvalidRequest", () => {
    for (const line of [
      "42",
      "null",
      "[]",
      JSON.stringify({ id: 1, method: "ping" }),
      JSON.stringify({ jsonrpc: "1.0", id: 1, method: "ping" }),
      JSON.stringify({ jsonrpc: "2.0", id: 1 }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "" }),
      JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }),
      JSON.stringify({ jsonrpc: "2.0", id: true, method: "ping" }),
      JSON.stringify({ jsonrpc: "2.0", id: {}, method: "ping" }),
    ]) {
      const parsed = parseMessageLine(line);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
    }
  });
});

// ── Tool factory ─────────────────────────────────────────────────────────────

describe("CodexMcpToolFactory", () => {
  it("compile() returns an unnamed descriptor", () => {
    const factory = new CodexMcpToolFactory();
    const descriptor = factory.compile(makeTools().echo) as {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    };
    expect(descriptor.name).toBe("");
    expect(descriptor.inputSchema.type).toBe("object");
  });

  it("compileAll() names descriptors by record key and appends a deprecation notice", () => {
    const factory = new CodexMcpToolFactory();
    const descriptors = factory.compileAll(makeTools());

    expect(Object.keys(descriptors).sort()).toEqual([
      "counted",
      "echo",
      "exploding",
      "legacy",
    ]);
    expect(descriptors.echo.name).toBe("echo");
    expect(descriptors.echo.inputSchema.type).toBe("object");
    expect(descriptors.echo.inputSchema.required).toEqual(["text"]);
    expect(descriptors.legacy.description).toContain("[DEPRECATED]");
    expect(descriptors.legacy.description).toContain("Use echo instead.");
    expect(descriptors.echo.description).not.toContain("[DEPRECATED]");
  });

  it("call() maps a string result to one text block", async () => {
    const factory = new CodexMcpToolFactory(makeTools());
    const result = await factory.call("echo", { text: "hi" }, context);
    expect(result).toEqual({ content: [{ type: "text", text: "echo:hi" }] });
    expect(result.isError).toBeUndefined();
  });

  it("call() maps an object result to its output and drops metadata", async () => {
    const factory = new CodexMcpToolFactory(makeTools());
    const result = await factory.call("counted", { count: 3 }, context);
    expect(result).toEqual({ content: [{ type: "text", text: "count=3" }] });
    expect(JSON.stringify(result)).not.toContain("never model-visible");
  });

  it("call() returns an isError correction naming the offending field", async () => {
    const factory = new CodexMcpToolFactory(makeTools());

    const missing = await factory.call("echo", {}, context);
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('missing required property "text"');

    const wrongType = await factory.call("echo", { text: 42 }, context);
    expect(wrongType.isError).toBe(true);
    expect(wrongType.content[0].text).toContain('"text" must be a string');
  });

  it("call() returns an isError result for an unknown tool", async () => {
    const factory = new CodexMcpToolFactory(makeTools());
    const result = await factory.call("nope", {}, context);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unknown tool");
    expect(result.content[0].text).toContain("nope");
  });

  it("call() converts a thrown tool error into an isError result", async () => {
    const factory = new CodexMcpToolFactory(makeTools());
    const result = await factory.call("exploding", {}, context);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("kaboom");
  });
});

// ── Server ───────────────────────────────────────────────────────────────────

describe("CodexMcpServer", () => {
  it("echoes a supported protocol version and reports capabilities/serverInfo", async () => {
    const harness = createHarness(makeTools(), { instructions: "Rolebox tools." });
    await harness.server.handleLine(
      request(1, "initialize", {
        protocolVersion: "2025-03-26",
        clientInfo: { name: "codex", version: "1.0.0" },
      }),
    );

    const [message] = await waitForMessages(harness, 1);
    expect(message.jsonrpc).toBe("2.0");
    expect(message.id).toBe(1);
    expect(message.result.protocolVersion).toBe("2025-03-26");
    expect(message.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(message.result.serverInfo).toEqual({ name: "rolebox-test", version: "9.9.9-test" });
    expect(message.result.instructions).toBe("Rolebox tools.");
    expect(harness.server.clientInfo).toEqual({ name: "codex", version: "1.0.0" });
    expect(harness.errors).toEqual([]);
  });

  it("falls back to the latest protocol version when the request is unsupported or absent", async () => {
    const harness = createHarness();
    await harness.server.handleLine(request(1, "initialize", { protocolVersion: "1999-01-01" }));
    await harness.server.handleLine(request(2, "initialize"));

    const messages = await waitForMessages(harness, 2);
    expect(messages[0].result.protocolVersion).toBe(MCP_LATEST_PROTOCOL_VERSION);
    expect(messages[1].result.protocolVersion).toBe(MCP_LATEST_PROTOCOL_VERSION);
  });

  it("answers no notification, including notifications/initialized", async () => {
    const harness = createHarness();
    await harness.server.handleLine(notify("notifications/initialized"));
    await harness.server.handleLine(notify("notifications/cancelled", { requestId: 1 }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(harness.rawText()).toBe("");
    expect(harness.messages()).toEqual([]);
  });

  it("answers ping with an empty result object", async () => {
    const harness = createHarness();
    await harness.server.handleLine(request(11, "ping"));
    const [message] = await waitForMessages(harness, 1);
    expect(message.id).toBe(11);
    expect(message.result).toEqual({});
    expect(message.error).toBeUndefined();
  });

  it("maps an unknown method to -32601 with the request id", async () => {
    const harness = createHarness();
    await harness.server.handleLine(request(3, "resources/list"));
    const [message] = await waitForMessages(harness, 1);
    expect(message.id).toBe(3);
    expect(message.error.code).toBe(JsonRpcErrorCode.MethodNotFound);
    expect(message.error.code).toBe(-32601);
    expect(message.error.message).toContain("resources/list");
  });

  it("maps malformed JSON to -32700 with a null id and keeps serving", async () => {
    const harness = createHarness();
    await harness.server.handleLine('{"jsonrpc":"2.0","id":1,');
    const [first] = await waitForMessages(harness, 1);
    expect(first.id).toBeNull();
    expect(first.error.code).toBe(JsonRpcErrorCode.ParseError);
    expect(first.error.code).toBe(-32700);

    await harness.server.handleLine(request(2, "ping"));
    const messages = await waitForMessages(harness, 2);
    expect(messages.length).toBe(2);
    expect(messages[1].id).toBe(2);
    expect(messages[1].result).toEqual({});
  });

  it("maps an invalid request object to -32600 with a null id", async () => {
    const harness = createHarness();
    await harness.server.handleLine('{"jsonrpc":"1.0","id":5,"method":"ping"}');
    const [message] = await waitForMessages(harness, 1);
    expect(message.id).toBeNull();
    expect(message.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
  });

  it("ignores blank lines and accepts CRLF-terminated requests", async () => {
    const harness = createHarness();
    await harness.server.handleLine("");
    await harness.server.handleLine("   ");
    await harness.server.handleLine(request(1, "ping") + "\r\n");

    const messages = await waitForMessages(harness, 1);
    expect(messages.length).toBe(1);
    expect(messages[0].id).toBe(1);
  });

  it("lists every registered tool with an object inputSchema", async () => {
    const tools = realCodexTools();
    const harness = createHarness(tools);
    await harness.server.handleLine(request(1, "tools/list"));

    const [message] = await waitForMessages(harness, 1);
    const listed = message.result.tools as Array<Record<string, any>>;
    expect(listed.map((tool) => tool.name).sort()).toEqual(Object.keys(tools).sort());
    expect(listed.map((tool) => tool.name).sort()).toEqual(EXPECTED_CODEX_TOOL_NAMES);
    expect(message.result.nextCursor).toBeUndefined();

    for (const tool of listed) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect((tool.description as string).length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe("object");
      expect(typeof tool.inputSchema.properties).toBe("object");
    }
  });

  it("advertises a real tool's properties and required list", async () => {
    const harness = createHarness(realCodexTools());
    await harness.server.handleLine(request(1, "tools/list"));
    const [message] = await waitForMessages(harness, 1);
    const listed = message.result.tools as Array<Record<string, any>>;
    const read = listed.find((tool) => tool.name === "hashline_read");

    expect(read).toBeDefined();
    expect(read?.inputSchema.properties.filePath.type).toBe("string");
    expect(read?.inputSchema.required).toContain("filePath");
    expect(read?.inputSchema.properties.offset.type).toBe("integer");
  });

  it("keeps the tool surface to the canonical intersection plus load_role_skill", () => {
    const names = Object.keys(realCodexTools());
    for (const prefix of ["session_", "dispatch_", "loop_", "task_", "graph_"]) {
      expect(names.filter((name) => name.startsWith(prefix))).toEqual([]);
    }
  });

  it("accepts and ignores a tools/list cursor (single page, no nextCursor)", async () => {
    const harness = createHarness(realCodexTools());
    await harness.server.handleLine(request(1, "tools/list", { cursor: "" }));
    await harness.server.handleLine(request(2, "tools/list", { cursor: "anything" }));

    const messages = await waitForMessages(harness, 2);
    const first = (messages[0].result.tools as Array<Record<string, any>>).map((t) => t.name);
    const second = (messages[1].result.tools as Array<Record<string, any>>).map((t) => t.name);
    expect(first).toEqual(second);
    expect(messages[1].result.nextCursor).toBeUndefined();
  });

  it("returns a string tool result as one text block", async () => {
    const harness = createHarness();
    await harness.server.handleLine(
      request(7, "tools/call", { name: "echo", arguments: { text: "hi" } }),
    );

    const [message] = await waitForMessages(harness, 1);
    expect(message.id).toBe(7);
    expect(message.error).toBeUndefined();
    expect(message.result).toEqual({
      content: [{ type: "text", text: "echo:hi" }],
    });
  });

  it("returns an object tool result as its output text without metadata", async () => {
    const harness = createHarness();
    await harness.server.handleLine(
      request(8, "tools/call", { name: "counted", arguments: { count: 3 } }),
    );

    const [message] = await waitForMessages(harness, 1);
    expect(message.result).toEqual({
      content: [{ type: "text", text: "count=3" }],
    });
    expect(JSON.stringify(message)).not.toContain("never model-visible");
  });

  it("returns an isError result naming the offending field", async () => {
    const harness = createHarness();
    await harness.server.handleLine(request(9, "tools/call", { name: "echo", arguments: {} }));

    const [message] = await waitForMessages(harness, 1);
    expect(message.result.isError).toBe(true);
    expect(message.result.content[0].text).toContain('missing required property "text"');
  });

  it("returns an isError result for an unknown tool", async () => {
    const harness = createHarness();
    await harness.server.handleLine(request(10, "tools/call", { name: "missing_tool" }));

    const [message] = await waitForMessages(harness, 1);
    expect(message.result.isError).toBe(true);
    expect(message.result.content[0].text).toContain("unknown tool");
  });

  it("returns an isError result for non-object arguments", async () => {
    const harness = createHarness();
    await harness.server.handleLine(
      request(11, "tools/call", { name: "echo", arguments: "not-an-object" }),
    );

    const [message] = await waitForMessages(harness, 1);
    expect(message.result.isError).toBe(true);
    expect(message.result.content[0].text).toContain("invalid arguments");
  });

  it("returns an isError result when the tool body throws", async () => {
    const harness = createHarness();
    await harness.server.handleLine(request(12, "tools/call", { name: "exploding" }));

    const [message] = await waitForMessages(harness, 1);
    expect(message.result.isError).toBe(true);
    expect(message.result.content[0].text).toContain("kaboom");
  });

  it("rejects a tools/call envelope without a tool name as -32602", async () => {
    const harness = createHarness();
    await harness.server.handleLine(request(13, "tools/call", {}));

    const [message] = await waitForMessages(harness, 1);
    expect(message.error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(message.error.code).toBe(-32602);
    expect(message.result).toBeUndefined();
  });

  it("reports a throwing context factory as an isError result and keeps serving", async () => {
    const harness = createHarness(makeTools(), {
      contextFactory: () => {
        throw new Error("no context here");
      },
    });
    await harness.server.handleLine(
      request(1, "tools/call", { name: "echo", arguments: { text: "hi" } }),
    );
    await harness.server.handleLine(request(2, "ping"));

    const messages = await waitForMessages(harness, 2);
    expect(messages[0].result.isError).toBe(true);
    expect(messages[0].result.content[0].text).toContain("no context here");
    expect(messages[1].id).toBe(2);
    expect(messages[1].result).toEqual({});
    expect(harness.errors.some((message) => message.includes("no context here"))).toBe(true);
  });

  it("passes the tool name and arguments to the context factory", async () => {
    const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
    const harness = createHarness(makeTools(), {
      contextFactory: (info) => {
        seen.push(info);
        return context;
      },
    });
    await harness.server.handleLine(
      request(1, "tools/call", { name: "echo", arguments: { text: "hi" } }),
    );

    await waitForMessages(harness, 1);
    expect(seen).toEqual([{ name: "echo", args: { text: "hi" } }]);
  });

  it("reassembles a line split across chunks, tolerating CRLF and blank lines", async () => {
    const harness = createHarness();
    const serving = harness.server.serve();
    const first = request(1, "ping");

    harness.input.write("\r\n");
    harness.input.write(first.slice(0, 12));
    harness.input.write(first.slice(12) + "\r\n");
    harness.input.write(request(2, "ping") + "\n");

    const messages = await waitForMessages(harness, 2);
    expect(messages.map((message) => message.id)).toEqual([1, 2]);
    expect(messages.map((message) => message.result)).toEqual([{}, {}]);

    harness.input.end();
    await serving;
  });

  it("serve() resolves on input end and never exits the process", async () => {
    const harness = createHarness();
    const serving = harness.server.serve();
    harness.input.write(request(1, "ping") + "\n");
    await waitForMessages(harness, 1);
    harness.input.end();
    await serving;
    expect(harness.messages().length).toBe(1);
  });

  it("serve() resolves for an input that already ended", async () => {
    const harness = createHarness();
    harness.input.end();
    await harness.server.serve();
    expect(harness.messages()).toEqual([]);
  });
});

// ── Entry point ──────────────────────────────────────────────────────────────

describe("entries/codex", () => {
  it("importing the module is side-effect free", async () => {
    const writes: string[] = [];
    const stdinListenersBefore = process.stdin.listenerCount("data");
    const spy = spyOn(process.stdout, "write").mockImplementation(((
      chunk: unknown,
    ) => {
      writes.push(String(chunk));
      return true;
    }) as never);

    let mod: { main?: unknown; startCodexMcpServer?: unknown; default?: unknown } = {};
    try {
      mod = await import("../../src/entries/codex.ts");
    } finally {
      spy.mockRestore();
    }

    expect(typeof mod.main).toBe("function");
    expect(typeof mod.startCodexMcpServer).toBe("function");
    expect(mod.default).toBeDefined();
    expect(writes).toEqual([]);
    expect(process.stdin.listenerCount("data")).toBe(stdinListenersBefore);
  });
});
