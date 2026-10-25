import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeBenchmarkWorkspace, materializeBenchmarkFiles, safeBenchmarkRelativePath, snapshotBenchmarkFiles } from "../../src/benchmark/workspace.ts";
import type { BenchmarkFileSnapshot } from "../../src/benchmark/types.ts";

let directory: string;
let source: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "rolebox-benchmark-workspace-"));
  source = join(directory, "source");
  await mkdir(source);
});

afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function write(path: string, content: string | Uint8Array): Promise<void> {
  const target = join(source, path);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content);
}

describe("benchmark workspace snapshots", () => {
  it("freezes bytes, preserves executable intent and hashes independently of source path", async () => {
    await write("src/main.ts", "export const value = 1;\n");
    await write("run", "#!/bin/sh\nexit 0\n");
    await chmod(join(source, "run"), 0o755);
    const snapshot = await snapshotBenchmarkFiles(source);
    expect(snapshot.files.map(file => file.path)).toEqual(["run", "src/main.ts"]);
    expect(snapshot.files[0]!.executable).toBe(process.platform !== "win32");
    await materializeBenchmarkFiles(snapshot, join(directory, "copy"));
    expect((await snapshotBenchmarkFiles(join(directory, "copy"))).digest).toBe(snapshot.digest);
    await write("src/main.ts", "export const value = 2;\n");
    expect(Buffer.from(snapshot.files[1]!.content, "base64").toString()).toContain("value = 1");
    expect((await snapshotBenchmarkFiles(source)).digest).not.toBe(snapshot.digest);
  });

  it("materializes independent mutable workspaces into a new or empty directory", async () => {
    await write("file.txt", "original");
    const snapshot = await snapshotBenchmarkFiles(source);
    const left = join(directory, "left");
    const right = join(directory, "right");
    await mkdir(right);
    await materializeBenchmarkFiles(snapshot, left);
    await materializeBenchmarkFiles(snapshot, right);
    await writeFile(join(left, "file.txt"), "changed");
    expect(await readFile(join(source, "file.txt"), "utf8")).toBe("original");
    expect(await readFile(join(right, "file.txt"), "utf8")).toBe("original");
    expect((await stat(join(right, "file.txt"))).mode & 0o200).toBe(0o200);
    await expect(materializeBenchmarkFiles(snapshot, left)).rejects.toThrow("empty directory");
  });

  it("tracks supported executable permission changes in its digest and evidence", async () => {
    await write("script", "echo example\n");
    await chmod(join(source, "script"), 0o600);
    const before = await snapshotBenchmarkFiles(source);
    await chmod(join(source, "script"), 0o700);
    const after = await snapshotBenchmarkFiles(source);
    const diff = describeBenchmarkWorkspace(before, after, "artifacts/trial");
    if (process.platform === "win32") {
      expect(after.files[0]!.executable).toBe(false);
      expect(after.digest).toBe(before.digest);
      expect(diff.changes).toEqual([]);
    } else {
      expect(after.digest).not.toBe(before.digest);
      expect(diff.changes[0]).toMatchObject({ kind: "modified", beforeExecutable: false, afterExecutable: true, contentOmitted: false });
      expect(diff.changes[0]!.beforeDigest).toBe(diff.changes[0]!.afterDigest);
    }
  });

  it("rejects symlinks both as a source and inside its tree", async () => {
    await write("file.txt", "example");
    await symlink(source, join(directory, "linked"));
    await expect(snapshotBenchmarkFiles(join(directory, "linked"))).rejects.toThrow("symlinks");
    await symlink(join(source, "file.txt"), join(source, "link"));
    await expect(snapshotBenchmarkFiles(source)).rejects.toThrow("symlinks");
    await rm(join(source, "link"));
    const snapshot = await snapshotBenchmarkFiles(source);
    await expect(materializeBenchmarkFiles(snapshot, join(directory, "linked"))).rejects.toThrow("empty directory");
  });

  it("can omit only the top-level runtime namespace without reading or following it", async () => {
    await write("src/main.ts", "example");
    await write("nested/.rolebox/file.txt", "nested user file");
    const before = await snapshotBenchmarkFiles(source);
    await symlink(join(directory, "missing-private-state"), join(source, ".rolebox"));
    expect((await snapshotBenchmarkFiles(source, { omitRoleboxState: true })).digest).toBe(before.digest);
    await expect(snapshotBenchmarkFiles(source)).rejects.toThrow("symlinks");
    await rm(join(source, ".rolebox"));
    await write(".rolebox/state/active.json", "{}");
    expect((await snapshotBenchmarkFiles(source, { omitRoleboxState: true })).digest).toBe(before.digest);
    expect((await snapshotBenchmarkFiles(source)).digest).not.toBe(before.digest);
  });

  it("rejects unsafe paths without exposing their source names", async () => {
    for (const path of ["", "/absolute", "../outside", "a/../outside", "./file", "a//file", "a/", "C:/file", "a\\file", "a\nfile", "a\u202efile", "a/\ud800", "a/" + "x".repeat(256)]) {
      expect(safeBenchmarkRelativePath(path)).toBe(false);
    }
    expect(safeBenchmarkRelativePath("src/文件 name.ts")).toBe(true);
    await write("private\u200bname", "example");
    try { await snapshotBenchmarkFiles(source); throw new Error("accepted invalid path"); }
    catch (error) {
      expect(String(error)).toContain("unsafe relative path");
      expect(String(error)).not.toContain("private");
    }
  });

  it("rejects malformed snapshots before creating the destination", async () => {
    const valid = await snapshotBenchmarkFiles(source);
    for (const changed of [
      { digest: "bad", files: [] },
      { ...valid, files: [{ path: "../outside", content: "", executable: false }] },
      { ...valid, files: [{ path: "file", content: "not base64", executable: false }] },
      { ...valid, files: [{ path: "file", content: "", executable: false }, { path: "file", content: "", executable: false }] },
      { ...valid, files: [{ path: "file", content: "", executable: false }, { path: "file/child", content: "", executable: false }] },
    ] satisfies BenchmarkFileSnapshot[]) {
      await expect(materializeBenchmarkFiles(changed, join(directory, "destination"))).rejects.toThrow("Benchmark workspace");
    }
    await expect(stat(join(directory, "destination"))).rejects.toThrow();
  });

  it("enforces the individual file and total byte limits", async () => {
    await write("large", Buffer.alloc(1_048_577));
    await expect(snapshotBenchmarkFiles(source)).rejects.toThrow("byte limit");
    await rm(join(source, "large"));
    for (let index = 0; index < 17; index++) await write(`file-${index}`, Buffer.alloc(1_048_576));
    await expect(snapshotBenchmarkFiles(source)).rejects.toThrow("byte limit");
  });

  it("bounds file count and directory traversal depth", async () => {
    for (let index = 0; index < 1_001; index++) await write(`file-${index}`, "");
    await expect(snapshotBenchmarkFiles(source)).rejects.toThrow("file or byte limit");
    await rm(source, { recursive: true });
    await mkdir(join(source, ...Array.from({ length: 65 }, () => "nested")), { recursive: true });
    await expect(snapshotBenchmarkFiles(source)).rejects.toThrow("directory traversal limit");
  });
});

