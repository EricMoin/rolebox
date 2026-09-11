import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHashlineReadTool, createHashlineEditTool } from "../../src/hashline/index.ts";

// ════════════════════════════════════════════════════════════════════
// Adversarial trailing-newline semantics — appends/prepends/replaces on
// files ending in 0/1/2/3 trailing newlines. Each `it` asserts the
// LINE-MODEL contract: an edit adds exactly the lines it declares, and the
// file's logical line count is original + added − removed. A failing
// assertion is a defect reproduction (the implementation writes phantom
// blank lines at EOF).
//
// Contract baseline (splitLines, src/hashline/hash.ts:30-34):
//   "a\nb\n"  → ["a","b"]        (1 trailing "\n" terminates the last line)
//   "a\n\n"   → ["a",""]         (a real blank content line)
//   "a\n\n\n" → ["a","",""]      (two real blank content lines)
//
// Defect under test (D12):
//   src/hashline/hashline-edit.ts:206-210 — after computing resultContent
//   (currentLines.join("\n"), which has NO trailing newline), the edit
//   strips trailing newlines and re-applies the ORIGINAL file's trailing-
//   newline count. When the result's last line is a NEW non-empty line
//   (anchorless append, prepend past the old EOF, or replacing the final
//   blank line), the reapplied count adds the original blank-line
//   terminators AGAIN — for any original file with ≥2 trailing newlines the
//   result gains phantom blank line(s) at EOF:
//     "a\n\n"  + append "x" → "a\n\nx\n\n"  (4 lines) instead of "a\n\nx\n" (3)
//   The strip/reapply step is redundant with restoreFileText's per-line
//   terminator record (src/hashline/hash.ts:188-202), which already
//   preserves the original lines' terminators and terminates new lines with
//   the envelope's line ending; the reapplied count double-counts.
// ════════════════════════════════════════════════════════════════════

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hashline-trailing-nl-adv-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const readTool = createHashlineReadTool();
const editTool = createHashlineEditTool();

