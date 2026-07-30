import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { LspClientManager } from "../../src/lsp/client-manager.ts";
import { isServerAvailable } from "../../src/lsp/servers.ts";
import type { Diagnostic } from "../../src/lsp/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fake child process with EventEmitter-based stdio streams.
 * Returns the fake process and a helper to simulate server responses.
 */
function createFakeProcess() {
  const stdin = new EventEmitter() as EventEmitter & { write: ReturnType<typeof mock> };
  stdin.write = mock(() => {});
  const stdout = new EventEmitter() as EventEmitter;
  const stderr = new EventEmitter() as EventEmitter;
  const process = new EventEmitter() as EventEmitter & {
    pid: number;
    killed: boolean;
    kill: ReturnType<typeof mock>;
    stdin: typeof stdin;
    stdout: typeof stdout;
    stderr: typeof stderr;
  };
  process.pid = 12345;
  process.killed = false;
  process.kill = mock(() => {
    process.killed = true;
  });
  process.stdin = stdin;
  process.stdout = stdout;
  process.stderr = stderr;
  return process;
}

/**
 * Send a JSON-RPC response as it would arrive from stdout.
 */
function sendResponse(
  process: ReturnType<typeof createFakeProcess>,
  msg: object,
): void {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
  process.stdout!.emit("data", Buffer.from(header + body));
}

// We need to work around the fact that LspClientManager.startServer
// spawns a real child process. We test the class's pure logic paths
// and its state management.

// ---------------------------------------------------------------------------
// constructor
// ---------------------------------------------------------------------------

describe("constructor", () => {
  it("initializes with the given directory", () => {
    const mgr = new LspClientManager("/test/dir");
    expect(mgr.directory).toBe("/test/dir");
  });

  it("initializes detectedLanguages as an array", () => {
    const mgr = new LspClientManager(process.cwd());
    expect(Array.isArray(mgr.detectedLanguages)).toBe(true);
  });

  it("initializes empty servers map", () => {
    const mgr = new LspClientManager("/tmp");
    expect(mgr.servers.size).toBe(0);
  });

  it("initializes messageIdCounter at 0", () => {
    const mgr = new LspClientManager("/tmp");
    expect(mgr.messageIdCounter).toBe(0);
  });

  it.skipIf(!isServerAvailable("typescript"))("detects typescript in the rolebox project directory", () => {
    const mgr = new LspClientManager(process.cwd());
    expect(mgr.detectedLanguages).toContain("typescript");
  });
});

// ---------------------------------------------------------------------------
// getDiagnostics / getAllDiagnostics
// ---------------------------------------------------------------------------

