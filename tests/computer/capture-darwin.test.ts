/// <reference types="bun-types" />

/**
 * Opt-in native screen captures on macOS. ROLEBOX_CUA_NATIVE_TESTS=1 requires
 * an already authorized host and captures the current main display into a
 * temporary directory. Default module test runs skip both tests.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG_SIGNATURE, hasPngSignature, readPngSize } from "../../src/computer/png.ts";
import { readPixelScale } from "../../src/computer/capture.ts";
import { createComputerScreenshotTool } from "../../src/computer/tools.ts";
import type { CanonicalToolContext } from "../../src/platform/types.ts";

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

    // The scale a real capture states is the one this host's file records, and
    // the result may only claim a scale the bytes actually support: absent, or a
    // whole number of device pixels per screen point.
    const stated = readPixelScale(bytes);
    expect(result.metadata.pixel_scale ?? null).toBe(stated);
    if (stated !== null) {
      expect(Number.isInteger(stated)).toBe(true);
      expect(stated).toBeGreaterThanOrEqual(1);
    }

    // The conversion sentence appears exactly when the image is not in screen
    // coordinates: one extra line for a scale above 1, and never otherwise.
    const lines = (result.output as string).split("\n");
    expect(lines).toHaveLength(stated !== null && stated > 1 ? 3 : 2);
    if (stated !== null && stated > 1) {
      expect(lines[2]).toContain(`pixel_scale ${stated}`);
      expect(lines[2]).toContain("divide");
    }
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
});
