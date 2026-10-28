
/**
 * Opt-in native screen captures on macOS. ROLEBOX_CUA_NATIVE_TESTS=1 requires
 * an already authorized host. Captures use temporary directories and never send
 * input. Default module test runs skip all native tests.
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG_SIGNATURE, hasPngSignature, readPngSize } from "../../src/computer/png.ts";
import { createComputerDisplaysTool, createComputerScreenshotTool } from "../../src/computer/tools.ts";
import type { CanonicalToolContext } from "../../src/platform/types.ts";
import type { ComputerDisplay, ComputerRegion } from "../../src/platform/system/types.ts";

const nativeTestsEnabled = process.platform === "darwin" && process.env.ROLEBOX_CUA_NATIVE_TESTS === "1";
const worktrees: string[] = [];

function makeContext(): CanonicalToolContext {
  const worktree = mkdtempSync(join(tmpdir(), "rolebox-computer-capture-"));
  worktrees.push(worktree);
  return {
    sessionID: "session-capture",
    messageID: "message-capture",
    agent: "agent-capture",
    directory: worktree,
    worktree,
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  };
}

afterEach(() => {
  while (worktrees.length > 0) rmSync(worktrees.pop()!, { recursive: true, force: true });
});

function mixedDisplayRegion(displays: readonly ComputerDisplay[]): ComputerRegion | undefined {
  for (const a of displays) for (const b of displays) {
    if (a.id === b.id || a.scale === b.scale) continue;
    const top = Math.max(a.y, b.y);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    if (a.x + a.width === b.x && Math.min(a.width, b.width) >= 20 && bottom - top >= 20) {
      return { x: b.x - 20, y: top, w: 40, h: 20 };
    }
    const left = Math.max(a.x, b.x);
    const right = Math.min(a.x + a.width, b.x + b.width);
    if (a.y + a.height === b.y && Math.min(a.height, b.height) >= 20 && right - left >= 20) {
      return { x: left, y: b.y - 20, w: 20, h: 40 };
    }
  }
}

describe("darwin capture", () => {
  it.skipIf(!nativeTestsEnabled)("writes a real PNG under .rolebox/computer and returns it as an attachment", async () => {
    const context = makeContext();
    const result = (await createComputerScreenshotTool().execute({}, context)) as any;

    expect(result.output.startsWith("[image: image/png, ")).toBe(true);
    const path = result.metadata.path as string;
    expect(path.startsWith(join(context.worktree, ".rolebox", "computer"))).toBe(true);
    expect(result.output).toContain(path);
    expect(result.output).not.toContain("base64");

    const bytes = readFileSync(path);
    expect(bytes.subarray(0, 8).equals(Buffer.from([...PNG_SIGNATURE]))).toBe(true);
    expect(hasPngSignature(bytes)).toBe(true);
    expect(result.metadata.bytes).toBe(bytes.byteLength);
    expect(result.metadata.driver).toBe("screencapture");

    const size = readPngSize(bytes);
    expect(size).not.toBeNull();
    expect(size!.width).toBe(result.metadata.width);
    expect(size!.height).toBe(result.metadata.height);
    expect(size!.width).toBeGreaterThan(0);
    expect(size!.height).toBeGreaterThan(0);

    const bounds = result.metadata.screen_bounds;
    expect(bounds.w).toBeGreaterThan(0);
    expect(bounds.h).toBeGreaterThan(0);
    expect(result.metadata.origin).toEqual({ x: bounds.x, y: bounds.y });
    expect(result.metadata.pixel_scale_x).toBe(size!.width / bounds.w);
    expect(result.metadata.pixel_scale_y).toBe(size!.height / bounds.h);
    expect(result.metadata.displays.length).toBeGreaterThan(0);
    expect(result.metadata.screenshot_id).toBeTypeOf("string");
  });

  it.skipIf(!nativeTestsEnabled)("creates the capture directory owner-only", () => {
    const context = makeContext();
    return createComputerScreenshotTool()
      .execute({}, context)
      .then(() => {
        const directory = join(context.worktree, ".rolebox", "computer");
        expect(existsSync(directory)).toBe(true);
        expect(statSync(directory).mode & 0o777).toBe(0o700);
      });
  });

  it.skipIf(!nativeTestsEnabled)("maps a real secondary-display capture to its screen origin", async test => {
    const context = makeContext();
    const listing = await createComputerDisplaysTool().execute({}, context) as any;
    expect(listing.output).not.toMatch(/^Error:/);
    const displays = listing.metadata.displays as ComputerDisplay[];
    const secondary = displays.find(display => !display.primary);
    if (secondary === undefined) return test.skip("requires two connected displays");
    const result = await createComputerScreenshotTool().execute({ display: secondary.id }, context) as any;
    expect(result.output).not.toMatch(/^Error:/);
    if (JSON.stringify(result.metadata.displays) !== JSON.stringify(displays)) return test.skip("display layout changed during the native test");
    expect(result.metadata.origin).toEqual({ x: secondary.x, y: secondary.y });
    expect(result.metadata.screen_bounds).toEqual({ x: secondary.x, y: secondary.y, w: secondary.width, h: secondary.height });
    const size = readPngSize(readFileSync(result.metadata.path))!;
    expect(result.metadata.pixel_scale_x).toBe(size.width / secondary.width);
    expect(result.metadata.pixel_scale_y).toBe(size.height / secondary.height);
    expect(result.metadata.screenshot_id).toBeTypeOf("string");
  });

  it.skipIf(!nativeTestsEnabled)("maps a real region spanning adjacent displays with different scaling", async test => {
    const context = makeContext();
    const listing = await createComputerDisplaysTool().execute({}, context) as any;
    expect(listing.output).not.toMatch(/^Error:/);
    const displays = listing.metadata.displays as ComputerDisplay[];
    const region = mixedDisplayRegion(displays);
    if (region === undefined) return test.skip("requires adjacent displays with different backing scales");
    const result = await createComputerScreenshotTool().execute({ region }, context) as any;
    expect(result.output).not.toMatch(/^Error:/);
    if (JSON.stringify(result.metadata.displays) !== JSON.stringify(displays)) return test.skip("display layout changed during the native test");
    expect(result.metadata.origin).toEqual({ x: region.x, y: region.y });
    expect(result.metadata.screen_bounds).toEqual(region);
    const size = readPngSize(readFileSync(result.metadata.path))!;
    expect(result.metadata.pixel_scale_x).toBe(size.width / region.w);
    expect(result.metadata.pixel_scale_y).toBe(size.height / region.h);
    expect(result.metadata.screenshot_id).toBeTypeOf("string");
  });
});
