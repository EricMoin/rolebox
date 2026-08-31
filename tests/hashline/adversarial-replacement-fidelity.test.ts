import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHashlineReadTool, createHashlineEditTool, computeLineHash } from "../../src/hashline/index.ts";

// ════════════════════════════════════════════════════════════════════
// Adversarial replacement-fidelity — what happens to the caller's
// replacement content as it travels through the pipeline. Each `it`
// asserts BYTE-FIDELITY: content the caller supplied must land on disk
// exactly as supplied, unless the tool documents a normalization.
//
// Defects under test:
//   D13 — trailing "\r" in replacement content is written verbatim, then
//         restoreFileText appends the envelope's CRLF terminator
//         (src/hashline/hash.ts:188-202), producing a DOUBLED "\r":
//         replace "two" with "x\r" on a CRLF file → "one\r\nx\r\r\n"
//         instead of "one\r\nx\r\n". The same doubling hits every line of
//         a multi-line replacement whose lines carry CRLF ("x\r\ny").
//
//   D14 — stripLinePrefixes (src/hashline/text-normalize.ts:41-43) removes
//         ANY line matching /^\d+#[A-Za-z0-9_-]{2,8}\|/ from replacement /
//         append / prepend content UNCONDITIONALLY — even when the prefix
//         is NOT a valid anchor for the file being edited (line number out
//         of range, or hash not present). Legitimate user content that
//         merely looks like an annotated line (e.g. "12#Ab|data") is
//         silently destroyed. The D4 echo-stripping guards
//         (text-normalize.ts:70-101) were tightened to require a literal
//         prefix whose content equals the anchor line; the bare prefix
//         strip never received the same anchor-validity check.
//
// Verified-correct boundaries (control cases): NFC/NFD anchor sensitivity
// (anchors are byte-fidelity — an NFC anchor must NOT validate an NFD
// line), NFD replacement round-trip, trailing whitespace in replacement
// content, NUL bytes in replacement content, tab-indent restoration.
// ════════════════════════════════════════════════════════════════════

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hashline-repl-fidelity-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const readTool = createHashlineReadTool();
const editTool = createHashlineEditTool();

