/**
 * Strip the Leading PREFIX pattern "LINE#HASH|" from a line if present.
 * Matches patterns like "42#aB3|content".
 */
const LINE_HASH_PREFIX_PATTERN = /^\d+#[A-Za-z0-9_-]{2,4}\|/;

/**
 * Convert a string or string[] into a string[].
 * Multi-line strings are split by \n.
 * Empty content becomes [""] (single empty string).
 */
export function toNewLines(input: string | string[]): string[] {
  if (Array.isArray(input)) {
    return input.length === 0 ? [""] : input;
  }
  if (input === "") {
    return [""];
  }
  return input.split("\n");
}

/**
 * Strip any "LINE#HASH|" prefix from lines if present.
 * The model sometimes includes annotated hashline format in its replacement content.
 */
export function stripLinePrefixes(lines: string[]): string[] {
  return lines.map((line) => line.replace(LINE_HASH_PREFIX_PATTERN, ""));
}

/**
 * If replacementLine lost its leading indent, restore it from templateLine.
 * Only triggers when:
 *   - templateLine has leading whitespace
 *   - replacementLine has NO leading whitespace (but is non-empty)
 */
export function restoreLeadingIndent(
  templateLine: string,
  replacementLine: string
): string {
  const indentMatch = templateLine.match(/^(\s+)/);
  if (!indentMatch) return replacementLine;
  if (replacementLine === "") return replacementLine;
  if (/^\s/.test(replacementLine)) return replacementLine;
  return indentMatch[1] + replacementLine;
}

/**
 * Strip anchor echo from insert-after operations.
 * The model sometimes echoes the anchor line at the start of the replacement.
 * Detects: first line of newLines matches anchorLine (trimmed).
 */
export function stripInsertAnchorEcho(
  anchorLine: string,
  newLines: string[]
): string[] {
  if (newLines.length === 0) return newLines;
  const stripped = newLines[0].replace(LINE_HASH_PREFIX_PATTERN, "");
  if (stripped === anchorLine) {
    return newLines.slice(1);
  }
  return newLines;
}

/**
 * Strip anchor echo from insert-before (prepend) operations.
 * The model sometimes echoes the anchor line at the end of the replacement.
 * Detects: last line of newLines matches anchorLine (trimmed).
 */
export function stripInsertBeforeEcho(
  anchorLine: string,
  newLines: string[]
): string[] {
  if (newLines.length === 0) return newLines;
  const lastIdx = newLines.length - 1;
  const stripped = newLines[lastIdx].replace(LINE_HASH_PREFIX_PATTERN, "");
  if (stripped === anchorLine) {
    return newLines.slice(0, -1);
  }
  return newLines;
}

/**
 * Strip range boundary echo from replace-range operations.
 * The model sometimes includes the boundary lines from the original range
 * in the replacement content.
 *
 * Detects:
 *   - First line of newLines matches lines[startLine-1] → strip from start
 *   - Last line of newLines matches lines[endLine-1] → strip from end
 */
export function stripRangeBoundaryEcho(
  lines: string[],
  startLine: number,
  endLine: number,
  newLines: string[]
): string[] {
  if (newLines.length === 0) return newLines;

  let result = [...newLines];

  // Check first line against start boundary
  const startIdx = startLine - 1;
  if (startIdx >= 0 && startIdx < lines.length) {
    const startContent = lines[startIdx].replace(LINE_HASH_PREFIX_PATTERN, "");
    const firstContent = result[0].replace(LINE_HASH_PREFIX_PATTERN, "");
    if (firstContent === startContent) {
      result = result.slice(1);
    }
  }

  if (result.length === 0) return result;

  // Check last line against end boundary
  const endIdx = endLine - 1;
  if (endIdx >= 0 && endIdx < lines.length) {
    const lastIdx = result.length - 1;
    const endContent = lines[endIdx].replace(LINE_HASH_PREFIX_PATTERN, "");
    const lastContent = result[lastIdx].replace(LINE_HASH_PREFIX_PATTERN, "");
    if (lastContent === endContent) {
      result = result.slice(0, -1);
    }
  }

  return result;
}
