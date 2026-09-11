import { defineTool } from "../../platform/ports/tool-factory.ts";
import { z } from "zod";
import type { LspClientManager } from "../client-manager.ts";
import type { LspDocumentManager } from "../document-manager.ts";
import type { Hover, MarkupContent, MarkedString, SignatureHelp } from "../types.ts";
import {
  extractLanguageId,
  ensureSynced,
  checkCapability,
  capabilityNotSupported,
} from "./utils.ts";

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

export function createLspHoverTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return defineTool({
    description:
      "Get hover information (type signature, documentation, etc.) for the symbol at the given position.",
    args: {
      filePath: z.string().describe("Absolute path to the file"),
      line: z.number().int().min(0).describe("0-based line number"),
      character: z.number().int().min(0).describe("0-based character offset"),
    },
    async execute(input) {
      try {
        const languageId = extractLanguageId(input.filePath);

        if (!checkCapability(languageId, clientManager, "hoverProvider")) {
          return capabilityNotSupported("hover");
        }

        await ensureSynced(input.filePath, docManager, clientManager, languageId);

        const result = await clientManager.request<Hover | null>(
          "textDocument/hover",
          {
            textDocument: { uri: docManager.getUri(input.filePath) },
            position: { line: input.line, character: input.character },
          },
          languageId,
        );

        if (!result || !result.contents) {
          return "No hover information available at this position.";
        }

        const lines: string[] = [];
        lines.push("## Hover");
        lines.push("");

        const content = formatHoverContents(result.contents);
        lines.push(content);

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

function formatHoverContents(contents: Hover["contents"]): string {
  // MarkupContent
  if (typeof contents === "object" && contents !== null && "kind" in contents && "value" in contents) {
    const mc = contents as MarkupContent;
    if (mc.kind === "markdown") {
      return mc.value;
    }
    return "```\n" + mc.value + "\n```";
  }

  // Single MarkedString (plain string)
  if (typeof contents === "string") {
    return "```\n" + contents + "\n```";
  }

  // Single MarkedString ({ language, value })
  if (typeof contents === "object" && contents !== null && "language" in contents) {
    const ms = contents as { language: string; value: string };
    return "```" + ms.language + "\n" + ms.value + "\n```";
  }

  // MarkedString[]
  if (Array.isArray(contents)) {
    const parts: string[] = [];
    for (const item of contents) {
      if (typeof item === "string") {
        parts.push("```\n" + item + "\n```");
      } else if (item && typeof item === "object" && "language" in item) {
        const ms = item as { language: string; value: string };
        parts.push("```" + ms.language + "\n" + ms.value + "\n```");
      }
    }
    return parts.join("\n\n");
  }

  return "```\n" + String(contents) + "\n```";
}

// ---------------------------------------------------------------------------
// Signature Help
// ---------------------------------------------------------------------------

export function createLspSignatureHelpTool(
  clientManager: LspClientManager,
  docManager: LspDocumentManager,
) {
  return defineTool({
    description:
      "Get signature help (function/method signature, parameter info) at the given position. " +
      "Useful when inside a function call's parentheses.",
    args: {
      filePath: z.string().describe("Absolute path to the file"),
      line: z.number().int().min(0).describe("0-based line number"),
      character: z.number().int().min(0).describe("0-based character offset"),
    },
    async execute(input) {
      try {
        const languageId = extractLanguageId(input.filePath);

        if (!checkCapability(languageId, clientManager, "signatureHelpProvider")) {
          return capabilityNotSupported("signature help");
        }

        await ensureSynced(input.filePath, docManager, clientManager, languageId);

        const result = await clientManager.request<SignatureHelp | null>(
          "textDocument/signatureHelp",
          {
            textDocument: { uri: docManager.getUri(input.filePath) },
            position: { line: input.line, character: input.character },
          },
          languageId,
        );

        if (!result || !result.signatures || result.signatures.length === 0) {
          return "No signature help available at this position.";
        }

        return formatSignatureHelp(result);
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

function formatSignatureHelp(help: SignatureHelp): string {
  const lines: string[] = [];
  lines.push("## Signature Help");
  lines.push("");

  const activeSigIndex = help.activeSignature ?? 0;
  const activeParamIndex = help.activeParameter ?? 0;

  for (let si = 0; si < help.signatures.length; si++) {
    const sig = help.signatures[si];
    const isActive = si === activeSigIndex;

    if (isActive) {
      lines.push(`### ▶ Active Signature (${si + 1}/${help.signatures.length})`);
    } else {
      lines.push(`### Signature ${si + 1}/${help.signatures.length}`);
    }
    lines.push("");

    // Show the signature label with active parameter highlighted
    let label = sig.label;

    // Try to highlight the active parameter within the label
    if (isActive && sig.parameters && sig.parameters.length > 0) {
      const activeParam = sig.parameters[activeParamIndex];
      if (activeParam && typeof activeParam.label === "string") {
        const paramLabel = activeParam.label;
        const idx = label.indexOf(paramLabel);
        if (idx >= 0) {
          label =
            label.slice(0, idx) +
            "**" + paramLabel + "**" +
            label.slice(idx + paramLabel.length);
        }
      }
    }

    lines.push("```");
    lines.push(label);
    lines.push("```");
    lines.push("");

    // Documentation for the signature
    if (sig.documentation) {
      const docs = typeof sig.documentation === "string"
        ? sig.documentation
        : (sig.documentation as MarkupContent).value;
      lines.push(docs);
      lines.push("");
    }

    // Parameters
    if (sig.parameters && sig.parameters.length > 0) {
      lines.push("**Parameters:**");
      for (let pi = 0; pi < sig.parameters.length; pi++) {
        const param = sig.parameters[pi];
        const isActiveParam = isActive && pi === activeParamIndex;
        const marker = isActiveParam ? "▶ " : "  ";
        const paramName = typeof param.label === "string" ? param.label : `Parameter ${pi + 1}`;
        let paramLine = `${marker}- \`${paramName}\``;
        if (param.documentation) {
          const docs = typeof param.documentation === "string"
            ? param.documentation
            : (param.documentation as MarkupContent).value;
          paramLine += ` — ${docs}`;
        }
        lines.push(paramLine);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
