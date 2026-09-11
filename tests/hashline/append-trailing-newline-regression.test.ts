import { describe, it, expect, afterAll } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHashlineReadTool, createHashlineEditTool } from "../../src/hashline/index.ts";

// Regression: anchorless append on a file that ends with a trailing newline
// must not insert an extra blank line.
//
// Root cause: edit-primitives.ts applyEditsWithReport splits canonical content
// with content.split("\n"), which leaves a trailing empty element for files
// ending in "\n". applyAppend then pushes new lines after that empty element,
// so appending "line three" to "line one\nline two\n" produces
// "line one\nline two\n\nline three\n" instead of
// "line one\nline two\nline three\n".
const ORIGINAL_CONTENT = "line one\nline two\n";
const EXPECTED_AFTER_APPEND = "line one\nline two\nline three\n";

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Read the file with the hashline read tool and extract version + last-line anchor. */
async function readVersionAndLastAnchor(filePath: string): Promise<{ version: string; lastAnchor: string }> {
  const output: string = String(await createHashlineReadTool().execute({ filePath }));
  const match = output.match(/^version: (\S+)$/m);
  expect(match, "hashline_read output should contain a version header").not.toBeNull();
  const anchors = output.split("\n").filter((line) => /^\d+#[A-Za-z0-9_-]+\|/.test(line));
  expect(anchors.length, "hashline_read output should contain annotated lines").toBeGreaterThan(0);
  const lastAnchor = anchors[anchors.length - 1].split("|")[0];
  return { version: match![1], lastAnchor };
}

describe("hashline append trailing-newline regression", () => {
  it("anchorless append on a trailing-newline file does not insert an extra blank line", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "hashline-append-nl-anchorless-"));
    tmpDirs.push(tmpDir);
    const filePath = join(tmpDir, "anchorless.txt");
    await writeFile(filePath, ORIGINAL_CONTENT, "utf-8");

    const { version } = await readVersionAndLastAnchor(filePath);
    const result = await createHashlineEditTool().execute({
      files: [{ filePath, version, edits: [{ op: "append" as const, lines: "line three" }] }],
    });

    expect(result).not.toContain("Error:");
    // Fails today: the implementation writes "line one\nline two\n\nline three\n"
    // (an extra blank line) because the trailing "\n" leaves an empty trailing
    // element that applyAppend pushes after.
    expect(await readFile(filePath, "utf-8")).toBe(EXPECTED_AFTER_APPEND);
  });

  it("anchored append on a trailing-newline file appends cleanly (control case)", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "hashline-append-nl-anchored-"));
    tmpDirs.push(tmpDir);
    const filePath = join(tmpDir, "anchored.txt");
    await writeFile(filePath, ORIGINAL_CONTENT, "utf-8");

    const { version, lastAnchor } = await readVersionAndLastAnchor(filePath);
    const result = await createHashlineEditTool().execute({
      files: [{ filePath, version, edits: [{ op: "append" as const, pos: lastAnchor, lines: "line three" }] }],
    });

    expect(result).not.toContain("Error:");
    // Control case: the anchored path (applyInsertAfter) splices before the
    // trailing empty element, so this variant should already pass today.
    expect(await readFile(filePath, "utf-8")).toBe(EXPECTED_AFTER_APPEND);
  });
});
