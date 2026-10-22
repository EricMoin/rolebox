import { afterEach, describe, expect, it } from "bun:test";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBenchmarkReport } from "../../src/benchmark/report-output.ts";
import { createDirSymlink } from "../helpers/symlink.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rolebox-benchmark-report-"));
  roots.push(root);
  const run = join(root, "run");
  await mkdir(join(run, "snapshot"), { recursive: true });
  return { root, run };
}

describe("benchmark report output", () => {
  it("protects every evidence filename through canonical directory aliases", async () => {
    const { root, run } = await fixture();
    const alias = join(root, "alias");
    createDirSymlink(run, alias);
    for (const name of ["benchmark.sqlite", "benchmark.sqlite-wal", "benchmark.sqlite-shm", "run.json", "plan.json"]) {
      const evidence = join(run, name);
      await writeFile(evidence, "original evidence");
      await expect(writeBenchmarkReport(run, join(alias, name), "report")).rejects.toThrow("benchmark evidence");
      await expect(writeBenchmarkReport(alias, evidence, "report")).rejects.toThrow("benchmark evidence");
      await expect(writeBenchmarkReport(run, join(alias, name.toUpperCase()), "report")).rejects.toThrow("benchmark evidence");
      expect(await readFile(evidence, "utf8")).toBe("original evidence");
    }
  });

  it("protects the snapshot directory and files reached through a parent alias", async () => {
    const { root, run } = await fixture();
    const snapshot = join(run, "snapshot");
    const alias = join(root, "snapshot-alias");
    createDirSymlink(snapshot, alias);
    await writeFile(join(snapshot, "role.yaml"), "original role");
    await expect(writeBenchmarkReport(run, snapshot, "report")).rejects.toThrow("benchmark evidence");
    await expect(writeBenchmarkReport(run, join(alias, "role.yaml"), "report")).rejects.toThrow("benchmark evidence");
    expect(await readFile(join(snapshot, "role.yaml"), "utf8")).toBe("original role");
  });

  it.skipIf(process.platform === "win32")("rejects an existing final symlink without changing its target", async () => {
    const { root, run } = await fixture();
    const evidence = join(run, "run.json");
    const output = join(root, "report.json");
    await writeFile(evidence, "original evidence");
    await symlink(evidence, output);
    await expect(writeBenchmarkReport(run, output, "report")).rejects.toThrow("symbolic link");
    expect((await lstat(output)).isSymbolicLink()).toBe(true);
    expect(await readFile(evidence, "utf8")).toBe("original evidence");
  });

  it.skipIf(process.platform === "win32")("rejects a dangling final symlink", async () => {
    const { root, run } = await fixture();
    const output = join(root, "report.html");
    await symlink(join(run, "missing.json"), output);
    await expect(writeBenchmarkReport(run, output, "report")).rejects.toThrow("symbolic link");
    expect((await lstat(output)).isSymbolicLink()).toBe(true);
  });

  it("creates and atomically replaces reports through an output directory alias", async () => {
    const { root, run } = await fixture();
    const alias = join(root, "alias");
    createDirSymlink(run, alias);
    const output = join(alias, "report.html");
    expect(await writeBenchmarkReport(run, output, "first report")).toBe(join(await realpath(run), "report.html"));
    await writeBenchmarkReport(run, output, "second report");
    expect(await readFile(output, "utf8")).toBe("second report");
    expect((await readdir(run)).sort()).toEqual(["report.html", "snapshot"]);
  });

  it("replaces a report hard link without truncating the original evidence", async () => {
    const { run } = await fixture();
    const evidence = join(run, "run.json");
    const output = join(run, "report.json");
    await writeFile(evidence, "original evidence");
    await link(evidence, output);
    await writeBenchmarkReport(run, output, "new report");
    expect(await readFile(evidence, "utf8")).toBe("original evidence");
    expect(await readFile(output, "utf8")).toBe("new report");
    expect((await lstat(evidence)).ino).not.toBe((await lstat(output)).ino);
  });

  it("removes the temporary report when replacing the destination fails", async () => {
    const { run } = await fixture();
    const output = join(run, "report.html");
    await mkdir(output);
    await expect(writeBenchmarkReport(run, output, "new report")).rejects.toThrow();
    expect((await lstat(output)).isDirectory()).toBe(true);
    expect((await readdir(run)).sort()).toEqual(["report.html", "snapshot"]);
  });
});
