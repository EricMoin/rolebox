import type { LspServerState, Diagnostic } from "./types.ts";
import { getLanguageIdFromExtension } from "./servers.ts";
import { createSubLogger, formatError } from "../logger.ts";

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
  params: { uri?: string; diagnostics?: Diagnostic[] },
): void {
  if (!params.uri) return;

  const diags = params.diagnostics ?? [];
  state.diagnosticCache.set(params.uri, diags as Diagnostic[]);
  const errors = diags.filter((d: Diagnostic) => d.severity === 1).length;
  const warnings = diags.filter((d: Diagnostic) => d.severity === 2).length;
  log.debug(`[${languageId}] ${params.uri}: ${errors} errors, ${warnings} warnings`);
}

export function resolveLanguageIdFromParams(params: object): string | undefined {
  if (params && typeof params === "object") {
    const p = params as Record<string, any>;
    if (p.textDocument?.uri && typeof p.textDocument.uri === "string") {
      return getLanguageIdFromExtension(p.textDocument.uri);
    }
  }
  return undefined;
}
