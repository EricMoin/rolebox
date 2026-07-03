import type { Position } from "./types.ts";

/**
 * Convert byte offset in file content to LSP Position (0-based line/character).
 * LSP spec mandates UTF-16 code unit counting. Surrogate pairs (codepoints > U+FFFF)
 * count as 2 UTF-16 code units, which is the natural behavior of charCodeAt iteration.
 */
export function offsetToPosition(text: string, offset: number): Position {
  const clampedOffset = Math.max(0, Math.min(offset, text.length));

  let line = 0;
  let character = 0;

  for (let i = 0; i < clampedOffset; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a) {
      line++;
      character = 0;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      character++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      character++;
    } else {
      character++;
    }
  }

  return { line, character };
}

/**
 * Convert LSP Position (0-based line/character) to byte offset in file content.
 * Handles UTF-16 surrogate pairs per LSP spec.
 */
export function positionToOffset(text: string, position: Position): number {
  const { line, character } = position;

  let currentLine = 0;
  let lineStart = 0;

  for (let i = 0; i < text.length; i++) {
    if (currentLine === line) {
      lineStart = i;
      break;
    }
    if (text.charCodeAt(i) === 0x0a) {
      currentLine++;
    }
  }

  if (currentLine < line) {
    return text.length;
  }

  let offset = lineStart;
  let charCount = 0;

  while (offset < text.length && charCount < character) {
    const code = text.charCodeAt(offset);
    if (code === 0x0a) break;
    offset++;
    charCount++;
  }

  return offset;
}
