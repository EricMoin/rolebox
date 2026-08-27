import { computeLineHash } from "./hash.ts";
import { FUZZY_SEARCH_WINDOW } from "./constants.ts";
import type { HashMismatch } from "./types.ts";

/**
 * True when `candidateLine`'s content matches `expectedHash`.
 *
 * Two conditions, checked in order:
 *  1. The candidate's own hash at its current position
 *     (computeLineHash(content, width, candidateLine) === expectedHash).
 *  2. Anchor-seeding fallback — the candidate's content hashed with the STALE
 *     target line number (computeLineHash(content, width, targetLine) ===
 *     expectedHash). Symbol-only lines are line-number-seeded
 *     (src/hashline/hash.ts:63-66), so a symbol line shifted by an insert or
 *     delete above it carries a hash that changed with its position. Re-seeding
 *     its content with the caller's original (stale) line number lets the
 *     shifted line match the stale expected hash. Content lines are unseeded,
 *     so the fallback is a no-op for them.
 */
function hashMatchesCandidate(
  lines: string[],
  candidateLine: number, // 1-based
  targetLine: number, // 1-based — the stale reference line from the anchor
  expectedHash: string,
  hashWidth: number,
): boolean {
  const content = lines[candidateLine - 1];
  return (
    computeLineHash(content, hashWidth, candidateLine) === expectedHash ||
    computeLineHash(content, hashWidth, targetLine) === expectedHash
  );
}

/**
 * Search ±N lines from the target position for a line whose computed hash
 * matches the expected hash. Used for fuzzy re-anchoring when a line has shifted.
 *
 * The search is truly symmetric: at each distance d the line above
 * (targetLine - d) is checked before the line below (targetLine + d), so an
 * ambiguous duplicate resolves to the nearest line, with above winning ties —
 * the caller's anchor was captured against an older revision, and a line
 * pushed down by an insertion above it is more likely to be the intended
 * target than a look-alike duplicate below.
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
    const above = targetLine - dist;
    if (above >= 1 && above <= lines.length) {
      if (hashMatchesCandidate(lines, above, targetLine, expectedHash, hashWidth)) {
        return above;
      }
    }
    const below = targetLine + dist;
    if (below <= lines.length) {
      if (hashMatchesCandidate(lines, below, targetLine, expectedHash, hashWidth)) {
        return below;
      }
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
 * For each mismatch the FULL candidate set (offset → line) within the search
 * window is collected; an offset qualifies only if it appears in EVERY
 * mismatch's candidate set (a uniform shift). When the qualifying offsets tie
 * (or there is a single mismatch), the smallest |offset| wins, with the above
 * (negative) side preferred.
 *
 * @returns Map of old_ref -> new_ref, or null if offsets are not uniform.
 */
export function detectUniformOffset(
  mismatches: HashMismatch[],
  fileLines: string[],
  hashWidth: number,
): Map<string, string> | null {
  if (mismatches.length === 0) return new Map();

  const candidateOffsets: Array<Map<number, number>> = [];

  for (const mismatch of mismatches) {
    const byOffset = new Map<number, number>();
    for (let dist = 1; dist <= FUZZY_SEARCH_WINDOW; dist++) {
      const above = mismatch.line - dist;
      if (above >= 1 && above <= fileLines.length) {
        if (hashMatchesCandidate(fileLines, above, mismatch.line, mismatch.expected, hashWidth)) {
          byOffset.set(above - mismatch.line, above);
        }
      }
      const below = mismatch.line + dist;
      if (below <= fileLines.length) {
        if (hashMatchesCandidate(fileLines, below, mismatch.line, mismatch.expected, hashWidth)) {
          byOffset.set(below - mismatch.line, below);
        }
      }
    }
    if (byOffset.size === 0) return null;
    candidateOffsets.push(byOffset);
  }

  // A uniform offset is one present in EVERY mismatch's candidate set.
  const common = new Set<number>(candidateOffsets[0].keys());
  for (let i = 1; i < candidateOffsets.length; i++) {
    for (const offset of [...common]) {
      if (!candidateOffsets[i].has(offset)) common.delete(offset);
    }
  }
  if (common.size === 0) return null;

  // Smallest |offset| wins; ties resolve to the above (negative) side.
  const chosenOffset = [...common].sort((a, b) => {
    const byMagnitude = Math.abs(a) - Math.abs(b);
    return byMagnitude !== 0 ? byMagnitude : a - b;
  })[0];

  const corrections = new Map<string, string>();
  for (let i = 0; i < mismatches.length; i++) {
    const mismatch = mismatches[i];
    const match = candidateOffsets[i].get(chosenOffset)!;
    const actualHash = computeLineHash(fileLines[match - 1], hashWidth, match);
    corrections.set(
      `${mismatch.line}#${mismatch.expected}`,
      `${match}#${actualHash}`,
    );
  }

  return corrections;
}
