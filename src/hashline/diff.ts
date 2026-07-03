import { computeLineHash } from "./hash.ts";
import type { ReanchoredLine } from "./types.ts";

/**
 * Myers diff operation types
 */
export type DiffOp = "equal" | "insert" | "delete";

/**
 * A single diff operation in the edit script
 */
export interface DiffEntry {
  op: DiffOp;
  oldLine?: number;  // 1-based line number in old file (for equal/delete)
  newLine?: number;  // 1-based line number in new file (for equal/insert)
  content: string;
}

/**
 * Number of context lines around each hunk in unified diff output.
 */
export const UNIFIED_DIFF_CONTEXT = 3;

/**
 * Build a diff edit script from the V trace.
 * Backtracks through the V arrays to reconstruct the shortest edit script.
 */
function buildDiffFromTrace(
  oldLines: string[],
  newLines: string[],
  trace: number[][],
  endD: number,
  N: number,
  M: number,
  offset: number,
): DiffEntry[] {
  const edits: DiffEntry[] = [];
  let x = N;
  let y = M;

  for (let D = endD; D > 0; D--) {
    // V at start of D = after D-1's iteration
    const V = trace[D];
    const k = x - y;
    const idx = k + offset;

    // Determine which diagonal we came from using V (from D-1 iteration)
    let prevK: number;
    if (k === -D || (k !== D && V[idx - 1] < V[idx + 1])) {
      prevK = k + 1; // Vertical move (insert)
    } else {
      prevK = k - 1; // Horizontal move (delete)
    }

    const prevIdx = prevK + offset;
    const prevX = V[prevIdx];
    const prevY = prevX - prevK;

    // Backtrack diagonals (matching lines) — walk backwards along equal entries
    while (x > prevX && y > prevY) {
      x--;
      y--;
      edits.push({
        op: "equal",
        oldLine: x + 1,
        newLine: y + 1,
        content: oldLines[x],
      });
    }

    // Backtrack the single non-diagonal step
    if (x > prevX) {
      // Horizontal step — deletion
      x--;
      edits.push({
        op: "delete",
        oldLine: x + 1,
        content: oldLines[x],
      });
    } else if (y > prevY) {
      // Vertical step — insertion
      y--;
      edits.push({
        op: "insert",
        newLine: y + 1,
        content: newLines[y],
      });
    }
  }

  // Handle initial diagonals from (0,0)
  while (x > 0 && y > 0) {
    x--;
    y--;
    edits.push({
      op: "equal",
      oldLine: x + 1,
      newLine: y + 1,
      content: oldLines[x],
    });
  }

  // Reverse because we traversed backwards
  return edits.reverse();
}

/**
 * Compute the Myers diff between two arrays of lines.
 * Returns an edit script: a sequence of equal/insert/delete operations.
 *
 * Algorithm: Myers O(ND) — finds the shortest edit script.
 * Reference: Eugene W. Myers, "An O(ND) Difference Algorithm and Its Variations" (1986)
 */
export function myersDiff(oldLines: string[], newLines: string[]): DiffEntry[] {
  const N = oldLines.length;
  const M = newLines.length;

  // Edge cases
  if (N === 0 && M === 0) return [];
  if (N === 0) {
    return newLines.map((line, i) => ({
      op: "insert" as const,
      newLine: i + 1,
      content: line,
    }));
  }
  if (M === 0) {
    return oldLines.map((line, i) => ({
      op: "delete" as const,
      oldLine: i + 1,
      content: line,
    }));
  }

  // Quick path for identical files
  if (
    N === M &&
    oldLines.every((l, i) => l === newLines[i])
  ) {
    return oldLines.map((line, i) => ({
      op: "equal" as const,
      oldLine: i + 1,
      newLine: i + 1,
      content: line,
    }));
  }

  const max = N + M;
  const offset = max;
  const V: number[] = new Array(2 * max + 1);
  V.fill(-1);
  V[1 + offset] = 0;

  // Store snapshots at each D iteration for backtracking
  const trace: number[][] = [];

  for (let D = 0; D <= max; D++) {
    // Save V before processing this D (snapshot after D-1's iteration)
    trace.push([...V]);

    for (let k = -D; k <= D; k += 2) {
      const idx = k + offset;
      let x: number;

      if (k === -D || (k !== D && V[idx - 1] < V[idx + 1])) {
        // Came from k+1 via vertical move (insert)
        x = V[idx + 1];
      } else {
        // Came from k-1 via horizontal move (delete)
        x = V[idx - 1] + 1;
      }

      let y = x - k;

      // Follow diagonal — matching lines
      while (x < N && y < M && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }

      V[idx] = x;

      if (x >= N && y >= M) {
        // Found the shortest path
        return buildDiffFromTrace(
          oldLines,
          newLines,
          trace,
          D,
          N,
          M,
          offset,
        );
      }
    }
  }

  // Should never reach here if N+M >= 0
  return [];
}

/**
 * Re-anchor changed lines after an edit.
 * Given the old and new line arrays, compute new hashes for lines that changed.
 * Returns only the changed lines' old→new anchor mapping (token-efficient).
 *
 * Uses Myers diff to identify changed regions, then computes new hashes
 * for each changed line in the new file.
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
      // New line inserted — compute its new anchor
      const newHash = computeLineHash(entry.content, hashWidth, entry.newLine);
      // Find what was at this position before (if anything)
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
      // Line deleted — the old anchor is now invalid
      result.push({
        line: entry.oldLine,
        oldAnchor: computeLineHash(entry.content, hashWidth, entry.oldLine),
        newAnchor: "", // deleted
        newContent: "",
      });
    }
    // "equal" entries are skipped — unchanged lines are not included
  }

  return result;
}

/**
 * Build a unified diff hunk between two line ranges.
 */
