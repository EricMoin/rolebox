import type { EditOp, RawEditOp, ReplaceOp, AppendOp, PrependOp } from "./types.ts";
import { parseLineRef, validateLineRef, validateLineRefs, HashlineMismatchError } from "./validation.ts";
import { toNewLines, stripLinePrefixes, restoreLeadingIndent, stripInsertAnchorEcho, stripInsertBeforeEcho, stripRangeBoundaryEcho } from "./text-normalize.ts";
import { sortEditsBottomUp, deduplicateEdits, detectOverlappingRanges, collectLineRefs, getEditLineNumber } from "./edit-ordering.ts";

/**
 * Normalize raw tool args to typed EditOp[].
 * Defaults op to "replace".
 * Handles null/undefined/empty lines.
 */
export function normalizeEdits(rawEdits: RawEditOp[]): EditOp[] {
  return rawEdits.map((raw) => {
    const op = raw.op ?? "replace";
    const lines = raw.lines != null ? raw.lines : "";

    switch (op) {
      case "replace":
        return { op: "replace", pos: raw.pos ?? "", end: raw.end, lines } as ReplaceOp;
      case "append":
        return { op: "append", pos: raw.pos, lines } as AppendOp;
      case "prepend":
        return { op: "prepend", pos: raw.pos, lines } as PrependOp;
      default:
        // Default to replace if op is somehow invalid
        return { op: "replace", pos: raw.pos ?? "", end: raw.end, lines } as ReplaceOp;
    }
  });
}

/**
 * Apply a replace operation targeting a single line at the given anchor.
 */
export function applyReplaceSingle(
  lines: string[],
  anchor: string,
  newText: string | string[],
  hashWidth: number
): string[] {
  const parsed = parseLineRef(anchor);
  const lineIndex = parsed.line - 1;

  validateLineRef(lines, anchor, hashWidth);
  let newLines = toNewLines(newText);
  newLines = stripLinePrefixes(newLines);

  // Restore leading indent for the first replacement line
  if (newLines.length > 0 && lines[lineIndex] !== undefined) {
    newLines[0] = restoreLeadingIndent(lines[lineIndex], newLines[0]);
  }

  const result = [...lines];
  result.splice(lineIndex, 1, ...newLines);
  return result;
}

/**
 * Apply a replace operation targeting an inclusive range [startAnchor, endAnchor].
 */
export function applyReplaceRange(
  lines: string[],
  startAnchor: string,
  endAnchor: string,
  newText: string | string[],
  hashWidth: number
): string[] {
  const startParsed = parseLineRef(startAnchor);
  const endParsed = parseLineRef(endAnchor);
  const startIndex = startParsed.line - 1;
  const endIndex = endParsed.line - 1;

  if (startIndex > endIndex) {
    throw new Error(
      `Invalid replace range: start line ${startParsed.line} > end line ${endParsed.line}`
    );
  }

  // Validate both anchors
  validateLineRef(lines, startAnchor, hashWidth);
  validateLineRef(lines, endAnchor, hashWidth);

  let newLines = toNewLines(newText);
  newLines = stripLinePrefixes(newLines);
  newLines = stripRangeBoundaryEcho(lines, startParsed.line, endParsed.line, newLines);

  // Restore leading indent for first replacement line
  if (newLines.length > 0 && lines[startIndex] !== undefined) {
    newLines[0] = restoreLeadingIndent(lines[startIndex], newLines[0]);
  }

  const rangeLen = endIndex - startIndex + 1;
  const result = [...lines];
  result.splice(startIndex, rangeLen, ...newLines);
  return result;
}

/**
 * Insert new lines after the anchor line.
 */
export function applyInsertAfter(
  lines: string[],
  anchor: string,
  text: string | string[],
  hashWidth: number
): string[] {
  const parsed = parseLineRef(anchor);
  const lineIndex = parsed.line - 1;

  validateLineRef(lines, anchor, hashWidth);

  let newLines = toNewLines(text);
  if (newLines.length === 0 || (newLines.length === 1 && newLines[0] === "")) {
    return lines; // noop
  }
  newLines = stripLinePrefixes(newLines);
  newLines = stripInsertAnchorEcho(lines[lineIndex], newLines);

  if (newLines.length === 0) return lines; // became noop after echo strip

  const result = [...lines];
  result.splice(lineIndex + 1, 0, ...newLines);
  return result;
}

