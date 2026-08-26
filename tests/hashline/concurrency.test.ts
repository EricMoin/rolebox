import { describe, it, expect } from "bun:test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, createHash } from "node:crypto";

import { createHashlineEditTool } from "../../src/hashline/index.ts";
import { verifyFileUnchanged } from "../../src/hashline/atomic-write.ts";
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
  return { version, lines, hw };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = join(tmpdir(), `hashline-conc-${randomBytes(4).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// These tests are deterministic by construction: they rely on lock FIFO order
// and the pre-write recheck seam, never on setTimeout/sleep/polling. The only
// timeouts involved are the test framework's own per-test limits.

describe("hashline_edit concurrency", () => {
  describe("collaborative same-file double write", () => {
    it("serializes concurrent edits to one file — the first write lands, the stale second fails, nothing is lost", async () => {
      await withTempDir(async (dir) => {
        const fp = join(dir, "coop.txt");
        await writeFile(fp, "line one\nline two\nline three\n", "utf-8");
        const { version, lines, hw } = await readFileContent(fp);
        const hash2 = computeLineHashFor(lines[1], hw, 2);
        const hash3 = computeLineHashFor(lines[2], hw, 3);

        const [r1, r2] = await Promise.all([
          createHashlineEditTool().execute({
            files: [{ filePath: fp, version, edits: [{ pos: `2#${hash2}`, lines: "EDITED BY ONE" }] }],
          }),
          createHashlineEditTool().execute({
            files: [{ filePath: fp, version, edits: [{ pos: `3#${hash3}`, lines: "EDITED BY TWO" }] }],
          }),
        ]);

        const ok = [r1, r2].filter((r) => !r.includes("Error:"));
        const failed = [r1, r2].filter((r) => r.includes("Error:"));
        expect(ok).toHaveLength(1);
        expect(failed).toHaveLength(1);
        expect(failed[0]).toContain("File version mismatch");
        expect(failed[0]).toContain("hashline_read");

        // Exactly one edit landed — the winner's. The loser's edit must not be
        // present, proving no lost update and no silent overwrite.
        const final = await readFile(fp, "utf-8");
        const finalLines = final.split("\n");
        if (ok[0].includes("EDITED BY ONE")) {
          expect(finalLines[1]).toBe("EDITED BY ONE");
          expect(finalLines[2]).toBe("line three");
          expect(final).not.toContain("EDITED BY TWO");
        } else {
          expect(finalLines[2]).toBe("EDITED BY TWO");
          expect(finalLines[1]).toBe("line two");
          expect(final).not.toContain("EDITED BY ONE");
        }
      });
    });
  });

  describe("pre-write recheck (best-effort CAS)", () => {
    it("rejects when an external write lands after compute — external content preserved", async () => {
      await withTempDir(async (dir) => {
        const fp = join(dir, "external.txt");
        await writeFile(fp, "original\n", "utf-8");
        const { version } = await readFileContent(fp);

        const tool = createHashlineEditTool({
          beforeWrite: async () => {
            // Simulates a modification landing in the read → recheck window.
            await writeFile(fp, "external modification\n", "utf-8");
          },
        });
        const result = await tool.execute({
          files: [{ filePath: fp, version, edits: [{ op: "append" as const, lines: "appended" }] }],
        });

        expect(result).toContain("Error:");
        expect(result).toContain("File version mismatch");
        expect(result).toContain("hashline_read");
        expect(result).toContain("No files were written");
        // The external content must survive untouched.
        expect(await readFile(fp, "utf-8")).toBe("external modification\n");
      });
    });

    it("rejects when a to-be-created file appears before the write", async () => {
      await withTempDir(async (dir) => {
        const fp = join(dir, "to-create.txt");
        const tool = createHashlineEditTool({
          beforeWrite: async () => {
            await writeFile(fp, "created externally\n", "utf-8");
          },
        });
        const result = await tool.execute({
          files: [{ filePath: fp, version: "whatever", edits: [{ op: "append" as const, lines: "new content" }] }],
        });

        expect(result).toContain("Error:");
        expect(result).toContain("expected to be created");
        expect(result).toContain("hashline_read");
        expect(await readFile(fp, "utf-8")).toBe("created externally\n");
      });
    });

    it("verifyFileUnchanged: unchanged file passes, modified file is reported", async () => {
      await withTempDir(async (dir) => {
        const fp = join(dir, "guard.txt");
        await writeFile(fp, "alpha\n", "utf-8");
        const { version } = await readFileContent(fp);

        expect(await verifyFileUnchanged(fp, version)).toBeNull();
        await writeFile(fp, "beta\n", "utf-8");
        const conflict = await verifyFileUnchanged(fp, version);
        expect(conflict).not.toBeNull();
        expect(conflict).toContain("File version mismatch");

        // New-file semantics: absent file passes with null; appearing file conflicts.
        const newFp = join(dir, "still-missing.txt");
        expect(await verifyFileUnchanged(newFp, null)).toBeNull();
        await writeFile(newFp, "surprise\n", "utf-8");
        const newConflict = await verifyFileUnchanged(newFp, null);
        expect(newConflict).not.toBeNull();
        expect(newConflict).toContain("expected to be created");
      });
    });
  });

  describe("overlapping batches", () => {
    it("{A,B}/{B,A} concurrent batches neither deadlock nor lose updates — the loser reports an honest conflict", async () => {
      await withTempDir(async (dir) => {
        const fa = join(dir, "oa.txt");
        const fb = join(dir, "ob.txt");
        // No trailing newline: append inserts directly after the last line.
        await writeFile(fa, "A1\nA2", "utf-8");
        await writeFile(fb, "B1\nB2", "utf-8");
        const ca = await readFileContent(fa);
        const cb = await readFileContent(fb);

        const [r1, r2] = await Promise.all([
          createHashlineEditTool().execute({
            files: [
              { filePath: fa, version: ca.version, edits: [{ op: "append" as const, lines: "X" }] },
              { filePath: fb, version: cb.version, edits: [{ op: "append" as const, lines: "Y" }] },
            ],
          }),
          createHashlineEditTool().execute({
            files: [
              { filePath: fb, version: cb.version, edits: [{ op: "append" as const, lines: "Z" }] },
              { filePath: fa, version: ca.version, edits: [{ op: "append" as const, lines: "W" }] },
            ],
          }),
        ]);

        const ok = [r1, r2].filter((r) => !r.includes("Error:"));
        const conflicted = [r1, r2].filter((r) => r.includes("Error:"));
        expect(ok).toHaveLength(1);
        expect(conflicted).toHaveLength(1);
        // The loser reports a conflict instead of deadlocking or silently losing.
        expect(conflicted[0]).toContain("File version mismatch");

        // The winner's edits are reflected in BOTH files; the loser's are not.
        const faFinal = await readFile(fa, "utf-8");
        const fbFinal = await readFile(fb, "utf-8");
        if (ok[0].includes("X")) {
          expect(faFinal).toBe("A1\nA2\nX");
          expect(fbFinal).toBe("B1\nB2\nY");
          expect(faFinal).not.toContain("W");
          expect(fbFinal).not.toContain("Z");
        } else {
          expect(faFinal).toBe("A1\nA2\nW");
          expect(fbFinal).toBe("B1\nB2\nZ");
          expect(faFinal).not.toContain("X");
          expect(fbFinal).not.toContain("Y");
        }
      });
    });
  });

  describe("lock release on error", () => {
    it("releases all path locks when the pipeline throws inside the locked section", async () => {
      await withTempDir(async (dir) => {
        const fp = join(dir, "err.txt");
        await writeFile(fp, "content\n", "utf-8");
        const { version } = await readFileContent(fp);

        const tool = createHashlineEditTool({
          beforeWrite: async () => {
            throw new Error("simulated pipeline failure");
          },
        });
        const result = await tool.execute({
          files: [{ filePath: fp, version, edits: [{ op: "append" as const, lines: "x" }] }],
        });
        expect(result).toContain("Error:");
        expect(result).toContain("simulated pipeline failure");
        // The failed call wrote nothing.
        expect(await readFile(fp, "utf-8")).toBe("content\n");

        // Locks must be released: a follow-up edit on the same file succeeds.
        const fresh = await readFileContent(fp);
        const hash1 = computeLineHashFor(fresh.lines[0], fresh.hw, 1);
        const retry = await createHashlineEditTool().execute({
          files: [{ filePath: fp, version: fresh.version, edits: [{ pos: `1#${hash1}`, lines: "CHANGED" }] }],
        });
        expect(retry).not.toContain("Error:");
        expect(await readFile(fp, "utf-8")).toBe("CHANGED\n");
      });
    });
  });

  describe("duplicate path rejection", () => {
    it("rejects the same filePath twice in one batch — explicit error, zero side effects", async () => {
      await withTempDir(async (dir) => {
        const fp = join(dir, "dup.txt");
        await writeFile(fp, "original\n", "utf-8");
        const { version } = await readFileContent(fp);

        const result = await createHashlineEditTool().execute({
          files: [
            { filePath: fp, version, edits: [{ op: "append" as const, lines: "A" }] },
            { filePath: fp, version, edits: [{ op: "append" as const, lines: "B" }] },
          ],
        });

        expect(result).toContain("Error:");
        expect(result).toContain("Duplicate filePath");
        expect(await readFile(fp, "utf-8")).toBe("original\n");
      });
    });

    it.skipIf(process.platform !== "darwin" && process.platform !== "win32")(
      "rejects case-alias duplicates on case-folding platforms",
      async () => {
        await withTempDir(async (dir) => {
          const fp = join(dir, "CaseDup.txt");
          const fpAlias = join(dir, "casedup.txt");
          await writeFile(fp, "original\n", "utf-8");
          const { version } = await readFileContent(fp);

          const result = await createHashlineEditTool().execute({
            files: [
              { filePath: fp, version, edits: [{ op: "append" as const, lines: "A" }] },
              { filePath: fpAlias, version, edits: [{ op: "append" as const, lines: "B" }] },
            ],
          });

          expect(result).toContain("Error:");
          expect(result).toContain("Duplicate filePath");
          expect(await readFile(fp, "utf-8")).toBe("original\n");
        });
      },
    );
  });
});
