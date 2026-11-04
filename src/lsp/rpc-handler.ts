import type { LspServerState, Diagnostic } from "./types.ts";
import { getLanguageIdFromExtension } from "./servers.ts";
import { createSubLogger, formatError } from "../logger.ts";
import { normalizeDocumentUri } from "./uri.ts";

const log = createSubLogger("lsp:client");

export function writeMessage(process: any, message: object): void {
  const json = JSON.stringify(message);
  const content = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`;
  process.stdin.write(content);
}

interface ServerBuffer {
  buffer: Buffer;
  state: LspServerState;
}

export function processBuffer(
  buffers: Map<string, ServerBuffer>,
  languageId: string,
  dispatchMessageFn: (languageId: string, state: LspServerState, msg: any) => void,
): void {
  const sb = buffers.get(languageId);
  if (!sb) return;

  const state = sb.state;
  const HEADER_PATTERN = /Content-Length:\s*(\d+)\r\n\r\n/;

  while (true) {
    const buf = sb.buffer;
    const headerMatch = buf.toString("utf-8").match(HEADER_PATTERN);

    if (!headerMatch) {
      if (buf.length > 1024 * 1024) {
        log.warn(`[${languageId}] Buffer exceeded 1MB without valid Content-Length header; trimming`);
        sb.buffer = Buffer.alloc(0);
      }
      return;
    }

    const headerEnd = headerMatch.index! + headerMatch[0].length;
    const contentLength = parseInt(headerMatch[1], 10);
    const totalMessageLength = headerEnd + contentLength;

    if (buf.length < totalMessageLength) {
      return;
    }

    const bodyBytes = buf.subarray(headerEnd, totalMessageLength);
    sb.buffer = buf.subarray(totalMessageLength);

    try {
      const msg = JSON.parse(bodyBytes.toString("utf-8"));
      dispatchMessageFn(languageId, state, msg);
    } catch (err) {
      log.error(`[${languageId}] Failed to parse JSON-RPC: ${formatError(err).message}`);
    }
  }
}

export function dispatchMessage(
  languageId: string,
  state: LspServerState,
  msg: any,
): void {
  if (msg.method && msg.id !== undefined && msg.id !== null) {
    if (msg.method === "workspace/configuration" && !Array.isArray(msg.params?.items)) {
      writeMessage(state.process, { jsonrpc: "2.0", id: msg.id,
        error: { code: -32602, message: "workspace/configuration requires an items array" } });
      return;
    }
    const result = msg.method === "workspace/configuration"
      ? (msg.params?.items ?? []).map(() => null)
      : msg.method === "workspace/applyEdit"
        ? { applied: false, failureReason: "Server-initiated edits are not supported" }
        : null;
    const supported = ["workspace/configuration", "workspace/workspaceFolders", "workspace/applyEdit",
      "window/workDoneProgress/create"].includes(msg.method);
    writeMessage(state.process, {
      jsonrpc: "2.0", id: msg.id,
      ...(supported ? { result } : { error: { code: -32601, message: `Unsupported client request: ${msg.method}` } }),
    });
    return;
  }
  if (msg.id !== undefined && msg.id !== null) {
    const pending = state.pendingRequests.get(msg.id);
    if (pending) {
      clearTimeout(pending.timeout);
      state.pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(`JSON-RPC error: ${JSON.stringify(msg.error)}`));
      } else {
        pending.resolve(msg.result);
      }
    } else {
      log.warn(`[${languageId}] Response for unknown request id=${msg.id}`);
    }
    return;
  }

  if (msg.method) {
    switch (msg.method) {
      case "window/showMessage":
        log.info(`[${languageId}][message] ${msg.params?.type}: ${msg.params?.message ?? ""}`);
        break;
      case "window/logMessage":
        log.info(`[${languageId}][log] ${msg.params?.message ?? ""}`);
        break;
      case "textDocument/publishDiagnostics":
        handlePublishDiagnostics(state, languageId, msg.params);
        break;
      default:
        log.debug(`[${languageId}] Unhandled notification: ${msg.method}`);
        break;
    }
  }
}

function handlePublishDiagnostics(
  state: LspServerState,
  languageId: string,
  params: { uri?: string; diagnostics?: Diagnostic[]; version?: number },
): void {
  if (!params.uri) return;
  const uri = normalizeDocumentUri(params.uri);
  if (state.closedDocuments?.has(uri)) return;
  const currentVersion = state.documentVersions?.get(uri);
  if (params.version !== undefined && currentVersion !== undefined && params.version < currentVersion) return;

  const diags = params.diagnostics ?? [];
  state.diagnosticCache.set(uri, diags as Diagnostic[]);
  const errors = diags.filter((d: Diagnostic) => d.severity === 1).length;
  const warnings = diags.filter((d: Diagnostic) => d.severity === 2).length;
  log.debug(`[${languageId}] ${params.uri}: ${errors} errors, ${warnings} warnings`);
}

export function resolveLanguageIdFromParams(params: object): string | undefined {
  if (params && typeof params === "object") {
    const p = params as Record<string, any>;
    const uri = p.textDocument?.uri ?? p.item?.uri;
    if (typeof uri === "string") {
      try { return getLanguageIdFromExtension(decodeURIComponent(new URL(uri).pathname)); }
      catch { return getLanguageIdFromExtension(uri); }
    }
  }
  return undefined;
}
