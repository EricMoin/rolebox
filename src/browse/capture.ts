/**
 * Screenshot files and their `data:` attachments.
 *
 * A browse screenshot is written to `<worktree>/.rolebox/browse/
 * <timestamp>-<seq>.<ext>` (UTC stamp, process-wide sequence, owner-only
 * directory) and returned twice: as a canonical file attachment for the model,
 * and as plain text plus the path for a transcript. The PNG readers in
 * `src/computer/png.ts` are reused so the reported geometry is the file's own
 * IHDR values rather than something the driver claimed.
 *
 * The 32 MiB attachment limit mirrors the computer-use family; a screenshot over
 * it becomes a `too_large` error result instead of an unusable base64 payload.
 * Nothing here throws: an I/O failure becomes an error result.
 */

import { chmodSync, closeSync, constants, fchmodSync, fstatSync, ftruncateSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { hasPngSignature, readPngSize } from "../computer/png.ts";
import type { ToolAttachment, ToolResult } from "../platform/types.ts";
import { browseErrorResult, browseMetadata, type BrowseResultContext } from "./results.ts";
import { browseError, isBrowseError, type ScreenshotResult } from "./types.ts";
import { checkedArtifactPath } from "./artifact-path.ts";

/** The worktree-relative directory browse captures are written under. */
export const BROWSE_CAPTURE_DIRECTORY = join(".rolebox", "browse");

/** The worktree-relative directory downloads are saved under. */
export const BROWSE_DOWNLOAD_DIRECTORY = join(".rolebox", "browse", "downloads");

/** The largest attachment this family will build (32 MiB, as in computer-use). */
export const BROWSE_ATTACHMENT_LIMIT_BYTES = 32 * 1024 * 1024;

/** Owner-only: a page capture is no more public than the page it shows. */
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

let sequence = 0;

/** The next capture number for this process, so two captures cannot collide. */
export function nextBrowseCaptureSequence(): number {
  sequence += 1;
  return sequence;
}

/** The directory captures are written to, under a worktree. */
export function browseCaptureDirectory(worktree: string): string {
  return join(worktree, BROWSE_CAPTURE_DIRECTORY);
}

/** The directory downloads are saved to, under a worktree. */
export function browseDownloadsDirectory(worktree: string): string {
  return join(worktree, BROWSE_DOWNLOAD_DIRECTORY);
}

/** A filesystem-safe UTC stamp: `20261025T012805123Z`. */
export function browseCaptureTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(".", "");
}

/** The file extension for a screenshot mime type. */
export function browseCaptureExtension(mime: string): string {
  return mime === "image/jpeg" ? "jpg" : "png";
}

/** The path one capture is written to. */
export function browseCaptureFilePath(
  worktree: string,
  mime: string,
  date: Date = new Date(),
  sequenceNumber: number = nextBrowseCaptureSequence(),
): string {
  const name = `${browseCaptureTimestamp(date)}-${String(sequenceNumber).padStart(3, "0")}.${browseCaptureExtension(mime)}`;
  return join(browseCaptureDirectory(worktree), name);
}

/** Create (or tighten) the capture directory before writing into it. */
export function ensureBrowseDirectory(directory: string, worktree: string): void {
  checkedArtifactPath(worktree, directory);
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  checkedArtifactPath(worktree, directory);
  try {
    chmodSync(directory, DIRECTORY_MODE);
  } catch {
    // Windows has no POSIX mode bits; the inherited ACL still applies.
  }
}

/** Build the canonical file attachment for one screenshot. */
export function buildBrowseAttachment(bytes: Uint8Array, mime: string, filename: string): ToolAttachment {
  return {
    type: "file",
    mime,
    url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
    filename,
  };
}

/**
 * Write a screenshot and build the tool result that carries it.
 *
 * The geometry in `metadata` comes from the PNG bytes, so a driver that returned
 * a differently sized image cannot make the result report a size it never
 * produced. `bytes` is never placed in the text output.
 */
export function browseScreenshotResult(input: {
  worktree: string;
  screenshot: ScreenshotResult;
  context: BrowseResultContext;
  /**
   * Absolute path the caller chose for this capture. The default timestamped
   * path under `.rolebox/browse` is used when it is omitted.
   */
  path?: string;
  /** Action fields merged into metadata in front of the capture fields. */
  metadata?: Record<string, unknown>;
}): ToolResult {
  const { screenshot, worktree, context } = input;
  const bytes = screenshot.bytes;
  if (bytes.byteLength > BROWSE_ATTACHMENT_LIMIT_BYTES) {
    return browseErrorResult(context, browseError(
      "too_large",
      `the screenshot is ${bytes.byteLength} bytes, over the 32 MiB attachment limit`,
      "Capture a smaller region or use a lower-quality JPEG.",
    ));
  }
  if (screenshot.mime === "image/png" && !hasPngSignature(bytes)) {
    return browseErrorResult(context, browseError(
      "protocol_error",
      "the screenshot bytes are not a PNG",
      "Retry the screenshot; if it keeps returning non-PNG bytes, check the browser engine.",
    ));
  }

  let path: string;
  try {
    path = input.path ?? browseCaptureFilePath(worktree, screenshot.mime);
    checkedArtifactPath(worktree, path);
    ensureBrowseDirectory(browseCaptureDirectory(worktree), worktree);
    mkdirSync(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
    checkedArtifactPath(worktree, path);
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), FILE_MODE);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) {
        throw browseError("invalid_arguments", "the screenshot destination is not a private regular file", "Choose a new file path.");
      }
      checkedArtifactPath(worktree, path);
      if (process.platform !== "win32") fchmodSync(fd, FILE_MODE);
      ftruncateSync(fd, 0);
      writeFileSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (isBrowseError(error)) return browseErrorResult(context, error);
    const message = error instanceof Error ? error.message : String(error);
    return browseErrorResult(context, browseError(
      "protocol_error",
      `the screenshot could not be written under ${browseCaptureDirectory(worktree)} (${message})`,
      "Check that the worktree is writable, then retry the screenshot.",
      error,
    ));
  }

  const filename = basename(path);
  const size = screenshot.mime === "image/png" ? readPngSize(bytes) : null;
  const output = [
    `[image: ${screenshot.mime}, ${bytes.byteLength} bytes]`,
    path,
  ];
  if (size !== null) output.push(`${size.width}x${size.height} pixels`);
  return {
    title: `Screenshot: ${path}`,
    output: output.join("\n"),
    metadata: browseMetadata(context, {
      ...input.metadata,
      path,
      mime: screenshot.mime,
      bytes: bytes.byteLength,
      ...(size === null ? {} : { width: size.width, height: size.height }),
    }),
    attachments: [buildBrowseAttachment(bytes, screenshot.mime, filename)],
  };
}
