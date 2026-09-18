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
 * reassembled, and Buffer chunks are decoded with a streaming UTF-8 decoder so
 * a multi-byte character split across two chunks survives), CRLF line endings,
 * and blank lines (skipped as framing noise, not a parse error). A trailing
 * line that was never newline-terminated is NOT treated as a message: it was
 * never a complete frame, and a trailing incomplete UTF-8 sequence inside it
 * stays undecoded for the same reason.
 *
 * Ordering: REQUESTS are handled strictly one at a time, awaited sequentially.
 * A slow tool call therefore delays the next request, but responses stay in
 * request order and the canonical tools' shared state (terminals, hashline
 * edits, memory writes) never runs two calls concurrently by accident.
 * NOTIFICATIONS are the deliberate exception: a message without an id is
 * handled immediately on arrival and never queues behind the in-flight
 * request, so notifications/cancelled can abort the call it names while that
 * call is still running. The server owns one AbortController per in-flight
 * request id and hands its signal to the tool context. A cancelled call is not
 * special on the wire: it still gets a normal response carrying whatever the
 * tool body returns or throws.
 *
 * @module
 */

import { StringDecoder } from "node:string_decoder";
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
   * an isError tool result rather than crashing the loop. The second argument
   * is the signal of the AbortController the server owns for this request id —
   * notifications/cancelled aborts it (an existing one-parameter factory stays
   * valid, it just cannot observe cancellation).
   */
  contextFactory?: (
    info: { name: string; args: Record<string, unknown> },
    signal: AbortSignal,
  ) => CanonicalToolContext | Promise<CanonicalToolContext>;
}

/** Plain-object guard used for params and arguments. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Whether a raw line is a well-formed notification (a message without an id).
 * An unparsable line is NOT one: it produces an error response, so it stays in
 * the ordered request chain.
 */
function isNotificationLine(line: string): boolean {
  const parsed = parseMessageLine(line);
  return parsed.ok && parsed.value.kind === "notification";
}

/** Fallback context when no contextFactory was supplied. */
function createDefaultContext(signal: AbortSignal): CanonicalToolContext {
  const directory = process.cwd();
  return {
    sessionID: "",
    messageID: "",
    agent: "",
    directory,
    worktree: directory,
    abort: signal,
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
  /** AbortController of each request currently inside a tool call, by id. */
  #inflight = new Map<JsonRpcId, AbortController>();
  /** Set once the output stream has failed; later writes are skipped. */
  #outputBroken = false;
  /** Sequential request chain — notifications bypass it (module docstring). */
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

    // An EPIPE arrives asynchronously: without this listener it would become an
    // uncaught exception, and every later write would throw again.
    const outputEvents = this.#output as {
      on?: (event: "error", listener: (err: unknown) => void) => unknown;
    };
    if (typeof outputEvents.on === "function") {
      outputEvents.on("error", (err: unknown) => {
        this.#outputBroken = true;
        this.#report("output stream error: " + formatError(err).message);
      });
    }

    // Compile once: the factory records the definitions for call() and returns
    // the descriptors in the same pass.
    this.#factory = new CodexMcpToolFactory();
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
   * Handle one newline-framed line. Blank lines are ignored; a notification is
   * never answered and is handled out of band (see the module docstring on
   * ordering); every error path is converted into a protocol response (or an
   * isError tool result) — this method never rejects.
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
      this.#handleNotification(message.method, message.params);
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
    // One decoder for the whole run: a multi-byte character split across two
    // chunks must be held until its remaining bytes arrive rather than decoded
    // in isolation as U+FFFD.
    const decoder = new StringDecoder("utf8");
    let buffer = "";

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      input.on("data", (chunk: Buffer | string) => {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
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

      // An input that already ended or was already destroyed before serve()
      // was called never emits "end"/"close" again — resolve immediately
      // rather than hanging.
      if ((input as { readableEnded?: boolean }).readableEnded === true) finish();
      if ((input as { destroyed?: boolean }).destroyed === true) finish();
    });

    await this.#chain;
    // Any bytes left in the buffer had no newline terminator: they were never
    // a complete frame, so they are intentionally dropped.
  }

  #enqueue(line: string): void {
    if (isNotificationLine(line)) {
      // Out of band: a notification must never wait behind the in-flight
      // request, or a cancel could only be seen after the call it cancels had
      // finished (see the module docstring on ordering).
      void this.handleLine(line).catch((err: unknown) => {
        this.#report("unhandled notification error: " + formatError(err).message);
      });
      return;
    }

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

    // One controller per in-flight request: #handleNotification looks the id
    // up here and aborts the signal the tool context carries.
    const controller = new AbortController();
    this.#inflight.set(id, controller);
    try {
      let context: CanonicalToolContext;
      if (this.#contextFactory) {
        try {
          context = await this.#contextFactory(
            { name, args: asRecord(args) ?? {} },
            controller.signal,
          );
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
        context = createDefaultContext(controller.signal);
      }

      const result: McpToolCallResult = await this.#factory.call(name, args, context);
      this.#writeResult(id, result);
    } finally {
      this.#inflight.delete(id);
    }
  }

  /**
   * Handle a notification immediately — never queued behind a request (see the
   * module docstring on ordering). notifications/cancelled aborts the request
   * it names while that request is still running; every other notification,
   * including notifications/initialized, is a documented no-op.
   */
  #handleNotification(method: string, params: unknown): void {
    if (method !== "notifications/cancelled") return;

    const record = asRecord(params);
    const requestId = record?.requestId;
    if (typeof requestId !== "string" && typeof requestId !== "number") return;

    const controller = this.#inflight.get(requestId);
    if (!controller) return;

    const requestedReason = record?.reason;
    controller.abort(
      new Error(
        typeof requestedReason === "string" && requestedReason.length > 0
          ? requestedReason
          : "cancelled by client",
      ),
    );
  }

  #writeResult(id: JsonRpcId, result: unknown): void {
    this.#write({ jsonrpc: JSONRPC_VERSION, id, result });
  }

  #writeError(id: JsonRpcId | null, code: number, message: string): void {
    this.#write({ jsonrpc: JSONRPC_VERSION, id, error: { code, message } });
  }

  #write(message: JsonRpcMessage): void {
    // Once the output has failed — synchronously below, or asynchronously via
    // the error listener — later writes are skipped instead of throwing once
    // per message.
    if (this.#outputBroken) return;
    try {
      this.#output.write(serializeMessage(message));
    } catch (err) {
      this.#outputBroken = true;
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
