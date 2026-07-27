/**
 * Node-compatible file system helpers.
 *
 * Replaces Bun.file()-based operations with node:fs/promises equivalents
 * that work under both Bun and Node.js runtimes.
 *
 * @module
 */

import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";

/**
 * Read a text file from disk. Equivalent to `Bun.file(path).text()`.
 */
export async function readTextFile(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

/**
 * Check whether a file exists. Equivalent to `(await Bun.file(path).exists())`.
 *
 * Only a definitively-missing path (ENOENT) yields `false`. Any other failure
 * to probe the path (e.g. an invalid path like a null byte, or an inaccessible
 * directory) is rethrown so callers can distinguish "confirmed absent" from
 * "could not verify". This preserves the behavior of `Bun.file().exists()`,
 * which threw on unprobeable paths rather than silently reporting false.
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}
