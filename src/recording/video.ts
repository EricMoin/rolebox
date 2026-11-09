import { spawn } from "node:child_process";
import { chmodSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface VideoFrame {
  file: string;
  at_ms: number;
}

export interface VideoEncoding {
  directory: string;
  frames: readonly VideoFrame[];
  duration_ms: number;
  width: number;
  height: number;
  signal: AbortSignal;
}

export interface VideoEncoder {
  check(signal: AbortSignal): Promise<void>;
  encode(input: VideoEncoding): Promise<void>;
}

function run(args: string[], signal: AbortSignal, timeoutMs: number, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Recording operation cancelled.")); return; }
    const child = spawn("ffmpeg", args, { cwd, stdio: "ignore", windowsHide: true });
    const stop = () => { child.kill("SIGKILL"); };
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); };
    child.once("error", () => {
      cleanup();
      reject(new Error("FFmpeg is unavailable. Install ffmpeg with the libx264 encoder on PATH, then retry."));
    });
    child.once("close", code => {
      cleanup();
      if (code === 0 && !signal.aborted) resolve();
      else reject(new Error("FFmpeg did not complete. Check ffmpeg/libx264 availability; captured frames remain in the recording directory."));
    });
  });
}

export class FfmpegVideoEncoder implements VideoEncoder {
  check(signal: AbortSignal): Promise<void> {
    return run(["-version"], signal, 5_000);
  }

  async encode(input: VideoEncoding): Promise<void> {
    const { frames } = input;
    if (frames.length === 0) throw new Error("No frames were captured.");
    const lines = ["ffconcat version 1.0"];
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index]!;
      const end = frames[index + 1]?.at_ms ?? input.duration_ms;
      lines.push(`file ${frame.file}`, `duration ${Math.max(0.04, (end - frame.at_ms) / 1000).toFixed(6)}`);
    }
    // The concat demuxer needs a final packet to preserve the last duration.
    lines.push(`file ${frames[frames.length - 1]!.file}`);
    writeFileSync(join(input.directory, "frames.ffconcat"), `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
    const ratio = Math.min(1, 1920 / input.width, 1080 / input.height);
    const width = Math.max(2, Math.floor(input.width * ratio / 2) * 2);
    const height = Math.max(2, Math.floor(input.height * ratio / 2) * 2);
    try { await run([
      "-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-f", "concat", "-safe", "1",
      "-i", "frames.ffconcat", "-an", "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
      "-fps_mode", "vfr", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", "recording.mp4",
    ], input.signal, 60_000, input.directory); }
    finally {
      const path = join(input.directory, "recording.mp4");
      try {
        const stat = lstatSync(path);
        if (stat.isFile() && stat.nlink === 1) chmodSync(path, 0o600);
      } catch { /* The encoder may fail before creating an output file. */ }
    }
  }
}
