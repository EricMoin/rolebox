import { describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import * as url from "node:url";
import { fileUri, normalizeDocumentUri } from "../../src/lsp/uri.ts";
import { fileUri as toolUri } from "../../src/lsp/tools/utils.ts";
import { LspDocumentManager } from "../../src/lsp/document-manager.ts";

describe("canonical document URIs", () => {
  it("normalizes equivalent server encodings of reserved filename characters", () => {
    const canonical = fileUri(path.resolve("project & + $ , ; = @", "index # %.ts"));
    const encoded = canonical.replaceAll("&", "%26").replaceAll("+", "%2B").replaceAll("$", "%24")
      .replaceAll(",", "%2C").replaceAll(";", "%3B").replaceAll("=", "%3D").replaceAll("@", "%40");
    expect(normalizeDocumentUri(encoded)).toBe(canonical);
  });
  it.each(["plain.ts", "name & + $ , ; = : @.ts", "name # % ? 中文.ts"])("round-trips %s with one URI for documents and tools", name => {
    const file = path.resolve("project", name);
    const uri = fileUri(file);
    expect(uri).toBe(new LspDocumentManager().getUri(file));
    expect(toolUri(file)).toBe(uri);
    expect(url.fileURLToPath(uri)).toBe(file);
    expect(new URL(uri).hash).toBe("");
    expect(new URL(uri).search).toBe("");
    if (/^[A-Za-z]:\\/.test(file)) expect(uri).toMatch(/^file:\/\/\/[A-Za-z]:\//);
  });

  it("preserves Windows drive separators and UNC hosts with Node's Windows URL semantics", async () => {
    vi.resetModules();
    vi.doMock("node:path", () => ({ ...path, resolve: path.win32.resolve }));
    vi.doMock("node:url", () => ({ ...url, pathToFileURL: (file: string) => url.pathToFileURL(file, { windows: true }) }));
    try {
      const { fileUri: windowsUri } = await import("../../src/lsp/uri.ts");
      const file = String.raw`C:\project with spaces\name & + $ , ; = @.ts`;
      const uri = windowsUri(file);
      expect(uri).toStartWith("file:///C:/project%20with%20spaces/");
      expect(uri).not.toContain("C%3A");
      expect(url.fileURLToPath(uri, { windows: true })).toBe(file);
      const unc = String.raw`\\server\share\file # %.ts`;
      expect(windowsUri(unc)).toBe("file://server/share/file%20%23%20%25.ts");
      expect(url.fileURLToPath(windowsUri(unc), { windows: true })).toBe(unc);
    } finally {
      vi.doUnmock("node:path");
      vi.doUnmock("node:url");
      vi.resetModules();
    }
  });
});