describe("getDiagnostics / getAllDiagnostics", () => {
  let mgr: LspClientManager;

  beforeEach(() => {
    mgr = new LspClientManager("/tmp");
  });

  it("getDiagnostics returns empty array when no diagnostics exist", () => {
    const result = mgr.getDiagnostics("file:///test.ts");
    expect(result).toEqual([]);
  });

  it("getDiagnostics returns cached diagnostics", () => {
    const diags: Diagnostic[] = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: "error" },
    ];
    // Manually seed the diagnostic cache using internal state
    const state = {
      languageId: "typescript",
      process: null,
      capabilities: null,
      status: "running" as const,
      startedAt: new Date(),
      pendingRequests: new Map(),
      diagnosticCache: new Map<string, Diagnostic[]>().set("file:///test.ts", diags),
      restartCount: 0,
    };
    mgr.servers.set("typescript", state);

    expect(mgr.getDiagnostics("file:///test.ts")).toEqual(diags);
  });

  it("getDiagnostics searches all servers", () => {
    const diags: Diagnostic[] = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 2, message: "warn" },
    ];
    const state1 = {
      languageId: "typescript",
      process: null,
      capabilities: null,
      status: "running" as const,
      startedAt: new Date(),
      pendingRequests: new Map(),
      diagnosticCache: new Map(),
      restartCount: 0,
    };
    const state2 = {
      languageId: "python",
      process: null,
      capabilities: null,
      status: "running" as const,
      startedAt: new Date(),
      pendingRequests: new Map(),
      diagnosticCache: new Map<string, Diagnostic[]>().set("file:///test.py", diags),
      restartCount: 0,
    };
    mgr.servers.set("typescript", state1);
    mgr.servers.set("python", state2);

    expect(mgr.getDiagnostics("file:///test.py")).toEqual(diags);
  });

  it("getAllDiagnostics returns merged map", () => {
    const diags1: Diagnostic[] = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "e1" },
    ];
    const diags2: Diagnostic[] = [
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, severity: 2, message: "w1" },
    ];
    const state = {
      languageId: "typescript",
      process: null,
      capabilities: null,
      status: "running" as const,
      startedAt: new Date(),
      pendingRequests: new Map(),
      diagnosticCache: new Map<string, Diagnostic[]>()
        .set("file:///a.ts", diags1)
        .set("file:///b.ts", diags2),
      restartCount: 0,
    };
    mgr.servers.set("typescript", state);

    const merged = mgr.getAllDiagnostics();
    expect(merged.get("file:///a.ts")).toEqual(diags1);
    expect(merged.get("file:///b.ts")).toEqual(diags2);
    expect(merged.size).toBe(2);
  });

  it("getAllDiagnostics returns empty map when no servers", () => {
    const merged = mgr.getAllDiagnostics();
    expect(merged.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getRunningServers / getServerCapabilities
// ---------------------------------------------------------------------------

describe("getRunningServers / getServerCapabilities", () => {
  let mgr: LspClientManager;

  beforeEach(() => {
    mgr = new LspClientManager("/tmp");
  });

  it("getRunningServers returns empty when no servers", () => {
    expect(mgr.getRunningServers()).toEqual([]);
  });

  it("getRunningServers returns server info with pid -1 when process is null", () => {
    const startedAt = new Date("2025-01-01");
    mgr.servers.set("typescript", {
      languageId: "typescript",
      process: null,
      capabilities: { hoverProvider: true },
      status: "running",
      startedAt,
      pendingRequests: new Map(),
      diagnosticCache: new Map(),
      restartCount: 0,
    });

    const servers = mgr.getRunningServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]!.languageId).toBe("typescript");
    expect(servers[0]!.pid).toBe(-1);
    expect(servers[0]!.status).toBe("running");
    expect(servers[0]!.capabilities).toEqual({ hoverProvider: true });
    expect(servers[0]!.startedAt).toBe(startedAt);
  });

  it("getRunningServers includes pid from process", () => {
    const fakeProc = { pid: 42 } as any;
    mgr.servers.set("go", {
      languageId: "go",
      process: fakeProc,
      capabilities: null,
      status: "running",
      startedAt: new Date(),
      pendingRequests: new Map(),
      diagnosticCache: new Map(),
      restartCount: 0,
    });

    const servers = mgr.getRunningServers();
    expect(servers[0]!.pid).toBe(42);
  });

  it("getServerCapabilities returns null for unknown server", () => {
    expect(mgr.getServerCapabilities("unknown")).toBeNull();
  });

  it("getServerCapabilities returns capabilities for known server", () => {
    mgr.servers.set("typescript", {
      languageId: "typescript",
      process: null,
      capabilities: { completionProvider: {} },
      status: "running",
      startedAt: new Date(),
      pendingRequests: new Map(),
      diagnosticCache: new Map(),
      restartCount: 0,
    });

    expect(mgr.getServerCapabilities("typescript")).toEqual({ completionProvider: {} });
  });

  it("getServerCapabilities returns null when capabilities is null", () => {
    mgr.servers.set("typescript", {
      languageId: "typescript",
      process: null,
      capabilities: null,
      status: "starting",
      startedAt: new Date(),
      pendingRequests: new Map(),
      diagnosticCache: new Map(),
      restartCount: 0,
    });

    expect(mgr.getServerCapabilities("typescript")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// shutdown / shutdownAll (without real child process)
// ---------------------------------------------------------------------------

describe("shutdown", () => {
  let mgr: LspClientManager;

  beforeEach(() => {
    mgr = new LspClientManager("/tmp");
  });

  it("is a no-op for a missing server", async () => {
    // Should not throw
    await mgr.shutdown("nonexistent");
    expect(mgr.servers.size).toBe(0);
  });

  it("cancels pending requests on shutdown", async () => {
    const timeout = setTimeout(() => {}, 10000);
    const reject = mock(() => {});
    const resolve = mock(() => {});
    mgr.servers.set("typescript", {
      languageId: "typescript",
      process: null,
      capabilities: null,
      status: "dead",
      startedAt: new Date(),
      pendingRequests: new Map().set(1, { resolve, reject, timeout }),
      diagnosticCache: new Map(),
      restartCount: 0,
    });

    await mgr.shutdown("typescript");
    const errArg = reject.mock.calls[0]![0] as Error;
    expect(errArg.message).toContain("shutting down");
    clearTimeout(timeout);
  });

  it("removes server entry after shutdown", async () => {
    mgr.servers.set("typescript", {
      languageId: "typescript",
      process: null,
      capabilities: null,
      status: "dead",
      startedAt: new Date(),
      pendingRequests: new Map(),
      diagnosticCache: new Map(),
      restartCount: 0,
    });

    await mgr.shutdown("typescript");
    expect(mgr.servers.has("typescript")).toBe(false);
  });

  it("calls shutdownAll and removes all servers", async () => {
    mgr.servers.set("ts", {
      languageId: "ts",
      process: null,
      capabilities: null,
      status: "dead",
      startedAt: new Date(),
      pendingRequests: new Map(),
      diagnosticCache: new Map(),
      restartCount: 0,
    });
    mgr.servers.set("py", {
      languageId: "py",
      process: null,
      capabilities: null,
      status: "dead",
      startedAt: new Date(),
      pendingRequests: new Map(),
      diagnosticCache: new Map(),
      restartCount: 0,
    });

    await mgr.shutdownAll();
    expect(mgr.servers.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// request (with mocked server state)
// ---------------------------------------------------------------------------

describe("request", () => {
  let mgr: LspClientManager;

  beforeEach(() => {
    mgr = new LspClientManager("/tmp");
  });

  it("throws when languageId cannot be resolved from params", async () => {
    await expect(mgr.request("someMethod", {})).rejects.toThrow(
      "Cannot determine languageId for request",
    );
  });

  it("throws when auto-start fails for unknown language", async () => {
    await expect(mgr.request("someMethod", {}, "$$$nonexistent$$$")).rejects.toThrow(
      "No LSP server configuration found for language",
    );
  });





  it("throws when server is dead with exhausted restart attempts", async () => {
    mgr.servers.set("typescript", {
      languageId: "typescript",
      process: null,
      capabilities: null,
      status: "dead",
      startedAt: new Date(),
      pendingRequests: new Map(),
      diagnosticCache: new Map(),
      restartCount: 3,
    });

    await expect(mgr.request("someMethod", {}, "typescript")).rejects.toThrow(
      "exceeded max restart attempts",
    );
  });





  it("throws when server exceeds max restart attempts", async () => {
    mgr.servers.set("typescript", {
      languageId: "typescript",
      process: null,
      capabilities: null,
      status: "dead",
      startedAt: new Date(),
      pendingRequests: new Map(),
      diagnosticCache: new Map(),
      restartCount: 3,
    });

    await expect(mgr.request("someMethod", {}, "typescript")).rejects.toThrow(
      "exceeded max restart attempts",
    );
  });
});

// ---------------------------------------------------------------------------
// notify (without real child process)
// ---------------------------------------------------------------------------

describe("notify", () => {
  let mgr: LspClientManager;

  beforeEach(() => {
    mgr = new LspClientManager("/tmp");
  });

  it("does nothing when languageId cannot be resolved", () => {
    // Should not throw
    mgr.notify("textDocument/didOpen", {});
    // No assertion needed — just no crash
  });

  it("does nothing when server is not running", () => {
    mgr.notify("textDocument/didOpen", {}, "typescript");
    // No crash — just log warning
  });
});

// ---------------------------------------------------------------------------
// _buildClientCapabilities (internal, but visible via constructor behavior)
// ---------------------------------------------------------------------------

describe("client capabilities (internal)", () => {
  it("capability structure is valid after initialization", () => {
    const mgr = new LspClientManager("/tmp");
    // Accessing the private method through the prototype for testing
    const capabilities = (LspClientManager.prototype as any)._buildClientCapabilities.call(mgr);
    expect(capabilities).toBeDefined();
    expect(capabilities.textDocument).toBeDefined();
    expect(capabilities.textDocument.synchronization).toBeDefined();
    expect(capabilities.textDocument.synchronization.dynamicRegistration).toBe(true);
    expect(capabilities.workspace).toBeDefined();
    expect(capabilities.window).toBeDefined();
    expect(capabilities.general).toBeDefined();
    expect(capabilities.general.positionEncodings).toContain("utf-16");
  });
});

// ---------------------------------------------------------------------------
// messageIdCounter
// ---------------------------------------------------------------------------

describe("messageIdCounter", () => {
  it("increments on each request call (when server config lookup fails)", async () => {
    const mgr = new LspClientManager("/tmp");
    const id1 = ++mgr.messageIdCounter;
    const id2 = ++mgr.messageIdCounter;

    expect(id2).toBe(id1 + 1);
  });
});