/**
 * Insert new lines before the anchor line.
 */
export function applyInsertBefore(
  lines: string[],
  anchor: string,
  text: string | string[],
  hashWidth: number
): string[] {
  const parsed = parseLineRef(anchor);
  const lineIndex = parsed.line - 1;

  validateLineRef(lines, anchor, hashWidth);

  let newLines = toNewLines(text);
  if (newLines.length === 0 || (newLines.length === 1 && newLines[0] === "")) {
    return lines; // noop
  }
  newLines = stripLinePrefixes(newLines);
  newLines = stripInsertBeforeEcho(lines[lineIndex], newLines);

  if (newLines.length === 0) return lines; // became noop after echo strip

  const result = [...lines];
  result.splice(lineIndex, 0, ...newLines);
  return result;
}

/**
 * Append lines at EOF.
 */
export function applyAppend(
  lines: string[],
  text: string | string[]
): string[] {
  let newLines = toNewLines(text);
  if (newLines.length === 0 || (newLines.length === 1 && newLines[0] === "")) {
    return lines; // noop
  }
  newLines = stripLinePrefixes(newLines);

  const result = [...lines];
  result.push(...newLines);
  return result;
}

/**
 * Prepend lines at BOF.
 */
export function applyPrepend(
  lines: string[],
  text: string | string[]
): string[] {
  let newLines = toNewLines(text);
  if (newLines.length === 0 || (newLines.length === 1 && newLines[0] === "")) {
    return lines; // noop
  }
  newLines = stripLinePrefixes(newLines);

  const result = [...lines];
  result.unshift(...newLines);
  return result;
}

/**
 * Apply multiple edits to content and return the result with a report.
 *
 * Pipeline:
 *   1. Deduplicate edits
 *   2. Sort bottom-up (descending line number)
 *   3. Validate all line references
 *   4. Detect overlapping ranges
 *   5. Apply each edit in order
 *   6. Track noop edits
 */
export function applyEditsWithReport(
  content: string,
  edits: EditOp[],
  hashWidth: number
): { content: string; noopEdits: number; deduplicatedEdits: number } {
  // Step 1: Deduplicate
  const { edits: deduped, deduplicatedCount } = deduplicateEdits(edits);

  // Step 2: Sort bottom-up
  const sorted = sortEditsBottomUp(deduped);

  // Step 3: Collect and validate all refs
  const refs = collectLineRefs(sorted);
  const lines = content === "" ? [] : content.split("\n");
  if (refs.length > 0) {
    validateLineRefs(lines, refs, hashWidth);
  }

  // Step 4: Detect overlapping ranges
  const overlapError = detectOverlappingRanges(sorted);
  if (overlapError) {
    throw new Error(overlapError);
  }

  // Step 5: Apply edits
  let currentLines = [...lines];
  let noopEdits = 0;

  for (const edit of sorted) {
    const before = [...currentLines];
    let beforeLen = currentLines.length;

    switch (edit.op) {
      case "replace": {
        if (edit.end) {
          currentLines = applyReplaceRange(currentLines, edit.pos, edit.end, edit.lines, hashWidth);
        } else {
          currentLines = applyReplaceSingle(currentLines, edit.pos, edit.lines, hashWidth);
        }
        break;
      }
      case "append":
        if (edit.pos) {
          currentLines = applyInsertAfter(currentLines, edit.pos, edit.lines, hashWidth);
        } else {
          currentLines = applyAppend(currentLines, edit.lines);
        }
        break;
      case "prepend":
        if (edit.pos) {
          currentLines = applyInsertBefore(currentLines, edit.pos, edit.lines, hashWidth);
        } else {
          currentLines = applyPrepend(currentLines, edit.lines);
        }
        break;
    }

    // Check if the edit was a noop (no change)
    if (
      arraysEqual(before, currentLines) ||
      (currentLines.length === beforeLen && arraysEqual(before, currentLines))
    ) {
      noopEdits++;
    }
  }

  const resultContent = currentLines.join("\n");

  return {
    content: resultContent,
    noopEdits,
    deduplicatedEdits: deduplicatedCount,
  };
}

/**
 * Compare two string arrays for equality.
 */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
