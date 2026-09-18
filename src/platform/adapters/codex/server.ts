/**
 * Codex MCP server — a hand-rolled JSON-RPC 2.0 stdio transport for rolebox's
 * canonical tools.
 *
 * Codex spawns the process behind this server (src/entries/codex.ts) and
 * speaks newline-delimited JSON-RPC on its stdin/stdout. This module owns the
 * read loop, the method dispatch (initialize, ping, tools/list, tools/call),
 * and the response/error mapping; it NEVER writes anything but protocol
 * messages to the configured output stream, never calls process.exit, and
 * never lets a tool failure escape to the protocol layer.
 *
 * Framing: output carries one JSON object per line, newline-terminated. The
 * loop tolerates chunk boundaries (a line split across two data events is
 * reassembled), CRLF line endings, and blank lines (skipped as framing noise,
 * not a parse error). A trailing line that was never newline-terminated is
 * NOT treated as a message: it was never a complete frame.
 *
 * Ordering: messages are handled strictly one at a time, awaited sequentially.
 * A slow tool call therefore delays the next message, but responses stay in
 * request order and the canonical tools' shared state (terminals, hashline
 * edits, memory writes) never runs two calls concurrently by accident.
 *
 * @module
 */

import {
  JsonRpcErrorCode,
  JSONRPC_VERSION,
  negotiateProtocolVersion,
  parseMessageLine,
  serializeMessage,
} from "./mcp-protocol.ts";
import type { JsonRpcId, JsonRpcMessage } from "./mcp-protocol.ts";
import { CodexMcpToolFactory } from "./tool-factory.ts";
import type { McpToolCallResult, McpToolDescriptor } from "./tool-factory.ts";
import type { CanonicalToolContext, CanonicalToolDef } from "../../types.ts";
import { formatError } from "../../../logger.ts";

/** Default serverInfo.name reported in the initialize result. */
export const DEFAULT_MCP_SERVER_NAME = "rolebox";

/** Everything the server needs to boot. */
export interface CodexMcpServerOptions {
  /** The canonical tools to expose — the same record buildCanonicalTools returns. */
  tools: Record<string, CanonicalToolDef>;
  /** serverInfo.version reported in the initialize result. */
  serverVersion: string;
  /** serverInfo.name; defaults to DEFAULT_MCP_SERVER_NAME. */
  serverName?: string;
  /** Optional instructions string included in the initialize result. */
  instructions?: string;
  /** Protocol input stream; defaults to process.stdin. */
  input?: NodeJS.ReadableStream;
  /** Protocol output stream; defaults to process.stdout. */
  output?: NodeJS.WritableStream;
  /** Diagnostics sink; defaults to stderr ("[rolebox-mcp] ..."). */
  onError?: (message: string) => void;
  /**
   * Build the canonical tool context for one call. Called once per
   * tools/call, before the tool runs; if it throws, the call is answered with
   * an isError tool result rather than crashing the loop.
   */
  contextFactory?: (info: {
    name: string;
    args: Record<string, unknown>;
  }) => CanonicalToolContext | Promise<CanonicalToolContext>;
}

/** Plain-object guard used for params and arguments. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Fallback context when no contextFactory was supplied. */
function createDefaultContext(): CanonicalToolContext {
  const directory = process.cwd();
  return {
    sessionID: "",
    messageID: "",
    agent: "",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata() {
      // No per-call metadata seam on stdio MCP — documented no-op.
    },
    async ask() {
      // stdio MCP has no permission callback — documented no-op.
    },
  };
}

/**
 * The stdio MCP server. Construct with createCodexMcpServer, then either
 * await serve() (reads the input stream until end/close) or call
 * await handleLine(line) directly for tests and embedded use.
 */
export class CodexMcpServer {
  #input: NodeJS.ReadableStream;
  #output: NodeJS.WritableStream;
  #onError: (message: string) => void;
  #factory: CodexMcpToolFactory;
  #descriptors: McpToolDescriptor[];
  #serverName: string;
  #serverVersion: string;
  #instructions: string | undefined;
  #contextFactory: CodexMcpServerOptions["contextFactory"];
  #clientInfo: Record<string, unknown> | undefined;
  /** Sequential handler chain — see the module docstring on ordering. */
  #chain: Promise<void> = Promise.resolve();
  #servePromise: Promise<void> | undefined;

  constructor(opts: CodexMcpServerOptions) {
    this.#input = opts.input ?? process.stdin;
    this.#output = opts.output ?? process.stdout;
    this.#onError =
      opts.onError ??
      ((message: string): void => {
        process.stderr.write("[rolebox-mcp] " + message + "\n");
      });
    this.#factory = new CodexMcpToolFactory(opts.tools);
    this.#descriptors = Object.values(this.#factory.compileAll(opts.tools));
    this.#serverName = opts.serverName ?? DEFAULT_MCP_SERVER_NAME;
    this.#serverVersion = opts.serverVersion;
    this.#instructions = opts.instructions;
    this.#contextFactory = opts.contextFactory;
  }

  /**
   * The params.clientInfo object from the initialize handshake, when the client
   * sent one. Exposed so a context factory can derive a session id from the
   * handshake (the stdio transport carries no Mcp-Session-Id header).
   */
  get clientInfo(): Record<string, unknown> | undefined {
    return this.#clientInfo;
  }

