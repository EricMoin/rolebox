import { spawn } from "node:child_process";
import { fileUri, normalizeDocumentUri } from "./uri.ts";
import { EventEmitter } from "node:events";
import { createSubLogger, formatError } from "../logger.ts";
import { autoDetectServers, getServerConfig, getLanguageIdFromExtension } from "./servers.ts";
import type { Diagnostic, LspServerState } from "./types.ts";
import { writeMessage, processBuffer, dispatchMessage, resolveLanguageIdFromParams } from "./rpc-handler.ts";

const log = createSubLogger("lsp:client");
const REQUEST_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const MAX_RESTART_ATTEMPTS = 3;
const DIAGNOSTIC_RETRY_MS = 30_000;

class DiagnosticsTimeoutError extends Error {}

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
  private readonly starting = new Map<string, Promise<void>>();
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, number>();
  private readonly terminating = new WeakMap<object, Promise<void>>();
  private readonly diagnosticMisses = new Map<string, { state: LspServerState; version?: number; until: number }>();
  private readonly diagnosticChanges = new EventEmitter().setMaxListeners(0);

  constructor(directory: string) {
    this.directory = directory;
    this.detectedLanguages = autoDetectServers(directory);
  }

  // -----------------------------------------------------------------------
  // Server lifecycle
  // -----------------------------------------------------------------------

  startServer(languageId: string): Promise<void> {
    if (this.stopping.has(languageId)) return Promise.reject(new Error(`Server ${languageId} is shutting down`));
    const pending = this.starting.get(languageId);
    if (pending) return pending;
    const existing = this.servers.get(languageId);
    if (existing?.status === "running") return Promise.resolve();
    if ((this.failures.get(languageId) ?? existing?.restartCount ?? 0) >= MAX_RESTART_ATTEMPTS) {
      return Promise.reject(new Error(`Server ${languageId} exceeded max restart attempts (${MAX_RESTART_ATTEMPTS})`));
    }
    const start = this.initializeServer(languageId);
    this.starting.set(languageId, start);
    const clear = () => { if (this.starting.get(languageId) === start) this.starting.delete(languageId); };
    void start.then(clear, clear);
    return start;
  }

  private async initializeServer(languageId: string): Promise<void> {
    const existing = this.servers.get(languageId);

    const config = getServerConfig(languageId);
    if (!config) {
      throw new Error(`No LSP server configuration found for language "${languageId}"`);
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
      documentVersions: new Map(),
      closedDocuments: new Set(),
      restartCount: this.failures.get(languageId) ?? existing?.restartCount ?? 0,
    };

    this.servers.set(languageId, state);
    this.buffers.set(languageId, { buffer: Buffer.alloc(0), state });

    child.stdout?.on("data", (chunk: Buffer) => {
      const sb = this.buffers.get(languageId);
      if (!sb || sb.state !== state) return;
      sb.buffer = Buffer.concat([sb.buffer, chunk]);
      processBuffer(this.buffers, languageId, (lid, s, msg) => {
        dispatchMessage(lid, s, msg);
        if (msg.method === "textDocument/publishDiagnostics") this.diagnosticChanges.emit(lid);
      });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) log.warn(`[${languageId}][stderr] ${text}`);
    });

    child.on("exit", (code: number | null, signal: string | null) => {
      log.warn(`Server ${languageId} exited (code=${code}, signal=${signal})`);
      const s = this.servers.get(languageId);
      if (s === state) {
        s.status = "dead";
        for (const [, entry] of s.pendingRequests) {
          clearTimeout(entry.timeout);
          entry.reject(new Error(`Server ${languageId} exited unexpectedly (code=${code}, signal=${signal})`));
        }
        s.pendingRequests.clear();
        this.buffers.delete(languageId);
        this.diagnosticChanges.emit(languageId);
      }
    });

    child.on("error", (err: Error) => {
      log.error(`Failed to spawn server ${languageId}: ${formatError(err).message}`);
      const s = this.servers.get(languageId);
      if (s === state) {
        if (s.status !== "stopping") s.status = "failed";
        for (const [, entry] of s.pendingRequests) {
          clearTimeout(entry.timeout);
          entry.reject(err);
        }
        s.pendingRequests.clear();
        this.buffers.delete(languageId);
        this.diagnosticChanges.emit(languageId);
      }
    });

    try {
      const result = await this.request<{ capabilities: any }>("initialize", {
        processId: process.pid,
        rootUri: fileUri(this.directory),
        capabilities: this._buildClientCapabilities(),
        clientInfo: { name: "rolebox", version: "0.16.0" },
      }, languageId);

      state.capabilities = result.capabilities;
      state.status = "running";
      this.notify("initialized", {}, languageId);
      state.restartCount = 0;
      this.failures.delete(languageId);
      log.info(`Server ${languageId} initialized`);
    } catch (err) {
      if (state.status !== "stopping" && !this.stopping.has(languageId)) {
        state.status = "failed";
        state.restartCount = (this.failures.get(languageId) ?? 0) + 1;
        this.failures.set(languageId, state.restartCount);
      }
      try { await this.terminate(child); }
      finally { this.forgetServer(languageId, state); }
      log.error(`Initialize handshake failed for ${languageId}: ${formatError(err).message}`);
      throw err;
    }

    log.info(`Server ${languageId} is now running`);
  }

  async restartServer(languageId: string): Promise<void> {
    await this.shutdown(languageId);
    this.failures.delete(languageId);
    await this.startServer(languageId);
  }

  // -----------------------------------------------------------------------
  // JSON-RPC request / notify
  // -----------------------------------------------------------------------

  async request<T>(method: string, params: object, languageId?: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (!languageId) {
      languageId = resolveLanguageIdFromParams(params);
    }
    if (!languageId) {
      throw new Error("Cannot determine languageId for request. Provide languageId or include textDocument.uri in params.");
    }
    if (method !== "shutdown" && this.stopping.has(languageId)) {
      throw new Error(`Server ${languageId} is shutting down`);
    }

    let state = this.servers.get(languageId);
    if ((!state || state.status !== "running") && method !== "shutdown" && method !== "initialize") {
      if (state && (state.restartCount ?? 0) >= MAX_RESTART_ATTEMPTS) {
        throw new Error(`Server ${languageId} exceeded max restart attempts (${MAX_RESTART_ATTEMPTS})`);
      }
      await this.startServer(languageId);
      state = this.servers.get(languageId)!;
    }

    if (!state) throw new Error(`Server ${languageId} not found`);
    if (state.status !== "running" && state.status !== "starting" && !(method === "shutdown" && state.status === "stopping")) {
      throw new Error(`Server ${languageId} status is "${state.status}"`);
    }

    const id = ++this.messageIdCounter;
    const message = { jsonrpc: "2.0", id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        state!.pendingRequests.delete(id);
        reject(new Error(`Request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);

      state!.pendingRequests.set(id, { resolve, reject, timeout });

      try {
        writeMessage(state!.process, message);
      } catch (err) {
        clearTimeout(timeout);
        state!.pendingRequests.delete(id);
        reject(new Error(`Failed to write message: ${formatError(err).message}`));
      }
    });
  }

  notify(method: string, params: object, languageId?: string): void {
    if (!languageId) {
      languageId = resolveLanguageIdFromParams(params);
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

    writeMessage(state.process, { jsonrpc: "2.0", method, params });
  }

  // -----------------------------------------------------------------------
  // Diagnostics
  // -----------------------------------------------------------------------

  getDiagnostics(uri: string): Diagnostic[] {
    uri = normalizeDocumentUri(uri);
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
        if (!merged.has(uri)) merged.set(uri, diags);
      }
    }
    return merged;
  }

  async readDiagnostics(uri: string, languageId: string, timeoutMs = 5000): Promise<Diagnostic[] | undefined> {
    uri = normalizeDocumentUri(uri);
    const state = this.servers.get(languageId);
    if (!state || state.status !== "running") throw new Error(`Server ${languageId} is not running`);
    const cached = state.diagnosticCache.get(uri);
    if (cached !== undefined) return cached;
    const key = `${languageId}\0${uri}`;
    const version = state.documentVersions?.get(uri);
    const miss = this.diagnosticMisses.get(key);
    if (miss?.state === state && miss.version === version && miss.until > Date.now()) return undefined;
    const deadline = Date.now() + timeoutMs;
    if (state.capabilities?.diagnosticProvider) {
      try {
        const report = await this.request<{ kind: string; items?: Diagnostic[] }>(
          "textDocument/diagnostic", { textDocument: { uri } }, languageId, timeoutMs,
        );
        if (this.servers.get(languageId) === state && !state.closedDocuments?.has(uri) &&
          state.documentVersions?.get(uri) === version && report?.kind === "full" && Array.isArray(report.items)) {
          state.diagnosticCache.set(uri, report.items);
          this.diagnosticMisses.delete(key);
          return report.items;
        }
      } catch (error) {
        if (this.servers.get(languageId) !== state || state.status !== "running") throw error;
      }
    }
    try {
      const diagnostics = await this.waitForDiagnostics(uri, languageId, Math.max(0, deadline - Date.now()));
      this.diagnosticMisses.delete(key);
      return diagnostics;
    } catch (error) {
      if (!(error instanceof DiagnosticsTimeoutError)) throw error;
      this.diagnosticMisses.set(key, { state, version, until: Date.now() + DIAGNOSTIC_RETRY_MS });
      return undefined;
    }
  }

  forgetDocument(uri: string): void {
    uri = normalizeDocumentUri(uri);
    for (const [languageId, state] of this.servers) {
      state.diagnosticCache.delete(uri);
      state.documentVersions?.delete(uri);
      state.closedDocuments?.add(uri);
      this.diagnosticMisses.delete(`${languageId}\0${uri}`);
    }
  }

  async waitForDiagnostics(uri: string, languageId: string, timeoutMs = 5000): Promise<Diagnostic[]> {
    uri = normalizeDocumentUri(uri);
    const state = this.servers.get(languageId);
    if (!state || state.status !== "running") throw new Error(`Server ${languageId} is not running`);
    const cached = state.diagnosticCache.get(uri);
    if (cached !== undefined) return cached;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, diagnostics: Diagnostic[] = []) => {
        clearTimeout(timeout);
        this.diagnosticChanges.off(languageId, update);
        if (error) reject(error);
        else resolve(diagnostics);
      };
      const update = () => {
        if (this.servers.get(languageId) !== state || state.status !== "running") {
          finish(new Error(`Server ${languageId} stopped before publishing diagnostics`));
        } else if (state.diagnosticCache.has(uri)) {
          finish(undefined, state.diagnosticCache.get(uri));
        }
      };
      const timeout = setTimeout(() => finish(new DiagnosticsTimeoutError(`Timed out waiting for diagnostics from ${languageId}`)), timeoutMs);
      this.diagnosticChanges.on(languageId, update);
      update();
    });
  }

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  shutdown(languageId: string): Promise<void> {
    const pending = this.stopping.get(languageId);
    if (pending) return pending;
    const state = this.servers.get(languageId);
    if (!state) return Promise.resolve();
    const stop = this.stopServer(languageId, state);
    this.stopping.set(languageId, stop);
    const clear = () => { if (this.stopping.get(languageId) === stop) this.stopping.delete(languageId); };
    void stop.then(clear, clear);
    return stop;
  }

  private async stopServer(languageId: string, state: LspServerState): Promise<void> {
    const running = state.status === "running";
    state.status = "stopping";
    for (const [, entry] of state.pendingRequests) {
      clearTimeout(entry.timeout);
      entry.reject(new Error("Server is shutting down"));
    }
    state.pendingRequests.clear();

    this.diagnosticChanges.emit(languageId);
    try {
      if (running) {
        try {
          await this.request("shutdown", {}, languageId, SHUTDOWN_TIMEOUT_MS);
        } catch (err) {
          log.warn(`Shutdown error for ${languageId}: ${formatError(err).message}`);
        }
        if (state.process?.exitCode === null && state.process?.signalCode === null) {
          writeMessage(state.process, { jsonrpc: "2.0", method: "exit", params: {} });
        }
      }
    } finally {
      try { await this.terminate(state.process); }
      finally {
        this.forgetServer(languageId, state);
        await this.starting.get(languageId)?.catch(() => {});
      }
    }
  }

  private terminate(child: any): Promise<void> {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    const pending = this.terminating.get(child);
    if (pending) return pending;
    const termination = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(force);
        child.off("exit", exited);
        child.off("error", failed);
        if (error) reject(error);
        else resolve();
      };
      const exited = () => finish();
      const failed = (error: Error) => finish(error);
      const force = setTimeout(() => {
        try { child.kill("SIGKILL"); }
        catch (error) { finish(error as Error); }
      }, 2000);
      child.once("exit", exited);
      child.once("error", failed);
      try { child.kill("SIGTERM"); }
      catch (error) { finish(error as Error); }
    });
    this.terminating.set(child, termination);
    const clear = () => { if (this.terminating.get(child) === termination) this.terminating.delete(child); };
    void termination.then(clear, clear);
    return termination;
  }

  private forgetServer(languageId: string, state: LspServerState): void {
    if (this.servers.get(languageId) === state) this.servers.delete(languageId);
    if (this.buffers.get(languageId)?.state === state) this.buffers.delete(languageId);
    state.diagnosticCache.clear();
    state.documentVersions?.clear();
    state.closedDocuments?.clear();
    for (const [key, miss] of this.diagnosticMisses) if (miss.state === state) this.diagnosticMisses.delete(key);
    this.diagnosticChanges.emit(languageId);
  }

  async shutdownAll(): Promise<void> {
    const ids = Array.from(this.servers.keys());
    await Promise.all(ids.map((id) => this.shutdown(id)));
  }

  // -----------------------------------------------------------------------
  // Introspection
  // -----------------------------------------------------------------------

  getRunningServers(): { languageId: string; pid: number; status: string; capabilities: any; startedAt: Date }[] {
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
  // Private helpers
  // -----------------------------------------------------------------------

  private _buildClientCapabilities(): object {
    return {
      textDocument: {
        synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: true },
        publishDiagnostics: { relatedInformation: true, versionSupport: true },
        diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
        hover: { dynamicRegistration: false, contentFormat: ["plaintext", "markdown"] },
        completion: { dynamicRegistration: false, completionItem: { snippetSupport: true } },
        signatureHelp: { dynamicRegistration: false },
        definition: { dynamicRegistration: false },
        references: { dynamicRegistration: false },
        documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
        codeAction: {
          dynamicRegistration: false, isPreferredSupport: true,
          codeActionLiteralSupport: {
            codeActionKind: {
              valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports"],
            },
          },
        },
        formatting: { dynamicRegistration: false },
        rangeFormatting: { dynamicRegistration: false },
        rename: { dynamicRegistration: false, prepareSupport: true },
        documentHighlight: { dynamicRegistration: false },
        documentLink: { dynamicRegistration: false },
        colorProvider: { dynamicRegistration: false },
        foldingRange: { dynamicRegistration: false, lineFoldingOnly: true },
        selectionRange: { dynamicRegistration: false },
        inlayHint: { dynamicRegistration: false },
        codeLens: { dynamicRegistration: false },
        semanticTokens: {
          dynamicRegistration: false,
          requests: { range: true, full: { delta: true } },
          formats: ["relative"],
          multilineTokenSupport: false, overlappingTokenSupport: false,
          serverCancelSupport: true, augmentsSyntaxTokens: true,
        },
        callHierarchy: { dynamicRegistration: false },
        typeHierarchy: { dynamicRegistration: false },
      },
      workspace: {
        symbol: { dynamicRegistration: false },
        executeCommand: { dynamicRegistration: false },
        didChangeWatchedFiles: { dynamicRegistration: false, relativePatternSupport: true },
      },
      window: { workDoneProgress: true },
      general: { positionEncodings: ["utf-16"] },
    };
  }
}
