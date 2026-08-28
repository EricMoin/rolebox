import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, readFile, rm, mkdir, chmod, symlink, lstat, realpath, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHashlineReadTool, createHashlineEditTool } from "../../src/hashline/index.ts";

// Adversarial mid-flight filesystem-state suite for hashline_edit.
//
// Each case mutates the target file inside the read → recheck window and
// observes what the tool does. The window is entered deterministically via the
// documented internal test hook `beforeWrite` (src/hashline/hashline-edit.ts:
// 28-33, invoked at :387 — fires AFTER every file's edit has been computed and
// BEFORE the pre-write version recheck, while all path locks are held). No
// wall-clock sleeps, no polling.
//
// Classification conventions:
//  - Documented behavior / control → assert the documented contract, PASS.
//  - Regression guard → assert the CORRECT (now-fixed) contract, log evidence
//    via console.log, PASS (guards against reintroduction of the defect).
//  - Every scenario logs a [CLASSIFY:] line for the triage report.
//
// All mutations happen inside mkdtemp temp dirs only; cleanup runs in
// finally/afterAll (chmod 0o000 must be restored — no chmod-locked files may
// be left behind).

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hashline-adv-midflight-"));
});

afterAll(async () => {
  // Cleanup assertions: no .tmp leftovers, no chmod-locked (0o000) regular
  // files, then remove the whole tree.
  const entries = await readdir(tmpDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile()) {
      const mode = (await stat(join(tmpDir, e.name))).mode & 0o777;
      expect(mode, `${e.name} must not be chmod-locked (mode 0o${mode.toString(8)})`).not.toBe(0);
    }
  }
  const leftovers = entries.filter((e) => e.name.endsWith(".tmp"));
  expect(leftovers.map((e) => e.name)).toEqual([]);
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

describe("hashline adversarial mid-flight filesystem state", () => {
  it("(a) file replaced by a DIRECTORY in the read→recheck window: clean string error, zero writes, message identifies the file", async () => {
    const fp = join(tmpDir, "a-dir-swap.txt");
    const original = "A1\nA2\n";
    await writeFile(fp, original, "utf-8");
    const version = await readVersion(fp);
    const beforeEntries = (await readdir(tmpDir)).sort();

    let r: string;
    try {
      r = String(
        await createHashlineEditTool({
          beforeWrite: async () => {
            // Simulates an external writer replacing the file with a directory
            // after our read phase, while path locks are held.
            await rm(fp, { force: true });
            await mkdir(fp);
          },
        }).execute({
          files: [{ filePath: fp, version, edits: [{ op: "append" as const, lines: "AX" }] }],
        }),
      );
    } catch (err) {
      throw new Error(
        `DEFECT: tool THREW instead of returning a string error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    console.log("[CLASSIFY:(a)] observed result message:\n" + r);
    // 1. String-return contract (hashline-edit.ts:458-462): never throws.
    expect(r).toContain("Error:");
    // 2. Zero writes: the installed directory is intact and no new entries
    //    (or .tmp files) appeared in the temp dir.
    expect((await lstat(fp)).isDirectory()).toBe(true);
    const afterEntries = (await readdir(tmpDir)).sort();
    expect(afterEntries).toEqual(beforeEntries);
    expect(afterEntries.filter((e) => e.endsWith(".tmp"))).toHaveLength(0);
    // 3. CORRECT contract (now fixed): the error message identifies the
    //    offending file. EISDIR propagates out of the recheck read into the
    //    generic catch (hashline-edit.ts) whose `Error: Edit failed: <message>`
    //    now carries the path via the path-aware atomic-write guard, so the
    //    caller can tell WHICH file failed. Regression guard.
    expect(r, "error message must identify the file that failed").toContain(fp);

    console.log("[CLASSIFY:(a)] verdict: string-error contract PASS; zero-writes PASS; message identifies file: PASS (path-aware error carries the offending file)");
  });

  it.skipIf(process.platform === "win32")("(b) chmod 0o000 on the file in the window: clean string error, zero writes, chmod restored in finally", async () => {
    const fp = join(tmpDir, "b-chmod.txt");
    const original = "B1\nB2\n";
    await writeFile(fp, original, "utf-8");
    const version = await readVersion(fp);

    let r: string;
    try {
      r = String(
        await createHashlineEditTool({
          beforeWrite: async () => {
            // Simulates an external writer locking the file (mode 0o000) after
            // our read phase.
            await chmod(fp, 0o000);
          },
        }).execute({
          files: [{ filePath: fp, version, edits: [{ op: "append" as const, lines: "BX" }] }],
        }),
      );
    } catch (err) {
      throw new Error(
        `DEFECT: tool THREW instead of returning a string error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // NEVER leave a chmod-locked file behind — restore on every path.
      await chmod(fp, 0o644);
      console.log("[CLASSIFY:(b)] chmod 0o000 restored to 0o644 in finally");
    }

    console.log("[CLASSIFY:(b)] observed result message:\n" + r);
    // Clean string error (never throws), and — unlike EISDIR — the EACCES
    // message from the generic catch DOES carry the path, so the file is
    // identified.
    expect(r).toContain("Error:");
    expect(r).toContain(fp);
    // Zero writes: original content intact after the chmod restore.
    expect(await readFile(fp, "utf-8")).toBe(original);
    expect((await readdir(tmpDir)).filter((e) => e.endsWith(".tmp"))).toHaveLength(0);

    console.log("[CLASSIFY:(b)] verdict: PASS — clean string error, zero writes, message identifies file (EACCES carries path), chmod restored");
  });

  it("(c) same-content symlink swap in the window: D16 write-through lands the edit at the link TARGET; symlink survives (documented behavior, PASS)", async () => {
    const fp = join(tmpDir, "c-symlink.txt");
    const other = join(tmpDir, "c-other.txt");
    const content = "C1\nC2\n";
    await writeFile(fp, content, "utf-8");
    await writeFile(other, content, "utf-8"); // byte-identical content
    const { version, anchors } = await readInfo(fp);

    const r = String(
      await createHashlineEditTool({
        beforeWrite: async () => {
          // Simulates an external writer swapping the file for a symlink to a
          // DIFFERENT temp file with byte-identical content. The version
          // recheck reads through the link and sees the same canonical content,
          // so the swap is indistinguishable from a no-op.
          await rm(fp, { force: true });
          await symlink(other, fp);
        },
      }).execute({
        files: [{ filePath: fp, version, edits: [{ pos: anchors[1], lines: "EDITED" }] }],
      }),
    );

    console.log("[CLASSIFY:(c)] edit result:\n" + r);
    // Recheck passed on identical content → the batch proceeds, no conflict.
    expect(r).not.toContain("Error:");
    // D16 write-through: the rename lands on the link's TARGET, the link
    // survives (atomic-write.ts:25-36, 47-49).
    expect((await lstat(fp)).isSymbolicLink()).toBe(true);
    // The edit landed at the redirect target — a file the caller never
    // referenced — NOT as a regular file at fp.
    expect(await readFile(other, "utf-8")).toBe("EDITED\nC2\n");
    // fp resolves to other and therefore observes the edit.
    expect(await realpath(fp)).toBe(await realpath(other));
    expect(await readFile(fp, "utf-8")).toBe("EDITED\nC2\n");
    // Zero stray temp files.
    expect((await readdir(tmpDir)).filter((e) => e.endsWith(".tmp"))).toHaveLength(0);

    console.log(
      "[CLASSIFY:(c)] verdict: PASS (D16 write-through) — OBSERVATION: mid-flight symlink swap with identical content is invisible to the version recheck; the write was redirected to an unexpected path within the temp dir (" +
        other +
        ") while the caller only referenced " +
        fp +
        "; the caller still observes the edit via the surviving symlink, but an un-referenced file was silently mutated",
    );
  });

  it("(d) file truncated to empty in the window: version-mismatch conflict with zero writes (documented recheck, PASS)", async () => {
    const fp = join(tmpDir, "d-truncate.txt");
    const original = "D1\nD2\n";
    await writeFile(fp, original, "utf-8");
    const version = await readVersion(fp);

    const r = String(
      await createHashlineEditTool({
        beforeWrite: async () => {
          // Simulates an external writer truncating the file after our read
          // phase.
          await writeFile(fp, "", "utf-8");
        },
      }).execute({
        files: [{ filePath: fp, version, edits: [{ op: "append" as const, lines: "DX" }] }],
      }),
    );

    console.log("[CLASSIFY:(d)] observed result message:\n" + r);
    // Documented recheck behavior (hashline-edit.ts:395-410): content no
    // longer matches the observed version → conflict before any byte is
    // written.
    expect(r).toContain("Error:");
    expect(r).toContain("File version mismatch");
    expect(r).toContain("No files were written");
    // Zero writes: the file stays truncated to empty — the tool wrote nothing.
    expect(await readFile(fp, "utf-8")).toBe("");
    expect((await readdir(tmpDir)).filter((e) => e.endsWith(".tmp"))).toHaveLength(0);

    console.log("[CLASSIFY:(d)] verdict: PASS — version recheck detected the truncation; clean conflict; zero writes");
  });
});
