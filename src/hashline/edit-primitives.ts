import type { EditOp, RawEditOp, ReplaceOp, AppendOp, PrependOp } from "./types.ts";
import { parseLineRef, validateLineRef, validateLineRefs, HashlineMismatchError } from "./validation.ts";
import { toNewLines, stripLinePrefixes, restoreLeadingIndent, stripInsertAnchorEcho, stripInsertBeforeEcho, stripRangeBoundaryEcho } from "./text-normalize.ts";
import { sortEditsBottomUp, deduplicateEdits, detectOverlappingRanges, collectLineRefs, getEditLineNumber } from "./edit-ordering.ts";
import { splitLines } from "./hash.ts";

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
 *
 * D11: when `originalLines` (the batch-start snapshot) is provided, anchor
 * validation and the indent template come from it, not from the mutated
 * working `lines` — a prior same-line op (replace before append/prepend)
 * rewrites the anchor's content, so re-validating against `lines` would fail
 * on the already-replaced line. The splice always operates on `lines`.
 */
export function applyReplaceSingle(
  lines: string[],
  anchor: string,
  newText: string | string[],
  hashWidth: number,
  originalLines?: string[]
): string[] {
  const parsed = parseLineRef(anchor);
  const lineIndex = parsed.line - 1;

  const ref = originalLines ?? lines;
  validateLineRef(ref, anchor, hashWidth);
  let newLines = toNewLines(newText);
  newLines = stripLinePrefixes(newLines);

  // Restore leading indent for the first replacement line
  if (newLines.length > 0 && ref[lineIndex] !== undefined) {
    newLines[0] = restoreLeadingIndent(ref[lineIndex], newLines[0]);
  }

  const result = [...lines];
  // D5: with zero newLines (toNewLines maps ""/[] to []), splice deletes the target line.
  result.splice(lineIndex, 1, ...newLines);
  return result;
}

/**
 * Apply a replace operation targeting an inclusive range [startAnchor, endAnchor].
 *
 * D11: validation/echo-strip/indent references use `originalLines` (the
 * batch-start snapshot) when provided; the splice operates on `lines`.
 * D3: `attached` inserts (append/prepend ops anchored strictly INSIDE this
 * range) ride along with the range splice as
 * [prepends..., rangeNewLines..., appends...].
 */
export function applyReplaceRange(
  lines: string[],
  startAnchor: string,
  endAnchor: string,
  newText: string | string[],
  hashWidth: number,
  originalLines?: string[],
  attached?: AttachedInsert
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

  // Validate both anchors — against the original snapshot when provided
  const ref = originalLines ?? lines;
  validateLineRef(ref, startAnchor, hashWidth);
  validateLineRef(ref, endAnchor, hashWidth);

  let newLines = toNewLines(newText);
  // D4: echo-strip FIRST — it needs the literal "LINE#HASH|" prefix form, which
  // stripLinePrefixes would erase before the match could be made.
  newLines = stripRangeBoundaryEcho(ref, startParsed.line, endParsed.line, newLines);
  newLines = stripLinePrefixes(newLines);

  // Restore leading indent for first replacement line
  if (newLines.length > 0 && ref[startIndex] !== undefined) {
    newLines[0] = restoreLeadingIndent(ref[startIndex], newLines[0]);
  }

  const rangeLen = endIndex - startIndex + 1;
  const result = [...lines];
  // D5: with zero newLines (toNewLines maps ""/[] to []), splice deletes the target range.
  if (attached) {
    result.splice(
      startIndex,
      rangeLen,
      ...[...attached.prependLines, ...newLines, ...attached.appendLines]
    );
  } else {
    result.splice(startIndex, rangeLen, ...newLines);
  }
  return result;
}

/**
 * Insert new lines after the anchor line.
 *
 * D11: anchor validation and the echo-strip anchor line come from
 * `originalLines` (batch-start snapshot) when provided — a prior same-line
 * replace rewrites the working line, but the anchor references the ORIGINAL
 * content.
 */
