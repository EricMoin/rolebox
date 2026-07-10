import { computeLineHash } from "./hash.ts";
import type { ReanchoredLine } from "./types.ts";
import { myersDiff } from "./myers-diff.ts";

/**
 * Myers diff operation types
 */
export type DiffOp = "equal" | "insert" | "delete";

/**
 * A single diff operation in the edit script
 */
export interface DiffEntry {
  op: DiffOp;
  oldLine?: number;
  newLine?: number;
  content: string;
}

/**
 * Number of context lines around each hunk in unified diff output.
 */
export const UNIFIED_DIFF_CONTEXT = 3;

export { myersDiff };

/**
 * Re-anchor changed lines after an edit.
 */
export function reanchorChangedLines(
  oldLines: string[],
  newLines: string[],
  hashWidth: number,
): ReanchoredLine[] {
  const diff = myersDiff(oldLines, newLines);
  const result: ReanchoredLine[] = [];

  for (const entry of diff) {
    if (entry.op === "insert" && entry.newLine) {
      const newHash = computeLineHash(entry.content, hashWidth, entry.newLine);
      const oldContent =
        entry.oldLine !== undefined && entry.oldLine <= oldLines.length
          ? oldLines[entry.oldLine - 1]
          : "";
      const oldHash = computeLineHash(oldContent, hashWidth, entry.newLine);

      result.push({
        line: entry.newLine,
        oldAnchor: oldHash,
        newAnchor: newHash,
        newContent: entry.content,
      });
    } else if (entry.op === "delete" && entry.oldLine) {
      result.push({
        line: entry.oldLine,
        oldAnchor: computeLineHash(entry.content, hashWidth, entry.oldLine),
        newAnchor: "",
        newContent: "",
      });
    }
  }

  return result;
}

/**
 * Build a unified diff hunk between two line ranges.
 */
interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

/**
 * Generate a unified diff (like `git diff`) between two file contents.
 */
export function generateUnifiedDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
): string {
  const oldLines = oldContent.length === 0 ? [] : oldContent.split("\n");
  const newLines = newContent.length === 0 ? [] : newContent.split("\n");
  const diff = myersDiff(oldLines, newLines);

  if (diff.length === 0) return "";

  const hasChanges = diff.some((e) => e.op !== "equal");
  if (!hasChanges) return "";

  const hunks: Hunk[] = [];
  let i = 0;
  const L = diff.length;

  while (i < L) {
    while (i < L && diff[i].op === "equal") {
      i++;
    }
    if (i >= L) break;

    const hunk: Hunk = {
      oldStart: 0,
      oldCount: 0,
      newStart: 0,
      newCount: 0,
      lines: [],
    };

    const contextBefore: DiffEntry[] = [];
    let scanIdx = i - 1;
    let contextCount = 0;
    while (scanIdx >= 0 && diff[scanIdx].op === "equal" && contextCount < UNIFIED_DIFF_CONTEXT) {
      contextBefore.unshift(diff[scanIdx]);
      contextCount++;
      scanIdx--;
    }

    if (contextBefore.length > 0) {
      hunk.oldStart = contextBefore[0].oldLine ?? 1;
      hunk.newStart = contextBefore[0].newLine ?? 1;
    } else {
      hunk.oldStart = diff[i].oldLine ?? diff[i].newLine ?? 1;
      hunk.newStart = diff[i].newLine ?? diff[i].oldLine ?? 1;
    }

    for (const entry of contextBefore) {
      hunk.lines.push(` ${entry.content}`);
      hunk.oldCount++;
      hunk.newCount++;
    }

    while (i < L && diff[i].op !== "equal") {
      const entry = diff[i];
      if (entry.op === "delete") {
        hunk.lines.push(`-${entry.content}`);
        hunk.oldCount++;
      } else if (entry.op === "insert") {
        hunk.lines.push(`+${entry.content}`);
        hunk.newCount++;
      }
      i++;
    }

    let contextAfter = 0;
    while (i < L && diff[i].op === "equal" && contextAfter < UNIFIED_DIFF_CONTEXT) {
      hunk.lines.push(` ${diff[i].content}`);
      hunk.oldCount++;
      hunk.newCount++;
      contextAfter++;
      i++;
    }

    hunks.push(hunk);
  }

  const mergedHunks = mergeAdjacentHunks(hunks);

  const header = `--- a/${filePath}\n+++ b/${filePath}\n`;
  const body = mergedHunks
    .map((hunk) => {
      const header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@\n`;
      return header + hunk.lines.join("\n");
    })
    .join("\n");

  return header + body + "\n";
}

function mergeAdjacentHunks(hunks: Hunk[]): Hunk[] {
  if (hunks.length <= 1) return hunks;

  const merged: Hunk[] = [hunks[0]];

  for (let i = 1; i < hunks.length; i++) {
    const last = merged[merged.length - 1];
    const curr = hunks[i];

    const gap = curr.oldStart - (last.oldStart + last.oldCount);

    if (gap <= UNIFIED_DIFF_CONTEXT * 2) {
      const lastOldEnd = last.oldStart + last.oldCount - 1;
      const overlapStart = Math.max(last.oldStart, curr.oldStart);
      const overlapEnd = Math.min(lastOldEnd, curr.oldStart + curr.oldCount - 1);

      if (overlapStart <= overlapEnd) {
        while (
          curr.lines.length > 0 &&
          curr.lines[0].startsWith(" ")
        ) {
          curr.lines.shift();
          curr.oldCount--;
          curr.newCount--;
          curr.oldStart++;
          curr.newStart++;
        }
      }

      last.lines.push(...curr.lines);
      last.oldCount += curr.oldCount;
      last.newCount += curr.newCount;

      if (gap > 0) {
        last.oldCount += gap;
        last.newCount += gap;
      }
    } else {
      merged.push(curr);
    }
  }

  return merged;
}

/**
 * Count additions and deletions from a diff.
 */
export function countLineDiffs(
  oldContent: string,
  newContent: string,
): { additions: number; deletions: number } {
  const oldLines = oldContent.length === 0 ? [] : oldContent.split("\n");
  const newLines = newContent.length === 0 ? [] : newContent.split("\n");
  const diff = myersDiff(oldLines, newLines);

  let additions = 0;
  let deletions = 0;
  for (const entry of diff) {
    if (entry.op === "insert") additions++;
    if (entry.op === "delete") deletions++;
  }
  return { additions, deletions };
}
