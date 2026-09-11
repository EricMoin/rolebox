import type { DiffEntry, DiffOp } from "./diff.ts";

/**
 * Build a diff edit script from the V trace.
 * Backtracks through the V arrays to reconstruct the shortest edit script.
 */
export function buildDiffFromTrace(
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
    const V = trace[D];
    const k = x - y;
    const idx = k + offset;

    let prevK: number;
    if (k === -D || (k !== D && V[idx - 1] < V[idx + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevIdx = prevK + offset;
    const prevX = V[prevIdx];
    const prevY = prevX - prevK;

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

    if (x > prevX) {
      x--;
      edits.push({
        op: "delete",
        oldLine: x + 1,
        content: oldLines[x],
      });
    } else if (y > prevY) {
      y--;
      edits.push({
        op: "insert",
        newLine: y + 1,
        content: newLines[y],
      });
    }
  }

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

  const trace: number[][] = [];

  for (let D = 0; D <= max; D++) {
    trace.push([...V]);

    for (let k = -D; k <= D; k += 2) {
      const idx = k + offset;
      let x: number;

      if (k === -D || (k !== D && V[idx - 1] < V[idx + 1])) {
        x = V[idx + 1];
      } else {
        x = V[idx - 1] + 1;
      }

      let y = x - k;

      while (x < N && y < M && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }

      V[idx] = x;

      if (x >= N && y >= M) {
        return buildDiffFromTrace(oldLines, newLines, trace, D, N, M, offset);
      }
    }
  }

  return [];
}
