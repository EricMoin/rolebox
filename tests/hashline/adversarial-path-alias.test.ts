import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHashlineReadTool, createHashlineEditTool } from "../../src/hashline/index.ts";

// ════════════════════════════════════════════════════════════════════
// Adversarial path-alias semantics — duplicate-path rejection and the
// write path's behavior when the same physical file is reached through
// different path spellings (symlinks, hardlinks, ".." segments, ".").
//
// Documented contract (src/hashline/hashline-edit.ts:260-269):
//   "Duplicate file paths in one batch are rejected."
//   "Concurrency: edits to the same file are serialized within this
//    process ... each file is re-checked against its version immediately
//    before writing — a stale version is rejected without writing anything."
//
// Defects under test:
//   D15 — duplicate detection and locking key on normalizeLockKey
//         (src/hashline/path-lock.ts:27-32), which uses path.resolve()
//         and lowercasing but never realpath(). A symlink or hardlink
//         ALIAS of a file already in the batch is therefore NOT recognized
//         as the same file: the batch succeeds, the two edits silently
//         diverge into two files, and the symlink is replaced by a regular
//         file. Same-file serialization (the lock) also misses the alias.
//
//   D16 — atomicWriteFile (src/hashline/atomic-write.ts:16-26) writes a
//         temp file and renames it over the target path. When the target
//         path IS a symlink, rename() replaces the symlink itself with a
//         regular file — the edit "lands" in a new file at the link path
//         while the real target keeps its old content. Editing through a
//         symlink silently destroys the link (write-through is broken).
//         The hardlink variant: rename breaks the link, so the other name
//         keeps the pre-edit content.
//
// Verified-correct boundaries (control cases): ".." / "." spellings of the
// same file ARE rejected as duplicates; special filenames (spaces, Chinese,
// symbols) round-trip fine.
// ════════════════════════════════════════════════════════════════════

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hashline-path-alias-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const readTool = createHashlineReadTool();
const editTool = createHashlineEditTool();

async function readVersion(filePath: string): Promise<string> {
  const out = String(await readTool.execute({ filePath }));
  const version = out.match(/^version: (\S+)$/m)?.[1];
  if (!version) throw new Error(`no version in read output:\n${out}`);
  return version;
}

async function anchorAt(filePath: string, line: number): Promise<string> {
  const out = String(await readTool.execute({ filePath }));
  const annotated = out.split("\n").find((l) => l.startsWith(`${line}#`));
  if (!annotated) throw new Error(`line ${line} missing from read output:\n${out}`);
  return annotated.split("|")[0];
}

