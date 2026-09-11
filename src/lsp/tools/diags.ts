import { defineTool } from "../../platform/ports/tool-factory.ts";
import { z } from "zod";
import type { LspClientManager } from "../client-manager.ts";
import type { LspDocumentManager } from "../document-manager.ts";
import type { Diagnostic } from "../types.ts";
import { extractLanguageId, ensureSynced, fileUri, formatSeverity } from "./utils.ts";

export function createLspDiagnosticsTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return defineTool({
    description:
      "Get diagnostics (errors, warnings, hints) for a file or across all open documents. " +
      "Optionally filter by severity level.",
    args: {
      filePath: z
        .string()
        .optional()
        .describe("Absolute path to the file (omit to aggregate across all open documents)"),
      severity: z
        .enum(["error", "warning", "information", "hint", "all"])
        .optional()
        .default("all")
        .describe("Filter by minimum severity level"),
    },
    async execute(input) {
      try {
        if (input.filePath) {
          return await getFileDiagnostics(input.filePath, input.severity ?? "all", clientManager, docManager);
        }
        return getAllDiagnostics(input.severity ?? "all", clientManager);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}

async function getFileDiagnostics(
  filePath: string,
  severity: string,
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
): Promise<string> {
  const languageId = extractLanguageId(filePath);
  await ensureSynced(filePath, docManager, clientManager, languageId);

  const uri = fileUri(filePath);
  const diags = clientManager.getDiagnostics(uri);

  return formatDiagnosticsTable(uri, diags, severity);
}

function getAllDiagnostics(
  severity: string,
  clientManager: LspClientManager,
): string {
  const all = clientManager.getAllDiagnostics();
  if (all.size === 0) {
    return "No diagnostics found.";
  }

  const sections: string[] = [];
  for (const [uri, diags] of all) {
    const formatted = formatDiagnosticsTable(uri, diags, severity);
    sections.push(formatted);
  }

  return sections.join("\n\n");
}

function formatDiagnosticsTable(uri: string, diags: Diagnostic[], severity: string): string {
  const filtered = filterBySeverity(diags, severity);
  if (filtered.length === 0) {
    return `No diagnostics found for \`${uri}\`.`;
  }

  const lines: string[] = [];
  lines.push(`## Diagnostics: \`${uri}\``);
  lines.push("");
  lines.push("| File | Line | Severity | Message | Source |");
  lines.push("|------|------|----------|---------|--------|");

  for (const d of filtered) {
    const line = d.range.start.line;
    const sev = formatSeverity(d.severity ?? 0);
    const message = d.message.replace(/\|/g, "\\|").replace(/\n/g, " ");
    const source = d.source ?? "";
    lines.push(`| \`${uri}\` | ${line} | ${sev} | ${message} | ${source} |`);
  }

  return lines.join("\n");
}

function filterBySeverity(diags: Diagnostic[], severity: string): Diagnostic[] {
  if (severity === "all") return diags;

  const severityMap: Record<string, number> = {
    error: 1,
    warning: 2,
    information: 3,
    hint: 4,
  };

  const minLevel = severityMap[severity];
  if (minLevel === undefined) return diags;

  return diags.filter((d) => (d.severity ?? 4) <= minLevel);
}
