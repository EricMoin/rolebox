import { existsSync, readFileSync } from "node:fs";
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import type { LspClientManager } from "../client-manager.ts";
import type { LspDocumentManager } from "../document-manager.ts";
import type { Location, DocumentHighlight } from "../types.ts";
import {
  extractLanguageId,
  ensureSynced,
  formatLocation,
  formatDocumentHighlightKind,
  checkCapability,
  capabilityNotSupported,
} from "./utils.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeLocations(result: unknown): Location[] {
  if (!result) return [];
  if (Array.isArray(result)) return result as Location[];
  return [result as Location];
}

function formatLocationList(locations: Location[], header: string): string {
  if (locations.length === 0) return "No results found.";

  const lines: string[] = [];
  lines.push(`## ${header}`);
  lines.push("");

  for (let i = 0; i < locations.length; i++) {
    const loc = locations[i];
    lines.push(`${i + 1}. \`${formatLocation(loc)}\``);
  }

  return lines.join("\n");
}

function extractContextSnippet(filePath: string, line: number): string {
  try {
    if (!existsSync(filePath)) return "";
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    const start = Math.max(0, line - 2);
    const end = Math.min(lines.length, line + 3);

    const snippetLines: string[] = [];
    for (let i = start; i < end; i++) {
      const prefix = i === line ? ">" : " ";
      snippetLines.push(`${prefix} L${i}: ${lines[i]}`);
    }
    return snippetLines.join("\n");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Generic navigation tool factory
// ---------------------------------------------------------------------------

function createNavigationTool(
  description: string,
  method: string,
  capabilityPath: string,
  resultLabel: string,
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return tool({
    description,
    args: {
      filePath: z.string().describe("Absolute path to the file"),
      line: z.number().int().min(0).describe("0-based line number"),
      character: z.number().int().min(0).describe("0-based character offset"),
    },
    async execute(input) {
      try {
        const languageId = extractLanguageId(input.filePath);

        if (!checkCapability(languageId, clientManager, capabilityPath)) {
          return capabilityNotSupported(
            method.replace("textDocument/", "").replace(/([A-Z])/g, " $1").toLowerCase().trim(),
          );
        }

        await ensureSynced(input.filePath, docManager, clientManager, languageId);

        const result = await clientManager.request<unknown>(method, {
          textDocument: { uri: docManager.getUri(input.filePath) },
          position: { line: input.line, character: input.character },
        }, languageId);

        const locations = normalizeLocations(result);
        return formatLocationList(locations, resultLabel);
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

// ---------------------------------------------------------------------------
// 6 Navigation tools
// ---------------------------------------------------------------------------

export function createLspGotoDefinitionTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return createNavigationTool(
    "Go to definition of the symbol at the given position. Returns the location(s) where the symbol is defined.",
    "textDocument/definition",
    "definitionProvider",
    "Definitions",
    clientManager,
    docManager,
  );
}

export function createLspGotoTypeDefinitionTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return createNavigationTool(
    "Go to type definition of the symbol at the given position. Returns the location(s) of the type definition.",
    "textDocument/typeDefinition",
    "typeDefinitionProvider",
    "Type Definitions",
    clientManager,
    docManager,
  );
}

export function createLspGotoImplementationTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return createNavigationTool(
    "Go to implementation(s) of the symbol at the given position.",
    "textDocument/implementation",
    "implementationProvider",
    "Implementations",
    clientManager,
    docManager,
  );
}

export function createLspGotoDeclarationTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return createNavigationTool(
    "Go to declaration of the symbol at the given position.",
    "textDocument/declaration",
    "declarationProvider",
    "Declarations",
    clientManager,
    docManager,
  );
}

export function createLspFindReferencesTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return tool({
    description:
      "Find all references to the symbol at the given position. Returns locations with surrounding context snippets.",
    args: {
      filePath: z.string().describe("Absolute path to the file"),
      line: z.number().int().min(0).describe("0-based line number"),
      character: z.number().int().min(0).describe("0-based character offset"),
      includeDeclaration: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to include the declaration in the results"),
    },
    async execute(input) {
      try {
        const languageId = extractLanguageId(input.filePath);

        if (!checkCapability(languageId, clientManager, "referencesProvider")) {
          return capabilityNotSupported("find references");
        }

        await ensureSynced(input.filePath, docManager, clientManager, languageId);

        const result = await clientManager.request<Location[]>(
          "textDocument/references",
          {
            textDocument: { uri: docManager.getUri(input.filePath) },
            position: { line: input.line, character: input.character },
            context: { includeDeclaration: input.includeDeclaration },
          },
          languageId,
        );

        if (!result || result.length === 0) {
          return "No references found.";
        }

        const lines: string[] = [];
        lines.push(`## References (${result.length})`);
        lines.push("");

        for (let i = 0; i < result.length; i++) {
          const ref = result[i];
          lines.push(`### ${i + 1}. \`${formatLocation(ref)}\``);

          // Extract file path from URI for context snippet
          const refPath = ref.uri.replace(/^file:\/\//, "");
          const snippet = extractContextSnippet(refPath, ref.range.start.line);
          if (snippet) {
            lines.push("");
            lines.push("```");
            lines.push(snippet);
            lines.push("```");
          }
          lines.push("");
        }

        return lines.join("\n");
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

export function createLspDocumentHighlightsTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return tool({
    description:
      "Highlight all occurrences of the symbol at the given position in the same document. " +
      "Returns ranges with their highlight kind (Text/Read/Write).",
    args: {
      filePath: z.string().describe("Absolute path to the file"),
      line: z.number().int().min(0).describe("0-based line number"),
      character: z.number().int().min(0).describe("0-based character offset"),
    },
    async execute(input) {
      try {
        const languageId = extractLanguageId(input.filePath);

        if (!checkCapability(languageId, clientManager, "documentHighlightProvider")) {
          return capabilityNotSupported("document highlights");
        }

        await ensureSynced(input.filePath, docManager, clientManager, languageId);

        const result = await clientManager.request<DocumentHighlight[]>(
          "textDocument/documentHighlight",
          {
            textDocument: { uri: docManager.getUri(input.filePath) },
            position: { line: input.line, character: input.character },
          },
          languageId,
        );

        if (!result || result.length === 0) {
          return "No highlights found.";
        }

        const lines: string[] = [];
        lines.push(`## Document Highlights (${result.length})`);
        lines.push("");

        for (let i = 0; i < result.length; i++) {
          const h = result[i];
          const kind = h.kind != null ? formatDocumentHighlightKind(h.kind) : "Text";
          const rangeStr = `L${h.range.start.line}:${h.range.start.character}-L${h.range.end.line}:${h.range.end.character}`;
          lines.push(`${i + 1}. \`${rangeStr}\` — **${kind}**`);
        }

        return lines.join("\n");
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
