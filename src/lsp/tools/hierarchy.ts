import { defineTool } from "../../platform/ports/tool-factory.ts";
import { z } from "zod";
import type { LspClientManager } from "../client-manager.ts";
import type { LspDocumentManager } from "../document-manager.ts";
import {
  ensureSynced,
  extractLanguageId,
  fileUri,
  formatRange,
  formatSymbolKind,
} from "./utils.ts";
import type {
  CallHierarchyItem,
  CallHierarchyIncomingCall,
  CallHierarchyOutgoingCall,
  TypeHierarchyItem,
} from "../types.ts";

const hierarchyItemSchema = z.any().describe("Call/Type hierarchy item (JSON object from prepare response)");

function formatCallHierarchyItem(item: CallHierarchyItem, indent: string = ""): string {
  const kind = formatSymbolKind(item.kind);
  const detail = item.detail ? ` — ${item.detail}` : "";
  return `${indent}- **${item.name}** (${kind})${detail}\n  ${item.uri} ${formatRange(item.range)}`;
}

function formatTypeHierarchyItem(item: TypeHierarchyItem, indent: string = ""): string {
  const kind = formatSymbolKind(item.kind);
  const detail = item.detail ? ` — ${item.detail}` : "";
  return `${indent}- **${item.name}** (${kind})${detail}\n  ${item.uri} ${formatRange(item.range)}`;
}

export function createLspPrepareCallHierarchyTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return defineTool({
    description:
      "Prepare call hierarchy for a symbol at the given position. " +
      "Returns CallHierarchyItem(s) with name, kind, uri, and range. " +
      "Use the returned item with lsp_incoming_calls / lsp_outgoing_calls to navigate.",
    args: {
      filePath: z.string().describe("Absolute path to the file"),
      line: z.number().int().min(0).describe("Line (0-based)"),
      character: z.number().int().min(0).describe("Character (0-based)"),
    },
    async execute(input) {
      try {
        const languageId = extractLanguageId(input.filePath);

        const caps = clientManager.getServerCapabilities(languageId);
        if (!caps || !caps.callHierarchyProvider) {
          return "This language server does not support call hierarchy.";
        }

        await ensureSynced(input.filePath, docManager, clientManager, languageId);

        const uri = fileUri(input.filePath);

        const result = await clientManager.request<CallHierarchyItem | CallHierarchyItem[]>(
          "textDocument/prepareCallHierarchy",
          {
            textDocument: { uri },
            position: { line: input.line, character: input.character },
          },
          languageId,
        );

        if (!result) {
          return "No call hierarchy found at the specified position.";
        }

        const items = Array.isArray(result) ? result : [result];
        if (items.length === 0) {
          return "No call hierarchy found at the specified position.";
        }

        const formatted = items.map((item) => formatCallHierarchyItem(item)).join("\n\n");
        return `## Call Hierarchy — ${items.length} item(s)\n\n${formatted}`;
      } catch (err: any) {
        return `Error preparing call hierarchy: ${err.message ?? String(err)}`;
      }
    },
  });
}

export function createLspIncomingCallsTool(
  clientManager: LspClientManager,
  _docManager: LspDocumentManager,
) {
  return defineTool({
    description:
      "Retrieve incoming calls (callers) for a call hierarchy item. " +
      "Pass an item returned from lsp_prepare_call_hierarchy.",
    args: {
      item: hierarchyItemSchema.describe("Call hierarchy item (from lsp_prepare_call_hierarchy)"),
    },
    async execute(input) {
      try {
        const result = await clientManager.request<CallHierarchyIncomingCall[]>(
          "callHierarchy/incomingCalls",
          { item: input.item },
        );

        if (!result || result.length === 0) {
          return "No incoming calls found for this item.";
        }

        const lines: string[] = [`## Incoming Calls (${result.length})`, ""];
        for (let i = 0; i < result.length; i++) {
          const call = result[i];
          const from = call.from;
          const kind = formatSymbolKind(from.kind);
          const detail = from.detail ? ` — ${from.detail}` : "";
          lines.push(`### ${i + 1}. **${from.name}** (${kind})${detail}`);
          lines.push(`  ${from.uri} ${formatRange(from.range)}`);
          if (call.fromRanges && call.fromRanges.length > 0) {
            lines.push("  Call sites:");
            for (const r of call.fromRanges) {
              lines.push(`    - ${formatRange(r)}`);
            }
          }
          lines.push("");
        }

        return lines.join("\n");
      } catch (err: any) {
        return `Error retrieving incoming calls: ${err.message ?? String(err)}`;
      }
    },
  });
}

