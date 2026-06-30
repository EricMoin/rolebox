import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Single source of truth for rolebox state-file naming and workspace paths.
 * The read side (`monitor` CLI) and write side (dispatch/function/graph stores)
 * MUST derive names through this module so they cannot drift apart and produce
 * different file names for the same workspace.
 */

export const ROLEBOX_DIR = ".rolebox";
export const STATE_SUBDIR = "state";

export function shortHash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 12);
}

/**
 * Canonicalize a workspace directory so the same physical location always
 * hashes identically. `realpathSync.native` resolves symlinks (e.g. macOS
 * `/var` → `/private/var`, or a symlinked project root) so the plugin
 * (opencode's `directory`) and the CLI (`process.cwd()`) agree. Falls back to
 * the resolved path when the directory does not exist yet (realpath throws).
 */
export function normalizeWorkspaceDir(dir: string): string {
  const abs = resolve(dir);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

export function workspaceHash(dir: string): string {
  return shortHash(normalizeWorkspaceDir(dir));
}

export function stateDirFor(dir: string): string {
  return join(dir, ROLEBOX_DIR, STATE_SUBDIR);
}
