import { defineTool } from "../../platform/ports/tool-factory.ts";
import { z } from "zod";
import { readFileSync, writeFileSync } from "node:fs";
import type { LspClientManager } from "../client-manager.ts";
import type { LspDocumentManager } from "../document-manager.ts";
import {
  ensureSynced,
  extractLanguageId,
  fileUri,
} from "./utils.ts";
import { positionToOffset } from "../position.ts";
import type { TextEdit } from "../types.ts";

function applyTextEdits(content: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => {
    const aStart = positionToOffset(content, a.range.start);
    const bStart = positionToOffset(content, b.range.start);
    if (bStart !== aStart) return bStart - aStart;
    const aEnd = positionToOffset(content, a.range.end);
    const bEnd = positionToOffset(content, b.range.end);
    return bEnd - aEnd;
  });

  let result = content;
  for (const edit of sorted) {
    const start = positionToOffset(result, edit.range.start);
    const end = positionToOffset(result, edit.range.end);
    result = result.slice(0, start) + edit.newText + result.slice(end);
  }
  return result;
}

export function createLspFormatDocumentTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return defineTool({
    description:
      "Format an entire document using the language server. " +
      "Returns a summary of changes (lines changed) or the full formatted content.",
    args: {
      filePath: z.string().describe("Absolute path to the file to format"),
    },
    async execute(input) {
      try {
        const languageId = extractLanguageId(input.filePath);

        const caps = clientManager.getServerCapabilities(languageId);
        if (!caps || !caps.documentFormattingProvider) {
          return "This language server does not support document formatting.";
        }

        await ensureSynced(
          input.filePath,
          docManager,
          clientManager,
          languageId,
        );

        const uri = fileUri(input.filePath);
        const originalContent = readFileSync(input.filePath, "utf-8");

        const edits = await clientManager.request<TextEdit[]>(
          "textDocument/formatting",
          {
            textDocument: { uri },
            options: { tabSize: 2, insertSpaces: true },
          },
          languageId,
        );

        if (!edits || edits.length === 0) {
          return "No formatting changes needed — the document is already formatted.";
        }

        const newContent = applyTextEdits(originalContent, edits);
        writeFileSync(input.filePath, newContent, "utf-8");

        try {
          await ensureSynced(
            input.filePath,
            docManager,
            clientManager,
            languageId,
          );
        } catch {
          // Best-effort sync after write
        }

        // Count changed lines
        const origLines = originalContent.split("\n");
        const newLines = newContent.split("\n");
        let changedLines = 0;
        const maxLen = Math.max(origLines.length, newLines.length);
        for (let i = 0; i < maxLen; i++) {
          if (origLines[i] !== newLines[i]) changedLines++;
        }

        return [
          "## Format Complete",
          "",
          `File: ${input.filePath}`,
          `Lines changed: ${changedLines}`,
          `Total edits: ${edits.length}`,
        ].join("\n");
      } catch (err: any) {
        return `Error formatting document: ${err.message ?? String(err)}`;
      }
    },
  });
}

export function createLspFormatRangeTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return defineTool({
    description:
      "Format a specific range within a document using the language server. " +
      "Returns the formatted range content.",
    args: {
      filePath: z.string().describe("Absolute path to the file"),
      startLine: z
        .number()
        .int()
        .min(0)
        .describe("Start line (0-based) of the range to format"),
      startChar: z
        .number()
        .int()
        .min(0)
        .describe("Start character (0-based) of the range to format"),
      endLine: z
        .number()
        .int()
        .min(0)
        .describe("End line (0-based) of the range to format"),
      endChar: z
        .number()
        .int()
        .min(0)
        .describe("End character (0-based) of the range to format"),
    },
    async execute(input) {
      try {
        const languageId = extractLanguageId(input.filePath);

        const caps = clientManager.getServerCapabilities(languageId);
        if (!caps || !caps.documentRangeFormattingProvider) {
          const docCaps = caps?.documentFormattingProvider;
          if (docCaps) {
            return "This language server does not support range formatting, but supports full document formatting. Use lsp_format_document instead.";
          }
          return "This language server does not support formatting.";
        }

        await ensureSynced(
          input.filePath,
          docManager,
          clientManager,
          languageId,
        );

        const uri = fileUri(input.filePath);
        const originalContent = readFileSync(input.filePath, "utf-8");

        const edits = await clientManager.request<TextEdit[]>(
          "textDocument/rangeFormatting",
          {
            textDocument: { uri },
            range: {
              start: { line: input.startLine, character: input.startChar },
              end: { line: input.endLine, character: input.endChar },
            },
            options: { tabSize: 2, insertSpaces: true },
          },
          languageId,
        );

        if (!edits || edits.length === 0) {
          return "No formatting changes needed for the specified range.";
        }

        const newContent = applyTextEdits(originalContent, edits);
        writeFileSync(input.filePath, newContent, "utf-8");

        try {
          await ensureSynced(
            input.filePath,
            docManager,
            clientManager,
            languageId,
          );
        } catch {
          // Best-effort sync
        }

        // Extract the formatted range content for preview
        const newLines = newContent.split("\n");
        const rangeLines = newLines.slice(
          input.startLine,
          input.endLine + 1,
        );
        const rangeContent = rangeLines.join("\n");

        return [
          "## Range Format Complete",
          "",
          `File: ${input.filePath}`,
          `Range: L${input.startLine}:${input.startChar}-L${input.endLine}:${input.endChar}`,
          `Edits applied: ${edits.length}`,
          "",
          "### Formatted Range",
          "```",
          rangeContent,
          "```",
        ].join("\n");
      } catch (err: any) {
        return `Error formatting range: ${err.message ?? String(err)}`;
      }
    },
  });
}