export function createLspOutgoingCallsTool(
  clientManager: LspClientManager,
  _docManager: LspDocumentManager,
) {
  return defineTool({
    description:
      "Retrieve outgoing calls (callees) for a call hierarchy item. " +
      "Pass an item returned from lsp_prepare_call_hierarchy.",
    args: {
      item: hierarchyItemSchema.describe("Call hierarchy item (from lsp_prepare_call_hierarchy)"),
    },
    async execute(input) {
      try {
        const result = await clientManager.request<CallHierarchyOutgoingCall[]>(
          "callHierarchy/outgoingCalls",
          { item: input.item },
        );

        if (!result || result.length === 0) {
          return "No outgoing calls found for this item.";
        }

        const lines: string[] = [`## Outgoing Calls (${result.length})`, ""];
        for (let i = 0; i < result.length; i++) {
          const call = result[i];
          const to = call.to;
          const kind = formatSymbolKind(to.kind);
          const detail = to.detail ? ` — ${to.detail}` : "";
          lines.push(`### ${i + 1}. **${to.name}** (${kind})${detail}`);
          lines.push(`  ${to.uri} ${formatRange(to.range)}`);
          if (call.fromRanges && call.fromRanges.length > 0) {
            lines.push("  Call sites:");
            for (const r of call.fromRanges) {
              lines.push(`    - ${formatRange(r)}`);
            }
          }
          lines.push("");
        }

        return lines.join("\n");
      } catch (err: any) {
        return `Error retrieving outgoing calls: ${err.message ?? String(err)}`;
      }
    },
  });
}

export function createLspTypeHierarchySupertypesTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return defineTool({
    description:
      "Retrieve supertypes (parent types) for a symbol at the given position. " +
      "Returns parent type hierarchy items.",
    args: {
      filePath: z.string().describe("Absolute path to the file"),
      line: z.number().int().min(0).describe("Line (0-based)"),
      character: z.number().int().min(0).describe("Character (0-based)"),
    },
    async execute(input) {
      try {
        const languageId = extractLanguageId(input.filePath);

        const caps = clientManager.getServerCapabilities(languageId);
        if (!caps || !caps.typeHierarchyProvider) {
          return "This language server does not support type hierarchy.";
        }

        await ensureSynced(input.filePath, docManager, clientManager, languageId);

        const uri = fileUri(input.filePath);

        const prepared = await clientManager.request<TypeHierarchyItem | TypeHierarchyItem[]>(
          "textDocument/prepareTypeHierarchy",
          {
            textDocument: { uri },
            position: { line: input.line, character: input.character },
          },
          languageId,
        );

        if (!prepared) {
          return "No type hierarchy found at the specified position.";
        }

        const items = Array.isArray(prepared) ? prepared : [prepared];
        if (items.length === 0) {
          return "No type hierarchy found at the specified position.";
        }

        // Use the first prepared item to query supertypes
        const result = await clientManager.request<TypeHierarchyItem[]>(
          "typeHierarchy/supertypes",
          { item: items[0] },
        );

        if (!result || result.length === 0) {
          return "No supertypes found for this symbol.";
        }

        const formatted = result
          .map((item) => formatTypeHierarchyItem(item))
          .join("\n\n");
        return `## Supertypes (${result.length})\n\n${formatted}`;
      } catch (err: any) {
        return `Error retrieving supertypes: ${err.message ?? String(err)}`;
      }
    },
  });
}

export function createLspTypeHierarchySubtypesTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return defineTool({
    description:
      "Retrieve subtypes (child types) for a symbol at the given position. " +
      "Returns child type hierarchy items.",
    args: {
      filePath: z.string().describe("Absolute path to the file"),
      line: z.number().int().min(0).describe("Line (0-based)"),
      character: z.number().int().min(0).describe("Character (0-based)"),
    },
    async execute(input) {
      try {
        const languageId = extractLanguageId(input.filePath);

        const caps = clientManager.getServerCapabilities(languageId);
        if (!caps || !caps.typeHierarchyProvider) {
          return "This language server does not support type hierarchy.";
        }

        await ensureSynced(input.filePath, docManager, clientManager, languageId);

        const uri = fileUri(input.filePath);

        const prepared = await clientManager.request<TypeHierarchyItem | TypeHierarchyItem[]>(
          "textDocument/prepareTypeHierarchy",
          {
            textDocument: { uri },
            position: { line: input.line, character: input.character },
          },
          languageId,
        );

        if (!prepared) {
          return "No type hierarchy found at the specified position.";
        }

        const items = Array.isArray(prepared) ? prepared : [prepared];
        if (items.length === 0) {
          return "No type hierarchy found at the specified position.";
        }

        const result = await clientManager.request<TypeHierarchyItem[]>(
          "typeHierarchy/subtypes",
          { item: items[0] },
        );

        if (!result || result.length === 0) {
          return "No subtypes found for this symbol.";
        }

        const formatted = result
          .map((item) => formatTypeHierarchyItem(item))
          .join("\n\n");
        return `## Subtypes (${result.length})\n\n${formatted}`;
      } catch (err: any) {
        return `Error retrieving subtypes: ${err.message ?? String(err)}`;
      }
    },
  });
}
