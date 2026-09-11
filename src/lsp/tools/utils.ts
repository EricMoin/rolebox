import { existsSync } from "node:fs";
import path from "node:path";
import { getLanguageIdFromExtension } from "../servers.ts";
import type { LspClientManager } from "../client-manager.ts";
import type { LspDocumentManager } from "../document-manager.ts";
import type { Location, Range } from "../types.ts";

// ---------------------------------------------------------------------------
// Language ID
// ---------------------------------------------------------------------------

/**
 * Resolve language ID from a file path. Throws if the extension is unsupported.
 */
export function extractLanguageId(filePath: string): string {
  const langId = getLanguageIdFromExtension(filePath);
  if (!langId) {
    const ext = path.extname(filePath);
    throw new Error(`No language server configured for file type: ${ext || "(no extension)"}`);
  }
  return langId;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a Location as a markdown link: `file://path Lstart:col-end:col`
 */
export function formatLocation(loc: Location): string {
  return `${loc.uri} ${formatRange(loc.range)}`;
}

/**
 * Format a Range as `L{line}:{char}-L{line}:{char}` (0-based).
 */
export function formatRange(range: Range): string {
  return `L${range.start.line}:${range.start.character}-L${range.end.line}:${range.end.character}`;
}

/**
 * Map DiagnosticSeverity number to human-readable label.
 */
export function formatSeverity(severity: number): string {
  switch (severity) {
    case 1: return "Error";
    case 2: return "Warning";
    case 3: return "Information";
    case 4: return "Hint";
    default: return `Unknown(${severity})`;
  }
}

/**
 * Map SymbolKind number to human-readable name.
 */
export function formatSymbolKind(kind: number): string {
  const names: Record<number, string> = {
    1: "File",
    2: "Module",
    3: "Namespace",
    4: "Package",
    5: "Class",
    6: "Method",
    7: "Property",
    8: "Field",
    9: "Constructor",
    10: "Enum",
    11: "Interface",
    12: "Function",
    13: "Variable",
    14: "Constant",
    15: "String",
    16: "Number",
    17: "Boolean",
    18: "Array",
    19: "Object",
    20: "Key",
    21: "Null",
    22: "EnumMember",
    23: "Struct",
    24: "Event",
    25: "Operator",
    26: "TypeParameter",
  };
  return names[kind] ?? `SymbolKind(${kind})`;
}

/**
 * Map CompletionItemKind number to human-readable name.
 */
export function formatCompletionKind(kind: number): string {
  const names: Record<number, string> = {
    1: "Text",
    2: "Method",
    3: "Function",
    4: "Constructor",
    5: "Field",
    6: "Variable",
    7: "Class",
    8: "Interface",
    9: "Module",
    10: "Property",
    11: "Unit",
    12: "Value",
    13: "Enum",
    14: "Keyword",
    15: "Snippet",
    16: "Color",
    17: "File",
    18: "Reference",
    19: "Folder",
    20: "EnumMember",
    21: "Constant",
    22: "Struct",
    23: "Event",
    24: "Operator",
    25: "TypeParameter",
  };
  return names[kind] ?? `CompletionKind(${kind})`;
}

/**
 * Map DocumentHighlightKind number to human-readable label.
 */
export function formatDocumentHighlightKind(kind: number): string {
  switch (kind) {
    case 1: return "Text";
    case 2: return "Read";
    case 3: return "Write";
    default: return `Highlight(${kind})`;
  }
}

// ---------------------------------------------------------------------------
// Document sync
// ---------------------------------------------------------------------------

/**
 * Ensure a document is synced with its LSP server. Throws if the file doesn't
 * exist or the language is not supported.
 */
export async function ensureSynced(
  filePath: string,
  docManager: LspDocumentManager,
  client: LspClientManager,
  languageId: string,
): Promise<void> {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  await docManager.sync(filePath, client, languageId);
}

// ---------------------------------------------------------------------------
// URI helpers
// ---------------------------------------------------------------------------

/**
 * Convert an absolute file path to a `file://` URI.
 */
export function fileUri(filePath: string): string {
  const absolute = path.resolve(filePath);
  const encoded = absolute
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  if (path.sep === "\\") {
    return `file:///${encoded}`;
  }
  return `file://${encoded}`;
}

// ---------------------------------------------------------------------------
// Capability checks
// ---------------------------------------------------------------------------

/**
 * Check whether the server for a given language supports a specific
 * capability (e.g. `"textDocument.typeDefinition"`). Returns true if
 * the capability value is truthy.
 */
export function checkCapability(
  languageId: string,
  client: LspClientManager,
  capabilityPath: string,
): boolean {
  const caps = client.getServerCapabilities(languageId);
  if (!caps) return false;

  const parts = capabilityPath.split(".");
  let current: any = caps;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return false;
    current = current[part];
  }
  return current != null && current !== false;
}

/**
 * Build a standard error message for an unsupported capability.
 */
export function capabilityNotSupported(feature: string): string {
  return `This language server does not support ${feature}.`;
}
