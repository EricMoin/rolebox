import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { createHashlineReadTool, createHashlineEditTool, resolveHashlinePath } from "../../src/hashline/index.ts";
import type { CanonicalToolContext } from "../../src/platform/types.ts";

function makeContext(directory: string): CanonicalToolContext {
  return {
    sessionID: "test-session",
    messageID: "test-message",
    agent: "test-agent",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    async ask() {},
  };
}

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hashline-relpath-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("hashline session-relative path resolution", () => {
  it("resolveHashlinePath passes absolute paths through and joins relative paths to the session directory", () => {
    const abs = resolve(tmpDir, "x.txt");
    expect(resolveHashlinePath(abs, makeContext(tmpDir))).toBe(abs);
    expect(resolveHashlinePath("sub/x.txt", makeContext(tmpDir))).toBe(join(tmpDir, "sub/x.txt"));
  });

  it("(a) hashline_read resolves a RELATIVE filePath against context.directory", async () => {
    const abs = join(tmpDir, "a-relative.txt");
    await writeFile(abs, "alpha\nbeta\n", "utf-8");

    const result = await createHashlineReadTool().execute(
      { filePath: "a-relative.txt" },
      makeContext(tmpDir),
    );

    expect(result).not.toContain("Error: File not found");
    const lines = (result as string).split("\n");
    expect(lines[0]).toMatch(/^version: [0-9a-f]{64}$/);
    expect(lines[1]).toMatch(/^hashWidth: \d+$/);
    expect(lines[2]).toBe("totalLines: 2");
    expect(lines[3]).toMatch(/^1#[A-Za-z0-9_-]+\|alpha$/);
    expect(lines[4]).toMatch(/^2#[A-Za-z0-9_-]+\|beta$/);
  });

  it("(b) an ABSOLUTE filePath yields the same output as the relative form", async () => {
    const abs = join(tmpDir, "b-absolute.txt");
    await writeFile(abs, "one\ntwo\nthree\n", "utf-8");

    const tool = createHashlineReadTool();
    const relative = await tool.execute({ filePath: "b-absolute.txt" }, makeContext(tmpDir));
    const absolute = await tool.execute({ filePath: abs }, makeContext(tmpDir));

    expect(typeof absolute).toBe("string");
    expect(absolute).toBe(relative);
  });

  it("(c) hashline_read and hashline_edit resolve the same relative path to the same physical file", async () => {
    const relative = "c-shared.txt";
    const abs = join(tmpDir, relative);
    await writeFile(abs, "first\nsecond\n", "utf-8");

    const readResult = (await createHashlineReadTool().execute(
      { filePath: relative },
      makeContext(tmpDir),
    )) as string;
    expect(readResult).not.toContain("Error");

    const version = readResult.match(/^version: ([0-9a-f]{64})$/m)?.[1];
    const anchor = readResult.match(/^1#([A-Za-z0-9_-]+)\|first$/m)?.[1];
    expect(typeof version).toBe("string");
    expect(typeof anchor).toBe("string");

    const editResult = (await createHashlineEditTool().execute(
      {
        files: [
          {
            filePath: relative,
            version: version!,
            edits: [{ op: "replace", pos: `1#${anchor}`, lines: "FIRST" }],
          },
        ],
      },
      makeContext(tmpDir),
    )) as string;
    expect(editResult).not.toContain("Error");

    // The anchor version check would have failed had edit resolved to a
    // different physical path; the on-disk content at <directory>/<relative>
    // proves both tools landed on the same file.
    expect(await readFile(abs, "utf-8")).toBe("FIRST\nsecond\n");
  });
});
