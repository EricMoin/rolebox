import { describe, it, expect, mock } from "bun:test";
import {
  writeMessage,
  processBuffer,
  dispatchMessage,
  resolveLanguageIdFromParams,
} from "../../src/lsp/rpc-handler.ts";
import type { LspServerState, Diagnostic } from "../../src/lsp/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServerState(overrides: Partial<LspServerState> = {}): LspServerState {
  return {
    languageId: "typescript",
    process: null,
    capabilities: null,
    status: "running",
    startedAt: new Date(),
    pendingRequests: new Map(),
    diagnosticCache: new Map(),
    restartCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// writeMessage
// ---------------------------------------------------------------------------

describe("writeMessage", () => {
  it("writes Content-Length header + JSON body to stdin", () => {
    let written = "";
    const fakeProcess = {
      stdin: {
        write: (data: string) => {
          written += data;
        },
      },
    };

    writeMessage(fakeProcess, { jsonrpc: "2.0", method: "test" });

    expect(written).toContain("Content-Length:");
    expect(written).toContain("\r\n\r\n");
    expect(written).toContain('"jsonrpc":"2.0"');
    expect(written).toContain('"method":"test"');
    expect(written).toMatch(/Content-Length:\s*\d+/);
  });

  it("sends valid JSON that can be parsed back", () => {
    let written = "";
    const fakeProcess = {
      stdin: {
        write: (data: string) => {
          written += data;
        },
      },
    };

    const msg = { jsonrpc: "2.0", id: 42, method: "test", params: { foo: "bar" } };
    writeMessage(fakeProcess, msg);

    const parts = written.split("\r\n\r\n");
    expect(parts.length).toBe(2);
    const parsed = JSON.parse(parts[1]!);
    expect(parsed).toEqual(msg);
  });

  it("computes Content-Length based on Buffer.byteLength", () => {
    let written = "";
    const fakeProcess = {
      stdin: {
        write: (data: string) => {
          written += data;
        },
      },
    };

    const msg = { jsonrpc: "2.0", method: "notify" };
    writeMessage(fakeProcess, msg);

    const match = written.match(/Content-Length:\s*(\d+)/);
    expect(match).not.toBeNull();
    const declaredLength = parseInt(match![1]!, 10);
    const headerEnd = written.indexOf("\r\n\r\n") + 4;
    const actualBody = written.slice(headerEnd);
    expect(declaredLength).toBe(Buffer.byteLength(actualBody, "utf-8"));
  });
});

// ---------------------------------------------------------------------------
// processBuffer
// ---------------------------------------------------------------------------

describe("processBuffer", () => {
  it("does nothing when buffer map has no entry for the language", () => {
    const buffers = new Map();
    const dispatchMock = mock(() => {});
    processBuffer(buffers, "nonexistent", dispatchMock);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("parses a single complete message and calls dispatchMessageFn", () => {
    const state = makeServerState();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" });
    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
    const raw = Buffer.from(header + body);

    const buffers = new Map();
    buffers.set("typescript", { buffer: raw, state });

    const dispatchMock = mock(() => {});
    processBuffer(buffers, "typescript", dispatchMock);

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0]![0]).toBe("typescript");
    expect(dispatchMock.mock.calls[0]![1]).toBe(state);
    expect(dispatchMock.mock.calls[0]![2]).toEqual({ jsonrpc: "2.0", id: 1, result: "ok" });
  });

  it("parses multiple complete messages in one buffer", () => {
    const state = makeServerState();
    const body1 = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "a" });
    const body2 = JSON.stringify({ jsonrpc: "2.0", method: "test" });
    const raw =
      `Content-Length: ${Buffer.byteLength(body1, "utf-8")}\r\n\r\n${body1}` +
      `Content-Length: ${Buffer.byteLength(body2, "utf-8")}\r\n\r\n${body2}`;

    const buffers = new Map();
    buffers.set("typescript", { buffer: Buffer.from(raw), state });

    const dispatchMock = mock(() => {});
    processBuffer(buffers, "typescript", dispatchMock);

    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(dispatchMock.mock.calls[0]![2]).toEqual({ jsonrpc: "2.0", id: 1, result: "a" });
    expect(dispatchMock.mock.calls[1]![2]).toEqual({ jsonrpc: "2.0", method: "test" });
  });

  it("does not dispatch when buffer is incomplete", () => {
    const state = makeServerState();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" });
    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
    // Only write the header, not the full body
    const raw = header.slice(0, -5);

    const buffers = new Map();
    buffers.set("typescript", { buffer: Buffer.from(raw), state });

    const dispatchMock = mock(() => {});
    processBuffer(buffers, "typescript", dispatchMock);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("trims buffer when it exceeds 1MB without a valid header", () => {
    const state = makeServerState();
    const junk = Buffer.alloc(1024 * 1024 + 1, 0x41); // 'A' * 1MB + 1

    const buffers = new Map();
    buffers.set("typescript", { buffer: junk, state });

    // After trimming, buffer should be empty (0 length)
    processBuffer(buffers, "typescript", mock(() => {}));
    expect(buffers.get("typescript")!.buffer.length).toBe(0);
  });

  it("returns early when there is no header match (small buffer, no trim)", () => {
    const state = makeServerState();
    const raw = Buffer.from("no-header-here");

    const buffers = new Map();
    buffers.set("typescript", { buffer: raw, state });

    processBuffer(buffers, "typescript", mock(() => {}));
    // Buffer should be preserved since it's under 1MB
    expect(buffers.get("typescript")!.buffer.length).toBe("no-header-here".length);
  });
});

// ---------------------------------------------------------------------------
// dispatchMessage
// ---------------------------------------------------------------------------

describe("dispatchMessage", () => {
  it("resolves pending request on successful response", () => {
    const resolve = mock(() => {});
    const reject = mock(() => {});
    const timeout = setTimeout(() => {}, 10000);
    const state = makeServerState();
    state.pendingRequests.set(1, { resolve, reject, timeout });

    dispatchMessage("typescript", state, { jsonrpc: "2.0", id: 1, result: "hello" });

    expect(resolve).toHaveBeenCalledWith("hello");
    expect(reject).not.toHaveBeenCalled();
    expect(state.pendingRequests.has(1)).toBe(false);
    clearTimeout(timeout);
  });

  it("rejects pending request on error response", () => {
    const resolve = mock(() => {});
    const reject = mock(() => {});
    const timeout = setTimeout(() => {}, 10000);
    const state = makeServerState();
    state.pendingRequests.set(1, { resolve, reject, timeout });

    dispatchMessage("typescript", state, {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found" },
    });

    const errArg = reject.mock.calls[0]![0] as Error;
    expect(errArg.message).toContain("Method not found");
    expect(resolve).not.toHaveBeenCalled();
    expect(state.pendingRequests.has(1)).toBe(false);
    clearTimeout(timeout);
  });

  it("handles textDocument/publishDiagnostics notification", () => {
    const state = makeServerState();
    const diags: Diagnostic[] = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "err" },
    ];

    dispatchMessage("typescript", state, {
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri: "file:///test.ts", diagnostics: diags },
    });

    expect(state.diagnosticCache.get("file:///test.ts")).toEqual(diags);
  });

  it("ignores publishDiagnostics without uri", () => {
    const state = makeServerState();

    dispatchMessage("typescript", state, {
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { diagnostics: [] },
    });

    expect(state.diagnosticCache.size).toBe(0);
  });

  it("does not crash on unknown notification", () => {
    const state = makeServerState();
    expect(() => {
      dispatchMessage("typescript", state, {
        jsonrpc: "2.0",
        method: "unknown/notification",
        params: {},
      });
    }).not.toThrow();
  });

  it("does not crash on response for unknown request id", () => {
    const state = makeServerState();
    expect(() => {
      dispatchMessage("typescript", state, {
        jsonrpc: "2.0",
        id: 999,
        result: "orphan",
      });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveLanguageIdFromParams
// ---------------------------------------------------------------------------

describe("resolveLanguageIdFromParams", () => {
  it("returns typescript for .ts file", () => {
    const result = resolveLanguageIdFromParams({ textDocument: { uri: "file:///test.ts" } });
    expect(result).toBe("typescript");
  });

  it("returns python for .py file", () => {
    const result = resolveLanguageIdFromParams({ textDocument: { uri: "file:///test.py" } });
    expect(result).toBe("python");
  });

  it("returns undefined for unknown extension", () => {
    const result = resolveLanguageIdFromParams({ textDocument: { uri: "file:///test.xyz" } });
    expect(result).toBeUndefined();
  });

  it("returns undefined when params is not an object", () => {
    expect(resolveLanguageIdFromParams(null as unknown as object)).toBeUndefined();
    expect(resolveLanguageIdFromParams(undefined as unknown as object)).toBeUndefined();
    expect(resolveLanguageIdFromParams("string" as unknown as object)).toBeUndefined();
  });

  it("returns undefined when textDocument is missing", () => {
    expect(resolveLanguageIdFromParams({})).toBeUndefined();
  });

  it("returns undefined when textDocument.uri is missing", () => {
    expect(resolveLanguageIdFromParams({ textDocument: {} })).toBeUndefined();
  });
});
