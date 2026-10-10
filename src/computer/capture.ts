/**
 * Where a screenshot lands, and how its bytes become a tool result.
 *
 * The path is generated, not guessed: `<worktree>/.rolebox/computer/
 * <timestamp>-<seq>.png`, in a directory created 0700 so a capture of the
 * user's screen is not world-readable. The result carries the bytes twice in
 * the forms a host needs — a `data:image/png;base64,...` attachment for the
 * model, and plain text (`[image: image/png, N bytes]` plus the saved path) for
 * a transcript — never base64 in the text.
 *
 * A capture is in device pixels, while input is asked for in screen
 * coordinates, so a PNG that states its own density is also reported as
 * `metadata.pixel_scale`, and one whose pixels are not screen points says so in
 * the text.
 */

import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ToolResult } from "../platform/types.ts";
import { hasPngSignature, readPngResolution, readPngSize } from "./png.ts";

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

/**
 * A screen coordinate is a point: 72 of them to the inch, and one inch is
 * 0.0254 metres, which is the unit a PNG's pHYs chunk records density in.
 */
const POINTS_PER_INCH = 72;
const METRES_PER_INCH = 0.0254;

/**
 * The pixel scale a capture states for itself — 2 for one of a 2x screen — or
 * `null` when it states none this can trust.
 *
 * `screencapture` writes device pixels and tags the file with the captured
 * screen's own density, so the recorded pixels-per-metre is the image saying
 * "divide me by two". A pHYs chunk is believed only when it states pixels per
 * METRE (unit 1), the same density on both axes, and a figure within 1% of a
 * whole scale from 1 to 8; a unit-0 chunk only describes an aspect ratio, so it
 * is not a scale at all.
 */
export function readPixelScale(bytes: Uint8Array): number | null {
  const resolution = readPngResolution(bytes);
  if (resolution === null || resolution.unit !== 1) return null;
  if (resolution.xPixelsPerMetre !== resolution.yPixelsPerMetre) return null;
  const scale = Math.round((resolution.xPixelsPerMetre * METRES_PER_INCH) / POINTS_PER_INCH);
  if (scale < 1 || scale > 8) return null;
  const expected = (scale * POINTS_PER_INCH) / METRES_PER_INCH;
  return Math.abs(resolution.xPixelsPerMetre - expected) / expected <= 0.01 ? scale : null;
}

/**
 * The one sentence a capture that is not in screen coordinates adds: the size in
 * pixels, the scale it stated and the same size in screen coordinates, then the
 * division that turns one of the image's pixels into a point the input tools
 * accept.
 */
function pixelScaleNote(width: number, height: number, scale: number): string {
  const points = `${Math.round(width / scale)}x${Math.round(height / scale)}`;
  return (
    `This capture is ${width}x${height} pixels at pixel_scale ${scale} (${points} in screen coordinates); ` +
    `computer_click and computer_move take screen coordinates, so divide any pixel coordinate read off this image by ${scale}.`
  );
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
 * make the tool report a picture it did not take. The density the file states,
 * when it states a usable one, is `metadata.pixel_scale`.
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
  const scale = readPixelScale(bytes);
  const output = [`[image: image/png, ${bytes.byteLength} bytes]`, path];
  if (scale !== null && scale > 1) output.push(pixelScaleNote(size.width, size.height, scale));
  const metadata: Record<string, unknown> = {
    platform,
    driver,
    action: "screenshot",
    path,
    width: size.width,
    height: size.height,
    bytes: bytes.byteLength,
  };
  if (scale !== null) metadata.pixel_scale = scale;
  return {
    title: `Image: ${path}`,
    output: output.join("\n"),
    metadata,
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
