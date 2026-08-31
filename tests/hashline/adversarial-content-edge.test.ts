import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHashlineReadTool, createHashlineEditTool, computeLineHash } from "../../src/hashline/index.ts";

// ── Adversarial content-edge suite ─────────────────────────────────
//
// Pins down the correct contract for hostile file content: mixed line
// endings, a missing trailing newline, over-long lines, multibyte
// characters, NUL / invalid UTF-8, degenerate empty files, and
// out-of-range window reads. Each `it` asserts the contract — a failing
// assertion is a defect reproduction, and the actual behavior is recorded
// via console.log for the report.
//
// Known defects pinned down here (do NOT "fix" the implementation):
//   D9  — src/hashline/hashline-read.ts:84-97 computes the window as
//         effectiveEnd = min(start + limit - 1, totalLines) without clamping
//         effectiveStart, so offset > totalLines yields startLine > endLine
//         with zero annotated lines.
//   D10 — src/hashline/hash.ts:124-138/146-150 canonicalizes CRLF to "\n"
//         (line 131) and restoreFileText re-expands EVERY "\n" back to "\r\n"
//         (line 149), so a mixed CRLF+LF file has its embedded LF-only lines
//         rewritten to CRLF on the first edit.

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hashline-content-edge-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const readTool = createHashlineReadTool();
const editTool = createHashlineEditTool();

/** Full read; returns the version, declared hashWidth, and raw output. */
async function readFull(filePath: string): Promise<{ version: string; hashWidth: number; output: string }> {
  const output = String(await readTool.execute({ filePath }));
  const version = output.match(/^version: (\S+)$/m)?.[1];
  const hashWidth = parseInt(output.match(/^hashWidth: (\d+)$/m)?.[1] ?? "", 10);
  expect(version, "read output should contain a version header").toBeDefined();
  expect(Number.isInteger(hashWidth), "read output should contain a numeric hashWidth").toBe(true);
  return { version: version!, hashWidth, output };
}

/** Extract the bare "LINE#HASH" anchor for a line number from read output. */
function anchorAt(output: string, line: number): string {
  const annotated = output.split("\n").find((l) => l.startsWith(`${line}#`));
  expect(annotated, `read output should contain an annotated line ${line}`).toBeDefined();
  return annotated!.split("|")[0];
}

