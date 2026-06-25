import {
  existsSync,
  lstatSync,
  readlinkSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

// ── ANSI Colors ──────────────────────────────────────────────────

export const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
export const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
export const red = (s: string) => `\x1b[31m${s}\x1b[39m`;
export const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
export const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;
export const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
export const magenta = (s: string) => `\x1b[35m${s}\x1b[39m`;

// ── Status Symbols ───────────────────────────────────────────────

export const SYM_OK = green("✓");
export const SYM_FAIL = red("✗");
export const SYM_WARN = yellow("⚠");
export const SYM_ARROW = dim("→");
export const SYM_BULLET = dim("•");

// ── Layout Helpers ───────────────────────────────────────────────

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function padEnd(s: string, width: number): string {
  const visible = stripAnsi(s).length;
  const padding = Math.max(0, width - visible);
  return s + " ".repeat(padding);
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
    return result;
  }

  if (result.isSymlink) {
    try {
      result.target = readlinkSync(linkPath);
      try {
        statSync(linkPath);
        result.targetExists = true;
      } catch {
        result.targetExists = false;
      }
    } catch {
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
    // non-fatal: directory unreadable
  }
  return results;
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
