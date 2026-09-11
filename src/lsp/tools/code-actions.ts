// ---------------------------------------------------------------------------
// LSP Code Action Tools — lsp_code_actions, lsp_execute_code_action
// ---------------------------------------------------------------------------

import { defineTool } from "../../platform/ports/tool-factory.ts";
import { z } from "zod";
import { readFileSync, writeFileSync } from "node:fs";
import type { LspClientManager } from "../client-manager.ts";
import type { LspDocumentManager } from "../document-manager.ts";
import {
  ensureSynced,
  extractLanguageId,
  fileUri,
  formatRange,
} from "./utils.ts";
import { positionToOffset } from "../position.ts";
import type { CodeAction, TextEdit } from "../types.ts";

/**
 * Apply an array of TextEdits to a file's content in reverse offset order.
 */
function applyTextEdits(content: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => {
    const aStart = positionToOffset(content, a.range.start);
    const bStart = positionToOffset(content, b.range.start);
    // Sort descending so earlier edits don't shift later offsets
    if (bStart !== aStart) return bStart - aStart;
    const aEnd = positionToOffset(content, a.range.end);
    const bEnd = positionToOffset(content, b.range.end);
    return bEnd - aEnd;
  });

  for (const edit of sorted) {
    const start = positionToOffset(content, edit.range.start);
    const end = positionToOffset(content, edit.range.end);
    content = content.slice(0, start) + edit.newText + content.slice(end);
  }
  return content;
}

export function createLspCodeActionsTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return defineTool({
    description:
      "Retrieve available code actions (quick fixes, refactorings) for a given range in a file. " +
      "Optionally filter by action kind (e.g. 'quickfix', 'refactor', 'refactor.extract', 'source.organizeImports').",
    args: {
      filePath: z.string().describe("Absolute path to the file"),
      startLine: z
        .number()
        .int()
        .min(0)
        .describe("Start line (0-based) of the range"),
      startChar: z
        .number()
        .int()
        .min(0)
        .describe("Start character (0-based) of the range"),
      endLine: z
        .number()
        .int()
        .min(0)
        .describe("End line (0-based) of the range"),
      endChar: z
        .number()
        .int()
        .min(0)
        .describe("End character (0-based) of the range"),
      kind: z
        .string()
        .optional()
        .describe(
          "Optional filter — only return actions matching this kind prefix (e.g. 'quickfix', 'refactor')",
        ),
    },
    async execute(input) {
      try {
        const filePath = input.filePath;
        const languageId = extractLanguageId(filePath);

        // Check capability
        const caps = clientManager.getServerCapabilities(languageId);
        if (!caps || !caps.codeActionProvider) {
          return "This language server does not support code actions.";
        }

        await ensureSynced(filePath, docManager, clientManager, languageId);

        const uri = fileUri(filePath);

        // Get diagnostics for context
        const diagnostics = clientManager.getDiagnostics(uri);
        // Filter diagnostics to those overlapping the requested range
        const rangeDiags = diagnostics.filter((d) => {
          const dStart = d.range.start;
          const dEnd = d.range.end;
          const rStartLine = input.startLine;
          const rStartChar = input.startChar;
          const rEndLine = input.endLine;
          const rEndChar = input.endChar;
          // Overlap check: diagnostic range intersects requested range
          const endsBefore =
            dEnd.line < rStartLine ||
            (dEnd.line === rStartLine && dEnd.character <= rStartChar);
          const startsAfter =
            dStart.line > rEndLine ||
            (dStart.line === rEndLine && dStart.character >= rEndChar);
          return !endsBefore && !startsAfter;
        });

        const result = await clientManager.request<CodeAction[]>(
          "textDocument/codeAction",
          {
            textDocument: { uri },
            range: {
              start: { line: input.startLine, character: input.startChar },
              end: { line: input.endLine, character: input.endChar },
            },
            context: {
              diagnostics: rangeDiags.map((d) => ({
                range: d.range,
                severity: d.severity,
                message: d.message,
              })),
            },
          },
          languageId,
        );

        if (!result || result.length === 0) {
          return "No code actions available for the specified range.";
        }

        let actions = result;
        if (input.kind) {
          actions = actions.filter((a) => a.kind?.startsWith(input.kind!));
          if (actions.length === 0) {
            return `No code actions found matching kind filter: '${input.kind}'.`;
          }
        }

        const lines = actions.map((a, i) => {
          const preferred = a.isPreferred ? " ★" : "";
          const kindStr = a.kind ? ` (${a.kind})` : "";
          return `${i + 1}. **${a.title}**${kindStr}${preferred}`;
        });

        return `## Code Actions (${actions.length})\n\n${lines.join("\n")}`;
      } catch (err: any) {
        return `Error retrieving code actions: ${err.message ?? String(err)}`;
      }
    },
  });
}

export function createLspExecuteCodeActionTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return defineTool({
    description:
      "Execute a code action by title for a given range. Applies workspace edits or executes commands. " +
      "Returns a summary of changes made to files.",
    args: {
      filePath: z.string().describe("Absolute path to the file"),
      startLine: z
        .number()
        .int()
        .min(0)
        .describe("Start line (0-based) of the range"),
      startChar: z
        .number()
        .int()
        .min(0)
        .describe("Start character (0-based) of the range"),
      endLine: z
        .number()
        .int()
        .min(0)
        .describe("End line (0-based) of the range"),
      endChar: z
        .number()
        .int()
        .min(0)
        .describe("End character (0-based) of the range"),
      title: z
        .string()
        .describe("Title of the code action to execute (fuzzy match)"),
    },
    async execute(input) {
      try {
        const filePath = input.filePath;
        const languageId = extractLanguageId(filePath);

        const caps = clientManager.getServerCapabilities(languageId);
        if (!caps || !caps.codeActionProvider) {
          return "This language server does not support code actions.";
        }

        await ensureSynced(filePath, docManager, clientManager, languageId);

        const uri = fileUri(filePath);
        const diagnostics = clientManager.getDiagnostics(uri);

        const result = await clientManager.request<CodeAction[]>(
          "textDocument/codeAction",
          {
            textDocument: { uri },
            range: {
              start: { line: input.startLine, character: input.startChar },
              end: { line: input.endLine, character: input.endChar },
            },
            context: {
              diagnostics: diagnostics.map((d) => ({
                range: d.range,
                severity: d.severity,
                message: d.message,
              })),
            },
          },
          languageId,
        );

        if (!result || result.length === 0) {
          return "No code actions available for the specified range.";
        }

        // Find matching action (case-insensitive substring match)
        const action = result.find(
          (a) => a.title.toLowerCase().includes(input.title.toLowerCase()),
        );
        if (!action) {
          const titles = result.map((a) => `  - "${a.title}"`).join("\n");
          return `No code action found matching title "${input.title}". Available actions:\n${titles}`;
        }

        const changes: string[] = [];

        // Apply workspace edit if present
        if (action.edit) {
          if (action.edit.documentChanges) {
            for (const change of action.edit.documentChanges) {
              const docChange = change as any;
              if (docChange.textDocument && docChange.edits) {
                const editUri = docChange.textDocument.uri;
                const editPath = editUri.startsWith("file://")
                  ? decodeURIComponent(editUri.slice(7))
                  : editUri;
                try {
                  const content = readFileSync(editPath, "utf-8");
                  const newContent = applyTextEdits(
                    content,
                    docChange.edits as TextEdit[],
                  );
                  writeFileSync(editPath, newContent, "utf-8");
                  changes.push(
                    `  - ${editPath}: ${docChange.edits.length} edit(s) applied`,
                  );
                } catch {
                  changes.push(
                    `  - ${editPath}: failed to apply edits (file may not exist)`,
                  );
                }
              }
            }
          } else if (action.edit.changes) {
            for (const [editUri, edits] of Object.entries(
              action.edit.changes,
            )) {
              const editPath = editUri.startsWith("file://")
                ? decodeURIComponent(editUri.slice(7))
                : editUri;
              try {
                const content = readFileSync(editPath, "utf-8");
                const newContent = applyTextEdits(content, edits);
                writeFileSync(editPath, newContent, "utf-8");
                changes.push(
                  `  - ${editPath}: ${edits.length} edit(s) applied`,
                );
              } catch {
                changes.push(
                  `  - ${editPath}: failed to apply edits (file may not exist)`,
                );
              }
            }
          }
        }

        // Execute command if present
        if (action.command) {
          try {
            await clientManager.request(
              "workspace/executeCommand",
              {
                command: action.command.command,
                arguments: action.command.arguments ?? [],
              },
              languageId,
            );
            changes.push(
              `  - Command executed: ${action.command.command}`,
            );
          } catch (err: any) {
            changes.push(
              `  - Command failed: ${action.command.command} — ${err.message ?? String(err)}`,
            );
          }
        }

        // Sync modified files
        if (action.edit) {
          const filesToSync = new Set<string>();
          if (action.edit.documentChanges) {
            for (const change of action.edit.documentChanges) {
              const docChange = change as any;
              if (docChange.textDocument) {
                const editUri = docChange.textDocument.uri;
                const editPath = editUri.startsWith("file://")
                  ? decodeURIComponent(editUri.slice(7))
                  : editUri;
                filesToSync.add(editPath);
              }
            }
          } else if (action.edit.changes) {
            for (const editUri of Object.keys(action.edit.changes)) {
              const editPath = editUri.startsWith("file://")
                ? decodeURIComponent(editUri.slice(7))
                : editUri;
              filesToSync.add(editPath);
            }
          }
          for (const f of filesToSync) {
            try {
              const lang = extractLanguageId(f);
              await ensureSynced(f, docManager, clientManager, lang);
            } catch {
              // Best-effort sync
            }
          }
        }

        if (changes.length === 0) {
          return `Code action "${action.title}" executed but produced no changes.`;
        }

        return [
          `## Code Action: "${action.title}"`,
          `Kind: ${action.kind || "N/A"}`,
          "",
          "### Changes",
          ...changes,
        ].join("\n");
      } catch (err: any) {
        return `Error executing code action: ${err.message ?? String(err)}`;
      }
    },
  });
}