describe("hashline adversarial content-edge", () => {
  // ── (a) CRLF round-trip ──────────────────────────────────────────
  it("(a) CRLF file: edit preserves CRLF line endings on every line", async () => {
    const filePath = join(tmpDir, "a-crlf.txt");
    await writeFile(filePath, "alpha\r\nbravo\r\ngamma\r\n", "utf-8");

    const { version, output } = await readFull(filePath);
    const anchor = anchorAt(output, 2);
    const result = String(
      await editTool.execute({
        files: [{ filePath, version, edits: [{ pos: anchor, lines: "CHANGED" }] }],
      }),
    );
    expect(result).not.toContain("Error:");

    const disk = await readFile(filePath, "utf-8");
    expect(disk).toBe("alpha\r\nCHANGED\r\ngamma\r\n");
    // No bare-LF line terminator anywhere (all "\n" must be part of "\r\n").
    expect(disk.split("\r\n").join("")).not.toContain("\n");
  });

  // ── (b) mixed CRLF+LF — D10 ──────────────────────────────────────
  it("(b) mixed CRLF+LF file: original per-line line endings preserved (D10)", async () => {
    const filePath = join(tmpDir, "b-mixed.txt");
    // line1 CRLF, line2 LF, line3 CRLF, line4 LF (EOF terminator, no CR).
    await writeFile(filePath, "one\r\ntwo\nthree\r\nfour\n", "utf-8");

    const { version, output } = await readFull(filePath);
    const anchor = anchorAt(output, 2);
    const result = String(
      await editTool.execute({
        files: [{ filePath, version, edits: [{ pos: anchor, lines: "TWO" }] }],
      }),
    );
    expect(result).not.toContain("Error:");

    const disk = await readFile(filePath, "utf-8");
    const bareLfCount = (disk.match(/(?<!\r)\n/g) ?? []).length;
    console.log(
      `(b) actual after edit: ${JSON.stringify(disk)} | bare-LF lines remaining: ${bareLfCount} ` +
        `| D10: canonicalize normalizes CRLF→LF (hash.ts:131), restoreFileText re-expands ALL \\n→\\r\\n (hash.ts:149)`,
    );
    // Correct contract: untouched lines keep their original terminator bytes —
    // line 3 stays CRLF, line 4 keeps its bare-LF EOF terminator.
    expect(disk).toBe("one\r\nTWO\nthree\r\nfour\n");
  });

  // ── (c) no trailing newline ──────────────────────────────────────
  it("(c) file without trailing newline: edit keeps it without trailing newline", async () => {
    const filePath = join(tmpDir, "c-no-trailing.txt");
    await writeFile(filePath, "first\nsecond", "utf-8");

    const { version, output } = await readFull(filePath);
    const anchor = anchorAt(output, 1);
    const result = String(
      await editTool.execute({
        files: [{ filePath, version, edits: [{ pos: anchor, lines: "CHANGED" }] }],
      }),
    );
    expect(result).not.toContain("Error:");
    expect(await readFile(filePath, "utf-8")).toBe("CHANGED\nsecond");
  });

  // ── (d) line > 2000 chars ────────────────────────────────────────
  it("(d) line >2000 chars: display truncated, anchor hashed from full text, edit succeeds", async () => {
    const longLine = "x".repeat(2500) + "END";
    const filePath = join(tmpDir, "d-long-line.txt");
    await writeFile(filePath, longLine + "\nsecond\n", "utf-8");

    const { version, hashWidth, output } = await readFull(filePath);
    const annotated = output.split("\n").find((l) => l.startsWith("1#"))!;
    // Display contract: content over 2000 chars is display-truncated.
    expect(annotated).toContain("...");
    expect(annotated.length).toBeLessThan("1#".length + hashWidth + 1 + longLine.length);

    // Anchor contract: the hash derives from the FULL line content, not the display.
    const anchor = annotated.split("|")[0];
    const anchorHash = anchor.split("#")[1];
    expect(anchorHash).toBe(computeLineHash(longLine, hashWidth, 1));

    const result = String(
      await editTool.execute({
        files: [{ filePath, version, edits: [{ pos: anchor, lines: "EDITED" }] }],
      }),
    );
    expect(result).not.toContain("Error:");
    expect((await readFile(filePath, "utf-8")).split("\n")[0]).toBe("EDITED");
  });

  // ── (e) emoji / combining chars ──────────────────────────────────
  it("(e) emoji + combining-char line: content preserved byte-for-byte through edit of another line", async () => {
    const emojiLine = "👨‍👩‍👧‍👦 cafe\u0301 e\u0301 e\u0301n"; // ZWJ family + combining acute accents
    const filePath = join(tmpDir, "e-emoji.txt");
    await writeFile(filePath, emojiLine + "\nplain\n", "utf-8");
    const originalBytes = await readFile(filePath);

    const { version, output } = await readFull(filePath);
    const anchor = anchorAt(output, 2);
    const result = String(
      await editTool.execute({
        files: [{ filePath, version, edits: [{ pos: anchor, lines: "EDITED2" }] }],
      }),
    );
    expect(result).not.toContain("Error:");

    const diskBuf = await readFile(filePath);
    const line1Bytes = Buffer.byteLength(emojiLine) + 1; // emoji line + '\n'
    // Byte-for-byte: untouched line 1's UTF-8 bytes are identical.
    expect(diskBuf.subarray(0, line1Bytes).equals(originalBytes.subarray(0, line1Bytes))).toBe(true);
    expect(diskBuf.toString("utf-8")).toBe(emojiLine + "\nEDITED2\n");
  });

  it("(e2) surrogate pair at 2000-char truncation boundary: anchor stays valid (display may split the pair)", async () => {
    // Position a surrogate pair so that slice(0, 1997) cuts between the high
    // (U+D83D) and low (U+DE00) surrogates.
    const boundaryLine = "a".repeat(1996) + "\uD83D\uDE00" + "tail";
    const filePath = join(tmpDir, "e2-surrogate-boundary.txt");
    await writeFile(filePath, boundaryLine + "\nsecond\n", "utf-8");

    const { version, hashWidth, output } = await readFull(filePath);
    const annotated = output.split("\n").find((l) => l.startsWith("1#"))!;
    expect(annotated).toContain("...");
    const displayContent = annotated.slice(annotated.indexOf("|") + 1);
    console.log(
      `(e2) display tail: ${JSON.stringify(displayContent.slice(-6))} ` +
        `— display truncation may split a surrogate pair (hash still covers full line)`,
    );

    const anchor = annotated.split("|")[0];
    expect(anchor.split("#")[1]).toBe(computeLineHash(boundaryLine, hashWidth, 1));
    const result = String(
      await editTool.execute({
        files: [{ filePath, version, edits: [{ pos: anchor, lines: "EDITED" }] }],
      }),
    );
    expect(result).not.toContain("Error:");
    expect((await readFile(filePath, "utf-8")).split("\n")[0]).toBe("EDITED");
  });

  // ── (f) NUL byte / invalid UTF-8 ─────────────────────────────────
  it("(f1) NUL byte in content: no crash, edit works, NUL preserved on untouched lines", async () => {
    const filePath = join(tmpDir, "f1-nul.txt");
    await writeFile(filePath, Buffer.from([0x61, 0x00, 0x62, 0x0a, 0x63, 0x0a])); // "a\0b\nc\n"

    const { version, output } = await readFull(filePath);
    // Record: read succeeds and the NUL byte round-trips through the decoder.
    expect(output).toContain("\u0000");

    const anchor = anchorAt(output, 2);
    const result = String(
      await editTool.execute({
        files: [{ filePath, version, edits: [{ pos: anchor, lines: "changed" }] }],
      }),
    );
    expect(result).not.toContain("Error:");
    // NUL byte on the untouched line 1 survives byte-for-byte.
    const diskBuf = await readFile(filePath);
    expect([...diskBuf]).toEqual([0x61, 0x00, 0x62, 0x0a, 0x63, 0x68, 0x61, 0x6e, 0x67, 0x65, 0x64, 0x0a]);
  });

  it("(f2) invalid UTF-8 bytes: no crash / clean error or safe handling (actual recorded)", async () => {
    const filePath = join(tmpDir, "f2-invalid-utf8.bin");
    await writeFile(filePath, Buffer.from([0x61, 0xff, 0xfe, 0x62, 0x0a, 0x63, 0x0a]));

    const { version, output } = await readFull(filePath);
    const anchor = anchorAt(output, 2);
    const result = String(
      await editTool.execute({
        files: [{ filePath, version, edits: [{ pos: anchor, lines: "changed" }] }],
      }),
    );
    // Contract: must never crash — the tool always returns a string result.
    expect(typeof result).toBe("string");

    const diskBuf = await readFile(filePath);
    const preserved = diskBuf[1] === 0xff && diskBuf[2] === 0xfe;
    console.log(
      `(f2) actual: read OK (invalid bytes decoded to U+FFFD), edit OK; ` +
        `original [0xff,0xfe] on untouched line1 preserved byte-for-byte: ${preserved} ` +
        `(post-edit bytes: ${JSON.stringify([...diskBuf])})`,
    );
  });

  // ── (g) degenerate files ─────────────────────────────────────────
  it("(g1) empty file: read reports 0 lines, anchorless append creates content", async () => {
    const filePath = join(tmpDir, "g1-empty.txt");
    await writeFile(filePath, "", "utf-8");

    const { version, output } = await readFull(filePath);
    expect(output).toContain("totalLines: 0");

    const result = String(
      await editTool.execute({
        files: [{ filePath, version, edits: [{ op: "append" as const, lines: "appended" }] }],
      }),
    );
    expect(result).not.toContain("Error:");
    // Recorded actual: trailing-newline count (0) is preserved, so the appended
    // content carries no trailing "\n" — consistent with the (c) invariant.
    expect(await readFile(filePath, "utf-8")).toBe("appended");
  });

  it("(g2) '\\n'-only file: read reports 1 line, append 'x' yields 'x\\n'", async () => {
    const filePath = join(tmpDir, "g2-nl-only.txt");
    await writeFile(filePath, "\n", "utf-8");

    const { version, output } = await readFull(filePath);
    expect(output).toContain("totalLines: 1");

    const result = String(
      await editTool.execute({
        files: [{ filePath, version, edits: [{ op: "append" as const, lines: "x" }] }],
      }),
    );
    expect(result).not.toContain("Error:");
    expect(await readFile(filePath, "utf-8")).toBe("x\n");
  });

  it("(g3) single-line file (no trailing newline): replace works", async () => {
    const filePath = join(tmpDir, "g3-single.txt");
    await writeFile(filePath, "hello", "utf-8");

    const { version, output } = await readFull(filePath);
    const anchor = anchorAt(output, 1);
    const result = String(
      await editTool.execute({
        files: [{ filePath, version, edits: [{ pos: anchor, lines: "goodbye" }] }],
      }),
    );
    expect(result).not.toContain("Error:");
    expect(await readFile(filePath, "utf-8")).toBe("goodbye");
  });

  // ── (h) window read offset > totalLines — D9 ─────────────────────
  it("(h) window read with offset > totalLines: endLine must be >= startLine (D9)", async () => {
    const filePath = join(tmpDir, "h-offset-over.txt");
    await writeFile(filePath, "a\nb\nc\nd\ne\n", "utf-8");

    const output = String(await readTool.execute({ filePath, offset: 10, limit: 4 }));
    const startLine = parseInt(output.match(/^startLine: (\d+)$/m)?.[1] ?? "", 10);
    const endLine = parseInt(output.match(/^endLine: (\d+)$/m)?.[1] ?? "", 10);
    const dataLines = output.split("\n").filter((l) => /^\d+#/.test(l));
    console.log(
      `(h) actual: startLine=${startLine} endLine=${endLine} annotatedLines=${dataLines.length} ` +
        `| D9: effectiveEnd=min(start+limit-1, totalLines) with unclamped start ` +
        `(hashline-read.ts:84-97) → endLine<startLine with zero data lines`,
    );
    // Correct contract: a window must never report endLine < startLine with no data.
    expect(endLine).toBeGreaterThanOrEqual(startLine);
  });

  // ── (i) 30000-line file, windowed edit ───────────────────────────
  it("(i) 30000-line file: window read (offset 15000, limit 4, hashWidth 4) then edit line in window", async () => {
    const filePath = join(tmpDir, "i-30000.txt");
    const content = Array.from({ length: 30000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await writeFile(filePath, content, "utf-8");

    const windowOut = String(await readTool.execute({ filePath, offset: 15000, limit: 4 }));
    const version = windowOut.match(/^version: (\S+)$/m)?.[1]!;
    const hashWidth = parseInt(windowOut.match(/^hashWidth: (\d+)$/m)?.[1]!, 10);
    expect(hashWidth).toBe(4); // >10000 lines → width 4
    expect(windowOut).toContain("totalLines: 30000");
    expect(windowOut).toContain("startLine: 15000");
    expect(windowOut).toContain("endLine: 15003");

    const anchor = anchorAt(windowOut, 15001);
    expect(anchor.length).toBe("15001#".length + hashWidth);

    const result = String(
      await editTool.execute({
        files: [{ filePath, version, edits: [{ pos: anchor, lines: "EDITED BIG" }] }],
      }),
    );
    expect(result).not.toContain("Error:");

    const disk = await readFile(filePath, "utf-8");
    expect(disk.split("\n")[15000]).toBe("EDITED BIG");
    // 30000 lines + trailing newline → 30001 split elements (last empty).
    expect(disk.split("\n")).toHaveLength(30001);
  });
});
