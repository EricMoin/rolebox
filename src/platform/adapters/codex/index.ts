/**
 * Codex platform adapters — barrel export.
 */

export {
  CodexMcpServer,
  createCodexMcpServer,
  DEFAULT_MCP_SERVER_NAME,
} from "./server.ts";
export type { CodexMcpServerOptions } from "./server.ts";
export { installProtocolStdoutGuard } from "./stdout-guard.ts";
export type { ProtocolStdoutGuard } from "./stdout-guard.ts";
export { CodexMcpToolFactory } from "./tool-factory.ts";
export type { McpContentBlock, McpToolDescriptor, McpToolCallResult } from "./tool-factory.ts";
export {
  MCP_PROTOCOL_VERSIONS,
  MCP_LATEST_PROTOCOL_VERSION,
  JSONRPC_VERSION,
  JsonRpcErrorCode,
  negotiateProtocolVersion,
  serializeMessage,
  parseMessageLine,
} from "./mcp-protocol.ts";
export type {
  McpProtocolVersion,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  JsonRpcError,
  JsonRpcMessage,
  ParsedMessage,
  ParseResult,
} from "./mcp-protocol.ts";
export {
  writeCodexPluginBundle,
  removeCodexPluginBundle,
  registerCodexPlugin,
  unregisterCodexPlugin,
  resolveRoleboxPackageRoot,
} from "./plugin-bundle.ts";
export type {
  CodexPluginBundleOptions,
  CodexPluginBundlePaths,
} from "./plugin-bundle.ts";
