import { isAbsolute, join } from "node:path";
import type { CanonicalToolContext } from "../platform/types.ts";

/**
 * Resolve a tool-input file path against the session workspace.
 *
 * hashline tools accept a `filePath` chosen by the model, which may be relative.
 * Node resolves bare relative paths against the HOST process cwd, not the
 * session's workspace — so a relative read/edit could land on a different
 * physical file than the session expects. This helper makes both tools agree on
 * one interpretation: absolute inputs pass through unchanged; relative inputs
 * resolve against `context.directory` (falling back to `context.worktree`, then
 * `process.cwd()`), the same value the canonical context populates from
 * `session.header.cwd`.
 */
export function resolveHashlinePath(
  filePath: string,
  context?: Pick<CanonicalToolContext, "directory" | "worktree"> | null,
): string {
  if (isAbsolute(filePath)) return filePath;
  const base = context?.directory || context?.worktree || process.cwd();
  return join(base, filePath);
}