  /**
   * Handle one newline-framed line. Blank lines are ignored; every error path
   * is converted into a protocol response (or an isError tool result) — this
   * method never rejects.
   */
  async handleLine(line: string): Promise<void> {
    if (line.trim().length === 0) return;

    const parsed = parseMessageLine(line);
    if (!parsed.ok) {
      this.#writeError(null, parsed.error.code, parsed.error.message);
      return;
    }

    const message = parsed.value;
    if (message.kind === "notification") {
      // Any message without an id is never answered. notifications/initialized
      // and notifications/cancelled are the ones Codex sends; both are no-ops
      // here (cancellation of an in-flight call is not wired on this transport).
      return;
    }

    await this.#handleRequest(message.id, message.method, message.params);
  }

  /**
   * Run the newline-framed read loop until the input ends or closes, then
   * drain queued handlers so every response is written before resolving.
   * Never throws and never calls process.exit. Calling it twice returns the
   * same promise.
   */
  async serve(): Promise<void> {
    if (!this.#servePromise) this.#servePromise = this.#run();
    return this.#servePromise;
  }

  async #run(): Promise<void> {
    const input = this.#input;
    let buffer = "";

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      input.on("data", (chunk: Buffer | string) => {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let index = buffer.indexOf("\n");
        while (index !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          this.#enqueue(line);
          index = buffer.indexOf("\n");
        }
      });
      input.on("end", finish);
      input.on("close", finish);
      input.on("error", (err: unknown) => {
        this.#report("input stream error: " + formatError(err).message);
        finish();
      });

      // An input that already ended before serve() was called never emits
      // "end" again — resolve immediately rather than hanging.
      if ((input as { readableEnded?: boolean }).readableEnded === true) finish();
    });

    await this.#chain;
    // Any bytes left in the buffer had no newline terminator: they were never
    // a complete frame, so they are intentionally dropped.
  }

  #enqueue(line: string): void {
    this.#chain = this.#chain
      .then(() => this.handleLine(line))
      .catch((err: unknown) => {
        this.#report("unhandled message error: " + formatError(err).message);
      });
  }

  async #handleRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    try {
      switch (method) {
        case "initialize": {
          const record = asRecord(params) ?? {};
          const clientInfo = asRecord(record.clientInfo);
          if (clientInfo) this.#clientInfo = clientInfo;

          const result: Record<string, unknown> = {
            protocolVersion: negotiateProtocolVersion(record.protocolVersion),
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: this.#serverName, version: this.#serverVersion },
          };
          if (this.#instructions) result.instructions = this.#instructions;
          this.#writeResult(id, result);
          return;
        }
        case "ping":
          this.#writeResult(id, {});
          return;
        case "tools/list":
          // The rolebox tool set is always one page, so pagination is not
          // implemented: a cursor param is tolerated and ignored (an empty
          // cursor is the only one a spec-compliant client sends for a
          // one-page list) and no nextCursor is returned.
          this.#writeResult(id, { tools: this.#descriptors });
          return;
        case "tools/call":
          await this.#handleToolCall(id, params);
          return;
        default:
          this.#writeError(
            id,
            JsonRpcErrorCode.MethodNotFound,
            "Method not found: " + method,
          );
      }
    } catch (err) {
      const message = formatError(err);
      this.#report('internal error handling "' + method + '": ' + message.message);
      this.#writeError(id, JsonRpcErrorCode.InternalError, message.message);
    }
  }

  async #handleToolCall(id: JsonRpcId, params: unknown): Promise<void> {
    const record = asRecord(params);
    const name = record?.name;
    if (typeof name !== "string" || name.length === 0) {
      this.#writeError(
        id,
        JsonRpcErrorCode.InvalidParams,
        'Invalid params: "name" must be a non-empty string',
      );
      return;
    }

    // An unknown tool name, a non-object arguments value, and every zod
    // validation failure all become an isError tool RESULT (the model
    // self-corrects); only a malformed tools/call envelope is a protocol error.
    const args = record?.arguments ?? {};

    let context: CanonicalToolContext;
    if (this.#contextFactory) {
      try {
        context = await this.#contextFactory({ name, args: asRecord(args) ?? {} });
      } catch (err) {
        const message = formatError(err).message;
        this.#report('context factory failed for tool "' + name + '": ' + message);
        this.#writeResult(id, {
          content: [{ type: "text", text: 'tool "' + name + '" could not run: ' + message }],
          isError: true,
        });
        return;
      }
    } else {
      context = createDefaultContext();
    }

    const result: McpToolCallResult = await this.#factory.call(name, args, context);
    this.#writeResult(id, result);
  }

  #writeResult(id: JsonRpcId, result: unknown): void {
    this.#write({ jsonrpc: JSONRPC_VERSION, id, result });
  }

  #writeError(id: JsonRpcId | null, code: number, message: string): void {
    this.#write({ jsonrpc: JSONRPC_VERSION, id, error: { code, message } });
  }

  #write(message: JsonRpcMessage): void {
    try {
      this.#output.write(serializeMessage(message));
    } catch (err) {
      this.#report("failed to write response: " + formatError(err).message);
    }
  }

  #report(message: string): void {
    try {
      this.#onError(message);
    } catch {
      // The diagnostics sink must never break the protocol loop.
    }
  }
}

/** Create a CodexMcpServer from explicit options. */
export function createCodexMcpServer(opts: CodexMcpServerOptions): CodexMcpServer {
  return new CodexMcpServer(opts);
}
