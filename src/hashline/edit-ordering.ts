import type { EditOp, ReplaceOp, AppendOp, PrependOp } from "./types.ts";
import { parseLineRef } from "./validation.ts";

/**
 * Extract the line number from an edit's anchor.
 * For replace ops without pos, returns 0. For append/prepend without pos,
 * returns 0 (BOF/EOF sentinel).
 */
export function getEditLineNumber(edit: EditOp): number {
  switch (edit.op) {
    case "replace":
      return edit.pos ? parseLineRef(edit.pos).line : 0;
    case "append":
      return edit.pos ? parseLineRef(edit.pos).line : Infinity;
    case "prepend":
      return edit.pos ? parseLineRef(edit.pos).line : 0;
  }
}

/**
 * Collect all line references from a set of edits.
 */
export function collectLineRefs(edits: EditOp[]): string[] {
  const refs: string[] = [];
  for (const edit of edits) {
    switch (edit.op) {
      case "replace":
        if (edit.pos) refs.push(edit.pos);
        if (edit.end) refs.push(edit.end);
        break;
      case "append":
        if (edit.pos) refs.push(edit.pos);
        break;
      case "prepend":
        if (edit.pos) refs.push(edit.pos);
        break;
    }
  }
  return refs;
}

/**
 * Op priority for within-same-line ordering (lower = processed first).
 * replace=0, append=1, prepend=2
 */
function opPriority(op: EditOp["op"]): number {
  switch (op) {
    case "replace":
      return 0;
    case "append":
      return 1;
    case "prepend":
      return 2;
  }
}

/**
 * Sort edits bottom-up (descending line number) to avoid index shifting
 * during application. Within the same line:
 *   replace before append before prepend.
 */
export function sortEditsBottomUp(edits: EditOp[]): EditOp[] {
  return [...edits].sort((a, b) => {
    const lineA = getEditLineNumber(a);
    const lineB = getEditLineNumber(b);

    // Compare by line number descending
    if (lineA !== lineB) {
      return lineB - lineA; // descending
    }

    // Same line: replace (0) < append (1) < prepend (2)
    return opPriority(a.op) - opPriority(b.op);
  });
}

/**
 * Detect identical edits and remove duplicates.
 * Two edits are identical if they have the same op, pos, end, and lines.
 */
export function deduplicateEdits(
  edits: EditOp[]
): { edits: EditOp[]; deduplicatedCount: number } {
  const seen = new Set<string>();
  const result: EditOp[] = [];
  let deduplicatedCount = 0;

  for (const edit of edits) {
    const key = editKey(edit);
    if (seen.has(key)) {
      deduplicatedCount++;
    } else {
      seen.add(key);
      result.push(edit);
    }
  }

  return { edits: result, deduplicatedCount };
}

/**
 * Detect overlapping replace ranges.
 * Returns an error message if overlaps found, or null if clean.
 */
export function detectOverlappingRanges(edits: EditOp[]): string | null {
  const ranges: { start: number; end: number; pos: string; endRef: string | undefined }[] = [];

  for (const edit of edits) {
    if (edit.op !== "replace") continue;
    if (!edit.pos) continue;

    const start = parseLineRef(edit.pos).line;
    const end = edit.end ? parseLineRef(edit.end).line : start;

    for (const existing of ranges) {
      if (rangesOverlap(start, end, existing.start, existing.end)) {
        return (
          `Overlapping replace ranges detected: ` +
          `"${edit.pos}${edit.end ? ".." + edit.end : ""}" overlaps with ` +
          `"${existing.pos}${existing.endRef ? ".." + existing.endRef : ""}". ` +
          `Edits must not overlap.`
        );
      }
    }

    ranges.push({ start, end, pos: edit.pos, endRef: edit.end });
  }

  return null;
}

// ── Internal helpers ───────────────────────────────────────────────

/**
 * Create a deduplication key for an edit op.
 */
function editKey(edit: EditOp): string {
  const linesKey = Array.isArray(edit.lines)
    ? edit.lines.join("\n")
    : String(edit.lines ?? "");

  switch (edit.op) {
    case "replace":
      return `replace|${edit.pos ?? ""}|${edit.end ?? ""}|${linesKey}`;
    case "append":
      return `append|${edit.pos ?? ""}||${linesKey}`;
    case "prepend":
      return `prepend|${edit.pos ?? ""}||${linesKey}`;
  }
}

/**
 * Check if two ranges [aStart, aEnd] and [bStart, bEnd] overlap.
 * Ranges are inclusive.
 */
function rangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}
