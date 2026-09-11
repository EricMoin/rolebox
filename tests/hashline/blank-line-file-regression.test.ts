import { describe, it, expect, afterAll } from "bun:test";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { createHashlineReadTool, formatReadOutput } from "../../src/hashline/hashline-read.ts";
import { createHashlineEditTool } from "../../src/hashline/hashline-edit.ts";

// ── Fixtures ──────────────────────────────────────────────────────
//
// Regression target: a file whose content is exactly "\n" — a single blank
// line. It is a one-line file and must be treated as such everywhere.

const tmpRoot = join(tmpdir(), `blank-line-file-regression-${randomBytes(4).toString("hex")}`);
const filePath = join(tmpRoot, "single-blank-line.txt");

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ── Regression tests ──────────────────────────────────────────────
//
// Known defects being pinned down (do NOT "fix" the implementation — this
// suite documents the correct behavior and is expected to fail until the
// underlying bug is resolved):
//   1. hashline-read.ts:68-69 treats content "\n" as an empty string
//      (endsWith("\n") strips the only character) → totalLines: 0, no 1# anchor.
//   2. hashline-edit.ts:144 counts "\n" as 2 lines (split("\n") → ["", ""]);
//      the trailing empty element makes an anchorless append produce
//      "\n\nx\n" instead of "x\n".

describe("blank-line file regression (content exactly '\\n')", () => {
  it("(a) read: a one-line file must report totalLines: 1 with a 1# anchor", () => {
    const out = formatReadOutput("\n", "/tmp/fake.txt");
    expect(out).toContain("totalLines: 1");
    expect(out).toMatch(/^1#/m);
  });

  it("(b) edit: anchorless append on a single-blank-line file must not fabricate a leading blank line", async () => {
    await mkdir(tmpRoot, { recursive: true });
    await writeFile(filePath, "\n", "utf-8");

    // Read the file through the real tool to obtain its version.
    const readOut = (await createHashlineReadTool().execute(
      { filePath },
      {
        sessionID: "test",
        messageID: "test",
        agent: "test",
        directory: tmpRoot,
        worktree: tmpRoot,
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
      },
    )) as string;
    const version = readOut.match(/^version: ([0-9a-f]{64})$/m)?.[1];
    expect(version).toBeDefined();

    // Anchorless append "x" at EOF. Result must be "x\n" — the file's single
    // blank line is just the terminator, not a line that precedes the append.
    const editOut = await createHashlineEditTool().execute({
      files: [{ filePath, version: version!, edits: [{ op: "append" as const, lines: "x" }] }],
    });
    expect(editOut).not.toContain("Error:");

    expect(await readFile(filePath, "utf-8")).toBe("x\n");
  });
});
