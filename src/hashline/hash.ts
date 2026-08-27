import { createHash } from "node:crypto";
import {
  BASE64_DICT,
  HASH_WIDTH_SMALL,
  HASH_WIDTH_MEDIUM,
  HASH_WIDTH_LARGE,
  SMALL_FILE_THRESHOLD,
  MEDIUM_FILE_THRESHOLD,
  HASH_WIDTH_ENV_VAR,
} from "./constants.ts";
import type { FileTextEnvelope } from "./types.ts";

/**
 * Split canonical content into its logical lines — the single shared line
 * model used by read, edit, and diff.
 *
 * A file's lines are the content delimited by "\n", where ONE trailing "\n"
 * terminates the last line instead of producing an extra empty line:
 *   ""       → []          (empty file: zero lines)
 *   "\n"     → [""]        (one empty line)
 *   "a\nb\n" → ["a", "b"]
 *   "a\nb"   → ["a", "b"]
 *   "a\n\n"  → ["a", ""]   ("a" followed by one blank line)
 *
 * Keeping this in one place guarantees hashline_read's totalLines/hashWidth,
 * anchor validation, and edit application all agree on line identity — the
 * trailing-newline/line-count mismatch that previously made exactly-1000-line
 * files uneditable and anchored appends misbehave.
 */
export function splitLines(content: string): string[] {
  if (content === "") return [];
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
  return normalized.split("\n");
}

/**
 * Determine hash width based on file line count.
 * Auto-escalates: 2 chars (≤1000 lines) → 3 chars (≤10000) → 4 chars (>10000).
 * Can be overridden by ROLEBOX_HASHLINE_WIDTH env var.
 */
export function hashWidthForLineCount(lineCount: number): number {
  const envOverride = process.env[HASH_WIDTH_ENV_VAR];
  if (envOverride) {
    const w = parseInt(envOverride, 10);
    if (w >= 2 && w <= 8) return w;
  }
  if (lineCount <= SMALL_FILE_THRESHOLD) return HASH_WIDTH_SMALL;
  if (lineCount <= MEDIUM_FILE_THRESHOLD) return HASH_WIDTH_MEDIUM;
  return HASH_WIDTH_LARGE;
}

/**
 * Compute a content-based hash for a single line.
 * Uses SHA-256 of the trimmed content, then base-64 encodes to `width` chars.
 *
 * The hash is stable: same content + same width → same hash.
 * Symbol-only lines (whitespace, braces) get line-number-seeded hashing
 * to differentiate identical-looking lines at different positions.
 */
export function computeLineHash(content: string, width: number, lineNumber?: number): string {
  const trimmed = content.replace(/\r/g, "").trimEnd();

  // For symbol-only lines (no letters/digits), seed with line number
  // to differentiate identical content at different positions
  const hasSignificantChar = /[\p{L}\p{N}]/u.test(trimmed);
  const seed = hasSignificantChar ? "" : String(lineNumber ?? 0);

  const hash = createHash("sha256").update(seed + trimmed).digest();

  // Convert hash bytes to a big integer, then base-64 encode to `width` chars
  let num = 0n;
  const bytesNeeded = Math.ceil((width * 6) / 8) + 1; // 6 bits per char
  for (let i = 0; i < bytesNeeded && i < hash.length; i++) {
    num = (num << 8n) | BigInt(hash[i]);
  }

  let result = "";
  for (let i = 0; i < width; i++) {
    const idx = Number(num % 64n);
    result = BASE64_DICT[idx] + result;
    num /= 64n;
  }
  return result;
}

/**
 * Compute the SHA-256 hex digest of entire file content.
 * Used as a whole-file version guard to detect external modifications.
 */
