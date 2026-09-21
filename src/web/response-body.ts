import { createSubLogger } from "../logger.ts";

const log = createSubLogger("web:body");

/** Hard cap on how many bytes of a response body are read into memory (20 MiB). */
export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

/** How many leading bytes are scanned for a declared charset. */
const CHARSET_SNIFF_BYTES = 4096;

/** Non-standard labels mapped onto the WHATWG label a TextDecoder expects. */
const CHARSET_ALIASES: Record<string, string> = {
  gb2312: "gbk",
  utf8: "utf-8",
};

/** Normalize a charset label: case, surrounding quotes, and common aliases. */
function normalizeCharset(label: string): string {
  const stripped = label
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim()
    .toLowerCase();
  return CHARSET_ALIASES[stripped] ?? stripped;
}

/** Concatenate the accepted chunks into one exact-length view. */
function joinChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Read at most `maxBytes` from a response body.
 *
 * Reads through a stream reader, stops (and cancels the reader) as soon as the
 * cap is reached, and reports whether bytes were dropped. A Content-Length
 * already above the cap is used as a fast path; a body without a stream falls
 * back to `response.arrayBuffer()`. A failing body stream propagates its
 * error rather than silently returning partial bytes.
 *
 * @param response - Response to read.
 * @param maxBytes - Byte cap (default {@link MAX_RESPONSE_BYTES}).
 * @returns The accepted bytes and whether the body was truncated.
 */
