// ---------------------------------------------------------------------------
// LSP Document Manager — tracks open documents and synchronizes content
// changes with LSP servers via didOpen / didChange / didClose notifications.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileUri } from "./uri.ts";
import { createSubLogger } from "../logger.ts";
import type { LspClientManager } from "./client-manager.ts";
import type { LspServerState } from "./types.ts";

const log = createSubLogger("lsp:doc");

export class LspDocumentManager {
  readonly openDocuments: Map<string, { version: number; content: string; open: boolean }> = new Map();
  private readonly documentServers = new Map<string, LspServerState | undefined>();

  // -----------------------------------------------------------------------
  // sync — ensure the server has the latest content for a file
  // -----------------------------------------------------------------------

  async sync(filePath: string, client: LspClientManager, languageId: string): Promise<void> {
    const uri = this.getUri(filePath);
    const content = readFileSync(filePath, "utf-8");
    await client.startServer(languageId);
    const server = client.servers.get(languageId);
    const existing = this.openDocuments.get(uri);

    if (!existing || !existing.open || this.documentServers.get(uri) !== server) {
      server?.closedDocuments?.delete(uri);
      server?.diagnosticCache.delete(uri);
      server?.documentVersions?.set(uri, 1);
      client.notify(
        "textDocument/didOpen",
        {
          textDocument: {
            uri,
            languageId,
            version: 1,
            text: content,
          },
        },
        languageId,
      );
      this.openDocuments.set(uri, { version: 1, content, open: true });
      this.documentServers.set(uri, server);
      return;
    }

    if (existing.content !== content) {
      const version = existing.version + 1;
      server?.diagnosticCache.delete(uri);
      server?.documentVersions?.set(uri, version);
      client.notify(
        "textDocument/didChange",
        {
          textDocument: { uri, version },
          contentChanges: [{ text: content }],
        },
        languageId,
      );
      this.openDocuments.set(uri, { version, content, open: true });
    }
  }

  // -----------------------------------------------------------------------
  // close — notify the server that a document is no longer open
  // -----------------------------------------------------------------------

  close(filePath: string, client: LspClientManager): void {
    const uri = this.getUri(filePath);
    this.closeUri(uri, client);
  }

  closeAll(client: LspClientManager): void {
    const uris = Array.from(this.openDocuments.keys());
    for (const uri of uris) {
      this.closeUri(uri, client);
    }
  }

  // -----------------------------------------------------------------------
  // URI helpers
  // -----------------------------------------------------------------------

  getUri(filePath: string): string {
    return fileUri(filePath);
  }

  isOpen(uri: string): boolean {
    const doc = this.openDocuments.get(uri);
    return doc?.open === true;
  }

  getContent(uri: string): string | undefined {
    return this.openDocuments.get(uri)?.content;
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private closeUri(uri: string, client: LspClientManager): void {
    const existing = this.openDocuments.get(uri);
    if (!existing) return;

    client.notify("textDocument/didClose", { textDocument: { uri } });
    client.forgetDocument(uri);
    this.openDocuments.delete(uri);
    this.documentServers.delete(uri);
  }
}