export function applyInsertAfter(
  lines: string[],
  anchor: string,
  text: string | string[],
  hashWidth: number,
  originalLines?: string[]
): string[] {
  const parsed = parseLineRef(anchor);
  const lineIndex = parsed.line - 1;

  const ref = originalLines ?? lines;
  validateLineRef(ref, anchor, hashWidth);

  let newLines = toNewLines(text);
  if (newLines.length === 0 || (newLines.length === 1 && newLines[0] === "")) {
    return lines; // noop
  }
  // D4: echo-strip FIRST — it needs the literal "LINE#HASH|" prefix form, which
  // stripLinePrefixes would erase before the match could be made.
  newLines = stripInsertAnchorEcho(ref[lineIndex], newLines);
  newLines = stripLinePrefixes(newLines);

  if (newLines.length === 0) return lines; // became noop after echo strip

  const result = [...lines];
  result.splice(lineIndex + 1, 0, ...newLines);
  return result;
}

/**
 * Insert new lines before the anchor line.
 *
 * D11: anchor validation and the echo-strip anchor line come from
 * `originalLines` (batch-start snapshot) when provided.
 */
export function applyInsertBefore(
  lines: string[],
  anchor: string,
  text: string | string[],
  hashWidth: number,
  originalLines?: string[]
): string[] {
  const parsed = parseLineRef(anchor);
  const lineIndex = parsed.line - 1;

  const ref = originalLines ?? lines;
  validateLineRef(ref, anchor, hashWidth);

  let newLines = toNewLines(text);
  if (newLines.length === 0 || (newLines.length === 1 && newLines[0] === "")) {
    return lines; // noop
  }
  // D4: echo-strip FIRST — it needs the literal "LINE#HASH|" prefix form, which
  // stripLinePrefixes would erase before the match could be made.
  newLines = stripInsertBeforeEcho(ref[lineIndex], newLines);
  newLines = stripLinePrefixes(newLines);

  if (newLines.length === 0) return lines; // became noop after echo strip

  const result = [...lines];
  result.splice(lineIndex, 0, ...newLines);
  return result;
}

/**
 * Append lines at EOF.
 *
 * Degenerate-file rule: a file whose only line is empty — canonical content
 * exactly "\n", the only content splitLines maps to [""] — has that newline as
 * its terminator, not a content line. An anchorless append therefore writes the
 * new lines as the file's first lines instead of stacking them below a blank
 * line (regression spec: "\n" + append "x" → "x\n", not "\nx\n").
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
  if (result.length === 1 && result[0] === "") {
    result.length = 0;
  }
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
 * D3: insert lines attached to a replace range. When the range is applied,
 * its splice becomes [prependLines..., rangeNewLines..., appendLines...].
 * Lines are already normalized (echo-strip against the original anchor line,
 * then prefix strip).
 */
export interface AttachedInsert {
  prependLines: string[];
  appendLines: string[];
}

/**
 * D3: attach append/prepend ops whose anchor lies STRICTLY INSIDE a replace
 * range [start, end] (start < anchorLine < end) to that range, removing them
 * from the returned independent list. Anchors on the range START or END
 * boundary are NOT attached — they keep applying independently (bottom-up),
 * preserving today's behavior.
 *
 * Runs after dedup, before sort. Attached anchors stay covered by the
 * batch-start validateLineRefs call because applyEditsWithReport collects
 * refs from the full pre-attachment set.
 */
function attachInsertsInsideRanges(
  edits: EditOp[],
  originalLines: string[]
): { edits: EditOp[]; attached: Map<ReplaceOp, AttachedInsert> } {
  const ranges: { start: number; end: number; op: ReplaceOp }[] = [];
  for (const edit of edits) {
    if (edit.op === "replace" && edit.pos && edit.end) {
      ranges.push({
        start: parseLineRef(edit.pos).line,
        end: parseLineRef(edit.end).line,
        op: edit,
      });
    }
  }

  const attached = new Map<ReplaceOp, AttachedInsert>();
  const independent: EditOp[] = [];

  for (const edit of edits) {
    if ((edit.op === "append" || edit.op === "prepend") && edit.pos) {
      const anchorLine = parseLineRef(edit.pos).line;
      const host = ranges.find((r) => r.start < anchorLine && anchorLine < r.end);
      if (host) {
        const newLines = normalizeAttachedInsert(edit, originalLines);
        if (newLines.length > 0) {
          const entry = attached.get(host.op) ?? { prependLines: [], appendLines: [] };
          if (edit.op === "append") {
            entry.appendLines.push(...newLines);
          } else {
            entry.prependLines.push(...newLines);
          }
          attached.set(host.op, entry);
        }
        continue; // attached — not independent
      }
    }
    independent.push(edit);
  }

  return { edits: independent, attached };
}

