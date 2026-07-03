import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import type { LspClientManager } from "../client-manager.ts";
import type { LspDocumentManager } from "../document-manager.ts";
import type { DocumentSymbol, SymbolInformation } from "../types.ts";
import {
  extractLanguageId,
  ensureSynced,
  formatSymbolKind,
  formatRange,
  checkCapability,
  capabilityNotSupported,
} from "./utils.ts";

// ---------------------------------------------------------------------------
// Document Symbols
// ---------------------------------------------------------------------------

export function createLspDocumentSymbolsTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return tool({
    description:
      "List all symbols defined in a document. Returns a hierarchical tree when the server supports it, " +
      "otherwise a flat list.",
    args: {
      filePath: z.string().describe("Absolute path to the file"),
    },
    async execute(input) {
      try {
        const languageId = extractLanguageId(input.filePath);

        if (!checkCapability(languageId, clientManager, "textDocument.documentSymbol")) {
          return capabilityNotSupported("document symbols");
        }

        await ensureSynced(input.filePath, docManager, clientManager, languageId);

        const result = await clientManager.request<unknown[]>(
          "textDocument/documentSymbol",
          {
            textDocument: { uri: docManager.getUri(input.filePath) },
          },
          languageId,
        );

        if (!result || result.length === 0) {
          return "No symbols found in the document.";
        }

        // Check if the result is DocumentSymbol[] (has "range" and "selectionRange") or SymbolInformation[]
        const first = result[0] as Record<string, unknown>;
        const isHierarchical = "range" in first && "selectionRange" in first;

        if (isHierarchical) {
          return formatDocumentSymbolTree(result as DocumentSymbol[], 0);
        }

        return formatSymbolInformationList(result as SymbolInformation[]);
      } catch (err) {
        if (err instanceof Error && err.message.includes("timed out")) {
          return "Request timed out. The language server may be slow to respond.";
        }
        if (err instanceof Error && err.message.includes("No language server configured")) {
          return err.message;
        }
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}

function formatDocumentSymbolTree(symbols: DocumentSymbol[], depth: number): string {
  const lines: string[] = [];
  if (depth === 0) {
    lines.push("## Document Symbols");
    lines.push("");
  }

  for (const sym of symbols) {
    const indent = "  ".repeat(depth);
    const kind = formatSymbolKind(sym.kind);
    lines.push(`${indent}- **${kind}** \`${sym.name}\` — ${formatRange(sym.range)}`);
    if (sym.children && sym.children.length > 0) {
      const childOutput = formatDocumentSymbolTree(sym.children, depth + 1);
      lines.push(childOutput);
    }
  }

  return lines.join("\n");
}

function formatSymbolInformationList(symbols: SymbolInformation[]): string {
  const lines: string[] = [];
  lines.push("## Document Symbols");
  lines.push("");

  for (const sym of symbols) {
    const kind = formatSymbolKind(sym.kind);
    const container = sym.containerName ? ` (in \`${sym.containerName}\`)` : "";
    lines.push(`- **${kind}** \`${sym.name}\`${container} — \`${sym.location.uri} ${formatRange(sym.location.range)}\``);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Workspace Symbols
// ---------------------------------------------------------------------------

export function createLspWorkspaceSymbolsTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return tool({
    description:
      "Search for symbols across the entire workspace. Results are grouped by symbol kind.",
    args: {
      query: z.string().min(1).describe("Search query for symbol names"),
    },
    async execute(input) {
      try {
        // Workspace symbols don't need a specific language ID — try each running server
        const runningServers = clientManager.getRunningServers();
        if (runningServers.length === 0) {
          return "No language servers are currently running. Open a file first.";
        }

        // Check if any running server supports workspace symbols
        let anySupport = false;
        for (const srv of runningServers) {
          const caps = clientManager.getServerCapabilities(srv.languageId);
          if (caps?.workspace?.symbol) {
            anySupport = true;
            break;
          }
        }
        if (!anySupport) {
          return capabilityNotSupported("workspace symbols");
        }

        // Try each server until we get results
        const allSymbols: { languageId: string; symbols: SymbolInformation[] }[] = [];

        for (const srv of runningServers) {
          const caps = clientManager.getServerCapabilities(srv.languageId);
          if (!caps?.workspace?.symbol) continue;

          try {
            const result = await clientManager.request<SymbolInformation[]>(
              "workspace/symbol",
              { query: input.query },
              srv.languageId,
            );
            if (result && result.length > 0) {
              allSymbols.push({ languageId: srv.languageId, symbols: result });
            }
          } catch {
            // Server may not support workspace/symbol — skip
          }
        }

        if (allSymbols.length === 0) {
          return "No workspace symbols found matching your query.";
        }

        const lines: string[] = [];
        lines.push(`## Workspace Symbols matching "${input.query}"`);
        lines.push("");

        for (const { languageId, symbols } of allSymbols) {
          lines.push(`### ${languageId} (${symbols.length} results)`);
          lines.push("");

          // Group by kind
          const grouped = new Map<string, SymbolInformation[]>();
          for (const sym of symbols) {
            const kind = formatSymbolKind(sym.kind);
            const group = grouped.get(kind) ?? [];
            group.push(sym);
            grouped.set(kind, group);
          }

          for (const [kind, kindSymbols] of grouped) {
            lines.push(`**${kind}:**`);
            for (const sym of kindSymbols) {
              const container = sym.containerName ? ` (in \`${sym.containerName}\`)` : "";
              lines.push(`- \`${sym.name}\`${container} — \`${sym.location.uri} ${formatRange(sym.location.range)}\``);
            }
            lines.push("");
          }
        }

        return lines.join("\n");
      } catch (err) {
        if (err instanceof Error && err.message.includes("timed out")) {
          return "Request timed out. The language server may be slow to respond.";
        }
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