export async function readBodyCapped(
  response: Response,
  maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
  const declaredLength = Number(response.headers.get("content-length"));
  const declaredOverCap = Number.isFinite(declaredLength) && declaredLength > cap;

  const body = response.body;
  if (body === null || typeof body.getReader !== "function") {
    const view = new Uint8Array(await response.arrayBuffer());
    if (view.byteLength > cap) {
      return { bytes: view.subarray(0, cap), truncated: true };
    }
    return { bytes: view, truncated: false };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      // A Content-Length above the cap already proves truncation, so stop as
      // soon as the cap is reached instead of reading one chunk more.
      if (declaredOverCap && total >= cap) {
        truncated = true;
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      const remaining = cap - total;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total = cap;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    if (truncated) {
      try {
        await reader.cancel();
      } catch (error) {
        log.debug("Response body cancel failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      reader.releaseLock();
    } catch (error) {
      log.debug("Response body releaseLock failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { bytes: joinChunks(chunks, total), truncated };
}

/**
 * Copy a view's exact bytes into a standalone ArrayBuffer.
 *
 * Unlike `view.buffer`, the result never exposes bytes outside the view
 * (e.g. the head of a subarray).
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** BOM detection: charset plus the number of leading bytes to skip. */
interface BomInfo {
  charset: string;
  offset: number;
}

/** Detect a UTF-8 / UTF-16 byte order mark. */
function detectBom(bytes: Uint8Array): BomInfo | null {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { charset: "utf-8", offset: 3 };
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { charset: "utf-16le", offset: 2 };
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { charset: "utf-16be", offset: 2 };
  }
  return null;
}

/** Extract and normalize the charset parameter of a Content-Type header. */
function charsetFromContentType(contentType: string | null): string | null {
  if (contentType === null || contentType === "") return null;
  const match = /;\s*charset\s*=\s*("([^"]*)"|'([^']*)'|([^;\s]+))/i.exec(contentType);
  if (match === null) return null;
  const raw = match[2] ?? match[3] ?? match[4] ?? "";
  const label = normalizeCharset(raw);
  return label === "" ? null : label;
}

/**
 * How many trailing bytes may be dropped to remove one partial character.
 *
 * Three covers the longest multi-byte sequence the supported decoders can
 * leave behind (a 4-byte UTF-8 character missing all of its continuation
 * bytes).
 */
const MAX_PARTIAL_TAIL_BYTES = 3;

/**
 * Length of an incomplete UTF-8 sequence at the end of `bytes`, or 0 when the
 * tail ends on a character boundary.
 */
function partialUtf8TailLength(bytes: Uint8Array): number {
  for (let back = 1; back <= 4 && back <= bytes.byteLength; back++) {
    const byte = bytes[bytes.byteLength - back];
    if ((byte & 0x80) === 0) return 0; // ASCII: the tail is a complete character
    if ((byte & 0xc0) === 0x80) continue; // continuation byte: walk back to its lead
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return back < needed ? back : 0;
  }
  return 0;
}

/**
 * Whether the tail of `bytes` really is an incomplete character for `charset`.
 *
 * Only a genuinely partial tail may be dropped: a body that ends with a
 * complete encoded U+FFFD has to keep it. UTF-8 is checked byte by byte;
 * UTF-16 only has to be even-sized; every other supported multi-byte charset
 * has a trailing byte at or above 0x80.
 */
function hasPartialTrailingChar(bytes: Uint8Array, charset: string): boolean {
  if (charset === "utf-8") return partialUtf8TailLength(bytes) > 0;
  if (charset === "utf-16le" || charset === "utf-16be") return bytes.byteLength % 2 === 1;
  return bytes[bytes.byteLength - 1] >= 0x80;
}

/**
 * Decode bytes, dropping a trailing partial character.
 *
 * A byte cap can cut the body in the middle of a multi-byte character, which
 * any decoder renders as a trailing U+FFFD. Dropping up to
 * {@link MAX_PARTIAL_TAIL_BYTES} bytes and re-decoding removes that artefact for
 * every charset the decoder supports, and a body that is nothing but a partial
 * character decodes to an empty string rather than to a replacement glyph. The
 * loop runs only while the decoded text still ends in a replacement character
 * *and* the tail is genuinely incomplete, so ordinary bodies — including one
 * that ends with an encoded U+FFFD — are untouched.
 */
function decodeWithoutPartialTail(decoder: TextDecoder, bytes: Uint8Array, charset: string): string {
  let body = bytes;
  let text = decoder.decode(body);
  for (let dropped = 0; dropped < MAX_PARTIAL_TAIL_BYTES && body.byteLength > 0; dropped++) {
    if (!text.endsWith("\uFFFD")) break;
    if (!hasPartialTrailingChar(body, charset)) break;
    body = body.subarray(0, body.byteLength - 1);
    text = decoder.decode(body);
  }
  return text;
}

/** Build a decoder for the first supported candidate label. */
function pickDecoder(candidates: string[]): { decoder: TextDecoder; charset: string } {
  for (const candidate of candidates) {
    const label = normalizeCharset(candidate);
    try {
      return { decoder: new TextDecoder(label), charset: label };
    } catch (error) {
      // Unknown or unsupported label: fall through to the next candidate.
      log.debug(`Unsupported charset "${label}", trying next candidate`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { decoder: new TextDecoder("utf-8"), charset: "utf-8" };
}

/**
 * Sniff a charset from the markup itself.
 *
 * Scans the first 4096 bytes (decoded as latin1, which preserves ASCII markup)
 * for a `<meta charset>` / `<meta http-equiv="Content-Type" content="...
 * charset=...">` declaration or an XML declaration encoding. Returns null when
 * nothing declarative is found.
 *
 * @param bytes - Response bytes; only the head is inspected.
 */
export function sniffCharset(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0) return null;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, CHARSET_SNIFF_BYTES));

  // Covers <meta charset="..."> and the charset parameter of a
  // <meta http-equiv="Content-Type" content="text/html; charset=..."> tag.
  const meta = /<meta[^>]*charset\s*=\s*["']?\s*([a-z0-9._:-]+)/i.exec(head);
  if (meta?.[1]) return normalizeCharset(meta[1]);

  const xml = /<\?xml[^>]*encoding\s*=\s*["']([a-z0-9._:-]+)["']/i.exec(head);
  if (xml?.[1]) return normalizeCharset(xml[1]);

  return null;
}

/**
 * Decode response bytes to text using the best available charset.
 *
 * Precedence: UTF-8/UTF-16 BOM, then the Content-Type charset parameter, then
 * {@link sniffCharset}, then UTF-8. Labels are normalized, an unsupported
 * label falls back to UTF-8 instead of throwing, and a leading BOM character
 * is stripped from the decoded text. A body whose byte cap cut the last
 * multi-byte character loses that partial character instead of ending in
 * U+FFFD.
 *
 * @param bytes - Response bytes.
 * @param contentTypeHeader - Raw Content-Type header value, when available.
 * @returns The decoded text and the charset that produced it.
 */
export function decodeText(
  bytes: Uint8Array,
  contentTypeHeader?: string | null,
): { text: string; charset: string } {
  const bom = detectBom(bytes);
  const candidates: string[] = [];
  if (bom !== null) candidates.push(bom.charset);
  const declared = charsetFromContentType(contentTypeHeader ?? null);
  if (declared !== null) candidates.push(declared);
  const sniffed = sniffCharset(bytes);
  if (sniffed !== null) candidates.push(sniffed);
  candidates.push("utf-8");

  const { decoder, charset } = pickDecoder(candidates);
  const body = bom === null ? bytes : bytes.subarray(bom.offset);
  const text = decodeWithoutPartialTail(decoder, body, charset).replace(/^\uFEFF/, "");
  return { text, charset };
}
