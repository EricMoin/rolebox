import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import type { LspClientManager } from "../client-manager.ts";
import type { LspDocumentManager } from "../document-manager.ts";
import {
  ensureSynced,
  extractLanguageId,
  fileUri,
  formatRange,
} from "./utils.ts";
import type { FoldingRange, SelectionRange, SemanticTokens } from "../types.ts";

export function createLspFoldingRangesTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return tool({
    description:
      "Retrieve folding ranges for a document. " +
      "Returns ranges sorted by start line with collapsible section markers.",
    args: {
      filePath: z.string().describe("Absolute path to the file"),
    },
    async execute(input) {
      try {
        const languageId = extractLanguageId(input.filePath);

        const caps = clientManager.getServerCapabilities(languageId);
        if (!caps || !caps.foldingRangeProvider) {
          return "This language server does not support folding ranges.";
        }

        await ensureSynced(input.filePath, docManager, clientManager, languageId);

        const uri = fileUri(input.filePath);

        const result = await clientManager.request<FoldingRange[]>(
          "textDocument/foldingRange",
          { textDocument: { uri } },
          languageId,
        );

        if (!result || result.length === 0) {
          return "No folding ranges found.";
        }

        const sorted = [...result].sort((a, b) => a.startLine - b.startLine);

        const lines = [
          `## Folding Ranges (${sorted.length})`,
          "",
        ];
        for (let i = 0; i < sorted.length; i++) {
          const r = sorted[i];
          const kindStr = r.kind ? ` (${r.kind})` : "";
          const startChar =
            r.startCharacter !== undefined
              ? `:${r.startCharacter}`
              : "";
          const endChar =
            r.endCharacter !== undefined ? `:${r.endCharacter}` : "";
          lines.push(
            `${i + 1}. \`L${r.startLine}${startChar}-L${r.endLine}${endChar}\`${kindStr}`,
          );
        }

        return lines.join("\n");
      } catch (err: any) {
        return `Error retrieving folding ranges: ${err.message ?? String(err)}`;
      }
    },
  });
}

function formatSelectionRangeTree(
  sr: SelectionRange,
  indent: number = 0,
): string {
  const prefix = "  ".repeat(indent);
  const r = sr.range;
  let result = `${prefix}- ${formatRange(r)}`;
  if (sr.parent) {
    result += `\n${formatSelectionRangeTree(sr.parent, indent + 1)}`;
  }
  return result;
}

export function createLspSelectionRangesTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return tool({
    description:
      "Retrieve hierarchical selection ranges (parent scopes) for one or more positions. " +
      "Each position returns a nested chain from innermost to outermost scope.",
    args: {
      filePath: z.string().describe("Absolute path to the file"),
      positions: z
        .array(
          z.object({
            line: z.number().int().min(0),
            character: z.number().int().min(0),
          }),
        )
        .min(1)
        .max(50)
        .describe("Array of positions (line, character) to get selection ranges for"),
    },
    async execute(input) {
      try {
        const languageId = extractLanguageId(input.filePath);

        const caps = clientManager.getServerCapabilities(languageId);
        if (!caps || !caps.selectionRangeProvider) {
          return "This language server does not support selection ranges.";
        }

        await ensureSynced(input.filePath, docManager, clientManager, languageId);

        const uri = fileUri(input.filePath);

        const result = await clientManager.request<(SelectionRange | null)[]>(
          "textDocument/selectionRange",
          {
            textDocument: { uri },
            positions: input.positions,
          },
          languageId,
        );

        if (!result || result.length === 0) {
          return "No selection ranges found.";
        }

        const lines = [`## Selection Ranges (${result.length} position(s))`, ""];
        for (let i = 0; i < result.length; i++) {
          const sr = result[i];
          const pos = input.positions[i];
          lines.push(`### Position ${i + 1}: L${pos.line}:${pos.character}`);
          if (sr) {
            const tree = formatSelectionRangeTree(sr);
            lines.push(tree);
          } else {
            lines.push("  (no selection range at this position)");
          }
          lines.push("");
        }

        return lines.join("\n");
      } catch (err: any) {
        return `Error retrieving selection ranges: ${err.message ?? String(err)}`;
      }
    },
  });
}

function decodeTokenModifiers(
  mask: number,
  modifierLegend: string[],
): string[] {
  const modifiers: string[] = [];
  for (let i = 0; i < modifierLegend.length; i++) {
    if (mask & (1 << i)) {
      modifiers.push(modifierLegend[i]);
    }
  }
  return modifiers;
}

export function createLspSemanticTokensTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return tool({
    description:
      "Retrieve semantic tokens for a document. " +
      "Decodes the delta-encoded integer array into a human-readable table of tokens with type and modifiers.",
    args: {
      filePath: z.string().describe("Absolute path to the file"),
    },
    async execute(input) {
      try {
        const languageId = extractLanguageId(input.filePath);

        const caps = clientManager.getServerCapabilities(languageId);
        if (!caps || !caps.semanticTokensProvider) {
          return "This language server does not support semantic tokens.";
        }

        const legend = caps.semanticTokensProvider.legend;
        if (!legend) {
          return "Semantic tokens legend not available from server capabilities.";
        }

        const tokenTypes: string[] = legend.tokenTypes ?? [];
        const tokenModifiers: string[] = legend.tokenModifiers ?? [];

        await ensureSynced(input.filePath, docManager, clientManager, languageId);

        const uri = fileUri(input.filePath);

        const result = await clientManager.request<SemanticTokens>(
          "textDocument/semanticTokens/full",
          { textDocument: { uri } },
          languageId,
        );

        if (!result || !result.data || result.data.length === 0) {
          return "No semantic tokens found.";
        }

        const data = result.data;
        const tokens: Array<{
          line: number;
          char: number;
          length: number;
          type: string;
          modifiers: string;
        }> = [];

        let currentLine = 0;
        let currentChar = 0;

        for (let i = 0; i < data.length; i += 5) {
          const deltaLine = data[i];
          const deltaStartChar = data[i + 1];
          const length = data[i + 2];
          const tokenTypeIdx = data[i + 3];
          const modifierMask = data[i + 4];

          currentLine += deltaLine;
          if (deltaLine === 0) {
            currentChar += deltaStartChar;
          } else {
            currentChar = deltaStartChar;
          }

          const typeName = tokenTypes[tokenTypeIdx] ?? `type${tokenTypeIdx}`;
          const mods = decodeTokenModifiers(modifierMask, tokenModifiers);
          const modStr = mods.length > 0 ? mods.join(", ") : "none";

          tokens.push({
            line: currentLine,
            char: currentChar,
            length,
            type: typeName,
            modifiers: modStr,
          });
        }

        const lines = [
          `## Semantic Tokens (${tokens.length})`,
          "",
          "| Line | Char | Length | Type | Modifiers |",
          "|------|------|--------|------|-----------|",
        ];

        // Show first 500 tokens to avoid overflow
        const displayTokens = tokens.slice(0, 500);
        for (const t of displayTokens) {
          lines.push(
            `| ${t.line} | ${t.char} | ${t.length} | ${t.type} | ${t.modifiers} |`,
          );
        }

        if (tokens.length > 500) {
          lines.push(
            "",
            `*(${tokens.length - 500} more tokens not shown — use semantic tokens on a smaller scope)*`,
          );
        }

        return lines.join("\n");
      } catch (err: any) {
        return `Error retrieving semantic tokens: ${err.message ?? String(err)}`;
      }
    },
  });
}
