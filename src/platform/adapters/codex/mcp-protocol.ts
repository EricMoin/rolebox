/**
 * MCP stdio protocol primitives — JSON-RPC 2.0 over newline-delimited JSON.
 *
 * Codex spawns the rolebox MCP server as a child process and speaks the Model
 * Context Protocol over its stdin/stdout. This module owns the wire shapes and
 * the pure parse/negotiate/serialize helpers; it performs NO I/O, so both the
 * server read loop (`./server.ts`) and its tests can exercise framing and
 * error mapping without a stream.
 *
 * Contract observed from Codex's MCP client:
 *   - one JSON object per line, newline-terminated, on stdout;
 *   - `initialize` echoes the client's requested protocol version when it is
 *     one of the versions below, otherwise the latest supported version;
 *   - `notifications/*` (no `id`) are never answered;
 *   - protocol-level failures map to the JSON-RPC error codes below, while a
 *     failed TOOL call is a normal `tools/call` result carrying `isError`.
 *
 * @module
 */

import { err, ok, type Result } from "../../../utils/result.ts";

/** Protocol versions this server implements, newest first. */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** The version answered when the client requests an unsupported one. */
export const MCP_LATEST_PROTOCOL_VERSION = "2025-06-18";

/** The only JSON-RPC version this server speaks. */
export const JSONRPC_VERSION = "2.0";

/** Standard JSON-RPC 2.0 error codes used on the wire. */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/** A supported MCP protocol version string. */
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];

/** A JSON-RPC message id: a string or a number (never null in a request). */
export type JsonRpcId = string | number;

/** A JSON-RPC request — carries an id and expects a response. */
export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

/** A JSON-RPC notification — no id, never answered. */
export interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: unknown;
}

/** A JSON-RPC error object. */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** A successful JSON-RPC response. */
export interface JsonRpcSuccessResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result: unknown;
}

/** A failed JSON-RPC response. A parse failure has no usable id, so it is null. */
export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId | null;
  error: JsonRpcError;
}

/** Every message this server serializes onto the wire. */
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

/**
 * Negotiate the protocol version for an `initialize` request.
 *
 * Echoes `requested` when it is one of {@link MCP_PROTOCOL_VERSIONS};
 * anything else (unknown string, wrong type, absent) falls back to
 * {@link MCP_LATEST_PROTOCOL_VERSION}.
 */
export function negotiateProtocolVersion(requested: unknown): string {
  if (
    typeof requested === "string" &&
    (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
  ) {
    return requested;
  }
  return MCP_LATEST_PROTOCOL_VERSION;
}

/** Serialize one message as a single newline-terminated JSON line. */
export function serializeMessage(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** A parsed inbound line: a request (has an id) or a notification (has none). */
export type ParsedMessage =
  | { kind: "request"; id: JsonRpcId; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown };

/** Result of {@link parseMessageLine}: a message or a JSON-RPC error to return. */
export type ParseResult = Result<ParsedMessage, { code: number; message: string }>;

function parseError(detail: string): ParseResult {
  return err({ code: JsonRpcErrorCode.ParseError, message: `Parse error: ${detail}` });
}

function invalidRequest(detail: string): ParseResult {
  return err({ code: JsonRpcErrorCode.InvalidRequest, message: `Invalid Request: ${detail}` });
}

/**
 * Parse one newline-framed line into a request or notification.
 *
 * Trailing \n / \r line terminators are stripped so both LF and CRLF framing
 * parse. An unparsable line is a ParseError; a non-object value, a missing or
 * wrong `jsonrpc` field, a missing/empty/non-string `method`, or an `id` that
 * is neither a string nor a number is an InvalidRequest. A line without an
 * `id` is a notification — the caller must not answer it.
 */
export function parseMessageLine(line: string): ParseResult {
  const payload = line.replace(/[\r\n]+$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    return parseError(err instanceof Error ? err.message : String(err));
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalidRequest("expected a JSON-RPC object");
  }

  const record = parsed as Record<string, unknown>;

  if (record.jsonrpc !== JSONRPC_VERSION) {
    return invalidRequest(`"jsonrpc" must be "${JSONRPC_VERSION}"`);
  }
  if (typeof record.method !== "string" || record.method.length === 0) {
    return invalidRequest('"method" must be a non-empty string');
  }

  const params = record.params;
  if (!("id" in record) || record.id === undefined) {
    return ok({ kind: "notification", method: record.method, params });
  }

  const id = record.id;
  if (typeof id !== "string" && typeof id !== "number") {
    return invalidRequest('"id" must be a string or a number');
  }

  return ok({ kind: "request", id, method: record.method, params });
}
