import { describe, it, expect, beforeAll } from "bun:test";

describe("detectMimeByMagic", () => {
  let detectMimeByMagic: (buffer: Uint8Array) => string | null;

  beforeAll(async () => {
    const mod = await import("../../src/web/mime-detect");
    detectMimeByMagic = mod.detectMimeByMagic;
  });

  // -----------------------------------------------------------------------
  // Image format detection
  // -----------------------------------------------------------------------

  it("detects PNG from magic bytes", () => {
    const buf = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x00]);
    expect(detectMimeByMagic(buf)).toBe("image/png");
  });

  it("detects JPEG from magic bytes", () => {
    const buf = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
    expect(detectMimeByMagic(buf)).toBe("image/jpeg");
  });

  it("detects GIF from magic bytes", () => {
    const buf = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(detectMimeByMagic(buf)).toBe("image/gif");
  });

  it("detects BMP from magic bytes", () => {
    const buf = new Uint8Array([0x42, 0x4D, 0x00, 0x00, 0x00, 0x00]);
    expect(detectMimeByMagic(buf)).toBe("image/bmp");
  });

  it("detects WebP from magic bytes with VP8 marker", () => {
    // RIFF header + WEBP at offset 8
    const buf = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x00, 0x00, 0x00, 0x00, // file size placeholder
      0x57, 0x45, 0x42, 0x50, // "WEBP"
    ]);
    expect(detectMimeByMagic(buf)).toBe("image/webp");
  });

  it("rejects WebP without VP8/WEBP chunk marker", () => {
    // RIFF header but no WEBP at offset 8
    const buf = new Uint8Array([
      0x52, 0x49, 0x46, 0x46,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, // garbage instead of "WEBP"
    ]);
    expect(detectMimeByMagic(buf)).toBeNull();
  });

  it("detects PDF from magic bytes", () => {
    const buf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E]);
    expect(detectMimeByMagic(buf)).toBe("application/pdf");
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it("returns null for empty buffer", () => {
    expect(detectMimeByMagic(new Uint8Array([]))).toBeNull();
  });

  it("returns null for buffer too short to match any signature", () => {
    expect(detectMimeByMagic(new Uint8Array([0x00, 0x01]))).toBeNull();
  });

  it("returns null for unknown data", () => {
    const buf = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x00, 0x00, 0x00]);
    expect(detectMimeByMagic(buf)).toBeNull();
  });
});

