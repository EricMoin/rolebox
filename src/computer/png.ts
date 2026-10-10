/**
 * The facts a screenshot tool needs from a PNG, read from its own bytes.
 *
 * `metadata.width`/`metadata.height` come from the IHDR chunk rather than from
 * the request, so a helper that wrote a different size (or a different format)
 * cannot make the tool report a geometry it never produced. The pHYs chunk is
 * where a file states its own pixel density, which is what tells a capture's
 * device pixels apart from the screen coordinates input is expressed in.
 */

/** The eight bytes every PNG starts with (PNG specification, section 5.2). */
export const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Whether `bytes` starts with the PNG signature. */
export function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/**
 * The pixel size declared in a PNG's IHDR chunk, or `null` when `bytes` is not
 * a PNG this can read (too short, wrong signature, or no IHDR first).
 */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  // 8-byte signature + 4-byte chunk length + 4-byte "IHDR" + 4 + 4 size fields.
  if (!hasPngSignature(bytes) || bytes.byteLength < 24) return null;
  const ihdr = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (ihdr !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * The pixel density a PNG states for itself, or `null` when this cannot read
 * one (not a PNG, a chunk that overruns the buffer, or no pHYs before IEND).
 *
 * Chunks are walked in file order — 4-byte big-endian length, 4-character type,
 * that many data bytes, then a CRC this does not read, matching
 * {@link readPngSize} — so a truncated or hostile file is answered with `null`
 * instead of an exception. `unit` is the chunk's own: 1 means the two figures
 * are pixels per metre, 0 that they only describe an aspect ratio.
 */
export function readPngResolution(bytes: Uint8Array): { xPixelsPerMetre: number; yPixelsPerMetre: number; unit: number } | null {
  if (!hasPngSignature(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset < bytes.byteLength) {
    // A chunk header is a 4-byte length and a 4-character type.
    if (offset + 8 > bytes.byteLength) return null;
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (type === "IEND") return null;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.byteLength) return null;
    if (type === "pHYs") {
      // x (4), y (4) and the unit (1); anything shorter is not a density.
      if (length < 9) return null;
      return {
        xPixelsPerMetre: view.getUint32(dataStart),
        yPixelsPerMetre: view.getUint32(dataStart + 4),
        unit: bytes[dataStart + 8],
      };
    }
    offset = dataEnd + 4;
  }
  return null;
}