async function readInfo(filePath: string): Promise<{ version: string; hashWidth: number; anchor: (n: number) => string }> {
  const out = String(await readTool.execute({ filePath }));
  const version = out.match(/^version: (\S+)$/m)?.[1];
  const hashWidth = parseInt(out.match(/^hashWidth: (\d+)$/m)?.[1] ?? "", 10);
  if (!version || !Number.isInteger(hashWidth)) throw new Error(`bad read output:\n${out}`);
  const anchors = new Map<number, string>();
  for (const line of out.split("\n")) {
    const m = line.match(/^(\d+)#([A-Za-z0-9_-]+)\|/);
    if (m) anchors.set(Number(m[1]), line.split("|")[0]);
  }
  return { version, hashWidth, anchor: (n) => anchors.get(n) ?? "" };
}

async function runEdit(filePath: string, version: string, edits: Array<Record<string, unknown>>): Promise<string> {
  return String(await editTool.execute({ files: [{ filePath, version, edits }] }));
}

describe("hashline adversarial replacement fidelity", () => {
  // ── (a) D13: CRLF file + replacement ending in "\r" ──
  it("(a) CRLF file: replace 'two' with 'x\\r' must NOT double the \\r [DEFECT: D13]", async () => {
    const fp = join(tmpDir, "a-crlf-trailing-cr.txt");
    await writeFile(fp, "one\r\ntwo\r\nthree\r\n", "utf-8");
    const { version, anchor } = await readInfo(fp);
    const r = await runEdit(fp, version, [{ pos: anchor(2), lines: "x\r" }]);
    expect(r).not.toContain("Error:");
    const disk = await readFile(fp, "utf-8");
    console.log(
      `(a) actual on disk: ${JSON.stringify(disk)} ` +
        `| D13: replacement "x\\r" written verbatim, restoreFileText appends \\r\\n → "x\\r\\r\\n" ` +
        `(hash.ts:188-202; edit-primitives.ts:52-63 keeps the \\r in the splice)`,
    );
    // Contract: one \r in the replacement → one \r on disk (line "x" + CRLF).
    expect(disk).toBe("one\r\nx\r\nthree\r\n");
  });

  // ── (b) D13b: CRLF file + multi-line replacement carrying CRLF ──
  it("(b) CRLF file: replace 'two' with 'x\\r\\ny' must not double \\r on either line [DEFECT: D13]", async () => {
    const fp = join(tmpDir, "b-crlf-multiline-cr.txt");
    await writeFile(fp, "one\r\ntwo\r\nthree\r\n", "utf-8");
    const { version, anchor } = await readInfo(fp);
    const r = await runEdit(fp, version, [{ pos: anchor(2), lines: "x\r\ny" }]);
    expect(r).not.toContain("Error:");
    const disk = await readFile(fp, "utf-8");
    console.log(
      `(b) actual on disk: ${JSON.stringify(disk)} ` +
        `| multi-line "x\\r\\ny" splits on \\n → ["x\\r","y"]; each \\r doubles against the CRLF terminator`,
    );
    expect(disk).toBe("one\r\nx\r\ny\r\nthree\r\n");
  });

  // ── (c) CONTROL: LF file + replacement ending in "\r" — byte-fidelity ──
  it("(c) LF file: replace 'two' with 'x\\r' keeps the \\r verbatim as content (control, PASS)", async () => {
    const fp = join(tmpDir, "c-lf-trailing-cr.txt");
    await writeFile(fp, "one\ntwo\nthree\n", "utf-8");
    const { version, anchor } = await readInfo(fp);
    const r = await runEdit(fp, version, [{ pos: anchor(2), lines: "x\r" }]);
    expect(r).not.toContain("Error:");
    // LF envelope: no \r expansion — the \r stays inside the line content.
    expect(await readFile(fp, "utf-8")).toBe("one\nx\r\nthree\n");
  });

  // ── (d) D14: replace content whose prefix is NOT a valid anchor ──
  it("(d) replace with '12#Ab|data' (12#Ab is not a line in the file) must preserve it [DEFECT: D14]", async () => {
    const fp = join(tmpDir, "d-prefix-replace.txt");
    await writeFile(fp, "a\nb\nc\n", "utf-8");
    const { version, anchor } = await readInfo(fp);
    const r = await runEdit(fp, version, [{ pos: anchor(2), lines: "12#Ab|data" }]);
    expect(r).not.toContain("Error:");
    const disk = await readFile(fp, "utf-8");
    console.log(
      `(d) actual on disk: ${JSON.stringify(disk)} ` +
        `| D14: stripLinePrefixes (text-normalize.ts:41-43) strips the prefix unconditionally, ` +
        `without checking that 12#Ab is a real anchor in this 3-line file`,
    );
    // Contract: "12#Ab|data" is legitimate user content — the file has no line 12,
    // so the prefix cannot be an anchor echo and must survive verbatim.
    expect(disk).toBe("a\n12#Ab|data\nc\n");
  });

  // ── (e) D14b: anchorless append content with a look-alike prefix ──
  it("(e) append '5#Cd|tail' to a 3-line file must preserve it verbatim [DEFECT: D14]", async () => {
    const fp = join(tmpDir, "e-prefix-append.txt");
    await writeFile(fp, "a\nb\nc\n", "utf-8");
    const { version } = await readInfo(fp);
    const r = await runEdit(fp, version, [{ op: "append" as const, lines: "5#Cd|tail" }]);
    expect(r).not.toContain("Error:");
    const disk = await readFile(fp, "utf-8");
    console.log(`(e) actual on disk: ${JSON.stringify(disk)}`);
    expect(disk).toBe("a\nb\nc\n5#Cd|tail\n");
  });

  // ── (f) D14c: prepend content with a look-alike prefix ──
  it("(f) prepend '9#Qw|head' must preserve it verbatim [DEFECT: D14]", async () => {
    const fp = join(tmpDir, "f-prefix-prepend.txt");
    await writeFile(fp, "a\nb\nc\n", "utf-8");
    const { version } = await readInfo(fp);
    const r = await runEdit(fp, version, [{ op: "prepend" as const, lines: "9#Qw|head" }]);
    expect(r).not.toContain("Error:");
    const disk = await readFile(fp, "utf-8");
    console.log(`(f) actual on disk: ${JSON.stringify(disk)}`);
    expect(disk).toBe("9#Qw|head\na\nb\nc\n");
  });

  // ── (g) CONTROL: non-prefix content passes through byte-exact ──
  it("(g) append 'ordinary text' passes through byte-exact (control, PASS)", async () => {
    const fp = join(tmpDir, "g-plain-append.txt");
    await writeFile(fp, "a\nb\n", "utf-8");
    const { version } = await readInfo(fp);
    const r = await runEdit(fp, version, [{ op: "append" as const, lines: "ordinary text" }]);
    expect(r).not.toContain("Error:");
    expect(await readFile(fp, "utf-8")).toBe("a\nb\nordinary text\n");
  });

  // ── (h) CONTROL: NFC anchor must NOT validate an NFD line (byte-fidelity anchors) ──
  it("(h) NFC anchor applied to an NFD line is rejected with a clean mismatch error (control, PASS)", async () => {
    const fp = join(tmpDir, "h-nfc-vs-nfd.txt");
    await writeFile(fp, "cafe\u0301\nb\n", "utf-8"); // NFD: e + combining acute
    const { version, hashWidth } = await readInfo(fp);
    const nfcHash = computeLineHash("caf\u00e9", hashWidth, 1); // NFC: precomposed é
    const r = await runEdit(fp, version, [{ pos: `1#${nfcHash}`, lines: "X" }]);
    // The anchors are byte-fidelity: NFC ≠ NFD, so the edit must fail cleanly
    // (hash mismatch), never silently edit the wrong content.
    expect(r).toContain("Error:");
    expect(await readFile(fp, "utf-8")).toBe("cafe\u0301\nb\n");
  });

  // ── (i) CONTROL: NFD replacement content round-trips byte-exact ──
  it("(i) replace with NFD content 'cafe\\u0301' lands byte-exact (control, PASS)", async () => {
    const fp = join(tmpDir, "i-nfd-replace.txt");
    await writeFile(fp, "a\nb\nc\n", "utf-8");
    const { version, anchor } = await readInfo(fp);
    const r = await runEdit(fp, version, [{ pos: anchor(2), lines: "cafe\u0301" }]);
    expect(r).not.toContain("Error:");
    expect(await readFile(fp, "utf-8")).toBe("a\ncafe\u0301\nc\n");
  });

  // ── (j) CONTROL: trailing whitespace in replacement content is preserved ──
  it("(j) replace with 'pad   ' keeps the trailing spaces (control, PASS)", async () => {
    const fp = join(tmpDir, "j-trailing-ws.txt");
    await writeFile(fp, "a\nb\nc\n", "utf-8");
    const { version, anchor } = await readInfo(fp);
    const r = await runEdit(fp, version, [{ pos: anchor(2), lines: "pad   " }]);
    expect(r).not.toContain("Error:");
    expect(await readFile(fp, "utf-8")).toBe("a\npad   \nc\n");
  });

  // ── (k) CONTROL: hash ignores trailing whitespace (documented trimEnd) ──
  it("(k) computeLineHash('foo') === computeLineHash('foo   ') — trailing whitespace is trimmed before hashing (control, PASS)", () => {
    const h1 = computeLineHash("foo", 3, 7);
    const h2 = computeLineHash("foo   ", 3, 7);
    const h3 = computeLineHash("foo\t", 3, 7);
    console.log(`(k) hash('foo')=${h1} hash('foo   ')=${h2} hash('foo\\t')=${h3}`);
    expect(h1).toBe(h2);
    expect(h1).toBe(h3);
  });

  // ── (l) CONTROL: NUL byte in replacement content round-trips ──
  it("(l) replace with 'n\\u0000l' keeps the NUL byte on disk (control, PASS)", async () => {
    const fp = join(tmpDir, "l-nul-replace.txt");
    await writeFile(fp, "a\nb\nc\n", "utf-8");
    const { version, anchor } = await readInfo(fp);
    const r = await runEdit(fp, version, [{ pos: anchor(2), lines: "n\u0000l" }]);
    expect(r).not.toContain("Error:");
    const buf = await readFile(fp);
    // "a\n" + "n\0l\n" + "c\n"
    expect([...buf]).toEqual([0x61, 0x0a, 0x6e, 0x00, 0x6c, 0x0a, 0x63, 0x0a]);
  });

  // ── (m) CONTROL: tab-indented template line restores tab indent on unindented replacement ──
  it("(m) replace on a tab-indented line restores the tab indent (control, PASS)", async () => {
    const fp = join(tmpDir, "m-tab-indent.txt");
    await writeFile(fp, "class A {\n\tmethod() {}\n}\n", "utf-8");
    const { version, anchor } = await readInfo(fp);
    const r = await runEdit(fp, version, [{ pos: anchor(2), lines: "newMethod() {}" }]);
    expect(r).not.toContain("Error:");
    expect(await readFile(fp, "utf-8")).toBe("class A {\n\tnewMethod() {}\n}\n");
  });
});