/** Read a file and return its whole-file version + per-line anchors. */
async function readInfo(filePath: string): Promise<{ version: string; anchor: (n: number) => string }> {
  const out = String(await readTool.execute({ filePath }));
  const version = out.match(/^version: (\S+)$/m)?.[1];
  if (!version) throw new Error(`no version in read output:\n${out}`);
  const anchors = new Map<number, string>();
  for (const line of out.split("\n")) {
    const m = line.match(/^(\d+)#([A-Za-z0-9_-]+)\|/);
    if (m) anchors.set(Number(m[1]), line.split("|")[0]);
  }
  return { version, anchor: (n) => anchors.get(n) ?? "" };
}

/** Run a single-file edit and return the tool result string. */
async function runEdit(filePath: string, version: string, edits: Array<Record<string, unknown>>): Promise<string> {
  return String(await editTool.execute({ files: [{ filePath, version, edits }] }));
}

describe("hashline adversarial trailing-newline semantics", () => {
  // ── (a) CONTROL: exactly one trailing newline — append is clean ──
  it("(a) 'a\\nb\\n' + append 'c' → 'a\\nb\\nc\\n' (control, PASS)", async () => {
    const fp = join(tmpDir, "a-one-nl-append.txt");
    await writeFile(fp, "a\nb\n", "utf-8");
    const { version } = await readInfo(fp);
    const r = String(await runEdit(fp, version, [{ op: "append" as const, lines: "c" }]));
    expect(r).not.toContain("Error:");
    expect(await readFile(fp, "utf-8")).toBe("a\nb\nc\n");
  });

  // ── (b) D12: two trailing newlines (real blank line) — append gains a phantom blank line ──
  it("(b) 'a\\n\\n' + append 'x' → 'a\\n\\nx\\n' (3 lines) [DEFECT: D12]", async () => {
    const fp = join(tmpDir, "b-two-nl-append.txt");
    await writeFile(fp, "a\n\n", "utf-8");
    const { version } = await readInfo(fp);
    const r = String(await runEdit(fp, version, [{ op: "append" as const, lines: "x" }]));
    expect(r).not.toContain("Error:");
    const disk = await readFile(fp, "utf-8");
    console.log(
      `(b) actual after append: ${JSON.stringify(disk)} ` +
        `| logical lines: ${disk.split("\n").length - 1} (expect 3) ` +
        `| D12: hashline-edit.ts:206-210 re-applies the original 2 trailing newlines over the join result`,
    );
    // Contract (line model): append adds exactly one line → 3 lines, "x" terminated.
    expect(disk).toBe("a\n\nx\n");
  });

  // ── (c) D12: three trailing newlines (two blank lines) — append gains two phantom blank lines ──
  it("(c) 'a\\n\\n\\n' + append 'x' → 'a\\n\\n\\nx\\n' (4 lines) [DEFECT: D12]", async () => {
    const fp = join(tmpDir, "c-three-nl-append.txt");
    await writeFile(fp, "a\n\n\n", "utf-8");
    const { version } = await readInfo(fp);
    const r = String(await runEdit(fp, version, [{ op: "append" as const, lines: "x" }]));
    expect(r).not.toContain("Error:");
    const disk = await readFile(fp, "utf-8");
    console.log(
      `(c) actual after append: ${JSON.stringify(disk)} ` +
        `| logical lines: ${disk.split("\n").length - 1} (expect 4)`,
    );
    expect(disk).toBe("a\n\n\nx\n");
  });

  // ── (d) D12: replace the FINAL blank line with content — a phantom blank line remains ──
  it("(d) 'a\\n\\n' + replace line 2 (blank) with 'x' → 'a\\nx\\n' (2 lines) [DEFECT: D12]", async () => {
    const fp = join(tmpDir, "d-replace-final-blank.txt");
    await writeFile(fp, "a\n\n", "utf-8");
    const { version, anchor } = await readInfo(fp);
    const r = String(await runEdit(fp, version, [{ pos: anchor(2), lines: "x" }]));
    expect(r).not.toContain("Error:");
    const disk = await readFile(fp, "utf-8");
    console.log(
      `(d) actual after replacing the blank line: ${JSON.stringify(disk)} ` +
        `| logical lines: ${disk.split("\n").length - 1} (expect 2)`,
    );
    expect(disk).toBe("a\nx\n");
  });

  // ── (e) CONTROL: replace a NON-final line — trailing-newline count is legitimately preserved ──
  it("(e) 'a\\n\\n' + replace line 1 with 'z' → 'z\\n\\n' (control, PASS)", async () => {
    const fp = join(tmpDir, "e-replace-first.txt");
    await writeFile(fp, "a\n\n", "utf-8");
    const { version, anchor } = await readInfo(fp);
    const r = String(await runEdit(fp, version, [{ pos: anchor(1), lines: "z" }]));
    expect(r).not.toContain("Error:");
    expect(await readFile(fp, "utf-8")).toBe("z\n\n");
  });

  // ── (f) CONTROL: prepend — the original blank line stays last, count preserved ──
  it("(f) 'a\\n\\n' + prepend 'P' → 'P\\na\\n\\n' (control, PASS)", async () => {
    const fp = join(tmpDir, "f-prepend.txt");
    await writeFile(fp, "a\n\n", "utf-8");
    const { version } = await readInfo(fp);
    const r = String(await runEdit(fp, version, [{ op: "prepend" as const, lines: "P" }]));
    expect(r).not.toContain("Error:");
    expect(await readFile(fp, "utf-8")).toBe("P\na\n\n");
  });

  // ── (g) CONTROL: no trailing newline, single line — append is clean ──
  it("(g) 'a' + append 'x' → 'a\\nx' (control, PASS)", async () => {
    const fp = join(tmpDir, "g-no-nl-append.txt");
    await writeFile(fp, "a", "utf-8");
    const { version } = await readInfo(fp);
    const r = String(await runEdit(fp, version, [{ op: "append" as const, lines: "x" }]));
    expect(r).not.toContain("Error:");
    expect(await readFile(fp, "utf-8")).toBe("a\nx");
  });

  // ── (h) CONTROL: no trailing newline, multi-line — append is clean ──
  it("(h) 'a\\nb' + append 'c' → 'a\\nb\\nc' (control, PASS)", async () => {
    const fp = join(tmpDir, "h-no-nl-multi-append.txt");
    await writeFile(fp, "a\nb", "utf-8");
    const { version } = await readInfo(fp);
    const r = String(await runEdit(fp, version, [{ op: "append" as const, lines: "c" }]));
    expect(r).not.toContain("Error:");
    expect(await readFile(fp, "utf-8")).toBe("a\nb\nc");
  });

  // ── (i) CONTROL: '\\n'-only degenerate file — append replaces the lone blank line ──
  it("(i) '\\n' + append 'x' → 'x\\n' (control, PASS — degenerate-file rule)", async () => {
    const fp = join(tmpDir, "i-nl-only-append.txt");
    await writeFile(fp, "\n", "utf-8");
    const { version } = await readInfo(fp);
    const r = String(await runEdit(fp, version, [{ op: "append" as const, lines: "x" }]));
    expect(r).not.toContain("Error:");
    expect(await readFile(fp, "utf-8")).toBe("x\n");
  });

  // ── (j) D12 anchored variant: anchored append after line 1 of a 2-trailing-newline file ──
  it("(j) 'a\\n\\n' + append after line 1 → 'a\\nx\\n\\n' (3 lines) [DEFECT: D12]", async () => {
    const fp = join(tmpDir, "j-anchored-append.txt");
    await writeFile(fp, "a\n\n", "utf-8");
    const { version, anchor } = await readInfo(fp);
    const r = String(await runEdit(fp, version, [{ op: "append" as const, pos: anchor(1), lines: "x" }]));
    expect(r).not.toContain("Error:");
    const disk = await readFile(fp, "utf-8");
    console.log(
      `(j) actual after anchored append: ${JSON.stringify(disk)} ` +
        `| logical lines: ${disk.split("\n").length - 1} (expect 3: a, x, blank)`,
    );
    // Insert after line 1 → [a, x, ""] → "a\nx\n\n" (3 lines: a, x, blank).
    expect(disk).toBe("a\nx\n\n");
  });
});
