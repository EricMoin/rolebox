import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";

export async function readTextFile(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

/** Returns false only for ENOENT; permission and invalid-path errors propagate. */
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
