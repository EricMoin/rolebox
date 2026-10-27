import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonicalizeFileContent, computeFileVersion } from "./hash.ts";

const LINE_INDEX_STRIDE = 256;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 8;

export interface ReadSnapshot {
  readonly content: string;
  readonly version: string;
  readonly totalLines: number;
  readonly lineStarts: readonly number[];
}

interface CacheEntry {
  raw: string;
  snapshot: ReadSnapshot;
  bytes: number;
}

export function createReadSnapshot(raw: string): ReadSnapshot {
  const content = raw.includes("\r")
    ? canonicalizeFileContent(raw)
    : raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return indexReadSnapshot(content, computeFileVersion(content));
}

function createBufferReadSnapshot(buffer: Buffer, raw: string): ReadSnapshot {
  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const byteOffset = hasBom ? 3 : 0;
  const contentLength = raw.length - (hasBom ? 1 : 0);
  // ASCII has equal byte and UTF-16 lengths after removing the optional BOM.
  if (buffer.length - byteOffset === contentLength
    || types.isSharedArrayBuffer(buffer.buffer)
    || buffer.includes(13)
    || !isUtf8(buffer)) {
    return createReadSnapshot(raw);
  }

  const content = hasBom ? raw.slice(1) : raw;
  // Valid UTF-8 without CR has identical canonical bytes after one BOM removal.
  const canonicalBytes = hasBom ? buffer.subarray(byteOffset) : buffer;
  const version = createHash("sha256").update(canonicalBytes).digest("hex");
  return indexReadSnapshot(content, version);
}

function indexReadSnapshot(content: string, version: string): ReadSnapshot {
  const lineStarts: number[] = [];
  let totalLines = 0;
  let lineStart = 0;
  while (lineStart < content.length) {
    if (totalLines % LINE_INDEX_STRIDE === 0) lineStarts.push(lineStart);
    totalLines++;
    const lineEnd = content.indexOf("\n", lineStart);
    lineStart = lineEnd === -1 ? content.length : lineEnd + 1;
  }
  return { content, version, totalLines, lineStarts };
}

export function findReadLineStart(snapshot: ReadSnapshot, line: number): number {
  const index = Math.floor((line - 1) / LINE_INDEX_STRIDE);
  let start = snapshot.lineStarts[index];
  for (let current = index * LINE_INDEX_STRIDE + 1; current < line; current++) {
    start = snapshot.content.indexOf("\n", start) + 1;
  }
  return start;
}

export class HashlineReadCache {
  private readonly entries = new Map<string, CacheEntry>();
  private bytes = 0;

  constructor(
    private readonly maxBytes = DEFAULT_MAX_BYTES,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {}

  // Presence is an I/O hint only; get still validates freshly read text.
  has(filePath: string): boolean {
    return this.entries.has(filePath);
  }

  get(filePath: string, input: string | Buffer): ReadSnapshot {
    const raw = typeof input === "string" ? input : input.toString("utf8");
    const cached = this.entries.get(filePath);
    // The caller has already read the file. Metadata alone never validates a hit.
    if (cached?.raw === raw) {
      this.entries.delete(filePath);
      this.entries.set(filePath, cached);
      return cached.snapshot;
    }
    this.delete(filePath);
    const snapshot = typeof input === "string"
      ? createReadSnapshot(raw)
      : createBufferReadSnapshot(input, raw);
    // Charge UTF-16 storage conservatively, including separately normalized text.
    const bytes = 256 + filePath.length * 2 + raw.length * 2
      + (snapshot.content === raw ? 0 : snapshot.content.length * 2)
      + snapshot.lineStarts.length * 16;
    if (bytes > this.maxBytes || this.maxEntries <= 0) return snapshot;

    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      this.delete(this.entries.keys().next().value!);
    }
    this.entries.set(filePath, { raw, snapshot, bytes });
    this.bytes += bytes;
    return snapshot;
  }

  delete(filePath: string): void {
    const cached = this.entries.get(filePath);
    if (cached) {
      this.entries.delete(filePath);
      this.bytes -= cached.bytes;
    }
  }
}