interface Hunk {
  oldStart: number; // 1-based
  oldCount: number;
  newStart: number; // 1-based
  newCount: number;
  lines: string[]; // Lines prefixed with ' ', '-', or '+'
}

/**
 * Generate a unified diff (like `git diff`) between two file contents.
 * Returns a string in unified diff format with @@ hunk headers.
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

  // Check if there are any changes at all
  const hasChanges = diff.some((e) => e.op !== "equal");
  if (!hasChanges) return "";

  // Build hunks from the diff entries with context
  const hunks: Hunk[] = [];
  let i = 0;
  const L = diff.length;

  while (i < L) {
    // Skip to first change
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

    // Include context lines before the change (up to UNIFIED_DIFF_CONTEXT)
    const contextBefore: DiffEntry[] = [];
    let scanIdx = i - 1;

    // Look backwards for context
    let contextCount = 0;
    while (scanIdx >= 0 && diff[scanIdx].op === "equal" && contextCount < UNIFIED_DIFF_CONTEXT) {
      contextBefore.unshift(diff[scanIdx]);
      contextCount++;
      scanIdx--;
    }

    // Set hunk start from the first context line or first change
    if (contextBefore.length > 0) {
      hunk.oldStart = contextBefore[0].oldLine ?? 1;
      hunk.newStart = contextBefore[0].newLine ?? 1;
    } else {
      hunk.oldStart = diff[i].oldLine ?? diff[i].newLine ?? 1;
      hunk.newStart = diff[i].newLine ?? diff[i].oldLine ?? 1;
    }

    // Add context before
    for (const entry of contextBefore) {
      hunk.lines.push(` ${entry.content}`);
      hunk.oldCount++;
      hunk.newCount++;
    }

    // Add changes
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

    // Include context lines after the change (up to UNIFIED_DIFF_CONTEXT)
    let contextAfter = 0;
    while (i < L && diff[i].op === "equal" && contextAfter < UNIFIED_DIFF_CONTEXT) {
      hunk.lines.push(` ${diff[i].content}`);
      hunk.oldCount++;
      hunk.newCount++;
      contextAfter++;
      i++;
    }

    // If there are more changes after context, step back so they reconnect
    // (but we already consumed the context, so the next iteration will start
    // from the correct position)

    // If we ran out of context, back up to the last context entry for next hunk
    // Actually, i is already past the context, which is correct — the next hunk
    // will pick up from there and find its own context-before

    // However, if we consumed exactly UNIFIED_DIFF_CONTEXT equals and there
    // are more equals after, the next hunk can independently find its own context.
    // If we consumed fewer equals (ran out of entries), the hunk just ends.

    hunks.push(hunk);
  }

  // Merge overlapping or adjacent hunks
  const mergedHunks = mergeAdjacentHunks(hunks);

  // Build the final diff string
  const header = `--- a/${filePath}\n+++ b/${filePath}\n`;
  const body = mergedHunks
    .map((hunk) => {
      const header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@\n`;
      return header + hunk.lines.join("\n");
    })
    .join("\n");

  return header + body + "\n";
}

/**
 * Merge hunks that are close enough to be combined.
 * Two hunks are merged if they overlap or if the gap between them
 * is less than 2 * UNIFIED_DIFF_CONTEXT (meaning the trailing context
 * of the first hunk overlaps the leading context of the second).
 */
function mergeAdjacentHunks(hunks: Hunk[]): Hunk[] {
  if (hunks.length <= 1) return hunks;

  const merged: Hunk[] = [hunks[0]];

  for (let i = 1; i < hunks.length; i++) {
    const last = merged[merged.length - 1];
    const curr = hunks[i];

    // Calculate overlap: the old lines of last end at last.oldStart + last.oldCount - 1
    // The old lines of curr start at curr.oldStart
    const gap = curr.oldStart - (last.oldStart + last.oldCount);

    // Merge if gap <= 0 (overlapping) or gap <= UNIFIED_DIFF_CONTEXT (close enough)
    if (gap <= UNIFIED_DIFF_CONTEXT * 2) {
      // Merge curr into last
      // Calculate how many lines from last's trailing context to keep
      const keepFromLast = Math.min(
        last.oldCount,
        last.oldCount + gap + UNIFIED_DIFF_CONTEXT * 2,
      );

      // Actually, since hunks are already built with context, we need to
      // recalculate. For simplicity, regenerate: combine the line arrays.
      // The gap portion between hunks needs to be re-included.

      // Extract the connecting lines from the gap
      // The gap is in terms of old line indices
      // last covers oldStart..(last.oldStart + last.oldCount - 1)
      // curr covers curr.oldStart..(curr.oldStart + curr.oldCount - 1)

      // Since we're using hunks pre-built with context, and adjacent hunks
      // might share context, let's just concatenate the line arrays
      // with proper deduplication of the overlap.

      // Find where the overlap starts
      const lastOldEnd = last.oldStart + last.oldCount - 1;
      const overlapStart = Math.max(last.oldStart, curr.oldStart);
      const overlapEnd = Math.min(lastOldEnd, curr.oldStart + curr.oldCount - 1);

      if (overlapStart <= overlapEnd) {
        // There's overlap — trim the overlap from curr
        // For simplicity, remove overlapping equal lines from the beginning of curr
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

      // Extend last to include curr
      last.lines.push(...curr.lines);
      last.oldCount += curr.oldCount;
      last.newCount += curr.newCount;

      // If gap > 0, the gap lines are equal lines that should be counted
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
