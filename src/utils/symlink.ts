import * as fs from "node:fs";
import * as path from "node:path";
import { createSubLogger, formatError } from "../logger.ts";
import { getPlatform } from "../cli/paths.ts";

const log = createSubLogger("symlink");

/** Resolve the platform through the shared seam (testable via setPlatformForTest). */
function isWindows(): boolean {
  return getPlatform() === "win32";
}

/**
 * Create a directory symlink at `link` pointing to `target`.
 *
 * On Windows this uses a junction (type `"junction"`) instead of a `"dir"`
 * symlink. Junctions do NOT require admin rights or Developer Mode (a `"dir"`
 * symlink throws EPERM without them), so this keeps skill/role syncing working
 * on un-elevated Windows CI. Junctions require an absolute `target` and only
 * work for directories on NTFS volumes. On other platforms a plain symlink is
 * created.
 *
 * An EPERM failure is logged with an actionable message and then rethrown —
 * never silently swallowed.
 */
export function createDirSymlink(target: string, link: string): void {
  try {
    if (isWindows()) {
      // Junctions require an absolute native drive path. skill filePaths are
      // POSIX-normalized, so dirname-derived targets carry forward slashes on
      // win32; normalize to native separators before handing to libuv.
      fs.symlinkSync(path.win32.resolve(target), path.win32.resolve(link), "junction");
    } else {
      fs.symlinkSync(target, link);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      log.warn(
        `Failed to create directory symlink ${link} -> ${target} (EPERM). ` +
          `On Windows, ensure the target is an absolute path (junctions require it); ` +
          `on Unix, the filesystem or mount may not permit symlinks.`,
        { target, link, error: formatError(err) },
      );
    }
    throw err;
  }
}

/**
 * Create a file symlink at `link` pointing to `target`.
 *
 * On Windows the type argument is passed as `"file"`; on other platforms a
 * plain symlink is created (the type argument is ignored there).
 *
 * An EPERM failure is logged with an actionable message and then rethrown —
 * never silently swallowed.
 */
export function createFileSymlink(target: string, link: string): void {
  try {
    if (isWindows()) {
      fs.symlinkSync(path.win32.resolve(target), path.win32.resolve(link), "file");
    } else {
      fs.symlinkSync(target, link);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      log.warn(
        `Failed to create file symlink ${link} -> ${target} (EPERM). ` +
          `On Windows, creating file symlinks requires Developer Mode or admin rights; ` +
          `on Unix, the filesystem or mount may not permit symlinks.`,
        { target, link, error: formatError(err) },
      );
    }
    throw err;
  }
}

/**
 * Return whether `p` is a symbolic link, or `false` if `p` does not exist.
 *
 * Uses lstat (not stat) so the link itself is inspected rather than followed.
 * Node reports Windows junctions as symbolic links, so this lstat-based
 * detection keeps working across platforms. Only a definitively-missing path
 * (ENOENT) yields `false`; any other failure is rethrown.
 */
export function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
