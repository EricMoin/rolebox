import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { browseError } from "./types.ts";

/** Refuse artifact paths outside the worktree or through a symbolic link below its root. */
export function checkedArtifactPath(worktree: string, path: string): string {
  const root = resolve(worktree);
  const target = resolve(path);
  const inside = relative(root, target);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw browseError("invalid_arguments", "the artifact path escapes the worktree", "Choose a file inside the worktree.");
  }
  let current = realpathSync(root);
  for (const component of inside.split(sep)) {
    current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw browseError("invalid_arguments", "the artifact path contains a symbolic link", "Choose a path without symbolic links below the worktree root.");
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") break;
      throw error;
    }
  }
  return target;
}
