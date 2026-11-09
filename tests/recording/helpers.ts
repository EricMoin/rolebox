import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { vi } from "vitest";
import type { CanonicalToolContext } from "../../src/platform/types.ts";
import type { VideoEncoder, VideoEncoding } from "../../src/recording/video.ts";

export function recordingContext(worktree: string, sessionID = "recording-session"): CanonicalToolContext {
  return { worktree, directory: worktree, sessionID, messageID: "message", agent: "agent", abort: new AbortController().signal, metadata() {}, async ask() {} };
}

export function fakeEncoder(): VideoEncoder & { check: ReturnType<typeof vi.fn>; encode: ReturnType<typeof vi.fn> } {
  return {
    check: vi.fn(async () => {}),
    encode: vi.fn(async (input: VideoEncoding) => { writeFileSync(join(input.directory, "recording.mp4"), "fixture video", { mode: 0o600 }); }),
  };
}

/** Valid PNG pixels let the optional encoder test exercise decoding, resizing and MP4 output. */
export function recordingPng(width = 16, height = 16): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const name = Buffer.from(type);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([name, data])) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, name, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height, 128);
  for (let y = 0; y < height; y++) pixels[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
