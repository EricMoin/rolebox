/// <reference types="bun-types" />

/**
 * One REAL, harmless capture on macOS: the proof that a plan built for darwin
 * actually produces a PNG when it is executed.
 *
 * The capture writes into a throwaway worktree under the system temp directory
 * and photographs the screen without any input — no click, no keystroke — so
 * running the suite cannot disturb the machine it runs on. Every other platform
 * skips both tests.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG_SIGNATURE, hasPngSignature, readPngSize } from "../../src/computer/png.ts";
import { createComputerScreenshotTool } from "../../src/computer/tools.ts";
import type { CanonicalToolContext } from "../../src/platform/types.ts";

const onDarwin = process.platform === "darwin";
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
  it.skipIf(!onDarwin)("writes a real PNG under .rolebox/computer and returns it as an attachment", async () => {
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
  });

  it.skipIf(!onDarwin)("creates the capture directory owner-only", () => {
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
