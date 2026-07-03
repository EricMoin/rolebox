import { existsSync, readFileSync } from "node:fs";
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import type { LspClientManager } from "../client-manager.ts";
import type { LspDocumentManager } from "../document-manager.ts";
import type { WorkspaceEdit, TextEdit } from "../types.ts";
import {
  extractLanguageId,
  ensureSynced,
  formatRange,
  checkCapability,
  capabilityNotSupported,
} from "./utils.ts";

// ---------------------------------------------------------------------------
// Prepare Rename
// ---------------------------------------------------------------------------

export function createLspPrepareRenameTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return tool({
    description:
      "Prepare to rename the symbol at the given position. " +
      "Returns the range of the symbol and its current text (placeholder). " +
      "If the server does not support prepareRename, rename may still work directly.",
    args: {
      filePath: z.string().describe("Absolute path to the file"),
      line: z.number().int().min(0).describe("0-based line number"),
      character: z.number().int().min(0).describe("0-based character offset"),
    },
    async execute(input) {
      try {
        const languageId = extractLanguageId(input.filePath);

        if (!checkCapability(languageId, clientManager, "textDocument.rename")) {
          return capabilityNotSupported("rename");
        }

        const hasPrepareSupport = checkCapability(languageId, clientManager, "textDocument.rename.prepareSupport");
        if (!hasPrepareSupport) {
          return "This language server does not support prepare rename (the `rename.prepareSupport` capability is not enabled). You can still try `lsp_rename` directly.";
        }

        await ensureSynced(input.filePath, docManager, clientManager, languageId);

        const result = await clientManager.request<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; placeholder: string } | null>(
          "textDocument/prepareRename",
          {
            textDocument: { uri: docManager.getUri(input.filePath) },
            position: { line: input.line, character: input.character },
          },
          languageId,
        );

        if (!result) {
          return "No rename information available at this position. The cursor may not be on a valid symbol.";
        }

        const lines: string[] = [];
        lines.push("## Prepare Rename");
        lines.push("");
        lines.push(`**Range:** \`${formatRange(result.range)}\``);
        lines.push(`**Current name:** \`${result.placeholder}\``);
        lines.push("");
        lines.push("You can rename this symbol using `lsp_rename` with a `newName`.");

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

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

export function createLspRenameTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return tool({
    description:
      "Rename the symbol at the given position across the entire workspace. " +
      "Returns a summary of changes: number of files modified and the list of edited locations.",
    args: {
      filePath: z.string().describe("Absolute path to the file"),
      line: z.number().int().min(0).describe("0-based line number"),
      character: z.number().int().min(0).describe("0-based character offset"),
      newName: z.string().min(1).describe("The new name for the symbol"),
    },
    async execute(input) {
      try {
        const languageId = extractLanguageId(input.filePath);

        if (!checkCapability(languageId, clientManager, "textDocument.rename")) {
          return capabilityNotSupported("rename");
        }

        await ensureSynced(input.filePath, docManager, clientManager, languageId);

        const edit = await clientManager.request<WorkspaceEdit | null>(
          "textDocument/rename",
          {
            textDocument: { uri: docManager.getUri(input.filePath) },
            position: { line: input.line, character: input.character },
            newName: input.newName,
          },
          languageId,
        );

        if (!edit) {
          return "No rename edits returned. The symbol may not be renameable at this position.";
        }

        return formatWorkspaceEdit(edit, input.newName);
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
// Formatting helpers
// ---------------------------------------------------------------------------

function formatWorkspaceEdit(edit: WorkspaceEdit, newName: string): string {
  const lines: string[] = [];
  let totalFiles = 0;
  let totalEdits = 0;

  if (edit.changes) {
    const fileUris = Object.keys(edit.changes);
    totalFiles = fileUris.length;

    lines.push(`## Rename to \`${newName}\``);
    lines.push("");
    lines.push(`**Files modified:** ${totalFiles}`);
    lines.push("");

    for (const uri of fileUris) {
      const edits = edit.changes[uri];
      if (!edits || edits.length === 0) continue;
      totalEdits += edits.length;

      lines.push(`### \`${uri}\` (${edits.length} changes)`);
      lines.push("");

      for (const te of edits) {
        const oldText = extractOldText(uri, te);
        if (oldText) {
          lines.push(`- \`${formatRange(te.range)}\`: \`${oldText}\` → \`${te.newText}\``);
        } else {
          lines.push(`- \`${formatRange(te.range)}\`: → \`${te.newText}\``);
        }
      }
      lines.push("");
    }
  }

  if (edit.documentChanges && edit.documentChanges.length > 0) {
    // documentChanges can be complex — provide summary
    lines.push("**Note:** This rename includes `documentChanges` which cannot be fully previewed here.");
  }

  if (totalEdits === 0) {
    return "No edits were generated by the rename operation.";
  }

  lines.push(`**Total:** ${totalEdits} edits across ${totalFiles} files.`);

  return lines.join("\n");
}

function extractOldText(uri: string, te: TextEdit): string | null {
  try {
    const filePath = uri.replace(/^file:\/\//, "");
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const startLine = lines[te.range.start.line] ?? "";
    return startLine.slice(te.range.start.character, te.range.end.character) || null;
  } catch {
    return null;
  }
}
