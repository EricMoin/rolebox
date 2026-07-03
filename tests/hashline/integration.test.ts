import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import { createHashlineReadTool, createHashlineEditTool } from "../../src/hashline/index.ts";
import { computeFileVersion, canonicalizeFileText, hashWidthForLineCount } from "../../src/hashline/hash.ts";

const BASE64_DICT = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

function computeLineHashFor(lineContent: string, hashWidth: number, lineNum: number): string {
  const trimmed = lineContent.replace(/\r/g, "").trimEnd();
  const hasSignificantChar = /[\p{L}\p{N}]/u.test(trimmed);
  const seed = hasSignificantChar ? "" : String(lineNum ?? 0);
  const hash = createHash("sha256").update(seed + trimmed).digest();
  let num = 0n;
  const bytesNeeded = Math.ceil((hashWidth * 6) / 8) + 1;
  for (let i = 0; i < bytesNeeded && i < hash.length; i++) {
    num = (num << 8n) | BigInt(hash[i]);
  }
  let result = "";
  for (let i = 0; i < hashWidth; i++) {
    const idx = Number(num % 64n);
    result = BASE64_DICT[idx] + result;
    num /= 64n;
  }
  return result;
}

async function readFileContent(fp: string) {
  const raw = await readFile(fp, "utf-8");
  const envelope = canonicalizeFileText(raw);
  const version = computeFileVersion(envelope.content);
  const norm = envelope.content.endsWith("\n") ? envelope.content.slice(0, -1) : envelope.content;
  const lines = norm === "" ? [] : norm.split("\n");
  const hw = hashWidthForLineCount(lines.length);
  return { envelope, version, lines, hw };
}

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hashline-int-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("hashline integration", () => {
  describe("end-to-end read \u2192 edit \u2192 verify", () => {
    it("reads a file, edits with anchors, and verifies the change", async () => {
      const fp = join(tmpDir, "e2e-test.txt");
      await writeFile(fp, "line one\nline two\nline three\n", "utf-8");
      const { version, lines, hw } = await readFileContent(fp);
      const hash2 = computeLineHashFor(lines[1], hw, 2);
      const result = await createHashlineEditTool().execute({
        expected_version: version,
        files: [{ filePath: fp, edits: [{ pos: `2#${hash2}`, lines: "modified line" }] }],
      });
      expect(result).not.toContain("Error:");
      const final = await readFile(fp, "utf-8");
      expect(final).toBe("line one\nmodified line\nline three\n");
    });
  });

  describe("version guard", () => {
    it("rejects edits with stale version", async () => {
      const fp = join(tmpDir, "version-guard.txt");
      await writeFile(fp, "original content\n", "utf-8");
      const { version } = await readFileContent(fp);
      await writeFile(fp, "externally modified content\n", "utf-8");
      const result = await createHashlineEditTool().execute({
        expected_version: version,
        files: [{ filePath: fp, edits: [{ pos: "1#abc", lines: "won't work" }] }],
      });
      expect(result).toContain("Error:");
      expect(result).toContain("File version mismatch");
      expect(result).toContain(version);
    });
  });

  describe("multi-file batch", () => {
    it("edits 3 files in one call, all succeed", async () => {
      const f1 = join(tmpDir, "batch-a.txt");
      const f2 = join(tmpDir, "batch-b.txt");
      const f3 = join(tmpDir, "batch-c.txt");
      const sharedContent = "line a\nline b\nline c\n";
      await writeFile(f1, sharedContent, "utf-8");
      await writeFile(f2, sharedContent, "utf-8");
      await writeFile(f3, sharedContent, "utf-8");

      const c1 = await readFileContent(f1);

      const a1 = `2#${computeLineHashFor(c1.lines[1], c1.hw, 2)}`;
      const a2 = `3#${computeLineHashFor(c1.lines[2], c1.hw, 3)}`;
      const a3 = `1#${computeLineHashFor(c1.lines[0], c1.hw, 1)}`;

      const result = await createHashlineEditTool().execute({
        expected_version: c1.version,
        files: [
          { filePath: f1, edits: [{ pos: a1, lines: "f1 mod" }] },
          { filePath: f2, edits: [{ pos: a2, lines: "f2 mod" }] },
          { filePath: f3, edits: [{ pos: a3, lines: "f3 mod" }] },
        ],
      });
      expect(result).not.toContain("Error:");
      expect(await readFile(f1, "utf-8")).toContain("f1 mod");
      expect(await readFile(f2, "utf-8")).toContain("f2 mod");
      expect(await readFile(f3, "utf-8")).toContain("f3 mod");
    });
  });

  describe("multi-file batch rollback", () => {
    it("2nd file has bad version \u2192 1st file unchanged (atomic)", async () => {
      const f1 = join(tmpDir, "rollback-a.txt");
      const f2 = join(tmpDir, "rollback-b.txt");
      await writeFile(f1, "file1 original\n", "utf-8");
      await writeFile(f2, "file2 original\n", "utf-8");

      const c1 = await readFileContent(f1);
      const c2 = await readFileContent(f2);

      const a1 = `1#${computeLineHashFor(c1.lines[0], c1.hw, 1)}`;
      const a2 = `1#${computeLineHashFor(c2.lines[0], c2.hw, 1)}`;

      await writeFile(f2, "modified externally\n", "utf-8");

      const result = await createHashlineEditTool().execute({
        expected_version: c1.version,
        files: [
          { filePath: f1, edits: [{ pos: a1, lines: "x" }] },
          { filePath: f2, edits: [{ pos: a2, lines: "y" }] },
        ],
      });
      expect(result).toContain("Error:");
      expect(result).toContain("File version mismatch");
      const final1 = await readFile(f1, "utf-8");
      expect(final1).toBe("file1 original\n");
    });
  });

  describe("large file (2000 lines, 3-char hashes)", () => {
    it("edits 10 scattered lines in a 2000-line file", async () => {
      const fp = join(tmpDir, "large-file.txt");
      const lines: string[] = [];
      for (let i = 1; i <= 2000; i++) {
        lines.push(`line ${i} val ${i * 7}`);
      }
      await writeFile(fp, lines.join("\n") + "\n", "utf-8");

      const { version, hw } = await readFileContent(fp);
      expect(hw).toBe(3);

      const editLines = [100, 250, 400, 550, 700, 900, 1100, 1400, 1700, 1950];
      const edits = editLines.map((ln) => {
        const hash = computeLineHashFor(lines[ln - 1], hw, ln);
        return { pos: `${ln}#${hash}`, lines: `EDITED ${ln}` };
      });

      const result = await createHashlineEditTool().execute({
        expected_version: version,
        files: [{ filePath: fp, edits }],
      });
      expect(result).not.toContain("Error:");

      const finalRaw = await readFile(fp, "utf-8");
      const finalLines = finalRaw.split("\n").filter((l) => l.length > 0);
      expect(finalLines.length).toBe(2000);
      for (const ln of editLines) {
        expect(finalLines[ln - 1]).toBe(`EDITED ${ln}`);
      }
    });
  });

  describe("re-anchoring", () => {
    it("read \u2192 edit \u2192 receive reanchored lines \u2192 edit again with new anchors", async () => {
      const fp = join(tmpDir, "reanchor-test.txt");
      await writeFile(fp, "a\nb\nc\n", "utf-8");

      const c1 = await readFileContent(fp);
      const a1 = `2#${computeLineHashFor(c1.lines[1], c1.hw, 2)}`;
      const r1 = await createHashlineEditTool().execute({
        expected_version: c1.version,
        files: [{ filePath: fp, edits: [{ pos: a1, lines: ["b1", "b2"] }] }],
      });
      expect(r1).not.toContain("Error:");
      expect(r1).toContain("reanchored:");

      const c2 = await readFileContent(fp);
      expect(c2.lines).toEqual(["a", "b1", "b2", "c"]);
      const a2 = `2#${computeLineHashFor(c2.lines[1], c2.hw, 2)}`;
      const r2 = await createHashlineEditTool().execute({
        expected_version: c2.version,
        files: [{ filePath: fp, edits: [{ pos: a2, lines: "B1_REVISED" }] }],
      });
      expect(r2).not.toContain("Error:");

      const final = await readFile(fp, "utf-8");
      expect(final).toBe("a\nB1_REVISED\nb2\nc\n");
    });
  });

  describe("fuzzy recovery", () => {
    it("anchor off by 1 line \u2192 detectUniformOffset auto-corrects", async () => {
      const fp = join(tmpDir, "fuzzy-test.txt");
      await writeFile(fp, "AAAA\nBBBB\nCCCC\nDDDD\nEEEE\n", "utf-8");

      const { version, lines, hw } = await readFileContent(fp);
      const hashLine3 = computeLineHashFor(lines[2], hw, 3);
      const wrongAnchor = `2#${hashLine3}`;

      const result = await createHashlineEditTool().execute({
        expected_version: version,
        files: [{ filePath: fp, edits: [{ pos: wrongAnchor, lines: "CHANGED" }] }],
      });
      expect(result).not.toContain("Error:");

      const final = await readFile(fp, "utf-8");
      expect(final).toBe("AAAA\nBBBB\nCHANGED\nDDDD\nEEEE\n");
    });
  });

  describe("hash mismatch with no uniform offset", () => {
    it("2 different mismatches with different offsets \u2192 clean error with suggestions", async () => {
      const fp = join(tmpDir, "no-uniform.txt");
      await writeFile(fp, "line A\nline B\nline C\nline D\nline E\n", "utf-8");

      const { version } = await readFileContent(fp);
      const result = await createHashlineEditTool().execute({
        expected_version: version,
        files: [{
          filePath: fp,
          edits: [
            { pos: "2#XXXX", lines: "changed B" },
            { pos: "4#YYYY", lines: "changed D" },
          ],
        }],
      });
      expect(result).toContain("Error:");
      expect(result).toContain("Hashline verification failed");
      expect(result).toContain("Line 2");
      expect(result).toContain("Line 4");
    });
  });

  describe("empty file creation", () => {
    it("anchorless append on non-existent file creates it", async () => {
      const fp = join(tmpDir, "newly-created.txt");
      const result = await createHashlineEditTool().execute({
        expected_version: "whatever",
        files: [{ filePath: fp, edits: [{ op: "append" as const, lines: "brand new content" }] }],
      });
      expect(result).not.toContain("Error:");
      expect(await readFile(fp, "utf-8")).toBe("brand new content");
    });

    it("anchor-based edit on non-existent file fails with clear error", async () => {
      const fp = join(tmpDir, "never-existed.txt");
      const result = await createHashlineEditTool().execute({
        expected_version: "whatever",
        files: [{ filePath: fp, edits: [{ pos: "1#abc", lines: "no" }] }],
      });
      expect(result).toContain("Error:");
      expect(result).toContain("File not found");
      expect(result).toContain("anchor-based");
    });
  });

  describe("delete lines", () => {
    it("replace with empty lines deletes the line", async () => {
      const fp = join(tmpDir, "delete-test.txt");
      await writeFile(fp, "keep this\ndelete this\nkeep this too\n", "utf-8");

      const { version, lines, hw } = await readFileContent(fp);
      const hash = computeLineHashFor(lines[1], hw, 2);
      const result = await createHashlineEditTool().execute({
        expected_version: version,
        files: [{ filePath: fp, edits: [{ pos: `2#${hash}`, lines: "" }] }],
      });
      expect(result).not.toContain("Error:");
      const finalContent = await readFile(fp, "utf-8");
      expect(finalContent).toBe("keep this\n\nkeep this too\n");
    });
  });

  describe("BOM and CRLF preservation", () => {
    it("edit preserves BOM and CRLF in output", async () => {
      const fp = join(tmpDir, "bom-crlf.txt");
      await writeFile(fp, "\uFEFFline1\r\nline2\r\nline3\r\n", "utf-8");

      const { version, lines, hw } = await readFileContent(fp);
      const hash = computeLineHashFor(lines[1], hw, 2);
      const result = await createHashlineEditTool().execute({
        expected_version: version,
        files: [{ filePath: fp, edits: [{ pos: `2#${hash}`, lines: "modified" }] }],
      });
      expect(result).not.toContain("Error:");

      const finalRaw = await readFile(fp, "utf-8");
      expect(finalRaw.charCodeAt(0)).toBe(0xfeff);
      expect(finalRaw).toBe("\uFEFFline1\r\nmodified\r\nline3\r\n");
    });
  });

  describe("no-op detection", () => {
    it("edit that produces identical content returns error", async () => {
      const fp = join(tmpDir, "noop-test.txt");
      await writeFile(fp, "same content\n", "utf-8");

      const { version } = await readFileContent(fp);
      const result = await createHashlineEditTool().execute({
        expected_version: version,
        files: [{ filePath: fp, edits: [{ op: "prepend" as const, lines: "" }] }],
      });
      expect(result).toContain("Error:");
      expect(result).toContain("No changes were made");
    });
  });

  describe("tool registration", () => {
    it("createHashlineReadTool returns a valid tool definition", () => {
      const readTool = createHashlineReadTool();
      expect(readTool).toBeDefined();
      expect(typeof readTool.description).toBe("string");
      expect(readTool.description.length).toBeGreaterThan(0);
      expect(typeof readTool.execute).toBe("function");
      expect(readTool.args).toBeDefined();
    });

    it("createHashlineEditTool returns a valid tool definition", () => {
      const editTool = createHashlineEditTool();
      expect(editTool).toBeDefined();
      expect(typeof editTool.description).toBe("string");
      expect(editTool.description.length).toBeGreaterThan(0);
      expect(typeof editTool.execute).toBe("function");
      expect(editTool.args).toBeDefined();
    });
  });
});