describe("hashline adversarial path aliases", () => {
  // ── (a) D15: symlink alias of a batch member must be rejected ──
  it("(a) batch containing a file AND its symlink alias is rejected (same file) [DEFECT: D15]", async () => {
    const real = join(tmpDir, "a-real.txt");
    const linkPath = join(tmpDir, "a-link.txt");
    await writeFile(real, "one\ntwo\n", "utf-8");
    await symlink(real, linkPath);
    const version = await readVersion(real);

    const r = String(await editTool.execute({
      files: [
        { filePath: real, version, edits: [{ op: "append" as const, lines: "AAA" }] },
        { filePath: linkPath, version, edits: [{ op: "append" as const, lines: "BBB" }] },
      ],
    }));

    const stillLink = (await lstat(linkPath)).isSymbolicLink();
    const realContent = await readFile(real, "utf-8");
    const linkContent = await readFile(linkPath, "utf-8");
    console.log(
      `(a) result head: ${r.split("\n").slice(0, 3).join(" ")} | link still a symlink: ${stillLink} ` +
        `| real.txt: ${JSON.stringify(realContent)} | link.txt: ${JSON.stringify(linkContent)} ` +
        `| D15: normalizeLockKey uses resolve() not realpath() (path-lock.ts:27-32), so the alias ` +
        `gets its own lock key and its own rename — the batch is not rejected`,
    );
    // Contract: both paths ARE the same file, so the batch must be rejected as
    // duplicate — the edits must not diverge, and the symlink must survive.
    expect(r).toContain("Error:");
    expect(r).toContain("Duplicate filePath");
    expect(stillLink).toBe(true);
    expect(realContent).toBe("one\ntwo\n");
  });

  // ── (b) D16: single edit THROUGH a symlink must write through, not destroy the link ──
  it("(b) editing a file through a symlink preserves the symlink and updates the target [DEFECT: D16]", async () => {
    const real = join(tmpDir, "b-real.txt");
    const linkPath = join(tmpDir, "b-link.txt");
    await writeFile(real, "x\ny\n", "utf-8");
    await symlink(real, linkPath);

    const version = await readVersion(linkPath);
    const a1 = await anchorAt(linkPath, 1);
    const r = String(await editTool.execute({
      files: [{ filePath: linkPath, version, edits: [{ pos: a1, lines: "CHANGED" }] }],
    }));
    expect(r).not.toContain("Error:");

    const stillLink = (await lstat(linkPath)).isSymbolicLink();
    const realContent = await readFile(real, "utf-8");
    const linkContent = await readFile(linkPath, "utf-8");
    console.log(
      `(b) link still a symlink: ${stillLink} | real.txt: ${JSON.stringify(realContent)} ` +
        `| link content: ${JSON.stringify(linkContent)} ` +
        `| D16: atomicWriteFile renames the temp over the link path (atomic-write.ts:16-26), ` +
        `replacing the symlink with a regular file`,
    );
    // Contract (write-through): the target file receives the edit and the
    // symlink stays a symlink.
    expect(stillLink).toBe(true);
    expect(realContent).toBe("CHANGED\ny\n");
  });

  // ── (c) D16b: hardlink alias — edit through the link breaks the hardlink ──
  it.skipIf(process.platform === "win32")(
    "(c) editing a file through a hardlink writes through to the shared inode (control, FAILS: D16)",
    async () => {
      const real = join(tmpDir, "c-real.txt");
      const hard = join(tmpDir, "c-hard.txt");
      await writeFile(real, "p\nq\n", "utf-8");
      await link(real, hard);

      const version = await readVersion(hard);
      const a1 = await anchorAt(hard, 1);
      const r = String(await editTool.execute({
        files: [{ filePath: hard, version, edits: [{ pos: a1, lines: "CHANGED" }] }],
      }));
      expect(r).not.toContain("Error:");

      const realContent = await readFile(real, "utf-8");
      const hardContent = await readFile(hard, "utf-8");
      console.log(
        `(c) real.txt: ${JSON.stringify(realContent)} | hard.txt: ${JSON.stringify(hardContent)} ` +
          `| D16: rename over the hardlink path breaks the link — the other name keeps the old inode`,
      );
      // Contract (write-through): both names observe the edit (same inode).
      expect(realContent).toBe("CHANGED\nq\n");
      expect(hardContent).toBe("CHANGED\nq\n");
    },
  );

  // ── (d) CONTROL: "sub/.." spelling alias is rejected as duplicate ──
  it("(d) 'dir/../f.txt' and 'f.txt' in one batch are rejected as duplicates (control, PASS)", async () => {
    const sub = join(tmpDir, "d-sub");
    await mkdir(sub, { recursive: true });
    const fp = join(tmpDir, "d.txt");
    const alias = join(sub, "..", "d.txt");
    await writeFile(fp, "d1\nd2\n", "utf-8");
    const version = await readVersion(fp);

    const r = String(await editTool.execute({
      files: [
        { filePath: fp, version, edits: [{ op: "append" as const, lines: "X" }] },
        { filePath: alias, version, edits: [{ op: "append" as const, lines: "Y" }] },
      ],
    }));
    // resolve() collapses ".." → same normalized key → rejected.
    expect(r).toContain("Error:");
    expect(r).toContain("Duplicate filePath");
    expect(await readFile(fp, "utf-8")).toBe("d1\nd2\n");
  });

  // ── (e) CONTROL: "." segment alias is rejected as duplicate ──
  it("(e) './f.txt' and 'f.txt' in one batch are rejected as duplicates (control, PASS)", async () => {
    const fp = join(tmpDir, "e.txt");
    const alias = join(tmpDir, ".", "e.txt");
    await writeFile(fp, "e1\ne2\n", "utf-8");
    const version = await readVersion(fp);

    const r = String(await editTool.execute({
      files: [
        { filePath: fp, version, edits: [{ op: "append" as const, lines: "X" }] },
        { filePath: alias, version, edits: [{ op: "append" as const, lines: "Y" }] },
      ],
    }));
    expect(r).toContain("Error:");
    expect(r).toContain("Duplicate filePath");
    expect(await readFile(fp, "utf-8")).toBe("e1\ne2\n");
  });

  // ── (f) CONTROL: special filenames (spaces, Chinese, symbols) round-trip ──
  it("(f) file named '中文 文件 äöü & symbols!.txt' reads and edits correctly (control, PASS)", async () => {
    const fp = join(tmpDir, "中文 文件 äöü & symbols!.txt");
    await writeFile(fp, "one\ntwo\n", "utf-8");
    const version = await readVersion(fp);
    const a1 = await anchorAt(fp, 1);
    const r = String(await editTool.execute({
      files: [{ filePath: fp, version, edits: [{ pos: a1, lines: "CH" }] }],
    }));
    expect(r).not.toContain("Error:");
    expect(await readFile(fp, "utf-8")).toBe("CH\ntwo\n");
  });

  // ── (g) CONTROL: two genuinely distinct files in one batch both succeed ──
  it("(g) batch of two distinct files applies both edits (control, PASS)", async () => {
    const fa = join(tmpDir, "g-a.txt");
    const fb = join(tmpDir, "g-b.txt");
    await writeFile(fa, "a1\na2\n", "utf-8");
    await writeFile(fb, "b1\nb2\n", "utf-8");
    const [va, vb] = await Promise.all([readVersion(fa), readVersion(fb)]);
    const r = String(await editTool.execute({
      files: [
        { filePath: fa, version: va, edits: [{ op: "append" as const, lines: "AX" }] },
        { filePath: fb, version: vb, edits: [{ op: "append" as const, lines: "BX" }] },
      ],
    }));
    expect(r).not.toContain("Error:");
    expect(await readFile(fa, "utf-8")).toBe("a1\na2\nAX\n");
    expect(await readFile(fb, "utf-8")).toBe("b1\nb2\nBX\n");
  });
});