export function computeFileVersion(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Format a single line with its hash annotation.
 * Output: "LINE#HASH|content"
 */
export function formatHashLine(lineNumber: number, content: string, width: number): string {
  const hash = computeLineHash(content, width, lineNumber);
  return `${lineNumber}#${hash}|${content}`;
}

/**
 * Format all lines in a file with hash annotations.
 */
export function formatHashLines(lines: string[], width: number): string[] {
  return lines.map((content, i) => formatHashLine(i + 1, content, width));
}

/**
 * Build the per-line terminator record from the de-BOM'd raw content, BEFORE
 * any line-ending normalization. One entry per logical line (the splitLines
 * model): the trailing empty segment of a "\n"-terminated file is a terminator
 * remnant, not a line. A segment ending in "\r" (part of a CRLF pair) records
 * "\r\n", otherwise "\n"; when the raw content has no trailing newline, the
 * last entry is "".
 */
function buildLineEols(raw: string): Array<"\r\n" | "\n" | ""> {
  if (raw === "") return [];
  const endsWithNl = raw.endsWith("\n");
  const segments = (endsWithNl ? raw.slice(0, -1) : raw).split("\n");
  const eols: Array<"\r\n" | "\n" | ""> = [];
  for (let i = 0; i < segments.length; i++) {
    if (!endsWithNl && i === segments.length - 1) {
      eols.push(""); // last line has no terminator
    } else {
      eols.push(segments[i].endsWith("\r") ? "\r\n" : "\n");
    }
  }
  return eols;
}

/**
 * Canonicalize file text: strip BOM, normalize line endings to \n.
 * Returns the canonicalized content and metadata for later restoration.
 */
export function canonicalizeFileText(rawContent: string): FileTextEnvelope {
  let content = rawContent;
  let hadBom = false;

  // Strip BOM
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
    hadBom = true;
  }

  // De-BOM'd raw content, captured BEFORE normalization — the source of the
  // per-line terminator record (D10: mixed CRLF+LF files keep per-line EOLs).
  const rawLines = content;

  // Detect line ending
  const hasCrlf = content.includes("\r\n");
  const hasCr = !hasCrlf && content.includes("\r");

  let lineEnding: "\n" | "\r\n";
  if (hasCrlf) {
    lineEnding = "\r\n";
    content = content.replace(/\r\n/g, "\n");
  } else if (hasCr) {
    // Legacy \r-only line endings — normalize to \n
    lineEnding = "\r\n"; // treat as CRLF for restoration
    content = content.replace(/\r/g, "\n");
  } else {
    lineEnding = "\n";
  }

  // Per-line terminators. Legacy CR-only files record "\r\n" everywhere,
  // matching today's restore (which re-expands every line to CRLF). All other
  // files record each original line's actual terminator byte-for-byte.
  const lineEols: Array<"\r\n" | "\n" | ""> = hasCr
    ? Array.from({ length: splitLines(content).length }, () => "\r\n" as const)
    : buildLineEols(rawLines);

  return { content, hadBom, lineEnding, lineEols };
}

/**
 * Restore file text to its original encoding (re-add BOM, restore line endings).
 *
 * Rebuilds from the canonical content's "\n"-split segments: a split point
 * follows segment i iff it is not the last segment, and that terminator is
 * lineEols[i] when one was recorded for the original line ("\r\n" or "\n").
 * Segments beyond the original line count (inserted/appended content) fall
 * back to the envelope's uniform line ending — identical to the pre-D10
 * restore for those positions. A "" entry (original unterminated last line)
 * adds no terminator.
 */
export function restoreFileText(content: string, envelope: FileTextEnvelope): string {
  const eols = envelope.lineEols ?? [];
  const segments = content.split("\n");
  let result = "";
  for (let i = 0; i < segments.length; i++) {
    result += segments[i];
    if (i < segments.length - 1) {
      const eol = i < eols.length && eols[i] !== "" ? eols[i] : envelope.lineEnding;
      result += eol;
    }
  }
  if (envelope.hadBom) {
    result = "\uFEFF" + result;
  }
  return result;
}
