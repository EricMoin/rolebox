import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHashlineReadTool, createHashlineEditTool } from "../../src/hashline/index.ts";

// Adversarial batch & concurrency suite for hashline_edit.
//
// Each case asserts the documented contract; a failing assertion is a defect
// reproduction, not a test bug.
//
// Concurrency simulation means:
//  - The engine exposes an injectable `beforeWrite` hook
//    (src/hashline/hashline-edit.ts:28-33, invoked at :363 while all path
//    locks are held, after edit computation, before the pre-write recheck).
//    Cases (d) and (h) use it to inject deterministic external modifications
//    into the read -> recheck window — no sleeps, no polling.
//  - Real concurrent tool invocations via Promise.all for case (f).
//  - Sequential chained tool calls for case (g) — the "concurrent workflow"
//    contract where edit2 consumes edit1's returned version without a re-read.
//
// Defect under test (D1 x concurrency, case g):
//  hashline-edit returns `computeFileVersion(resultContent)` — the canonical
//  join of the edited lines, which never carries a trailing newline
//  (src/hashline/hashline-edit.ts:218) — but writes
//  `restoreFileText(finalContent, envelope)`, which re-applies the original
//  trailing-newline count (src/hashline/hashline-edit.ts:203-217). For any
//  file ending in "\n", the returned version therefore does NOT match the
//  canonical version of the on-disk content. A chained edit using that
//  returned version fails the pre-write validation. Deterministic by
//  construction — no actual race is needed.

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hashline-adv-batch-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Read a file with hashline_read and return version + per-line anchors. */
async function readInfo(filePath: string): Promise<{ version: string; anchors: Record<number, string> }> {
  const out = String(await createHashlineReadTool().execute({ filePath }));
  const m = out.match(/^version: (\S+)$/m);
  if (!m) throw new Error(`no version in hashline_read output for ${filePath}:\n${out}`);
  const anchors: Record<number, string> = {};
  for (const line of out.split("\n")) {
    const am = line.match(/^(\d+)#([A-Za-z0-9_-]+)\|/);
    if (am) anchors[Number(am[1])] = `${am[1]}#${am[2]}`;
  }
  return { version: m[1], anchors };
}

/** Read only the whole-file version. */
async function readVersion(filePath: string): Promise<string> {
  return (await readInfo(filePath)).version;
}

/** Extract the `version:` header from a successful edit result. */
function versionFromResult(result: string): string {
  const m = result.match(/^version: (\S+)$/m);
  if (!m) throw new Error(`no version header in edit result:\n${result}`);
  return m[1];
}

describe("hashline adversarial batch & concurrency", () => {
  it("(a) exact duplicate path in one batch is rejected with zero side effects", async () => {
    const fp = join(tmpDir, "a-dup.txt");
    const original = "a-original\n";
    await writeFile(fp, original, "utf-8");
    const version = await readVersion(fp);

    const r = String(await createHashlineEditTool().execute({
      files: [
        { filePath: fp, version, edits: [{ op: "append" as const, lines: "X" }] },
        { filePath: fp, version, edits: [{ op: "append" as const, lines: "Y" }] },
      ],
    }));

    // Contract: duplicate detection must fire BEFORE any read/write/lock, so
    // the batch reports an error and the file is untouched.
    expect(r).toContain("Error:");
    expect(r).toContain("Duplicate filePath");
    expect(await readFile(fp, "utf-8")).toBe(original);
  });

  it.skipIf(process.platform !== "darwin" && process.platform !== "win32")(
    "(b) case-alias duplicates (Foo.txt + foo.txt) are rejected — normalizeLockKey folds case",
    async () => {
      const fp = join(tmpDir, "Foo.txt");
      const alias = join(tmpDir, "foo.txt");
      const original = "b-original\n";
      await writeFile(fp, original, "utf-8");
      const version = await readVersion(fp);

      const r = String(await createHashlineEditTool().execute({
        files: [
          { filePath: fp, version, edits: [{ op: "append" as const, lines: "X" }] },
          { filePath: alias, version, edits: [{ op: "append" as const, lines: "Y" }] },
        ],
      }));

      // normalizeLockKey lowercases on darwin/win32 (src/hashline/path-lock.ts:27-32),
      // so both spellings collapse to one key and the batch must reject.
      expect(r).toContain("Error:");
      expect(r).toContain("Duplicate filePath");
      expect(await readFile(fp, "utf-8")).toBe(original);
    },
  );

  it("(c) 3-file batch with a stale middle-file version writes nothing to any of the three", async () => {
    const fa = join(tmpDir, "c-a.txt");
    const fb = join(tmpDir, "c-b.txt");
    const fc = join(tmpDir, "c-c.txt");
    const origA = "A1\nA2\n";
    const origB = "B1\nB2\n";
    const origC = "C1\nC2\n";
    await writeFile(fa, origA, "utf-8");
    await writeFile(fb, origB, "utf-8");
    await writeFile(fc, origC, "utf-8");
    const [va, vb, vc] = await Promise.all([readVersion(fa), readVersion(fb), readVersion(fc)]);

    // Stale B: externally modified after its version was observed.
    await writeFile(fb, "B1\nB2\nEXTERNAL\n", "utf-8");

    const r = String(await createHashlineEditTool().execute({
      files: [
        { filePath: fa, version: va, edits: [{ op: "append" as const, lines: "AX" }] },
        { filePath: fb, version: vb, edits: [{ op: "append" as const, lines: "BX" }] },
        { filePath: fc, version: vc, edits: [{ op: "append" as const, lines: "CX" }] },
      ],
    }));

    // Any per-file validation failure aborts the whole batch BEFORE a single
    // byte is written — zero-write-on-validation-failure semantics.
    expect(r).toContain("Error:");
    expect(r).toContain("File version mismatch");
    expect(r).toContain("c-b.txt");
    expect(await readFile(fa, "utf-8")).toBe(origA);
    expect(await readFile(fb, "utf-8")).toBe("B1\nB2\nEXTERNAL\n");
    expect(await readFile(fc, "utf-8")).toBe(origC);
  });

  it("(d) a to-be-created file appearing in the read→recheck window conflicts; existing file is untouched", async () => {
    const fa = join(tmpDir, "d-exists.txt");
    const fb = join(tmpDir, "d-to-create.txt");
    const origA = "D1\nD2\n";
    await writeFile(fa, origA, "utf-8");
    const va = await readVersion(fa);

    const r = String(await createHashlineEditTool({
      beforeWrite: async () => {
        // Simulates an external writer creating the file after our read phase.
        await writeFile(fb, "created by external writer\n", "utf-8");
      },
    }).execute({
      files: [
        { filePath: fa, version: va, edits: [{ op: "append" as const, lines: "DX" }] },
        // To-be-created file: anchorless append, version is not validated.
        { filePath: fb, version: "whatever", edits: [{ op: "append" as const, lines: "new file" }] },
      ],
    }));

    // Pre-write CAS (verifyFileUnchanged with expectedVersion=null) must catch
    // the newly-appeared file and fail the batch before any write.
    expect(r).toContain("Error:");
    expect(r).toContain("expected to be created");
    expect(r).toContain("No files were written");
    // Zero writes: the existing file is untouched; the external file is preserved.
    expect(await readFile(fa, "utf-8")).toBe(origA);
    expect(await readFile(fb, "utf-8")).toBe("created by external writer\n");
  });

  it("(e) batch targeting a missing directory writes nothing and cleans up temp files", async () => {
    const fOk = join(tmpDir, "e-in-existing-dir.txt");
    const missingDir = join(tmpDir, "e-missing-dir");
    const fMissing = join(missingDir, "e-in-missing-dir.txt");

    const r = String(await createHashlineEditTool().execute({
      files: [
        { filePath: fOk, version: "whatever", edits: [{ op: "append" as const, lines: "OK" }] },
        { filePath: fMissing, version: "whatever", edits: [{ op: "append" as const, lines: "MISSING" }] },
      ],
    }));

    // The second temp write fails (ENOENT); atomicWriteBatch must clean the
    // first temp and report a write failure — no partial rename may survive.
    // The write-failure path uses the "Error:" prefix consistent with every
    // other error path (hashline-edit.ts), so a caller grepping for /^Error:/
    // catches it — regression guard against the prefixed-prefix regression.
    expect(r.startsWith("Error:")).toBe(true);
    expect(r).toContain("Write failed");
    expect(r).toContain("ENOENT");
    // Zero writes: the to-be-created file in the existing dir must not exist.
    await expect(readFile(fOk, "utf-8")).rejects.toThrow();
    // Temp cleanup: no .tmp leftovers in the existing dir.
    const entries = await readdir(tmpDir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toHaveLength(0);
    // The missing dir is still absent.
    await expect(readdir(missingDir)).rejects.toThrow();
  });

  it("(f) concurrent same-version edits to one file: exactly one wins, one conflicts, nothing is lost", async () => {
    const fp = join(tmpDir, "f-concurrent.txt");
    await writeFile(fp, "one\ntwo\nthree\n", "utf-8");
    const { version, anchors } = await readInfo(fp);

    const [r1, r2] = await Promise.all([
      createHashlineEditTool().execute({
        files: [{ filePath: fp, version, edits: [{ pos: anchors[2], lines: "WIN-A" }] }],
      }),
      createHashlineEditTool().execute({
        files: [{ filePath: fp, version, edits: [{ pos: anchors[3], lines: "WIN-B" }] }],
      }),
    ]);
    const [s1, s2] = [String(r1), String(r2)];

    const ok = [s1, s2].filter((r) => !r.includes("Error:"));
    const failed = [s1, s2].filter((r) => r.includes("Error:"));
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("File version mismatch");
    expect(failed[0]).toContain("hashline_read");

    // Exactly one edit landed — the winner's; the loser's edit must be absent.
    const final = await readFile(fp, "utf-8");
    if (ok[0].includes("WIN-A")) {
      expect(final).toContain("WIN-A");
      expect(final).not.toContain("WIN-B");
    } else {
      expect(final).toContain("WIN-B");
      expect(final).not.toContain("WIN-A");
    }
  });

  it("(g) chained edit using the previous edit's returned version succeeds (no re-read)", async () => {
    const fp = join(tmpDir, "g-chained.txt");
    // Trailing-newline file: this is what makes the returned-version contract
    // observable (see header comment — D1 x concurrency reproduction).
    await writeFile(fp, "line one\nline two\n", "utf-8");
    const v0 = await readVersion(fp);

    const r1 = String(await createHashlineEditTool().execute({
      files: [{ filePath: fp, version: v0, edits: [{ op: "append" as const, lines: "line three" }] }],
    }));
    // edit1 itself must succeed and write correct content.
    expect(r1).not.toContain("Error:");
    expect(await readFile(fp, "utf-8")).toBe("line one\nline two\nline three\n");
    const v1 = versionFromResult(r1);

    // Contract: a sequential edit consuming the previous edit's returned
    // version (the way a multi-step editing workflow chains tool calls) must
    // succeed without re-reading.
    //
    // KNOWN DEFECT: edit1 returns computeFileVersion(resultContent) — the
    // canonical join WITHOUT the trailing newline (hashline-edit.ts:218) —
    // while the on-disk content carries the envelope-restored trailing "\n"
    // (hashline-edit.ts:203-217). edit2's version validation therefore sees a
    // mismatch and rejects. This assertion is EXPECTED TO FAIL today.
    const r2 = String(await createHashlineEditTool().execute({
      files: [{ filePath: fp, version: v1, edits: [{ op: "append" as const, lines: "line four" }] }],
    }));
    expect(r2, `chained edit with returned version failed:\n${r2}`).not.toContain("Error:");
  });

  it("(h) file deleted in the read→recheck window is detected as a conflict", async () => {
    const fp = join(tmpDir, "h-deleted.txt");
    const original = "H1\nH2\n";
    await writeFile(fp, original, "utf-8");
    const version = await readVersion(fp);

    const r = String(await createHashlineEditTool({
      beforeWrite: async () => {
        // Simulates an external writer deleting the file after our read phase.
        await rm(fp, { force: true });
      },
    }).execute({
      files: [{ filePath: fp, version, edits: [{ op: "append" as const, lines: "HX" }] }],
    }));

    // verifyFileUnchanged's ENOENT branch (expectedVersion non-null) must
    // report the deletion and abort the batch before any write.
    expect(r).toContain("Error:");
    expect(r).toContain("was deleted since the edit was computed");
    expect(r).toContain("No files were written");
    // Zero writes: the file stays deleted — the edit tool wrote nothing.
    await expect(readFile(fp, "utf-8")).rejects.toThrow();
  });
});
