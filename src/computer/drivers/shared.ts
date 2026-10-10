/**
 * Small pure helpers the per-OS computer-use drivers share.
 *
 * Every function here is a pure transformation of its arguments: no helper
 * reads this host, so a plan built for another system is exactly the plan that
 * system's own command would receive.
 */

import type { ComputerRegion } from "../../platform/system/types.ts";

/** One screen rectangle in whole pixels, as a capture helper takes it. */
export interface WholeRegion {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** One sentence naming what a region request must contain. */
export const REGION_REFUSAL =
  "a capture region needs a finite x and y and a width and height of at least one pixel (values are rounded to whole pixels).";

/**
 * Round a requested region to the whole pixels every capture helper takes.
 *
 * Returns `null` when the request cannot name a real rectangle, so a builder
 * answers with {@link REGION_REFUSAL} instead of handing a helper a
 * zero-width crop it would silently accept.
 */
export function wholeRegion(region: ComputerRegion): WholeRegion | null {
  const x = Math.round(region.x);
  const y = Math.round(region.y);
  const w = Math.round(region.w);
  const h = Math.round(region.h);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w < 1 || h < 1) return null;
  return { x, y, w, h };
}

/** Quote one string for a POSIX shell as a single-quoted literal. */
export function shellQuote(text: string): string {
  return `'${text.split("'").join("'\\''")}'`;
}

/** Quote one string as a PowerShell single-quoted literal. */
export function powerShellQuote(text: string): string {
  return `'${text.split("'").join("''")}'`;
}

/**
 * Whether a requested window id can be one: the OS's own ids are positive
 * integers, and a fractional or negative value would be a caller mistake the
 * helper would report as a missing window instead.
 */
export function usableWindowId(windowId: number): boolean {
  return Number.isInteger(windowId) && windowId > 0;
}
