import { computeLineHash } from "./hash.ts";
import { FUZZY_SEARCH_WINDOW } from "./constants.ts";
import type { HashMismatch } from "./types.ts";

/**
 * Search ±N lines from the target position for a line whose computed hash
 * matches the expected hash. Used for fuzzy re-anchoring when a line has shifted.
 *
 * @returns The matching line number, or null if no match found within window.
 */
export function findNearbyMatch(
  lines: string[],
  targetLine: number,
  expectedHash: string,
  hashWidth: number,
  maxDistance: number = FUZZY_SEARCH_WINDOW,
): number | null {
  for (let dist = 1; dist <= maxDistance; dist++) {
    const below = targetLine + dist - 1;
    if (below < lines.length) {
      const hash = computeLineHash(lines[below], hashWidth, below + 1);
      if (hash === expectedHash) return below + 1;
    }
    const above = targetLine - dist - 1;
    if (above >= 0 && above < lines.length) {
      const hash = computeLineHash(lines[above], hashWidth, above + 1);
      if (hash === expectedHash) return above + 1;
    }
  }
  return null;
}

/**
 * Suggest the correct anchor for a mismatched line reference.
 * Returns a human-readable suggestion string, or null if no suggestion found.
 *
 * Example output: 'Line 42#aB not found. Did you mean line 43#cD? (content matches, line shifted by +1)'
 */
export function suggestCorrectAnchor(
  mismatch: HashMismatch,
  fileLines: string[],
  hashWidth: number,
): string | null {
  const match = findNearbyMatch(
    fileLines,
    mismatch.line,
    mismatch.expected,
    hashWidth,
  );

  if (match === null) return null;

  const offset = match - mismatch.line;
  const offsetStr = offset > 0 ? `+${offset}` : String(offset);
  const actualHash = computeLineHash(fileLines[match - 1], hashWidth, match);

  return `Line ${mismatch.line}#${mismatch.expected} not found. Did you mean line ${match}#${actualHash}? (content matches, line shifted by ${offsetStr})`;
}

/**
 * Attempt to auto-correct all mismatches by detecting a uniform offset.
 * If all mismatches are off by the same number of lines (e.g., an insertion
 * happened above the edit region), return the corrected anchors.
 *
 * @returns Map of old_ref -> new_ref, or null if offsets are not uniform.
 */
export function detectUniformOffset(
  mismatches: HashMismatch[],
  fileLines: string[],
  hashWidth: number,
): Map<string, string> | null {
  if (mismatches.length === 0) return new Map();

  const offsets: number[] = [];
  const corrections = new Map<string, string>();

  for (const mismatch of mismatches) {
    const match = findNearbyMatch(
      fileLines,
      mismatch.line,
      mismatch.expected,
      hashWidth,
    );

    if (match === null) return null;

    const offset = match - mismatch.line;
    offsets.push(offset);

    const actualHash = computeLineHash(fileLines[match - 1], hashWidth, match);
    corrections.set(
      `${mismatch.line}#${mismatch.expected}`,
      `${match}#${actualHash}`,
    );
  }

  const firstOffset = offsets[0];
  if (!offsets.every((o) => o === firstOffset)) return null;

  return corrections;
}
