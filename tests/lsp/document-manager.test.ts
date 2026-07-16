import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LspDocumentManager } from "../../src/lsp/document-manager.ts";
import type { LspClientManager } from "../../src/lsp/client-manager.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(): LspClientManager {
  return {
    directory: "/tmp",
    servers: new Map(),
    detectedLanguages: [],
    messageIdCounter: 0,
    buffers: new Map(),
    notify: mock(() => {}),
    request: mock(() => Promise.resolve({})),
    startServer: mock(() => Promise.resolve()),
    restartServer: mock(() => Promise.resolve()),
    shutdown: mock(() => Promise.resolve()),
    shutdownAll: mock(() => Promise.resolve()),
    getDiagnostics: mock(() => []),
    getAllDiagnostics: mock(() => new Map()),
    getRunningServers: mock(() => []),
    getServerCapabilities: mock(() => null),
  } as unknown as LspClientManager;
}

// ---------------------------------------------------------------------------
// getUri
// ---------------------------------------------------------------------------

describe("getUri", () => {
  let mgr: LspDocumentManager;

  beforeEach(() => {
    mgr = new LspDocumentManager();
  });

  it("converts an absolute path to file:// URI on Unix", () => {
    const uri = mgr.getUri("/home/user/project/file.ts");
    expect(uri).toMatch(/^file:\/\//);
    expect(uri).toContain("file.ts");
  });

  it("encodes special characters in path segments", () => {
    const uri = mgr.getUri("/home/user/my project/file.ts");
    expect(uri).toContain("my%20project");
  });

  it("produces a valid URI that includes the filename", () => {
    const uri = mgr.getUri("/absolute/path/to/test.ts");
    expect(uri).toBe("file:///absolute/path/to/test.ts");
  });

  it("resolves relative paths to absolute", () => {
    const uri = mgr.getUri("relative/path.ts");
    // URI must be absolute (path.resolve is called internally)
    expect(uri.startsWith("file://")).toBe(true);
    expect(uri.endsWith("relative/path.ts")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isOpen / getContent
// ---------------------------------------------------------------------------

describe("isOpen / getContent", () => {
  let mgr: LspDocumentManager;

  beforeEach(() => {
    mgr = new LspDocumentManager();
  });

  it("returns false for unopened documents", () => {
    expect(mgr.isOpen("file:///unopened.ts")).toBe(false);
  });

  it("returns undefined for unopened document content", () => {
    expect(mgr.getContent("file:///unopened.ts")).toBeUndefined();
  });

  it("returns open status after tracked via internal state", () => {
    const uri = "file:///test.ts";
    mgr.openDocuments.set(uri, { version: 1, content: "hello", open: true });
    expect(mgr.isOpen(uri)).toBe(true);
    expect(mgr.getContent(uri)).toBe("hello");
  });

  it("returns false for documents that were closed", () => {
    const uri = "file:///test.ts";
    mgr.openDocuments.set(uri, { version: 1, content: "hello", open: false });
    expect(mgr.isOpen(uri)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

describe("sync", () => {
  let tmpDir: string;
  let mgr: LspDocumentManager;
  let client: LspClientManager;

  beforeEach(() => {
    tmpDir = mkdtempSync("/tmp/lsp-doc-test-");
    mgr = new LspDocumentManager();
    client = createMockClient();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sends didOpen for a new file", async () => {
    const filePath = join(tmpDir, "test.ts");
    writeFileSync(filePath, "content", "utf-8");

    await mgr.sync(filePath, client, "typescript");

    const uri = mgr.getUri(filePath);
    expect(client.notify).toHaveBeenCalledTimes(1);
    const notifyCall = (client.notify as ReturnType<typeof mock>).mock.calls[0]!;
    expect(notifyCall[0]).toBe("textDocument/didOpen");
    expect(notifyCall[1].textDocument.uri).toBe(uri);
    expect(notifyCall[1].textDocument.languageId).toBe("typescript");
    expect(notifyCall[1].textDocument.version).toBe(1);
    expect(notifyCall[1].textDocument.text).toBe("content");

    expect(mgr.isOpen(uri)).toBe(true);
    expect(mgr.getContent(uri)).toBe("content");
  });

  it("sends didChange when content has changed", async () => {
    const filePath = join(tmpDir, "test.ts");
    writeFileSync(filePath, "v1", "utf-8");

    // First sync opens the document
    await mgr.sync(filePath, client, "typescript");

    // Modify the file
    writeFileSync(filePath, "v2", "utf-8");

    // Reset notify mock to track only the second call
    (client.notify as ReturnType<typeof mock>).mockReset();

    // Second sync should send didChange
    await mgr.sync(filePath, client, "typescript");

    const uri = mgr.getUri(filePath);
    expect(client.notify).toHaveBeenCalledTimes(1);
    const notifyCall = (client.notify as ReturnType<typeof mock>).mock.calls[0]!;
    expect(notifyCall[0]).toBe("textDocument/didChange");
    expect(notifyCall[1].textDocument.uri).toBe(uri);
    expect(notifyCall[1].textDocument.version).toBe(2);
    expect(notifyCall[1].contentChanges[0].text).toBe("v2");

    expect(mgr.getContent(uri)).toBe("v2");
  });

  it("does not send didChange when content is identical", async () => {
    const filePath = join(tmpDir, "test.ts");
    writeFileSync(filePath, "same", "utf-8");

    // First sync opens
    await mgr.sync(filePath, client, "typescript");
    expect(client.notify).toHaveBeenCalledTimes(1);

    (client.notify as ReturnType<typeof mock>).mockReset();

    // Second sync with same content
    await mgr.sync(filePath, client, "typescript");

    expect(client.notify).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// close / closeAll
// ---------------------------------------------------------------------------

describe("close / closeAll", () => {
  let mgr: LspDocumentManager;
  let client: LspClientManager;

  beforeEach(() => {
    mgr = new LspDocumentManager();
    client = createMockClient();
  });

  it("sends didClose for a single document", () => {
    const uri = "file:///test.ts";
    mgr.openDocuments.set(uri, { version: 1, content: "hello", open: true });

    mgr.close("/test.ts", client);

    expect(mgr.isOpen(uri)).toBe(false);
    expect(client.notify).toHaveBeenCalledWith("textDocument/didClose", {
      textDocument: { uri },
    });
  });

  it("does nothing when closing a non-open document", () => {
    mgr.close("/nonexistent.ts", client);
    expect(client.notify).not.toHaveBeenCalled();
  });

  it("sends didClose for all open documents", () => {
    mgr.openDocuments.set("file:///a.ts", { version: 1, content: "a", open: true });
    mgr.openDocuments.set("file:///b.ts", { version: 1, content: "b", open: true });

    mgr.closeAll(client);

    expect(client.notify).toHaveBeenCalledTimes(2);
    expect(mgr.openDocuments.size).toBe(0);
  });

  it("does nothing when closing all with no open documents", () => {
    mgr.closeAll(client);
    expect(client.notify).not.toHaveBeenCalled();
  });
});
