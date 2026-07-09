/**
 * Shared helpers for memory CLI commands.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

export function resolveProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, ".rolebox"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "\u2026";
}

export function relevanceLevels(minRelevance: string): string[] {
  const order = ["high", "medium", "low"];
  const idx = order.indexOf(minRelevance);
  if (idx === -1) return ["high", "medium", "low"];
  return order.slice(0, idx + 1);
}
