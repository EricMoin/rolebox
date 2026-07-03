import { spawn } from "node:child_process";
import { createSubLogger, formatError } from "../logger.ts";
import { autoDetectServers, getServerConfig, getLanguageIdFromExtension } from "./servers.ts";
import type { Diagnostic, LspServerState } from "./types.ts";

const log = createSubLogger("lsp:client");
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESTART_ATTEMPTS = 3;

interface ServerBuffer {
  buffer: Buffer;
  state: LspServerState;
}

export class LspClientManager {
  readonly directory: string;
  readonly servers: Map<string, LspServerState> = new Map();
  readonly detectedLanguages: string[];
  messageIdCounter = 0;

  private readonly buffers: Map<string, ServerBuffer> = new Map();

  constructor(directory: string) {
    this.directory = directory;
    this.detectedLanguages = autoDetectServers(directory);
  }

  // -----------------------------------------------------------------------
  // Server lifecycle
  // -----------------------------------------------------------------------

  async startServer(languageId: string): Promise<void> {
    const existing = this.servers.get(languageId);
    if (existing && (existing.status === "starting" || existing.status === "running")) {
      log.warn(`Server for ${languageId} is already ${existing.status}`);
      return;
    }

    const config = getServerConfig(languageId);
    if (!config) {
      throw new Error(
        `No LSP server configuration found for language "${languageId}"`,
      );
    }

    const child = spawn(config.command, config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.directory,
      env: { ...process.env },
    });

    const state: LspServerState = {
      languageId,
      process: child,
      capabilities: null,
      status: "starting",
      startedAt: new Date(),
      pendingRequests: new Map(),
      diagnosticCache: new Map(),
      restartCount: 0,
    };

    this.servers.set(languageId, state);
    this.buffers.set(languageId, { buffer: Buffer.alloc(0), state });

