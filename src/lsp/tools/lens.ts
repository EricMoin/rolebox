import { defineTool } from "../../platform/ports/tool-factory.ts";
import { z } from "zod";
import type { LspClientManager } from "../client-manager.ts";
import type { LspDocumentManager } from "../document-manager.ts";
import {
  ensureSynced,
  extractLanguageId,
  fileUri,
  formatRange,
} from "./utils.ts";
import type {
  CodeLens,
  InlayHint,
  DocumentLink,
  ColorInformation,
} from "../types.ts";

function colorToHex(color: {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}): string {
  const r = Math.round(color.red * 255);
  const g = Math.round(color.green * 255);
  const b = Math.round(color.blue * 255);
  const a = Math.round(color.alpha * 255);
  if (a === 255) {
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  }
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}${a.toString(16).padStart(2, "0")}`;
}

export function createLspCodeLensTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return defineTool({
    description:
      "Retrieve code lenses (run/test/debug actions above functions, references, etc.) for a document.",
    args: {
      filePath: z.string().describe("Absolute path to the file"),
    },
    async execute(input) {
      try {
        const languageId = extractLanguageId(input.filePath);

        const caps = clientManager.getServerCapabilities(languageId);
        if (!caps || !caps.codeLensProvider) {
          return "This language server does not support code lenses.";
        }

        await ensureSynced(input.filePath, docManager, clientManager, languageId);

        const uri = fileUri(input.filePath);

        const result = await clientManager.request<CodeLens[]>(
          "textDocument/codeLens",
          { textDocument: { uri } },
          languageId,
        );

        if (!result || result.length === 0) {
          return "No code lenses found.";
        }

        const lines = [`## Code Lenses (${result.length})`, ""];
        for (let i = 0; i < result.length; i++) {
          const lens = result[i];
          const rangeStr = formatRange(lens.range);
          const cmdTitle = lens.command?.title ?? "(no command)";
          const cmdName = lens.command?.command
            ? ` \`${lens.command.command}\``
            : "";
          lines.push(`${i + 1}. **${cmdTitle}**${cmdName}`);
          lines.push(`   Range: ${rangeStr}`);
          lines.push("");
        }

        return lines.join("\n");
      } catch (err: any) {
        return `Error retrieving code lenses: ${err.message ?? String(err)}`;
      }
    },
  });
}

export function createLspInlayHintsTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return defineTool({
    description:
      "Retrieve inlay hints (type hints, parameter name hints) for a document. " +
      "Optionally restrict to a specific range.",
    args: {
      filePath: z.string().describe("Absolute path to the file"),
      startLine: z.number().int().min(0).optional().describe("Start line (0-based) for range restriction"),
      startChar: z.number().int().min(0).optional().describe("Start character (0-based) for range restriction"),
      endLine: z.number().int().min(0).optional().describe("End line (0-based) for range restriction"),
      endChar: z.number().int().min(0).optional().describe("End character (0-based) for range restriction"),
    },
    async execute(input) {
      try {
        const languageId = extractLanguageId(input.filePath);

        const caps = clientManager.getServerCapabilities(languageId);
        if (!caps || !caps.inlayHintProvider) {
          return "This language server does not support inlay hints.";
        }

        await ensureSynced(input.filePath, docManager, clientManager, languageId);

        const uri = fileUri(input.filePath);

        const params: any = { textDocument: { uri } };
        if (
          input.startLine !== undefined &&
          input.startChar !== undefined &&
          input.endLine !== undefined &&
          input.endChar !== undefined
        ) {
          params.range = {
            start: { line: input.startLine, character: input.startChar },
            end: { line: input.endLine, character: input.endChar },
          };
        }

        const result = await clientManager.request<InlayHint[]>(
          "textDocument/inlayHint",
          params,
          languageId,
        );

        if (!result || result.length === 0) {
          return "No inlay hints found.";
        }

        const lines = [`## Inlay Hints (${result.length})`, ""];
        for (let i = 0; i < result.length; i++) {
          const hint = result[i];
          const pos = hint.position;
          const labelStr =
            typeof hint.label === "string"
              ? hint.label
              : hint.label.map((part) => part.value).join("");
          const kindStr = hint.kind === 1
            ? " (Type)"
            : hint.kind === 2
              ? " (Parameter)"
              : "";
          lines.push(
            `${i + 1}. \`${labelStr}\`${kindStr} — L${pos.line}:${pos.character}`,
          );
        }

        return lines.join("\n");
      } catch (err: any) {
        return `Error retrieving inlay hints: ${err.message ?? String(err)}`;
      }
    },
  });
}

export function createLspDocumentLinksTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return defineTool({
    description:
      "Retrieve document links (clickable URLs/references) from a document.",
    args: {
      filePath: z.string().describe("Absolute path to the file"),
    },
    async execute(input) {
      try {
        const languageId = extractLanguageId(input.filePath);

        const caps = clientManager.getServerCapabilities(languageId);
        if (!caps || !caps.documentLinkProvider) {
          return "This language server does not support document links.";
        }

        await ensureSynced(input.filePath, docManager, clientManager, languageId);

        const uri = fileUri(input.filePath);

        const result = await clientManager.request<DocumentLink[]>(
          "textDocument/documentLink",
          { textDocument: { uri } },
          languageId,
        );

        if (!result || result.length === 0) {
          return "No document links found.";
        }

        const lines = [`## Document Links (${result.length})`, ""];
        for (let i = 0; i < result.length; i++) {
          const link = result[i];
          const target = link.target ?? "(no target)";
          const rangeStr = formatRange(link.range);
          lines.push(`${i + 1}. [${target}]`);
          lines.push(`   Range: ${rangeStr}`);
          if (link.tooltip) {
            lines.push(`   Tooltip: ${link.tooltip}`);
          }
          lines.push("");
        }

        return lines.join("\n");
      } catch (err: any) {
        return `Error retrieving document links: ${err.message ?? String(err)}`;
      }
    },
  });
}

export function createLspDocumentColorsTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return defineTool({
    description:
      "Retrieve color information (color references) from a document. " +
      "Returns colors as hex values with their ranges.",
    args: {
      filePath: z.string().describe("Absolute path to the file"),
    },
    async execute(input) {
      try {
        const languageId = extractLanguageId(input.filePath);

        const caps = clientManager.getServerCapabilities(languageId);
        if (!caps || !caps.colorProvider) {
          return "This language server does not support document colors.";
        }

        await ensureSynced(input.filePath, docManager, clientManager, languageId);

        const uri = fileUri(input.filePath);

        const result = await clientManager.request<ColorInformation[]>(
          "textDocument/documentColor",
          { textDocument: { uri } },
          languageId,
        );

        if (!result || result.length === 0) {
          return "No color information found.";
        }

        const lines = [`## Document Colors (${result.length})`, ""];
        for (let i = 0; i < result.length; i++) {
          const ci = result[i];
          const hex = colorToHex(ci.color);
          const rangeStr = formatRange(ci.range);
          lines.push(
            `${i + 1}. ${hex} — ${rangeStr}`,
          );
        }

        return lines.join("\n");
      } catch (err: any) {
        return `Error retrieving document colors: ${err.message ?? String(err)}`;
      }
    },
  });
}
