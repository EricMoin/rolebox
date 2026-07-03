import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import type { LspClientManager } from "../client-manager.ts";
import type { LspDocumentManager } from "../document-manager.ts";
import type { CompletionItem, MarkupContent } from "../types.ts";
import {
  extractLanguageId,
  ensureSynced,
  formatCompletionKind,
  checkCapability,
  capabilityNotSupported,
} from "./utils.ts";

export function createLspCompletionTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return tool({
    description:
      "Get code completion suggestions at the given position. Returns the top N items with label, kind, detail, and documentation.",
    args: {
      filePath: z.string().describe("Absolute path to the file"),
      line: z.number().int().min(0).describe("0-based line number"),
      character: z.number().int().min(0).describe("0-based character offset"),
      maxItems: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe("Maximum number of completion items to return (default: 20)"),
    },
    async execute(input) {
      try {
        const languageId = extractLanguageId(input.filePath);

        if (!checkCapability(languageId, clientManager, "completionProvider")) {
          return capabilityNotSupported("completion");
        }

        await ensureSynced(input.filePath, docManager, clientManager, languageId);

        const result = await clientManager.request<CompletionItem[] | { isIncomplete: boolean; items: CompletionItem[] } | null>(
          "textDocument/completion",
          {
            textDocument: { uri: docManager.getUri(input.filePath) },
            position: { line: input.line, character: input.character },
          },
          languageId,
        );

        if (!result) {
          return "No completion results available at this position.";
        }

        // Normalize result — LSP can return either CompletionItem[] or { isIncomplete, items }
        let items: CompletionItem[];
        let isIncomplete = false;
        if (Array.isArray(result)) {
          items = result;
        } else {
          items = result.items ?? [];
          isIncomplete = result.isIncomplete ?? false;
        }

        if (items.length === 0) {
          return "No completion items available at this position.";
        }

        const maxItems = input.maxItems ?? 20;
        const display = items.slice(0, maxItems);

        const lines: string[] = [];
        lines.push(`## Completion Items (showing ${display.length} of ${items.length}${isIncomplete ? "+" : ""})`);
        lines.push("");

        for (let i = 0; i < display.length; i++) {
          const item = display[i];
          const kind = item.kind != null ? formatCompletionKind(item.kind) : "";
          const kindBadge = kind ? `**\`[${kind}]\`**` : "";
          const detail = item.detail ?? "";
          lines.push(`### ${i + 1}. ${kindBadge} \`${item.label}\``);

          if (detail) {
            lines.push(`**Detail:** ${detail}`);
          }

          if (item.documentation) {
            const docs = typeof item.documentation === "string"
              ? item.documentation
              : (item.documentation as MarkupContent).value;
            lines.push("");
            lines.push(docs);
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
