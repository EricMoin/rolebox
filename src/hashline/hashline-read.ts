import { readFile } from "node:fs/promises";
import { defineTool } from "../platform/ports/tool-factory.ts";
import { z } from "zod";
import { canonicalizeFileText, computeFileVersion, computeLineHash, hashWidthForLineCount, formatHashLine } from "./hash.ts";

export function createHashlineReadTool() {
  return defineTool({
    description:
      "Read a file and return each line annotated with a content-based hash anchor (LINE#HASH|content).\n" +
      "Always use this tool before editing with hashline edit tools:\n" +
      "1. Always read first — copy the `version` and `LINE#HASH` anchors exactly\n" +
      "2. Use windowed reads (offset/limit) for large files to save tokens\n" +
      "3. Lines longer than 2000 characters may be truncated in display\n" +
      "\n" +
      "Returns:\n" +
      "  version: <sha256 hex>    — whole-file version for integrity checks\n" +
      "  hashWidth: <number>       — auto-escalated based on total line count\n" +
      "  totalLines: <number>      — total lines in the file\n" +
      "  [startLine: <number>]     — present for windowed reads\n" +
      "  [endLine: <number>]       — present for windowed reads\n" +
      "  LINE#HASH|content         — one annotated line per line of output",
    args: {
      filePath: z.string().describe("Absolute path to the file to read"),
      offset: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("1-based start line (optional — omit for full read)"),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Maximum number of lines to return (optional — omit for full read)"),
    },
    async execute(input) {
      try {
        const raw = await readFile(input.filePath, "utf-8");
        return formatReadOutput(raw, input.filePath, input.offset, input.limit);
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return `Error: File not found: ${input.filePath}`;
        }
        return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}

/**
 * Parse canonical content and produce the annotated read output string.
 * Exported for testing.
 */
export function formatReadOutput(
  rawContent: string,
  filePath: string,
  offset?: number,
  limit?: number,
): string {
  const envelope = canonicalizeFileText(rawContent);
  const content = envelope.content;

  // Compute version from canonical content
  const version = computeFileVersion(content);

  // Split into lines, stripping trailing newline to avoid empty trailing element
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
  const allLines = normalized === "" ? [] : normalized.split("\n");

  // If the file ends with a trailing newline, the last element after split
  // is an empty string — that's a valid empty trailing line. Keep it.
  // But if the file is empty or has a single newline, handle correctly.
  const totalLines = allLines.length;

  const hashWidth = hashWidthForLineCount(totalLines);

  const lines: string[] = [];
  const result: string[] = [];

  // Header
  result.push(`version: ${version}`);
  result.push(`hashWidth: ${hashWidth}`);
  result.push(`totalLines: ${totalLines}`);

  // Determine window
  const effectiveStart = offset ?? 1;
  const effectiveEnd = limit
    ? Math.min(effectiveStart + limit - 1, totalLines)
    : totalLines;

  if (totalLines === 0) {
    // Empty file — no annotated lines
    return result.join("\n");
  }

  if (offset !== undefined || limit !== undefined) {
    result.push(`startLine: ${effectiveStart}`);
    result.push(`endLine: ${effectiveEnd}`);
  }

  // Annotate lines within the window
  // Lines exceeding 2000 chars get display-only truncation to match the documented
  // contract. Hash is computed from the ORIGINAL full content so anchors are stable.
  for (let i = effectiveStart; i <= effectiveEnd; i++) {
    const lineContent = allLines[i - 1] ?? "";
    const displayContent =
      lineContent.length > 2000
        ? lineContent.slice(0, 1997) + "..."
        : lineContent;
    const hash = computeLineHash(lineContent, hashWidth, i);
    result.push(`${i}#${hash}|${displayContent}`);
  }

  return result.join("\n");
}