    child.stdout?.on("data", (chunk: Buffer) => {
      const sb = this.buffers.get(languageId);
      if (!sb) return;
      sb.buffer = Buffer.concat([sb.buffer, chunk]);
      this.processBuffer(languageId);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) {
        log.warn(`[${languageId}][stderr] ${text}`);
      }
    });

    child.on("exit", (code: number | null, signal: string | null) => {
      log.warn(`Server ${languageId} exited (code=${code}, signal=${signal})`);
      const s = this.servers.get(languageId);
      // Only mutate state if this is still the current server process.
      // If restartServer replaced it, the old exit should not clobber the new state.
      if (s === state) {
        s.status = "dead";
        for (const [, entry] of s.pendingRequests) {
          clearTimeout(entry.timeout);
          entry.reject(
            new Error(`Server ${languageId} exited unexpectedly (code=${code}, signal=${signal})`),
          );
        }
        s.pendingRequests.clear();
        s.restartCount = (s.restartCount ?? 0) + 1;
        this.buffers.delete(languageId);
      }
    });

    child.on("error", (err: Error) => {
      log.error(`Failed to spawn server ${languageId}: ${formatError(err).message}`);
      const s = this.servers.get(languageId);
      // Same guard: only act if this is still the current server.
      if (s === state) {
        s.status = "failed";
        for (const [, entry] of s.pendingRequests) {
          clearTimeout(entry.timeout);
          entry.reject(err);
        }
        s.pendingRequests.clear();
      }
    });

    try {
      const result = await this.request<{ capabilities: any }>(
        "initialize",
        {
          processId: process.pid,
          rootUri: `file://${this.directory}`,
          capabilities: {
            textDocument: {
              synchronization: { dynamicRegistration: true, willSave: false, willSaveWaitUntil: false, didSave: true },
              hover: { dynamicRegistration: true, contentFormat: ["plaintext", "markdown"] },
              completion: { dynamicRegistration: true, completionItem: { snippetSupport: true } },
              signatureHelp: { dynamicRegistration: true },
              definition: { dynamicRegistration: true },
              references: { dynamicRegistration: true },
              documentSymbol: { dynamicRegistration: true, hierarchicalDocumentSymbolSupport: true },
              codeAction: {
                dynamicRegistration: true,
                isPreferredSupport: true,
                codeActionLiteralSupport: {
                  codeActionKind: {
                    valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports"],
                  },
                },
              },
              formatting: { dynamicRegistration: true },
              rangeFormatting: { dynamicRegistration: true },
              rename: { dynamicRegistration: true, prepareSupport: true },
              documentHighlight: { dynamicRegistration: true },
              documentLink: { dynamicRegistration: true },
              colorProvider: { dynamicRegistration: true },
              foldingRange: { dynamicRegistration: true, lineFoldingOnly: true },
              selectionRange: { dynamicRegistration: true },
              inlayHint: { dynamicRegistration: true },
              codeLens: { dynamicRegistration: true },
              semanticTokens: {
                dynamicRegistration: true,
                requests: { range: true, full: { delta: true } },
                formats: ["relative"],
                multilineTokenSupport: false,
                overlappingTokenSupport: false,
                serverCancelSupport: true,
                augmentsSyntaxTokens: true,
              },
              callHierarchy: { dynamicRegistration: true },
              typeHierarchy: { dynamicRegistration: true },
            },
            workspace: {
              symbol: { dynamicRegistration: true },
              executeCommand: { dynamicRegistration: true },
              didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
            },
            window: {
              workDoneProgress: true,
            },
            general: {
              positionEncodings: ["utf-16"],
            },
          },
          clientInfo: { name: "rolebox", version: "0.16.0" },
        },
        languageId,
      );

      state.capabilities = result.capabilities;
      log.info(`Server ${languageId} initialized`);
    } catch (err) {
      state.status = "failed";
      log.error(`Initialize handshake failed for ${languageId}: ${formatError(err).message}`);
      throw err;
    }

    this.notify("initialized", {}, languageId);
    state.status = "running";
    log.info(`Server ${languageId} is now running`);
  }

  async restartServer(languageId: string): Promise<void> {
    await this.shutdown(languageId);
    await this.startServer(languageId);
  }

  // -----------------------------------------------------------------------
  // JSON-RPC request / notify
  // -----------------------------------------------------------------------

  async request<T>(
    method: string,
    params: object,
    languageId?: string,
  ): Promise<T> {
    if (!languageId) {
      languageId = this.resolveLanguageIdFromParams(params);
    }
    if (!languageId) {
      throw new Error(
        "Cannot determine languageId for request. Provide languageId or include textDocument.uri in params.",
      );
    }

    let state = this.servers.get(languageId);
    if ((!state || state.status === "dead" || state.status === "failed") && method !== "shutdown") {
      if (state && (state.restartCount ?? 0) >= MAX_RESTART_ATTEMPTS) {
        throw new Error(
          `Server ${languageId} exceeded max restart attempts (${MAX_RESTART_ATTEMPTS})`,
        );
      }
      await this.startServer(languageId);
      state = this.servers.get(languageId)!;
    }

    if (!state) {
      throw new Error(`Server ${languageId} not found`);
    }

    if (state.status !== "running" && state.status !== "starting") {
      throw new Error(`Server ${languageId} status is "${state.status}"`);
    }

    const id = ++this.messageIdCounter;
    const message = { jsonrpc: "2.0", id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        state!.pendingRequests.delete(id);
        reject(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      state!.pendingRequests.set(id, { resolve, reject, timeout });

      try {
        this.writeMessage(state!.process, message);
      } catch (err) {
        clearTimeout(timeout);
        state!.pendingRequests.delete(id);
        reject(new Error(`Failed to write message: ${formatError(err).message}`));
      }
    });
  }

  notify(method: string, params: object, languageId?: string): void {
    if (!languageId) {
      languageId = this.resolveLanguageIdFromParams(params);
    }
    if (!languageId) {
      log.warn("Cannot determine languageId for notification; skipping.");
      return;
    }

    const state = this.servers.get(languageId);
    if (!state || state.status !== "running") {
      log.warn(`Cannot notify "${method}" — server ${languageId} not running`);
      return;
    }

    this.writeMessage(state.process, { jsonrpc: "2.0", method, params });
  }

  // -----------------------------------------------------------------------
  // Diagnostics
  // -----------------------------------------------------------------------

  getDiagnostics(uri: string): Diagnostic[] {
    for (const state of this.servers.values()) {
      const diags = state.diagnosticCache.get(uri);
      if (diags) return diags;
    }
    return [];
  }

  getAllDiagnostics(): Map<string, Diagnostic[]> {
    const merged = new Map<string, Diagnostic[]>();
    for (const state of this.servers.values()) {
      for (const [uri, diags] of state.diagnosticCache) {
        if (!merged.has(uri)) {
          merged.set(uri, diags);
        }
      }
    }
    return merged;
  }

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  async shutdown(languageId: string): Promise<void> {
    const state = this.servers.get(languageId);
    if (!state) return;

    for (const [, entry] of state.pendingRequests) {
      clearTimeout(entry.timeout);
      entry.reject(new Error("Server is shutting down"));
    }
    state.pendingRequests.clear();

    // Only send shutdown request if the server is still running.
    // If it's already dead/failed, skip the LSP shutdown handshake
    // and go straight to process cleanup.
    if (state.status === "running") {
      try {
        await this.request("shutdown", {}, languageId);
      } catch (err) {
        log.warn(`Shutdown error for ${languageId}: ${formatError(err).message}`);
      }
      this.notify("exit", {}, languageId);
    }

    try {
      if (state.process && !state.process.killed) {
        state.process.kill("SIGTERM");
        setTimeout(() => {
          try {
            if (state.process && !state.process.killed) {
              state.process.kill("SIGKILL");
            }
          } catch { /* best-effort */ }
        }, 2000);
      }
    } catch (err) {
      log.warn(`Error killing ${languageId} process: ${formatError(err).message}`);
    }

    this.servers.delete(languageId);
    this.buffers.delete(languageId);
  }

  async shutdownAll(): Promise<void> {
    const ids = Array.from(this.servers.keys());
    await Promise.all(ids.map((id) => this.shutdown(id)));
  }

  // -----------------------------------------------------------------------
  // Introspection
  // -----------------------------------------------------------------------

  getRunningServers(): {
    languageId: string;
    pid: number;
    status: string;
    capabilities: any;
    startedAt: Date;
  }[] {
    return Array.from(this.servers.entries()).map(([languageId, state]) => ({
      languageId,
      pid: state.process?.pid ?? -1,
      status: state.status,
      capabilities: state.capabilities,
      startedAt: state.startedAt,
    }));
  }

  getServerCapabilities(languageId: string): any {
    const state = this.servers.get(languageId);
    return state?.capabilities ?? null;
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private writeMessage(process: any, message: object): void {
    const json = JSON.stringify(message);
    const content = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`;
    process.stdin.write(content);
  }

  private processBuffer(languageId: string): void {
    const sb = this.buffers.get(languageId);
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
        this.dispatchMessage(languageId, state, msg);
      } catch (err) {
        log.error(`[${languageId}] Failed to parse JSON-RPC: ${formatError(err).message}`);
      }
    }
  }

  private dispatchMessage(
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
          this.handlePublishDiagnostics(languageId, msg.params);
          break;
        default:
          log.debug(`[${languageId}] Unhandled notification: ${msg.method}`);
          break;
      }
    }
  }

  private handlePublishDiagnostics(
    languageId: string,
    params: { uri?: string; diagnostics?: Diagnostic[] },
  ): void {
    const state = this.servers.get(languageId);
    if (!state || !params.uri) return;

    const diags = params.diagnostics ?? [];
    state.diagnosticCache.set(params.uri, diags as Diagnostic[]);
    const errors = diags.filter((d: Diagnostic) => d.severity === 1).length;
    const warnings = diags.filter((d: Diagnostic) => d.severity === 2).length;
    log.debug(`[${languageId}] ${params.uri}: ${errors} errors, ${warnings} warnings`);
  }

  private resolveLanguageIdFromParams(params: object): string | undefined {
    if (params && typeof params === "object") {
      const p = params as Record<string, any>;
      if (p.textDocument?.uri && typeof p.textDocument.uri === "string") {
        return getLanguageIdFromExtension(p.textDocument.uri);
      }
    }
    return undefined;
  }
}
