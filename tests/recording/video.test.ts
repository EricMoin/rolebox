import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FfmpegVideoEncoder } from "../../src/recording/video.ts";
import { recordingPng } from "./helpers.ts";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

describe("FFmpeg recording encoder", () => {
  it.skipIf(!hasFfmpeg)("encodes real PNGs with changing dimensions into a decodable video with wall-clock duration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rolebox-video-"));
    try {
      writeFileSync(join(directory, "frame-000000.png"), recordingPng(16, 16));
      writeFileSync(join(directory, "frame-000001.png"), recordingPng(32, 24));
      const encoder = new FfmpegVideoEncoder();
      const signal = new AbortController().signal;
      await encoder.check(signal);
      await encoder.encode({ directory, frames: [{ file: "frame-000000.png", at_ms: 0 }, { file: "frame-000001.png", at_ms: 720 }], duration_ms: 1_500, width: 16, height: 16, signal });
      const bytes = readFileSync(join(directory, "recording.mp4"));
      expect(bytes.subarray(4, 8).toString()).toBe("ftyp");
      const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", join(directory, "recording.mp4"), "-f", "null", "-"], { encoding: "utf8" });
      expect(decoded.status, decoded.stderr).toBe(0);
      const info = spawnSync("ffmpeg", ["-hide_banner", "-i", join(directory, "recording.mp4")], { encoding: "utf8" });
      expect(info.stderr).toMatch(/Duration: 00:00:01\.[45]/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
