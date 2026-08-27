/**
 * Strip the Leading PREFIX pattern "LINE#HASH|" from a line if present.
 * Matches patterns like "42#aB3|content".
 * Hash width range is {2,8} (D4) so width-5..8 anchors are stripped too.
 */
const LINE_HASH_PREFIX_PATTERN = /^\d+#[A-Za-z0-9_-]{2,8}\|/;

/**
 * Full literal prefix form with the prefixed content captured.
 * Echo stripping (D4) requires a new line to literally carry the
 * "LINE#HASH|content" form AND for that content to equal the anchor/boundary
 * line. A bare content line that merely equals the anchor (e.g. consecutive
 * "}") is never an echo.
 */
const LINE_HASH_PREFIX_FULL_PATTERN = /^\d+#[A-Za-z0-9_-]{2,8}\|(.*)$/;

/**
 * Convert a string or string[] into a string[].
 * Multi-line strings are split by \n.
 *
 * D5 deletion semantics: empty content ("" or []) becomes [] — a replace
 * with empty content therefore deletes its target line/range (the splice in
 * applyReplaceSingle/applyReplaceRange spreads zero new lines), while the
 * append/prepend no-op guards (newLines.length === 0) keep "" a no-op there.
 * Pass [""] explicitly to insert a single empty line.
 */
export function toNewLines(input: string | string[]): string[] {
  if (Array.isArray(input)) {
    return input.length === 0 ? [] : input;
  }
  if (input === "") {
    return [];
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
 * The model sometimes echoes the anchor line at the start of the replacement
 * in literal annotated-hashline form ("LINE#HASH|anchor"). D4: strips ONLY
 * when the first new line literally matches the prefix form and its prefixed
 * content equals the anchor line — a bare content line that merely equals the
 * anchor (e.g. consecutive "}") is never stripped.
 */
export function stripInsertAnchorEcho(
  anchorLine: string,
  newLines: string[]
): string[] {
  if (newLines.length === 0) return newLines;
  const match = newLines[0].match(LINE_HASH_PREFIX_FULL_PATTERN);
  if (match !== null && match[1] === anchorLine) {
    return newLines.slice(1);
  }
  return newLines;
}

/**
 * Strip anchor echo from insert-before (prepend) operations.
 * The model sometimes echoes the anchor line at the end of the replacement
 * in literal annotated-hashline form ("LINE#HASH|anchor"). D4: strips ONLY
 * when the last new line literally matches the prefix form and its prefixed
 * content equals the anchor line — a bare content line that merely equals the
 * anchor is never stripped.
 */
export function stripInsertBeforeEcho(
  anchorLine: string,
  newLines: string[]
): string[] {
  if (newLines.length === 0) return newLines;
  const lastIdx = newLines.length - 1;
  const match = newLines[lastIdx].match(LINE_HASH_PREFIX_FULL_PATTERN);
  if (match !== null && match[1] === anchorLine) {
    return newLines.slice(0, -1);
  }
  return newLines;
}

/**
 * Strip range boundary echo from replace-range operations.
 * The model sometimes includes the boundary lines from the original range
 * in the replacement content in literal annotated-hashline form. D4: strips
 * ONLY when the boundary new line literally matches the prefix form and its
 * prefixed content equals the boundary line — a bare content line that merely
 * equals the boundary (e.g. re-using the old start line as new content) is
 * never stripped.
 *
 * Detects:
 *   - First line of newLines is "LINE#HASH|lines[startLine-1]" → strip from start
 *   - Last line of newLines is "LINE#HASH|lines[endLine-1]" → strip from end
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
    const match = result[0].match(LINE_HASH_PREFIX_FULL_PATTERN);
    if (match !== null && match[1] === lines[startIdx]) {
      result = result.slice(1);
    }
  }

  if (result.length === 0) return result;

  // Check last line against end boundary
  const endIdx = endLine - 1;
  if (endIdx >= 0 && endIdx < lines.length) {
    const lastIdx = result.length - 1;
    const match = result[lastIdx].match(LINE_HASH_PREFIX_FULL_PATTERN);
    if (match !== null && match[1] === lines[endIdx]) {
      result = result.slice(0, -1);
    }
  }

  return result;
}