describe("detectContentType", () => {
  let detectContentType: (
    contentTypeHeader: string | null,
    bodyStart: Uint8Array,
  ) => {
    mime: string;
    isHtml: boolean;
    isImage: boolean;
    isPdf: boolean;
    isText: boolean;
    isJson: boolean;
    isSvg: boolean;
    isBinary: boolean;
  };

  beforeAll(async () => {
    const mod = await import("../../src/web/mime-detect");
    detectContentType = mod.detectContentType;
  });

  // -----------------------------------------------------------------------
  // Content-Type header only (no magic bytes)
  // -----------------------------------------------------------------------

  it("detects text/html from header", () => {
    const result = detectContentType("text/html; charset=utf-8", new Uint8Array([]));
    expect(result.mime).toBe("text/html");
    expect(result.isHtml).toBe(true);
    expect(result.isText).toBe(true);
    expect(result.isBinary).toBe(false);
  });

  it("detects application/json from header", () => {
    const result = detectContentType("application/json", new Uint8Array([]));
    expect(result.mime).toBe("application/json");
    expect(result.isJson).toBe(true);
    expect(result.isText).toBe(true);
    expect(result.isBinary).toBe(false);
  });

  it("detects image/png from header", () => {
    const result = detectContentType("image/png", new Uint8Array([]));
    expect(result.mime).toBe("image/png");
    expect(result.isImage).toBe(true);
    expect(result.isBinary).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Magic bytes take precedence over generic header
  // -----------------------------------------------------------------------

  it("uses magic bytes when header is application/octet-stream", () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const result = detectContentType("application/octet-stream", pngBytes);
    expect(result.mime).toBe("image/png");
    expect(result.isImage).toBe(true);
  });

  it("uses magic bytes when header is text/plain", () => {
    const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    const result = detectContentType("text/plain", gifBytes);
    expect(result.mime).toBe("image/gif");
    expect(result.isImage).toBe(true);
  });

  it("uses magic bytes when header is application/unknown", () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D]);
    const result = detectContentType("application/unknown", pdfBytes);
    expect(result.mime).toBe("application/pdf");
    expect(result.isPdf).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Magic bytes override header when categories disagree
  // -----------------------------------------------------------------------

  it("prefers magic bytes when header and magic disagree on category", () => {
    // Header says text/plain, bytes say PNG
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const result = detectContentType("text/plain", pngBytes);
    expect(result.mime).toBe("image/png"); // magic wins
  });

  it("prefers header when header and magic agree on category", () => {
    // Both are image category, header is specific
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const result = detectContentType("image/gif", pngBytes);
    // Same category (image) → header wins
    expect(result.mime).toBe("image/gif");
  });

  // -----------------------------------------------------------------------
  // No header, no magic → fallback
  // -----------------------------------------------------------------------

  it("defaults to application/octet-stream when no info available", () => {
    const result = detectContentType(null, new Uint8Array([]));
    expect(result.mime).toBe("application/octet-stream");
    expect(result.isBinary).toBe(true);
    expect(result.isHtml).toBe(false);
    expect(result.isImage).toBe(false);
  });

  it("defaults to application/octet-stream with generic header and no magic", () => {
    const result = detectContentType("application/octet-stream", new Uint8Array([0x00, 0x01]));
    expect(result.mime).toBe("application/octet-stream");
  });

  // -----------------------------------------------------------------------
  // Classification flags for various MIME types
  // -----------------------------------------------------------------------

  it("classifies image/svg+xml as SVG (isSvg=true, isImage=false)", () => {
    const result = detectContentType("image/svg+xml", new Uint8Array([]));
    expect(result.isSvg).toBe(true);
    expect(result.isImage).toBe(false); // SVG excluded from isImage
    expect(result.isBinary).toBe(false); // Text-based
  });

  it("classifies application/xhtml+xml as HTML", () => {
    const result = detectContentType("application/xhtml+xml", new Uint8Array([]));
    expect(result.mime).toBe("application/xhtml+xml");
    expect(result.isHtml).toBe(true);
    expect(result.isText).toBe(true);
  });

  it("classifies application/javascript as text (not binary)", () => {
    const result = detectContentType("application/javascript", new Uint8Array([]));
    expect(result.isText).toBe(true);
    expect(result.isBinary).toBe(false);
  });

  it("classifies application/xml as text (not binary)", () => {
    const result = detectContentType("application/xml", new Uint8Array([]));
    expect(result.isText).toBe(true);
    expect(result.isBinary).toBe(false);
  });

  it("classifies application/ld+json as JSON and text", () => {
    const result = detectContentType("application/ld+json", new Uint8Array([]));
    expect(result.isJson).toBe(true);
    expect(result.isText).toBe(true);
    expect(result.isBinary).toBe(false);
  });

  it("classifies video/mp4 as binary", () => {
    const result = detectContentType("video/mp4", new Uint8Array([]));
    expect(result.isBinary).toBe(true);
    expect(result.isImage).toBe(false);
    expect(result.isText).toBe(false);
  });

  it("classifies application/zip as binary", () => {
    const result = detectContentType("application/zip", new Uint8Array([]));
    expect(result.isBinary).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Strips parameters from Content-Type header
  // -----------------------------------------------------------------------

  it("strips charset from Content-Type header", () => {
    const result = detectContentType("text/html; charset=UTF-8", new Uint8Array([]));
    expect(result.mime).toBe("text/html");
  });

  it("strips boundary from multipart Content-Type", () => {
    const result = detectContentType(
      "multipart/form-data; boundary=----WebKitFormBoundary",
      new Uint8Array([]),
    );
    expect(result.mime).toBe("multipart/form-data");
  });

  // -----------------------------------------------------------------------
  // Null/empty header edge cases
  // -----------------------------------------------------------------------

  it("handles null header gracefully", () => {
    const result = detectContentType(null, new Uint8Array([]));
    expect(result.mime).toBe("application/octet-stream");
  });

  it("handles empty string header gracefully", () => {
    const result = detectContentType("", new Uint8Array([]));
    expect(result.mime).toBe("application/octet-stream");
  });
});
