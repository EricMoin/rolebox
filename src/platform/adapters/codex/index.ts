/**
 * Codex platform adapters — barrel export.
 */

export {
  CodexMcpServer,
  createCodexMcpServer,
  DEFAULT_MCP_SERVER_NAME,
} from "./mcp/server.ts";
export type { CodexMcpServerOptions } from "./mcp/server.ts";
export { installProtocolStdoutGuard } from "./mcp/stdout-guard.ts";
export type { ProtocolStdoutGuard } from "./mcp/stdout-guard.ts";
export { CodexMcpToolFactory } from "./mcp/tool-factory.ts";
export type { McpContentBlock, McpToolDescriptor, McpToolCallResult } from "./mcp/tool-factory.ts";
export {
  MCP_PROTOCOL_VERSIONS,
  MCP_LATEST_PROTOCOL_VERSION,
  JSONRPC_VERSION,
  JsonRpcErrorCode,
  negotiateProtocolVersion,
  serializeMessage,
  parseMessageLine,
} from "./mcp/mcp-protocol.ts";
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
} from "./mcp/mcp-protocol.ts";
export {
  writeCodexPluginBundle,
  removeCodexPluginBundle,
  registerCodexPlugin,
  unregisterCodexPlugin,
  resolveRoleboxPackageRoot,
} from "./installation/plugin-bundle.ts";
export type {
  CodexPluginBundleOptions,
  CodexPluginBundlePaths,
} from "./installation/plugin-bundle.ts";
export {
  codexAgentName,
  collectCodexAgentDescriptors,
  renderCodexAgent,
  syncCodexAgents,
} from "./installation/agents.ts";
export type {
  CodexAgentDescriptor,
  CodexAgentMappingOptions,
  CodexAgentMappings,
  SyncCodexAgentsOptions,
  SyncCodexAgentsResult,
} from "./installation/agents.ts";
