import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHashlineReadTool, createHashlineEditTool } from "../../src/hashline/index.ts";

// Regression test for the exact-1000-line boundary defect.
//
// Root cause: hashline-read strips the trailing newline before splitting
// (src/hashline/hashline-read.ts:68-69), so a 1000-line file that ends with "\n"
// reports totalLines=1000 and hashWidth=2 (src/hashline/hashline-read.ts:76).
// hashline-edit, however, computes the line count as
// canonicalContent.split("\n").length = 1001 (src/hashline/hashline-edit.ts:144),
// which escalates to hashWidth=3. The width-2 anchors returned by hashline_read can
// therefore never validate ("Hashline verification failed"), and forwarding read's
// hashWidth: 2 is rejected outright as a "hashWidth mismatch"
// (src/hashline/hashline-edit.ts:148-153).
//
// This test asserts the correct behavior: a normal ~1000-line source file must be
// editable with the anchor that hashline_read itself returns. Today both
// assertions fail because the edit tool errors out instead of applying the edit.

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hashline-boundary-width-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("hashline boundary width regression (exactly 1000 lines + trailing newline)", () => {
  it("edits a 1000-line file using the anchor returned by hashline_read", async () => {
    const filePath = join(tmpDir, "boundary-1000.txt");
    // 'line 1' .. 'line 1000', terminated with a trailing '\n'
    const content =
      Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await writeFile(filePath, content, "utf-8");

    // Read the file with hashline_read and parse the envelope.
    const readTool = createHashlineReadTool();
    const readOutput = (await readTool.execute({ filePath })) as string;
    const readLines = readOutput.split("\n");

    const version = readLines
      .find((line) => line.startsWith("version: "))!
      .slice("version: ".length);
    const hashWidth = parseInt(
      readLines
        .find((line) => line.startsWith("hashWidth: "))!
        .slice("hashWidth: ".length),
      10,
    );
    // Anchor for line 500: the token before '|', starting with '500#'.
    const anchor500 = readLines
      .find((line) => line.startsWith("500#"))!
      .split("|")[0];

    // Sanity: the anchor read returns must be consistent with the width it
    // declares (holds under any future width change — no hard-coded value).
    expect(anchor500.length).toBe("500#".length + hashWidth);

    // Edit line 500 with the anchor exactly as returned by hashline_read.
    const editTool = createHashlineEditTool();
    const editResult = (await editTool.execute({
      files: [{ filePath, version, edits: [{ pos: anchor500, lines: "EDITED 500" }] }],
    })) as string;

    // (a) The edit must succeed — no error in the tool result.
    expect(editResult).not.toContain("Error:");

    // (b) The edit must have been applied on disk: line 500 == 'EDITED 500'.
    const diskContent = await readFile(filePath, "utf-8");
    expect(diskContent.split("\n")[499]).toBe("EDITED 500");
  });
});