describe("benchmark workspace evidence", () => {
  it("records ordered additions, changes and deletions with bounded UTF-8 content", async () => {
    await write("deleted.txt", "old");
    await write("modified.txt", "before");
    await write("untouched.txt", "same");
    const before = await snapshotBenchmarkFiles(source);
    await rm(join(source, "deleted.txt"));
    await write("modified.txt", "after");
    await write("added.txt", "new");
    const after = await snapshotBenchmarkFiles(source);
    const evidence = describeBenchmarkWorkspace(before, after, "artifacts/trial");
    expect(evidence).toMatchObject({ fixtureDigest: before.digest, resultDigest: after.digest, artifactDirectory: "artifacts/trial" });
    expect(evidence.changes.map(change => [change.path, change.kind])).toEqual([["added.txt", "added"], ["deleted.txt", "deleted"], ["modified.txt", "modified"]]);
    expect(evidence.changes[0]).toMatchObject({ beforeDigest: null, beforeText: null, afterText: "new", beforeExecutable: null, contentOmitted: false });
    expect(evidence.changes[1]).toMatchObject({ beforeText: "old", afterDigest: null, afterText: null, afterExecutable: null });
    expect(evidence.changes[2]).toMatchObject({ beforeText: "before", afterText: "after" });
  });

  it("omits binary, invalid UTF-8 and oversized text but retains digests", async () => {
    const before = await snapshotBenchmarkFiles(source);
    await write("binary", Buffer.from([0, 1, 2]));
    await write("invalid", Buffer.from([0xff]));
    await write("large", "文".repeat(6_000));
    const evidence = describeBenchmarkWorkspace(before, await snapshotBenchmarkFiles(source), "artifacts/trial");
    for (const change of evidence.changes) {
      expect(change).toMatchObject({ afterText: null, contentOmitted: true });
      expect(change.afterDigest).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("limits total preview bytes across all changed files", async () => {
    for (let index = 0; index < 3; index++) await write(`file-${index}`, "文".repeat(5_000));
    const before = await snapshotBenchmarkFiles(source);
    for (let index = 0; index < 3; index++) await write(`file-${index}`, "字".repeat(5_000));
    const evidence = describeBenchmarkWorkspace(before, await snapshotBenchmarkFiles(source), "artifacts/trial");
    const bytes = evidence.changes.reduce((total, change) => total + Buffer.byteLength(change.beforeText ?? "") + Buffer.byteLength(change.afterText ?? ""), 0);
    expect(bytes).toBe(60_000);
    expect(evidence.changes[2]).toMatchObject({ beforeText: null, afterText: null, contentOmitted: true });
  });
});
