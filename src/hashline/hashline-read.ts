import { readFile } from "node:fs/promises";
import { defineTool } from "../platform/ports/tool-factory.ts";
import { z } from "zod";
import { computeLineHash, hashWidthForLineCount } from "./hash.ts";
import { resolveHashlinePath } from "./path-resolve.ts";
import { createReadSnapshot, findReadLineStart, HashlineReadCache, type ReadSnapshot } from "./read-cache.ts";

export function createHashlineReadTool() {
  const cache = new HashlineReadCache();
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
      filePath: z
        .string()
        .describe(
          "Path to the file to read. Relative paths resolve against the session working directory.",
        ),
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
    async execute(input, context) {
      const filePath = resolveHashlinePath(input.filePath, context);
      try {
        const raw = cache.has(filePath)
          ? await readFile(filePath, "utf-8")
          : await readFile(filePath);
        return formatSnapshot(cache.get(filePath, raw), input.offset, input.limit);
      } catch (err: unknown) {
        cache.delete(filePath);
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return `Error: File not found: ${filePath}`;
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
  return formatSnapshot(createReadSnapshot(rawContent), offset, limit);
}

function formatSnapshot(snapshot: ReadSnapshot, offset?: number, limit?: number): string {
  const { content, version, totalLines } = snapshot;
  const hashWidth = hashWidthForLineCount(totalLines);

  const result: string[] = [];

  // Header
  result.push(`version: ${version}`);
  result.push(`hashWidth: ${hashWidth}`);
  result.push(`totalLines: ${totalLines}`);

  // Determine window. Clamp the start so offset > totalLines cannot produce
  // endLine < startLine with zero annotated lines (D9).
  const effectiveStart = totalLines > 0 ? Math.min(offset ?? 1, totalLines) : 1;
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
  let lineStart = findReadLineStart(snapshot, effectiveStart);
  for (let i = effectiveStart; i <= effectiveEnd; i++) {
    let lineEnd = content.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = content.length;
    const lineContent = content.slice(lineStart, lineEnd);
    const displayContent =
      lineContent.length > 2000
        ? lineContent.slice(0, 1997) + "..."
        : lineContent;
    const hash = computeLineHash(lineContent, hashWidth, i);
    result.push(`${i}#${hash}|${displayContent}`);
    lineStart = lineEnd + 1;
  }

  return result.join("\n");
}
