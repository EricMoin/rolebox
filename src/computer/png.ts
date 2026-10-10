/**
 * The two facts a screenshot tool needs from a PNG, read from its own bytes.
 *
 * `metadata.width`/`metadata.height` come from the IHDR chunk rather than from
 * the request, so a helper that wrote a different size (or a different format)
 * cannot make the tool report a geometry it never produced.
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
