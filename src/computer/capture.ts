/**
 * Where a screenshot lands, and how its bytes become a tool result.
 *
 * The path is generated, not guessed: `<worktree>/.rolebox/computer/
 * <timestamp>-<seq>.png`, in a directory created 0700 so a capture of the
 * user's screen is not world-readable. The result carries the bytes twice in
 * the forms a host needs — a `data:image/png;base64,...` attachment for the
 * model, and plain text (`[image: image/png, N bytes]` plus the saved path) for
 * a transcript — never base64 in the text.
 */

import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ToolResult } from "../platform/types.ts";
import { hasPngSignature, readPngSize } from "./png.ts";

/** The worktree-relative directory every capture is written under. */
export const CAPTURE_DIRECTORY = ".rolebox/computer";

/** Owner-only: a screen capture is no more readable than the screen itself. */
const CAPTURE_DIRECTORY_MODE = 0o700;

let sequence = 0;

/** The next capture number for this process, so two captures cannot collide. */
export function nextCaptureSequence(): number {
  sequence += 1;
  return sequence;
}

/** The directory captures are written to, under a worktree. */
export function captureDirectory(worktree: string): string {
  return join(worktree, CAPTURE_DIRECTORY);
}

/** A filesystem-safe UTC stamp: `20261009T121255123Z`. */
export function captureTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(".", "");
}

/** The path one capture is written to. */
export function captureFilePath(
  worktree: string,
  date: Date = new Date(),
  sequenceNumber: number = nextCaptureSequence(),
): string {
  const name = `${captureTimestamp(date)}-${String(sequenceNumber).padStart(3, "0")}.png`;
  return join(captureDirectory(worktree), name);
}

/** Create (or tighten) the capture directory before a helper writes into it. */
export function ensureCaptureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: CAPTURE_DIRECTORY_MODE });
  try {
    chmodSync(directory, CAPTURE_DIRECTORY_MODE);
  } catch {
    // Windows has no POSIX mode bits; the ACL it inherited still applies.
  }
}

function screenshotFailure(driver: string, platform: string, message: string): ToolResult {
  return {
    title: "Screenshot failed",
    output: `Error: ${message}`,
    metadata: { platform, driver, action: "screenshot" },
  };
}

/**
 * Read a written capture and build the screenshot tool's result.
 *
 * The geometry in `metadata` is the PNG's own IHDR values and the byte count is
 * the file's, so a helper that wrote a different size than requested cannot
 * make the tool report a picture it did not take.
 */
export function captureResult(path: string, platform: string, driver: string): ToolResult {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return screenshotFailure(
      driver,
      platform,
      `the ${driver} command reported success but ${path} could not be read (${message}); check that this process is allowed to capture the screen.`,
    );
  }
  const size = readPngSize(bytes);
  if (size === null) {
    const reason = hasPngSignature(bytes)
      ? "it has a PNG signature but no readable IHDR header"
      : `it is not a PNG (${bytes.byteLength} bytes)`;
    return screenshotFailure(
      driver,
      platform,
      `the ${driver} command wrote ${path}, but ${reason}; nothing was returned as an image.`,
    );
  }
  return {
    title: `Image: ${path}`,
    output: `[image: image/png, ${bytes.byteLength} bytes]\n${path}`,
    metadata: {
      platform,
      driver,
      action: "screenshot",
      path,
      width: size.width,
      height: size.height,
      bytes: bytes.byteLength,
    },
    attachments: [
      {
        type: "file",
        mime: "image/png",
        url: `data:image/png;base64,${bytes.toString("base64")}`,
        filename: basename(path),
      },
    ],
  };
}
