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

  return { content, hadBom, lineEnding };
}

/**
 * Restore file text to its original encoding (re-add BOM, restore line endings).
 */
export function restoreFileText(content: string, envelope: FileTextEnvelope): string {
  let result = content;
  if (envelope.lineEnding === "\r\n") {
    result = result.replace(/\n/g, "\r\n");
  }
  if (envelope.hadBom) {
    result = "\uFEFF" + result;
  }
  return result;
}
