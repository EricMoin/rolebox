import {
  existsSync,
  lstatSync,
  readlinkSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── ANSI Colors ──────────────────────────────────────────────────

export const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
export const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
export const red = (s: string) => `\x1b[31m${s}\x1b[39m`;
export const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
export const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;
export const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
export const magenta = (s: string) => `\x1b[35m${s}\x1b[39m`;
export const white = (s: string) => `\x1b[37m${s}\x1b[39m`;

// ── TUI Color Primitives ───────────────────────────────────────────

export const gray = (s: string) => `\x1b[38;5;244m${s}\x1b[39m`;
export const soft = (s: string) => `\x1b[38;5;240m${s}\x1b[39m`;
export const border = (s: string) => `\x1b[38;5;238m${s}\x1b[39m`;
export const sub = (s: string) => `\x1b[38;5;236m${s}\x1b[39m`;
export const bright = (s: string) => `\x1b[97m${s}\x1b[39m`;

// ── Status Symbols ───────────────────────────────────────────────

export const SYM_OK = green("✓");
export const SYM_FAIL = red("✗");
export const SYM_WARN = yellow("⚠");
export const SYM_ARROW = dim("→");
export const SYM_BULLET = dim("•");

// ── Phase Status Icons ────────────────────────────────────────────

export const SYM_DISPATCH = "▶";
export const SYM_AWAIT = "◷";
export const SYM_SUMMARIZE = "◆";
export const SYM_COMPLETE = "✓";
export const SYM_ERROR = "✗";
export const SYM_CANCELLED = "⊘";

// ── Health Indicators ─────────────────────────────────────────────

export const HLTH_OK = green("●");
export const HLTH_DEGRADED = yellow("●");
export const HLTH_ERROR = red("●");

// ── Layout Helpers ───────────────────────────────────────────────

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function padEnd(s: string, width: number): string {
  const visible = stripAnsi(s).length;
  const padding = Math.max(0, width - visible);
  return s + " ".repeat(padding);
}

export function padRight(s: string, width: number): string {
  const visible = stripAnsi(s).length;
  const padding = Math.max(0, width - visible);
  return s + " ".repeat(padding);
}

/**
 * Draw a filled progress bar. Useful for showing rounds/task completion.
 * @param current — completed count
 * @param total — total count (must be > 0)
 * @param width — total character width of the bar (default 10)
 * @returns a visual bar like ■■■□□□□□□□ for 3/10
 */
export function bar(current: number, total: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((current / total) * width)));
  const empty = Math.max(0, width - filled);
  return "■".repeat(filled) + "□".repeat(empty);
}

export function printHeader(title: string): void {
  console.log("");
  console.log(bold(title));
  console.log(dim("─".repeat(50)));
}

export function printField(label: string, value: string, indent = 2): void {
  const prefix = " ".repeat(indent);
  const paddedLabel = (label + ":").padEnd(14);
  console.log(`${prefix}${dim(paddedLabel)} ${value}`);
}

// ── Symlink Utilities ────────────────────────────────────────────

export interface SymlinkStatus {
  name: string;
  path: string;
  exists: boolean;
  isSymlink: boolean;
  target: string | null;
  targetExists: boolean;
}

export function checkSymlink(linkPath: string, name: string): SymlinkStatus {
  const result: SymlinkStatus = {
    name,
    path: linkPath,
    exists: false,
    isSymlink: false,
    target: null,
    targetExists: false,
  };

  if (!existsSync(linkPath) && !lstatExists(linkPath)) {
    return result;
  }

  result.exists = true;

  try {
    const stat = lstatSync(linkPath);
    result.isSymlink = stat.isSymbolicLink();
  } catch {
    // Best-effort — UI formatting should never crash
    return result;
  }

  if (result.isSymlink) {
    try {
      result.target = readlinkSync(linkPath);
      try {
        statSync(linkPath);
        result.targetExists = true;
      } catch {
        // Best-effort — UI formatting should never crash
        result.targetExists = false;
      }
    } catch {
      // Best-effort — UI formatting should never crash
      result.target = null;
    }
  } else {
    result.targetExists = true;
  }

  return result;
}

export function listSymlinks(dir: string, prefix?: string): SymlinkStatus[] {
  if (!existsSync(dir)) return [];

  const results: SymlinkStatus[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (prefix && !entry.startsWith(prefix)) continue;
      const fullPath = join(dir, entry);
      results.push(checkSymlink(fullPath, entry));
    }
  } catch {
    // Best-effort — UI formatting should never crash
  }
  return results;
}

// ── Path Utilities ───────────────────────────────────────────────

/**
 * Replace the home directory prefix with `~` for human-readable display.
 */
export function shortenPath(p: string): string {
  const home = homedir();
  if (p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}

// ── Private ──────────────────────────────────────────────────────

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
