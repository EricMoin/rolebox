import type { HashAnchor, HashMismatch } from "./types.ts";
import { HASHLINE_REF_PATTERN, MISMATCH_CONTEXT, FUZZY_SEARCH_WINDOW } from "./constants.ts";
import { computeLineHash } from "./hash.ts";

// ── Tolerant anchor parsing ────────────────────────────────────────

/**
 * Parse a "LINE#HASH" reference string with tolerant normalization.
 *
 * Handles:
 * - Leading markers: `>>>`, `+`, `-` (from diff context)
 * - `# ` (hash followed by space) → normalize to `#`
 * - Trailing `|content` (from annotated lines) → strip
 */
export function parseLineRef(ref: string): HashAnchor {
  let cleaned = ref.trim();

  // Strip leading >>> markers
  cleaned = cleaned.replace(/^>>>\s*/, "");

  // Strip leading + or - (diff markers)
  cleaned = cleaned.replace(/^[+-]\s*/, "");

  // Normalize "# " to "#"
  cleaned = cleaned.replace(/#\s+/, "#");

  // Strip trailing |content (from "LINE#HASH|content" annotated lines)
  cleaned = cleaned.replace(/\|.*$/, "");

  // Strip any remaining whitespace
  cleaned = cleaned.trim();

  const match = cleaned.match(HASHLINE_REF_PATTERN);
  if (!match) {
    throw new Error(
      `Invalid line reference: "${ref}". Expected format: LINE#HASH (e.g., "42#aB3")`
    );
  }

  return {
    line: parseInt(match[1], 10),
    hash: match[2],
  };
}

// ── Anchor validation ──────────────────────────────────────────────

/**
 * Verify that an anchor's hash matches the actual line content.
 * Throws HashlineMismatchError on mismatch.
 */
export function validateLineRef(
  lines: string[],
  ref: string,
  hashWidth: number
): void {
  const anchor = parseLineRef(ref);
  const lineIndex = anchor.line - 1;

  if (lineIndex < 0 || lineIndex >= lines.length) {
    throw new HashlineMismatchError(
      [{ line: anchor.line, expected: anchor.hash, actual: undefined }],
      lines
    );
  }

  const actualHash = computeLineHash(lines[lineIndex], hashWidth, anchor.line);

  if (actualHash !== anchor.hash) {
    throw new HashlineMismatchError(
      [{ line: anchor.line, expected: anchor.hash, actual: actualHash }],
      lines
    );
  }
}

/**
 * Batch-validate multiple line references.
 * Collects all mismatches and throws once with full context.
 */
export function validateLineRefs(
  lines: string[],
  refs: string[],
  hashWidth: number
): void {
  const mismatches: HashMismatch[] = [];

  for (const ref of refs) {
    const anchor = parseLineRef(ref);
    const lineIndex = anchor.line - 1;

    if (lineIndex < 0 || lineIndex >= lines.length) {
      mismatches.push({
        line: anchor.line,
        expected: anchor.hash,
        actual: undefined,
      });
      continue;
    }

    const actualHash = computeLineHash(lines[lineIndex], hashWidth, anchor.line);
    if (actualHash !== anchor.hash) {
      mismatches.push({
        line: anchor.line,
        expected: anchor.hash,
        actual: actualHash,
      });
    }
  }

  if (mismatches.length > 0) {
    throw new HashlineMismatchError(mismatches, lines);
  }
}

// ── Version validation ─────────────────────────────────────────────

/**
 * Whole-file version guard. Throw if expected ≠ actual.
 */
export function validateVersion(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new Error(
      `File version mismatch: expected ${expected}, got ${actual}. ` +
        "The file may have been modified externally since the last read."
    );
  }
}

// ── Structured mismatch error ──────────────────────────────────────

const HASHLINE_ANNOTATED_LINE = /^\d+#[A-Za-z0-9_-]{2,4}\|/;

export class HashlineMismatchError extends Error {
  mismatches: HashMismatch[];
  fileLines: string[];

  constructor(mismatches: HashMismatch[], fileLines: string[]) {
    const message = buildMismatchMessage(mismatches, fileLines);
    super(message);
    this.name = "HashlineMismatchError";
    this.mismatches = mismatches;
    this.fileLines = fileLines;
  }

  /**
   * Scan all lines to find one whose hash matches `ref`'s expected hash.
   * Returns a "did you mean?" hint, or null if no match found.
   */
  suggestLineForHash(
    ref: string,
    lines: string[],
    hashWidth: number
  ): string | null {
    const anchor = parseLineRef(ref);
    const targetHash = anchor.hash;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const hash = computeLineHash(lines[i], hashWidth, lineNum);
      if (hash === targetHash) {
        return `"${lineNum}#${hash}" found at line ${lineNum}`;
      }
    }

    return null;
  }
}

// ── Internal helpers ───────────────────────────────────────────────

function buildMismatchMessage(
  mismatches: HashMismatch[],
  fileLines: string[]
): string {
  const parts: string[] = [];

  // Summary
  if (mismatches.length === 1) {
    const m = mismatches[0];
    parts.push(
      `Hashline mismatch at line ${m.line}: expected "${m.expected}", got "${m.actual ?? "(line does not exist)"}"`
    );
  } else {
    parts.push(
      `${mismatches.length} hashline mismatches detected:`
    );
  }

  // Detail for each mismatch
  for (const m of mismatches) {
    parts.push("");
    parts.push(`--- Line ${m.line} ---`);

    // Context before
    const startCtx = Math.max(0, m.line - 1 - MISMATCH_CONTEXT);
    for (let i = startCtx; i < m.line - 1; i++) {
      const prefix = HASHLINE_ANNOTATED_LINE.test(fileLines[i] ?? "")
        ? "  "
        : "  ";
      parts.push(`  ${i + 1}: ${fileLines[i] ?? ""}`);
    }

    // The mismatched line
    const rawLine = fileLines[m.line - 1] ?? "(line does not exist)";
    const actualHash = m.actual
      ? m.actual
      : computeLineHash(rawLine, 4, m.line).slice(0, 4);
    parts.push(`>>> ${m.line}: ${rawLine}`);
    parts.push(`    expected hash: ${m.expected}, actual: ${m.actual ?? actualHash}`);

    // Context after
    const endCtx = Math.min(fileLines.length, m.line + MISMATCH_CONTEXT);
    for (let i = m.line; i < endCtx; i++) {
      parts.push(`  ${i + 1}: ${fileLines[i] ?? ""}`);
    }
  }

  return parts.join("\n");
}
