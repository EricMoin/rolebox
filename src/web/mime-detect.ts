import { createSubLogger } from "../logger.ts";

const log = createSubLogger("web:mime");

/** Magic byte signature definitions. */
const MAGIC_SIGNATURES: Array<{ mime: string; bytes: number[]; offset?: number }> = [
  { mime: "image/png", bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { mime: "image/jpeg", bytes: [0xFF, 0xD8, 0xFF] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: "image/bmp", bytes: [0x42, 0x4D] },
  { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 },
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2D] },
];

/** Additional check for WebP: must also have "WEBP" at offset 8. */
const WEBP_VP8_SIGNATURE = [0x57, 0x45, 0x42, 0x50]; // "WEBP" as bytes

export interface ContentTypeInfo {
  mime: string;
  isHtml: boolean;
  isImage: boolean;
  isPdf: boolean;
  isText: boolean;
  isJson: boolean;
  isSvg: boolean;
  isBinary: boolean;
}

/**
 * Detect MIME type by inspecting magic bytes at the start of a binary buffer.
 *
 * Checks known signatures (PNG, JPEG, GIF, BMP, WebP, PDF) and returns the
 * MIME type string on match, or `null` if nothing matches.
 *
 * @param buffer — The raw bytes to inspect (at least the first 12 bytes).
 * @returns The detected MIME type string, or `null`.
 */
export function detectMimeByMagic(buffer: Uint8Array): string | null {
  for (const sig of MAGIC_SIGNATURES) {
    const start = sig.offset ?? 0;
    const end = start + sig.bytes.length;

    if (buffer.length < end) continue;

    let match = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[start + i] !== sig.bytes[i]) {
        match = false;
        break;
      }
    }

    if (match) {
      // For WebP, also verify the WEBP chunk marker at offset 8
      if (sig.mime === "image/webp") {
        if (buffer.length < 12) continue;
        let webpMatch = true;
        for (let i = 0; i < WEBP_VP8_SIGNATURE.length; i++) {
          if (buffer[8 + i] !== WEBP_VP8_SIGNATURE[i]) {
            webpMatch = false;
            break;
          }
        }
        if (!webpMatch) continue;
      }

      log.debug(`Detected MIME by magic bytes: ${sig.mime}`);
      return sig.mime;
    }
  }

  return null;
}

/**
 * Parse a Content-Type header value into a clean MIME type string.
 * Strips parameters (charset, boundary, etc.) after `;`.
 */
function parseContentTypeHeader(header: string | null): string | null {
  if (!header) return null;
  const mime = header.split(";")[0].trim().toLowerCase();
  return mime || null;
}

/**
 * Determine whether a detected MIME type should still be considered
 * generic / unhelpful, meaning magic byte detection should take priority.
 */
function isGenericMime(mime: string): boolean {
  return (
    mime === "application/octet-stream" ||
    mime === "application/unknown" ||
    mime === "text/plain"
  );
}

/**
 * Detect content type by combining the HTTP Content-Type header with magic
 * byte analysis of the response body. Returns a structured `ContentTypeInfo`
 * with convenience boolean flags.
 *
 * Strategy:
 * 1. Magic bytes take precedence when they detect a known format, overriding
 *    the header for generic/mismatched types.
 * 2. If the Content-Type header provides a specific, non-generic MIME, trust it
 *    (unless magic bytes detected something of a different category).
 * 3. If neither source yields a result, default to `application/octet-stream`.
 *
 * @param contentTypeHeader — The value of the Content-Type response header (or null).
 * @param bodyStart — The first few bytes of the response body (≥12 bytes preferred).
 * @returns A ContentTypeInfo record with the resolved MIME and boolean flags.
 */
export function detectContentType(
  contentTypeHeader: string | null,
  bodyStart: Uint8Array,
): ContentTypeInfo {
  const headerMime = parseContentTypeHeader(contentTypeHeader);
  const magicMime = detectMimeByMagic(bodyStart);

  let resolvedMime: string;

  if (magicMime && headerMime && !isGenericMime(headerMime)) {
    // Both available and header is specific — prefer magic bytes when categories
    // disagree (e.g., header says text/plain but bytes say image/png)
    if (headerCategory(headerMime) !== headerCategory(magicMime)) {
      resolvedMime = magicMime;
    } else {
      resolvedMime = headerMime;
    }
  } else if (magicMime) {
    resolvedMime = magicMime;
  } else if (headerMime && !isGenericMime(headerMime)) {
    resolvedMime = headerMime;
  } else {
    resolvedMime = "application/octet-stream";
  }

  log.debug(`Content type resolved: header=${headerMime ?? "null"} magic=${magicMime ?? "null"} => ${resolvedMime}`);

  return classifyMime(resolvedMime);
}

/**
 * Return a broad category string for a MIME type, used for comparing
 * whether two MIME types belong to the same fundamental data type.
 */
function headerCategory(mime: string): string {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("text/")) return "text";
  if (mime.startsWith("application/")) return "application";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("multipart/")) return "multipart";
  return "other";
}

/**
 * Build a ContentTypeInfo from a resolved MIME type string.
 */
function classifyMime(mime: string): ContentTypeInfo {
  const lower = mime.toLowerCase();

  return {
    mime: lower,
    isHtml: lower === "text/html" || lower === "application/xhtml+xml",
    isImage: lower.startsWith("image/") && lower !== "image/svg+xml",
    isPdf: lower === "application/pdf",
    isText: lower.startsWith("text/") ||
      lower === "application/json" ||
      lower.endsWith("+json") ||
      lower === "application/xml" ||
      lower.endsWith("+xml") ||
      lower === "application/javascript" ||
      lower === "application/ecmascript",
    isJson: lower === "application/json" || lower.endsWith("+json"),
    isSvg: lower === "image/svg+xml",
    isBinary: !(
      lower.startsWith("text/") ||
      lower === "application/json" ||
      lower.endsWith("+json") ||
      lower === "application/xml" ||
      lower.endsWith("+xml") ||
      lower === "application/javascript" ||
      lower === "application/ecmascript"
    ),
  };
}