/**
 * Normalize an attached insert's lines exactly like applyInsertAfter/
 * applyInsertBefore would: noop guard, echo-strip against the ORIGINAL anchor
 * line (the line the model's anchor referenced), then prefix strip.
 */
function normalizeAttachedInsert(
  edit: AppendOp | PrependOp,
  originalLines: string[]
): string[] {
  let newLines = toNewLines(edit.lines);
  if (newLines.length === 0 || (newLines.length === 1 && newLines[0] === "")) {
    return [];
  }
  const anchorLine = originalLines[parseLineRef(edit.pos!).line - 1] ?? "";
  if (edit.op === "append") {
    newLines = stripInsertAnchorEcho(anchorLine, newLines);
  } else {
    newLines = stripInsertBeforeEcho(anchorLine, newLines);
  }
  newLines = stripLinePrefixes(newLines);
  return newLines;
}

/**
 * Apply multiple edits to content and return the result with a report.
 *
 * Pipeline:
 *   1. Deduplicate edits
 *   2. Attach append/prepend ops anchored strictly inside a replace range (D3)
 *   3. Sort bottom-up (descending line number)
 *   4. Validate all line references
 *   5. Detect overlapping ranges
 *   6. Apply each edit in order
 *   7. Track noop edits
 */
export function applyEditsWithReport(
  content: string,
  edits: EditOp[],
  hashWidth: number
): { content: string; noopEdits: number; deduplicatedEdits: number } {
  // Step 1: Deduplicate
  const { edits: deduped, deduplicatedCount } = deduplicateEdits(edits);

  const lines = splitLines(content);

  // Step 2 (D3): after dedup, before sort — attach append/prepend ops whose
  // anchor lies strictly inside a replace range to that range. Attached
  // inserts ride along with the range's splice instead of applying
  // independently (which bottom-up ordering would run first, only to have the
  // range replace re-validate/overwrite them).
  const { edits: independent, attached } = attachInsertsInsideRanges(deduped, lines);

  // Step 3: Sort bottom-up
  const sorted = sortEditsBottomUp(independent);

  // Step 4: Collect and validate all refs — from the FULL deduped set so
  // attached anchors stay covered. All refs are validated against the
  // batch-start `lines` snapshot (D11), never the mutated working array.
  const refs = collectLineRefs(deduped);
  if (refs.length > 0) {
    validateLineRefs(lines, refs, hashWidth);
  }

  // Step 5: Detect overlapping ranges (replace × replace still throws)
  const overlapError = detectOverlappingRanges(sorted);
  if (overlapError) {
    throw new Error(overlapError);
  }

  // Step 6: Apply edits — every op validates/echo-strips against the original
  // `lines` snapshot (D11) while splicing the working `currentLines`.
  let currentLines = [...lines];
  let noopEdits = 0;

  for (const edit of sorted) {
    const before = [...currentLines];
    let beforeLen = currentLines.length;

    switch (edit.op) {
      case "replace": {
        if (edit.end) {
          currentLines = applyReplaceRange(
            currentLines,
            edit.pos,
            edit.end,
            edit.lines,
            hashWidth,
            lines,
            attached.get(edit)
          );
        } else {
          currentLines = applyReplaceSingle(currentLines, edit.pos, edit.lines, hashWidth, lines);
        }
        break;
      }
      case "append":
        if (edit.pos) {
          currentLines = applyInsertAfter(currentLines, edit.pos, edit.lines, hashWidth, lines);
        } else {
          currentLines = applyAppend(currentLines, edit.lines);
        }
        break;
      case "prepend":
        if (edit.pos) {
          currentLines = applyInsertBefore(currentLines, edit.pos, edit.lines, hashWidth, lines);
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
