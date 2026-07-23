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
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
